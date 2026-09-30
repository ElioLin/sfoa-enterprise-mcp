import assert from 'node:assert/strict';
import test from 'node:test';
import { ReleaseState, Toolset, type OrgService, type Services } from '@salesforce/mcp-provider-api';
import {
  CONTEXT_ERROR_CODES,
  ContextRuntimeError,
  FIELD_ACCESS_INDETERMINATE,
  FIELD_ACCESS_PARENT_TYPES,
  SFOA_CONTEXT_TOOL_NAMES,
  SFOA_CONTEXT_TOOL_ROLES,
  SfoaContextMcpProvider,
  buildFieldAccessConclusion,
  explainFieldAccessInputSchema,
  explainFieldAccessOutputSchema,
  fieldAccessHint,
  indeterminateLayerName,
  summarizeObjectAccess,
  toFieldAccessGrants,
  type ExplainFieldAccessOutput,
  type FieldAccessConclusionFacts,
  type FieldAccessExplanation,
  type FieldAccessGrantRow,
  type FieldAccessHintFacts,
  type FieldAccessObjectPermissionRow,
  type FieldAccessParentFacts,
} from '../index.js';
import { ExplainFieldAccessMcpTool, describeState, renderExplainFieldAccessText } from '../tools/explain-field-access.js';

/**
 * T3's `explain_field_access`, provider side.
 *
 * Everything the provider owns here is pure — the input and output schemas, the conclusion builder, the
 * hint — so none of it needs a Connection. The identity guard, the query shapes, the `targetUserId`
 * boundary and the byte budget belong to the host and are covered in
 * `packages/sfoa-mcp-server/src/test/field-access-context-executor.test.ts`.
 *
 * The assertions are written against the failures this Tool is most likely to ship with, each of which is
 * a plausible implementation rather than an exotic one:
 *
 *   - reading `'INDETERMINATE'` as a denial, or as a grant — it is a truthy string;
 *   - treating "the layer was never read" as "no permission is granted", which ADR-0029 §3 forbids;
 *   - letting `describe`, which answers for the DIAGNOSTIC identity, decide a named user's conclusion;
 *   - a hint that names a Tool the session does not advertise.
 */

// ---------------------------------------------------------------------------------------------
// Input: bounds, dedupe, and the boundary that keeps this from being a reconnaissance surface
// ---------------------------------------------------------------------------------------------

test('the field access input bounds the field list on both ends and accepts the object and field grammar', () => {
  assert.equal(explainFieldAccessInputSchema.safeParse({ objectApiName: 'Account', fieldApiNames: ['Name'] }).success, true);
  assert.equal(explainFieldAccessInputSchema.safeParse({
    objectApiName: 'Value_Bill__c',
    fieldApiNames: ['Amount__c', 'OwnerId'],
  }).success, true);
  assert.equal(explainFieldAccessInputSchema.safeParse({ objectApiName: 'Account', fieldApiNames: [] }).success, false);
  assert.equal(
    explainFieldAccessInputSchema
      .safeParse({ objectApiName: 'Account', fieldApiNames: Array.from({ length: 11 }, (_, i) => `F${String(i)}__c`) })
      .success,
    false,
    'eleven fields is over the bound: fields × grants is the response size, and the bound is what keeps it a product',
  );
  assert.equal(explainFieldAccessInputSchema.safeParse({ objectApiName: 'Account' }).success, false);
});

test('the field access input refuses a relationship path as a field name and a non-API-name object', () => {
  // `Owner.Name` is a different thing from a field and would address a different `FieldPermissions` row,
  // so it is refused at the boundary rather than quietly returning nothing.
  assert.equal(explainFieldAccessInputSchema.safeParse({ objectApiName: 'Account', fieldApiNames: ['Owner.Name'] }).success, false);
  assert.equal(explainFieldAccessInputSchema.safeParse({ objectApiName: 'Account', fieldApiNames: ['Account.Name'] }).success, false);
  assert.equal(explainFieldAccessInputSchema.safeParse({ objectApiName: 'Account; DROP', fieldApiNames: ['Name'] }).success, false);
  assert.equal(explainFieldAccessInputSchema.safeParse({ objectApiName: 'Account', fieldApiNames: [''] }).success, false);
});

test('the field access input deduplicates repeated field names rather than double-counting them', () => {
  const parsed = explainFieldAccessInputSchema.parse({
    objectApiName: 'Account',
    fieldApiNames: ['Name', 'Name', 'OwnerId', 'name'],
  });
  // Deduplication is on the literal, so `name` survives beside `Name`. That is deliberate: collapsing the
  // two here would answer a question about one field while appearing to answer one about two spellings, and
  // the host resolves both to the same row set anyway.
  assert.deepEqual(parsed.fieldApiNames, ['Name', 'OwnerId', 'name']);
});

test('the field access input refuses an identity of the caller\'s choosing, including a raw Salesforce Id', () => {
  const base = { objectApiName: 'Account', fieldApiNames: ['Name'] } as const;
  // `targetUserId` is the one identity-shaped parameter this Tool has, and it is an Id rather than a
  // username on purpose: a username would be free text a caller could shape, and the Id grammar is what
  // lets the host scope the subject query to the deployment's identity-route table.
  assert.equal(explainFieldAccessInputSchema.safeParse({ ...base, targetUserId: '005000000000001AAA' }).success, true);
  assert.equal(explainFieldAccessInputSchema.safeParse({ ...base, targetUserId: '005000000000001' }).success, true);
  assert.equal(explainFieldAccessInputSchema.safeParse({ ...base, targetUserId: 'user@example.test' }).success, false);
  assert.equal(explainFieldAccessInputSchema.safeParse({ ...base, targetUserId: '005000000000001AAAA' }).success, false);
  for (const forged of [
    { username: 'forged@example.test' },
    { usernameOrAlias: 'forged@example.test' },
    { diagnosticUsername: 'forged@example.test' },
    { salesforceUsername: 'forged@example.test' },
    { targetUsername: 'forged@example.test' },
    { connectionRole: 'DIAGNOSTIC' },
    { platformUserId: 'p2-user-a' },
    { credentialProfile: 'sfoa-shared-jwt' },
    { useToolingApi: true },
    { soql: 'SELECT Id FROM Account' },
  ]) {
    assert.equal(explainFieldAccessInputSchema.safeParse({ ...base, ...forged }).success, false, JSON.stringify(forged));
  }
});

test('the record-type switch takes a boolean only, and applies its default in the executor rather than the schema', () => {
  const omitted = explainFieldAccessInputSchema.parse({ objectApiName: 'Account', fieldApiNames: ['Name'] });
  assert.equal(omitted.includeRecordTypeContext, undefined);
  assert.equal(
    explainFieldAccessInputSchema.safeParse({
      objectApiName: 'Account', fieldApiNames: ['Name'], includeRecordTypeContext: 'yes',
    }).success,
    false,
  );
});

// ---------------------------------------------------------------------------------------------
// Grants: attribution across the profile and permission-set layers
// ---------------------------------------------------------------------------------------------

const PROFILE_SET: FieldAccessParentFacts = Object.freeze({
  id: '0PS000000000001AAA', name: 'System_Administrator', label: '系统管理员',
  isOwnedByProfile: true, profileName: '系统管理员',
});
const STANDALONE_SET: FieldAccessParentFacts = Object.freeze({
  id: '0PS000000000002AAA', name: 'SFOA_Field_Editor', label: 'Field Editor',
  isOwnedByProfile: false, profileName: null,
});

function grantRow(parentId: string, permissionsRead: boolean, permissionsEdit: boolean): FieldAccessGrantRow {
  return Object.freeze({ parentId, permissionsRead, permissionsEdit });
}

function objectRow(
  parentId: string,
  read: boolean,
  edit: boolean,
  viewAllRecords: boolean,
): FieldAccessObjectPermissionRow {
  return Object.freeze({ parentId, permissionsRead: read, permissionsEdit: edit, permissionsViewAllRecords: viewAllRecords });
}

test('a profile-owned permission set is attributed to the profile, and a standalone one to the permission set', () => {
  const grants = toFieldAccessGrants(
    [grantRow(PROFILE_SET.id, true, false), grantRow(STANDALONE_SET.id, true, true)],
    [PROFILE_SET, STANDALONE_SET],
  );
  assert.deepEqual(grants.map((entry) => entry.parentType), ['PROFILE', 'PERMISSION_SET']);
  assert.deepEqual(grants.map((entry) => entry.parentName), ['System_Administrator', 'SFOA_Field_Editor']);
  // The label this org translates is carried as data and never matched on — the same discipline the probe
  // recorded for `ApexLog.Status` and `Profile.Name`.
  assert.equal(grants[0]?.parentLabel, '系统管理员');
  assert.equal(grants[1]?.parentLabel, 'Field Editor');
  assert.deepEqual(FIELD_ACCESS_PARENT_TYPES, ['PERMISSION_SET', 'PROFILE']);
});

test('a grant with no matching parent keeps the row and reports the parent as unknown rather than dropping it', () => {
  // Dropping an unattributable row would turn a real grant into an absent one — the silent-empty failure in
  // its most damaging form, because the answer would then read as "nobody granted this".
  const grants = toFieldAccessGrants([grantRow('0PS000000000009AAA', true, false)], [PROFILE_SET]);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]?.parentName, null);
  assert.equal(grants[0]?.parentLabel, null);
  // With no parent facts there is no `IsOwnedByProfile`, so it cannot be shown as a profile grant.
  assert.equal(grants[0]?.parentType, 'PERMISSION_SET');
});

// ---------------------------------------------------------------------------------------------
// Object access: three outcomes, because "no row was read" is not "no grant"
// ---------------------------------------------------------------------------------------------

test('object access is granted when any parent grants it, denied when rows were read and none does', () => {
  const access = summarizeObjectAccess([PROFILE_SET, STANDALONE_SET], [
    objectRow(PROFILE_SET.id, true, true, false),
    objectRow(STANDALONE_SET.id, false, false, false),
  ]);
  assert.equal(access.read, true);
  assert.equal(access.edit, true);
  assert.equal(access.viewAllRecords, false);
  assert.deepEqual([...access.unreadableParentIds], []);
});

test('object access is null — not false — when no row was read for any permission set', () => {
  const access = summarizeObjectAccess([PROFILE_SET, STANDALONE_SET], []);
  assert.equal(access.read, null);
  assert.equal(access.edit, null);
  assert.equal(access.viewAllRecords, null);
  // Zero and false are different claims and only one of them is a measurement: a permission set with no
  // `ObjectPermissions` row is a configuration this Tool did not read.
  assert.notEqual(access.read, false);
  assert.deepEqual([...access.unreadableParentIds], [PROFILE_SET.id, STANDALONE_SET.id]);
});

test('a permission set with no object row is named even when another parent answers the question', () => {
  const access = summarizeObjectAccess([PROFILE_SET, STANDALONE_SET], [objectRow(PROFILE_SET.id, true, false, false)]);
  assert.equal(access.read, true);
  // The subject can read the object and the answer still says which layer it could not check, so a field
  // denial resting on the readable rows alone does not look like one resting on all of them.
  assert.deepEqual([...access.unreadableParentIds], [STANDALONE_SET.id]);
});

test('a readable row that grants nothing is a denial rather than a gap, because the row was read', () => {
  // The distinction `aggregateFlag`'s `null` return carries: no rows at all is a gap; a row that answers
  // "false" is an answer. Getting these two confused is how `INDETERMINATE` turns back into a denial.
  const access = summarizeObjectAccess([PROFILE_SET], [objectRow(PROFILE_SET.id, false, false, false)]);
  assert.equal(access.read, false);
  assert.deepEqual([...access.unreadableParentIds], []);
});

// ---------------------------------------------------------------------------------------------
// Conclusions: the three states, in the order the platform decides them
// ---------------------------------------------------------------------------------------------

function facts(overrides: Partial<FieldAccessConclusionFacts> = {}): FieldAccessConclusionFacts {
  return Object.freeze({
    objectAccess: summarizeObjectAccess([PROFILE_SET], [objectRow(PROFILE_SET.id, true, true, false)]),
    grants: toFieldAccessGrants([grantRow(PROFILE_SET.id, true, true)], [PROFILE_SET]),
    profileBaselineReadable: true,
    permissionSetsTruncated: false,
    fieldMissingFromDescribe: false,
    ...overrides,
  });
}

test('a readable profile grant that carries read and edit concludes granted twice over', () => {
  const conclusion = buildFieldAccessConclusion(facts());
  assert.equal(conclusion.visible, true);
  assert.equal(conclusion.editable, true);
  assert.deepEqual([...conclusion.conflicts], []);
  assert.match(conclusion.sourceChain.join(' '), /object-visibility: read=true edit=true/u);
  assert.match(conclusion.sourceChain.join(' '), /profileBaselineReadable=true/u);
  // Every conclusion carries the caveat that field-level security is not the only gate, because the
  // interesting number is the one this Tool never sees.
  assert.match(conclusion.caveats.join(' '), /a validation rule, a field dependency or a read-only page layout/u);
});

test('a muting permission set is declared as the one layer the union cannot subtract', () => {
  // A muting set is itself a `PermissionSet` assigned through `PermissionSetAssignment`, so its rows are
  // read and listed like any other set's — the aggregation cannot tell that they are subtractive, because
  // the permission-set-group membership that makes them so is not on this Tool's read surface. That is a
  // property of the reading and not of the org, so the answer says it rather than leaving a union to be
  // over-read. It rides on the same conclusion the grants do: a caveat a reader has to know to look for is
  // not doing its job.
  const muted = Object.freeze({
    ...STANDALONE_SET,
    id: '0PS000000000003AAA',
    name: 'SFOA_Muting_Set',
  });
  const conclusion = buildFieldAccessConclusion(facts({
    grants: toFieldAccessGrants([
      grantRow(PROFILE_SET.id, true, true),
      // The muting set's own rows, present and reported exactly as they were read.
      grantRow(muted.id, false, false),
    ], [PROFILE_SET, muted]),
  }));
  assert.equal(conclusion.visible, true);
  assert.equal(conclusion.editable, true);
  assert.match(conclusion.caveats.join(' '), /including any that mute permissions/u);
  assert.match(conclusion.caveats.join(' '), /not the permission-set-group membership that makes a muting set subtractive/u);
  // The caveat is on every conclusion, so it cannot be missed by reading only a positive one.
  assert.match(
    buildFieldAccessConclusion(facts({ objectAccess: summarizeObjectAccess([PROFILE_SET], []) })).caveats.join(' '),
    /including any that mute permissions/u,
  );
});

test('a profile grant that carries read alone concludes visible but not editable', () => {
  const conclusion = buildFieldAccessConclusion(facts({
    grants: toFieldAccessGrants([grantRow(PROFILE_SET.id, true, false)], [PROFILE_SET]),
  }));
  assert.equal(conclusion.visible, true);
  assert.equal(conclusion.editable, false);
});

test('a profile that denies is overridden by a standalone permission set that grants, and the disagreement is named', () => {
  // The configuration this Tool exists to explain: an administrator looks at the profile in Setup, sees no
  // edit, and stops — while a permission set grants it. Salesforce unions the two, so the answer is
  // "editable" and the disagreement is the actionable half of it.
  const conclusion = buildFieldAccessConclusion(facts({
    grants: toFieldAccessGrants(
      [grantRow(PROFILE_SET.id, true, false), grantRow(STANDALONE_SET.id, true, true)],
      [PROFILE_SET, STANDALONE_SET],
    ),
  }));
  assert.equal(conclusion.visible, true);
  assert.equal(conclusion.editable, true);
  assert.match(conclusion.conflicts.join(' '), /No profile-owned grant carries edit, but a standalone permission set does/u);
});

test('a standalone permission set that denies is named when the profile is the grant that takes effect', () => {
  const conclusion = buildFieldAccessConclusion(facts({
    grants: toFieldAccessGrants(
      [grantRow(PROFILE_SET.id, true, true), grantRow(STANDALONE_SET.id, false, false)],
      [PROFILE_SET, STANDALONE_SET],
    ),
  }));
  assert.equal(conclusion.editable, true);
  assert.match(conclusion.conflicts.join(' '), /removing the profile grant would therefore be the change that takes effect/u);
});

test('an object-level denial concludes both false, and says why the field grant above it does not matter', () => {
  const conclusion = buildFieldAccessConclusion(facts({
    objectAccess: summarizeObjectAccess([PROFILE_SET], [objectRow(PROFILE_SET.id, false, false, false)]),
    // The field row is present and grants both — the configuration that produces a wrong answer if object
    // access is not decided first.
    grants: toFieldAccessGrants([grantRow(PROFILE_SET.id, true, true)], [PROFILE_SET]),
  }));
  assert.equal(conclusion.visible, false);
  assert.equal(conclusion.editable, false);
  assert.match(conclusion.conflicts.join(' '), /no object-level read grant/u);
  assert.match(conclusion.caveats.join(' '), /Object access is decided before field access/u);
});

test('an unreadable object layer is INDETERMINATE and names the layer rather than denying', () => {
  const conclusion = buildFieldAccessConclusion(facts({ objectAccess: summarizeObjectAccess([PROFILE_SET], []) }));
  assert.equal(conclusion.visible, FIELD_ACCESS_INDETERMINATE);
  assert.equal(conclusion.editable, FIELD_ACCESS_INDETERMINATE);
  assert.match(conclusion.caveats.join(' '), /This is a gap in the evidence, not a denial/u);
  assert.match(conclusion.caveats.join(' '), /object-level grants could not be read/u);
  // The whole point of the third state: `false` would be a claim the evidence does not support.
  assert.notEqual(conclusion.visible, false);
});

test('no grant rows and no profile-owned parent is INDETERMINATE, because the baseline layer was never queried', () => {
  const conclusion = buildFieldAccessConclusion(facts({
    grants: Object.freeze([]),
    // The assignment read returned only a standalone set — the subject's profile-owned set is missing, so
    // the layer every user's answer rests on was never in the query at all.
    profileBaselineReadable: false,
    objectAccess: summarizeObjectAccess([STANDALONE_SET], [objectRow(STANDALONE_SET.id, true, true, false)]),
  }));
  assert.equal(conclusion.visible, FIELD_ACCESS_INDETERMINATE);
  assert.match(conclusion.caveats.join(' '), /baseline layer was never queried/u);
});

test('no grant rows with the profile baseline read is a real denial, not a gap', () => {
  // The mirror of the case above, and the reason the two are separate facts rather than one: the
  // profile-owned set was in the list, the query named it, and no row came back. That is a reading —
  // nobody granted the field.
  const denial = facts({ grants: Object.freeze([]) });
  const conclusion = buildFieldAccessConclusion(denial);
  assert.equal(conclusion.visible, false);
  assert.equal(conclusion.editable, false);
  assert.equal(indeterminateLayerName(denial), null, 'a denial is not a gap, and the hint branches on this');
});

test('a truncated permission-set list makes every field INDETERMINATE, because the grant set is a subset', () => {
  const conclusion = buildFieldAccessConclusion(facts({ permissionSetsTruncated: true }));
  assert.equal(conclusion.visible, FIELD_ACCESS_INDETERMINATE);
  assert.equal(conclusion.editable, FIELD_ACCESS_INDETERMINATE);
  assert.match(conclusion.sourceChain.join(' '), /TRUNCATED/u);
});

test('edit without read is reported as the rows are, with the inconsistency named', () => {
  const conclusion = buildFieldAccessConclusion(facts({
    grants: toFieldAccessGrants([grantRow(PROFILE_SET.id, false, true)], [PROFILE_SET]),
  }));
  assert.equal(conclusion.visible, false);
  assert.equal(conclusion.editable, true);
  assert.match(conclusion.conflicts.join(' '), /edit without read/u);
});

test('a field missing from describe is a caveat about the name, never a change to the conclusion', () => {
  const conclusion = buildFieldAccessConclusion(facts({ fieldMissingFromDescribe: true }));
  assert.equal(conclusion.visible, true);
  assert.match(conclusion.caveats.join(' '), /describe did not carry this field name/u);
});

test('View All Records is reported as its own caveat, because a field grant cannot express it', () => {
  const conclusion = buildFieldAccessConclusion(facts({
    objectAccess: summarizeObjectAccess([PROFILE_SET], [objectRow(PROFILE_SET.id, true, true, true)]),
  }));
  assert.match(conclusion.caveats.join(' '), /View All Records/u);
});

test('a permission set with no object row is named in the conclusion that rests on the rows that were read', () => {
  const conclusion = buildFieldAccessConclusion(facts({
    objectAccess: summarizeObjectAccess([PROFILE_SET, STANDALONE_SET], [objectRow(PROFILE_SET.id, true, true, false)]),
  }));
  assert.equal(conclusion.visible, true);
  assert.match(conclusion.caveats.join(' '), /No object-level row was readable for 1 of the subject's permission sets/u);
});

test('the named gap layer matches the conclusion that was produced, in every gap case', () => {
  const truncated = facts({ permissionSetsTruncated: true });
  const unreadableObject = facts({ objectAccess: summarizeObjectAccess([PROFILE_SET], []) });
  const missingBaseline = facts({
    grants: Object.freeze([]),
    profileBaselineReadable: false,
    objectAccess: summarizeObjectAccess([STANDALONE_SET], [objectRow(STANDALONE_SET.id, true, true, false)]),
  });
  assert.match(indeterminateLayerName(truncated) ?? '', /cut short/u);
  assert.match(indeterminateLayerName(unreadableObject) ?? '', /object-level grants could not be read/u);
  assert.match(indeterminateLayerName(missingBaseline) ?? '', /baseline layer was never queried/u);
  // Truncation outranks the object layer even when all three could apply, because it is the gap the reader
  // has to fix first — a partial permission-set list makes every layer below it partial too.
  assert.equal(
    indeterminateLayerName(facts({ permissionSetsTruncated: true, objectAccess: summarizeObjectAccess([PROFILE_SET], []) })),
    indeterminateLayerName(truncated),
  );
  // And a decided field names no layer, so the hint does not send a reader chasing a gap that is not there.
  assert.equal(indeterminateLayerName(facts()), null);
});

// ---------------------------------------------------------------------------------------------
// The truthiness trap: `'INDETERMINATE'` is a truthy string
// ---------------------------------------------------------------------------------------------

test('describeState renders all three states as words, and never reads INDETERMINATE as a grant', () => {
  assert.equal(describeState(true), 'granted');
  assert.equal(describeState(false), 'not granted');
  assert.equal(describeState(FIELD_ACCESS_INDETERMINATE), 'INDETERMINATE (layer not readable)');
  // The trap, asserted directly: this is what `if (value)` would have done.
  assert.equal(Boolean(FIELD_ACCESS_INDETERMINATE), true);
  assert.notEqual(describeState(FIELD_ACCESS_INDETERMINATE), 'granted');
  assert.notEqual(describeState(FIELD_ACCESS_INDETERMINATE), 'not granted');
});

test('the text renderer prints a gap as a gap, in the field block it belongs to', () => {
  const output = outputFixture({
    objects: [
      explanation('Name', true, true),
      explanation('Secret__c', FIELD_ACCESS_INDETERMINATE, FIELD_ACCESS_INDETERMINATE),
      explanation('Locked__c', false, false),
    ],
  });
  const blocks = renderExplainFieldAccessText(output).split('Field: ').slice(1);

  const secret = blocks.find((block) => block.startsWith('Secret__c'));
  assert.ok(secret, 'the renderer must emit one block per field');
  assert.match(secret, /conclusion: visible=INDETERMINATE \(layer not readable\) editable=INDETERMINATE \(layer not readable\)/u);
  assert.equal(secret.includes('visible=granted'), false, 'a truthy INDETERMINATE must not render as a grant');

  const locked = blocks.find((block) => block.startsWith('Locked__c'));
  assert.ok(locked);
  assert.match(locked, /conclusion: visible=not granted editable=not granted/u);

  const open = blocks.find((block) => block.startsWith('Name\n'));
  assert.ok(open);
  assert.match(open, /conclusion: visible=granted editable=granted/u);
});

// ---------------------------------------------------------------------------------------------
// The hint: gated on the advertised set, and branched on the three states
// ---------------------------------------------------------------------------------------------

test('the hint names the metadata Tool only when the session advertises it', () => {
  const gated = fieldAccessHint(new Set(['explain_field_access']), hintFacts());
  const open = fieldAccessHint(new Set(['explain_field_access', 'get_metadata_component_context']), hintFacts());
  assert.equal(gated.includes('get_metadata_component_context'), false);
  assert.equal(open.includes('get_metadata_component_context'), true);
  // Both say the same thing about what the answer does not establish; only the remedy differs, because only
  // one of them can actually be followed in that session.
  assert.match(gated, /a validation rule, a field dependency or a read-only page layout/u);
  assert.match(open, /ValidationRule or Layout/u);
});

test('the hint tells a reader that INDETERMINATE is a gap and not a denial', () => {
  const hint = fieldAccessHint(new Set(), hintFacts({
    indeterminateFieldCount: 3,
    indeterminateLayer: 'object-level grants could not be read for any of the subject\'s permission sets',
  }));
  assert.match(hint, /3 field\(s\) could not be decided/u);
  assert.match(hint, /INDETERMINATE is a gap in the evidence and not a denial/u);
  assert.match(hint, /object-level grants could not be read/u);
  // It must not borrow the denial branch's phrasing: "cannot read" is how a settled denial is described,
  // and using it here would undo the distinction the third state exists to make.
  assert.equal(hint.includes('cannot read'), false);
});

test('the hint offers a widened query only when a target user could actually be named', () => {
  const allowed = fieldAccessHint(new Set(), hintFacts({ targetUserAllowed: true }));
  const notAllowed = fieldAccessHint(new Set(), hintFacts({ targetUserAllowed: false }));
  assert.match(allowed, /call this Tool again with targetUserId/u);
  // On a runtime with no identity-route table behind it the suggestion would be a dead end, so it is not made.
  assert.equal(notAllowed.includes('targetUserId'), false);
  // And it is never offered to a caller who already named one.
  assert.equal(fieldAccessHint(new Set(), hintFacts({ targetUserNamed: true, targetUserAllowed: true })).includes('targetUserId'), false);
});

test('the hint says which Setup surface to change, and names the subject it is talking about', () => {
  const denied = fieldAccessHint(new Set(), hintFacts({ notVisibleFieldCount: 1, readOnlyFieldCount: 2 }));
  assert.match(denied, /1 field\(s\) this user cannot read, and 2 field\(s\) this user can read but not edit/u);
  assert.match(denied, /a profile-owned entry is under Profiles, the others under Permission Sets/u);

  const named = fieldAccessHint(new Set(), hintFacts({ targetUserNamed: true, notVisibleFieldCount: 1 }));
  assert.match(named, /the named user/u);
});

test('a budget cut outranks every other branch, because every other sentence would describe an incomplete set', () => {
  const truncated = fieldAccessHint(new Set(), hintFacts({
    truncated: true, indeterminateFieldCount: 4, notVisibleFieldCount: 4,
  }));
  assert.match(truncated, /dropped to fit the server's response budget/u);
  assert.equal(truncated.includes('could not be decided'), false);
  assert.equal(truncated.includes('cannot read'), false);
});

test('a field list with no rows at all says so rather than implying a denial', () => {
  const hint = fieldAccessHint(new Set(), hintFacts({ editableFieldCount: 0, targetUserAllowed: false }));
  assert.match(hint, /No grant and no denial was found/u);
  assert.match(hint, /Check the field API names/u);
});

test('every branch of the hint carries the muting limitation and still fits the schema\'s bound', () => {
  // The union the answer reports cannot subtract a muting permission set, and that is the one thing a
  // reader is most likely to over-read a grant from — so it is on all of them, not only on the branch
  // where a grant was found. The length assertion is not decoration: `hint` is capped at 1000 characters
  // by the output schema, and the longest branch is the indeterminate one whose layer name is a sentence.
  const branches: readonly string[] = [
    fieldAccessHint(new Set(), hintFacts({ truncated: true })),
    fieldAccessHint(new Set(), hintFacts({ indeterminateFieldCount: 1, indeterminateLayer: null })),
    // The longest layer string the builder can produce, with the Tool-naming branch selected.
    fieldAccessHint(new Set(['get_metadata_component_context']), hintFacts({
      indeterminateFieldCount: 1,
      indeterminateLayer: 'the subject\'s permission-set list did not contain the profile-owned set every internal '
        + 'user holds, so the baseline layer was never queried',
    })),
    fieldAccessHint(new Set(['get_metadata_component_context']), hintFacts({ notVisibleFieldCount: 1 })),
    fieldAccessHint(new Set(['get_metadata_component_context']), hintFacts()),
    fieldAccessHint(new Set(['get_metadata_component_context']), hintFacts({ editableFieldCount: 0 })),
  ];
  for (const hint of branches) {
    assert.match(hint, /its rows are listed like any other set's, but this Tool reads the permission rows and not the group membership/u);
    assert.ok(hint.length <= 1_000, `the hint is ${hint.length} characters, over the schema's 1000`);
  }
});

function hintFacts(overrides: Partial<FieldAccessHintFacts> = {}): FieldAccessHintFacts {
  return {
    targetUserNamed: false,
    targetUserAllowed: true,
    indeterminateFieldCount: 0,
    notVisibleFieldCount: 0,
    readOnlyFieldCount: 0,
    editableFieldCount: 1,
    indeterminateLayer: null,
    truncated: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Output schema: the role literal, the pinned INDETERMINATE, and the privacy assertion
// ---------------------------------------------------------------------------------------------

test('the output pins the DIAGNOSTIC role and the standard API, and refuses a USER-role success', () => {
  const output = outputFixture({});
  assert.equal(explainFieldAccessOutputSchema.safeParse(output).success, true);
  assert.equal(
    explainFieldAccessOutputSchema.safeParse({ ...output, executionRole: 'USER' }).success,
    false,
    'a regression that silently reverted the role would otherwise still pass every schema check',
  );
  assert.equal(explainFieldAccessOutputSchema.safeParse({ ...output, api: 'TOOLING' }).success, false);
  assert.equal(explainFieldAccessOutputSchema.safeParse({ success: false, errorCode: 'MCP_FIELD_ACCESS_READ_FAILED' }).success, true);
});

test('the output pins record-type availability to INDETERMINATE, so no edit can make it answer false', () => {
  const output = outputFixture({
    recordTypeContext: {
      recordTypes: [{ id: '012000000000001AAA', developerName: 'WRN', name: 'WRN', isActive: false }],
      truncated: false,
      availableToExecutionIdentity: [],
      availableToSubject: FIELD_ACCESS_INDETERMINATE,
      caveat: 'per-user availability is a Profile and page-layout fact this read surface does not carry',
    },
  });
  assert.equal(explainFieldAccessOutputSchema.safeParse(output).success, true);
  assert.equal(
    explainFieldAccessOutputSchema.safeParse({
      ...output,
      recordTypeContext: {
        recordTypes: [],
        truncated: false,
        availableToExecutionIdentity: [],
        availableToSubject: false,
        caveat: 'x',
      },
    }).success,
    false,
    'answering false would read a layer that was never read as a denial',
  );
});

test('the output rejects an extra key, which is what makes the privacy assertion below mean anything', () => {
  assert.equal(
    explainFieldAccessOutputSchema.safeParse({ ...outputFixture({}), records: [{ Id: '001000000000001AAA' }] }).success,
    false,
  );
});

test('this Tool\'s three error codes are registered, and the output accepts the refusal shape', () => {
  for (const code of ['MCP_FIELD_ACCESS_INVALID', 'MCP_FIELD_ACCESS_READ_FAILED', 'MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED'] as const) {
    assert.ok(CONTEXT_ERROR_CODES.includes(code), code);
  }
  assert.equal(
    explainFieldAccessOutputSchema.safeParse({ success: false, errorCode: 'MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED' }).success,
    true,
  );
});

test('the output carries permission facts only — no field value, no business record, no business object Id', () => {
  const serialized = JSON.stringify(outputFixture({}));

  // The identifiers this answer is *about* are permission-layer Ids and the subject's own User Id: `005` is
  // User, `0PS` is PermissionSet, `012` is RecordType. `001` Account, `003` Contact, `00Q` Lead, `500` Case,
  // `006` Opportunity and every other business prefix must not appear, because a payload carrying one would
  // have read a record rather than a permission table — the §0.3 data red line.
  const PERMISSION_LAYER_PREFIXES = ['005', '0PS', '012'];
  const ids = serialized.match(/[0-9A-Z]{15,18}/gu) ?? [];
  assert.ok(ids.length > 0, 'the fixture must contain the subject Id, or this assertion proves nothing');
  for (const id of ids) {
    assert.ok(
      PERMISSION_LAYER_PREFIXES.some((prefix) => id.startsWith(prefix)),
      `${id} is not a permission-layer Id, so something in this payload is not a permission fact`,
    );
  }

  // And no key anywhere in the payload is one that would carry record content, at any depth.
  const forbiddenKeys = ['records', 'recordId', 'recordTypeId', 'fieldValue', 'fieldValues', 'draftFields', 'body', 'data'];
  for (const key of collectKeys(JSON.parse(serialized))) {
    assert.equal(forbiddenKeys.includes(key), false, `${key} is not a permission fact`);
  }
});

test('the output echoes the object as the question, never a field value as an answer', () => {
  // `objectApiName` is the one business-shaped string in the payload, and it is what was *asked about*: it
  // says which object's permission configuration was read. Asserted so a later edit that started echoing
  // record content would have to change this test deliberately rather than by accident.
  const output = outputFixture({ objectApiName: 'Account' });
  assert.equal(output.objectApiName, 'Account');
  assert.deepEqual(output.fields?.map((field) => field.fieldApiName), ['Name']);
});

// ---------------------------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------------------------

test('explain_field_access is GA, read-only, DIAGNOSTIC, and states the targetUserId boundary in its text', async () => {
  const tool = new ExplainFieldAccessMcpTool({
    execute: async (input) => outputFixture({ objectApiName: input.objectApiName }),
  });
  assert.equal(tool.getName(), 'explain_field_access');
  assert.equal(tool.getReleaseState(), ReleaseState.GA);
  assert.deepEqual(tool.getToolsets(), [Toolset.DATA]);
  assert.deepEqual(tool.getConfig().annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });

  const description = tool.getConfig().description ?? '';
  assert.match(description, /Only users this deployment has configured as identity routes may be named/u);
  assert.match(description, /It is not a permission simulator/u);
  assert.match(description, /"INDETERMINATE"/u);
  assert.match(description, /never a business record/u);
  assert.match(description, /server-owned DIAGNOSTIC identity/u);
  assert.match(description, /no field value is ever read/u);
  assert.match(description, /which is NOT a denial/u);

  const result = await tool.exec({ objectApiName: 'Account', fieldApiNames: ['Name'] });
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as Record<string, unknown>).executionRole, 'DIAGNOSTIC');
  assert.match(String((result.content[0] as { text: string }).text), /explain_field_access: object=Account/u);
});

test('the Tool turns a refusal into the documented error shape rather than a success with no fields', async () => {
  const tool = new ExplainFieldAccessMcpTool({
    execute: async () => {
      // The host's boundary check raises this; the Tool's job is to convert it into the error shape rather
      // than to answer "no fields", which would read as "nobody has access".
      throw new ContextRuntimeError('MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED', 'that user is not a configured identity route');
    },
  });
  const result = await tool.exec({ objectApiName: 'Account', fieldApiNames: ['Name'], targetUserId: '005000000000009AAA' });
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as Record<string, unknown>).errorCode, 'MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED');
});

test('the provider refuses to build the Tool without an explainer rather than advertising a dead Tool', async () => {
  await assert.rejects(
    async () => new SfoaContextMcpProvider({ toolNames: ['explain_field_access'] }).provideTools(services()),
    /explain_field_access requires a field access explainer/u,
  );
});

test('the provider builds exactly the requested Tool when it has an explainer', async () => {
  const tools = await new SfoaContextMcpProvider({
    toolNames: ['explain_field_access'],
    fieldAccessExplainer: { execute: async (input) => outputFixture({ objectApiName: input.objectApiName }) },
  }).provideTools(services());
  assert.deepEqual(tools.map((tool) => tool.getName()), ['explain_field_access']);
});

test('explain_field_access is advertised by the provider and routed to the DIAGNOSTIC role', () => {
  assert.ok(SFOA_CONTEXT_TOOL_NAMES.includes('explain_field_access'));
  assert.equal(SFOA_CONTEXT_TOOL_ROLES.explain_field_access, 'DIAGNOSTIC');
});

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function explanation(
  fieldApiName: string,
  visible: boolean | 'INDETERMINATE',
  editable: boolean | 'INDETERMINATE',
): FieldAccessExplanation {
  return {
    fieldApiName,
    describeFacts: null,
    grants: [],
    grantsTruncated: false,
    conclusion: {
      visible,
      editable,
      sourceChain: ['object-visibility: read=true edit=true'],
      conflicts: [],
      caveats: [],
    },
  };
}

function outputFixture(
  overrides: Partial<ExplainFieldAccessOutput> & { objects?: readonly FieldAccessExplanation[] } = {},
): ExplainFieldAccessOutput {
  const { objects, ...rest } = overrides;
  const fields = objects ?? [explanation('Name', true, true)];
  return {
    success: true,
    executionRole: 'DIAGNOSTIC',
    api: 'STANDARD',
    objectApiName: 'Account',
    requestedFieldCount: fields.length,
    returnedFieldCount: fields.length,
    userContext: {
      userId: '005000000000001AAA',
      username: 'routed.user@example.test',
      userName: null,
      isActive: true,
      isRequestingUser: true,
      permissionSets: [{
        id: PROFILE_SET.id,
        name: PROFILE_SET.name,
        label: PROFILE_SET.label,
        isOwnedByProfile: true,
        profileName: PROFILE_SET.profileName,
      }],
      permissionSetsTruncated: false,
      objectAccess: { read: true, edit: true, viewAllRecords: false, unreadableParentIds: [] },
    },
    fields: [...fields],
    truncated: false,
    ...rest,
  };
}

/** Every key name anywhere in a parsed payload, so the privacy assertion is not defeated by nesting. */
function collectKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, found);
    return found;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      found.add(key);
      collectKeys(entry, found);
    }
  }
  return found;
}

function services(): Services {
  const orgService = {
    getAllowedOrgUsernames: async () => new Set(['user@example.test']),
    getConnection: async () => {
      throw new Error('not invoked by the provider Tool-contract test');
    },
  } as unknown as OrgService;
  return {
    getOrgService: () => orgService,
    getTelemetryService: () => ({ sendEvent: () => undefined }),
    getConfigService: () => ({
      getDataDir: () => process.cwd(),
      getStartupFlags: () => ({ 'allow-non-ga-tools': false, debug: false }),
    }),
  };
}
