import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import {
  ContextRuntimeError,
  FIELD_ACCESS_INDETERMINATE,
  ExplainFieldAccessMcpTool,
  explainFieldAccessInputSchema,
  explainFieldAccessOutputSchema,
  type ExplainFieldAccessOutput,
  type FieldAccessExplainer,
} from '@sfoa/mcp-provider-sfoa-context';
import type { RequestContext, RequestScope, RuntimeLogEvent } from '@sfoa/identity-runtime';
import { createSalesforceIdentityRoute } from '@sfoa/identity-runtime';
import { ContextToolFacade } from '../context-tool-facade.js';
import {
  FIELD_ACCESS_STANDARD_OBJECTS,
  ScopedFieldAccessExplainer,
} from '../field-access-context-executor.js';
import {
  FIELD_ACCESS_MAX_ROUTE_USERNAMES,
  envFieldAccessTargetUsers,
  selectFieldAccessSubject,
  type FieldAccessTargetUsers,
} from '../field-access-target-users.js';

import {
  TEST_DIAGNOSTIC_USERNAME,
  TEST_PLATFORM_USER_A,
  TEST_PLATFORM_USER_B,
  TEST_USERNAME_A,
  TEST_USERNAME_B,
  createTestIdentityRuntime,
} from './helpers.js';

/**
 * Host-side coverage for `explain_field_access`.
 *
 * The provider package owns what is pure — the input/output schemas, the conclusion builder, the hint
 * gating — and covers it in `field-access-toolset.test.ts`. What needs a Connection and an identity is
 * covered here: the `FROM`-target whitelist that makes the §0.3 data red line checkable, the
 * `targetUserId` boundary, the exact SOQL this module sends, ADR-0029 §3's degradation contract, the
 * response budget, and the facade's audit summaries.
 *
 * The fixture is purpose-built rather than reusing `RecordingConnectionFactory`, because the whole
 * point of this Tool is *which* permission rows it reads and how it attributes them: a fixture that
 * answered every query with one generic row would let the aggregation be wrong while these tests
 * passed. The tables below are the org's Setup-layer tables, and the queries are routed by the same
 * markers the production statements carry — so an assertion on `queries` is an assertion on the
 * statement that was actually sent.
 */

// ---------------------------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------------------------

const OBJECT = 'Account';
const SUBJECT_ID = '005000000000001AAA';
const OTHER_USER_ID = '005000000000002AAA';
const PROFILE_PS_ID = '0PS000000000001AAA';
const STANDALONE_PS_ID = '0PS000000000002AAA';

/**
 * A Connection over the org's permission tables.
 *
 * `users`, `assignments`, `permissionSets`, `objectPermissions`, `fieldPermissions` and `recordTypes`
 * are the six whitelisted objects, and the fixture implements real filtering on each — an `IN` list
 * genuinely narrows, a `ParentId` genuinely scopes — so a test cannot pass by having the executor send
 * a query whose clauses it does not honour.
 */
class PermissionConnectionFactory {
  public readonly creations: string[] = [];
  public readonly queries: string[] = [];
  public apiVersion = '65.0';

  public users: Record<string, unknown>[] = [];
  public assignments: Record<string, unknown>[] = [];
  public permissionSets: Record<string, unknown>[] = [];
  public objectPermissions: Record<string, unknown>[] = [];
  public fieldPermissions: Record<string, unknown>[] = [];
  public recordTypes: Record<string, unknown>[] = [];

  /** Thrown by any query whose statement contains `match`. Specific beats general. */
  public queryErrors: { match: string; error: unknown }[] = [];
  /** Answers `sobject(name).describe()`. Absent means the small default schema below. */
  public describe?: (objectApiName: string) => unknown;
  public describeError: unknown;

  public async create(route: { connectionRole: string; salesforceUsername: string }): Promise<Connection> {
    this.creations.push(route.salesforceUsername);
    const connection = {
      // `RequestScopedSalesforceConnection.initialize` reads the API version off the Connection before it
      // hands it to the executor, so a fixture without it fails at initialization rather than at an
      // assertion — every test would report an auth failure instead of the behaviour it means to check.
      getApiVersion: () => this.apiVersion,
      query: async (query: string) => this.runQuery(query),
      sobject: (objectApiName: string) => ({
        describe: async () => {
          if (this.describeError !== undefined) throw this.describeError;
          return this.describe === undefined ? describePayload(objectApiName) : this.describe(objectApiName);
        },
      }),
    };
    return connection as unknown as Connection;
  }

  public get fromTargets(): readonly string[] {
    return this.queries.map((query) => fromTarget(query) ?? '<none>');
  }

  private runQuery(query: string): unknown {
    this.queries.push(query);
    const specific = this.queryErrors.find((entry) => query.includes(entry.match));
    if (specific) throw specific.error;

    if (query.includes('FROM User WHERE ')) {
      const id = clauseLiteral(query, 'Id = ');
      const username = clauseLiteral(query, 'Username = ');
      const allowed = inList(query, 'Username IN (');
      return result(this.users.filter((row) => (
        (id === null || row.Id === id)
        && (username === null || row.Username === username)
        // The boundary clause is honoured here rather than ignored, so a subject the route list does not
        // carry really does produce an empty result set — which is what the refusals below depend on.
        && (allowed.length === 0 || allowed.includes(String(row.Username)))
      )));
    }
    if (query.includes('FROM PermissionSetAssignment WHERE ')) {
      const assignee = clauseLiteral(query, 'AssigneeId = ');
      return result(this.assignments.filter((row) => assignee === null || row.AssigneeId === assignee));
    }
    if (query.includes('FROM PermissionSet WHERE ')) {
      const ids = inList(query, 'Id IN (');
      return result(this.permissionSets.filter((row) => ids.includes(String(row.Id))));
    }
    if (query.includes('FROM ObjectPermissions WHERE ')) {
      const sobject = clauseLiteral(query, 'SobjectType = ');
      const parents = inList(query, 'ParentId IN (');
      return result(this.objectPermissions.filter((row) => (
        (sobject === null || row.SobjectType === sobject) && parents.includes(String(row.ParentId))
      )));
    }
    if (query.includes('FROM FieldPermissions WHERE ')) {
      const sobject = clauseLiteral(query, 'SobjectType = ');
      const fields = inList(query, 'Field IN (');
      const parents = inList(query, 'ParentId IN (');
      return result(this.fieldPermissions.filter((row) => (
        (sobject === null || row.SobjectType === sobject)
        && fields.includes(String(row.Field))
        && parents.includes(String(row.ParentId))
      )));
    }
    if (query.includes('FROM RecordType')) {
      return result(this.recordTypes);
    }
    throw new Error(`Unexpected permission query in the field-access fixture: ${query}`);
  }
}

function result(records: Record<string, unknown>[]): unknown {
  return { records, totalSize: records.length, done: true };
}

function fromTarget(query: string): string | null {
  return /\bFROM ([A-Za-z_][A-Za-z0-9_]*)/u.exec(query)?.[1] ?? null;
}

/** The single quoted literal immediately after `marker`, when the clause is present at all. */
function clauseLiteral(query: string, marker: string): string | null {
  const at = query.indexOf(marker);
  if (at < 0) return null;
  const match = /^\s*'((?:[^'\\]|\\.)*)'/u.exec(query.slice(at + marker.length));
  return match?.[1] === undefined ? null : unescapeSoql(match[1]);
}

/** Every quoted literal inside the `IN (…)` list that begins at `marker`. */
function inList(query: string, marker: string): string[] {
  const at = query.indexOf(marker);
  if (at < 0) return [];
  const rest = query.slice(at + marker.length);
  const end = rest.indexOf(')');
  return allLiterals(end < 0 ? rest : rest.slice(0, end));
}

function allLiterals(text: string): string[] {
  const found: string[] = [];
  const pattern = /'((?:[^'\\]|\\.)*)'/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) found.push(unescapeSoql(match[1] ?? ''));
  return found;
}

function unescapeSoql(value: string): string {
  return value.replaceAll("\\'", "'").replaceAll('\\\\', '\\');
}

/**
 * The `describe` payload, small but shaped like jsforce's.
 *
 * `Id` is the one field the default list reports as neither createable nor updateable, so a test can
 * tell "the describe was read" from "every flag defaulted to true".
 */
function describePayload(objectApiName: string, names: readonly string[] = ['Id', 'Name', 'OwnerId']): unknown {
  return {
    name: objectApiName,
    label: objectApiName,
    fields: names.map((name) => ({
      name,
      label: name === 'Id' ? `${objectApiName} ID` : `${name} label`,
      type: name === 'Id' ? 'id' : 'string',
      createable: name !== 'Id',
      updateable: name !== 'Id',
      accessible: name !== 'Id',
    })),
  };
}

function userRow(id: string, username: string, isActive: boolean): Record<string, unknown> {
  return { Id: id, Username: username, IsActive: isActive };
}

function assignmentRow(index: number, permissionSetId: string, assigneeId: string): Record<string, unknown> {
  return {
    Id: `0Pa${String(index).padStart(12, '0')}AAA`,
    PermissionSetId: permissionSetId,
    AssigneeId: assigneeId,
  };
}

function permissionSetRow(
  id: string,
  name: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    Id: id,
    Name: name,
    Label: name,
    IsOwnedByProfile: false,
    Profile: null,
    ...overrides,
  };
}

/**
 * The baseline deployment: one subject reachable through one profile-owned set and one standalone
 * permission set, both granting read and edit on the object.
 *
 * The profile-owned row carries a translated `Label` and profile `Name` (`系统管理员`) deliberately —
 * the probe measured the live org's names that way, and the Tool reports labels while matching on
 * `Name` only. A fixture with ASCII labels would not tell those two apart.
 */
function seeded(factory = new PermissionConnectionFactory()): PermissionConnectionFactory {
  factory.users = [
    userRow(SUBJECT_ID, TEST_USERNAME_A, true),
    userRow(OTHER_USER_ID, TEST_USERNAME_B, true),
  ];
  factory.assignments = [
    assignmentRow(1, PROFILE_PS_ID, SUBJECT_ID),
    assignmentRow(2, STANDALONE_PS_ID, SUBJECT_ID),
  ];
  factory.permissionSets = [
    permissionSetRow(PROFILE_PS_ID, 'System_Administrator', {
      Label: '系统管理员',
      IsOwnedByProfile: true,
      Profile: { Name: '系统管理员' },
    }),
    permissionSetRow(STANDALONE_PS_ID, 'SFOA_Field_Editor', { Label: 'Field Editor' }),
  ];
  factory.objectPermissions = [
    objectRow(PROFILE_PS_ID, true, true, false),
    objectRow(STANDALONE_PS_ID, true, true, false),
  ];
  factory.fieldPermissions = [];
  factory.recordTypes = [];
  return factory;
}

function objectRow(
  parentId: string,
  read: boolean,
  edit: boolean,
  viewAllRecords: boolean,
): Record<string, unknown> {
  return {
    ParentId: parentId,
    SobjectType: OBJECT,
    PermissionsRead: read,
    PermissionsEdit: edit,
    PermissionsViewAllRecords: viewAllRecords,
  };
}

function grantRow(
  parentId: string,
  field: string,
  read: boolean,
  edit: boolean,
  sobject = OBJECT,
): Record<string, unknown> {
  return { ParentId: parentId, SobjectType: sobject, Field: field, PermissionsRead: read, PermissionsEdit: edit };
}

/** The route facts the host injects, as both runtimes supply them. */
function targetUsers(overrides: Partial<FieldAccessTargetUsers> = {}): FieldAccessTargetUsers {
  return Object.freeze({
    selfSalesforceUsername: TEST_USERNAME_A,
    configuredSalesforceUsernames: Object.freeze([TEST_USERNAME_A, TEST_USERNAME_B]),
    ...overrides,
  });
}

const ALL_TOOLS: readonly string[] = [
  'explain_field_access',
  'get_metadata_component_context',
  'run_diagnostic_tooling_query',
];

class RecordingLogger {
  public readonly events: RuntimeLogEvent[] = [];

  public log(event: RuntimeLogEvent): void {
    this.events.push(event);
  }
}

type Scopes = Readonly<{
  diagnostic: RequestScope;
  user: RequestScope;
  factory: PermissionConnectionFactory;
  close(): Promise<void>;
}>;

async function createScopes(factory = seeded()): Promise<Scopes> {
  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-p10-fieldaccess-'));
  const runtime = createTestIdentityRuntime(root, factory, new RecordingLogger(), TEST_DIAGNOSTIC_USERNAME);
  const diagnosticFactory = runtime.diagnosticScopeFactory;
  if (!diagnosticFactory) assert.fail('the test runtime must expose a DIAGNOSTIC scope factory');
  const diagnostic = await diagnosticFactory.create({
    platformUserId: TEST_PLATFORM_USER_A,
    correlationId: 'fieldaccess-diagnostic',
  });
  const user = await runtime.scopeFactory.create({
    platformUserId: TEST_PLATFORM_USER_A,
    correlationId: 'fieldaccess-user',
  });
  return {
    diagnostic,
    user,
    factory,
    close: async () => {
      await Promise.allSettled([diagnostic.close(), user.close()]);
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

function rejection(promise: Promise<unknown>): Promise<ContextRuntimeError> {
  return promise.then(
    () => { throw new Error('expected the call to fail'); },
    (thrown: unknown) => {
      assert.ok(thrown instanceof ContextRuntimeError, `expected a ContextRuntimeError, got ${String(thrown)}`);
      return thrown;
    },
  );
}

/** Runs the executor on the DIAGNOSTIC scope and returns the output, validated against its own schema. */
async function explain(
  scopes: Scopes,
  input: Readonly<Record<string, unknown>>,
  target: FieldAccessTargetUsers = targetUsers(),
  advertised: readonly string[] = ALL_TOOLS,
): Promise<ExplainFieldAccessOutput> {
  const output = await new ScopedFieldAccessExplainer(scopes.diagnostic, advertised, target)
    .execute(input as never);
  // Every assertion below is about a field the wire contract carries, so parsing here means a shape the
  // schema would reject can never be asserted on as if it were a valid answer.
  return explainFieldAccessOutputSchema.parse(output) as ExplainFieldAccessOutput;
}

function hintOf(output: { hint?: string | undefined }): string {
  const hint = output.hint;
  if (hint === undefined || hint.length === 0) assert.fail('expected the Tool output to carry a hint');
  return hint;
}

function fieldOf(output: ExplainFieldAccessOutput, index: number): NonNullable<ExplainFieldAccessOutput['fields']>[number] {
  const fields = output.fields ?? [];
  const field = fields[index];
  if (field === undefined) assert.fail(`expected the output to carry a field at index ${index}`);
  return field;
}

// ---------------------------------------------------------------------------------------------
// The §0.3 data red line: the query surface is a constant whitelist
// ---------------------------------------------------------------------------------------------

test('every FROM target in the executor is on the T3 whitelist, and the whitelist is the six Setup-layer objects', async () => {
  const { readFile } = await import('node:fs/promises');
  // The compiled module, because it is the artifact under test — this test runs from `dist`. Comments
  // are stripped by the compiler, so what is scanned is the code and only the code.
  const source = await readFile(new URL('../field-access-context-executor.js', import.meta.url), 'utf8');
  const targets = [...source.matchAll(/\bFROM ([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1] ?? '');
  assert.ok(
    targets.length >= 6,
    `the source scan must find the module's own FROM targets, found ${targets.length}`,
  );
  const allowed: readonly string[] = FIELD_ACCESS_STANDARD_OBJECTS;
  for (const target of targets) {
    assert.ok(allowed.includes(target), `FROM ${target} is not on the T3 whitelist`);
  }
  // The whitelist itself: exactly the Setup-layer permission configuration plus `User`, and no business
  // object. A tool that could query `Account` could read business rows through the standard API, which
  // the probe measured the DIAGNOSTIC identity being able to do (955 `Lead` rows).
  assert.deepEqual(
    [...FIELD_ACCESS_STANDARD_OBJECTS].sort(),
    ['FieldPermissions', 'ObjectPermissions', 'PermissionSet', 'PermissionSetAssignment', 'RecordType', 'User'],
  );
  assert.equal(Object.isFrozen(FIELD_ACCESS_STANDARD_OBJECTS), true);
  for (const business of ['Account', 'Contact', 'Lead', 'Opportunity', 'Case']) {
    assert.equal(allowed.includes(business), false, `${business} must not be queryable by this Tool`);
  }
});

test('a live call reads only whitelisted objects, and the caller-named object appears in no query', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.fieldPermissions = [grantRow(PROFILE_PS_ID, 'Name', true, true)];
    await explain(scopes, { objectApiName: OBJECT, fieldApiNames: ['Name'] });

    const allowed: readonly string[] = FIELD_ACCESS_STANDARD_OBJECTS;
    assert.ok(scopes.factory.queries.length >= 5, 'the executor must have read its layers');
    for (const target of scopes.factory.fromTargets) {
      assert.ok(allowed.includes(target), `FROM ${target} was sent but is not whitelisted`);
    }
    // `Account` appears as a `SobjectType` *value*, and that is the point: the object the caller names is
    // a filter key on the permission tables, never a query target. This assertion is what tells the two
    // apart, and it is the red line in one line.
    assert.equal(scopes.factory.fromTargets.includes(OBJECT), false);
    assert.equal(scopes.factory.queries.some((query) => /FROM\s+Account\b/u.test(query)), false);
  } finally {
    await scopes.close();
  }
});

// ---------------------------------------------------------------------------------------------
// The targetUserId boundary
// ---------------------------------------------------------------------------------------------

test('a named target is accepted as sent, and the allowed set is the deployment route usernames, deduplicated and sorted', () => {
  const selection = selectFieldAccessSubject(OTHER_USER_ID, targetUsers({
    configuredSalesforceUsernames: Object.freeze([TEST_USERNAME_B, TEST_USERNAME_A, TEST_USERNAME_B]),
  }));
  assert.deepEqual(selection, {
    targetUserId: OTHER_USER_ID,
    targetNamed: true,
    selfSalesforceUsername: null,
    allowedUsernames: [TEST_USERNAME_A, TEST_USERNAME_B],
  });
});

test('omitting targetUserId means the requesting user, whose own route is the one the query is scoped by', () => {
  const selection = selectFieldAccessSubject(undefined, targetUsers());
  assert.equal(selection.targetNamed, false);
  assert.equal(selection.targetUserId, null);
  assert.equal(selection.selfSalesforceUsername, TEST_USERNAME_A);
  // The boundary applies to a self-subject too: a user whose own route has been disabled is not somebody
  // this Tool explains access for, so the same `Username IN (…)` clause scopes the self query.
  assert.deepEqual(selection.allowedUsernames, [TEST_USERNAME_A, TEST_USERNAME_B]);
});

test('a runtime with no configured routes refuses a named target rather than explaining it', () => {
  assert.throws(
    () => selectFieldAccessSubject(OTHER_USER_ID, targetUsers({ configuredSalesforceUsernames: Object.freeze([]) })),
    (thrown: unknown) => thrown instanceof ContextRuntimeError
      && thrown.code === 'MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED',
  );
});

test('a request with no route of its own is refused instead of answering INDETERMINATE for every field', () => {
  // This is the honest outcome rather than a table of gaps: a conclusion is a claim *about a user*, and a
  // deployment that does not know which Salesforce user is asking cannot make one.
  for (const self of [null, '', '   ']) {
    assert.throws(
      () => selectFieldAccessSubject(undefined, targetUsers({ selfSalesforceUsername: self })),
      (thrown: unknown) => thrown instanceof ContextRuntimeError
        && thrown.code === 'MCP_DIAGNOSTIC_PREREQUISITE_MISSING'
        && thrown.prerequisite === 'requesting-user route unavailable',
    );
  }
});

test('a deployment above the route bound refuses, rather than silently narrowing the set to the first N', () => {
  const over = Array.from({ length: FIELD_ACCESS_MAX_ROUTE_USERNAMES + 1 }, (_, index) => `u${index}@example.test`);
  const error = (() => {
    try {
      selectFieldAccessSubject(undefined, targetUsers({ configuredSalesforceUsernames: Object.freeze(over) }));
    } catch (thrown) {
      return thrown;
    }
    return null;
  })();
  assert.ok(error instanceof ContextRuntimeError);
  assert.equal(error.code, 'MCP_DIAGNOSTIC_PREREQUISITE_MISSING');
  assert.equal(error.prerequisite, `identity routes > ${FIELD_ACCESS_MAX_ROUTE_USERNAMES}`);
  assert.equal(
    selectFieldAccessSubject(undefined, targetUsers({
      configuredSalesforceUsernames: Object.freeze(over.slice(0, FIELD_ACCESS_MAX_ROUTE_USERNAMES)),
    })).allowedUsernames.length,
    FIELD_ACCESS_MAX_ROUTE_USERNAMES,
  );
});

test('the refusal carries no prerequisite, because it is the Tool\'s own boundary and not a missing deployment step', () => {
  const error = (() => {
    try {
      selectFieldAccessSubject(OTHER_USER_ID, targetUsers({ configuredSalesforceUsernames: Object.freeze([]) }));
    } catch (thrown) {
      return thrown;
    }
    return null;
  })();
  assert.ok(error instanceof ContextRuntimeError);
  assert.equal(error.prerequisite, undefined);
  // The suggestion is where the indistinguishability is stated, so an operator does not read the refusal
  // as "that Id does not exist".
  assert.match(error.suggestion ?? '', /the same whether or not the Id names a user/u);
});

test('the environment runtime derives its route set from the routes it actually resolves calls through', () => {
  const routes = [
    { platformUserId: TEST_PLATFORM_USER_A, salesforceUsername: TEST_USERNAME_A },
    { platformUserId: TEST_PLATFORM_USER_B, salesforceUsername: TEST_USERNAME_B },
  ];
  const users = envFieldAccessTargetUsers(routes, TEST_PLATFORM_USER_A);
  assert.equal(users.selfSalesforceUsername, TEST_USERNAME_A);
  assert.deepEqual([...users.configuredSalesforceUsernames], [TEST_USERNAME_A, TEST_USERNAME_B]);
  // A platform user with no route of its own has no self-subject, which is what makes the refusal above
  // reachable on this runtime rather than an answer about nobody.
  assert.equal(envFieldAccessTargetUsers(routes, 'p2-user-c').selfSalesforceUsername, null);
  assert.equal(envFieldAccessTargetUsers([], TEST_PLATFORM_USER_A).selfSalesforceUsername, null);
});

// ---------------------------------------------------------------------------------------------
// The emitted statements
// ---------------------------------------------------------------------------------------------

test('the subject query carries the boundary inside it, and every layer query is scoped to the subject\'s permission sets', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.fieldPermissions = [grantRow(PROFILE_PS_ID, 'Name', true, true)];
    await explain(scopes, { objectApiName: OBJECT, fieldApiNames: ['Name'], includeRecordTypeContext: false });

    const [subject, assignments, sets, objectRows, fieldRows] = scopes.factory.queries;
    // A self-subject: the requesting user's route is the scope, and the allowed list narrows it. The
    // boundary is *inside* the query, which is why a non-configured Id and a nonexistent Id are the same
    // answer rather than the same convention.
    assert.equal(
      subject,
      `SELECT Id, Username, IsActive FROM User WHERE Username = '${TEST_USERNAME_A}' `
        + `AND Username IN ('${TEST_USERNAME_A}', '${TEST_USERNAME_B}') LIMIT 1`,
    );
    assert.equal(
      assignments,
      `SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${SUBJECT_ID}'`,
    );
    // Two measured steps rather than a `PermissionSetAssignment.PermissionSet.Profile.Name` traversal: the
    // two-level path was never measured on a live org, and an unmeasured traversal is an `INVALID_FIELD`
    // that takes the whole Tool down.
    assert.equal(
      sets,
      'SELECT Id, Name, Label, IsOwnedByProfile, Profile.Name FROM PermissionSet '
        + `WHERE Id IN ('${PROFILE_PS_ID}', '${STANDALONE_PS_ID}')`,
    );
    assert.equal(
      objectRows,
      'SELECT ParentId, PermissionsRead, PermissionsEdit, PermissionsViewAllRecords FROM ObjectPermissions '
        + `WHERE SobjectType = '${OBJECT}' AND ParentId IN ('${PROFILE_PS_ID}', '${STANDALONE_PS_ID}')`,
    );
    // Both spellings of every field are sent, because whether this org qualifies `FieldPermissions.Field`
    // was never measured and getting it wrong has no error — the query simply returns nothing and every
    // field would read as ungranted.
    assert.equal(
      fieldRows,
      'SELECT ParentId, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions '
        + `WHERE SobjectType = '${OBJECT}' AND Field IN ('Name', '${OBJECT}.Name') `
        + `AND ParentId IN ('${PROFILE_PS_ID}', '${STANDALONE_PS_ID}') LIMIT 2000`,
    );
    // No record-type read at all when the caller turns the context off, and no query without a WHERE for
    // `RecordType` — its filterability was never measured either.
    assert.equal(scopes.factory.queries.some((query) => query.includes('FROM RecordType')), false);
  } finally {
    await scopes.close();
  }
});

test('a named target is resolved by Id under the same route clause, and every layer below is scoped to that user', async () => {
  // The target's own assignments, so the layers under the subject query have a subject to read: without
  // them the permission-set list is empty and the two `ParentId IN (…)` queries are correctly skipped,
  // which would make this test assert the shape of an answer about nobody.
  const factory = seeded();
  factory.assignments = [
    ...factory.assignments,
    assignmentRow(3, PROFILE_PS_ID, OTHER_USER_ID),
    assignmentRow(4, STANDALONE_PS_ID, OTHER_USER_ID),
  ];
  const scopes = await createScopes(factory);
  try {
    const output = await explain(scopes, {
      objectApiName: OBJECT, fieldApiNames: ['Name'], targetUserId: OTHER_USER_ID, includeRecordTypeContext: false,
    });
    // The boundary is *inside* this query, which is the whole reason the two refusal cases below cannot
    // be told apart: the Id is checked by the same statement that would have returned the row.
    assert.match(
      scopes.factory.queries[0] ?? '',
      new RegExp(`^SELECT Id, Username, IsActive FROM User WHERE Id = '${OTHER_USER_ID}' AND Username IN `, 'u'),
    );
    // Five layers and nothing else: the subject, the assignments, the sets, the object rows, the field rows.
    assert.equal(scopes.factory.queries.length, 5);
    assert.equal(output.userContext?.userId, OTHER_USER_ID);
    assert.equal(output.userContext?.isRequestingUser, false);
    assert.equal(output.userContext?.isActive, true);
    // The subject that was resolved is the target rather than the requester, so the permission-set list is
    // the target's — the assertion a wrong `AssigneeId` would fail.
    assert.equal(output.userContext?.permissionSets?.length, 2);
    assert.ok(scopes.factory.queries.some((query) => query.includes(`AssigneeId = '${OTHER_USER_ID}'`)));
  } finally {
    await scopes.close();
  }
});

test('a target outside the routes and a target that names nobody give one answer, for one read', async () => {
  // Not merely the same code: the same message, byte for byte. Telling the two apart is exactly what
  // would turn this Tool into an account-existence oracle, so the assertion is on the whole refusal.
  const messages: string[] = [];
  for (const id of [OTHER_USER_ID, '005000000000009AAA']) {
    const scopes = await createScopes();
    try {
      const error = await rejection(new ScopedFieldAccessExplainer(
        scopes.diagnostic,
        ALL_TOOLS,
        // `user-b` is a real user in the fixture's `User` table, and the route list does not carry them:
        // the empty result set is produced by the boundary clause, not by the row being absent.
        targetUsers({ configuredSalesforceUsernames: Object.freeze([TEST_USERNAME_A]) }),
      ).execute({ objectApiName: OBJECT, fieldApiNames: ['Name'], targetUserId: id } as never));
      assert.equal(error.code, 'MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED');
      messages.push(error.message);
      // One read, and it is the subject lookup. The boundary is a clause inside it rather than a check
      // before it, so a refusal cannot cost less than that — what it *can* do, and does, is stop there:
      // no layer below a subject that was never resolved is ever queried.
      assert.equal(scopes.factory.queries.length, 1, `${id} must cost exactly the subject read`);
      assert.match(scopes.factory.queries[0] ?? '', /^SELECT Id, Username, IsActive FROM User WHERE /u);
    } finally {
      await scopes.close();
    }
  }
  assert.equal(messages[0], messages[1]);
});

test('a USER request scope can never run this Tool, and never opens a Connection trying', async () => {
  const scopes = await createScopes();
  try {
    const error = await rejection(new ScopedFieldAccessExplainer(scopes.user, ALL_TOOLS, targetUsers())
      .execute({ objectApiName: OBJECT, fieldApiNames: ['Name'] } as never));
    assert.equal(error.code, 'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED');
    assert.match(error.message, /explain_field_access requires the fixed server-owned DIAGNOSTIC request scope/u);
    assert.deepEqual(scopes.factory.creations, []);
    assert.deepEqual(scopes.factory.queries, []);
  } finally {
    await scopes.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Aggregation: profile, permission set, object layer
// ---------------------------------------------------------------------------------------------

test('a profile that denies edit and a permission set that grants it produce an editable field with the disagreement named', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.fieldPermissions = [
      grantRow(PROFILE_PS_ID, 'Name', true, false),
      grantRow(STANDALONE_PS_ID, 'Name', true, true),
    ];
    const output = await explain(scopes, { objectApiName: OBJECT, fieldApiNames: ['Name'] });

    const field = fieldOf(output, 0);
    assert.equal(field.fieldApiName, 'Name');
    assert.equal(field.conclusion.visible, true);
    assert.equal(field.conclusion.editable, true);
    assert.deepEqual(field.grants.map((grant) => [grant.parentType, grant.parentName, grant.permissionsRead, grant.permissionsEdit]), [
      // The row order is the query's row order, and a profile-owned grant is a `PROFILE` because the
      // administrator changes it under Profiles rather than under Permission Sets.
      ['PROFILE', 'System_Administrator', true, false],
      ['PERMISSION_SET', 'SFOA_Field_Editor', true, true],
    ]);
    // The label is the org's translated one, reported and never matched on.
    assert.equal(field.grants[0]?.parentLabel, '系统管理员');
    assert.equal(
      field.conclusion.conflicts.some((conflict) => conflict.includes('No profile-owned grant carries edit')),
      true,
    );
    assert.match(hintOf(output), /This user holds a read and edit grant on every field reported/u);
  } finally {
    await scopes.close();
  }
});

test('a profile that grants nothing and a permission set that grants everything is reported as the union it is', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.fieldPermissions = [
      grantRow(PROFILE_PS_ID, 'Name', false, false),
      grantRow(STANDALONE_PS_ID, 'Name', true, true),
    ];
    const field = fieldOf(await explain(scopes, { objectApiName: OBJECT, fieldApiNames: ['Name'] }), 0);
    assert.equal(field.conclusion.visible, true);
    assert.equal(field.conclusion.editable, true);
    // Reading the profile in Setup and stopping would read as a denial of visibility, which is the whole
    // reason the two layers are reported side by side.
    assert.equal(
      field.conclusion.conflicts.some((conflict) => conflict.includes('No profile-owned grant carries read')),
      true,
    );
  } finally {
    await scopes.close();
  }
});

test('an object layer with no readable row is INDETERMINATE, never a denial', async () => {
  const scopes = await createScopes();
  try {
    // The permission sets exist and their field rows are readable, but no `ObjectPermissions` row came
    // back for either — which is a gap in the read, not a refusal by the org.
    scopes.factory.objectPermissions = [];
    scopes.factory.fieldPermissions = [grantRow(PROFILE_PS_ID, 'Name', true, true)];
    const output = await explain(scopes, { objectApiName: OBJECT, fieldApiNames: ['Name'] });

    const field = fieldOf(output, 0);
    assert.equal(field.conclusion.visible, FIELD_ACCESS_INDETERMINATE);
    assert.equal(field.conclusion.editable, FIELD_ACCESS_INDETERMINATE);
    assert.notEqual(field.conclusion.visible, false);
    assert.equal(field.conclusion.sourceChain[0], 'object-visibility: unreadable');
    // The layer is named for the reader, in the caveat and in the hint — and the hint says out loud that
    // INDETERMINATE is not a refusal.
    assert.match(field.conclusion.caveats[0] ?? '', /gap in the evidence, not a denial/u);
    assert.match(hintOf(output), /INDETERMINATE is a gap in the evidence and not a denial/u);
    assert.deepEqual(output.userContext?.objectAccess?.unreadableParentIds, [PROFILE_PS_ID, STANDALONE_PS_ID]);
  } finally {
    await scopes.close();
  }
});

test('a subject whose permission-set list lacks the profile-owned set is INDETERMINATE when no grant was found', async () => {
  const scopes = await createScopes();
  try {
    // Only a standalone set is assigned, and it has rows for a different field. Every layer that could
    // decide was read except the baseline every internal user holds — so absence cannot be read as a
    // refusal, and the answer says which layer was never queried.
    scopes.factory.assignments = [assignmentRow(1, STANDALONE_PS_ID, SUBJECT_ID)];
    scopes.factory.permissionSets = [permissionSetRow(STANDALONE_PS_ID, 'SFOA_Field_Editor')];
    scopes.factory.objectPermissions = [objectRow(STANDALONE_PS_ID, true, true, false)];
    scopes.factory.fieldPermissions = [];
    const output = await explain(scopes, { objectApiName: OBJECT, fieldApiNames: ['Name'] });

    const field = fieldOf(output, 0);
    assert.equal(field.conclusion.visible, FIELD_ACCESS_INDETERMINATE);
    assert.match(field.conclusion.caveats[0] ?? '', /profile-owned set every internal user holds/u);
    assert.match(hintOf(output), /the baseline layer was never queried/u);
    assert.equal(output.userContext?.permissionSets?.[0]?.isOwnedByProfile, false);
  } finally {
    await scopes.close();
  }
});

test('a subject whose permission-set list was cut short is INDETERMINATE rather than a partial answer', async () => {
  const scopes = await createScopes();
  try {
    // 201 assigned sets: the list is bounded at 200, and a bounded list produces a wrong answer rather
    // than a shorter one, so the truncation is reported and the conclusion is a gap.
    const ids = Array.from({ length: 201 }, (_, index) => `0PS${String(index + 10).padStart(12, '0')}AAA`);
    scopes.factory.assignments = ids.map((id, index) => assignmentRow(index, id, SUBJECT_ID));
    scopes.factory.permissionSets = ids.map((id, index) => permissionSetRow(id, `PS_${index}`));
    scopes.factory.objectPermissions = ids.map((id) => objectRow(id, true, true, false));
    scopes.factory.fieldPermissions = [];
    const output = await explain(scopes, { objectApiName: OBJECT, fieldApiNames: ['Name'] });

    assert.equal(output.userContext?.permissionSetsTruncated, true);
    assert.equal(output.userContext?.permissionSets?.length, 200);
    assert.equal(fieldOf(output, 0).conclusion.visible, FIELD_ACCESS_INDETERMINATE);
    assert.equal(fieldOf(output, 0).conclusion.sourceChain[0], 'subject-permission-sets: TRUNCATED');
    assert.match(hintOf(output), /permission-set list was cut short/u);
  } finally {
    await scopes.close();
  }
});

test('an object-level denial is reported as a denial, with the field grant that cannot take effect still shown', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.objectPermissions = [
      objectRow(PROFILE_PS_ID, false, false, false),
      objectRow(STANDALONE_PS_ID, false, false, false),
    ];
    scopes.factory.fieldPermissions = [grantRow(PROFILE_PS_ID, 'Name', true, true)];
    const field = fieldOf(await explain(scopes, { objectApiName: OBJECT, fieldApiNames: ['Name'] }), 0);
    assert.equal(field.conclusion.visible, false);
    assert.equal(field.conclusion.editable, false);
    assert.equal(field.grants.length, 1);
    assert.equal(
      field.conclusion.conflicts.some((conflict) => conflict.includes('no object-level read grant')),
      true,
    );
  } finally {
    await scopes.close();
  }
});

test('a row stored with the object-qualified field name lands on the caller\'s bare name', async () => {
  const scopes = await createScopes();
  try {
    // Both spellings are sent; this is the half where the org stores the qualifier. Without the
    // normalization the field would read as entirely ungranted and the answer would be silently wrong.
    scopes.factory.fieldPermissions = [grantRow(PROFILE_PS_ID, `${OBJECT}.Name`, true, true)];
    const field = fieldOf(await explain(scopes, { objectApiName: OBJECT, fieldApiNames: ['Name'] }), 0);
    assert.equal(field.conclusion.visible, true);
    assert.equal(field.conclusion.editable, true);
    assert.equal(field.grants.length, 1);
  } finally {
    await scopes.close();
  }
});

test('a grant row for a field the caller did not ask about is not attributed to a field that was asked about', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.fieldPermissions = [
      grantRow(PROFILE_PS_ID, 'Name', true, true),
      grantRow(PROFILE_PS_ID, 'OwnerId', true, true),
    ];
    const output = await explain(scopes, { objectApiName: OBJECT, fieldApiNames: ['Name'] });
    assert.equal(fieldOf(output, 0).grants.length, 1);
    assert.equal(output.requestedFieldCount, 1);
    assert.equal(output.returnedFieldCount, 1);
  } finally {
    await scopes.close();
  }
});

// ---------------------------------------------------------------------------------------------
// describe is never allowed to decide a conclusion
// ---------------------------------------------------------------------------------------------

test('describe facts are reported as the executing identity\'s view and never decide the subject\'s conclusion', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.fieldPermissions = [grantRow(STANDALONE_PS_ID, 'Name', true, true)];
    // The DIAGNOSTIC account's own describe says this field is read-only for it. Mixed into a named
    // user's answer it would report the service account's field-level security as theirs — the specific
    // correctness trap the probe named (P10_T0_LIVE_PROBE_FINDINGS.md §6).
    scopes.factory.describe = (objectApiName) => ({
      name: objectApiName,
      fields: [{ name: 'Name', label: 'Account Name', type: 'string', createable: false, updateable: false, accessible: false }],
    });
    const field = fieldOf(await explain(scopes, { objectApiName: OBJECT, fieldApiNames: ['Name'] }), 0);

    assert.equal(field.describeFacts?.executionIdentityView, true);
    assert.equal(field.describeFacts?.updateable, false);
    // The conclusion follows the permission rows and not the describe.
    assert.equal(field.conclusion.editable, true);
    assert.equal(field.conclusion.visible, true);
  } finally {
    await scopes.close();
  }
});

test('a describe that fails degrades to null facts rather than failing the call', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.fieldPermissions = [grantRow(PROFILE_PS_ID, 'Name', true, true)];
    scopes.factory.describeError = Object.assign(new Error('describe is unavailable'), { errorCode: 'NOT_FOUND' });
    const output = await explain(scopes, { objectApiName: OBJECT, fieldApiNames: ['Name'] });

    const field = fieldOf(output, 0);
    assert.equal(field.describeFacts, null);
    // The field answer the caller asked for is unaffected, so the failure stays local.
    assert.equal(field.conclusion.visible, true);
    assert.equal(field.conclusion.editable, true);
  } finally {
    await scopes.close();
  }
});

test('a field the describe does not carry is reported as a possible name mistake rather than hidden', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.fieldPermissions = [grantRow(PROFILE_PS_ID, 'Ghost__c', true, true)];
    const output = await explain(scopes, { objectApiName: OBJECT, fieldApiNames: ['Ghost__c'] });
    const field = fieldOf(output, 0);
    assert.deepEqual(field.describeFacts, {
      type: null, label: null, createable: null, updateable: null, accessible: null, executionIdentityView: true,
    });
    assert.equal(
      field.conclusion.caveats.some((caveat) => caveat.includes('did not carry this field name')),
      true,
    );
  } finally {
    await scopes.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------------------------

test('the record-type context is read by default, and its availability to the subject is INDETERMINATE', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.fieldPermissions = [grantRow(PROFILE_PS_ID, 'Name', true, true)];
    scopes.factory.recordTypes = [
      { Id: '012000000000001AAA', DeveloperName: 'Master', Name: 'Master', SobjectType: OBJECT, IsActive: true },
      { Id: '012000000000002AAA', DeveloperName: 'Other', Name: 'Other', SobjectType: 'Lead', IsActive: true },
    ];
    const output = await explain(scopes, { objectApiName: OBJECT, fieldApiNames: ['Name'] });

    // Read with no `WHERE` clause: `RecordType.SobjectType` filterability was never measured, so the
    // narrowing happens in memory where it cannot fail the call.
    assert.equal(scopes.factory.queries.some((query) => query.includes('FROM RecordType')), true);
    assert.equal(scopes.factory.queries.some((query) => /FROM RecordType WHERE/u.test(query)), false);
    // Only this object's record types, filtered in memory.
    assert.deepEqual(output.recordTypeContext?.recordTypes.map((recordType) => recordType.developerName), ['Master']);
    assert.equal(output.recordTypeContext?.availableToSubject, FIELD_ACCESS_INDETERMINATE);
    assert.notEqual(output.recordTypeContext?.availableToSubject, false);
    assert.deepEqual(output.recordTypeContext?.availableToExecutionIdentity, []);
  } finally {
    await scopes.close();
  }
});

test('turning the record-type context off omits it entirely, and a failed record-type read does not fail the call', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.fieldPermissions = [grantRow(PROFILE_PS_ID, 'Name', true, true)];
    const off = await explain(scopes, {
      objectApiName: OBJECT, fieldApiNames: ['Name'], includeRecordTypeContext: false,
    });
    assert.equal(off.recordTypeContext, undefined);
    assert.equal(scopes.factory.queries.some((query) => query.includes('FROM RecordType')), false);

    scopes.factory.queryErrors = [{
      match: 'FROM RecordType',
      error: Object.assign(new Error('no access'), { errorCode: 'INSUFFICIENT_ACCESS' }),
    }];
    const degraded = await explain(scopes, { objectApiName: OBJECT, fieldApiNames: ['Name'] });
    // It is context, not the answer: nothing in a conclusion depends on it, so it is simply absent.
    assert.equal(degraded.recordTypeContext, undefined);
    assert.equal(fieldOf(degraded, 0).conclusion.visible, true);
  } finally {
    await scopes.close();
  }
});

// ---------------------------------------------------------------------------------------------
// ADR-0029 §3: degradation and the response budget
// ---------------------------------------------------------------------------------------------

test('a permission refusal on the diagnostic identity is a structured prerequisite, not an empty answer', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.queryErrors = [{
      match: 'FROM FieldPermissions',
      error: Object.assign(new Error('insufficient access'), { errorCode: 'INSUFFICIENT_ACCESS' }),
    }];
    const error = await rejection(new ScopedFieldAccessExplainer(scopes.diagnostic, ALL_TOOLS, targetUsers())
      .execute({ objectApiName: OBJECT, fieldApiNames: ['Name'] } as never));
    assert.equal(error.code, 'MCP_DIAGNOSTIC_PREREQUISITE_MISSING');
    assert.equal(error.prerequisite, 'permission-table readability on the diagnostic identity');
    assert.equal(error.salesforceErrorCode, 'INSUFFICIENT_ACCESS');
    // The suggestion names the surface and the permission, because that is what an operator can act on.
    assert.match(error.suggestion ?? '', /View Setup and Configuration/u);
  } finally {
    await scopes.close();
  }
});

test('any other read failure is its own code, so a transient failure is never read as a permission decision', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.queryErrors = [{
      match: 'FROM ObjectPermissions',
      error: Object.assign(new Error('socket hang up'), { errorCode: 'UNKNOWN_EXCEPTION' }),
    }];
    const error = await rejection(new ScopedFieldAccessExplainer(scopes.diagnostic, ALL_TOOLS, targetUsers())
      .execute({ objectApiName: OBJECT, fieldApiNames: ['Name'] } as never));
    assert.equal(error.code, 'MCP_FIELD_ACCESS_READ_FAILED');
    assert.equal(error.prerequisite, undefined);
    // A failed read never returns an empty field list, because an empty list would read as "nothing is
    // granted" — the failure mode the T2 prohibition on silent empty results exists to prevent.
    assert.match(error.suggestion ?? '', /A failed read never returns an empty field list/u);
  } finally {
    await scopes.close();
  }
});

test('a response that exceeds the byte budget is truncated with the requested count still reported', async () => {
  const scopes = await createScopes();
  try {
    // 60 permission sets with long labels granting all ten fields: 60 rows per field, sliced to 50, over
    // ten fields. The labels are what make the payload exceed the 256 KiB budget — nothing else about the
    // fixture is large, so the truncation can only come from the budget.
    const ids = Array.from({ length: 60 }, (_, index) => `0PS${String(index + 10).padStart(12, '0')}AAA`);
    const long = 'L'.repeat(1_000);
    scopes.factory.assignments = ids.map((id, index) => assignmentRow(index, id, SUBJECT_ID));
    scopes.factory.permissionSets = ids.map((id, index) => permissionSetRow(id, `${long}${index}`));
    scopes.factory.objectPermissions = ids.map((id) => objectRow(id, true, true, false));
    const fieldApiNames = Array.from({ length: 10 }, (_, index) => `Field${index}__c`);
    scopes.factory.fieldPermissions = ids.flatMap((id) => (
      fieldApiNames.map((field) => grantRow(id, field, true, true))
    ));

    const output = await explain(scopes, { objectApiName: OBJECT, fieldApiNames });

    assert.equal(output.truncated, true);
    assert.equal(output.requestedFieldCount, 10);
    const returned = output.returnedFieldCount ?? 0;
    assert.ok(returned >= 1 && returned < 10, `expected a partial answer, got ${returned} of 10 fields`);
    assert.equal(output.fields?.length, returned);
    // The per-field grant list is bounded too, and that bound is reported rather than applied silently.
    assert.equal(fieldOf(output, 0).grants.length, 50);
    assert.equal(fieldOf(output, 0).grantsTruncated, true);
    assert.match(hintOf(output), /dropped to fit the server's response budget/u);
    assert.match(hintOf(output), /Re-run with fewer fieldApiNames/u);
  } finally {
    await scopes.close();
  }
});

test('a response inside the budget reports no truncation and every field it was asked about', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.fieldPermissions = [grantRow(PROFILE_PS_ID, 'Name', true, true)];
    const output = await explain(scopes, { objectApiName: OBJECT, fieldApiNames: ['Name', 'OwnerId'] });
    assert.equal(output.truncated, false);
    assert.equal(output.requestedFieldCount, 2);
    assert.equal(output.returnedFieldCount, 2);
    assert.equal(output.executionRole, 'DIAGNOSTIC');
    assert.equal(output.api, 'STANDARD');
    assert.equal(output.success, true);
    assert.equal(output.objectApiName, OBJECT);
  } finally {
    await scopes.close();
  }
});

// ---------------------------------------------------------------------------------------------
// The answer carries permission facts and no business data
// ---------------------------------------------------------------------------------------------

test('the answer is permission facts only, and no input could carry a record even if a caller tried', async () => {
  // "It does not read business data" is a claim about two different surfaces, so it is asserted on both.
  //
  // The **input** first: there is no parameter that could carry a record Id, a filter or a field *value*.
  // The red line is therefore not merely respected by the implementation — it is unexpressible through the
  // Tool's interface. `fieldApiNames` is the only caller-controlled string that reaches a query, and the
  // schema pins it to a bare API name, refusing a relationship path; the caller's object is a filter value
  // on the permission tables and a `describe` target, never a query target.
  assert.deepEqual(
    Object.keys(explainFieldAccessInputSchema.shape).sort(),
    ['fieldApiNames', 'includeRecordTypeContext', 'objectApiName', 'targetUserId'],
  );
  const scopes = await createScopes();
  try {
    scopes.factory.fieldPermissions = [
      grantRow(PROFILE_PS_ID, 'Name', true, true),
      grantRow(STANDALONE_PS_ID, 'Account.Name', true, false),
    ];
    const output = await explain(scopes, { objectApiName: OBJECT, fieldApiNames: ['Name'] });
    // The output, key by key. The schema is `.strict()`, so the parse in `explain` already refuses an
    // undeclared key; asserting the key set here is what makes adding one a deliberate act rather than a
    // parse that happens to pass. Every key below is a permission fact, the subject it is about, or a
    // statement about the reading of one — and none of them has a place to put a field value.
    assert.deepEqual(Object.keys(output).sort(), [
      'api', 'executionRole', 'fields', 'hint', 'objectApiName', 'objectLabel', 'recordTypeContext',
      'requestedFieldCount', 'returnedFieldCount', 'success', 'truncated', 'userContext',
    ]);
    const field = fieldOf(output, 0);
    assert.deepEqual(
      Object.keys(field).sort(),
      ['conclusion', 'describeFacts', 'fieldApiName', 'grants', 'grantsTruncated'],
    );
    // `describeFacts` is the one place the object's own metadata appears, and it carries field
    // *definitions* — a type, a label and three flags. The subject's grants beside it are rows keyed by
    // permission-set Id, and the conclusion is prose about those rows.
    assert.deepEqual(
      Object.keys(field.describeFacts ?? {}).sort(),
      ['accessible', 'createable', 'executionIdentityView', 'label', 'type', 'updateable'],
    );
    assert.deepEqual(
      Object.keys(field.grants?.[0] ?? {}).sort(),
      ['parentId', 'parentLabel', 'parentName', 'parentType', 'permissionsEdit', 'permissionsRead'],
    );
  } finally {
    await scopes.close();
  }
});

// ---------------------------------------------------------------------------------------------
// The hint may only name a Tool this session advertises
// ---------------------------------------------------------------------------------------------

test('the hint names the metadata Tool only when the session advertises it', async () => {
  for (const [advertised, shouldName] of [
    [ALL_TOOLS, true],
    [ALL_TOOLS.filter((name) => name !== 'get_metadata_component_context'), false],
  ] as const) {
    const scopes = await createScopes();
    try {
      scopes.factory.fieldPermissions = [grantRow(PROFILE_PS_ID, 'Name', true, true)];
      const output = await explain(scopes, { objectApiName: OBJECT, fieldApiNames: ['Name'] }, targetUsers(), advertised);
      const hint = hintOf(output);
      assert.equal(
        hint.includes('get_metadata_component_context'),
        shouldName,
        `advertised=${advertised.join(',')}`,
      );
      // The non-permission caveat is present either way; only the Tool name is gated. A hint that named a
      // Tool the caller's own tool list does not carry would send an Agent to a name it cannot call.
      assert.match(hint, /validation rule, a field dependency or a read-only page layout/u);
    } finally {
      await scopes.close();
    }
  }
});

test('the hint offers the targetUserId form only when a target could actually have been named', async () => {
  const open = await createScopes();
  try {
    open.factory.fieldPermissions = [grantRow(PROFILE_PS_ID, 'Name', true, true)];
    assert.match(
      hintOf(await explain(open, { objectApiName: OBJECT, fieldApiNames: ['Name'] })),
      /call this Tool again with targetUserId/u,
    );
    assert.doesNotMatch(
      hintOf(await explain(open, { objectApiName: OBJECT, fieldApiNames: ['Name'] }, targetUsers({ configuredSalesforceUsernames: Object.freeze([]) }))),
      /call this Tool again with targetUserId/u,
    );
    // A named target is never told to name another one.
    assert.doesNotMatch(
      hintOf(await explain(open, { objectApiName: OBJECT, fieldApiNames: ['Name'], targetUserId: OTHER_USER_ID })),
      /call this Tool again with targetUserId/u,
    );
  } finally {
    await open.close();
  }
});

// ---------------------------------------------------------------------------------------------
// The facade: role gate, audit purpose and audit summaries
// ---------------------------------------------------------------------------------------------

test('the facade refuses a USER route, audits it as BLOCKED, and never reaches the executor', async () => {
  const logger = new RecordingLogger();
  let executions = 0;
  const explainer: FieldAccessExplainer = {
    execute: async () => {
      executions += 1;
      throw new Error('the facade must not reach the executor on a USER route');
    },
  };
  const facade = new ContextToolFacade({
    tool: new ExplainFieldAccessMcpTool(explainer),
    context: {
      platformUserId: TEST_PLATFORM_USER_A,
      correlationId: 'fieldaccess-facade-user',
      workspaceRoot: process.cwd(),
    } as unknown as RequestContext,
    route: createSalesforceIdentityRoute({
      platformUserId: TEST_PLATFORM_USER_A,
      salesforceUsername: TEST_USERNAME_A,
      credentialProfile: 'sfoa-shared-jwt-user',
      connectionRole: 'USER',
      aliases: [],
    }),
    toolTimeoutMs: 1_000,
    logger,
    clientId: 'test-client',
  });

  const result = await facade.execute({ objectApiName: OBJECT, fieldApiNames: ['Name'] }, {} as never);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.errorCode, 'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED');
  assert.match(String(result.structuredContent?.message), /fixed to the DIAGNOSTIC execution role/u);
  assert.equal(executions, 0);
  const terminal = logger.events.find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
  assert.equal(terminal?.result, 'BLOCKED');
  assert.equal(terminal?.outcome, 'DENIED');
  assert.equal(terminal?.errorCode, 'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED');
});

test('the audit row records whose access was explained and which fields were asked about', async () => {
  const logger = new RecordingLogger();
  const scopes = await createScopes();
  try {
    scopes.factory.fieldPermissions = [grantRow(PROFILE_PS_ID, 'Name', true, true)];
    const explainer = new ScopedFieldAccessExplainer(scopes.diagnostic, ALL_TOOLS, targetUsers());
    const facade = new ContextToolFacade({
      tool: new ExplainFieldAccessMcpTool(explainer),
      context: {
        platformUserId: TEST_PLATFORM_USER_A,
        correlationId: 'fieldaccess-facade-summary',
        workspaceRoot: process.cwd(),
      } as unknown as RequestContext,
      route: createSalesforceIdentityRoute({
        platformUserId: TEST_PLATFORM_USER_A,
        salesforceUsername: TEST_DIAGNOSTIC_USERNAME,
        credentialProfile: 'sfoa-shared-jwt-diagnostic',
        connectionRole: 'DIAGNOSTIC',
        aliases: [],
      }),
      toolTimeoutMs: 5_000,
      logger,
      clientId: 'test-client',
    });

    const result = await facade.execute({
      objectApiName: OBJECT, fieldApiNames: ['Name', 'OwnerId'], targetUserId: OTHER_USER_ID,
      includeRecordTypeContext: false,
    }, {} as never);

    assert.equal(result.isError, undefined);
    const terminal = logger.events.find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
    assert.equal(terminal?.executionRole, 'DIAGNOSTIC');
    // ADR-0029 §4d: a permission explanation is only auditable if the subject is on the row. The field
    // names are keys into the permission configuration and no value is ever read from them.
    assert.deepEqual(terminal?.requestSummary, {
      objectApiName: OBJECT,
      targetUserId: OTHER_USER_ID,
      fieldApiNames: ['Name', 'OwnerId'],
      fieldCount: 2,
      includeRecordTypeContext: false,
    });
    const summary = terminal?.responseSummary as Record<string, unknown>;
    assert.equal(summary.requestedFieldCount, 2);
    assert.equal(summary.fieldCount, 2);
    assert.equal(summary.truncated, false);
    // The response summary is counts and flags, never the permission rows themselves.
    assert.equal(JSON.stringify(terminal?.responseSummary).includes('System_Administrator'), false);
    assert.equal(JSON.stringify(terminal?.responseSummary).includes('SFOA_Field_Editor'), false);

    // A second call, omitting the switch. The row must record the value the Tool *ran with*: an omitted
    // argument is not "off", and a row reading `false` beside a response that carried `recordTypeContext`
    // would describe a call that did not happen.
    const defaulted = await facade.execute({ objectApiName: OBJECT, fieldApiNames: ['Name'] }, {} as never);
    assert.equal(defaulted.isError, undefined);
    assert.notEqual(
      (defaulted.structuredContent as Record<string, unknown>).recordTypeContext,
      undefined,
      'the default must actually read the record-type context, or the audit assertion below proves nothing',
    );
    const second = logger.events.filter((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL')[1];
    assert.deepEqual(second?.requestSummary, {
      objectApiName: OBJECT,
      targetUserId: null,
      fieldApiNames: ['Name'],
      fieldCount: 1,
      includeRecordTypeContext: true,
    });
  } finally {
    await scopes.close();
  }
});

test('the permission explanation is audited under its own purpose, separate from the Tooling query purpose', async () => {
  const { readFile } = await import('node:fs/promises');
  // The purpose is attached to the Salesforce API audit records the instrumented Connection emits, which
  // this fixture deliberately does not model, so reading the table is the only way to fail when a later
  // edit folds the two together. The distinction matters for the reason the map's own comment gives: this
  // Tool issues no Tooling query at all, and the audit's question is a different one.
  const source = await readFile(new URL('../context-tool-facade.js', import.meta.url), 'utf8');
  assert.match(source, /explain_field_access: 'PERMISSION_EXPLAIN'/u);
});
