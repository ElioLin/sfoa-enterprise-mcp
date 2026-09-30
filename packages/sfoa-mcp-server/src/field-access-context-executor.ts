import type { Connection } from '@salesforce/core';
import { DATA_MAX_RESPONSE_BYTES, readSalesforceFailure, trimToByteBudget } from '@sfoa/mcp-provider-sfoa-data';
import {
  ContextRuntimeError,
  EXPLAIN_FIELD_ACCESS_DEFAULT_RECORD_TYPE_CONTEXT,
  FIELD_ACCESS_INDETERMINATE,
  buildFieldAccessConclusion,
  fieldAccessHint,
  indeterminateLayerName,
  summarizeObjectAccess,
  toFieldAccessGrants,
  type ExplainFieldAccessInput,
  type ExplainFieldAccessOutput,
  type FieldAccessConclusionFacts,
  type FieldAccessExplanation,
  type FieldAccessGrantRow,
  type FieldAccessObjectPermissionRow,
  type FieldAccessParentFacts,
  type FieldAccessRecordTypeContext,
  type FieldAccessUserContext,
  type FieldAccessExplainer,
} from '@sfoa/mcp-provider-sfoa-context';
import type { RequestScope } from '@sfoa/identity-runtime';
import { assertDiagnosticScope } from './diagnostic-context-adapters.js';
import { selectFieldAccessSubject, targetNotAllowed, type FieldAccessTargetUsers } from './field-access-target-users.js';

/**
 * `explain_field_access`, host-side on the fixed DIAGNOSTIC identity.
 *
 * Host-side for the reason recorded on the `FieldAccessExplainer` contract: the `targetUserId` boundary
 * is a fact about the deployment's identity routes, which are the host's model, not the provider's. The
 * provider owns the Tool contract, the schemas, the pure conclusion builder and the hint; this file owns
 * the Connection, the identity guard, the query shapes and the response budget.
 *
 * ## The four disciplines this file is built around
 *
 * **One: the query surface is a constant whitelist, and it is the §0.3 red line made checkable.**
 * `FIELD_ACCESS_STANDARD_OBJECTS` below names every object any query in this file may read, and it
 * contains nothing but Setup-layer permission configuration plus `User`. The object the *caller* names is
 * reached through `describe` and nothing else — `describe` returns field definitions and never a record —
 * so no code path here can read a business row. That is not a claim in a comment: a unit test asserts
 * that every `FROM` clause in this module's source is drawn from the whitelist and that the caller's
 * object appears in no query. ADR-0029 §4a requires the whitelist because the same identity was measured
 * reading 955 `Lead` rows through the standard API, so the API does not stop a mistake — the Tool's code
 * has to.
 *
 * **Two: `describe` is never allowed to decide a conclusion.** The probe measured `Account`'s describe
 * reporting 252 fields, 199 createable, `for the calling identity` — and the calling identity is the
 * administrator-grade DIAGNOSTIC account. Mixed into a named user's answer it would silently report the
 * administrator's own field-level security as theirs. So `describeFacts` carries `executionIdentityView:
 * true` and is never passed to the conclusion builder: the builder takes a `FieldAccessConclusionFacts`
 * that has no field for it, which makes the mistake unrepresentable rather than merely discouraged.
 *
 * **Three: a layer that was not read is `INDETERMINATE`, never `false`.** The conclusion builder decides
 * that from the facts; this file's job is to be honest about what it actually measured, which is why the
 * parent list, the object-level rows and the field-level rows reach the builder as distinct facts rather
 * than pre-collapsed into a boolean.
 *
 * **Four: an empty result never means "nothing went wrong".** The T2 prohibition on silent empty results
 * applies here with a twist: a field with no grant rows is a real, common answer ("nobody granted it"),
 * so the way an empty answer is made non-silent is by carrying the layer readings next to it — the
 * `sourceChain` says which layers were consulted, and the `caveats` say which were not.
 */

/** The advertised Tool names of this session, which a hint may name and nothing else may. */
type AdvertisedTools = readonly string[];

/**
 * Every object this module's queries may name — ADR-0029 §4a's per-Tool whitelist for T3.
 *
 * `User` is here, and only for the subject lookup: the boundary query needs the routed username and the
 * Id it belongs to. It is a system object read for identity, not a business record.
 */
export const FIELD_ACCESS_STANDARD_OBJECTS = Object.freeze([
  'User',
  'PermissionSetAssignment',
  'PermissionSet',
  'ObjectPermissions',
  'FieldPermissions',
  'RecordType',
] as const);

/**
 * The permission sets one call reads before it stops.
 *
 * A permission-set list is the multiplier on everything below it: the object-level and field-level
 * queries are both scoped by `ParentId IN (…)`. An unbounded list would make one call's cost a function
 * of the org's assignment history, so it is bounded — and the bound is *reported* rather than applied
 * silently, because a subset list produces a wrong answer rather than a shorter one.
 */
const FIELD_ACCESS_MAX_PERMISSION_SETS = 200;

/** Grants kept per field before the list is cut. The count is reported in `grantsTruncated`. */
const FIELD_ACCESS_MAX_GRANTS_PER_FIELD = 50;

/** Record types read before the list is cut. */
const FIELD_ACCESS_MAX_RECORD_TYPES = 200;

/** A safety net on the field-grant query: the `IN` filter already bounds it to fields × parents. */
const FIELD_ACCESS_MAX_FIELD_PERMISSION_ROWS = 2_000;

/** A conclusion with the facts it was read from, kept together so the hint can name the same layer. */
type FieldExplanation = Readonly<{
  fieldApiName: string;
  describeFacts: DescribeFacts | null;
  grantsTruncated: boolean;
  facts: FieldAccessConclusionFacts;
}>;

export class ScopedFieldAccessExplainer implements FieldAccessExplainer {
  public constructor(
    private readonly scope: RequestScope,
    private readonly advertisedToolNames: AdvertisedTools,
    private readonly targetUsers: FieldAccessTargetUsers,
  ) {}

  public async execute(input: ExplainFieldAccessInput): Promise<ExplainFieldAccessOutput> {
    // The facade decides what the request may do; this decides which identity a Connection may be opened
    // for. Neither is redundant — this is the last point before Salesforce.
    assertDiagnosticScope(this.scope, 'explain_field_access');
    const objectApiName = input.objectApiName;
    const fieldApiNames = input.fieldApiNames;
    const includeRecordTypeContext = input.includeRecordTypeContext
      ?? EXPLAIN_FIELD_ACCESS_DEFAULT_RECORD_TYPE_CONTEXT;
    try {
      // The boundary is decided before anything is read *about a user*: `selectFieldAccessSubject` refuses
      // a request the deployment cannot scope at all, and the membership test itself is the
      // `Username IN (…)` clause `resolveSubject` puts inside the subject query. So an Id outside the
      // routes costs exactly one read — the subject lookup that returns nothing — and the answer is then
      // the same refusal a nonexistent Id gets, which is what keeps the Tool from being an existence
      // oracle. See `field-access-target-users.ts` for why membership is checked there rather than here.
      const selection = selectFieldAccessSubject(input.targetUserId, this.targetUsers);
      const connection = await this.scope.getConnection();
      const subject = await resolveSubject(connection, selection);
      const assigned = await readSubjectPermissionSets(connection, subject.userId);
      const parents = assigned.parents;

      const objectAccess = await readObjectAccess(connection, objectApiName, parents);
      const grantRows = await readFieldGrants(connection, objectApiName, fieldApiNames, parents);
      // The baseline layer of every answer is the permission set Salesforce creates for the subject's
      // profile. Whether it was *in the list that was read* is a fact about the parent list, and it is the
      // one that decides whether an empty grant set is a denial or a gap — see `indeterminateLayerName`.
      const profileBaselineReadable = parents.some((parent) => parent.isOwnedByProfile);
      // Best-effort and never decisive: describe answers for the executing DIAGNOSTIC identity, so a
      // failure here degrades to `null` per field rather than failing the call. Nothing below reads it.
      const describeFacts = await readDescribeFacts(connection, objectApiName, fieldApiNames);
      const recordTypeContext = includeRecordTypeContext
        ? await readRecordTypeContext(connection, objectApiName)
        : undefined;

      const fields: readonly FieldExplanation[] = fieldApiNames.map((fieldApiName) => {
        const all = grantRows.get(fieldApiName) ?? [];
        const grants = toFieldAccessGrants(all, parents).slice(0, FIELD_ACCESS_MAX_GRANTS_PER_FIELD);
        return Object.freeze({
          fieldApiName,
          describeFacts,
          grantsTruncated: all.length > grants.length,
          facts: Object.freeze({
            objectAccess,
            grants,
            profileBaselineReadable,
            permissionSetsTruncated: assigned.truncated,
            fieldMissingFromDescribe: describeFacts !== null && !describeFacts.has(fieldApiName),
          }),
        });
      });

      const build = (kept: readonly FieldExplanation[]): ExplainFieldAccessOutput => {
        const truncated = kept.length < fields.length;
        const conclusions = kept.map((entry) => buildFieldAccessConclusion(entry.facts));
        const indeterminateCount = conclusions
          .filter((conclusion) => isIndeterminate(conclusion.visible)).length;
        const notVisibleCount = conclusions
          .filter((conclusion) => conclusion.visible === false).length;
        const editableCount = conclusions
          .filter((conclusion) => conclusion.visible === true && conclusion.editable === true).length;
        const userContext: FieldAccessUserContext = {
          userId: subject.userId,
          username: subject.username,
          // `User.Name` is not among the field lists the T1 probe measured on a live org, and an unmeasured
          // field name is an `INVALID_FIELD` that takes the whole Tool down rather than one null in the
          // output. `Username` is the identifier the route table keys on and the one a reader needs here,
          // so the display name is left null rather than guessed at.
          userName: null,
          isActive: subject.isActive,
          isRequestingUser: !selection.targetNamed,
          permissionSets: parents.map((parent) => ({
            id: parent.id,
            name: parent.name,
            label: parent.label,
            isOwnedByProfile: parent.isOwnedByProfile,
            profileName: parent.profileName,
          })),
          permissionSetsTruncated: assigned.truncated,
          objectAccess: {
            read: objectAccess.read,
            edit: objectAccess.edit,
            viewAllRecords: objectAccess.viewAllRecords,
            unreadableParentIds: [...objectAccess.unreadableParentIds],
          },
        };
        const explanations: FieldAccessExplanation[] = kept.map((entry, index) => ({
          fieldApiName: entry.fieldApiName,
          describeFacts: entry.describeFacts === null ? null : {
            type: entry.describeFacts.get(entry.fieldApiName)?.type ?? null,
            label: entry.describeFacts.get(entry.fieldApiName)?.label ?? null,
            createable: entry.describeFacts.get(entry.fieldApiName)?.createable ?? null,
            updateable: entry.describeFacts.get(entry.fieldApiName)?.updateable ?? null,
            accessible: entry.describeFacts.get(entry.fieldApiName)?.accessible ?? null,
            executionIdentityView: true,
          },
          grants: entry.facts.grants.map((grant) => ({
            parentType: grant.parentType,
            parentId: grant.parentId,
            parentName: grant.parentName,
            parentLabel: grant.parentLabel,
            permissionsRead: grant.permissionsRead,
            permissionsEdit: grant.permissionsEdit,
          })),
          grantsTruncated: entry.grantsTruncated,
          conclusion: {
            visible: conclusions[index]?.visible ?? FIELD_ACCESS_INDETERMINATE,
            editable: conclusions[index]?.editable ?? FIELD_ACCESS_INDETERMINATE,
            sourceChain: [...(conclusions[index]?.sourceChain ?? [])],
            conflicts: [...(conclusions[index]?.conflicts ?? [])],
            caveats: [...(conclusions[index]?.caveats ?? [])],
          },
        }));
        return {
          success: true,
          executionRole: 'DIAGNOSTIC',
          api: 'STANDARD',
          objectApiName,
          requestedFieldCount: fieldApiNames.length,
          returnedFieldCount: kept.length,
          userContext,
          ...(recordTypeContext === undefined ? {} : { recordTypeContext }),
          fields: explanations,
          truncated,
          hint: fieldAccessHint(new Set(this.advertisedToolNames), {
            targetUserNamed: selection.targetNamed,
            targetUserAllowed: this.targetUsers.configuredSalesforceUsernames.length > 0,
            indeterminateFieldCount: indeterminateCount,
            notVisibleFieldCount: notVisibleCount,
            readOnlyFieldCount: kept.length - indeterminateCount - notVisibleCount - editableCount,
            editableFieldCount: editableCount,
            // The first field that could not be decided names the layer, and every undecided field in a call
            // names the same one: the layers are properties of the subject and the object, not of a field.
            indeterminateLayer: kept
              .map((entry) => indeterminateLayerName(entry.facts))
              .find((layer) => layer !== null) ?? null,
            truncated,
          }),
        };
      };
      return build(trimToByteBudget(fields, DATA_MAX_RESPONSE_BYTES, build).kept);
    } catch (error) {
      throw mapFieldAccessFailure(error);
    }
  }
}

/**
 * `===` and not truthiness: `INDETERMINATE` is a truthy string, so `if (conclusion.visible)` would read a
 * gap as a grant. This is the one trap the three-state shape carries, and it is why the check is a named
 * function rather than an inline expression.
 */
function isIndeterminate(value: boolean | 'INDETERMINATE'): boolean {
  return value === FIELD_ACCESS_INDETERMINATE;
}

type SubjectFacts = Readonly<{
  userId: string;
  username: string | null;
  isActive: boolean | null;
}>;

/**
 * Resolves the subject, with the `targetUserId` boundary enforced **inside the query**.
 *
 * The `Username IN (…)` clause is the whole boundary. A named Id that is not a configured identity route
 * and a named Id that exists nowhere both produce an empty result set, so this function has exactly one
 * "no subject" branch and it cannot be made to distinguish the two — the indistinguishability is
 * structural rather than a convention two error paths have to keep in step. A self-subject is scoped by
 * the same list, which is also correct: a user whose own route has been disabled is not somebody this
 * Tool explains access for.
 *
 * `Id, Username, IsActive` is the field list the T1 probe measured on a live org; `User.Name` was not in
 * any measured list and is deliberately not selected (see the `userName: null` note at the call site).
 */
async function resolveSubject(
  connection: Connection,
  selection: ReturnType<typeof selectFieldAccessSubject>,
): Promise<SubjectFacts> {
  const routeClause = selection.allowedUsernames.length === 0
    ? ''
    : ` AND Username IN (${selection.allowedUsernames.map(quoteSoqlLiteral).join(', ')})`;
  const subjectClause = selection.targetUserId !== null
    ? `Id = ${quoteSoqlLiteral(selection.targetUserId)}`
    : `Username = ${quoteSoqlLiteral(selection.selfSalesforceUsername ?? '')}`;
  const record = readQueryRecords(await connection.query(
    `SELECT Id, Username, IsActive FROM User WHERE ${subjectClause}${routeClause} LIMIT 1`,
  ))[0];
  if (record === undefined) {
    // One refusal for both readings. `targetNotAllowed` is worded so it is the same answer whether the Id
    // names a user this deployment does not route or names nobody at all.
    throw targetNotAllowed();
  }
  const userId = asString(record.Id);
  if (userId === null) throw targetNotAllowed();
  return Object.freeze({
    userId,
    username: asString(record.Username),
    isActive: typeof record.IsActive === 'boolean' ? record.IsActive : null,
  });
}

/**
 * The subject's permission sets, read in two measured steps rather than one traversal.
 *
 * `PermissionSetAssignment.PermissionSet.Name` was measured on a live org, but the ownership flag and the
 * profile name were measured only on `PermissionSet` itself (`IsOwnedByProfile`, `Profile.Name`). A
 * two-level traversal (`PermissionSetAssignment.PermissionSet.Profile.Name`) is expressible in SOQL and
 * was never measured, and an unmeasured traversal fails with `INVALID_FIELD` — taking the whole Tool down
 * to save one round trip. So the assignment query returns ids and the second query resolves the facts,
 * from the exact field list the probe measured.
 */
async function readSubjectPermissionSets(
  connection: Connection,
  userId: string,
): Promise<Readonly<{ parents: readonly FieldAccessParentFacts[]; truncated: boolean }>> {
  const assignments = readQueryRecords(await connection.query(
    `SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = ${quoteSoqlLiteral(userId)}`,
  ));
  const ids = [...new Set(assignments
    .map((record) => asString(record.PermissionSetId))
    .filter((id): id is string => id !== null))].sort();
  if (ids.length === 0) return Object.freeze({ parents: Object.freeze([]), truncated: false });
  const selected = ids.slice(0, FIELD_ACCESS_MAX_PERMISSION_SETS);
  const records = readQueryRecords(await connection.query(
    'SELECT Id, Name, Label, IsOwnedByProfile, Profile.Name FROM PermissionSet '
      + `WHERE Id IN (${selected.map(quoteSoqlLiteral).join(', ')})`,
  ));
  const parents = records.map((record) => {
    const profile = isRecord(record.Profile) ? record.Profile : {};
    return Object.freeze({
      id: asString(record.Id) ?? '',
      name: asString(record.Name),
      // `Label` and the profile's `Name` are translated on this org (`系统管理员`), so they are reported
      // and never matched on. `Name` is the API name and the stable key.
      label: asString(record.Label),
      isOwnedByProfile: record.IsOwnedByProfile === true,
      profileName: asString(profile.Name),
    });
  }).filter((parent) => parent.id.length > 0);
  return Object.freeze({ parents: Object.freeze(parents), truncated: ids.length > selected.length });
}

async function readObjectAccess(
  connection: Connection,
  objectApiName: string,
  parents: readonly FieldAccessParentFacts[],
): Promise<ReturnType<typeof summarizeObjectAccess>> {
  if (parents.length === 0) {
    // No permission set at all is anomalous — every internal user has a profile-owned set — and it means
    // no object-level row could have been read. `summarizeObjectAccess` returns the all-gap answer.
    return summarizeObjectAccess(parents, []);
  }
  const records = readQueryRecords(await connection.query(
    'SELECT ParentId, PermissionsRead, PermissionsEdit, PermissionsViewAllRecords FROM ObjectPermissions '
      + `WHERE SobjectType = ${quoteSoqlLiteral(objectApiName)} `
      + `AND ParentId IN (${parents.map((parent) => quoteSoqlLiteral(parent.id)).join(', ')})`,
  ));
  const rows: readonly FieldAccessObjectPermissionRow[] = records.map((record) => Object.freeze({
    parentId: asString(record.ParentId) ?? '',
    permissionsRead: readFlag(record.PermissionsRead),
    permissionsEdit: readFlag(record.PermissionsEdit),
    permissionsViewAllRecords: readFlag(record.PermissionsViewAllRecords),
  })).filter((row) => row.parentId.length > 0);
  return summarizeObjectAccess(parents, rows);
}

/**
 * The subject's `FieldPermissions` rows for the requested fields, keyed by the name the caller used.
 *
 * The `Field IN (…)` list carries **both spellings** of every field — `Name` and `Object.Name` — because
 * whether this org stores `FieldPermissions.Field` qualified by its object is a question the T1 probe did
 * not record an answer to, and getting it wrong has no error: the query simply returns nothing and every
 * field reads as ungranted. Rather than guess, both forms are sent and the result is normalized back to
 * the bare name, so the answer is the same either way and the ambiguity is confined to this function.
 */
async function readFieldGrants(
  connection: Connection,
  objectApiName: string,
  fieldApiNames: readonly string[],
  parents: readonly FieldAccessParentFacts[],
): Promise<ReadonlyMap<string, readonly FieldAccessGrantRow[]>> {
  const byField = new Map<string, FieldAccessGrantRow[]>(fieldApiNames.map((name) => [name, []]));
  if (parents.length === 0 || fieldApiNames.length === 0) return byField;
  const spellings = [...new Set(fieldApiNames.flatMap((name) => [name, `${objectApiName}.${name}`]))];
  const records = readQueryRecords(await connection.query(
    'SELECT ParentId, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions '
      + `WHERE SobjectType = ${quoteSoqlLiteral(objectApiName)} `
      + `AND Field IN (${spellings.map(quoteSoqlLiteral).join(', ')}) `
      + `AND ParentId IN (${parents.map((parent) => quoteSoqlLiteral(parent.id)).join(', ')}) `
      + `LIMIT ${FIELD_ACCESS_MAX_FIELD_PERMISSION_ROWS}`,
  ));
  for (const record of records) {
    const parentId = asString(record.ParentId) ?? '';
    const field = bareFieldName(asString(record.Field), objectApiName);
    if (parentId.length === 0 || field === null) continue;
    // Only a name the caller actually asked about is kept: the `IN` list carries both spellings, so a
    // single row can arrive under either and must land on the one key the caller used.
    const key = [...byField.keys()].find((candidate) => candidate.toLowerCase() === field.toLowerCase());
    if (key === undefined) continue;
    byField.get(key)?.push(Object.freeze({
      parentId,
      permissionsRead: record.PermissionsRead === true,
      permissionsEdit: record.PermissionsEdit === true,
    }));
  }
  return byField;
}

/**
 * Strips a `<Object>.` qualifier from a stored `FieldPermissions.Field` so a qualified row and a bare
 * request meet. Case-insensitive, because Salesforce API names compare that way.
 */
function bareFieldName(stored: string | null, objectApiName: string): string | null {
  if (stored === null) return null;
  const prefix = `${objectApiName}.`;
  const bare = stored.toLowerCase().startsWith(prefix.toLowerCase()) ? stored.slice(prefix.length) : stored;
  return bare.trim().length === 0 ? null : bare;
}

type DescribeFieldFacts = Readonly<{
  type: string | null;
  label: string | null;
  createable: boolean | null;
  updateable: boolean | null;
  accessible: boolean | null;
}>;

type DescribeFacts = ReadonlyMap<string, DescribeFieldFacts>;

/**
 * The caller's object's field definitions — and **nothing else about it**.
 *
 * This is the only place the object the caller names is reached, and `describe` returns metadata: no
 * query in this module can name it. That is what keeps the §0.3 red line structural on the one object a
 * caller controls, and the module's unit test asserts it.
 *
 * A failure here returns `null` rather than throwing, because these facts never decide a conclusion —
 * they exist so the answer can say what the field *is*, alongside what the subject may do with it.
 */
async function readDescribeFacts(
  connection: Connection,
  objectApiName: string,
  fieldApiNames: readonly string[],
): Promise<DescribeFacts | null> {
  try {
    const described = (await connection.sobject(objectApiName).describe()) as unknown as {
      fields?: readonly Record<string, unknown>[];
    };
    const facts = new Map<string, DescribeFieldFacts>();
    for (const requested of fieldApiNames) {
      // Keyed by the caller's own spelling, not the describe's: the grants key on the caller's name, and
      // the two have to meet for the answer to render.
      const match = (described.fields ?? []).find((field) => (
        (asString(field.name) ?? '').toLowerCase() === requested.toLowerCase()
      ));
      if (match === undefined) continue;
      facts.set(requested, Object.freeze({
        type: asString(match.type),
        label: asString(match.label),
        createable: readFlag(match.createable),
        updateable: readFlag(match.updateable),
        accessible: readFlag(match.accessible),
      }));
    }
    return facts;
  } catch {
    return null;
  }
}

/**
 * The object's record types, and an honest statement about what cannot be said about them.
 *
 * Availability to the *subject* is a Profile/Layout metadata fact, and this Tool's whitelist carries the
 * `RecordType` object rather than the profile metadata that decides availability. So the object's record
 * types are reported as facts and their availability to the subject is reported as `INDETERMINATE` — the
 * schema pins that to a literal, so no future edit can quietly answer `false`, which would read a layer
 * that was never read as a denial.
 *
 * The query has no `WHERE` clause. `RecordType.SobjectType` filterability was never measured, and an
 * unmeasured filter is an `INVALID_FIELD` that takes the Tool down; the table is small, the read is
 * bounded, and the narrowing happens in memory where it cannot fail.
 */
async function readRecordTypeContext(
  connection: Connection,
  objectApiName: string,
): Promise<FieldAccessRecordTypeContext | undefined> {
  try {
    const records = readQueryRecords(await connection.query(
      'SELECT Id, DeveloperName, Name, SobjectType, IsActive FROM RecordType '
        + `LIMIT ${FIELD_ACCESS_MAX_RECORD_TYPES}`,
    ));
    const matching = records.filter((record) => (
      (asString(record.SobjectType) ?? '').toLowerCase() === objectApiName.toLowerCase()
    ));
    return Object.freeze({
      recordTypes: matching.map((record) => Object.freeze({
        id: asString(record.Id) ?? '',
        developerName: asString(record.DeveloperName),
        name: asString(record.Name),
        isActive: readFlag(record.IsActive),
      })).filter((recordType) => recordType.id.length > 0),
      truncated: false,
      availableToExecutionIdentity: [],
      availableToSubject: FIELD_ACCESS_INDETERMINATE,
      caveat: 'Whether the subject may use each record type is a Profile and page-layout fact rather than a permission-table '
        + 'row, and this Tool\'s read surface does not carry it. The record types are listed as facts about the object; their '
        + 'availability to this subject is not established here, and INDETERMINATE is a gap rather than a denial.',
    });
  } catch {
    // A record-type read that fails does not fail the call: nothing in a conclusion depends on it, and the
    // field-level answer is the answer the caller asked for.
    return undefined;
  }
}

/** Reads the boolean flag fields, treating anything that is not a boolean as unread rather than as false. */
function readFlag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

const PERMISSION_DENIAL_CODES = [
  'INSUFFICIENT_ACCESS',
  'INSUFFICIENT_ACCESS_OR_READONLY',
  'INSUFFICIENT_PRIVILEGES',
  'API_DISABLED_FOR_ORG',
  'INVALID_TYPE',
] as const;

function isPermissionDenial(code: string | null): boolean {
  if (code === null) return false;
  const normalized = code.toLocaleUpperCase('en-US');
  return PERMISSION_DENIAL_CODES.some((denial) => denial === normalized);
}

/**
 * ADR-0029 §3 on the read path: a permission the deployment has not granted is a structured error naming
 * its prerequisite, never a quiet gap.
 *
 * The prerequisite identifier here is not one of §2's letters. §2's `A-1`…`A-4` are the places P10 had
 * already identified as unmeasured; this Tool reads a different surface — the standard API's permission
 * tables — and ADR-0029 §3 explicitly allows the identifier to be "the measured constraint it tripped"
 * rather than a §2 row. What is named is the fact, because that is what an operator can act on.
 */
function mapFieldAccessFailure(error: unknown): ContextRuntimeError {
  if (error instanceof ContextRuntimeError) return error;
  const failure = readSalesforceFailure(error);
  if (isPermissionDenial(failure.code)) {
    return new ContextRuntimeError(
      'MCP_DIAGNOSTIC_PREREQUISITE_MISSING',
      'Salesforce refused to let the diagnostic identity read the permission tables this Tool aggregates.',
      {
        cause: error,
        ...(failure.code === null ? {} : { salesforceErrorCode: failure.code }),
        prerequisite: 'permission-table readability on the diagnostic identity',
        suggestion: 'This Tool reads the org\'s permission configuration — FieldPermissions, ObjectPermissions, '
          + 'PermissionSet, PermissionSetAssignment, Profile, RecordType — and needs "View Setup and Configuration" on the '
          + 'diagnostic account. The T1 probe measured all six as readable on its sandbox, so a refusal here means this '
          + 'deployment\'s account differs from the probed one. Enable the Tool only after the read is granted.',
      },
    );
  }
  return new ContextRuntimeError(
    'MCP_FIELD_ACCESS_READ_FAILED',
    'Salesforce could not complete the permission-read this request needs.',
    {
      cause: error,
      ...(failure.code === null ? {} : { salesforceErrorCode: failure.code }),
      suggestion: 'Retry once. If it fails again, check the diagnostic identity\'s API access. A failed read never returns an '
        + 'empty field list, because an empty list would read as "nothing is granted".',
    },
  );
}

/** SOQL string-literal escaping. Every value quoted here is schema-bounded, never free text. */
function quoteSoqlLiteral(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

type QueryResult = Readonly<{ records: readonly Record<string, unknown>[]; totalSize: number | null }>;

function readQueryResult(value: unknown): QueryResult {
  const record = isRecord(value) ? value : {};
  const records = Array.isArray(record.records) ? record.records.filter(isRecord) : [];
  return Object.freeze({ records: Object.freeze(records), totalSize: asNumber(record.totalSize) });
}

function readQueryRecords(value: unknown): readonly Record<string, unknown>[] {
  return readQueryResult(value).records;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
