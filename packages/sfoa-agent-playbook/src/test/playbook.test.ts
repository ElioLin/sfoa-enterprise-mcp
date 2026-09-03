import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_PLAYBOOK_VERSION,
  PLAYBOOK_SECTION_NAMES,
  createAgentCapabilities,
  renderDifyInstruction,
  renderFullPlaybook,
  renderServerInstructions,
  renderWorkflow,
  renderWorkBuddySkill,
  renderWorkBuddySystemPrompt,
} from '../index.js';

describe('canonical SFoA Agent Playbook', () => {
  it('has the accepted semantic version and all required sections', () => {
    assert.equal(AGENT_PLAYBOOK_VERSION, '1.2.0');
    assert.deepEqual(PLAYBOOK_SECTION_NAMES, [
      'CORE', 'READ', 'ORG_OBJECT_USAGE', 'CREATE', 'UPDATE', 'DIAGNOSIS', 'LOOKUP', 'PICKLIST',
      'RESPONSE_FORMAT', 'ERROR_HANDLING', 'SAFETY_BOUNDARIES',
    ]);
  });

  it('normalizes only recognized effective capability facts deterministically', () => {
    const capabilities = createAgentCapabilities({
      enabledTools: ['future_tool', 'update_record', 'run_soql_query', 'create_record'],
      createAllowedObjects: ['Lead', 'Account', 'not valid!'],
      updateAllowedObjects: ['Contact', 'Contact'],
      diagnosticReady: true,
      managedDmlFields: [
        { objectApiName: 'Lead', fieldApiName: 'Requested_By__c', operations: ['CREATE'], managedBy: 'MCP', strategy: 'PLATFORM_IDENTITY' },
        { objectApiName: 'Contact', fieldApiName: 'Created_By_AI__c', operations: ['UPDATE'], managedBy: 'MCP', strategy: 'AI_CREATED_MARKER' },
      ],
    });

    assert.deepEqual(capabilities.enabledTools, ['run_soql_query', 'create_record', 'update_record']);
    assert.deepEqual(capabilities.createAllowedObjects, ['Account', 'Lead']);
    assert.deepEqual(capabilities.updateAllowedObjects, ['Contact']);
    assert.equal(capabilities.diagnosticReady, false);
    assert.equal(capabilities.dynamicFormEvidence, 'NOT_AVAILABLE');
    assert.deepEqual(capabilities.managedDmlFields, [{
      objectApiName: 'Lead', fieldApiName: 'Requested_By__c', operations: ['CREATE'], managedBy: 'MCP', strategy: 'PLATFORM_IDENTITY',
    }]);
  });

  it('renders every required safety contract on every distribution surface', () => {
    const capabilities = createAgentCapabilities({
      enabledTools: [
        'run_soql_query', 'create_record', 'update_record', 'get_record_action_context',
        'run_diagnostic_tooling_query', 'get_metadata_component_context',
        'get_agent_playbook', 'get_record_links',
      ],
      createAllowedObjects: ['Account'],
      updateAllowedObjects: ['Contact'],
      diagnosticReady: true,
      managedDmlFields: [{
        objectApiName: 'Account', fieldApiName: 'Requested_By__c', operations: ['CREATE'], managedBy: 'MCP', strategy: 'PLATFORM_IDENTITY',
      }],
    });
    const outputs = [
      renderServerInstructions(capabilities),
      renderFullPlaybook(capabilities),
      renderWorkflow('READ', capabilities),
      renderWorkflow('CREATE', capabilities),
      renderWorkflow('UPDATE', capabilities),
      renderWorkflow('DIAGNOSIS', capabilities),
      renderDifyInstruction(capabilities),
      renderWorkBuddySkill(),
      renderWorkBuddySystemPrompt(capabilities),
    ];

    for (const output of outputs) {
      assert.match(output, /1\.2\.0/u);
      assert.match(output, /MCP_DML_OUTCOME_UNKNOWN/u);
      assert.match(output, /do not automatically retry|never auto-retry|do not automatically retry/u);
    }
    assert.match(renderFullPlaybook(capabilities), /READ \(SOQL\) scope/u);
    assert.match(renderFullPlaybook(capabilities), /NOT bounded by the CREATE\/UPDATE allowlists/u);
    assert.match(renderFullPlaybook(capabilities), /govern only `create_record` and `update_record`, never reads/u);
    assert.match(renderWorkflow('READ', capabilities), /READ is never bounded by the CREATE\/UPDATE allowlists or DML policy/u);
    assert.match(renderWorkflow('READ', capabilities), /Account, Opportunity, Contact/u);
    assert.match(renderFullPlaybook(capabilities), /Dynamic Forms evidence: `NOT_AVAILABLE`/u);
    assert.match(renderFullPlaybook(capabilities), /minimum requested mutation|only fields the user asked/u);
    assert.match(renderFullPlaybook(capabilities), /trusted Lightning record link/u);
    assert.match(renderWorkflow('CREATE', capabilities), /3 to 8 high-value optional fields/u);
    assert.match(renderWorkflow('CREATE', capabilities), /required, recommended, and other optional fields/u);
    assert.match(renderWorkflow('CREATE', capabilities), /show the bounded current valid choices/u);
    assert.match(renderWorkflow('UPDATE', capabilities), /CREATE-required fields are not automatically required/u);
    assert.match(renderWorkflow('READ', capabilities), /roughly 6 to 10 useful columns/u);
    assert.match(renderWorkflow('READ', capabilities), /display\/name field and trusted link/u);
    assert.match(renderFullPlaybook(capabilities), /Do not hardcode object-specific/u);
    assert.match(renderFullPlaybook(capabilities), /Do not create a Runtime Form Engine/u);
    assert.match(renderFullPlaybook(capabilities), /MCP-managed DML fields: `Account\.Requested_By__c`/u);
    assert.match(renderWorkflow('CREATE', capabilities), /Exclude MCP-managed fields from required questions/u);
    assert.match(renderServerInstructions(capabilities), /do not ask for, recommend, derive, or override them/u);
    assert.match(renderFullPlaybook(capabilities), /## ORG_OBJECT_USAGE/u);
    assert.match(renderFullPlaybook(capabilities), /`Quote`/u);
    assert.match(renderFullPlaybook(capabilities), /`Quote__c`/u);
    assert.match(renderFullPlaybook(capabilities), /MCP_SOBJECT_NOT_IN_USE/u);
    assert.match(renderWorkflow('READ', capabilities), /## ORG_OBJECT_USAGE/u);
    assert.match(renderServerInstructions(capabilities), /declares the standard Salesforce objects/u);
  });

  it('does not claim unavailable capabilities and never includes unknown or secret-shaped facts', () => {
    const secret = 'MCP_CLIENT_TOKEN=<TEST_ONLY_SECRET_SHAPED_VALUE>';
    const output = renderDifyInstruction(createAgentCapabilities({
      enabledTools: ['run_soql_query', 'future_unknown_tool', secret],
      createAllowedObjects: [secret],
      updateAllowedObjects: [secret],
      diagnosticReady: true,
    }));

    assert.match(output, /CREATE.*unavailable/su);
    assert.match(output, /Diagnostic.*not ready|DIAGNOSIS.*unavailable/su);
    assert.doesNotMatch(output, /future_unknown_tool|TEST_ONLY_SECRET_SHAPED_VALUE/u);
    assert.match(output, /Do not configure `X-Platform-User-Id`/u);
  });

  it('keeps static generated guidance capability-neutral', () => {
    const outputs = [renderDifyInstruction(), renderWorkBuddySystemPrompt()];
    for (const output of outputs) {
      assert.match(output, /distribution template/u);
      assert.match(output, /no capability is implied/u);
      assert.doesNotMatch(output, /Status: available for/u);
      assert.match(output, /## ORG_OBJECT_USAGE/u);
    }
    assert.match(
      renderWorkBuddySkill(),
      /GENERATED FROM SFoA Agent Playbook \(@sfoa\/agent-playbook\) 1\.2\.0; DO NOT EDIT DIRECTLY/u,
    );
  });
});
