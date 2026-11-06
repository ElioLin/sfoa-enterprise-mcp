/** Structural Salesforce configuration only. A cache hit is never a freshness proof. */
export type PrecisionComponentType = 'Profile' | 'CustomApplication' | 'FlexiPage';
export type PrecisionComponentRevision = Readonly<{ id: string; lastModifiedDate: string }>;
export type PrecisionComponentKey = Readonly<{
  organizationId: string; apiVersion: string; parserVersion: string;
  type: PrecisionComponentType; fullName: string;
}>;

type Entry = Readonly<{ revision: PrecisionComponentRevision; json: string; bytes: number }>;

/**
 * Host-owned bounded LRU. Callers must obtain a current Salesforce revision on
 * every task START/SUBMIT and compare before/after a cold component read. No
 * Connection, identity credentials, evaluated state or business values belong
 * here. The only stored values are the loader's allowlisted config projections.
 */
export class PrecisionComponentCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  public constructor(private readonly maxEntries = 32, private readonly maxBytes = 4_194_304) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 128 || !Number.isInteger(maxBytes)
      || maxBytes < 1 || maxBytes > 16_777_216) throw new Error('FORM_COMPONENT_CACHE_BOUND_INVALID');
  }

  public get(key: PrecisionComponentKey, revision: PrecisionComponentRevision): Record<string, unknown> | undefined {
    const id = keyOf(key);
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (!sameComponentRevision(entry.revision, revision)) { this.remove(id); return undefined; }
    this.entries.delete(id); this.entries.set(id, entry);
    return JSON.parse(entry.json) as Record<string, unknown>;
  }

  public set(key: PrecisionComponentKey, revision: PrecisionComponentRevision, value: Readonly<Record<string, unknown>>): void {
    if (!precisionComponentRevision(revision)) return;
    const id = keyOf(key);
    const json = JSON.stringify(value);
    const bytes = Buffer.byteLength(json, 'utf8');
    this.remove(id);
    if (bytes > Math.min(this.maxBytes, 1_048_576)) return;
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.remove(oldest);
    }
    this.entries.set(id, { revision: { ...revision }, json, bytes }); this.bytes += bytes;
  }

  public clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key); }
  }
}

export function precisionComponentRevision(raw: Readonly<Record<string, unknown>>): PrecisionComponentRevision | undefined {
  const id = raw.id;
  const timestamp = raw.lastModifiedDate;
  if (typeof id !== 'string' || !/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u.test(id)
    || typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T/u.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp)) || Date.parse(timestamp) <= 0) return undefined;
  return { id: id.slice(0, 15), lastModifiedDate: new Date(timestamp).toISOString() };
}

export function sameComponentRevision(left: PrecisionComponentRevision, right: PrecisionComponentRevision): boolean {
  return left.id.slice(0, 15) === right.id.slice(0, 15) && left.lastModifiedDate === right.lastModifiedDate;
}

function keyOf(key: PrecisionComponentKey): string {
  return JSON.stringify([key.organizationId.slice(0, 15), key.apiVersion, key.parserVersion, key.type, key.fullName]);
}
