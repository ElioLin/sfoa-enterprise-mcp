import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const inheritedYarnCli = process.env.npm_execpath;
const corepackYarnCli = path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'yarn.js');
const yarnCli = inheritedYarnCli && /\.[cm]?js$/iu.test(inheritedYarnCli) && existsSync(inheritedYarnCli)
  ? inheritedYarnCli
  : existsSync(corepackYarnCli) ? corepackYarnCli : undefined;
const yarn = yarnCli ? process.execPath : process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
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
  runYarn(['workspace', workspace, gate]);
}

for (const gate of ['p5:e2e', 'p5:e2e:fullstack']) {
  process.stdout.write(`\n[P5 GATE] ${gate}\n`);
  runYarn([gate]);
}

process.stdout.write('\nP5 local acceptance gates completed. The independent P4 live Salesforce DIAGNOSTIC gate retains its own PASS/NOT TESTED evidence.\n');

function runYarn(arguments_) {
  const args = [...(yarnCli ? [yarnCli] : []), ...arguments_];
  const result = spawnSync(yarn, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
