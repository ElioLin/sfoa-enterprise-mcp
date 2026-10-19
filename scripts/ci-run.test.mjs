import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runner = fileURLToPath(new URL('./ci-run.mjs', import.meta.url));
async function check(source, flags, verify) {
  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-ci-evidence-'));
  try {
    const filename = path.join(root, 'fixture.test.mjs');
    await writeFile(filename, source);
    const environment = { ...process.env, SFOA_TEST_SECRET: 'ci-evidence-sensitive-fixture' };
    // A nested Node test runner otherwise inherits the parent's binary IPC reporter.
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [runner, 'fixture', ...flags, '--', 'node', '--test', '--test-reporter=tap', filename], {
      cwd: root, encoding: 'utf8', env: environment,
    });
    const report = JSON.parse(await readFile(path.join(root, '.temp/p11a-ci/fixture.json'), 'utf8'));
    const log = await readFile(path.join(root, '.temp/p11a-ci/fixture.log'), 'utf8');
    verify(result, report, log);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('an all-skipped real Node suite cannot satisfy the test gate', async () => {
  await check("import test from 'node:test'; test.skip('database missing',()=>{});", ['--tests'], (result, report) => {
    assert.equal(result.status, 1);
    assert.equal(report.passed, 0);
    assert.equal(report.skipped, 1);
  });
});

test('the no-skips integration gate rejects a partially skipped suite', async () => {
  await check("import test from 'node:test'; test('runs',()=>{}); test.skip('missing',()=>{});", ['--tests', '--no-skips'], (result, report) => {
    assert.equal(result.status, 1);
    assert.equal(report.passed, 1);
    assert.equal(report.skipped, 1);
  });
});

test('a passing real suite yields counts and redacts sensitive output in console and artifact', async () => {
  await check("import test from 'node:test'; test('runs',()=>{ console.log(process.env.SFOA_TEST_SECRET); });", ['--tests', '--no-skips'], (result, report, log) => {
    assert.equal(result.status, 0);
    assert.equal(report.passed, 1);
    assert.equal(report.failed, 0);
    assert.equal(report.skipped, 0);
    assert.equal(log.includes('ci-evidence-sensitive-fixture'), false);
    assert.equal(result.stdout.includes('ci-evidence-sensitive-fixture'), false);
  });
});

test('a real failed assertion keeps the command failure and failed test count', async () => {
  await check("import test from 'node:test'; import assert from 'node:assert/strict'; test('fails',()=>assert.fail('fixture'));", ['--tests'], (result, report) => {
    assert.equal(result.status, 1);
    assert.equal(report.exitCode, 1);
    assert.equal(report.failed, 1);
  });
});
