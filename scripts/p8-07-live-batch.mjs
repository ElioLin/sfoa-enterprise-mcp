import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadIdentityRuntimeConfig, createIdentityRuntime, NoopRuntimeLogger, RequestAuditContextController,
  runWithRequestAuditContext, runWithSalesforceDmlSemantic, runWithSalesforceSubmittedDmlSemantic,
  installJsforceAuditAdapter } from '../packages/sfoa-identity-runtime/dist/index.js';
import { loadRemoteRuntimeConfig } from '../packages/sfoa-mcp-server/dist/config.js';
import { loadP3LiveInputs } from '../packages/sfoa-mcp-server/dist/validation/p3-live-validation.js';
import { DmlExecutor } from '../packages/mcp-provider-sfoa-dml/dist/index.js';
async function main() {
  const root = process.cwd();
  const environment = { ...process.env, SFOA_CONTROL_PLANE_MODE: 'env', MCP_AUTH_MODE: 'internal_bearer',
    MCP_BUNTU_IDENTITY_ENABLED: 'false', MCP_WECOM_CHANNEL_ENABLED: 'false' };
  const config = await loadRemoteRuntimeConfig(root, environment);
  const identity = await loadIdentityRuntimeConfig(root);
  const object = identity.testObject;
  assert.ok(object && identity.secondaryUsername);
  config.dmlAllowlist.assertAllowed(object, 'CREATE'); config.dmlAllowlist.assertAllowed(object, 'UPDATE');
  const input = await loadP3LiveInputs(root, object, environment);
  const runtime = createIdentityRuntime(identity, { logger: new NoopRuntimeLogger() });
  installJsforceAuditAdapter();
  const cleanup = []; const gates = [];
  try {
    for (const [index, platformUserId] of [identity.platformUserA, identity.platformUserB].entries()) {
      const scope = await runtime.scopeFactory.create({ platformUserId, correlationId: randomUUID() });
      try {
        const connection = await scope.getConnection();
        const who = await connection.identity(); assert.equal(who.username.toLowerCase(), scope.route.salesforceUsername.toLowerCase());
        const executor = new DmlExecutor(scope.services.getOrgService(), config.dmlAllowlist, {
          onMutationStarted() {}, runWithSubmittedRecords: (records, call) => runWithSalesforceSubmittedDmlSemantic({ submittedRecords: records }, call),
        });
        async function observed(operation, call) {
          const controller = RequestAuditContextController.create({ channel: 'MCP_HTTP', toolName: operation === 'CREATE' ? 'create_records' : 'update_records' });
          const result = await runWithRequestAuditContext(controller, () => runWithSalesforceDmlSemantic({ operation, objectApiName: object,
            requestedFields: {}, managedFields: {} }, call));
          const snapshot = controller.finalizeAudit();
          const wire = snapshot.salesforceApiCalls.filter((item) => item.apiCategory === 'COMPOSITE_API');
          gates.push({ user: index === 0 ? 'A' : 'B', operation, status: result.status, total: result.total,
            succeeded: result.succeeded, failed: result.failed, unknown: result.unknown, collectionRequests: wire.length });
          // Retain proven CREATE IDs for cleanup even if observational evidence fails.
          if (wire.length !== 1) process.exitCode = 1;
          return result;
        }
        const created = await observed('CREATE', () => executor.createRecords({ objectApiName: object, allOrNone: index === 0,
          records: [0, 1].map((row) => ({ clientReferenceId: `user-${index}-row-${row}`, fields: input.createFields })) }));
        for (const item of created.results) if (item.success && item.recordId) cleanup.push({ platformUserId, id: item.recordId });
        assert.equal(created.status, 'SUCCESS');
        assert.equal(new Set(created.results.map((item) => item.clientReferenceId)).size, 2);
        const updated = await observed('UPDATE', () => executor.updateRecords({ objectApiName: object, allOrNone: index !== 0,
          records: created.results.map((row) => ({ clientReferenceId: row.clientReferenceId, recordId: row.recordId, fields: input.updateFields })) }));
        assert.equal(updated.status, 'SUCCESS');
        const ids = created.results.map((item) => `'${item.recordId}'`).join(',');
        const verified = await connection.query(`SELECT Id FROM ${object} WHERE Id IN (${ids})`);
        assert.equal(verified.records.length, 2);
      } finally { await scope.close(); }
    }
  } catch (error) { gates.push({ status: 'FAIL', reason: error.code ?? error.name ?? 'UNKNOWN' }); process.exitCode = 1; }
  finally {
    let cleaned = 0;
    // Test cleanup only for proven IDs created above, following the existing P3 validator.
    for (const item of cleanup) {
      const scope = await runtime.scopeFactory.create({ platformUserId: item.platformUserId, correlationId: randomUUID() });
      try {
        assert.match(item.id, /^[A-Za-z0-9]{18}$/u);
        const result = await (await scope.getConnection()).sobject(object).destroy(item.id);
        if (result.success) cleaned++; else process.exitCode = 1;
      } catch { process.exitCode = 1; } finally { await scope.close(); }
    }
    gates.push({ gate: 'test-owned cleanup', created: cleanup.length, cleaned, status: cleaned === cleanup.length ? 'PASS' : 'FAIL' });
    console.log(JSON.stringify({ gates, overall: process.exitCode ? 'FAIL' : 'PASS' }, null, 2));
  }
}
await main().catch((error) => {
  console.log(JSON.stringify({ overall: 'BLOCKED', reason: error.code ?? error.name ?? 'LIVE_CONFIGURATION_UNAVAILABLE',
    note: 'No policy overrides: configure an authorized TEST_OBJECT and valid native Salesforce test values before rerunning.' }));
  process.exitCode = 1;
});
