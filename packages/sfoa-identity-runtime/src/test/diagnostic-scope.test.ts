import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createIdentityRuntime } from '../runtime.js';
import { NoopRuntimeLogger } from '../runtime-logger.js';
import { RequestWorkspaceFactory } from '../workspace.js';
import { RecordingConnectionFactory } from './helpers.js';

test('DIAGNOSTIC scope is server-owned, fresh per request, correlated to the trigger user, and exactly cleaned', async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p4-diagnostic-scope-'));
  const connectionFactory = new RecordingConnectionFactory();
  const workspaceFactory = new RequestWorkspaceFactory({ baseRoot: path.join(testRoot, 'requests') });
  const runtime = createIdentityRuntime(
    {
      projectRoot: testRoot,
      instanceUrl: 'https://example.test',
      primaryUsername: 'user-a@example.test',
      diagnosticUsername: 'fixed-diagnostic@example.test',
      clientId: 'test-client',
      privateKeyPath: path.join(testRoot, 'unused-test-key.pem'),
      platformUserA: 'platform-user-a',
      platformUserB: 'platform-user-b',
      concurrentRequests: 20,
      port: 3000,
    },
    { connectionFactory, workspaceFactory, logger: new NoopRuntimeLogger() },
  );

  try {
    assert.ok(runtime.diagnosticScopeFactory);
    const first = await runtime.diagnosticScopeFactory.create({
      platformUserId: 'platform-user-a',
      correlationId: 'diagnostic-one',
    });
    const second = await runtime.diagnosticScopeFactory.create({
      platformUserId: 'platform-user-b',
      correlationId: 'diagnostic-two',
    });
    assert.equal(first.route.connectionRole, 'DIAGNOSTIC');
    assert.equal(second.route.connectionRole, 'DIAGNOSTIC');
    assert.equal(first.route.salesforceUsername, 'fixed-diagnostic@example.test');
    assert.equal(second.route.salesforceUsername, 'fixed-diagnostic@example.test');
    assert.equal(first.context.platformUserId, 'platform-user-a');
    assert.equal(second.context.platformUserId, 'platform-user-b');
    assert.notEqual(first.connection, second.connection);
    assert.notEqual(first.workspace.root, second.workspace.root);

    await Promise.all([first.close(), second.close()]);
    assert.deepEqual(workspaceFactory.getMetrics(), {
      created: 2,
      cleaned: 2,
      active: 0,
      createdRoots: workspaceFactory.getMetrics().createdRoots,
    });
    assert.deepEqual(connectionFactory.creations.map((entry) => entry.salesforceUsername), [
      'fixed-diagnostic@example.test',
      'fixed-diagnostic@example.test',
    ]);
  } finally {
    await rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('identity runtime omits the DIAGNOSTIC scope factory when no diagnostic user is configured', () => {
  const runtime = createIdentityRuntime(
    {
      projectRoot: process.cwd(),
      instanceUrl: 'https://example.test',
      primaryUsername: 'user-a@example.test',
      clientId: 'test-client',
      privateKeyPath: 'unused-test-key.pem',
      platformUserA: 'platform-user-a',
      platformUserB: 'platform-user-b',
      concurrentRequests: 20,
      port: 3000,
    },
    { connectionFactory: new RecordingConnectionFactory(), logger: new NoopRuntimeLogger() },
  );
  assert.equal(runtime.diagnosticScopeFactory, undefined);
});

test('identity runtime rejects a DIAGNOSTIC username that aliases a configured USER', () => {
  assert.throws(
    () => createIdentityRuntime(
      {
        projectRoot: process.cwd(),
        instanceUrl: 'https://example.test',
        primaryUsername: 'user-a@example.test',
        diagnosticUsername: 'USER-A@EXAMPLE.TEST',
        clientId: 'test-client',
        privateKeyPath: 'unused-test-key.pem',
        platformUserA: 'platform-user-a',
        platformUserB: 'platform-user-b',
        concurrentRequests: 20,
        port: 3000,
      },
      { connectionFactory: new RecordingConnectionFactory(), logger: new NoopRuntimeLogger() },
    ),
    /SFOA_DIAGNOSTIC_USERNAME must be distinct/iu,
  );
});
