import type { OrgService } from '@salesforce/mcp-provider-api';
import { DataRuntimeError } from './errors.js';
import { readField } from './list-sobjects-executor.js';
import { resolveRequestConnection } from './org-connection.js';
import { DATA_MAX_RESPONSE_BYTES, trimToByteBudget } from './response-budget.js';
import { mapDataFailure, type DataFailureMapping } from './salesforce-errors.js';
import {
  ORG_LIMIT_HIGHLIGHT_ALIASES,
  ORG_LIMIT_HIGHLIGHT_SLOTS,
  type OrgLimitEntry,
  type OrgLimitHighlight,
  type OrgLimitHighlightSlot,
  type OrgLimitHighlights,
  type OrgLimitsInput,
  type OrgLimitsOutput,
} from './schemas.js';

/**
 * Reads the org's governor limits through the official jsforce `limits()` surface.
 *
 * This is the pre-flight a large data job needs: the gap it closes is an Agent launching a bulk
 * export with no way to see the daily API and bulk allowances it is about to spend. Nothing here is
 * inferred — the Tool reports the org's own keys and numbers, and a resource the org does not meter
 * is reported as an absent slot rather than as a zero.
 *
 * **This org refuses the resource.** `limits()` answered `API_DISABLED_FOR_ORG` for every identity
 * and API version tried (see `docs/sfoa/P9_T3_LIVE_PROBE_FINDINGS.md` §1), so against this org the
 * Tool returns a structured `MCP_LIMITS_ACCESS_DENIED` — the intended behaviour, and the reason the
 * failure message names both possible causes instead of guessing at one.
 */
export class OrgLimitsExecutor {
  public constructor(private readonly orgService: OrgService) {}

  public async execute(input: OrgLimitsInput): Promise<OrgLimitsOutput> {
    const verbose = input.verbose === true;
    try {
      const connection = await resolveRequestConnection(this.orgService);
      const payload: unknown = await connection.limits();
      const entries = readOrgLimitEntries(payload);
      const readable = countMeasured(entries);
      // An org that answered with nothing readable is not an org without limits, and returning
      // `limits: {}` would invite exactly that conclusion from an Agent about to size a bulk job.
      if (readable === 0) {
        throw new DataRuntimeError(
          'MCP_LIMITS_READ_FAILED',
          'Salesforce returned no readable governor-limit entry, so this org\'s quota state is unknown.',
          {
            suggestion: 'Treat this as unknown, never as unlimited: retry once, and if it repeats the org or API version in '
              + 'use does not expose the limits resource, so the allowances have to be read from Salesforce Setup.',
          },
        );
      }
      const ordered = orderLimitKeys(entries);
      const highlights = readOrgLimitHighlights(entries);
      // `build` renders the complete answer for a candidate prefix, so the budget measures what the
      // Agent receives, hint included. The highlight slots sit at the front of `ordered`, which is
      // what lets the hint promise they survive a cut.
      const build = (kept: readonly string[]): OrgLimitsOutput => {
        const limits: Record<string, OrgLimitEntry> = {};
        for (const key of kept) {
          const entry = entries.get(key);
          if (entry !== undefined) limits[key] = entry;
        }
        const truncated = kept.length < ordered.length;
        return {
          success: true,
          executionRole: 'USER',
          api: 'REST',
          verbose,
          limits,
          highlights,
          totalLimits: entries.size,
          returnedLimits: kept.length,
          unreadableLimits: entries.size - readable,
          truncated,
          ...(truncated
            ? {
                hint: `Incomplete read: this org reports ${entries.size} limits and ${kept.length} are included here. `
                  + `The ${ORG_LIMIT_HIGHLIGHT_SLOTS.length} highlight slots are always kept; the rest were dropped to fit `
                  + `the ${DATA_MAX_RESPONSE_BYTES}-byte response budget, and no parameter raises it.`,
              }
            : {}),
        };
      };
      return build(trimToByteBudget(ordered, DATA_MAX_RESPONSE_BYTES, build).kept);
    } catch (error) {
      throw mapDataFailure(error, orgLimitsFailureMapping());
    }
  }
}

/**
 * Reads the whole limits payload, validating rather than trusting it.
 *
 * A payload that is not a plain object yields no entries, which the caller turns into a failure
 * rather than an empty success. Keys are kept exactly as the org wrote them: renaming them would
 * break the one thing this Tool is for, which is reporting what the org actually said.
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

function findHighlightKey(
  entries: ReadonlyMap<string, OrgLimitEntry>,
  slot: OrgLimitHighlightSlot,
): string | null {
  return ORG_LIMIT_HIGHLIGHT_ALIASES[slot].find((key) => entries.has(key)) ?? null;
}

function countMeasured(entries: ReadonlyMap<string, OrgLimitEntry>): number {
  let count = 0;
  for (const entry of entries.values()) {
    if (entry.measured) count += 1;
  }
  return count;
}

function compareKeys(left: string, right: string): number {
  return left.localeCompare(right, 'en-US');
}

/**
 * `limits` has no access-denied branch of its own beyond this one, because "the identity may not
 * read the limits resource" and "this org does not expose it" arrive as the same Salesforce code.
 * The message therefore states both possibilities rather than picking one, and the suggestion says
 * the failure is confined to quotas, so an Agent does not conclude that its other Tools are broken.
 */
function orgLimitsFailureMapping(): DataFailureMapping {
  return {
    fallbackCode: 'MCP_LIMITS_READ_FAILED',
    fallbackMessage: 'Salesforce could not return the org\'s governor limits for this request.',
    fallbackSuggestion: 'Retry once; if it fails again the request identity or the org\'s API access needs to be checked.',
    rules: [
      {
        codes: [
          'INSUFFICIENT_ACCESS',
          'INSUFFICIENT_ACCESS_OR_READONLY',
          'INSUFFICIENT_PRIVILEGES',
          'API_DISABLED_FOR_ORG',
          'NOT_FOUND',
          'INVALID_TYPE',
        ],
        code: 'MCP_LIMITS_ACCESS_DENIED',
        message: 'Salesforce refused to report the org\'s governor limits to this request\'s identity.',
        suggestion: 'Either the identity lacks View Setup and Configuration, or the org does not expose the limits resource to '
          + 'any identity. Report it rather than retrying, and read the allowances from Salesforce Setup. This affects quota '
          + 'visibility only: other Salesforce Tools are unaffected.',
      },
    ],
  };
}
