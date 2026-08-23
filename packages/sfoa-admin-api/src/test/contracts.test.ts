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
