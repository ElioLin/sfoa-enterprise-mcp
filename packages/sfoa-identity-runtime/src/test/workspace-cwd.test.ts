import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CwdExecutionGuard } from '../cwd-execution-guard.js';
import { IdentityRuntimeError } from '../errors.js';
import { RequestWorkspaceFactory } from '../workspace.js';

test('RequestWorkspaceFactory creates a bounded DX project, resolves local paths, and cleans exactly its workspace', async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p1-workspace-test-'));
  const factory = new RequestWorkspaceFactory({
    baseRoot: path.join(testRoot, 'requests'),
    metadataSeed: { type: 'CustomObject', fullName: 'Example__c' },
  });
  try {
    const workspace = await factory.create('corr-workspace', '65.0');
    assert.equal(path.isAbsolute(workspace.root), true);
    assert.equal(workspace.resolveClientPath('manifest/package.xml'), workspace.manifestPath);
    assert.throws(
      () => workspace.resolveClientPath('../escape.txt'),
      (error: unknown) => error instanceof IdentityRuntimeError && error.code === 'MCP_REQUEST_WORKSPACE_FAILED',
    );
    assert.ok((await workspace.countFiles()) >= 2);
    assert.deepEqual(factory.getMetrics().active, 1);

    await workspace.cleanup();
    await workspace.cleanup();
    await assert.rejects(access(workspace.root));
    assert.equal(factory.getMetrics().created, 1);
    assert.equal(factory.getMetrics().cleaned, 1);
    assert.equal(factory.getMetrics().active, 0);
  } finally {
    await removeTestRoot(testRoot);
  }
});

test('CwdExecutionGuard permits audited shared calls, serializes exclusive calls, and restores CWD after failure', async () => {
  const originalCwd = process.cwd();
  const testRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p1-cwd-test-'));
  const directoryA = path.join(testRoot, 'a');
  const directoryB = path.join(testRoot, 'b');
  await mkdir(directoryA);
  await mkdir(directoryB);
  const guard = new CwdExecutionGuard(originalCwd);

  try {
    await Promise.all([
      guard.runShared(async () => {
        process.chdir(directoryA);
        await delay(30);
      }),
      guard.runShared(async () => {
        process.chdir(directoryB);
        await delay(30);
      }),
    ]);
    assert.equal(process.cwd(), originalCwd);
    assert.equal(guard.getMetrics().maxConcurrentShared, 2);

    let activeExclusive = 0;
    let observedExclusive = 0;
    await Promise.all(
      [directoryA, directoryB].map((directory) =>
        guard.runExclusive(async () => {
          activeExclusive += 1;
          observedExclusive = Math.max(observedExclusive, activeExclusive);
          process.chdir(directory);
          await delay(20);
          activeExclusive -= 1;
        }),
      ),
    );
    assert.equal(observedExclusive, 1);
    assert.equal(guard.getMetrics().maxConcurrentExclusive, 1);

    await assert.rejects(
      guard.runExclusive(async () => {
        process.chdir(directoryA);
        throw new Error('expected test failure');
      }),
      /expected test failure/u,
    );
    assert.equal(process.cwd(), originalCwd);
  } finally {
    if (process.cwd() !== originalCwd) process.chdir(originalCwd);
    await removeTestRoot(testRoot);
  }
});

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function removeTestRoot(root: string): Promise<void> {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.match(path.basename(resolved), /^sfoa-p1-(?:workspace|cwd)-test-/u);
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
