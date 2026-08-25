import { AGENT_PLAYBOOK_VERSION } from '@sfoa/agent-playbook';
import type { AdminToolRecordDto, DiagnosticConfigRecord, DmlPolicyRecord } from '@sfoa/control-plane';
import { describe, expect, it } from 'vitest';
import { deriveDifyInstructionFacts, generateDifyAgentInstruction } from '../agent/instruction-generator.js';

const NOW = '2026-08-24T00:00:00.000Z';

describe('canonical capability-aware Dify Agent instruction generator', () => {
  it('renders the canonical version and READ-only live capabilities without claiming mutation', () => {
    const input = fixture([tool('get_username'), tool('run_soql_query')]);
    const instruction = generateDifyAgentInstruction(input);
    const facts = deriveDifyInstructionFacts(input);

    expect(instruction).toContain(`Playbook-Version: ${AGENT_PLAYBOOK_VERSION}`);
    expect(instruction).toContain('## READ');
    expect(instruction).toContain('CREATE');
    expect(instruction).toContain('Status: unavailable');
    expect(facts.availableTools).toEqual(['get_username', 'run_soql_query']);
    expect(facts.createObjects).toEqual([]);
    expect(instruction).toContain('MCP_DML_OUTCOME_UNKNOWN');
  });

  it('reports CREATE and UPDATE only for effective matching Tool and object policies', () => {
    const input = fixture(
      [tool('run_soql_query'), tool('create_record'), tool('update_record'), tool('get_record_action_context')],
      [policy('Lead', true, false), policy('Account', true, false), policy('Contact', false, true)],
    );
    const instruction = generateDifyAgentInstruction(input);
    const facts = deriveDifyInstructionFacts(input);

    expect(facts.createObjects).toEqual(['Account', 'Lead']);
    expect(facts.updateObjects).toEqual(['Contact']);
    expect(instruction).toContain('Status: available for `Account`, `Lead`');
    expect(instruction).toContain('Status: available for `Contact`');
    expect(instruction).toContain('get_record_action_context');
    expect(instruction).toContain('only fields the user asked to change');
  });

  it('does not treat a policy as executable when its matching mutation Tool is disabled', () => {
    const input = fixture(
      [tool('create_record', { enabled: false, status: 'DISABLED' }), tool('run_soql_query')],
      [policy('Account', true, false)],
    );
    const facts = deriveDifyInstructionFacts(input);

    expect(facts.createObjects).toEqual([]);
    expect(facts.availableTools).not.toContain('create_record');
    expect(generateDifyAgentInstruction(input)).toContain('CREATE object policy is absent');
  });

  it('exposes Diagnosis only when both Tools and verified Diagnostic configuration are ready', () => {
    const ready = fixture(
      [tool('run_soql_query'), tool('run_diagnostic_tooling_query'), tool('get_metadata_component_context')],
      [],
      diagnostic({ verificationStatus: 'PASS' }),
    );
    const unverified = fixture(
      [tool('run_diagnostic_tooling_query'), tool('get_metadata_component_context')],
      [],
      diagnostic({ verificationStatus: 'NOT_VERIFIED' }),
    );

    expect(deriveDifyInstructionFacts(ready).diagnosticReady).toBe(true);
    expect(generateDifyAgentInstruction(ready)).not.toContain('complete verified Diagnostic chain is not ready');
    expect(deriveDifyInstructionFacts(unverified).diagnosticEnabledButUnverified).toBe(true);
    expect(deriveDifyInstructionFacts(unverified).availableTools).not.toContain('run_diagnostic_tooling_query');
    expect(generateDifyAgentInstruction(unverified)).toContain('Diagnostic chain is not ready');
  });

  it('includes the mandatory unknown-outcome, Salesforce rejection, link, and Dynamic Forms boundaries', () => {
    const instruction = generateDifyAgentInstruction(fixture(
      [tool('create_record'), tool('get_record_links')],
      [policy('Lead', true, false)],
    ));

    expect(instruction).toContain('MCP_DML_OUTCOME_UNKNOWN');
    expect(instruction).toContain('do not automatically retry');
    expect(instruction).toContain('trusted Lightning record link');
    expect(instruction).toContain('Dynamic Forms evidence: `NOT_AVAILABLE`');
    expect(instruction).toContain('Never change identity or bypass a rule');
    expect(instruction).toContain('required, recommended, and other optional fields');
    expect(instruction).toContain('3 to 8 high-value optional fields');
    expect(instruction).toContain('show the bounded current valid choices');
    expect(instruction).toContain('confirm the controlling value first');
    expect(instruction).toContain('Resolve ambiguous Lookups');
    expect(instruction).toContain('CREATE-required fields are not automatically required');
    expect(instruction).toContain('display/name field as the primary label and Markdown hyperlink');
  });

  it('filters unknown Tools and secret-shaped records from canonical facts and output', () => {
    const secret = 'MCP_CLIENT_TOKEN=<TEST_ONLY_SECRET_SHAPED_VALUE>';
    const input = fixture(
      [tool('run_soql_query', { remark: secret }), tool('future_unknown_tool')],
      [policy(secret, true, true, true, secret)],
      diagnostic({ lastErrorMessageSafe: secret, salesforceUsername: secret }),
    );
    const instruction = generateDifyAgentInstruction(input);

    expect(instruction).not.toContain('future_unknown_tool');
    expect(instruction).not.toContain('TEST_ONLY_SECRET_SHAPED_VALUE');
    expect(deriveDifyInstructionFacts(input).availableTools).toEqual(['run_soql_query']);
  });

  it('uses Buntu bearer identity guidance and forbids normal platform Header setup', () => {
    const instruction = generateDifyAgentInstruction(fixture([tool('run_soql_query')]));
    expect(instruction).toContain('Bearer <CURRENT_USER_TOKEN>');
    expect(instruction).toContain('Do not configure `X-Platform-User-Id`');
    expect(instruction).toContain('platformUserId -> Identity Route -> Salesforce username');
  });
});

function fixture(
  tools: readonly AdminToolRecordDto[],
  dmlPolicies: readonly DmlPolicyRecord[] = [],
  diagnosticConfig: DiagnosticConfigRecord | null = null,
) {
  return Object.freeze({ tools, dmlPolicies, diagnostic: diagnosticConfig });
}

function tool(toolName: string, overrides: Partial<AdminToolRecordDto> = {}): AdminToolRecordDto {
  return Object.freeze({
    toolName,
    classification: 'READ',
    executionRole: 'USER',
    remoteCompatible: true,
    releaseState: 'GA',
    enabled: true,
    rowVersion: '1',
    remark: null,
    dependencies: Object.freeze([]),
    status: 'AVAILABLE',
    enableAllowed: true,
    disabledReason: null,
    ...overrides,
  });
}

function policy(
  objectApiName: string,
  allowCreate: boolean,
  allowUpdate: boolean,
  enabled = true,
  remark: string | null = null,
): DmlPolicyRecord {
  return Object.freeze({ objectApiName, allowCreate, allowUpdate, enabled, remark, id: objectApiName, rowVersion: '1', createdAt: NOW, updatedAt: NOW });
}

function diagnostic(overrides: Partial<DiagnosticConfigRecord> = {}): DiagnosticConfigRecord {
  return Object.freeze({
    id: '1',
    salesforceUsername: 'diagnostic@example.invalid',
    enabled: true,
    verificationStatus: 'NOT_VERIFIED',
    lastVerifiedAt: null,
    lastErrorCode: null,
    lastErrorMessageSafe: null,
    testMetadataType: null,
    testMetadataFullName: null,
    rowVersion: '1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}
