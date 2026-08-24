import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const workspaceDirectories = new Map([
  ['@sfoa/control-plane', 'packages/sfoa-control-plane'],
  ['@sfoa/admin-api', 'packages/sfoa-admin-api'],
  ['@sfoa/admin-web', 'packages/sfoa-admin-web'],
  ['@sfoa/mcp-server', 'packages/sfoa-mcp-server'],
  ['@sfoa/identity-runtime', 'packages/sfoa-identity-runtime'],
]);
const gates = [
  ['@sfoa/control-plane', 'lint'],
  ['@sfoa/admin-api', 'lint'],
  ['@sfoa/admin-web', 'lint'],
  ['@sfoa/mcp-server', 'lint'],
  ['@sfoa/identity-runtime', 'lint'],
  ['@sfoa/control-plane', 'test'],
  ['@sfoa/control-plane', 'test:mysql'],
  ['@sfoa/identity-runtime', 'test'],
  ['@sfoa/mcp-server', 'test:p5'],
  ['@sfoa/admin-api', 'test'],
  ['@sfoa/admin-web', 'build'],
  ['@sfoa/admin-web', 'test'],
];

for (const [workspace, gate] of gates) {
  process.stdout.write(`\n[P5 GATE] ${workspace} ${gate}\n`);
  runWorkspace(workspace, gate);
}

process.stdout.write('\n[P5 GATE] p5:e2e\n');
runWorkspace('@sfoa/admin-web', 'e2e');

process.stdout.write('\n[P5 GATE] p5:e2e:fullstack prerequisites\n');
runWorkspace('@sfoa/control-plane', 'build');
runWorkspace('@sfoa/admin-api', 'build');
runWorkspace('@sfoa/admin-web', 'build');
process.stdout.write('\n[P5 GATE] p5:e2e:fullstack\n');
runProcess(process.execPath, [path.join(process.cwd(), 'scripts/p5-fullstack-e2e.mjs')]);

process.stdout.write('\nP5 local acceptance gates completed. The independent P4 live Salesforce DIAGNOSTIC gate retains its own PASS/NOT TESTED evidence.\n');

function runWorkspace(workspace, gate) {
  const relativeDirectory = workspaceDirectories.get(workspace);
  if (!relativeDirectory) throw new Error(`Unknown P5 validation workspace: ${workspace}`);
  const directory = path.join(process.cwd(), relativeDirectory);
  for (const arguments_ of workspaceGateCommands(workspace, gate)) {
    runProcess(process.execPath, arguments_, directory);
  }
}

function workspaceGateCommands(workspace, gate) {
  const lint = ['./node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit'];
  const build = ['./node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'];
  if (gate === 'lint') return [lint];
  if (gate === 'build' && workspace === '@sfoa/admin-web') {
    return [lint, ['./node_modules/vite/bin/vite.js', 'build']];
  }
  if (gate === 'build') return [build];
  if (workspace === '@sfoa/control-plane' && gate === 'test') return [build, ['--test', 'dist/test/*.test.js']];
  if (workspace === '@sfoa/control-plane' && gate === 'test:mysql') return [build, ['--test', 'dist/mysql-test/*.test.js']];
  if (workspace === '@sfoa/identity-runtime' && gate === 'test') return [build, ['--test', 'dist/test/*.test.js']];
  if (workspace === '@sfoa/mcp-server' && gate === 'test:p5') return [build, ['--test', 'dist/p5-test/*.test.js']];
  if (workspace === '@sfoa/admin-api' && gate === 'test') return [build, ['--test', 'dist/test/*.test.js']];
  if (workspace === '@sfoa/admin-web' && gate === 'test') return [['./node_modules/vitest/vitest.mjs', 'run']];
  if (workspace === '@sfoa/admin-web' && gate === 'e2e') return [['./node_modules/@playwright/test/cli.js', 'test']];
  throw new Error(`Unknown P5 validation gate: ${workspace} ${gate}`);
}

function runProcess(command, arguments_, cwd = process.cwd()) {
  const result = spawnSync(command, arguments_, {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
