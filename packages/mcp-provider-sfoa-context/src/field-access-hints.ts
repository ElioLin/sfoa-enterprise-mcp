/**
 * The `hint` `explain_field_access` returns, and the rule that shapes it.
 *
 * Two constraints meet here.
 *
 * The first is the T2 rule, which applies to every P10 Tool: **a hint may only name a Tool the session's
 * `tools/list` actually advertises.** These Tools are enabled one at a time in the Console, so
 * `get_metadata_component_context` can be off while this one is on, and a hint naming it would send an
 * Agent to a name its own tool list does not carry. Every branch below is gated on the advertised set and
 * degrades to a sentence that names no Tool.
 *
 * The second is this Tool's own failure mode. An answer that lists grants is easy to over-read, because
 * the interesting number is always missing from it: field-level security decides *two* of the gates a
 * field can be behind, and a validation rule, a field dependency or a read-only layout decides others
 * that this Tool never sees. So the hint is where "what this answer does not establish" is said out
 * loud — and it is said differently depending on whether the subject was granted, denied, or never
 * decided.
 *
 * The builders are pure functions of the aggregated counts, so the gating and the branch selection are
 * unit-testable without a Salesforce Connection — which matters, because a hint that named a Tool that
 * was not there, or that read `INDETERMINATE` as a denial, is a defect no live run would reliably catch.
 */

const METADATA_CONTEXT_TOOL = 'get_metadata_component_context';

/**
 * The one layer the grants above cannot subtract, said in the hint as well as in the conclusion's caveats.
 *
 * A muting permission set's rows are read like any other set's, so they are in the answer; what is not on
 * this Tool's read surface is the permission-set-group membership that makes them subtractive. Leaving that
 * out of the agent-facing sentence would leave the reader of a union free to over-read it, which is the same
 * failure the sentence above exists to prevent.
 */
const MUTING_NOTE =
  ' A muting permission set is a third: its rows are listed like any other set\'s, but this Tool reads the '
  + 'permission rows and not the group membership that makes one subtractive.';

export type FieldAccessHintFacts = Readonly<{
  /** True when the caller named `targetUserId`; false when the subject is the requesting user. */
  targetUserNamed: boolean;
  /**
   * True when this runtime supplied a route-scoped set of users, i.e. when a target user *could* have
   * been named. False means the request is on a runtime with no identity-route table behind it.
   */
  targetUserAllowed: boolean;
  /** Fields whose `visible` or `editable` is `INDETERMINATE`. */
  indeterminateFieldCount: number;
  /** Fields the subject cannot read at all. */
  notVisibleFieldCount: number;
  /** Fields the subject can read but cannot edit. */
  readOnlyFieldCount: number;
  /** Fields the subject can both read and edit. */
  editableFieldCount: number;
  /** The layer that made a conclusion indeterminate, named for the reader. */
  indeterminateLayer: string | null;
  /** True when fields were dropped to fit the response budget. */
  truncated: boolean;
}>;

export function fieldAccessHint(advertised: ReadonlySet<string>, facts: FieldAccessHintFacts): string {
  const nonPermissionCheck = advertised.has(METADATA_CONTEXT_TOOL)
    ? ` Field-level security is not the only gate: a validation rule, a field dependency or a read-only page `
      + `layout can refuse an edit this answer permits. Call ${METADATA_CONTEXT_TOOL} with metadataType `
      + `ValidationRule or Layout to check whether one exists for this object.${MUTING_NOTE}`
    : ' Field-level security is not the only gate: a validation rule, a field dependency or a read-only page '
      + 'layout can refuse an edit this answer permits, and none of them is readable by this Tool.'
      + MUTING_NOTE;
  if (facts.truncated) {
    return 'Fields were dropped to fit the server\'s response budget, so this answer does not cover every field that '
      + `was asked about. Re-run with fewer fieldApiNames to see the rest.${nonPermissionCheck}`;
  }
  if (facts.indeterminateFieldCount > 0) {
    const layer = facts.indeterminateLayer === null
      ? 'a layer this answer depends on'
      : facts.indeterminateLayer;
    return `${facts.indeterminateFieldCount} field(s) could not be decided because ${layer} could not be read. `
      + 'INDETERMINATE is a gap in the evidence and not a denial: nothing here says the subject lacks the '
      + `permission, and nothing says they hold it. Re-run after the layer is readable rather than treating `
      + `these as refused.${nonPermissionCheck}`;
  }
  if (facts.notVisibleFieldCount > 0 || facts.readOnlyFieldCount > 0) {
    const subject = facts.targetUserNamed ? 'the named user' : 'this user';
    const parts: string[] = [];
    if (facts.notVisibleFieldCount > 0) parts.push(`${facts.notVisibleFieldCount} field(s) ${subject} cannot read`);
    if (facts.readOnlyFieldCount > 0) parts.push(`${facts.readOnlyFieldCount} field(s) ${subject} can read but not edit`);
    return `${parts.join(', and ')}. The grants above name the permission sets and profiles the decision comes from, `
      + `so the change is made on those in Salesforce Setup — a profile-owned entry is under Profiles, the others `
      + `under Permission Sets. Remember that removing a grant here is only half the answer: this Tool reports what `
      + `the org is configured to allow, not what Salesforce will decide for a particular record.${nonPermissionCheck}`;
  }
  if (facts.editableFieldCount > 0) {
    const subject = facts.targetUserNamed ? 'The named user' : 'This user';
    const widen = !facts.targetUserNamed && facts.targetUserAllowed
      ? ' To explain another configured user\'s access to the same fields, call this Tool again with targetUserId.'
      : '';
    return `${subject} holds a read and edit grant on every field reported, so field-level security is not what would `
      + `refuse an edit.${nonPermissionCheck}${widen}`;
  }
  return 'No grant and no denial was found for any requested field, which means the permission tables carried no '
    + `row for them at all. Check the field API names against the object before drawing a conclusion.${nonPermissionCheck}`;
}
