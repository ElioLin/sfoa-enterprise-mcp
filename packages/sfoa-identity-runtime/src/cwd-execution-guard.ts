import { IdentityRuntimeError } from './errors.js';

type Release = () => void;
type Waiter = Readonly<{ mode: 'shared' | 'exclusive'; resolve: (release: Release) => void }>;

class AsyncReadWriteLock {
  private activeReaders = 0;
  private writerActive = false;
  private readonly queue: Waiter[] = [];

  public acquireShared(): Promise<Release> {
    const writerQueued = this.queue.some((waiter) => waiter.mode === 'exclusive');
    if (!this.writerActive && !writerQueued) {
      this.activeReaders += 1;
      return Promise.resolve(this.createReaderRelease());
    }
    return new Promise((resolve) => this.queue.push({ mode: 'shared', resolve }));
  }

  public acquireExclusive(): Promise<Release> {
    if (!this.writerActive && this.activeReaders === 0 && this.queue.length === 0) {
      this.writerActive = true;
      return Promise.resolve(this.createWriterRelease());
    }
    return new Promise((resolve) => this.queue.push({ mode: 'exclusive', resolve }));
  }

  private createReaderRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeReaders -= 1;
      this.drain();
    };
  }

  private createWriterRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.writerActive = false;
      this.drain();
    };
  }

  private drain(): void {
    if (this.writerActive || this.activeReaders > 0) return;
    const first = this.queue[0];
    if (!first) return;

    if (first.mode === 'exclusive') {
      this.queue.shift();
      this.writerActive = true;
      first.resolve(this.createWriterRelease());
      return;
    }

    while (this.queue[0]?.mode === 'shared') {
      const waiter = this.queue.shift();
      if (!waiter) break;
      this.activeReaders += 1;
      waiter.resolve(this.createReaderRelease());
    }
  }
}

export type CwdExecutionMetrics = Readonly<{
  sharedExecutions: number;
  exclusiveExecutions: number;
  maxConcurrentShared: number;
  maxConcurrentExclusive: number;
}>;

export class CwdExecutionGuard {
  private readonly lock = new AsyncReadWriteLock();
  private activeShared = 0;
  private activeExclusive = 0;
  private sharedExecutions = 0;
  private exclusiveExecutions = 0;
  private maxConcurrentShared = 0;
  private maxConcurrentExclusive = 0;

  public constructor(private readonly baselineCwd: string = process.cwd()) {}

  public async runShared<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.lock.acquireShared();
    this.activeShared += 1;
    this.sharedExecutions += 1;
    this.maxConcurrentShared = Math.max(this.maxConcurrentShared, this.activeShared);
    try {
      return await operation();
    } finally {
      this.restore(this.baselineCwd);
      this.activeShared -= 1;
      release();
    }
  }

  public async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.lock.acquireExclusive();
    const previousCwd = process.cwd();
    this.activeExclusive += 1;
    this.exclusiveExecutions += 1;
    this.maxConcurrentExclusive = Math.max(this.maxConcurrentExclusive, this.activeExclusive);
    try {
      return await operation();
    } finally {
      this.restore(previousCwd);
      this.activeExclusive -= 1;
      release();
    }
  }

  public getMetrics(): CwdExecutionMetrics {
    return Object.freeze({
      sharedExecutions: this.sharedExecutions,
      exclusiveExecutions: this.exclusiveExecutions,
      maxConcurrentShared: this.maxConcurrentShared,
      maxConcurrentExclusive: this.maxConcurrentExclusive,
    });
  }

  private restore(target: string): void {
    try {
      if (process.cwd() !== target) process.chdir(target);
    } catch (error) {
      throw new IdentityRuntimeError(
        'MCP_REQUEST_SCOPE_FAILED',
        'The runtime could not restore its working directory after official Tool execution.',
        { cause: error },
      );
    }
  }
}
