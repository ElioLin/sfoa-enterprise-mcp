import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const bootstrap = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'node-test-lifecycle.mjs')).href;
function runFixture(body, timeoutMs = 8000) {
  const parent = path.resolve(tmpdir());
  const directory = mkdtempSync(path.join(parent, 'sfoa-node-test-lifecycle-'));
  const file = path.join(directory, 'scenario.test.mjs');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  writeFileSync(file, "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" + body);
  try {
    return spawnSync(process.execPath, ['--import', bootstrap, '--test', '--test-reporter=tap', '--test-timeout=' + timeoutMs, file],
      { encoding: 'utf8', env, timeout: timeoutMs + 15000, windowsHide: true });
  } finally {
    // Only remove the uniquely created fixture directory inside the resolved temp parent.
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith('sfoa-node-test-lifecycle-'));
    rmSync(directory, { recursive: true, force: true });
  }
}

test('unref deadlines settle and their existing assertions actually execute', () => {
  const result = runFixture("test('deadline', async () => { const value = await new Promise(resolve => setTimeout(() => resolve(42), 20).unref()); assert.equal(value, 42); console.log('DEADLINE_ASSERTION_EXECUTED'); });");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /DEADLINE_ASSERTION_EXECUTED/u);
  assert.match(result.stdout, /# pass 1\b/u);
  assert.match(result.stdout, /# cancelled 0\b/u);
});

test('the lifecycle handle cannot conceal a failed assertion', () => {
  const result = runFixture("test('failure', () => { assert.equal(1, 2); });");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /# fail 1\b/u);
});

test('a truly pending test still fails at the native timeout and terminates', () => {
  const result = runFixture("test('pending', async () => { console.log('PENDING_TEST_ENTERED'); await new Promise(() => {}); });");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /PENDING_TEST_ENTERED/u);
  assert.match(result.stdout, /testTimeoutFailure/u);
  assert.match(result.stdout, /# pass 0\b/u);
});
