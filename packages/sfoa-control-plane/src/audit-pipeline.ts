import type { AuditSnapshot, RuntimeLogger } from '@sfoa/identity-runtime';
import type { AuditWrite } from './repositories.js';

export const DEFAULT_AUDIT_QUEUE_CAPACITY = 1_000;
export const DEFAULT_AUDIT_BATCH_SIZE = 50;
export const DEFAULT_AUDIT_FLUSH_INTERVAL_MS = 100;
export const DEFAULT_AUDIT_RETRY_ATTEMPTS = 2;
export const DEFAULT_AUDIT_RETRY_BASE_DELAY_MS = 100;
export const DEFAULT_AUDIT_FLUSH_TIMEOUT_MS = 5_000;
export const DEFAULT_AUDIT_DB_CONNECTION_LIMIT = 2;

export type AuditWriterState = 'IDLE' | 'WRITING' | 'BACKOFF' | 'STOPPING' | 'STOPPED';

export type AuditPipelineHealth = Readonly<{
  status: 'UP' | 'DEGRADED';
  queueDepth: number;
  queueCapacity: number;
  enqueuedSnapshots: number;
  persistedSnapshots: number;
  droppedSnapshots: number;
  writerFailureCount: number;
  queueFullCount: number;
  lastFailureAt: string | null;
  lastDropAt: string | null;
  lastSuccessAt: string | null;
  writerState: AuditWriterState;
}>;

export type AuditQueueEntry =
  | Readonly<{ kind: 'SNAPSHOT'; snapshot: AuditSnapshot }>
  | Readonly<{ kind: 'LEGACY_RUNTIME'; write: AuditWrite }>;

export interface AuditBatchSink {
  persist(entries: readonly AuditQueueEntry[]): Promise<void>;
}

export class AuditBatchPersistenceError extends Error {
  public constructor(message: string, public readonly retryable: boolean, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'AuditBatchPersistenceError';
  }
}

export type AsyncAuditPipelineOptions = Readonly<{
  capacity?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  retryAttempts?: number;
  retryBaseDelayMs?: number;
}>;

export class AsyncAuditPipeline {
  private readonly queue: BoundedAuditQueue<AuditQueueEntry>;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly retryAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly worker: Promise<void>;
  private writerState: AuditWriterState = 'IDLE';
  private enqueuedSnapshots = 0;
  private persistedSnapshots = 0;
  private droppedSnapshots = 0;
  private writerFailureCount = 0;
  private queueFullCount = 0;
  private lastFailureAt: string | null = null;
  private lastDropAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private forcedStop = false;
  private inFlightBatch: readonly AuditQueueEntry[] = Object.freeze([]);
  private abandonedInFlight = false;
  private closePromise: Promise<Readonly<{ flushed: boolean; dropped: number }>> | undefined;

  public constructor(
    private readonly sink: AuditBatchSink,
    private readonly fallback: RuntimeLogger,
    options: AsyncAuditPipelineOptions = {},
  ) {
    this.queue = new BoundedAuditQueue(positiveInteger(options.capacity, DEFAULT_AUDIT_QUEUE_CAPACITY));
    this.batchSize = positiveInteger(options.batchSize, DEFAULT_AUDIT_BATCH_SIZE);
    this.flushIntervalMs = nonNegativeInteger(options.flushIntervalMs, DEFAULT_AUDIT_FLUSH_INTERVAL_MS);
    this.retryAttempts = nonNegativeInteger(options.retryAttempts, DEFAULT_AUDIT_RETRY_ATTEMPTS);
    this.retryBaseDelayMs = nonNegativeInteger(options.retryBaseDelayMs, DEFAULT_AUDIT_RETRY_BASE_DELAY_MS);
    this.worker = this.runWriter();
  }

  public offerSnapshot(snapshot: AuditSnapshot): boolean {
    const offered = this.queue.offer(Object.freeze({ kind: 'SNAPSHOT', snapshot }));
    if (offered) {
      this.enqueuedSnapshots += 1;
    } else {
      this.recordDrop(1, this.queue.accepting ? 'MCP_AUDIT_QUEUE_FULL' : 'MCP_AUDIT_PIPELINE_CLOSED');
      if (this.queue.accepting) this.queueFullCount += 1;
    }
    return offered;
  }

  public offerLegacy(write: AuditWrite): boolean {
    const offered = this.queue.offer(Object.freeze({ kind: 'LEGACY_RUNTIME', write: Object.freeze({ ...write }) }));
    if (!offered) {
      if (this.queue.accepting) this.queueFullCount += 1;
      this.recordFailure(this.queue.accepting ? 'MCP_AUDIT_QUEUE_FULL' : 'MCP_AUDIT_PIPELINE_CLOSED');
    }
    return offered;
  }

  public recordCollectorFailure(): void {
    this.recordFailure('MCP_AUDIT_COLLECTOR_FAILED');
  }

  public getHealth(): AuditPipelineHealth {
    return Object.freeze({
      status: this.writerFailureCount > 0 || this.droppedSnapshots > 0 ? 'DEGRADED' : 'UP',
      queueDepth: this.queue.depth,
      queueCapacity: this.queue.capacity,
      enqueuedSnapshots: this.enqueuedSnapshots,
      persistedSnapshots: this.persistedSnapshots,
      droppedSnapshots: this.droppedSnapshots,
      writerFailureCount: this.writerFailureCount,
      queueFullCount: this.queueFullCount,
      lastFailureAt: this.lastFailureAt,
      lastDropAt: this.lastDropAt,
      lastSuccessAt: this.lastSuccessAt,
      writerState: this.writerState,
    });
  }

  public close(timeoutMs = DEFAULT_AUDIT_FLUSH_TIMEOUT_MS): Promise<Readonly<{ flushed: boolean; dropped: number }>> {
    this.closePromise ??= this.closeOnce(nonNegativeInteger(timeoutMs, DEFAULT_AUDIT_FLUSH_TIMEOUT_MS));
    return this.closePromise;
  }

  private async closeOnce(timeoutMs: number): Promise<Readonly<{ flushed: boolean; dropped: number }>> {
    this.writerState = 'STOPPING';
    this.queue.stopAccepting();
    const completed = await completesWithin(this.worker, timeoutMs);
    if (completed) return Object.freeze({ flushed: true, dropped: 0 });
    this.forcedStop = true;
    const droppedEntries = this.queue.dropAll();
    const droppedSnapshots = countSnapshots(droppedEntries) + countSnapshots(this.inFlightBatch);
    const droppedTotal = droppedEntries.length + this.inFlightBatch.length;
    this.abandonedInFlight = this.inFlightBatch.length > 0;
    this.recordDrop(droppedSnapshots, 'MCP_AUDIT_FLUSH_TIMEOUT');
    this.queue.wake();
    return Object.freeze({ flushed: false, dropped: droppedTotal });
  }

  private async runWriter(): Promise<void> {
    while (!this.forcedStop && (this.queue.accepting || this.queue.depth > 0)) {
      if (this.queue.depth === 0) {
        this.writerState = this.queue.accepting ? 'IDLE' : 'STOPPING';
        await this.queue.waitForWork(this.flushIntervalMs);
        continue;
      }
      if (this.queue.depth < this.batchSize && this.queue.accepting && this.flushIntervalMs > 0) {
        await delay(this.flushIntervalMs);
      }
      const batch = this.queue.drain(this.batchSize);
      if (batch.length === 0) continue;
      this.inFlightBatch = batch;
      this.abandonedInFlight = false;
      await this.persistWithPolicy(batch);
      this.inFlightBatch = Object.freeze([]);
    }
    this.writerState = 'STOPPED';
  }

  private async persistWithPolicy(batch: readonly AuditQueueEntry[]): Promise<void> {
    for (let attempt = 0; attempt <= this.retryAttempts; attempt += 1) {
      try {
        this.writerState = 'WRITING';
        await this.sink.persist(batch);
        if (!this.abandonedInFlight) this.persistedSnapshots += countSnapshots(batch);
        this.lastSuccessAt = new Date().toISOString();
        return;
      } catch (error) {
        const retryable = !(error instanceof AuditBatchPersistenceError) || error.retryable;
        this.recordFailure('MCP_AUDIT_WRITER_FAILED');
        if (this.forcedStop) return;
        if (!retryable) {
          await this.isolatePoisonEntries(batch);
          return;
        }
        if (attempt >= this.retryAttempts) {
          this.recordDrop(countSnapshots(batch), 'MCP_AUDIT_WRITER_RETRIES_EXHAUSTED');
          return;
        }
        this.writerState = 'BACKOFF';
        await delay(this.retryBaseDelayMs * (2 ** attempt));
      }
    }
  }

  private async isolatePoisonEntries(batch: readonly AuditQueueEntry[]): Promise<void> {
    if (batch.length === 1) {
      this.recordDrop(countSnapshots(batch), 'MCP_AUDIT_SNAPSHOT_REJECTED');
      return;
    }
    for (const entry of batch) {
      try {
        this.writerState = 'WRITING';
        await this.sink.persist([entry]);
        this.persistedSnapshots += countSnapshots([entry]);
        this.lastSuccessAt = new Date().toISOString();
      } catch {
        this.recordFailure('MCP_AUDIT_SNAPSHOT_REJECTED');
        this.recordDrop(countSnapshots([entry]), 'MCP_AUDIT_SNAPSHOT_REJECTED');
      }
    }
  }

  private recordDrop(snapshotCount: number, errorCode: string): void {
    this.droppedSnapshots += snapshotCount;
    if (snapshotCount > 0) this.lastDropAt = new Date().toISOString();
    this.recordFailure(errorCode);
  }

  private recordFailure(errorCode: string): void {
    this.writerFailureCount += 1;
    this.lastFailureAt = new Date().toISOString();
    try {
      void Promise.resolve(this.fallback.log({
        correlationId: 'audit-pipeline',
        result: 'ERROR',
        errorCode,
        requestSummary: {
          queueDepth: this.queue.depth,
          queueCapacity: this.queue.capacity,
        },
      })).catch(() => undefined);
    } catch {
      // Operational fallback is best effort and must never escape into a Tool request.
    }
  }
}

class BoundedAuditQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters = new Set<() => void>();
  public accepting = true;

  public constructor(public readonly capacity: number) {}

  public get depth(): number {
    return this.items.length;
  }

  public offer(item: T): boolean {
    if (!this.accepting || this.items.length >= this.capacity) return false;
    this.items.push(item);
    this.wake();
    return true;
  }

  public drain(maximum: number): readonly T[] {
    return this.items.splice(0, maximum);
  }

  public dropAll(): readonly T[] {
    return this.items.splice(0, this.items.length);
  }

  public stopAccepting(): void {
    this.accepting = false;
    this.wake();
  }

  public wake(): void {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }

  public async waitForWork(timeoutMs: number): Promise<void> {
    if (this.items.length > 0 || !this.accepting) return;
    await new Promise<void>((resolve) => {
      const complete = (): void => {
        clearTimeout(timer);
        this.waiters.delete(complete);
        resolve();
      };
      const timer = setTimeout(complete, timeoutMs);
      this.waiters.add(complete);
    });
  }
}

function countSnapshots(entries: readonly AuditQueueEntry[]): number {
  return entries.reduce((count, entry) => count + (entry.kind === 'SNAPSHOT' ? 1 : 0), 0);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function completesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void operation.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
