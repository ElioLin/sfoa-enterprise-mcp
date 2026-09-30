/**
 * The pure half of `explain_field_access`: turning permission-table rows into a conclusion.
 *
 * It lives in the provider rather than in the host executor for the reason the debug-log set's parser
 * does: the host owns the Connection, the identity guard and the response budget, and everything that
 * can be decided from rows already in memory is decided here, where it can be unit-tested against
 * fixtures without a Salesforce org. "Profile denies but a permission set grants", "the object is not
 * readable so no field grant can apply" and "the layer that would have decided this was never read" are
 * all judgements about data, and a judgement about data that can only be tested live is a judgement that
 * ships untested.
 *
 * **Nothing here predicts Salesforce.** The unit of the answer is a *grant read from the permission
 * tables*, and the conclusion is the reading of that set — not a re-implementation of the platform's
 * decision procedure. Where the reading cannot be completed, the answer is `'INDETERMINATE'` and the
 * missing layer is named; ADR-0029 §3 makes that the contract rather than an option, because "the
 * evidence is missing" and "the permission is absent" are different facts and only one is actionable.
 *
 * The collections are `readonly`, which is this module's internal style; the host copies them into the
 * schema's mutable arrays at the one boundary where the wire contract lives, exactly as the Apex log
 * parser's output is copied.
 */

import {
  FIELD_ACCESS_INDETERMINATE,
  type FieldAccessParentType,
} from './schemas.js';

/** One `FieldPermissions` row, reduced to what the conclusion needs. */
export type FieldAccessGrantRow = Readonly<{
  parentId: string;
  permissionsRead: boolean;
  permissionsEdit: boolean;
}>;

/** One permission set the subject holds, as `PermissionSetAssignment` / `PermissionSet` reported it. */
export type FieldAccessParentFacts = Readonly<{
  id: string;
  /** `PermissionSet.Name` — the API name, and the stable key. */
  name: string | null;
  /** `PermissionSet.Label`, which this org translates. Reported, never matched on. */
  label: string | null;
  isOwnedByProfile: boolean;
  /** The owning profile's name, translated in this org for the same reason. */
  profileName: string | null;
}>;

/** One `ObjectPermissions` row for the subject's permission sets. */
export type FieldAccessObjectPermissionRow = Readonly<{
  parentId: string;
  permissionsRead: boolean | null;
  permissionsEdit: boolean | null;
  permissionsViewAllRecords: boolean | null;
}>;

export type FieldAccessObjectAccess = Readonly<{
  read: boolean | null;
  edit: boolean | null;
  viewAllRecords: boolean | null;
  unreadableParentIds: readonly string[];
}>;

/**
 * A conclusion as this module produces it. Structurally the schema's `conclusion`, with `readonly`
 * collections — the difference the host erases when it writes the response.
 */
export type FieldAccessConclusionView = Readonly<{
  visible: boolean | 'INDETERMINATE';
  editable: boolean | 'INDETERMINATE';
  sourceChain: readonly string[];
  conflicts: readonly string[];
  caveats: readonly string[];
}>;

/** An attributed grant, as this module produces it. */
export type FieldAccessGrantView = Readonly<{
  parentType: FieldAccessParentType;
  parentId: string;
  parentName: string | null;
  parentLabel: string | null;
  permissionsRead: boolean;
  permissionsEdit: boolean;
}>;

/**
 * Aggregates `ObjectPermissions` over the subject's permission sets.
 *
 * Three outcomes, not two. A row that grants read on any parent is a read; rows that were read and
 * grant nothing are a denial; and **no row at all is neither** — a permission set with no
 * `ObjectPermissions` row is a configuration this Tool did not read, and Salesforce materializes object
 * rows for profiles but not for every permission set. So the third outcome is `null`, the caller renders
 * it as `INDETERMINATE`, and the parents it is missing are named so the gap is checkable.
 *
 * `View All Records` is aggregated the same way and is reported because it is the fact that most often
 * explains a "why can this person see everything" question that field grants alone cannot.
 */
export function summarizeObjectAccess(
  parents: readonly FieldAccessParentFacts[],
  rows: readonly FieldAccessObjectPermissionRow[],
): FieldAccessObjectAccess {
  const byParent = new Map(rows.map((row) => [row.parentId, row]));
  const unreadableParentIds = parents.filter((parent) => !byParent.has(parent.id)).map((parent) => parent.id);
  return Object.freeze({
    read: aggregateFlag(rows.map((row) => row.permissionsRead)),
    edit: aggregateFlag(rows.map((row) => row.permissionsEdit)),
    viewAllRecords: aggregateFlag(rows.map((row) => row.permissionsViewAllRecords)),
    unreadableParentIds: Object.freeze(unreadableParentIds),
  });
}

/**
 * `true` when any row grants it, `false` when rows were read and none does, `null` when none was read.
 *
 * A `null` value inside a readable row set is treated as "not granted by this row" rather than as a gap:
 * the row exists, so the question was answerable for that parent; only the absence of every row is a gap.
 */
function aggregateFlag(values: readonly (boolean | null)[]): boolean | null {
  if (values.length === 0) return null;
  return values.some((value) => value === true);
}

/** Attributes `FieldPermissions` rows to their owning permission set or profile. */
export function toFieldAccessGrants(
  rows: readonly FieldAccessGrantRow[],
  parents: readonly FieldAccessParentFacts[],
): readonly FieldAccessGrantView[] {
  const byId = new Map(parents.map((parent) => [parent.id, parent]));
  return Object.freeze(rows.map((row) => {
    const parent = byId.get(row.parentId);
    return Object.freeze({
      // A profile's field permissions are stored on the permission set Salesforce creates for it, so a
      // profile grant is a permission-set row carrying `IsOwnedByProfile`. The distinction is kept in the
      // output because an administrator changes the two in different places in Setup.
      parentType: (parent?.isOwnedByProfile === true ? 'PROFILE' : 'PERMISSION_SET') as FieldAccessParentType,
      parentId: row.parentId,
      parentName: parent?.name ?? null,
      parentLabel: parent?.label ?? null,
      permissionsRead: row.permissionsRead,
      permissionsEdit: row.permissionsEdit,
    });
  }));
}

export type FieldAccessConclusionFacts = Readonly<{
  objectAccess: FieldAccessObjectAccess;
  /** The subject's grants for this one field, already attributed. */
  grants: readonly FieldAccessGrantView[];
  /**
   * True when the subject's permission-set list contains the profile-owned set every internal user holds.
   *
   * This is a property of the **parent list**, not of the grant rows, and the distinction is the whole
   * reason the field exists. A profile's field permissions live on the permission set Salesforce creates
   * for it, so that set is the baseline layer of every answer — and if the assignment read did not return
   * it, the baseline was never queried. Zero grant rows then mean "no row came back", which is not the
   * same fact as "the baseline was read and grants nothing", and only the second is a denial.
   */
  profileBaselineReadable: boolean;
  /** True when the subject's permission-set list was cut short to keep the query bounded. */
  permissionSetsTruncated: boolean;
  /** True when the object's `describe` did not carry this field at all. */
  fieldMissingFromDescribe: boolean;
}>;

/** The non-permission gates, stated once because every conclusion has to carry them. */
const NON_PERMISSION_CAVEAT =
  'Field-level security is one gate among several: a validation rule, a field dependency or a read-only page layout '
  + 'can refuse an edit these grants permit, and none of them is readable through this Tool\'s read surface.';

/**
 * The one layer the aggregation cannot subtract, stated for the same reason as the caveat above.
 *
 * Salesforce unions a profile's field permissions with the permission sets a user holds, with a single
 * exception: a **muting** permission set inside a permission set group removes permissions its group's
 * constituents grant. Every muting set is itself a `PermissionSet` assigned through
 * `PermissionSetAssignment`, so its rows *are* read and *are* in `grants` — what is not on this read
 * surface is the group membership that makes those rows subtractive. So the union this module computes can
 * over-state a grant a group mutes, and that is a fact about the reading rather than about the org.
 *
 * It is reported on every conclusion rather than only on a positive one: a caveat a reader has to know to
 * look for is a caveat that is not doing its job, and the answer is read as a whole.
 */
const MUTING_CAVEAT =
  'Every permission set the subject holds is reported, including any that mute permissions. This Tool reads the '
  + 'permission rows and not the permission-set-group membership that makes a muting set subtractive, so a grant '
  + 'listed here can be one a group mutes.';

/**
 * Names the layer that leaves a conclusion undecided, or `null` when every layer was read.
 *
 * Exported because two readers need the same answer in two different shapes: the caveat this module
 * writes for an undecided field, and the `hint` the Tool returns so the next step can name what to fix.
 * Deriving it twice would let the two drift, and the drift would show up as a hint that points at the
 * wrong layer — the failure mode the T2 rule about hints exists to prevent.
 *
 * The priority order is the builder's own order of operations, so the layer named here is always the one
 * that actually stopped the reading rather than a later one that never got reached.
 */
export function indeterminateLayerName(facts: FieldAccessConclusionFacts): string | null {
  if (facts.permissionSetsTruncated) {
    return 'the subject\'s permission-set list was cut short before it could be read in full';
  }
  if (facts.objectAccess.read === null) {
    return 'object-level grants could not be read for any of the subject\'s permission sets';
  }
  if (!facts.grants.some((grant) => grant.permissionsRead || grant.permissionsEdit) && !facts.profileBaselineReadable) {
    return 'the subject\'s permission-set list did not contain the profile-owned set every internal user holds, so the '
      + 'baseline layer was never queried';
  }
  return null;
}

/**
 * Reads a conclusion off the aggregated facts.
 *
 * The order is the platform's own order of operations, and it is the order because a field grant cannot
 * take effect on an object the subject cannot reach: object visibility is decided first, and when it is
 * unreadable nothing below it can be decided either.
 */
export function buildFieldAccessConclusion(facts: FieldAccessConclusionFacts): FieldAccessConclusionView {
  const sourceChain: string[] = [];
  const conflicts: string[] = [];
  const caveats: string[] = [NON_PERMISSION_CAVEAT, MUTING_CAVEAT];
  const gapLayer = indeterminateLayerName(facts);

  if (facts.permissionSetsTruncated) {
    sourceChain.push('subject-permission-sets: TRUNCATED');
    return indeterminate(sourceChain, conflicts, caveats, gapLayer ?? 'the subject\'s permission-set list');
  }

  sourceChain.push(describeObjectLayer(facts.objectAccess));

  if (facts.objectAccess.read === null) {
    return indeterminate(sourceChain, conflicts, caveats, gapLayer ?? 'object-level grants');
  }
  if (facts.objectAccess.read === false) {
    conflicts.push('The subject has no object-level read grant, so no field-level grant on this object can take effect.');
    caveats.push('Object access is decided before field access, which is why a field grant that is present in the table '
      + 'above does not make the field visible to this subject.');
    return Object.freeze({
      visible: false,
      editable: false,
      sourceChain: Object.freeze(sourceChain),
      conflicts: Object.freeze(conflicts),
      caveats: Object.freeze(caveats),
    });
  }

  const readGrant = facts.grants.some((grant) => grant.permissionsRead);
  const editGrant = facts.grants.some((grant) => grant.permissionsEdit);
  sourceChain.push(describeGrantLayer(facts.grants, readGrant, editGrant, facts.profileBaselineReadable));
  collectGrantConflicts(facts.grants, conflicts);
  if (editGrant && !readGrant) {
    // Reported as the rows are, with the inconsistency named: an org whose tables say this is an org whose
    // tables say this, and this Tool's job is to report the tables rather than to tidy them.
    conflicts.push('A grant carries edit without read for this field, which Salesforce does not normally configure; '
      + 'the rows above are reported as they were read.');
  }

  if (facts.fieldMissingFromDescribe) {
    caveats.push('The object\'s describe did not carry this field name, so it may not exist on this object — check the '
      + 'field API name before acting on the grants above.');
  }
  if (facts.objectAccess.unreadableParentIds.length > 0) {
    caveats.push(`No object-level row was readable for ${facts.objectAccess.unreadableParentIds.length} of the subject's `
      + 'permission sets, so a denial recorded here rests on the rows that were read.');
  }
  if (facts.objectAccess.viewAllRecords === true) {
    caveats.push('The subject holds View All Records on this object, so reach that would otherwise be limited by sharing '
      + 'rules is not limited for them.');
  }

  // The profile layer is the baseline every user has, so when the subject's permission-set list does not
  // carry a profile-owned set, the field's rows for that layer were never asked for — and absence cannot be
  // read as a denial. This is the single most important place the `INDETERMINATE` state exists for: the
  // field is not necessarily refused, it is simply not evidenced.
  if (!readGrant && !editGrant && !facts.profileBaselineReadable) {
    return indeterminate(sourceChain, conflicts, caveats, gapLayer ?? 'the subject\'s profile baseline');
  }

  return Object.freeze({
    visible: readGrant,
    editable: editGrant,
    sourceChain: Object.freeze(sourceChain),
    conflicts: Object.freeze(conflicts),
    caveats: Object.freeze(caveats),
  });
}

function indeterminate(
  sourceChain: readonly string[],
  conflicts: readonly string[],
  caveats: readonly string[],
  layer: string,
): FieldAccessConclusionView {
  return Object.freeze({
    visible: FIELD_ACCESS_INDETERMINATE,
    editable: FIELD_ACCESS_INDETERMINATE,
    sourceChain: Object.freeze([...sourceChain]),
    conflicts: Object.freeze([...conflicts]),
    caveats: Object.freeze([
      `This is a gap in the evidence, not a denial: ${layer}, so nothing here establishes that the subject lacks the `
      + 'permission or that they hold it.',
      ...caveats,
    ]),
  });
}

function describeObjectLayer(objectAccess: FieldAccessObjectAccess): string {
  if (objectAccess.read === null) return 'object-visibility: unreadable';
  const viewAll = objectAccess.viewAllRecords === true ? ', viewAllRecords=true' : '';
  return `object-visibility: read=${String(objectAccess.read)} edit=${String(objectAccess.edit)}${viewAll}`;
}

function describeGrantLayer(
  grants: readonly FieldAccessGrantView[],
  readGrant: boolean,
  editGrant: boolean,
  profileBaselineReadable: boolean,
): string {
  const profile = grants.filter((grant) => grant.parentType === 'PROFILE').length;
  const standalone = grants.length - profile;
  return `field-grants: ${grants.length} row(s) over ${profile} profile-owned and ${standalone} standalone permission `
    + `set(s), read=${String(readGrant)} edit=${String(editGrant)}, `
    + `profileBaselineReadable=${String(profileBaselineReadable)}`;
}

/**
 * Records where two layers disagree about the same field.
 *
 * These are not errors. Salesforce unions a profile's field permissions with every permission set the
 * user holds, so "the profile does not grant edit but a permission set does" is an ordinary, correct
 * configuration — and it is exactly the configuration a reader gets wrong when they look at the profile
 * in Setup and stop. Recording the disagreement is what makes the union visible.
 */
function collectGrantConflicts(grants: readonly FieldAccessGrantView[], conflicts: string[]): void {
  const profiles = grants.filter((grant) => grant.parentType === 'PROFILE');
  const standalone = grants.filter((grant) => grant.parentType === 'PERMISSION_SET');
  if (profiles.length === 0 || standalone.length === 0) return;
  const profileEdits = profiles.some((grant) => grant.permissionsEdit);
  const standaloneEdits = standalone.some((grant) => grant.permissionsEdit);
  if (!profileEdits && standaloneEdits) {
    conflicts.push('No profile-owned grant carries edit, but a standalone permission set does — the profile alone would '
      + 'read as a refusal.');
  }
  if (profileEdits && !standaloneEdits) {
    conflicts.push('A profile-owned grant carries edit and no standalone permission set does; removing the profile grant '
      + 'would therefore be the change that takes effect.');
  }
  const profileReads = profiles.some((grant) => grant.permissionsRead);
  const standaloneReads = standalone.some((grant) => grant.permissionsRead);
  if (!profileReads && standaloneReads) {
    conflicts.push('No profile-owned grant carries read, but a standalone permission set does — the profile alone would '
      + 'read as a denial of visibility.');
  }
}
