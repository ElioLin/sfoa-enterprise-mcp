import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adminAuditQuerySchema,
  adminDiagnosticConfigUpdateSchema,
  adminDmlPolicyCreateSchema,
  adminIdentityRouteCreateSchema,
  adminPaginationQuerySchema,
  adminToolControlUpdateSchema,
} from '@sfoa/control-plane/admin-contracts';
import type { ToolControlRecord } from '@sfoa/control-plane';
import { SFOA_DATA_TOOL_NAMES } from '@sfoa/mcp-provider-sfoa-data';
import type { UpstreamInventoryComparison } from '@sfoa/mcp-server';
import { buildAdminToolCatalog, canEnableAdminTool } from '../tool-catalog.js';

const upstreamPass: UpstreamInventoryComparison = Object.freeze({ status: 'PASS', drift: Object.freeze([]) });
const upstreamDrift: UpstreamInventoryComparison = Object.freeze({
  status: 'UPSTREAM_REVIEW_REQUIRED',
  drift: Object.freeze([Object.freeze({
    kind: 'ADDED' as const,
    toolName: 'future_tool',
    expected: '<absent>',
    actual: 'future_tool',
  })]),
});

test('strict Admin contracts reject unknown fields and SQL-injection-shaped identifiers', () => {
  assert.equal(adminIdentityRouteCreateSchema.safeParse({
    platformUserId: "user' OR 1=1 --",
    userName: '用户 甲',
    salesforceUsername: 'user@example.invalid',
    enabled: true,
    remark: null,
  }).success, true, 'platform IDs are data and may contain punctuation because SQL is parameterized');
  assert.equal(adminDmlPolicyCreateSchema.safeParse({
    objectApiName: 'Lead; DROP TABLE sfoa_dml_policy',
    allowCreate: true,
    allowUpdate: false,
    enabled: true,
    remark: null,
  }).success, false);
  assert.equal(adminDmlPolicyCreateSchema.safeParse({
    objectApiName: 'Lead',
    allowCreate: true,
    allowUpdate: false,
    allowDelete: true,
    enabled: true,
    remark: null,
  }).success, false);
  assert.equal(adminDmlPolicyCreateSchema.safeParse({
    objectApiName: 'Lead',
    allowCreate: false,
    allowUpdate: false,
    enabled: true,
    remark: null,
  }).success, false);
});

test('pagination, diagnostic seed, and tool inputs are bounded', () => {
  assert.equal(adminPaginationQuerySchema.safeParse({ limit: '100', offset: '1000000' }).success, true);
  assert.equal(adminPaginationQuerySchema.safeParse({ limit: '101', offset: '0' }).success, false);
  assert.equal(adminAuditQuerySchema.safeParse({ occurredFrom: '2026-01-02T00:00:00Z', occurredTo: '2026-01-01T00:00:00Z' }).success, false);
  assert.equal(adminDiagnosticConfigUpdateSchema.safeParse({
    salesforceUsername: 'diagnostic@example.invalid',
    enabled: true,
    testMetadataType: 'ApexClass',
    testMetadataFullName: '../Secret',
    rowVersion: null,
  }).success, false);
  assert.equal(adminToolControlUpdateSchema.safeParse({ enabled: true, remark: null, rowVersion: null, role: 'DIAGNOSTIC' }).success, false);
});

test('unknown or drifted executable Tools cannot be enabled from database state', () => {
  const unknown: ToolControlRecord = Object.freeze({
    id: '999',
    toolName: 'future_unknown_tool',
    enabled: true,
    remark: null,
    rowVersion: '1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const record = buildAdminToolCatalog([unknown], upstreamPass).find((item) => item.toolName === unknown.toolName);
  assert.equal(record?.status, 'UNKNOWN');
  assert.equal(record?.enableAllowed, false);
  assert.equal(canEnableAdminTool(unknown.toolName, upstreamPass).allowed, false);

  const officialRead = buildAdminToolCatalog([], upstreamDrift).find((item) => item.classification === 'READ');
  assert.equal(officialRead?.enableAllowed, false);
  assert.equal(officialRead?.status, 'DISABLED');
  assert.match(officialRead?.disabledReason ?? '', /drift/iu);

  for (const diagnosticName of ['run_diagnostic_tooling_query', 'get_metadata_component_context']) {
    const diagnostic = buildAdminToolCatalog([], upstreamDrift).find((item) => item.toolName === diagnosticName);
    assert.equal(diagnostic?.enableAllowed, false);
    assert.match(diagnostic?.disabledReason ?? '', /drift/iu);
  }
});

test('SFoA Agent infrastructure Tools are explicit read-only governed catalog entries', () => {
  const catalog = buildAdminToolCatalog([], upstreamDrift);
  for (const toolName of ['get_agent_playbook', 'get_record_links']) {
    const record = catalog.find((item) => item.toolName === toolName);
    assert.equal(record?.classification, 'READ');
    assert.equal(record?.executionRole, 'USER');
    assert.equal(record?.remoteCompatible, true);
    assert.equal(record?.releaseState, 'GA');
    assert.equal(record?.enableAllowed, true, `${toolName} is SFoA-owned and independent of official Provider drift`);
    assert.equal(canEnableAdminTool(toolName, upstreamDrift).allowed, true);
  }
});

test('every P9 Data Tool is enablable by an Admin even though it ships default-disabled', () => {
  // The P9 Data Tools are absent from DEFAULT_ENABLED_TOOLS on purpose. That is only
  // shippable if an Admin can find them here: a Data Tool missing from this catalog would be
  // advertised nowhere and permanently unenableable. Like the Agent infrastructure Tools they
  // are SFoA-owned, so official Provider drift must not block enabling them.
  assert.ok(SFOA_DATA_TOOL_NAMES.length > 0);
  const catalog = buildAdminToolCatalog([], upstreamDrift);
  for (const toolName of SFOA_DATA_TOOL_NAMES) {
    const record = catalog.find((item) => item.toolName === toolName);
    assert.ok(record !== undefined, `${toolName} must appear in the Admin catalog`);
    assert.equal(record.classification, 'READ');
    assert.equal(record.executionRole, 'USER');
    assert.equal(record.remoteCompatible, true);
    assert.equal(record.releaseState, 'GA');
    assert.equal(record.status, 'DISABLED', `${toolName} must ship disabled until an Admin enables it`);
    assert.equal(record.enableAllowed, true, `${toolName} is SFoA-owned and independent of official Provider drift`);
    assert.equal(record.disabledReason, null);
    assert.equal(canEnableAdminTool(toolName, upstreamDrift).allowed, true);
  }

  // A database row for a Data Tool is what makes it enabled; the catalog must reflect it
  // rather than overriding the stored state.
  const stored: ToolControlRecord = Object.freeze({
    id: '1',
    toolName: SFOA_DATA_TOOL_NAMES[0] as string,
    enabled: true,
    remark: null,
    rowVersion: '2',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const enabledRecord = buildAdminToolCatalog([stored], upstreamPass)
    .find((item) => item.toolName === stored.toolName);
  assert.equal(enabledRecord?.enabled, true);
  assert.equal(enabledRecord?.status, 'AVAILABLE');
});

test('the debug log Toolset carries its own classification for the write, and is enablable', () => {
  // `set_trace_flag` writes Setup-layer trace configuration, which is neither a business-record write
  // (`MUTATION`) nor a permission change (`ADMIN`). An Administrator reads this column before
  // enabling the Tool, so the classification has to say what is actually licensed rather than reuse a
  // label that means something else in every other row of the same table (ADR-0030 §1).
  const catalog = buildAdminToolCatalog([], upstreamPass);
  const write = catalog.find((item) => item.toolName === 'set_trace_flag');
  assert.ok(write !== undefined, 'set_trace_flag must appear in the Admin catalog');
  assert.equal(write.classification, 'DIAGNOSTIC_WRITE');
  assert.equal(write.executionRole, 'DIAGNOSTIC');
  assert.equal(write.enableAllowed, true, 'set_trace_flag is SFoA-owned and independent of official Provider drift');

  for (const toolName of ['get_apex_logs', 'get_debug_log_body']) {
    const read = catalog.find((item) => item.toolName === toolName);
    assert.ok(read !== undefined, `${toolName} must appear in the Admin catalog`);
    assert.equal(read.classification, 'READ', `${toolName} reads and must not be classified as a write`);
    assert.equal(read.executionRole, 'DIAGNOSTIC');
    assert.equal(read.enableAllowed, true);
  }
});
