/**
 * The prebuilt `DebugLevel` tiers `set_trace_flag` resolves or creates.
 *
 * A tier is a named column of ten levels rather than a single level, because that is what the sObject
 * is: one `TraceFlag` points at exactly one `DebugLevel`, and every category the platform can log is a
 * field on that row. A caller who asks for `logLevel: 'PROFILING'` is therefore making a claim about
 * ten fields at once, and the claim has to be inspectable — which is why the table below is data with a
 * per-tier reason rather than three inline objects in the Tool.
 *
 * **Why resolve-or-create, measured.** This org stores exactly one `DebugLevel` (`SFDC_DevConsole`,
 * with `ApexProfiling: INFO` — the *sampling* level, see
 * `docs/sfoa/P10_T0_LIVE_PROBE_FINDINGS.md` §3). Reusing whatever exists would silently cap profiling
 * at sampling, so a tier that needs full profiling has to be created; the probe measured that creating
 * one succeeds (developer name `SFOA_P10_PROBE`, deleted in-step). Reuse is still tried first, by the
 * tier's own developer name, so repeated calls converge on one row per tier instead of one row per call.
 *
 * **The prefix is what makes reuse safe.** `SFOA_P10_` cannot collide with a level an administrator
 * built by hand, so this Tool never adopts — and then rewrites — a row someone else owns. Resolution
 * only ever looks up the three names below.
 *
 * **Not every field is sent on create.** The probe created its level with seven fields
 * (`ApexCode`, `ApexProfiling`, `Callout`, `Database`, `System`, `Validation`, `Workflow`) and the
 * create succeeded; `NBA`, `Visualforce` and `Wave` were never exercised. An unset `DebugLevel` field
 * defaults to `NONE`, so `debugLevelCreatePayload` omits every field whose tier value is `NONE`. That
 * keeps a created level inside the measured surface without weakening the catalog: `levels` still
 * states all ten, the three never-exercised fields are always `NONE` in every tier, and so each
 * payload is a *subset* of the seven fields the probe proved creatable — three for `MINIMAL`, six for
 * `DEBUG`, seven for `PROFILING`. The sizes differ by design; what is invariant is the subset.
 */

/**
 * Every category a `DebugLevel` can carry, in the sObject's own field names.
 *
 * The names match `APEX_LOG_CATEGORY_FIELDS`' values in `debug-log-parser.ts`, which is what lets a
 * parsed log's categories be compared against the level that was requested. That module asserts the
 * correspondence at compile time; a unit test pins the bijection.
 */
export const DEBUG_LEVEL_FIELDS = Object.freeze([
  'ApexCode',
  'ApexProfiling',
  'Callout',
  'Database',
  'NBA',
  'System',
  'Validation',
  'Visualforce',
  'Wave',
  'Workflow',
] as const);

export type DebugLevelField = (typeof DEBUG_LEVEL_FIELDS)[number];

/** The sObject's level values, ascending in verbosity. `NONE` is the sObject's own default. */
export const DEBUG_LEVEL_VALUES = Object.freeze([
  'NONE',
  'ERROR',
  'WARN',
  'INFO',
  'DEBUG',
  'FINE',
  'FINER',
  'FINEST',
] as const);

export type DebugLevelValue = (typeof DEBUG_LEVEL_VALUES)[number];

/**
 * The three tier names, as a tuple rather than derived from `DEBUG_LEVEL_TIERS`' keys.
 *
 * The direction matters: this is the source of truth, `DebugLevelTierName` is derived from it, and
 * `DEBUG_LEVEL_TIERS` is typed as a total `Record` of it — so a tier named here without a catalog entry,
 * or a catalog entry whose name is not here, is a compile error. It is also what lets the input schema be
 * `z.enum(DEBUG_LEVEL_TIER_NAMES)` with no second copy of the names to drift.
 */
export const DEBUG_LEVEL_TIER_NAMES = Object.freeze(['MINIMAL', 'DEBUG', 'PROFILING'] as const);

export type DebugLevelTierName = (typeof DEBUG_LEVEL_TIER_NAMES)[number];

export type DebugLevelTier = Readonly<{
  /** The `DebugLevel.DeveloperName` this tier resolves to. Unique per tier, and never hand-authored. */
  developerName: string;
  masterLabel: string;
  /** One sentence, for the Tool description: what this tier is for. */
  purpose: string;
  levels: Readonly<Record<DebugLevelField, DebugLevelValue>>;
}>;

/** Prefix for every level this Tool may create. Documented in the Tool description and the ADR. */
export const DEBUG_LEVEL_TIER_PREFIX = 'SFOA_P10_';

/**
 * Three tiers, and the reason there are three rather than one.
 *
 * `DEBUG` is the default because it is the cheapest tier that answers "what did this request do".
 * `MINIMAL` exists because the log body is bounded and a `FINEST` log of a busy transaction does not
 * fit — it is the tier the truncation hint recommends, so the hint has something concrete to say
 * instead of "ask for less". `PROFILING` exists because the org's only stored level samples profiling
 * at `INFO`, so full profiling is only reachable through a level this Tool creates.
 */
export const DEBUG_LEVEL_TIERS: Readonly<Record<DebugLevelTierName, DebugLevelTier>> = Object.freeze({
  MINIMAL: Object.freeze({
    developerName: `${DEBUG_LEVEL_TIER_PREFIX}MINIMAL`,
    masterLabel: 'SFoA P10 Minimal',
    purpose: 'the cheapest tier that still records an uncaught exception and the class and line that raised it',
    levels: Object.freeze({
      ApexCode: 'INFO',
      ApexProfiling: 'NONE',
      Callout: 'NONE',
      Database: 'NONE',
      NBA: 'NONE',
      System: 'INFO',
      Validation: 'INFO',
      Visualforce: 'NONE',
      Wave: 'NONE',
      Workflow: 'NONE',
    }),
  }),
  DEBUG: Object.freeze({
    developerName: `${DEBUG_LEVEL_TIER_PREFIX}DEBUG`,
    masterLabel: 'SFoA P10 Debug',
    purpose: 'statement-level Apex detail plus database and callout summaries, without profiling counters',
    levels: Object.freeze({
      ApexCode: 'DEBUG',
      ApexProfiling: 'NONE',
      Callout: 'INFO',
      Database: 'INFO',
      NBA: 'NONE',
      System: 'DEBUG',
      Validation: 'INFO',
      Visualforce: 'NONE',
      Wave: 'NONE',
      Workflow: 'INFO',
    }),
  }),
  PROFILING: Object.freeze({
    developerName: `${DEBUG_LEVEL_TIER_PREFIX}PROFILING`,
    masterLabel: 'SFoA P10 Profiling',
    purpose: 'the debug tier plus full Apex profiling, which this org\'s only stored level samples instead',
    levels: Object.freeze({
      ApexCode: 'FINEST',
      ApexProfiling: 'FINEST',
      Callout: 'INFO',
      Database: 'INFO',
      NBA: 'NONE',
      System: 'DEBUG',
      Validation: 'INFO',
      Visualforce: 'NONE',
      Wave: 'NONE',
      Workflow: 'INFO',
    }),
  }),
});

export const DEFAULT_DEBUG_LEVEL_TIER: DebugLevelTierName = 'DEBUG';

export function isDebugLevelTierName(value: string): value is DebugLevelTierName {
  return Object.hasOwn(DEBUG_LEVEL_TIERS, value);
}

/**
 * The `DebugLevel` insert body for a tier: `DeveloperName`, `MasterLabel`, and every field the tier
 * sets to something other than `NONE`.
 *
 * Omitting the `NONE` fields is not a shortcut. It is what keeps every payload a subset of the seven
 * fields the probe actually created a level with, and it is exactly equivalent — `NONE` is the
 * sObject's default — so a level created here carries the tier's meaning whether or not a future API
 * version stops exposing one of the three unexercised fields.
 */
export function debugLevelCreatePayload(tier: DebugLevelTier): Readonly<Record<string, string>> {
  const payload: Record<string, string> = {
    DeveloperName: tier.developerName,
    MasterLabel: tier.masterLabel,
  };
  for (const field of DEBUG_LEVEL_FIELDS) {
    const value = tier.levels[field];
    if (value !== 'NONE') payload[field] = value;
  }
  return Object.freeze(payload);
}

/**
 * A tier's levels as a full ten-field record, filling any field the org did not report with `NONE`.
 *
 * Used for a *reused* level: the values come from what the org actually stores, so a level someone
 * edited by hand is reported as it is rather than as the tier describes it. That difference is the
 * point — an operator comparing a thin log against a `PROFILING` request can see which field was not
 * set.
 */
export function readDebugLevelLevels(
  record: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<DebugLevelField, DebugLevelValue>> {
  const levels: Record<string, DebugLevelValue> = {};
  for (const field of DEBUG_LEVEL_FIELDS) {
    const value = record?.[field];
    levels[field] = typeof value === 'string' && isDebugLevelValue(value) ? value : 'NONE';
  }
  return Object.freeze(levels) as Readonly<Record<DebugLevelField, DebugLevelValue>>;
}

function isDebugLevelValue(value: string): value is DebugLevelValue {
  return (DEBUG_LEVEL_VALUES as readonly string[]).includes(value);
}
