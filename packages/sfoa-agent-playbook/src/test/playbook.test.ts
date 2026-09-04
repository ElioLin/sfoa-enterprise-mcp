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
    assert.equal(AGENT_PLAYBOOK_VERSION, '1.4.0');
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
      assert.match(output, /1\.4\.0/u);
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
      /GENERATED FROM SFoA Agent Playbook \(@sfoa\/agent-playbook\) 1\.4\.0; DO NOT EDIT DIRECTLY/u,
    );
  });

  it('encodes the P8-03 presentation-intelligence contract on the workflow surfaces', () => {
    const capabilities = createAgentCapabilities({
      enabledTools: [
        'run_soql_query', 'create_record', 'update_record', 'get_record_action_context',
        'get_record_display_context', 'run_diagnostic_tooling_query', 'get_metadata_component_context',
        'get_agent_playbook', 'get_record_links',
      ],
      createAllowedObjects: ['Quote__c'],
      updateAllowedObjects: ['Quote__c'],
      dynamicFormEvidence: 'NOT_AVAILABLE',
    });

    const create = renderWorkflow('CREATE', capabilities);
    // CREATE must branch on available Record Types instead of silently using the default.
    assert.match(create, /availableRecordTypes/u);
    assert.match(create, /has exactly one entry, use it without an extra prompt/u);
    assert.match(create, /several and the user has not uniquely and reliably named one/u);
    assert.match(create, /ask the user which Record Type to use/u);
    assert.match(create, /no available Record Type, stop and tell the user/u);

    const read = renderWorkflow('READ', capabilities);
    // READ must use display context as evidence, not a whitelist, and separate analytics.
    assert.match(read, /call `get_record_display_context` first when it is enabled/u);
    assert.match(read, /not a fixed field allowlist/u);
    assert.match(read, /analytical queries and do not force record framing on them/u);
    assert.match(read, /do not fabricate an Id, add a per-row record hyperlink/u);

    const full = renderFullPlaybook(capabilities);
    // Normal business answers must suppress raw Salesforce IDs.
    assert.match(full, /Keep raw Salesforce IDs internal in normal business answers/u);
    assert.match(full, /Surface a Record ID only when the user explicitly asks/u);
    assert.match(full, /Answer like a business-aware assistant, not a SOQL JSON dump/u);
    assert.doesNotMatch(full, /include the Salesforce Record ID as supporting detail/u);
    // The distribution surfaces must stay versioned and carry the display-context pointer.
    assert.match(full, /## CORE —/u);
    assert.match(renderDifyInstruction(capabilities), /get_record_display_context/u);
    assert.match(renderServerInstructions(capabilities), /keep raw Salesforce Record IDs internal/u);
  });

  it('encodes the CREATE two-stage Record Type dialog so facts load before field questions', () => {
    const create = renderWorkflow('CREATE', createAgentCapabilities({
      enabledTools: ['get_record_action_context', 'create_record'],
      createAllowedObjects: ['Quote__c'],
      updateAllowedObjects: [],
      dynamicFormEvidence: 'NOT_AVAILABLE',
    }));

    // While selection is required the create facts are not loaded: only the available
    // Record Types are shown and no Layout/Picklist/Record-Type field questions start.
    assert.match(create, /`recordTypeSelectionRequired=true`/u);
    assert.match(create, /show only the `availableRecordTypes`/u);
    assert.match(create, /do not begin Layout, Picklist, or Record-Type-dependent field questions before those facts exist/u);
    // The second context call carries the chosen Record Type; field collection and the
    // create_record payload both use that same Record Type.
    assert.match(create, /call `get_record_action_context` again with the same `recordTypeId`/u);
    assert.match(create, /`recordTypeSelectionRequired=false` with Create Defaults, Layout, Picklists, and required\/editable facts loaded/u);
    assert.match(create, /pass that same `recordTypeId` to `create_record`/u);
    assert.match(create, /never silently create under the default/u);
  });
});
