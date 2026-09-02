import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import type { SalesforceIdentityRoute } from '../contracts.js';
import type { SalesforceConnectionFactory } from '../connection-factory.js';
import { IdentityRuntimeError } from '../errors.js';
import { RecordingConnectionFactory, TEST_ROUTE_A, TEST_ROUTE_B, createTestScopeFactory } from './helpers.js';

test('RequestScope creates zero Connections and memoizes first, repeated, and concurrent access', async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p7-09-lazy-'));
  const connectionFactory = new RecordingConnectionFactory();
  const setup = createTestScopeFactory({ baseRoot: path.join(testRoot, 'requests'), connectionFactory });
  const scope = await setup.scopeFactory.create({ platformUserId: TEST_ROUTE_A.platformUserId, correlationId: 'lazy-a' });
  try {
    assert.equal(connectionFactory.creations.length, 0);
    await assert.rejects(readFile(path.join(scope.workspace.root, 'sfdx-project.json'), 'utf8'));

    const promises = [scope.getConnection(), scope.getConnection(), scope.getConnection()];
    assert.equal(promises[0], promises[1]);
    assert.equal(promises[1], promises[2]);
    const connections = await Promise.all(promises);
    assert.equal(connectionFactory.creations.length, 1);
    assert.equal(new Set(connections).size, 1);
    assert.equal(await scope.getConnection(), connections[0]);
    assert.equal(connectionFactory.creations.length, 1);
    assert.equal(projectApiVersion(await readFile(path.join(scope.workspace.root, 'sfdx-project.json'), 'utf8')), '65.0');
  } finally {
    await scope.close();
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('two RequestScopes never share their memoized Connection or route', async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p7-09-scopes-'));
  const connectionFactory = new RecordingConnectionFactory();
  const setup = createTestScopeFactory({ baseRoot: path.join(testRoot, 'requests'), connectionFactory });
  const [scopeA, scopeB] = await Promise.all([
    setup.scopeFactory.create({ platformUserId: TEST_ROUTE_A.platformUserId, correlationId: 'scope-a' }),
    setup.scopeFactory.create({ platformUserId: TEST_ROUTE_B.platformUserId, correlationId: 'scope-b' }),
  ]);
  try {
    assert.equal(connectionFactory.creations.length, 0);
    const [connectionA, connectionB] = await Promise.all([scopeA.getConnection(), scopeB.getConnection()]);
    assert.notEqual(connectionA, connectionB);
    assert.deepEqual(connectionFactory.creations.map((entry) => entry.platformUserId).sort(), [
      TEST_ROUTE_A.platformUserId,
      TEST_ROUTE_B.platformUserId,
    ]);
  } finally {
    await Promise.all([scopeA.close(), scopeB.close()]);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('lazy initialization failure is memoized, correlated, and cleanup-safe', async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p7-09-failure-'));
  let creates = 0;
  const factory: SalesforceConnectionFactory = {
    create: async () => {
      creates += 1;
      throw new IdentityRuntimeError('MCP_SALESFORCE_AUTH_FAILED', 'safe lazy authentication failure');
    },
  };
  const setup = createTestScopeFactory({ baseRoot: path.join(testRoot, 'requests'), connectionFactory: factory });
  const scope = await setup.scopeFactory.create({ platformUserId: TEST_ROUTE_A.platformUserId, correlationId: 'lazy-failure' });
  try {
    const first = scope.getConnection();
    const second = scope.getConnection();
    assert.equal(first, second);
    for (const attempt of [first, second]) {
      await assert.rejects(attempt, (error: unknown) =>
        error instanceof IdentityRuntimeError
        && error.code === 'MCP_SALESFORCE_AUTH_FAILED'
        && error.correlationId === 'lazy-failure');
    }
    assert.equal(creates, 1);
  } finally {
    await scope.close();
    assert.equal(setup.workspaceFactory.getMetrics().active, 0);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('lazy Connection creation failure retains its specific taxonomy and correlation', async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p7-09-connection-failure-'));
  let creates = 0;
  const factory: SalesforceConnectionFactory = {
    create: async () => {
      creates += 1;
      throw new IdentityRuntimeError('MCP_SALESFORCE_CONNECTION_FAILED', 'safe lazy Connection failure');
    },
  };
  const setup = createTestScopeFactory({ baseRoot: path.join(testRoot, 'requests'), connectionFactory: factory });
  const scope = await setup.scopeFactory.create({
    platformUserId: TEST_ROUTE_A.platformUserId,
    correlationId: 'lazy-connection-failure',
  });
  try {
    const attempts = [scope.getConnection(), scope.getConnection()];
    assert.equal(attempts[0], attempts[1]);
    for (const attempt of attempts) {
      await assert.rejects(attempt, (error: unknown) =>
        error instanceof IdentityRuntimeError
        && error.code === 'MCP_SALESFORCE_CONNECTION_FAILED'
        && error.correlationId === 'lazy-connection-failure');
    }
    assert.equal(creates, 1);
  } finally {
    await scope.close();
    assert.equal(setup.workspaceFactory.getMetrics().active, 0);
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('closing an unused or initializing lazy resource never recreates the workspace', async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p7-09-close-'));
  let release: ((connection: Connection) => void) | undefined;
  let creates = 0;
  const factory: SalesforceConnectionFactory = {
    create: async (_route: SalesforceIdentityRoute) => {
      creates += 1;
      return await new Promise<Connection>((resolve) => { release = resolve; });
    },
  };
  const setup = createTestScopeFactory({ baseRoot: path.join(testRoot, 'requests'), connectionFactory: factory });
  const unused = await setup.scopeFactory.create({ platformUserId: TEST_ROUTE_A.platformUserId, correlationId: 'unused' });
  await unused.close();
  assert.equal(creates, 0);

  const initializing = await setup.scopeFactory.create({ platformUserId: TEST_ROUTE_A.platformUserId, correlationId: 'initializing' });
  const pending = initializing.getConnection();
  await initializing.close();
  release?.({ getApiVersion: () => '65.0' } as unknown as Connection);
  await assert.rejects(pending, (error: unknown) =>
    error instanceof IdentityRuntimeError && error.code === 'MCP_REQUEST_SCOPE_FAILED');
  assert.equal(setup.workspaceFactory.getMetrics().active, 0);
  await rm(testRoot, { recursive: true, force: true });
});

function projectApiVersion(source: string): string | undefined {
  const parsed = JSON.parse(source) as { sourceApiVersion?: unknown };
  return typeof parsed.sourceApiVersion === 'string' ? parsed.sourceApiVersion : undefined;
}
