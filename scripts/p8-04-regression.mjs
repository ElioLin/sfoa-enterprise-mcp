// Runs repository-local executables directly, avoiding Windows Yarn nested-shell failures.
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.temp/p8-04-regression');
await mkdir(output, { recursive: true });
const packages = ['sfoa-identity-runtime', 'sfoa-control-plane', 'mcp-provider-sfoa-context', 'mcp-provider-sfoa-dml', 'sfoa-agent-playbook', 'sfoa-mcp-server', 'sfoa-admin-api', 'sfoa-admin-web'];
const selected = process.argv.slice(2);
const results = [];
async function run(name, workspace, args) {
  const start = performance.now();
  let text = '';
  const status = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: path.join(root, 'packages', workspace), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.stderr.on('data', (chunk) => { text += chunk; });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
  const result = { name, status: status === 0 ? 'PASS' : 'FAIL', durationMs: Math.round(performance.now() - start), command: [process.execPath, ...args] };
  results.push(result);
  await writeFile(path.join(output, `${name}.log`), text);
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(result));
  if (status !== 0) process.exitCode = 1;
  return status === 0;
}
for (const workspace of packages.filter((name) => !selected.length || selected.includes(name))) {
  if (workspace === 'sfoa-admin-web') {
    if (!await run(`${workspace}-lint`, workspace, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit'])) continue;
    await run(`${workspace}-build`, workspace, ['node_modules/vite/bin/vite.js', 'build']);
    await run(`${workspace}-test`, workspace, ['node_modules/vitest/vitest.mjs', 'run']);
  } else {
    if (!await run(`${workspace}-build`, workspace, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'])) continue;
    await run(`${workspace}-lint`, workspace, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit']);
    await run(`${workspace}-test`, workspace, ['--test-concurrency=1', '--test', 'dist/test/*.test.js']);
    if (workspace === 'sfoa-control-plane') await run(`${workspace}-mysql`, workspace, ['--test-concurrency=1', '--test', 'dist/mysql-test/*.test.js']);
    if (workspace === 'sfoa-mcp-server') {
      for (const suite of ['p3-test', 'p4-test', 'p5-test', 'p7-test']) await run(`${workspace}-${suite}`, workspace, ['--test-concurrency=1', '--test', `dist/${suite}/*.test.js`]);
      await run(`${workspace}-upstream`, workspace, ['dist/validation/upstream-compatibility.js']);
    }
  }
}
