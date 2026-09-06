// Bounded A-01 API ID-join follow-up; one selected USER, one DIAGNOSTIC.
import { readFile, writeFile } from 'node:fs/promises';
import { loadProjectEnvironment } from '../skills/sfoa-mcp-maintainer/scripts/shared/project.mjs';
import { withReadOnlyDatabase } from '../skills/sfoa-mcp-maintainer/scripts/shared/db.mjs';
import { JwtConnectionFactory, loadIdentityRuntimeConfig, createSalesforceIdentityRoute, installJsforceAuditAdapter,
  RequestAuditContextController, runWithRequestAuditContext } from '../packages/sfoa-identity-runtime/dist/index.js';
const report = { generatedAt: new Date().toISOString(), operations: [], status: 'PARTIAL' };
const begin = performance.now();
const timer = setTimeout(() => { console.error('APP_JOIN_TIMEOUT'); process.exit(1); }, 120000);
async function measure(label, role, fn, project = () => ({})) {
  const audit = RequestAuditContextController.create({ channel: 'MCP_STDIO', toolName: 'p8_04a_app_join_probe' });
  const started = performance.now();
  const op = { label, role };
  let value;
  try {
    value = await runWithRequestAuditContext(audit, async () => await fn());
    op.status = 'PASS';
    if (!label.startsWith('AUTH')) op.decodedJsonBytes = Buffer.byteLength(JSON.stringify(value));
    op.evidence = project(value);
  } catch (e) { op.status = 'BLOCKED'; const code = e?.errorCode ?? e?.code; op.errorCode = /^[A-Za-z0-9_]{1,100}$/u.test(code ?? '') ? code : 'READ_FAILED'; }
  op.elapsedMs = Math.round(performance.now() - started);
  op.httpAttemptCount = audit.finalizeAudit()?.salesforceApiCalls?.length ?? 0;
  report.operations.push(op);
  return value;
}
try {
  const root = process.cwd();
  const env = await loadProjectEnvironment(root);
  const config = await loadIdentityRuntimeConfig(root, env.values, { routesFromDatabase: true });
  const key = JSON.parse(await readFile('.temp/p8-04a-capture-key.json', 'utf8'));
  const selected = key.users.find((u) => u.alias === 'USER_1');
  const routes = await withReadOnlyDatabase(root, env, async (db) => ({
    users: await db.execute('SELECT id, platform_user_id, salesforce_username FROM sfoa_identity_route WHERE enabled = TRUE ORDER BY id LIMIT 501'),
    diagnostic: await db.execute('SELECT salesforce_username FROM sfoa_diagnostic_config WHERE id = 1 AND enabled = TRUE'),
  }));
  const user = routes.users.find((u) => u.id === selected.routeId && u.salesforce_username === selected.username);
  if (!user || routes.users.length > 500) throw new Error('ROUTE_CHANGED');
  installJsforceAuditAdapter();
  const factory = new JwtConnectionFactory({ instanceUrl: config.instanceUrl, clientId: config.clientId, privateKeyPath: config.privateKeyPath });
  for (const [role, row] of [['USER', user], ['DIAGNOSTIC', routes.diagnostic[0]]]) {
    const conn = await measure(`AUTH_${role}`, role, () => factory.create(createSalesforceIdentityRoute({
      platformUserId: row.platform_user_id ?? 'p8-04a-diagnostic', salesforceUsername: row.salesforce_username,
      connectionRole: role, credentialProfile: 'sfoa-shared-jwt', aliases: [],
    })));
    if (!conn) throw new Error('CONNECTION_UNAVAILABLE');
    if (role === 'USER') {
      const result = await measure('USER_1_APPS', role, () => conn.request({ method: 'GET', url: `/services/data/v${conn.getApiVersion()}/ui-api/apps?formFactor=Large` }));
      report.apps = result?.apps?.map((a) => ({ developerName: a.developerName, appId: a.appId, durableId: a.durableId, keys: Object.keys(a) }));
    } else {
      const list = await measure('APP_METADATA_DIRECTORY', role, () => conn.metadata.list([{ type: 'CustomApplication' }]));
      report.metadataDirectory = (Array.isArray(list) ? list : [list]).map((a) => ({ fullName: a.fullName, id: a.id }));
      const definitions = await measure('APP_DEFINITION', role, () => conn.query('SELECT DurableId, DeveloperName, NamespacePrefix FROM AppDefinition LIMIT 101'));
      report.definitions = definitions?.records?.map((a) => ({ durableId: a.DurableId, developerName: a.DeveloperName, namespacePrefix: a.NamespacePrefix }));
      report.definitionComplete = definitions?.done === true && definitions.records.length <= 100;
      report.appJoins = [];
      if (!report.definitionComplete || report.apps?.length > 2) throw new Error('JOIN_BOUND');
      for (const app of report.apps ?? []) {
        const matches = report.definitions.filter((d) => d.durableId === app.appId && d.developerName === app.developerName);
        if (matches.length !== 1) continue;
        const definition = matches[0];
        const fullName = definition.namespacePrefix ? `${definition.namespacePrefix}__${definition.developerName}` : definition.developerName;
        if (report.metadataDirectory.filter((m) => m.fullName === fullName).length !== 1) continue;
        const metadata = await measure(`MATCHED_APP_${report.appJoins.length + 1}`, role, () => conn.metadata.read('CustomApplication', fullName));
        const asArray = (v) => v == null ? [] : Array.isArray(v) ? v : [v];
        report.appJoins.push({ developerName: app.developerName, fullName, durableIdMatches: true,
          developerNameMatches: true, namespaceQualifiedMetadataNameMatches: metadata?.fullName === fullName,
          actionOverrides: asArray(metadata?.actionOverrides).filter((o) => ['Quote__c', 'Lead', 'Opportunity'].includes(o.pageOrSobjectType)),
          profileActionOverrides: asArray(metadata?.profileActionOverrides).filter((o) => ['Quote__c', 'Lead', 'Opportunity'].includes(o.pageOrSobjectType)) });
      }
    }
  }
  report.status = 'EVIDENCE_COLLECTED';
} catch { report.status = 'BLOCKED_APP_JOIN'; process.exitCode = 1; }
finally {
  clearTimeout(timer);
  report.elapsedMs = Math.round(performance.now() - begin);
  await writeFile('.temp/p8-04a-app-join.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, elapsedMs: report.elapsedMs,
    operations: report.operations.map(({ evidence, ...op }) => op), appCount: report.apps?.length,
    appMetadataIdMatches: report.apps?.map((a) => ({ hasAppId: Boolean(a.appId), matches: report.metadataDirectory?.filter((m) => m.id === a.appId).length })) }));
}
