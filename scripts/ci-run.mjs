import { spawn } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { stripVTControlCharacters } from 'node:util';
import { yarnInvocation } from './build-workspaces.mjs';

// Keep command results even on failure; never turn a missing/skipped suite into success.
const [label, ...args] = process.argv.slice(2);
const separator = args.indexOf('--');
if (!/^[a-z0-9-]+$/u.test(label ?? '') || separator < 0) {
  throw new Error('Usage: ci-run.mjs <label> [--tests] [--no-skips] -- <yarn|node> <arguments...>');
}
const options = args.slice(0, separator);
const [command, ...commandArgs] = args.slice(separator + 1);
if (!['yarn', 'node'].includes(command)) throw new Error('Only repository Yarn/Node commands are supported.');
const directory = path.resolve('.temp/p11a-ci');
await mkdir(directory, { recursive: true });
const invocation = command === 'yarn' ? yarnInvocation(commandArgs)
  : { command: process.execPath, args: commandArgs, shell: false };
let output = '';
const start = Date.now();
const exitCode = await new Promise((resolve) => {
  const child = spawn(invocation.command, invocation.args, {
    cwd: process.cwd(), shell: invocation.shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk) => { output += chunk.toString(); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.once('error', (error) => { output += error.message; resolve(1); });
  child.once('close', (code) => resolve(code ?? 1));
});
const plain = stripVTControlCharacters(output);
const counts = { passed: 0, failed: 0, skipped: 0, cancelled: 0, todo: 0 };
for (const key of ['pass', 'fail', 'skipped', 'cancelled', 'todo']) {
  const name = key === 'pass' ? 'passed' : key === 'fail' ? 'failed' : key;
  for (const match of plain.matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`, 'gm'))) counts[name] += Number(match[1]);
}
for (const match of plain.matchAll(/^\s*Tests\s+(.+)$/gmu)) {
  for (const [word, key] of [['passed', 'passed'], ['failed', 'failed'], ['skipped', 'skipped'], ['todo', 'todo']]) {
    const count = new RegExp(`(\\d+) ${word}`).exec(match[1]);
    if (count) counts[key] += Number(count[1]);
  }
}
for (const match of plain.matchAll(/^\s*(\d+) (passing|pending|failing)(?:\s|$)/gmu)) {
  counts[{ passing: 'passed', pending: 'skipped', failing: 'failed' }[match[2]]] += Number(match[1]);
}
// Playwright's summary uses "passed", rather than Mocha's "passing".
for (const match of plain.matchAll(/^\s*(\d+) (passed|skipped|failed)(?: \([^)]+\))?\s*$/gmu)) {
  counts[match[2]] += Number(match[1]);
}
let status = exitCode;
if (options.includes('--tests') && counts.passed === 0) status = status || 1;
if (options.includes('--no-skips') && (counts.skipped || counts.cancelled || counts.todo)) status = status || 1;
if (counts.failed || counts.cancelled) status = status || 1;
let safeOutput = plain;
for (const [key, value] of Object.entries(process.env)) {
  if (/(?:TOKEN|PASSWORD|SECRET|AUTH_URL|PRIVATE_KEY)/iu.test(key) && value?.length >= 4) safeOutput = safeOutput.replaceAll(value, '[REDACTED]');
}
safeOutput = safeOutput.replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]')
  .replace(/sfoa_ub1_[A-Za-z0-9_-]+/gu, '[REDACTED]')
  .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[REDACTED]');
const result = { label, command: [command, ...commandArgs], exitCode, gateExitCode: status,
  ...counts, durationMs: Date.now() - start, sha: process.env.GITHUB_SHA ?? null,
  headSha: process.env.P11A_HEAD_SHA ?? null };
await writeFile(path.join(directory, `${label}.json`), `${JSON.stringify(result, null, 2)}\n`);
// Artifacts contain a bounded, redacted tail, never env files or an entire service log directory.
await writeFile(path.join(directory, `${label}.log`), safeOutput.slice(-65_536));
process.stdout.write(`${safeOutput.slice(-16_384)}\n${JSON.stringify(result)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `| ${label} | ${status} | ${counts.passed} | ${counts.failed} | ${counts.skipped} |\n`);
}
process.exitCode = status;
