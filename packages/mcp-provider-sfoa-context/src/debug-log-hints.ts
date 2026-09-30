/**
 * The `hint` each debug-log Tool returns, and the rule that shapes every one of them.
 *
 * The three Tools are meant to be walked in order — open a trace, reproduce, list the logs, read the
 * body, find the class and line — so each hint names the next step of that path rather than restating
 * the payload the caller already has.
 *
 * **A hint may only name a Tool `tools/list` advertises.** That is a hard rule here (the T2 prompt
 * forbids naming an unadvertised Tool), and it is not a formality: the three Tools are enabled
 * independently in the Console, so `set_trace_flag` can be on while `get_apex_logs` is off. A hint that
 * named a disabled Tool would send an Agent to a name its own `tools/list` does not carry, which reads
 * as a broken deployment rather than as a Tool that is simply switched off. Every builder below
 * therefore takes the session's advertised set and degrades to an actionable sentence that names no
 * Tool when the next step is not available.
 *
 * The builders are pure functions of that set and of measured counts, so the gating is unit-testable
 * without a Salesforce Connection — which matters, because "the hint named a Tool that was not there" is
 * a defect no live run would reliably catch.
 */

const LOG_BODY_TOOL = 'get_debug_log_body';
const APEX_LOGS_TOOL = 'get_apex_logs';
const TRACE_FLAG_TOOL = 'set_trace_flag';
const TOOLING_QUERY_TOOL = 'run_diagnostic_tooling_query';

export function traceFlagHint(advertised: ReadonlySet<string>): string {
  return advertised.has(APEX_LOGS_TOOL)
    ? `Reproduce the problem now, then call ${APEX_LOGS_TOOL} with a timeWindowMinutes that covers this window `
      + 'to list what was logged.'
    : 'Reproduce the problem now, while this trace is active. Apex logs are kept for a short platform retention '
      + 'window only, so read them soon after reproducing.';
}

export type ApexLogsHintFacts = Readonly<{
  returnedCount: number;
  totalCount: number | null;
  /** True when a `status` filter was supplied and applied to the scanned rows. */
  statusFilterApplied: boolean;
  /** The distinct `Status` values the scanned rows carry, in the org's own spelling. */
  observedStatuses: readonly string[];
  /**
   * True when rows that matched were dropped to fit the response budget.
   *
   * Separate from `limit`, because the two cuts mean different things and only this one makes the list
   * incomplete by *size*: a caller who asked for `limit: 50` and got 50 knows what happened, while a
   * caller who asked for 50 and got 12 because the answer was too large does not — and without this flag
   * an empty result would fall into the "no log was found" branch and read as a quiet org.
   */
  budgetDropped: boolean;
}>;

/**
 * The list hint has to carry more than a next step, because an empty log list is the single most
 * mis-readable answer these Tools produce. An Agent — and the person reading its summary — will take
 * "no rows" as "nothing went wrong", when on this org it far more often means the trace was not open
 * while the problem happened, or that logging is switched off for the user.
 *
 * So an empty result says what it is, and a status-filtered empty result says something different again:
 * the filter was matched against the values this org stores, which are localized, and a literal that does
 * not appear among them selects nothing at all rather than everything. A budget-dropped result is checked
 * first, because it is the one case where rows existed and are simply not on the page.
 */
export function apexLogsHint(advertised: ReadonlySet<string>, facts: ApexLogsHintFacts): string {
  const next = advertised.has(LOG_BODY_TOOL)
    ? `Call ${LOG_BODY_TOOL} with one of the ids above to read the body and locate the class and line.`
    : 'The log body is fetched separately, by log id.';
  if (facts.budgetDropped) {
    return `Rows that matched were dropped to fit the server's response budget, so this list is incomplete by size `
      + 'rather than by count. Re-run with a smaller limit or a narrower timeWindowMinutes to read the rest; '
      + (facts.returnedCount > 0 ? next : 'no row at all fitted, which is a size problem and not an empty window.');
  }
  if (facts.returnedCount > 0) {
    const ofTotal = facts.totalCount === null
      ? ''
      : ` of ${facts.totalCount} in this window`;
    return `${facts.returnedCount} log(s) listed${ofTotal}. ${next}`;
  }
  if (facts.statusFilterApplied) {
    const observed = facts.observedStatuses.length === 0
      ? 'no Status value at all could be read from the scanned rows'
      : `the scanned rows carry ${facts.observedStatuses.map((value) => `'${value}'`).join(', ')}`;
    return `No scanned row matched the status filter, and this is not the same as no matching execution: `
      + `${observed}. The filter is an exact match against the value this org stores, which may be localized. `
      + 'Re-run without the status filter, or pass one of those values verbatim, before concluding anything '
      + 'about the request.';
  }
  return 'No log was found in this window. That is not a statement about whether the request succeeded — it means '
    + 'nothing was logged: a trace must be open for the target while the problem is reproduced, and Apex log '
    + 'retention is short, so a log for the incident may already have expired.';
}

export type DebugLogBodyHintFacts = Readonly<{
  truncated: boolean;
  maxCharacters: number;
  parseStatus: 'PARSED' | 'NOT_A_LOG';
  /** The class the top stack frame named, when the log carried an exception. */
  apexClass: string | null;
  lineNumber: number | null;
}>;

export function debugLogBodyHint(advertised: ReadonlySet<string>, facts: DebugLogBodyHintFacts): string {
  if (facts.truncated) {
    const remedy = advertised.has(TRACE_FLAG_TOOL)
      ? `re-open a trace with ${TRACE_FLAG_TOOL} at logLevel MINIMAL and reproduce again, so a smaller log `
        + 'is written'
      : 'reduce the log level the trace is opened at and reproduce again, so a smaller log is written';
    return `The body was cut at ${facts.maxCharacters} characters, so the end of the log — which is where an `
      + `exception is written — may be missing. Read only what is needed from this prefix, or ${remedy}.`;
  }
  if (facts.parseStatus === 'NOT_A_LOG') {
    return 'The body did not begin with a debug-log header, so nothing could be parsed from it. Treat the raw text '
      + 'above as the evidence; it has been returned unread rather than summarised.';
  }
  if (facts.apexClass !== null && facts.lineNumber !== null && advertised.has(TOOLING_QUERY_TOOL)) {
    return `The top stack frame names ${facts.apexClass} line ${facts.lineNumber}. Call ${TOOLING_QUERY_TOOL} with `
      + `\`SELECT Body FROM ApexClass WHERE Name = '${facts.apexClass}'\` to read the code around that line.`;
  }
  if (facts.apexClass !== null && facts.lineNumber !== null) {
    return `The top stack frame names ${facts.apexClass} line ${facts.lineNumber} — read that class and line in `
      + 'Salesforce to see the statement that raised the exception.';
  }
  return 'No exception was found in this log, so nothing in it locates a failure. Check that the trace was open on '
    + 'the right entity while the problem was reproduced, and that the log is not an earlier run.';
}
