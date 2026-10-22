/**
 * In-memory, bounded event buffer for one CRM run.
 *
 * It exists so a browser that refreshes or briefly disconnects can replay the
 * events of the run it already started instead of submitting the same message
 * again. It is not durable: after an access-service restart the buffer is gone
 * and the run is marked UNKNOWN rather than silently resubmitted.
 */

export type RunStreamEvent = Readonly<{
  seq: number;
  type: string;
  data: unknown;
}>;

type Subscriber = (event: RunStreamEvent) => void;

export class RunStream {
  private readonly events: RunStreamEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private bytes = 0;
  private nextSeq = 1;
  private closed = false;
  private dropped = 0;

  public constructor(
    private readonly options: Readonly<{ maxEvents?: number; maxBytes?: number }> = {},
  ) {}

  public publish(type: string, data: unknown): RunStreamEvent {
    const event = Object.freeze({ seq: this.nextSeq, type, data });
    this.nextSeq += 1;
    if (!this.closed) {
      this.events.push(event);
      this.bytes += estimateBytes(event);
      this.trim();
      for (const subscriber of this.subscribers) {
        try {
          subscriber(event);
        } catch {
          // A subscriber's connection failure must not break the run.
        }
      }
    }
    return event;
  }

  public subscribe(afterSeq: number, subscriber: Subscriber): Readonly<{ replay: readonly RunStreamEvent[]; unsubscribe: () => void }> {
    const replay = this.events.filter((event) => event.seq > afterSeq);
    if (!this.closed) this.subscribers.add(subscriber);
    return Object.freeze({
      replay: Object.freeze(replay),
      unsubscribe: () => { this.subscribers.delete(subscriber); },
    });
  }

  public close(): void {
    this.closed = true;
    this.subscribers.clear();
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public get truncated(): boolean {
    return this.dropped > 0;
  }

  public get droppedEvents(): number {
    return this.dropped;
  }

  public get lastEvent(): RunStreamEvent | undefined {
    return this.events.at(-1);
  }

  private trim(): void {
    const maxEvents = this.options.maxEvents ?? 2_000;
    const maxBytes = this.options.maxBytes ?? 524_288;
    while (this.events.length > maxEvents || this.bytes > maxBytes) {
      const removed = this.events.shift();
      if (!removed) break;
      this.bytes -= estimateBytes(removed);
      this.dropped += 1;
    }
  }
}

function estimateBytes(event: RunStreamEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event), 'utf8');
  } catch {
    return 1_024;
  }
}
