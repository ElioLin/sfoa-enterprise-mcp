import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestAuditContextController } from '@sfoa/identity-runtime';

test('P7-06 OFF/ON small/large payload benchmark runs three paired 50/100/200 rounds', { timeout: 120_000 }, async () => {
  const smallPayload = JSON.stringify({ marker: 'SMALL_PAYLOAD', data: 'S'.repeat(1_024) });
  const largePayload = JSON.stringify({ marker: 'LARGE_PAYLOAD', data: 'L'.repeat(2 * 1024 * 1024) });
  const results: Record<'small' | 'large', PairedResult[]> = { small: [], large: [] };
  for (const [size, payload] of [['small', smallPayload], ['large', largePayload]] as const) {
    for (const concurrency of [50, 100, 200]) {
      const rounds: Pair[] = [];
      for (let round = 0; round < 3; round += 1) {
        const pair = round % 2 === 0
          ? { off: await runRound(false, concurrency, payload), on: await runRound(true, concurrency, payload) }
          : { on: await runRound(true, concurrency, payload), off: await runRound(false, concurrency, payload) };
        rounds.push(Object.freeze(pair));
      }
      results[size].push(Object.freeze({ concurrency, rounds: Object.freeze(rounds) }));
    }
  }
  assert.equal(results.small.length, 3);
  assert.equal(results.large.length, 3);
  assert.equal(results.large.every((result) => result.rounds.every((round) => round.on.failures === 0)), true);
  process.stderr.write(`P7_06_PAYLOAD_PERFORMANCE ${JSON.stringify(results)}\n`);
});

type Metrics = Readonly<{
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  throughputPerSecond: number;
  heapDeltaBytes: number;
  failures: number;
}>;
type Pair = Readonly<{ off: Metrics; on: Metrics }>;
type PairedResult = Readonly<{ concurrency: number; rounds: readonly Pair[] }>;

async function runRound(enabled: boolean, concurrency: number, payload: string): Promise<Metrics> {
  const heapBefore = process.memoryUsage().heapUsed;
  const wallStarted = performance.now();
  const samples = await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
    await Promise.resolve();
    const started = performance.now();
    const context = RequestAuditContextController.create({
      correlationId: `payload-bench-${index}`, channel: 'MCP_HTTP', toolName: 'benchmark_tool',
    });
    if (enabled) {
      context.collector().recordPayloadEvidence({
        payloadType: 'MCP_RESPONSE', contentType: 'application/json', payload,
      });
    }
    context.collector().record({
      eventCategory: 'TOOL', eventType: 'TOOL_TERMINAL', eventName: 'benchmark_tool', status: 'SUCCESS',
      terminal: { source: 'TOOL', result: 'PASS', outcome: 'SUCCESS' },
    });
    const snapshot = context.finalizeAudit();
    const failed = snapshot?.auditCall.outcome !== 'SUCCESS'
      || (enabled && snapshot.payloadEvidence.length !== 1)
      || (enabled && (snapshot.payloadEvidence[0]?.storedSizeBytes ?? Number.MAX_SAFE_INTEGER) > 262_144);
    return Object.freeze({ elapsedMs: performance.now() - started, failed });
  }));
  const wallMs = performance.now() - wallStarted;
  const latencies = samples.map((sample) => sample.elapsedMs).sort((left, right) => left - right);
  return Object.freeze({
    p50Ms: percentile(latencies, 0.50),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    throughputPerSecond: Number((concurrency / Math.max(wallMs / 1_000, 0.001)).toFixed(2)),
    heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
    failures: samples.filter((sample) => sample.failed).length,
  });
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Number((sorted[index] ?? 0).toFixed(3));
}
