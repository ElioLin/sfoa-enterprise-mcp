// Read-only, one-object parser smoke. No snapshot/setting writes, DML or raw metadata files.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectEnvironment } from '../skills/sfoa-mcp-maintainer/scripts/shared/project.mjs';
import { withReadOnlyDatabase } from '../skills/sfoa-mcp-maintainer/scripts/shared/db.mjs';
import { JwtConnectionFactory, loadIdentityRuntimeConfig, createSalesforceIdentityRoute,
  installJsforceAuditAdapter, RequestAuditContextController, runWithRequestAuditContext } from '../packages/sfoa-identity-runtime/dist/index.js';
import { collectUiSnapshot } from '../packages/mcp-provider-sfoa-context/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const object = process.argv[process.argv.indexOf('--object') + 1];
const timeout = setTimeout(() => { console.error('P8_04_SMOKE_TIMEOUT'); process.exit(1); }, 150000);
try {
  if (!process.argv.includes('--object') || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(object ?? '')) throw new Error('OBJECT_ARGUMENT_REQUIRED');
  const environment = await loadProjectEnvironment(root);
  const config = await loadIdentityRuntimeConfig(root, environment.values, { routesFromDatabase: true });
  const rows = await withReadOnlyDatabase(root, environment, async (db) => db.execute(`SELECT salesforce_username FROM sfoa_diagnostic_config
    WHERE id = 1 AND enabled = TRUE AND verification_status = 'PASS'
    AND NOT EXISTS (SELECT 1 FROM sfoa_identity_route WHERE enabled = TRUE AND salesforce_username = sfoa_diagnostic_config.salesforce_username)`));
  if (rows.length !== 1) throw new Error('INDEPENDENT_DIAGNOSTIC_REQUIRED');
  const factory = new JwtConnectionFactory({ instanceUrl: config.instanceUrl, clientId: config.clientId, privateKeyPath: config.privateKeyPath });
  const connection = await factory.create(createSalesforceIdentityRoute({ platformUserId: 'p804-readonly-smoke',
    salesforceUsername: rows[0].salesforce_username, connectionRole: 'DIAGNOSTIC', credentialProfile: 'sfoa-shared-jwt', aliases: [] }));
  installJsforceAuditAdapter();
  const audit = RequestAuditContextController.create({ channel: 'MCP_STDIO', toolName: 'p804_readonly_smoke' });
  const started = performance.now();
  const snapshot = await runWithRequestAuditContext(audit, () => collectUiSnapshot(connection, object));
  const apiCalls = audit.finalizeAudit()?.salesforceApiCalls ?? [];
  const report = { status: 'PASS', kind: 'READ_ONLY_CONFIGURATION_SMOKE_NOT_UI_ACCURACY', generatedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started), parserVersion: snapshot.parserVersion,
    normalizedBytes: Buffer.byteLength(JSON.stringify(snapshot)), assignmentCount: snapshot.assignments.length,
    appCount: snapshot.apps.length, profileCount: snapshot.profiles.length, recordTypeCount: snapshot.recordTypes.length,
    pages: snapshot.pages.map((page, index) => ({ page: index + 1, formSource: page.formSource,
      fields: page.fields.length, rules: page.fields.reduce((sum, field) => sum + field.rules.length, 0),
      normalizedBytes: Buffer.byteLength(JSON.stringify(page)), unsupported: page.unsupported })),
    apiCount: apiCalls.length, api: apiCalls.map(({ apiCategory, httpMethod, httpStatus, durationMs }) => ({ apiCategory, httpMethod, httpStatus, durationMs })),
  };
  await mkdir(path.join(root, '.temp/p8-04-regression'), { recursive: true });
  await writeFile(path.join(root, '.temp/p8-04-regression/readonly-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  const code = error?.errorCode ?? error?.code ?? error?.message;
  console.error(JSON.stringify({ status: 'FAIL', code: typeof code === 'string' && /^[A-Z0-9_]{1,128}$/u.test(code) ? code : 'SMOKE_FAILED' }));
  process.exitCode = 1;
} finally { clearTimeout(timeout); }
