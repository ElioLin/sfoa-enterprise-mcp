import { describe, expect, it } from 'vitest';
import type { AdminToolRecordDto, DiagnosticConfigRecord, DmlPolicyRecord } from '@sfoa/control-plane';
import { generateDifyAgentInstruction } from '../agent/instruction-generator.js';

const NOW = '2026-08-24T00:00:00.000Z';

describe('deterministic Dify Agent instruction generator', () => {
  it('generates a READ-only workflow from the current executable Tool catalog', () => {
    const instruction = generate([tool('get_username'), tool('run_soql_query')]);

    expect(instruction).toContain('## READ Workflow');
    expect(instruction).toContain('`run_soql_query`');
    expect(instruction).not.toContain('## CREATE Workflow');
    expect(instruction).not.toContain('## UPDATE Workflow');
    expect(instruction).not.toContain('MCP_DML_OUTCOME_UNKNOWN');
  });

  it('adds the full CREATE workflow when create_record, context, and policy are enabled', () => {
    const instruction = generate(
      [tool('run_soql_query'), tool('create_record'), tool('get_record_action_context')],
      [policy('Account', true, false)],
    );

    expect(instruction).toContain('## CREATE Workflow');
    expect(instruction).toContain('2. 调用 `get_record_action_context`。');
    expect(instruction).toContain('Picklist 必须使用 Salesforce 返回的合法值');
    expect(instruction).toContain('CREATE 允许对象：`Account`');
  });

  it('adds UPDATE only when update_record and UPDATE policy are enabled', () => {
    const instruction = generate(
      [tool('run_soql_query'), tool('update_record')],
      [policy('Contact', false, true)],
    );

    expect(instruction).toContain('## UPDATE Workflow');
    expect(instruction).toContain('不修改用户没有要求修改的业务字段');
    expect(instruction).not.toContain('## CREATE Workflow');
  });

  it('changes CREATE and UPDATE guidance when context Tool is disabled', () => {
    const disabledContext = tool('get_record_action_context', { enabled: false, status: 'DISABLED' });
    const instruction = generate(
      [tool('run_soql_query'), tool('create_record'), tool('update_record'), disabledContext],
      [policy('Account', true, true)],
    );

    expect(instruction).toContain('当前不得强制调用未启用的 `get_record_action_context`');
    expect(instruction).not.toContain('2. 调用 `get_record_action_context`。');
  });

  it('adds diagnosis only when both Diagnostic Tools and verification are ready', () => {
    const instruction = generate(
      [tool('run_soql_query'), tool('run_diagnostic_tooling_query'), tool('get_metadata_component_context')],
      [],
      diagnostic({ verificationStatus: 'PASS' }),
    );

    expect(instruction).toContain('## Diagnosis Workflow');
    expect(instruction).toContain('`run_diagnostic_tooling_query`');
    expect(instruction).toContain('DIAGNOSTIC evidence ≠ business record data');
  });

  it('does not claim diagnosis when Diagnostic is disabled or unverified', () => {
    const instruction = generate(
      [tool('run_diagnostic_tooling_query'), tool('get_metadata_component_context')],
      [],
      diagnostic({ enabled: false, verificationStatus: 'PASS' }),
    );

    expect(instruction).not.toContain('## Diagnosis Workflow');
    expect(instruction).not.toContain('`run_diagnostic_tooling_query`');
    expect(instruction).toContain('不得将诊断能力描述为当前可用');
  });

  it('removes mutation workflows when DML policy is disabled but retains UNKNOWN safety for exposed Tools', () => {
    const instruction = generate(
      [tool('create_record'), tool('update_record')],
      [policy('Lead', true, true, false)],
    );

    expect(instruction).not.toContain('## CREATE Workflow');
    expect(instruction).not.toContain('## UPDATE Workflow');
    expect(instruction).toContain('没有启用的 CREATE 对象策略；不得执行创建');
    expect(instruction).toContain('没有启用的 UPDATE 对象策略；不得执行更新');
    expect(instruction).toContain('MCP_DML_OUTCOME_UNKNOWN');
  });

  it('does not present DML policy as executable when the matching Tool is disabled', () => {
    const instruction = generate(
      [tool('create_record', { enabled: false, status: 'DISABLED' }), tool('run_soql_query')],
      [policy('Account', true, false)],
    );

    expect(instruction).not.toContain('## CREATE Workflow');
    expect(instruction).not.toContain('CREATE 允许对象');
    expect(instruction).not.toContain('MCP_DML_OUTCOME_UNKNOWN');
  });

  it('always includes UNKNOWN-outcome safety when either mutation is effective', () => {
    const createInstruction = generate([tool('create_record')], [policy('Lead', true, false)]);
    const updateInstruction = generate([tool('update_record')], [policy('Lead', false, true)]);

    for (const instruction of [createInstruction, updateInstruction]) {
      expect(instruction).toContain('MCP_DML_OUTCOME_UNKNOWN');
      expect(instruction).toContain('禁止自动再次调用 `create_record` / `update_record`');
      expect(instruction).toContain('如果无法确认，明确告诉用户结果未知');
    }
  });

  it('does not let an unknown Tool enter the generated instruction', () => {
    const instruction = generate([tool('run_soql_query'), tool('future_unknown_tool')]);

    expect(instruction).not.toContain('future_unknown_tool');
  });

  it('never copies secret-shaped remarks or diagnostic details into the instruction', () => {
    const secret = 'MCP_CLIENT_TOKEN=super-secret-value';
    const instruction = generate(
      [tool('run_soql_query', { remark: secret })],
      [policy('Account', false, false, true, secret)],
      diagnostic({ lastErrorMessageSafe: secret, salesforceUsername: secret }),
    );

    expect(instruction).not.toContain(secret);
    expect(instruction).not.toContain('super-secret-value');
  });

  it('presents enabled DML object policies deterministically by operation and name', () => {
    const instruction = generate(
      [tool('create_record'), tool('update_record')],
      [policy('Lead', true, false), policy('Account', true, false), policy('Contact', false, true)],
    );

    expect(instruction).toContain('CREATE 允许对象：`Account`、`Lead`');
    expect(instruction).toContain('UPDATE 允许对象：`Contact`');
  });
});

function generate(
  tools: readonly AdminToolRecordDto[],
  dmlPolicies: readonly DmlPolicyRecord[] = [],
  diagnosticConfig: DiagnosticConfigRecord | null = null,
): string {
  return generateDifyAgentInstruction({ tools, dmlPolicies, diagnostic: diagnosticConfig });
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
  return Object.freeze({ id: objectApiName, objectApiName, allowCreate, allowUpdate, enabled, remark, rowVersion: '1', createdAt: NOW, updatedAt: NOW });
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
