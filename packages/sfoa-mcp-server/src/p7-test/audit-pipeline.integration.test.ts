import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  AsyncAuditPipeline,
  DatabaseRuntimeLogger,
  type AuditQueueEntry,
  type AuditRepository,
} from '@sfoa/control-plane';
import { NoopRuntimeLogger, type RuntimeLogger } from '@sfoa/identity-runtime';
import { startRemoteMcpServer, type RemoteMcpServer } from '../http-server.js';
import {
  createTestIdentityRuntime,
  createTestRemoteConfig,
  RecordingConnectionFactory,
  TEST_CLIENT_TOKEN,
  TEST_PLATFORM_USER_A,
  TEST_PLATFORM_USER_B,
  TEST_USERNAME_A,
  TEST_USERNAME_B,
  waitFor,
} from '../test/helpers.js';

test('a five-second Audit Writer does not delay Tool response and health exposes bounded metrics', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-p7-slow-audit-'));
  const entries: AuditQueueEntry[] = [];
  const pipeline = new AsyncAuditPipeline({
    persist: async (batch) => {
      if (batch.some((entry) => entry.kind === 'SNAPSHOT')) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      entries.push(...batch);
    },
  }, new NoopRuntimeLogger(), { batchSize: 10, flushIntervalMs: 0, retryAttempts: 0 });
  const logger = asyncLogger(pipeline);
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig(),
    identityRuntime: createTestIdentityRuntime(root, new RecordingConnectionFactory(), logger),
  });
  const client = await connect(server, TEST_PLATFORM_USER_A, 'slow-writer-client', 'slow-writer-correlation');
  try {
    const started = performance.now();
    const result = await client.callTool({ name: 'get_username', arguments: {} });
    const elapsedMs = performance.now() - started;
    assert.equal(result.isError === true, false);
    assert.ok(elapsedMs < 2_000, `Tool waited ${elapsedMs}ms for a five-second Audit sink`);
    await waitFor(() => pipeline.getHealth().enqueuedSnapshots === 1, 2_000);
    const healthBody = await (await fetch(server.healthUrl)).json() as Record<string, unknown>;
    const auditHealth = healthBody.auditPersistence as Record<string, unknown>;
    assert.equal(auditHealth.queueCapacity, 1_000);
    assert.equal(auditHealth.enqueuedSnapshots, 1);
    assert.equal(typeof auditHealth.writerState, 'string');
    await waitFor(() => entries.some((entry) => entry.kind === 'SNAPSHOT'), 7_000);
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
    await pipeline.close(6_000);
    await rm(root, { recursive: true, force: true });
  }
  const snapshots = entries.filter((entry): entry is Extract<AuditQueueEntry, { kind: 'SNAPSHOT' }> => entry.kind === 'SNAPSHOT');
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.snapshot.auditEvents.length, 2);
});

test('HTTP OFF/ON 50/100/200 Gate preserves outcomes and zero cross-audit binding', { timeout: 180_000 }, async () => {
  const entries: AuditQueueEntry[] = [];
  const pipeline = new AsyncAuditPipeline({ persist: async (batch) => { entries.push(...batch); } }, new NoopRuntimeLogger(), {
    capacity: 1_000, batchSize: 50, flushIntervalMs: 100,
  });
  const offFixture = await startLoadFixture('OFF', new NoopRuntimeLogger());
  const onFixture = await startLoadFixture('ON', asyncLogger(pipeline));
  const heapBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const offRounds: LoadRound[] = [];
  const onRounds: LoadRound[] = [];
  const pairedSamples: PairedLoadSamples[] = [];
  try {
    await Promise.all([warmup(offFixture), warmup(onFixture)]);
    for (const concurrency of [50, 100, 200]) {
      const offSamples: LoadRound[] = [];
      const onSamples: LoadRound[] = [];
      for (let pair = 0; pair < 3; pair += 1) {
        if (pair % 2 === 0) {
          offSamples.push(await runRound(offFixture, concurrency));
          onSamples.push(await runRound(onFixture, concurrency));
        } else {
          onSamples.push(await runRound(onFixture, concurrency));
          offSamples.push(await runRound(offFixture, concurrency));
        }
      }
      pairedSamples.push(Object.freeze({
        concurrency,
        off: Object.freeze(offSamples),
        on: Object.freeze(onSamples),
      }));
      offRounds.push(averageRound(offSamples));
      onRounds.push(averageRound(onSamples));
    }
  } finally {
    await Promise.all([offFixture.close(), onFixture.close()]);
  }
  await waitFor(() => pipeline.getHealth().enqueuedSnapshots === 1_060, 10_000);
  await pipeline.close(10_000);
  const cpu = process.cpuUsage(cpuBefore);
  const off = loadResult('OFF', offRounds, offFixture);
  const on = loadResult('ON', onRounds, onFixture);

  const snapshots = entries
    .filter((entry): entry is Extract<AuditQueueEntry, { kind: 'SNAPSHOT' }> => entry.kind === 'SNAPSHOT')
    .map((entry) => entry.snapshot);
  assert.equal(snapshots.length, 1_060);
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.auditCall.publicAuditId)).size, 1_060);
  assert.equal(snapshots.filter((snapshot) => snapshot.auditCall.auditIntegrityStatus !== 'COMPLETE').length, 0);
  assert.equal(snapshots.filter((snapshot) => snapshot.auditEvents.length !== 2).length, 0);
  assert.equal(snapshots.filter((snapshot) => snapshot.auditEvents[0]?.sequence !== 1 || snapshot.auditEvents[1]?.sequence !== 2).length, 0);
  assert.equal(snapshots.filter((snapshot) => !validIdentityBinding(snapshot.auditCall.platformUserId, snapshot.auditCall.salesforceUsername)).length, 0);
  assert.equal(snapshots.filter((snapshot) => !validCorrelationBinding(snapshot.auditCall.platformUserId, snapshot.auditCall.correlationId)).length, 0);
  assert.equal(snapshots.filter((snapshot) =>
    snapshot.auditEvents.some((event) => event.eventName !== snapshot.auditCall.toolName)).length, 0);
  assert.equal(pipeline.getHealth().droppedSnapshots, 0);
  assert.equal(on.connectionCreations, off.connectionCreations);
  assert.equal(on.restApiRequests, off.restApiRequests);

  for (const concurrency of [50, 100, 200]) {
    const offRound = off.rounds.find((round) => round.concurrency === concurrency);
    const onRound = on.rounds.find((round) => round.concurrency === concurrency);
    assert.ok(offRound);
    assert.ok(onRound);
    assert.equal(offRound.failures, 0);
    assert.equal(onRound.failures, 0);
  }
  process.stderr.write(`P7_03_PERFORMANCE ${JSON.stringify({
    off,
    on,
    pairedSamples,
    comparison: comparePerformance(off, on),
    environmentCpuUserMicros: cpu.user,
    environmentCpuSystemMicros: cpu.system,
    environmentHeapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - heapBefore),
  })}\n`);
});

type LoadRound = Readonly<{
  concurrency: number;
  p50: number;
  p95: number;
  p99: number;
  throughput: number;
  failures: number;
}>;

type LoadResult = Readonly<{
  mode: 'OFF' | 'ON';
  rounds: readonly LoadRound[];
  connectionCreations: number;
  restApiRequests: number;
}>;

type PairedLoadSamples = Readonly<{
  concurrency: number;
  off: readonly LoadRound[];
  on: readonly LoadRound[];
}>;

type LoadFixture = Readonly<{
  mode: 'OFF' | 'ON';
  clients: readonly Client[];
  connectionFactory: RecordingConnectionFactory;
  close(): Promise<void>;
}>;

async function startLoadFixture(mode: 'OFF' | 'ON', logger: RuntimeLogger): Promise<LoadFixture> {
  const root = await mkdtemp(path.join(tmpdir(), `sfoa-p7-perf-${mode.toLowerCase()}-`));
  const connectionFactory = new RecordingConnectionFactory();
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig(),
    identityRuntime: createTestIdentityRuntime(root, connectionFactory, logger),
  });
  const clients = [
    await connect(server, TEST_PLATFORM_USER_A, `${mode}-a`, 'shared-correlation-a'),
    await connect(server, TEST_PLATFORM_USER_B, `${mode}-b`, 'shared-correlation-b'),
  ];
  return Object.freeze({
    mode,
    clients: Object.freeze(clients),
    connectionFactory,
    close: async () => {
      await Promise.allSettled(clients.map((client) => client.close()));
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  });
}

async function warmup(fixture: LoadFixture): Promise<void> {
  await Promise.all(Array.from({ length: 10 }, (_, index) =>
    fixture.clients[index % 2]?.callTool({ name: 'get_username', arguments: {} })));
}

async function runRound(fixture: LoadFixture, concurrency: number): Promise<LoadRound> {
  const wallStarted = performance.now();
  const results = await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
    const started = performance.now();
    const result = await fixture.clients[index % 2]?.callTool(index % 3 === 0
      ? { name: 'run_soql_query', arguments: { query: 'SELECT Id FROM Lead LIMIT 1', useToolingApi: false } }
      : { name: 'get_username', arguments: {} });
    return { elapsed: performance.now() - started, failed: result?.isError === true };
  }));
  const wallMs = performance.now() - wallStarted;
  const latencies = results.map((result) => result.elapsed).sort((a, b) => a - b);
  return Object.freeze({
    concurrency,
    p50: percentile(latencies, 0.50),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    throughput: Number((concurrency / (wallMs / 1_000)).toFixed(2)),
    failures: results.filter((result) => result.failed).length,
  });
}

function averageRound(samples: readonly LoadRound[]): LoadRound {
  const average = (field: 'p50' | 'p95' | 'p99' | 'throughput'): number =>
    Number((samples.reduce((total, sample) => total + sample[field], 0) / samples.length).toFixed(2));
  return Object.freeze({
    concurrency: samples[0]?.concurrency ?? 0,
    p50: average('p50'), p95: average('p95'), p99: average('p99'), throughput: average('throughput'),
    failures: samples.reduce((total, sample) => total + sample.failures, 0),
  });
}

function loadResult(mode: 'OFF' | 'ON', rounds: readonly LoadRound[], fixture: LoadFixture): LoadResult {
  return Object.freeze({
    mode,
    rounds: Object.freeze(rounds),
    connectionCreations: fixture.connectionFactory.creations.length,
    restApiRequests: fixture.connectionFactory.apiRequests.length,
  });
}

function comparePerformance(off: LoadResult, on: LoadResult): readonly Readonly<{
  concurrency: number;
  p50: Readonly<{ absoluteMs: number; relativePercent: number }>;
  p95: Readonly<{ absoluteMs: number; relativePercent: number }>;
  p99: Readonly<{ absoluteMs: number; relativePercent: number }>;
  throughput: Readonly<{ absolutePerSecond: number; relativePercent: number }>;
}>[] {
  const delta = (offValue: number, onValue: number): Readonly<{ absolute: number; relativePercent: number }> =>
    Object.freeze({
      absolute: Number((onValue - offValue).toFixed(2)),
      relativePercent: Number((((onValue - offValue) / offValue) * 100).toFixed(2)),
    });
  return Object.freeze(off.rounds.map((offRound) => {
    const onRound = on.rounds.find((candidate) => candidate.concurrency === offRound.concurrency);
    assert.ok(onRound);
    const p50 = delta(offRound.p50, onRound.p50);
    const p95 = delta(offRound.p95, onRound.p95);
    const p99 = delta(offRound.p99, onRound.p99);
    const throughput = delta(offRound.throughput, onRound.throughput);
    return Object.freeze({
      concurrency: offRound.concurrency,
      p50: Object.freeze({ absoluteMs: p50.absolute, relativePercent: p50.relativePercent }),
      p95: Object.freeze({ absoluteMs: p95.absolute, relativePercent: p95.relativePercent }),
      p99: Object.freeze({ absoluteMs: p99.absolute, relativePercent: p99.relativePercent }),
      throughput: Object.freeze({ absolutePerSecond: throughput.absolute, relativePercent: throughput.relativePercent }),
    });
  }));
}

function asyncLogger(pipeline: AsyncAuditPipeline): DatabaseRuntimeLogger {
  return new DatabaseRuntimeLogger(unusedAuditRepository(), new NoopRuntimeLogger(), undefined, pipeline);
}

function unusedAuditRepository(): AuditRepository {
  return {
    append: async () => { throw new Error('request path must not call AuditRepository.append'); },
    getById: async () => undefined,
    search: async (filter) => Object.freeze({
      items: Object.freeze([]), total: 0, limit: filter.limit, offset: filter.offset,
      count: 0, hasMore: false, nextOffset: null,
    }),
    countSince: async () => Object.freeze({ total: 0, pass: 0, blocked: 0, error: 0, unknown: 0 }),
  };
}

async function connect(
  server: RemoteMcpServer,
  platformUserId: string,
  name: string,
  correlationId: string,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
    requestInit: { headers: {
      authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
      'x-platform-user-id': platformUserId,
      'x-correlation-id': correlationId,
    } },
  });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return Number((sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0).toFixed(2));
}

function validIdentityBinding(platformUserId: string | null, salesforceUsername: string | null): boolean {
  return (platformUserId === TEST_PLATFORM_USER_A && salesforceUsername === TEST_USERNAME_A)
    || (platformUserId === TEST_PLATFORM_USER_B && salesforceUsername === TEST_USERNAME_B);
}

function validCorrelationBinding(platformUserId: string | null, correlationId: string): boolean {
  return (platformUserId === TEST_PLATFORM_USER_A && correlationId === 'shared-correlation-a')
    || (platformUserId === TEST_PLATFORM_USER_B && correlationId === 'shared-correlation-b');
}
