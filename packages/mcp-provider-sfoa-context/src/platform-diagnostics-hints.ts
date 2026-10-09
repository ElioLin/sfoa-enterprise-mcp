import type { PlatformDiagnosticSection, PlatformDiagnosticSectionState } from './schemas.js';

/**
 * The `hint` `get_platform_diagnostics` returns, and the rule that shapes it.
 *
 * The T2 rule applies here as it does to every P10 Tool: **a hint may only name a Tool the session's
 * `tools/list` actually advertises.** These Tools are enabled one at a time in the Console, so
 * `get_metadata_component_context` or `get_apex_logs` can be off while this one is on, and a hint naming
 * one would send an Agent to a name its own tool list does not carry. Every Tool-naming branch below is
 * gated on the advertised set and degrades to a sentence that names no Tool.
 *
 * The second constraint is this Tool's own failure mode, and it is the opposite of a listing's. A
 * timeline *looks* complete: it is a single ordered list, and a section that could not be read simply
 * contributes no lines to it. So the hint is where an incomplete timeline is said out loud — and where a
 * complete-but-empty one is distinguished from it, because "nothing changed" and "nothing could be read"
 * are the two readings a bare timeline cannot tell apart. That is why the unavailable branch leads, ahead
 * of every other thing this hint could say.
 *
 * The builders are pure functions of the aggregated counts, so the gating and the branch selection are
 * unit-testable without a Salesforce Connection — which matters, because a hint that led with "line up the
 * nearest change" while a section was unreadable is a defect no live run would reliably catch.
 */

const METADATA_CONTEXT_TOOL = 'get_metadata_component_context';
const APEX_LOGS_TOOL = 'get_apex_logs';

/** The budget the output schema pins `hint` to. A hint is bounded by contract, not by convention. */
const HINT_MAX_CHARACTERS = 1_000;

export type PlatformDiagnosticsSectionFact = Readonly<{
  section: PlatformDiagnosticSection;
  status: PlatformDiagnosticSectionState;
  entryCount: number;
  totalCount: number | null;
  /** Present only when the section is `SCHEDULED_JOBS` and was read. */
  suspectedStallCount: number | null;
  /** Present only on `UNAVAILABLE`: the prerequisite identifier, so the hint can point at the remedy. */
  prerequisite: string | null;
}>;

export type PlatformDiagnosticsHintFacts = Readonly<{
  windowHours: number;
  sections: readonly PlatformDiagnosticsSectionFact[];
  truncated: boolean;
  /** The oldest `SetupAuditTrail` row the org still retains, when that bound could be read. */
  oldestRetainedAt: string | null;
}>;

const SECTION_LABELS: Readonly<Record<PlatformDiagnosticSection, string>> = Object.freeze({
  SETUP_CHANGES: 'the setup audit trail',
  ASYNC_FAILURES: 'the failed asynchronous jobs',
  SCHEDULED_JOBS: 'the scheduled jobs',
});

export function platformDiagnosticsHint(
  advertised: ReadonlySet<string>,
  facts: PlatformDiagnosticsHintFacts,
): string {
  const unavailable = facts.sections.filter((section) => section.status === 'UNAVAILABLE');
  const read = facts.sections.filter((section) => section.status === 'READ');
  const sentences: string[] = [];

  if (unavailable.length > 0) {
    const names = unavailable
      .map((section) => `${SECTION_LABELS[section.section]}`
        + (section.prerequisite === null ? '' : ` (missing: ${section.prerequisite})`))
      .join(', ');
    sentences.push(
      `${unavailable.length} of ${facts.sections.length} section(s) could not be read — ${names}. The timeline covers `
      + 'only the sections that were read, so a quiet stretch on it is missing evidence rather than a quiet org, and '
      + 'the empty-looking sections must not be reported as "no anomalies". Each unavailable section carries its own '
      + 'prerequisite and reason; resolve that prerequisite and re-run rather than drawing a conclusion from this '
      + 'partial timeline.',
    );
  } else if (facts.truncated) {
    sentences.push(
      'Entries were dropped to fit the server\'s response budget, so the sections below are not the whole window: each '
      + 'section states its own total count, and re-running with a smaller limitPerSection or a narrower windowHours '
      + 'is how the rest is read.',
    );
  } else if (read.length > 0 && read.every((section) => section.entryCount === 0)) {
    sentences.push(
      `Every requested section was read and every one is empty in this ${facts.windowHours}-hour window: no setup `
      + 'change, no failed or aborted asynchronous job, no scheduled job. That is a fact about this org rather than an '
      + 'error — but an empty window can also mean the change that matters happened before it, so widen windowHours '
      + 'before concluding that nothing changed.',
    );
  } else {
    sentences.push(
      'The timeline is ordered oldest first, so the entry immediately above the moment a symptom started is the nearest '
      + 'change to investigate: it is a candidate, not a cause. A setup change and a job failure that touch the same '
      + 'component are the pairing worth reading first.',
    );
  }

  const stalls = facts.sections.find((section) => section.section === 'SCHEDULED_JOBS')?.suspectedStallCount ?? null;
  if (stalls !== null && stalls > 0) {
    sentences.push(
      `${stalls} scheduled job(s) are flagged SUSPECTED stalled: the platform reports a waiting state although the next `
      + 'fire time has passed. The flag is a reading of the platform\'s own fields and not a diagnosis — the job may '
      + 'have been blocked by a failure the other sections carry, and this Tool does not know why it did not fire.',
    );
  }

  if (facts.oldestRetainedAt !== null) {
    sentences.push(
      `The setup audit trail on this org reaches back to ${facts.oldestRetainedAt} and Salesforce does not expose the `
      + 'retention policy to SOQL, so a window reaching further back than that can only return what is still stored.',
    );
  }

  if (advertised.has(METADATA_CONTEXT_TOOL)) {
    sentences.push(
      `A setup change names the component it changed; that component's current definition can be read with `
      + `${METADATA_CONTEXT_TOOL} (ApexClass, Flow, ValidationRule and Layout are among its types). This Tool reports no `
      + 'version history, so a before/after comparison of the change itself is not possible from here.',
    );
  }

  if (advertised.has(APEX_LOGS_TOOL) && facts.sections.some((section) => section.section === 'ASYNC_FAILURES')) {
    sentences.push(
      `A failed job's Apex output is a log rather than a field, and logs are removed by the platform: if one is still `
      + `retained, ${APEX_LOGS_TOOL} is what lists it.`,
    );
  }

  return boundedHint(sentences);
}

/**
 * Joins the sentences and holds the result inside the schema's own bound.
 *
 * The branch sentences are sized so this never cuts in practice — the unit suite asserts the longest
 * possible composition still fits — but the schema refuses a 1 001-character hint, and a refusal at
 * structured-content validation time would turn a hint-overflow into a failed Tool call. A hard cut is
 * therefore the last resort rather than a lost answer.
 */
function boundedHint(sentences: readonly string[]): string {
  const text = sentences.filter((sentence) => sentence.length > 0).join(' ');
  return text.length <= HINT_MAX_CHARACTERS ? text : `${text.slice(0, HINT_MAX_CHARACTERS - 1)}…`;
}
