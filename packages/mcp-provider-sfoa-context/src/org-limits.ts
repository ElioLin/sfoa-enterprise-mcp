import {
  ORG_LIMIT_HIGHLIGHT_ALIASES,
  ORG_LIMIT_HIGHLIGHT_SLOTS,
  type OrgLimitEntry,
  type OrgLimitHighlight,
  type OrgLimitHighlightSlot,
  type OrgLimitHighlights,
} from './schemas.js';

/**
 * Pure derivation for `get_org_limits`: turned into its own module because nothing here needs a
 * Connection, a request role or a byte budget. The executor that owns the Connection lives in the
 * MCP server, and these four functions are what it calls once the org has answered.
 *
 * Nothing here is inferred from configuration — every value comes from the payload the org returned,
 * and a resource the org does not meter becomes an absent slot rather than a zero.
 */
export function readOrgLimitEntries(value: unknown): ReadonlyMap<string, OrgLimitEntry> {
  const entries = new Map<string, OrgLimitEntry>();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return entries;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key.length === 0) continue;
    const max = readLimitNumber(readField(raw, 'Max'));
    const remaining = readLimitNumber(readField(raw, 'Remaining'));
    entries.set(key, Object.freeze({
      max,
      remaining,
      // Only derivable when both ends are known and consistent. A `remaining` above `max` means one
      // of the two is not what this Tool assumes, so no `used` is invented from it — and never a
      // negative one, which is how a subtraction with the operands the wrong way round would read.
      used: max !== null && remaining !== null && max >= remaining ? max - remaining : null,
      measured: max !== null || remaining !== null,
    }));
  }
  return entries;
}

/**
 * A governor limit as a number, or null when the org reported nothing this Tool can trust.
 *
 * Only a finite, non-negative number counts. A numeric string is deliberately not coerced: the
 * limits resource reports numbers, so a string means the payload is not the shape this Tool was
 * written against, and guessing at it would put an invented quota in front of an Agent that is
 * about to launch a bulk job.
 */
export function readLimitNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The order `limits` is built in: the highlight slots first, in the order the Tool documents them,
 * then everything else alphabetically. Deterministic, so a payload that has to be trimmed is
 * trimmed at the same place every time, and the slots are never the part that gets cut.
 *
 * One key can fill only one slot, which is why a slot whose key is already claimed is skipped: the
 * table is a lookup, not a set of independent lists.
 */
export function orderLimitKeys(entries: ReadonlyMap<string, OrgLimitEntry>): readonly string[] {
  const ordered: string[] = [];
  for (const slot of ORG_LIMIT_HIGHLIGHT_SLOTS) {
    const key = findHighlightKey(entries, slot);
    if (key !== null && !ordered.includes(key)) ordered.push(key);
  }
  const rest = [...entries.keys()].filter((key) => !ordered.includes(key)).sort(compareKeys);
  return Object.freeze([...ordered, ...rest]);
}

/**
 * The five highlight slots, always all five.
 *
 * A slot the org does not report is `present: false` with a null key and null numbers — never
 * omitted and never zeroed. "This org does not meter that resource" is an answer an Agent has to be
 * able to act on; a missing slot and a zero allowance look the same to a reader of the other one.
 */
export function readOrgLimitHighlights(entries: ReadonlyMap<string, OrgLimitEntry>): OrgLimitHighlights {
  const slot = (name: OrgLimitHighlightSlot): OrgLimitHighlight => {
    const key = findHighlightKey(entries, name);
    const entry = key === null ? undefined : entries.get(key);
    return Object.freeze({
      key,
      present: entry !== undefined,
      max: entry?.max ?? null,
      remaining: entry?.remaining ?? null,
      used: entry?.used ?? null,
    });
  };
  return Object.freeze({
    dailyApiRequests: slot('dailyApiRequests'),
    dailyBulkApiRequests: slot('dailyBulkApiRequests'),
    dailyAsyncApexExecutions: slot('dailyAsyncApexExecutions'),
    dataStorageMB: slot('dataStorageMB'),
    fileStorageMB: slot('fileStorageMB'),
  });
}

/** How many entries the org reported a usable number for; 0 means the payload is unusable. */
export function countMeasuredLimits(entries: ReadonlyMap<string, OrgLimitEntry>): number {
  let count = 0;
  for (const entry of entries.values()) {
    if (entry.measured) count += 1;
  }
  return count;
}

function readField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function findHighlightKey(
  entries: ReadonlyMap<string, OrgLimitEntry>,
  slot: OrgLimitHighlightSlot,
): string | null {
  return ORG_LIMIT_HIGHLIGHT_ALIASES[slot].find((key) => entries.has(key)) ?? null;
}

function compareKeys(left: string, right: string): number {
  return left.localeCompare(right, 'en-US');
}
