import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { withReadOnlyDatabase } from './shared/db.mjs';
import {
  configurationStatus,
  exists,
  findProjectRoot,
  loadProjectEnvironment,
  parseCliArguments,
  readWorkspacePackages,
  runCommand,
  sanitizeForOutput,
} from './shared/project.mjs';

const CORE_ENV_KEYS = Object.freeze([
  'SFOA_CONTROL_PLANE_MODE', 'SFOA_DB_HOST', 'SFOA_DB_PORT', 'SFOA_DB_NAME', 'SFOA_DB_USER', 'SFOA_DB_PASSWORD',
  'SFOA_INSTANCE_URL', 'CONNECTED_APP_CLIENT_ID', 'JWT_PRIVATE_KEY_PATH',
  'MCP_AUTH_MODE', 'MCP_CLIENT_TOKEN', 'MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY',
  'SFOA_ADMIN_USERNAME', 'SFOA_ADMIN_PASSWORD', 'SFOA_ADMIN_SESSION_SECRET',
]);

export async function runDoctor(options = {}) {
  const projectRoot = options.projectRoot ?? await findProjectRoot();
  const environment = options.environment ?? await loadProjectEnvironment(projectRoot);
  const rootManifestPath = path.join(projectRoot, 'package.json');
  const rootManifest = JSON.parse(await readFile(rootManifestPath, 'utf8'));
  const workspaces = await readWorkspacePackages(projectRoot);
  const [yarn, gitBranch, gitStatus] = await Promise.all([
    detectYarn(projectRoot),
    runCommand('git', ['branch', '--show-current'], { cwd: projectRoot }),
    runCommand('git', ['status', '--porcelain=v1'], { cwd: projectRoot }),
  ]);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const packageChecks = Object.freeze({
    runtime: workspaces.some((item) => item.name === '@sfoa/mcp-server'),
    controlPlane: workspaces.some((item) => item.name === '@sfoa/control-plane'),
    adminApi: workspaces.some((item) => item.name === '@sfoa/admin-api'),
    adminWeb: workspaces.some((item) => item.name === '@sfoa/admin-web'),
    agentPlaybook: workspaces.some((item) => item.name === '@sfoa/agent-playbook'),
  });
  const scriptChecks = Object.freeze(Object.fromEntries([
    'build', 'test', 'lint', 'p5:test', 'validate:p5', 'skill:sync', 'skill:check', 'skill:package',
  ].map((name) => [name, typeof rootManifest.scripts?.[name] === 'string'])));
  const report = {
    status: 'PASS',
    projectRoot,
    node: { version: process.version, supported: nodeMajor >= 22 },
    yarn: { version: yarn.ok ? yarn.stdout : null, available: yarn.ok, requiredFamily: '1.x Classic' },
    git: {
      available: gitBranch.ok && gitStatus.ok,
      branch: gitBranch.ok ? gitBranch.stdout || '(detached)' : null,
      dirtyEntries: gitStatus.ok ? gitStatus.stdout.split(/\r?\n/u).filter(Boolean).length : null,
    },
    workspace: {
      packageCount: workspaces.length,
      configuredPatterns: rootManifest.workspaces?.packages ?? [],
      nohoist: rootManifest.workspaces?.nohoist ?? [],
      packages: packageChecks,
      scripts: scriptChecks,
    },
    localEnvironment: {
      file: '.env.local',
      exists: environment.fileExists,
      keys: configurationStatus(environment, CORE_ENV_KEYS),
    },
    database: { status: options.skipDatabase ? 'SKIPPED' : 'NOT_CHECKED' },
    orgObjectUsage: await checkOrgObjectUsage(projectRoot),
    services: options.skipServices ? { status: 'SKIPPED' } : await checkServices(environment),
  };
  if (!options.skipDatabase) report.database = await checkDatabase(projectRoot, environment, options.databaseProbe);
  const requiredBooleans = [report.node.supported, report.yarn.available, ...Object.values(packageChecks), ...Object.values(scriptChecks)];
  if (requiredBooleans.some((value) => value !== true)) report.status = 'FAIL';
  else if (report.orgObjectUsage.status === 'FAIL') report.status = 'FAIL';
  else if (!environment.fileExists || report.database.status !== 'PASS') report.status = 'DEGRADED';
  return Object.freeze(sanitizeForOutput(report, environment));
}

async function checkOrgObjectUsage(projectRoot) {
  const agentPlaybookEntry = path.join(projectRoot, 'packages', 'sfoa-agent-playbook', 'dist', 'index.js');
  if (!await exists(agentPlaybookEntry)) {
    return Object.freeze({
      status: 'SKIPPED',
      reason: 'sfoa-agent-playbook is not built; run its build or test first',
    });
  }
  try {
    const playbook = await import(pathToFileURL(agentPlaybookEntry).href);
    const substitutions = Array.isArray(playbook.ORG_OBJECT_SUBSTITUTIONS) ? playbook.ORG_OBJECT_SUBSTITUTIONS : [];
    const structuralProblems = typeof playbook.findOrgObjectSubstitutionProblems === 'function'
      ? playbook.findOrgObjectSubstitutionProblems()
      : ['findOrgObjectSubstitutionProblems is unavailable in the built agent-playbook'];
    const inventoryProblems = typeof playbook.findOrgObjectInventoryProblems === 'function'
      ? playbook.findOrgObjectInventoryProblems()
      : ['findOrgObjectInventoryProblems is unavailable in the built agent-playbook'];
    const problems = [...structuralProblems, ...inventoryProblems];
    return Object.freeze({
      status: problems.length === 0 ? 'PASS' : 'FAIL',
      substitutions: substitutions.length,
      standardObjects: Object.freeze(
        substitutions.map((entry) => entry?.standardObjectApiName ?? '').filter(Boolean).sort((left, right) => left.localeCompare(right, 'en-US')),
      ),
      customObjects: Object.freeze(
        substitutions.map((entry) => entry?.customObjectApiName ?? '').filter(Boolean).sort((left, right) => left.localeCompare(right, 'en-US')),
      ),
      inventoryRecordedOn: typeof playbook.ORG_OBJECT_INVENTORY_RECORDED_ON === 'string'
        ? playbook.ORG_OBJECT_INVENTORY_RECORDED_ON
        : null,
      problems: Object.freeze(problems),
    });
  } catch (error) {
    return Object.freeze({
      status: 'FAIL',
      problems: Object.freeze([error instanceof Error ? error.message : String(error)]),
    });
  }
}

async function checkDatabase(projectRoot, environment, databaseProbe) {
  try {
    if (databaseProbe) return await databaseProbe();
    return await withReadOnlyDatabase(projectRoot, environment, async (database) => {
      const versionRows = await database.execute('SELECT VERSION() AS version');
      const tableRows = await database.execute(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name LIKE ? ORDER BY table_name',
        [database.database, 'sfoa\\_%'],
      );
      const migrations = await database.execute('SELECT version, applied_at FROM sfoa_schema_migration ORDER BY version');
      const expected = ['sfoa_identity_route', 'sfoa_tool_control', 'sfoa_dml_policy', 'sfoa_runtime_setting', 'sfoa_audit_log', 'sfoa_audit_event', 'sfoa_salesforce_api_call', 'sfoa_audit_payload_evidence'];
      const names = new Set(tableRows.map((row) => row.table_name ?? row.TABLE_NAME ?? row.Table_name));
      return Object.freeze({
        status: expected.every((name) => names.has(name)) ? 'PASS' : 'DEGRADED',
        version: versionRows[0]?.version ?? null,
        schema: database.database,
        tableCount: tableRows.length,
        missingCoreTables: expected.filter((name) => !names.has(name)),
        appliedMigrations: migrations.map((row) => row.version),
      });
    });
  } catch (error) {
    return Object.freeze({ status: 'UNAVAILABLE', error: safeError(error) });
  }
}

async function detectYarn(projectRoot) {
  const fromAgent = /(?:^|\s)yarn\/([0-9.]+)/u.exec(process.env.npm_config_user_agent ?? '')?.[1];
  if (fromAgent) return Object.freeze({ ok: true, stdout: fromAgent, stderr: '' });
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    const viaCurrentRuntime = await runCommand(process.execPath, [npmExecPath, '--version'], { cwd: projectRoot });
    if (viaCurrentRuntime.ok) return viaCurrentRuntime;
  }
  return await runCommand('yarn', ['--version'], { cwd: projectRoot });
}

async function checkServices(environment) {
  const values = environment.values;
  const mcpPort = safePort(values.MCP_PORT, 8080);
  const adminPort = safePort(values.SFOA_ADMIN_PORT, 8081);
  const endpoints = Object.freeze({
    mcp: `http://127.0.0.1:${mcpPort}/health`,
    adminApi: `http://127.0.0.1:${adminPort}/admin/api/ready`,
    adminWeb: 'http://127.0.0.1:5173/login',
  });
  const entries = await Promise.all(Object.entries(endpoints).map(async ([name, url]) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500), redirect: 'manual' });
      return [name, { reachable: true, httpStatus: response.status }];
    } catch {
      return [name, { reachable: false, httpStatus: null }];
    }
  }));
  const checks = Object.freeze(Object.fromEntries(entries));
  return Object.freeze({
    status: Object.values(checks).every((item) => item.reachable) ? 'PASS' : 'NOT_RUNNING',
    checks,
  });
}

function safePort(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback;
}

function safeError(error) {
  if (!(error instanceof Error)) return 'Database check failed.';
  return error.message.replace(/password\s*[:=]\s*[^\s,;]+/giu, 'password=[REDACTED]').slice(0, 512);
}

async function main() {
  const arguments_ = parseCliArguments(process.argv.slice(2));
  const projectRoot = arguments_['project-root'] ? path.resolve(String(arguments_['project-root'])) : await findProjectRoot();
  const report = await runDoctor({
    projectRoot,
    skipDatabase: arguments_['skip-db'] === true,
    skipServices: arguments_['skip-services'] === true,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status === 'FAIL') process.exitCode = 1;
}

const isCli = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isCli) main().catch((error) => {
  process.stderr.write(`[doctor] ${safeError(error)}\n`);
  process.exitCode = 1;
});
