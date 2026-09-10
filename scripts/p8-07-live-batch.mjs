import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadIdentityRuntimeConfig, createIdentityRuntime, NoopRuntimeLogger, RequestAuditContextController,
  runWithRequestAuditContext, runWithSalesforceDmlSemantic, runWithSalesforceSubmittedDmlSemantic,
  installJsforceAuditAdapter } from '../packages/sfoa-identity-runtime/dist/index.js';
import { loadRemoteRuntimeConfig } from '../packages/sfoa-mcp-server/dist/config.js';
import { loadP3LiveInputs } from '../packages/sfoa-mcp-server/dist/validation/p3-live-validation.js';
import { DmlExecutor } from '../packages/mcp-provider-sfoa-dml/dist/index.js';

/**
 * Opt-in workspace validator for the P8-07 batch contract. This is NOT a business Tool.
 *
 * It runs only against the operator's existing env-backed TEST_OBJECT with CREATE/UPDATE in the
 * real DML allowlist and both configured USER routes. It copies, relaxes and bypasses nothing:
 * no allowlist change, no Validation Rule bypass, no administrator identity, no business-rule
 * edit. The one deliberately-invalid payload comes from the operator's own
 * `P3_VALIDATION_FAILURE_FIELDS_JSON` fixture (the same one the P3 validator already uses).
 *
 * A gate whose fixture the environment cannot satisfy is reported BLOCKED, never PASS and never
 * a manufactured success. Fixture the environment did supply but that contradicts the contract
 * is reported FAIL.
 */
const gates = [];
const gate = (name, status, detail) => gates.push({ gate: name, status, ...(detail ? { detail } : {}) });

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
  const updateFieldNames = Object.keys(input.updateFields);
  assert.ok(updateFieldNames.length > 0);
  const runtime = createIdentityRuntime(identity, { logger: new NoopRuntimeLogger() });
  installJsforceAuditAdapter();
  const cleanup = [];
  /** Read the requested fields back through the request USER's own Connection. */
  const readFields = async (connection, ids) => {
    const list = ids.map((id) => `'${id}'`).join(',');
    const result = await connection.query(`SELECT Id, ${updateFieldNames.join(', ')} FROM ${object} WHERE Id IN (${list})`);
    return new Map(result.records.map((row) => [String(row.Id).toUpperCase(),
      Object.fromEntries(updateFieldNames.map((name) => [name, row[name]]))]));
  };
  try {
    for (const [index, platformUserId] of [identity.platformUserA, identity.platformUserB].entries()) {
      const user = index === 0 ? 'A' : 'B';
      const scope = await runtime.scopeFactory.create({ platformUserId, correlationId: randomUUID() });
      try {
        const connection = await scope.getConnection();
        const who = await connection.identity(); assert.equal(who.username.toLowerCase(), scope.route.salesforceUsername.toLowerCase());
        const executor = new DmlExecutor(scope.services.getOrgService(), config.dmlAllowlist, {
          onMutationStarted() {}, runWithSubmittedRecords: (records, call) => runWithSalesforceSubmittedDmlSemantic({ submittedRecords: records }, call),
        });
        const observed = async (operation, call) => {
          const controller = RequestAuditContextController.create({ channel: 'MCP_HTTP', toolName: operation === 'CREATE' ? 'create_records' : 'update_records' });
          const result = await runWithRequestAuditContext(controller, () => runWithSalesforceDmlSemantic({ operation, objectApiName: object,
            requestedFields: {}, managedFields: {} }, call));
          const snapshot = controller.finalizeAudit();
          const wire = snapshot.salesforceApiCalls.filter((item) => item.apiCategory === 'COMPOSITE_API');
          gate(`user ${user} ${operation} collection wire requests`, wire.length === 1 ? 'PASS' : 'FAIL', `observed ${wire.length}`);
          return result;
        };

        // HF12.1 Batch CREATE: at least two records in one collection request, IDs returned.
        const created = await observed('CREATE', () => executor.createRecords({ objectApiName: object, allOrNone: index === 0,
          records: [0, 1].map((row) => ({ clientReferenceId: `user-${index}-row-${row}`, fields: input.createFields })) }));
        for (const item of created.results) if (item.success && item.recordId) cleanup.push({ platformUserId, id: item.recordId });
        gate(`user ${user} batch CREATE status`, created.status === 'SUCCESS' ? 'PASS' : 'FAIL', `status ${created.status}`);
        gate(`user ${user} batch CREATE returns one ID per record`,
          new Set(created.results.map((item) => item.clientReferenceId)).size === 2 && new Set(created.results.map((item) => item.recordId)).size === 2 ? 'PASS' : 'FAIL');
        if (created.status !== 'SUCCESS') continue;
        const [firstId, secondId] = created.results.map((item) => item.recordId);

        // HF12.2 Batch UPDATE: at least two records in one collection request, verified by a USER read.
        const updated = await observed('UPDATE', () => executor.updateRecords({ objectApiName: object, allOrNone: index !== 0,
          records: created.results.map((row) => ({ clientReferenceId: row.clientReferenceId, recordId: row.recordId, fields: input.updateFields })) }));
        gate(`user ${user} batch UPDATE status`, updated.status === 'SUCCESS' ? 'PASS' : 'FAIL', `status ${updated.status}`);
        const readBack = await readFields(connection, [firstId, secondId]);
        const valuesMatch = [...readBack.values()].every((row) => updateFieldNames.every((name) => String(row[name]) === String(input.updateFields[name])));
        gate(`user ${user} batch UPDATE values verified by a USER read`, valuesMatch ? 'PASS' : 'FAIL',
          valuesMatch ? undefined : 'The USER read did not return the submitted values; check field types before treating this as a contract failure.');

        // HF12.3 allOrNone. Both probes need the operator's own invalid-row fixture.
        if (index !== 0) continue;
        const invalidRow = input.validationFailureFields;
        const probe = async (allOrNone, targetId) => {
          const result = await observed('UPDATE', () => executor.updateRecords({ objectApiName: object, allOrNone, records: [
            { clientReferenceId: 'probe-valid', recordId: firstId, fields: input.updateFields },
            { clientReferenceId: 'probe-invalid', recordId: targetId, fields: invalidRow },
          ] }));
          return { result, after: await readFields(connection, [firstId, targetId]) };
        };
        const partialProbe = await probe(false, secondId);
        if (partialProbe.result.status === 'SUCCESS') {
          gate('allOrNone=false partial result', 'BLOCKED',
            'P3_VALIDATION_FAILURE_FIELDS_JSON was accepted by Salesforce, so this environment cannot produce a partial result without bypassing a Validation Rule.');
        } else {
          gate('allOrNone=false reports PARTIAL_SUCCESS',
            partialProbe.result.status === 'PARTIAL_SUCCESS' && partialProbe.result.succeeded === 1 && partialProbe.result.failed === 1 ? 'PASS' : 'FAIL',
            `status ${partialProbe.result.status} succeeded ${partialProbe.result.succeeded} failed ${partialProbe.result.failed}`);
          const committed = partialProbe.after.get(String(firstId).toUpperCase());
          gate('allOrNone=false keeps the committed row',
            updateFieldNames.every((name) => String(committed?.[name]) === String(input.updateFields[name])) ? 'PASS' : 'FAIL');
        }
        const rollbackProbe = await probe(true, secondId);
        if (rollbackProbe.result.status === 'SUCCESS') {
          gate('allOrNone=true rollback', 'BLOCKED',
            'P3_VALIDATION_FAILURE_FIELDS_JSON was accepted by Salesforce, so this environment cannot prove rollback without bypassing a Validation Rule.');
        } else {
          const rolledBack = rollbackProbe.after.get(String(firstId).toUpperCase());
          const unchanged = updateFieldNames.every((name) => String(rolledBack?.[name]) === String(partialProbe.after.get(String(firstId).toUpperCase())?.[name]));
          gate('allOrNone=true rolls back the whole collection',
            rollbackProbe.result.status === 'FAILED' && unchanged ? 'PASS' : 'FAIL',
            `status ${rollbackProbe.result.status} rollbackProven ${unchanged}`);
        }
      } finally { await scope.close(); }
    }
  } catch (error) {
    gate('live batch validation', 'FAIL', error.code ?? error.name ?? 'UNKNOWN');
  } finally {
    let cleaned = 0; let cleanupFailed = false;
    // Test cleanup only for proven IDs created above, following the existing P3 validator.
    for (const item of cleanup) {
      const scope = await runtime.scopeFactory.create({ platformUserId: item.platformUserId, correlationId: randomUUID() });
      try {
        assert.match(item.id, /^[A-Za-z0-9]{18}$/u);
        const result = await (await scope.getConnection()).sobject(object).destroy(item.id);
        if (result.success) cleaned++; else cleanupFailed = true;
      } catch { cleanupFailed = true; } finally { await scope.close(); }
    }
    gate('test-owned cleanup', cleaned === cleanup.length && !cleanupFailed ? 'PASS' : 'FAIL', `created ${cleanup.length} cleaned ${cleaned}`);
    const overall = gates.some((row) => row.status === 'FAIL') ? 'FAIL'
      : gates.some((row) => row.status === 'BLOCKED') ? 'BLOCKED' : 'PASS';
    console.log(JSON.stringify({ gates, overall }, null, 2));
    if (overall === 'FAIL') process.exitCode = 1;
  }
}
await main().catch((error) => {
  console.log(JSON.stringify({ gates, overall: 'BLOCKED', reason: error.code ?? error.name ?? 'LIVE_CONFIGURATION_UNAVAILABLE',
    note: 'No policy overrides: configure an authorized TEST_OBJECT, USER routes and native Salesforce test values before rerunning.' }, null, 2));
  process.exitCode = 1;
});
