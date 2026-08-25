import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = new Map();
let stopping = false;
let finalExitCode = 0;
let finish;
const finished = new Promise((resolve) => { finish = resolve; });

process.once('SIGINT', () => { void stop(0, '[P5 DEV] stopping services.'); });
process.once('SIGTERM', () => { void stop(0, '[P5 DEV] stopping services.'); });

try {
  // Yarn Classic on Windows can transiently deny Vite/esbuild startup while TypeScript
  // builds are creating workspace process trees. Build the backends first, deterministically.
  // P6-ID-01 HOTFIX01: control-plane must be built BEFORE mcp-server/admin-api so that the
  // freshly compiled control-plane (USER_BOUND credential repos, migrations, identity-credential
  // cipher) is what the runtime loads — a stale control-plane dist was the mixed-version cause
  // of MCP_ADMIN_NOT_FOUND and the P5 delete semantics.
  await runTypeScriptBuild('Control Plane', 'sfoa-control-plane');
  await runTypeScriptBuild('MCP runtime', 'sfoa-mcp-server');
  await runTypeScriptBuild('Admin API', 'sfoa-admin-api');

  const [{ loadRemoteRuntimeConfig }, { loadAdminApiConfig }] = await Promise.all([
    import('../packages/sfoa-mcp-server/dist/index.js'),
    import('../packages/sfoa-admin-api/dist/index.js'),
  ]);
  const [mcpConfig, adminConfig] = await Promise.all([
    loadRemoteRuntimeConfig(projectRoot),
    loadAdminApiConfig(projectRoot),
  ]);
  const webOrigin = 'http://127.0.0.1:5173';
  if (adminConfig.allowedOrigin !== webOrigin) {
    throw new Error(
      `SFOA_ADMIN_ALLOWED_ORIGIN must be ${webOrigin} for yarn p5:dev; configured ${adminConfig.allowedOrigin}.`,
    );
  }

  await assertPortsAvailable([
    { label: 'MCP runtime', host: mcpConfig.bindHost, port: mcpConfig.port },
    { label: 'Admin API', host: adminConfig.bindHost, port: adminConfig.port },
    { label: 'Admin Web', host: '127.0.0.1', port: 5173 },
  ]);

  startService('MCP runtime', {
    cwd: path.join(projectRoot, 'packages', 'sfoa-mcp-server'),
    args: [path.join(projectRoot, 'packages', 'sfoa-mcp-server', 'dist', 'main.js')],
  });
  startService('Admin API', {
    cwd: path.join(projectRoot, 'packages', 'sfoa-admin-api'),
    args: [path.join(projectRoot, 'packages', 'sfoa-admin-api', 'dist', 'main.js')],
  });

  const mcpHealth = localUrl(mcpConfig.bindHost, mcpConfig.port, '/health');
  const adminReady = localUrl(adminConfig.bindHost, adminConfig.port, '/admin/api/ready');
  await Promise.all([
    waitForHttp('MCP runtime', mcpHealth, 60_000),
    waitForHttp('Admin API', adminReady, 60_000),
  ]);

  const adminApiOrigin = localUrl(adminConfig.bindHost, adminConfig.port, '/').origin;
  startService('Admin Web', {
    cwd: path.join(projectRoot, 'packages', 'sfoa-admin-web'),
    args: [path.join(projectRoot, 'packages', 'sfoa-admin-web', 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1'],
    env: { ...process.env, SFOA_ADMIN_API_PROXY_TARGET: adminApiOrigin },
  });
  await waitForHttp('Admin Web', new URL('/login', webOrigin), 30_000);

  process.stdout.write(
    `[P5 DEV] ready: MCP ${mcpHealth.origin}, Admin API ${adminReady.origin}, Admin Web ${webOrigin}\n` +
    `[P5 DEV] capabilities: USER_BOUND_CREDENTIAL enabled (sfoa_ub1_ bearer on ${mcpHealth.origin}/mcp)\n`,
  );
  await finished;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await stop(1, `[P5 DEV] startup failed: ${message}`);
}

process.exitCode = finalExitCode;

async function runTypeScriptBuild(label, workspaceName) {
  process.stdout.write(`[P5 DEV] building ${label}\n`);
  const workspaceRoot = path.join(projectRoot, 'packages', workspaceName);
  const compiler = path.join(workspaceRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const config = path.join(workspaceRoot, 'tsconfig.json');
  await new Promise((resolve, reject) => {
    const childKey = `${label} build`;
    const child = spawn(process.execPath, [compiler, '-p', config], {
      cwd: workspaceRoot,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    children.set(childKey, child);
    child.once('error', (error) => {
      children.delete(childKey);
      reject(new Error(`${label} build could not start (${safeCode(error)}).`, { cause: error }));
    });
    child.once('exit', (code, signal) => {
      children.delete(childKey);
      if (code === 0 && !signal) resolve();
      else reject(new Error(`${label} build exited (${signal ?? code ?? 'unknown'}).`));
    });
  });
}

function startService(label, options) {
  process.stdout.write(`[P5 DEV] starting ${label}\n`);
  const child = spawn(process.execPath, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  children.set(label, child);
  child.once('error', (error) => {
    if (!stopping) void stop(1, `[P5 DEV] ${label} could not start (${safeCode(error)}).`);
  });
  child.once('exit', (code, signal) => {
    children.delete(label);
    if (!stopping) {
      void stop(code && code > 0 ? code : 1, `[P5 DEV] ${label} exited (${signal ?? code ?? 'unknown'}); stopping peers.`);
    }
  });
}

async function assertPortsAvailable(ports) {
  for (const port of ports) await assertPortAvailable(port);
}

async function assertPortAvailable({ label, host, port }) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', (error) => {
      const code = safeCode(error);
      reject(new Error(
        `${label} cannot bind ${host}:${port} (${code}). Stop the existing process on that port before running yarn p5:dev.`,
        { cause: error },
      ));
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
}

async function waitForHttp(label, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // The bounded startup poll intentionally waits for the listener and dependencies.
    }
    await delay(250);
  }
  if (stopping) throw new Error(`${label} startup was cancelled.`);
  throw new Error(`${label} did not become ready at ${url.href} within ${timeoutMs} ms.`);
}

async function stop(exitCode, message) {
  if (stopping) return;
  stopping = true;
  finalExitCode = exitCode;
  if (message) (exitCode === 0 ? process.stdout : process.stderr).write(`${message}\n`);
  await Promise.all([...children.values()].map(terminateChild));
  finish();
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => {
        child.kill();
        resolve();
      });
      killer.once('exit', () => resolve());
    });
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(5_000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); }),
  ]);
}

function localUrl(bindHost, port, pathname) {
  const host = bindHost === '0.0.0.0' || bindHost === '::'
    ? '127.0.0.1'
    : bindHost.includes(':') ? `[${bindHost}]` : bindHost;
  return new URL(pathname, `http://${host}:${port}`);
}

function safeCode(error) {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
