import type { ScheduledJobStallAssessment } from './schemas.js';

/**
 * The pure half of `get_platform_diagnostics`' scheduled-job section: the conservative stall rule.
 *
 * **Why the rule is a module of its own.** The section's whole claim is a hedge — "suspected" — and the
 * one thing that must never happen is a hedge being rendered as a verdict, or an unrecognized reading
 * being rendered as a healthy one. Both are decided here, as a pure function of the fields the org
 * returned, so the unit suite can pin every shape (including the shapes this org does not hold, because
 * the reference org's `CronTrigger` table is empty — the probe measured 0 rows) without a Connection.
 *
 * **The rule, in full.**
 *
 * - `SUSPECTED` requires *both*: the platform reports one of the **waiting literals** below, *and* the
 *   job's `NextFireTime` passed more than {@link SCHEDULED_JOB_STALL_GRACE_MS} ago. A waiting job whose
 *   next fire time is still ahead is not late; a waiting job that is minutes late is inside the grace
 *   window, because a scheduler is allowed to be late and the cost of a false accusation is higher than
 *   the cost of a delayed flag.
 * - `NOT_SUSPECTED` covers exactly two readings: the platform reports the job **running right now**
 *   (a long run is a different diagnosis, and this Tool does not judge one), or the job is **deleted**.
 * - `INDETERMINATE` is everything else, and it is the default rather than a leftover: an unrecognized
 *   `State` literal (this Tool has never measured the vocabulary — the reference org holds no
 *   `CronTrigger` rows), a missing or unparseable `NextFireTime`, or a state this rule declines to judge
 *   (a paused schedule fires nowhere, and whether an administrator paused it is not readable here).
 *
 * **What the rule deliberately does not do.** It does not compare `TimesTriggered` across calls (one
 * snapshot has no history), it does not treat a missing `PreviousFireTime` as evidence (a job created
 * inside the window legitimately has none), and it does not rank the suspicion — every reason it emits
 * is a fact the org returned, phrased as a fact.
 */

/**
 * The state literals that mean "waiting to fire".
 *
 * Matched exactly, against the API enum, never against a label — and the rule's `INDETERMINATE` default
 * is what makes a literal this list has never seen *visible* rather than silently healthy. The list is a
 * set of literals to recognize, not a claim that the org uses exactly these: the reference org was
 * measured holding no `CronTrigger` rows at all (`P10_T0_LIVE_PROBE_FINDINGS` §5), so no state
 * vocabulary could be measured on it.
 */
export const SCHEDULED_JOB_WAITING_STATES = Object.freeze([
  'WAITING',
  'QUEUED',
  'READY',
  'BLOCKED',
] as const);

/** The literals that mean the platform reports the job as running right now. */
export const SCHEDULED_JOB_RUNNING_STATES = Object.freeze(['ACQUIRED', 'EXECUTING'] as const);

/** The literal that means the schedule no longer exists. A deleted job is not a stalled one. */
export const SCHEDULED_JOB_DELETED_STATE = 'DELETED';

/**
 * How late a waiting job may be before the flag is raised.
 *
 * 30 minutes, flat, chosen to be *uninteresting*: the platform's own scheduler lag is seconds, a
 * long-running job holds its trigger in a running state rather than a waiting one, and a job whose next
 * fire time is half an hour in the past while the platform still calls it waiting is late in a way no
 * healthy reading explains. A larger grace would hide real stalls inside a support window of hours; a
 * smaller one would flag scheduler lag.
 */
export const SCHEDULED_JOB_STALL_GRACE_MS = 30 * 60_000;

export type ScheduledJobStallInput = Readonly<{
  /** The `State` literal exactly as the org returned it. */
  state: string | null;
  /** The `NextFireTime` value exactly as the org returned it. */
  nextFireTime: string | null;
  /** The `PreviousFireTime` value exactly as the org returned it. Not used to decide; kept for the output. */
  previousFireTime: string | null;
  /** The org's clock, in epoch milliseconds, at which this reading was taken. */
  nowMs: number;
}>;

export type ScheduledJobStallVerdict = Readonly<{
  assessment: ScheduledJobStallAssessment;
  reasons: readonly string[];
}>;

export function assessScheduledJobStall(input: ScheduledJobStallInput): ScheduledJobStallVerdict {
  const state = input.state;
  if (state === null) {
    return verdict('INDETERMINATE', [
      'The org returned no State for this scheduled job, so there is nothing to apply the rule to.',
    ]);
  }
  if (SCHEDULED_JOB_RUNNING_STATES.some((literal) => literal === state)) {
    return verdict('NOT_SUSPECTED', [
      `The platform reports state ${state}, which means the job is running now.`,
      'A long run is a different reading than a stall: this Tool does not judge execution time.',
    ]);
  }
  if (state === SCHEDULED_JOB_DELETED_STATE) {
    return verdict('NOT_SUSPECTED', [
      `The platform reports state ${SCHEDULED_JOB_DELETED_STATE}: the schedule no longer exists, so it is not `
        + 'a schedule that stopped firing.',
    ]);
  }
  if (!SCHEDULED_JOB_WAITING_STATES.some((literal) => literal === state)) {
    return verdict('INDETERMINATE', [
      `The platform reports state ${state}, which is not a literal this rule recognizes, so no assessment is made.`,
      'The state vocabulary of CronTrigger could not be measured on the reference org (it holds no CronTrigger '
        + 'rows), so an unfamiliar literal is reported as a gap rather than read as healthy.',
    ]);
  }
  if (input.nextFireTime === null) {
    return verdict('INDETERMINATE', [
      `The platform reports state ${state} but returned no NextFireTime, so lateness cannot be decided.`,
    ]);
  }
  const nextFireMs = Date.parse(input.nextFireTime);
  if (Number.isNaN(nextFireMs)) {
    return verdict('INDETERMINATE', [
      `The platform reports state ${state} but its NextFireTime (${input.nextFireTime}) could not be parsed as a `
        + 'timestamp, so lateness cannot be decided.',
    ]);
  }
  const lateMs = input.nowMs - nextFireMs;
  if (lateMs <= SCHEDULED_JOB_STALL_GRACE_MS) {
    return verdict('NOT_SUSPECTED', [
      `The platform reports state ${state}; its next fire time is ${lateMs <= 0
        ? 'still ahead'
        : `${describeMinutes(lateMs)} in the past, inside the ${describeMinutes(SCHEDULED_JOB_STALL_GRACE_MS)} grace window`}.`,
    ]);
  }
  return verdict('SUSPECTED', [
    `The platform reports state ${state}, which is a waiting state, and its next fire time passed `
      + `${describeMinutes(lateMs)} ago — more than the ${describeMinutes(SCHEDULED_JOB_STALL_GRACE_MS)} grace window.`,
    'This is a flag to investigate, not a diagnosis: the platform says the schedule has not fired, and this Tool '
      + 'does not know why.',
  ]);
}

function verdict(
  assessment: ScheduledJobStallAssessment,
  reasons: readonly string[],
): ScheduledJobStallVerdict {
  return Object.freeze({ assessment, reasons: Object.freeze(reasons) });
}

function describeMinutes(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}
