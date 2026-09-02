/**
 * In-process, bounded, TTL (by upstream `expiresAt`) cache for Buntu token
 * identity validation results.
 *
 * Security contract:
 * - Keyed only by the SHA-256 `buntuTokenFingerprint(rawToken)`; the raw token
 *   is never stored.
 * - An entry holds a single already-validated platform `userId` and the epoch
 *   milliseconds at which the upstream token expires (`expiresAtMs`, derived
 *   from `data.expiresAt` seconds). Nothing else.
 * - `get()` never returns an expired entry: it evicts on read.
 * - Only the authenticator decides what to store; this class never fabricates
 *   a validation outcome and has no notion of success/failure.
 *
 * This cache is process-local and per-runtime-instance. It deliberately avoids
 * any external shared cache dependency: a single MCP server process needs zero
 * extra infrastructure, and on restart the cache is empty (the next request
 * simply revalidates). If the server is later scaled horizontally, swap this
 * implementation for a shared store without changing the interface.
 */

export interface BuntuValidationCacheEntry {
  /** Already `platformUserIdSchema`-validated platform user id. */
  userId: string;
  /** Epoch milliseconds at which the cached identity expires (token `expiresAt`). */
  expiresAtMs: number;
  /** Epoch milliseconds at which the entry was written. */
  cachedAtMs: number;
}

export interface BuntuTokenValidationCache {
  /**
   * Returns the non-expired entry for `fingerprint`, or undefined when absent
   * or expired. Expired entries are evicted as a side effect.
   */
  get(fingerprint: string, nowMs: number): BuntuValidationCacheEntry | undefined;
  /** Inserts or refreshes `entry` for `fingerprint`, enforcing the LRU bound. */
  set(fingerprint: string, entry: BuntuValidationCacheEntry): void;
  clear(): void;
}

export const DEFAULT_BUNTU_VALIDATION_CACHE_MAX_ENTRIES = 1000;

export type InMemoryBuntuValidationCacheOptions = Readonly<{
  maxEntries?: number;
}>;

/** Insertion-ordered Map implementing an LRU with a hard entry bound. */
export class InMemoryBuntuValidationCache implements BuntuTokenValidationCache {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, BuntuValidationCacheEntry>();

  public constructor(options: InMemoryBuntuValidationCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_BUNTU_VALIDATION_CACHE_MAX_ENTRIES;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error('InMemoryBuntuValidationCache maxEntries must be a positive safe integer.');
    }
  }

  public get(fingerprint: string, nowMs: number): BuntuValidationCacheEntry | undefined {
    const entry = this.entries.get(fingerprint);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs <= nowMs) {
      // Expired: evict and treat as a miss so a fresh validation is performed.
      this.entries.delete(fingerprint);
      return undefined;
    }
    // Refresh LRU recency.
    this.entries.delete(fingerprint);
    this.entries.set(fingerprint, entry);
    return entry;
  }

  public set(fingerprint: string, entry: BuntuValidationCacheEntry): void {
    this.entries.delete(fingerprint);
    this.entries.set(fingerprint, entry);
    while (this.entries.size > this.maxEntries) {
      // Map preserves insertion order; the first key is the least recently used.
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  public clear(): void {
    this.entries.clear();
  }
}
