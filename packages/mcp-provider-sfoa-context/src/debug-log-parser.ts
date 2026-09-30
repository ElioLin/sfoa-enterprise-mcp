/**
 * Header and exception parsing for an Apex debug log body.
 *
 * Pure: nothing here opens a Connection or knows about a request role, so the whole module is
 * unit-testable against fixture text. The host executor fetches the bytes and owns the budget; this
 * owns what the bytes mean.
 *
 * **The version comes from the log, never from the org.** The T1 probe measured a v68.0 org whose
 * logs opened `56.0` and `54.0`; a parser written against the org's own version would mis-read two of
 * the three formats it can meet. Everything version-dependent in this module is therefore read from
 * the log's first line, and the answer says which version it read.
 *
 * **Nothing is invented.** A log with no exception reports `NO_EXCEPTION`, a body that is not a log
 * reports `NOT_A_LOG`, and a version this module has no measurement for is still parsed but flagged
 * `unvalidated` — so a reader can always tell a parse from a guess. The alternative, a confident
 * summary built from a format that was assumed, is the failure this module exists to avoid.
 */

import type { DebugLevelField } from './debug-levels.js';

/**
 * Log header API versions this parser has been validated against — measured, not chosen. `56.0` and
 * `54.0` are the two the T1 probe actually sampled (see `docs/sfoa/P10_T0_LIVE_PROBE_FINDINGS.md` §1).
 *
 * A log outside this set still gets parsed: the event-line grammar has been stable across every
 * version observed, so refusing outright would discard readable evidence. What it does *not* get is
 * silence about the uncertainty — `unvalidated` is set, and the Tool's description says so.
 */
export const VALIDATED_APEX_LOG_MAJOR_VERSIONS = Object.freeze([54, 56]);

/**
 * The header's category tokens mapped to the `DebugLevel` sObject field names they configure.
 *
 * The tokens are not the field names: the header says `APEX_CODE` and `DB` where the sObject says
 * `ApexCode` and `Database`. Two renames are the whole reason this table exists; without it the
 * categories a log actually captured cannot be compared against the level that was requested.
 *
 * An unrecognized token is **kept with `field: null`** rather than dropped, because a category this
 * table does not know is exactly the signal that the log came from a version worth looking at.
 *
 * The `satisfies` clause is what keeps this table honest as `debug-levels.ts` changes: every mapped
 * value has to be a real `DebugLevel` field, so a typo or a field Salesforce renames fails the build
 * rather than producing a category that silently never matches a requested level.
 */
export const APEX_LOG_CATEGORY_FIELDS = Object.freeze({
  APEX_CODE: 'ApexCode',
  APEX_PROFILING: 'ApexProfiling',
  CALLOUT: 'Callout',
  DB: 'Database',
  NBA: 'NBA',
  SYSTEM: 'System',
  VALIDATION: 'Validation',
  VISUALFORCE: 'Visualforce',
  WAVE: 'Wave',
  WORKFLOW: 'Workflow',
} as const satisfies Readonly<Record<string, DebugLevelField>>);

export type ApexLogCategory = Readonly<{
  /** The token exactly as the log header wrote it. */
  token: string;
  /** The level the log recorded for this category, as written. */
  level: string;
  /** The `DebugLevel` field this token configures, or null when the token is not one we know. */
  field: DebugLevelField | null;
}>;

export type ApexLogStackFrame = Readonly<{
  /** The class (or trigger) the frame is in. */
  apexClass: string;
  /** The method, or null for a trigger frame, which has no method name. */
  method: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
  /** The frame exactly as the log wrote it, so a reader can check the parse. */
  raw: string;
}>;

export type ApexLogHeaderSummary = Readonly<{
  /**
   * `PARSED` — a header was read. `NOT_A_LOG` — the first line is not a debug-log header, so nothing
   * else here was attempted and every other field is empty. There is deliberately no third state
   * meaning "probably fine".
   */
  parseStatus: 'PARSED' | 'NOT_A_LOG';
  /** The version the log itself declares. Null when `parseStatus` is `NOT_A_LOG`. */
  logApiVersion: string | null;
  /** The major version as a number, for the validated check. Null when unreadable. */
  logApiVersionMajor: number | null;
  /** False when this version is outside the measured range: parsed, but by an unmeasured format. */
  validated: boolean;
  /** This log's categories, in the order the header listed them. */
  categories: readonly ApexLogCategory[];
  /**
   * The exception the log ended on, or null when the execution completed. `EXCEPTION_THROWN` is a
   * handled throw and is reported separately; this is the one that stopped the transaction.
   */
  fatalError: string | null;
  exceptionType: string | null;
  exceptionMessage: string | null;
  /** The class of the top stack frame — the class the exception was raised in. */
  apexClass: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
  /** Frames, outermost last, in the order the log wrote them and bounded by `MAX_STACK_FRAMES`. */
  stackSummary: readonly ApexLogStackFrame[];
  /** Throws recorded along the way, handled or not, in order and bounded. */
  thrownExceptions: readonly string[];
  /** Bytes of `USER_DEBUG` output, which is what a caller usually added on purpose. */
  userDebugLineCount: number;
  /** True when the log recorded `EXECUTION_FINISHED`; false does not by itself mean a failure. */
  executionFinished: boolean;
}>;

/** Frames beyond this are dropped from `stackSummary`; the count is still the real one. */
export const MAX_STACK_FRAMES = 20;
/** Throws beyond this are dropped from `thrownExceptions`. */
export const MAX_THROWN_EXCEPTIONS = 20;
const MAX_FIELD_CHARACTERS = 600;

/**
 * `HH:MM:SS.mmm (nanoseconds)|EVENT|…`. Anchored on the pipe rather than on the timestamp so a
 * continuation line — which has no timestamp — can be told apart from an event line by the same test.
 */
const EVENT_LINE_PATTERN = /^\d{2}:\d{2}:\d{2}\.\d{1,3}\s+\(\d+\)\|/u;
const HEADER_PATTERN = /^(\d+(?:\.\d+)?)\s+(.*)$/u;
const CATEGORY_PATTERN = /^([A-Z_]+),([A-Z]+)$/u;
/**
 * A stack frame's `…: line N, column M` tail, with an optional `Class.`/`Trigger.` qualifier and an
 * optional method segment. Covers all three shapes Salesforce writes — `MyClass.myMethod`,
 * `Class.MyClass.myMethod` (qualifier and method) and `Trigger.MyTrigger` (qualifier, no method) —
 * so the qualifier is matched only to be discarded: it never carries the class name.
 */
const FRAME_PATTERN = /^(?:(?:Class|Trigger)\.)?([A-Za-z_][A-Za-z0-9_]*)\.?([A-Za-z_][A-Za-z0-9_]*)?:\s*line\s+(\d+),\s*column\s+(\d+)$/u;

/** The `|`-separated payload of an event line, with the leading timestamp and event name removed. */
function eventPayload(line: string): { event: string; fields: readonly string[] } | null {
  if (!EVENT_LINE_PATTERN.test(line)) return null;
  const pipe = line.indexOf('|');
  const rest = line.slice(pipe + 1);
  const parts = rest.split('|');
  const event = parts[0]?.trim() ?? '';
  return event.length === 0 ? null : { event, fields: parts.slice(1) };
}

/**
 * `System.NullPointerException: Attempt to de-reference a null object` split into its two halves.
 *
 * The split is on the **first** colon: a `DmlException` message carries colons of its own
 * ("Insert failed. First exception on row 0; first error: REQUIRED_FIELD_MISSING, …"), and splitting
 * on the last one would cut the type name in half.
 */
export function splitExceptionText(value: string): Readonly<{ type: string | null; message: string | null }> {
  const trimmed = value.trim();
  if (trimmed.length === 0) return Object.freeze({ type: null, message: null });
  const colon = trimmed.indexOf(':');
  if (colon <= 0) return Object.freeze({ type: null, message: trimField(trimmed) });
  return Object.freeze({
    type: trimField(trimmed.slice(0, colon)),
    message: trimField(trimmed.slice(colon + 1)),
  });
}

/**
 * Parses a debug log body into the summary `get_debug_log_body` returns.
 *
 * The scan is single-pass over the lines, because a log can be megabytes and the Tool is bounded.
 * Frame lines are recognized positionally — a line with no event prefix directly after a
 * `FATAL_ERROR` is that error's stack — which is how Salesforce writes them; anywhere else an
 * unprefixed line is ignored rather than guessed at.
 */
export function parseApexLogHeader(body: string): ApexLogHeaderSummary {
  const lines = body.split(/\r?\n/u);
  const header = lines[0] ?? '';
  const headerMatch = HEADER_PATTERN.exec(header.trim());
  if (headerMatch === null) return notALog();

  const logApiVersion = headerMatch[1] ?? null;
  const categories = parseCategories(headerMatch[2] ?? '');
  // A header with no category at all is not the shape a debug log has, and treating it as one would
  // mean reporting a version parsed out of some other file's first line.
  if (categories.length === 0) return notALog();

  const major = logApiVersion === null ? null : Number.parseInt(logApiVersion.split('.')[0] ?? '', 10);
  const majorNumber = major !== null && Number.isFinite(major) ? major : null;

  let fatalError: string | null = null;
  let thrown: string | null = null;
  const thrownExceptions: string[] = [];
  const frames: ApexLogStackFrame[] = [];
  let userDebugLineCount = 0;
  let executionFinished = false;
  let collectingFrames = false;

  for (const line of lines.slice(1)) {
    const parsed = eventPayload(line);
    if (parsed === null) {
      // Only meaningful directly after a `FATAL_ERROR`; a stray unprefixed line is not a frame.
      if (collectingFrames && frames.length < MAX_STACK_FRAMES) {
        const frame = parseStackFrame(line);
        if (frame !== null) frames.push(frame);
      }
      continue;
    }
    collectingFrames = false;
    const { event, fields } = parsed;
    if (event === 'FATAL_ERROR') {
      fatalError = trimField(fields[0] ?? '');
      collectingFrames = true;
    } else if (event === 'EXCEPTION_THROWN') {
      const text = fields[fields.length - 1] ?? '';
      if (thrown === null) thrown = trimField(text);
      if (thrownExceptions.length < MAX_THROWN_EXCEPTIONS) thrownExceptions.push(trimField(text) ?? '');
    } else if (event === 'USER_DEBUG') {
      userDebugLineCount += 1;
    } else if (event === 'EXECUTION_FINISHED') {
      executionFinished = true;
    }
  }

  // The fatal error is what stopped the transaction, so it names the exception. A log that only threw
  // handled exceptions is not a failed execution, and reporting one of those as the failure would
  // point a reader at a caught error instead of the real one.
  const source = fatalError ?? thrown;
  const { type, message } = source === null
    ? Object.freeze({ type: null, message: null })
    : splitExceptionText(source);
  const top = frames[0] ?? null;

  return Object.freeze({
    parseStatus: 'PARSED',
    logApiVersion,
    logApiVersionMajor: majorNumber,
    validated: majorNumber !== null && VALIDATED_APEX_LOG_MAJOR_VERSIONS.includes(majorNumber),
    categories: Object.freeze(categories),
    fatalError,
    exceptionType: type,
    exceptionMessage: message,
    apexClass: top?.apexClass ?? null,
    lineNumber: top?.lineNumber ?? null,
    columnNumber: top?.columnNumber ?? null,
    stackSummary: Object.freeze(frames),
    thrownExceptions: Object.freeze(thrownExceptions),
    userDebugLineCount,
    executionFinished,
  });
}

/**
 * `56.0 APEX_CODE,FINEST;DB,INFO;…` — everything after the version, split on `;`.
 *
 * A token that does not match `TOKEN,LEVEL` is skipped rather than reported, because the only thing
 * the header's categories are used for is the known-token lookup, and a malformed entry carries no
 * level to look up. Unknown-but-well-formed tokens are kept.
 */
function parseCategories(value: string): ApexLogCategory[] {
  const categories: ApexLogCategory[] = [];
  for (const entry of value.split(';')) {
    const match = CATEGORY_PATTERN.exec(entry.trim());
    if (match === null) continue;
    const token = match[1] ?? '';
    const level = match[2] ?? '';
    const field = (APEX_LOG_CATEGORY_FIELDS as Readonly<Record<string, DebugLevelField | undefined>>)[token]
      ?? null;
    categories.push(Object.freeze({ token, level, field }));
  }
  return categories;
}

/**
 * One stack frame line, or null when the line is not a frame.
 *
 * The class is the first captured segment and the method the second, whichever qualifier was written:
 * `MyClass.myMethod`, `Class.MyClass.myMethod` and `Trigger.MyTrigger` are one shape once the
 * qualifier is discarded, which is why this needs no per-kind branch.
 */
export function parseStackFrame(line: string): ApexLogStackFrame | null {
  const raw = trimField(line.trim());
  if (raw === null) return null;
  const match = FRAME_PATTERN.exec(raw);
  if (match === null) return null;
  const apexClass = match[1] ?? '';
  const method = match[2] ?? null;
  return Object.freeze({
    apexClass,
    method: method !== null && method.length > 0 ? method : null,
    lineNumber: toNumber(match[3]),
    columnNumber: toNumber(match[4]),
    raw,
  });
}

function notALog(): ApexLogHeaderSummary {
  return Object.freeze({
    parseStatus: 'NOT_A_LOG',
    logApiVersion: null,
    logApiVersionMajor: null,
    validated: false,
    categories: Object.freeze([]),
    fatalError: null,
    exceptionType: null,
    exceptionMessage: null,
    apexClass: null,
    lineNumber: null,
    columnNumber: null,
    stackSummary: Object.freeze([]),
    thrownExceptions: Object.freeze([]),
    userDebugLineCount: 0,
    executionFinished: false,
  });
}

function trimField(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, MAX_FIELD_CHARACTERS);
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
