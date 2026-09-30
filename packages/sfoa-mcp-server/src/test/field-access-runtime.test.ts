import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CwdExecutionGuard,
  RequestWorkspaceFactory,
  createIdentityRuntime,
  type RuntimeLogEvent,
  type RuntimeLogger,
} from '@sfoa/identity-runtime';
import { startRemoteMcpServer, type RemoteMcpServer } from '../http-server.js';
import { DEFAULT_ENABLED_TOOLS } from '../tool-governance.js';
import {
  createTestRemoteConfig,
  RecordingConnectionFactory,
  TEST_CLIENT_TOKEN,
  TEST_DIAGNOSTIC_USERNAME,
  TEST_PLATFORM_USER_A,
  TEST_PLATFORM_USER_B,
  TEST_USERNAME_A,
  TEST_USERNAME_B,
} from './helpers.js';

/**
 * `explain_field_access` at the protocol boundary, over the real Streamable HTTP surface.
 *
 * The unit suite covers the aggregation, the conclusion builder and the boundary as functions. Four
 * claims are only true here, and neither a provider-side nor a host-side unit test can make any of them:
 *
 * 1. **Invisible until enabled.** Governance decides which names exist. A Tool an Admin has not enabled
 *    is not merely refused — it is absent from `tools/list`, so an Agent cannot plan around it, and a
 *    call to the name is denied before any Provider is composed.
 * 2. **Routed to the server-owned DIAGNOSTIC identity.** The role map decides that before the Tool body
 *    runs, and the Connection the call opens carries `executionRole: 'DIAGNOSTIC'` and the fixed
 *    diagnostic username rather than the caller's route. This is the failure the whole classification
 *    exists to prevent, and it is invisible to a test that hands the executor a scope directly.
 * 3. **The `targetUserId` bound is the deployment's own route set.** `envFieldAccessTargetUsers` is fed
 *    the routes `createIdentityRuntime` built, so a named Id is bounded by the set this deployment
 *    actually routes calls through. Asserting that here is asserting the wiring rather than the function.
 * 4. **The answer is audited.** A permission explanation is only auditable if the row says *whose*
 *    access was explained, and the audit event is produced by the facade on this path and nowhere else.
 */
const FIELD_ACCESS_TOOLS = ['explain_field_access'] as const;

const PROFILE_PS_ID = '0PS000000000001AAA';
const STANDALONE_PS_ID = '0PS000000000002AAA';
/** The one user this deployment routes calls through, and therefore the only subject a fixture holds. */
const SUBJECT_USER_ID = '005000000000001AAA';

class RecordingLogger implements RuntimeLogger {
  public readonly events: RuntimeLogEvent[] = [];

  public log(event: RuntimeLogEvent): void {
    this.events.push(event);
  }

  public forTool(toolName: string): RuntimeLogEvent[] {
    return this.events.filter((event) => event.toolName === toolName);
  }
}

/**
 * Answers the six permission reads the Tool makes, by the object each statement names.
 *
 * The subject is the deployment's primary route, `user-a@example.test`: the environment runtime has an
 * identity config rather than a route table, so `envFieldAccessTargetUsers` derives both the caller's own
 * route and the bound from it. The permission data is the ordinary "explain a field a profile denies and
 * a permission set grants" configuration, because that union is the answer this Tool exists to produce.
 */
function permissionAnswer(statement: string): unknown {
  const subject = { Id: SUBJECT_USER_ID, Username: TEST_USERNAME_A, IsActive: true };
  const rows = (records: readonly Record<string, unknown>[]): unknown => ({ records, totalSize: records.length, done: true });
  if (statement.includes('FROM User WHERE ')) {
    // The subject lookup honours the `Id` clause the way an org does, which is the whole point of the
    // boundary being a clause rather than a post-filter: an Id this fixture does not hold resolves to no
    // row even though the `Username IN (…)` list beside it would have matched. A handler that ignored the
    // clause would make the out-of-bound test below pass for the wrong reason — or, as written first,
    // fail to refuse at all.
    const namedId = /Id = '([^']*)'/u.exec(statement)?.[1];
    if (namedId !== undefined) return rows(namedId === SUBJECT_USER_ID ? [subject] : []);
    return rows([subject]);
  }
  if (statement.includes('FROM PermissionSetAssignment WHERE ')) {
    return rows([{ PermissionSetId: PROFILE_PS_ID }, { PermissionSetId: STANDALONE_PS_ID }]);
  }
  if (statement.includes('FROM PermissionSet WHERE ')) {
    return rows([
      { Id: PROFILE_PS_ID, Name: 'System_Administrator', Label: '系统管理员', IsOwnedByProfile: true, Profile: { Name: '系统管理员' } },
      { Id: STANDALONE_PS_ID, Name: 'SFOA_Field_Editor', Label: 'Field Editor', IsOwnedByProfile: false, Profile: null },
    ]);
  }
  if (statement.includes('FROM ObjectPermissions WHERE ')) {
    return rows([
      { ParentId: PROFILE_PS_ID, PermissionsRead: true, PermissionsEdit: true, PermissionsViewAllRecords: false },
      { ParentId: STANDALONE_PS_ID, PermissionsRead: true, PermissionsEdit: true, PermissionsViewAllRecords: false },
    ]);
  }
  if (statement.includes('FROM FieldPermissions WHERE ')) {
    // The profile denies edit on `Name`; the standalone set grants it, and the row is stored with the
    // object-qualified spelling, which is one of the two this Tool sends and normalizes back.
    return rows([
      { ParentId: PROFILE_PS_ID, Field: 'Name', PermissionsRead: true, PermissionsEdit: false },
      { ParentId: STANDALONE_PS_ID, Field: 'Account.Name', PermissionsRead: true, PermissionsEdit: true },
    ]);
  }
  if (statement.includes('FROM RecordType')) {
    return rows([
      { Id: '012000000000001AAA', DeveloperName: 'Master', Name: 'Master', SobjectType: 'Account', IsActive: true },
    ]);
  }
  return rows([]);
}

type Harness = Readonly<{
  server: RemoteMcpServer;
  client: Client;
  factory: RecordingConnectionFactory;
  logger: RecordingLogger;
  close(): Promise<void>;
}>;

async function startHarness(options: Readonly<{
  enabledTools: readonly string[];
  diagnosticUsername?: string;
}>): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-p10-fieldaccess-http-'));
  const factory = new RecordingConnectionFactory({ query: (statement) => permissionAnswer(statement) });
  const logger = new RecordingLogger();
  const identity = {
    projectRoot: root,
    instanceUrl: 'https://example.test',
    primaryUsername: TEST_USERNAME_A,
    secondaryUsername: TEST_USERNAME_B,
    clientId: 'test-connected-app',
    privateKeyPath: path.join(root, 'unused.pem'),
    platformUserA: TEST_PLATFORM_USER_A,
    platformUserB: TEST_PLATFORM_USER_B,
    concurrentRequests: 50,
    port: 3000,
    ...(options.diagnosticUsername === undefined ? {} : { diagnosticUsername: options.diagnosticUsername }),
  } as const;
  const identityRuntime = createIdentityRuntime(identity, {
    connectionFactory: factory,
    workspaceFactory: new RequestWorkspaceFactory({ baseRoot: path.join(root, 'requests') }),
    cwdGuard: new CwdExecutionGuard(),
    logger,
  });
  const config = {
    ...createTestRemoteConfig({ enabledTools: options.enabledTools }),
    identity,
  };
  const server = await startRemoteMcpServer({ config, identityRuntime });
  const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
    requestInit: {
      headers: {
        authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        'x-platform-user-id': TEST_PLATFORM_USER_A,
      },
    },
  });
  const client = new Client({ name: 'p10-fieldaccess-http-test', version: '1.0.0' });
  await client.connect(transport);
  return {
    server,
    client,
    factory,
    logger,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

/** The Tool's structured answer, narrowed back to something a test can read key by key. */
function structured(result: unknown): Record<string, unknown> {
  const content = (result as { structuredContent?: unknown }).structuredContent;
  assert.ok(content !== undefined, 'the Tool must answer with structuredContent');
  return content as Record<string, unknown>;
}

function fieldAt(output: Record<string, unknown>, index: number): Record<string, unknown> {
  const fields = output.fields as Record<string, unknown>[] | undefined;
  const field = fields?.[index];
  assert.ok(field !== undefined, `expected the answer to carry a field at index ${index}`);
  return field;
}

test('explain_field_access is absent from tools/list until an Admin enables it', async () => {
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS] });
  try {
    const names = (await harness.client.listTools()).tools.map((tool) => tool.name);
    for (const name of FIELD_ACCESS_TOOLS) {
      assert.equal(names.includes(name), false, `${name} must not be advertised while it is disabled`);
    }

    await assert.rejects(
      harness.client.callTool({ name: 'explain_field_access', arguments: { objectApiName: 'Account', fieldApiNames: ['Name'] } }),
      (error: unknown) => /explain_field_access/u.test(String(error)),
    );
    const denial = harness.logger.forTool('explain_field_access')
      .find((event) => event.auditEvent?.eventType === 'GOVERNANCE_DENIED');
    assert.ok(denial !== undefined, 'a disabled-Tool attempt must be audited as a governance denial');
    assert.equal(denial.result, 'BLOCKED');
    assert.equal(denial.outcome, 'DENIED');
    assert.equal(denial.errorCode, 'MCP_TOOL_DISABLED');
    // A refusal that still opened a Connection would mean the denial happened after the org was touched,
    // which is not a denial.
    assert.deepEqual(harness.factory.creations, []);
  } finally {
    await harness.close();
  }
});

test('an enabled explain_field_access call runs on the fixed DIAGNOSTIC identity and is audited as PERMISSION_EXPLAIN', async () => {
  const harness = await startHarness({
    enabledTools: [...DEFAULT_ENABLED_TOOLS, ...FIELD_ACCESS_TOOLS],
    diagnosticUsername: TEST_DIAGNOSTIC_USERNAME,
  });
  try {
    const listed = await harness.client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === 'explain_field_access');
    assert.ok(tool !== undefined, 'explain_field_access must be advertised once an Admin enables it');
    assert.deepEqual(
      Object.keys(tool.inputSchema.properties ?? {}).sort(),
      ['fieldApiNames', 'includeRecordTypeContext', 'objectApiName', 'targetUserId'].sort(),
    );
    // Read-only, and the annotation is a claim an Agent plans on: this Tool reads permission
    // configuration and must never be mistaken for one that can change it.
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(harness.factory.creations.length, 0, 'initialize and tools/list must not open a Connection');

    const result = await harness.client.callTool({
      name: 'explain_field_access',
      arguments: { objectApiName: 'Account', fieldApiNames: ['Name'] },
    });
    assert.equal(result.isError === true, false);
    const output = structured(result);
    assert.equal(output.executionRole, 'DIAGNOSTIC');
    assert.equal(output.api, 'STANDARD');
    assert.equal(output.objectApiName, 'Account');
    assert.equal(output.requestedFieldCount, 1);
    assert.equal(output.returnedFieldCount, 1);
    assert.equal(output.truncated, false);

    // The subject is the caller's own business route rather than the DIAGNOSTIC account the Tool runs on,
    // and `isRequestingUser` is how the answer says which of the two the conclusion is about.
    const user = output.userContext as Record<string, unknown>;
    assert.equal(user.userId, SUBJECT_USER_ID);
    assert.equal(user.username, TEST_USERNAME_A);
    assert.equal(user.isRequestingUser, true);
    assert.equal(user.isActive, true);
    assert.deepEqual(
      (user.permissionSets as Record<string, unknown>[]).map((set) => set.name),
      ['System_Administrator', 'SFOA_Field_Editor'],
    );
    assert.deepEqual(user.objectAccess, {
      read: true, edit: true, viewAllRecords: false, unreadableParentIds: [],
    });

    const field = fieldAt(output, 0);
    assert.equal(field.fieldApiName, 'Name');
    // Describe answers for the executing identity, and the flag is what stops a reader taking the
    // administrator's own view for the subject's. It is never an input to the conclusion.
    assert.equal((field.describeFacts as Record<string, unknown>).executionIdentityView, true);
    assert.deepEqual(
      (field.grants as Record<string, unknown>[]).map((grant) => [grant.parentType, grant.parentName, grant.permissionsEdit]),
      [['PROFILE', 'System_Administrator', false], ['PERMISSION_SET', 'SFOA_Field_Editor', true]],
    );
    // The whole point of the Tool, over the wire: the profile alone reads as a refusal and the union is
    // an edit, with the disagreement named rather than resolved away.
    const conclusion = field.conclusion as Record<string, unknown>;
    assert.equal(conclusion.visible, true);
    assert.equal(conclusion.editable, true);
    assert.match((conclusion.conflicts as string[]).join(' '), /No profile-owned grant carries edit/u);
    assert.match((conclusion.caveats as string[]).join(' '), /validation rule/u);
    assert.match(String(output.hint), /holds a read and edit grant on every field reported/u);

    // The read is attributed: the triggering platform user is the caller, the Salesforce username behind
    // it is the server-owned diagnostic identity, and the caller's own route is never used for it.
    assert.ok(harness.factory.creations.some((entry) =>
      entry.connectionRole === 'DIAGNOSTIC' && entry.salesforceUsername === TEST_DIAGNOSTIC_USERNAME));
    assert.equal(harness.factory.creations.some((entry) => entry.connectionRole === 'USER'), false,
      'a diagnostic Tool must not open a Connection as the caller');
    // Every statement is scoped to a permission table, and the caller-named object is a filter value
    // rather than a query target — the §0.3 red line as it appears on the wire.
    assert.ok(harness.factory.queryCalls.length > 0);
    for (const statement of harness.factory.queryCalls) {
      assert.doesNotMatch(statement, /\bFROM\s+Account\b/u, statement);
    }

    const terminal = harness.logger.forTool('explain_field_access')
      .find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
    assert.ok(terminal !== undefined, 'explain_field_access must emit a TOOL_TERMINAL audit event');
    assert.equal(terminal.result, 'PASS');
    assert.equal(terminal.executionRole, 'DIAGNOSTIC');
    assert.equal(terminal.salesforceUsername, TEST_DIAGNOSTIC_USERNAME);
    assert.equal(terminal.platformUserId, TEST_PLATFORM_USER_A);
    // Whose access was explained and which fields were asked about: the row an operator reads when the
    // question is "who looked up whose field access".
    assert.deepEqual(terminal.requestSummary, {
      objectApiName: 'Account',
      targetUserId: null,
      fieldApiNames: ['Name'],
      fieldCount: 1,
      includeRecordTypeContext: true,
    });
    assert.deepEqual(terminal.responseSummary, {
      isError: false,
      fieldCount: 1,
      truncated: false,
      requestedFieldCount: 1,
    });
  } finally {
    await harness.close();
  }
});

test('the targetUserId bound is the deployment route set, and a named user outside it is refused', async () => {
  const harness = await startHarness({
    enabledTools: [...DEFAULT_ENABLED_TOOLS, ...FIELD_ACCESS_TOOLS],
    diagnosticUsername: TEST_DIAGNOSTIC_USERNAME,
  });
  try {
    // `User` is the one permission-adjacent table a named target is resolved from, and the fixture answers
    // it with the primary route only. So `user-b`'s Id resolves to no row under the deployment's own
    // route clause, which is the bound doing its work and not a missing fixture row.
    const refused = await harness.client.callTool({
      name: 'explain_field_access',
      arguments: { objectApiName: 'Account', fieldApiNames: ['Name'], targetUserId: '005000000000002AAA' },
    });
    assert.equal(refused.isError, true);
    const text = JSON.stringify(refused.content);
    assert.match(text, /MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED/u);
    // The refusal names no layer and reports no conclusion: a refused subject must not look like a table
    // of gaps, which is exactly what an Agent would act on.
    assert.doesNotMatch(text, /INDETERMINATE/u);

    const terminal = harness.logger.forTool('explain_field_access')
      .find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
    assert.ok(terminal !== undefined);
    assert.equal(terminal.errorCode, 'MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED');
    // Even the refusal records the subject that was asked about, which is the fact the row exists for.
    assert.equal((terminal.requestSummary as Record<string, unknown>).targetUserId, '005000000000002AAA');
  } finally {
    await harness.close();
  }
});

test('a runtime with no diagnostic identity refuses the call rather than downgrading to the caller', async () => {
  const harness = await startHarness({
    enabledTools: [...DEFAULT_ENABLED_TOOLS, ...FIELD_ACCESS_TOOLS],
  });
  try {
    // Refused before the request even reaches a Tool: the role map classified the call DIAGNOSTIC and this
    // runtime has no server-owned diagnostic scope, so the refusal is a request-level error rather than a
    // Tool result. Either way the point is that it stops here.
    await assert.rejects(
      harness.client.callTool({
        name: 'explain_field_access',
        arguments: { objectApiName: 'Account', fieldApiNames: ['Name'] },
      }),
      (error: unknown) => /MCP_DIAGNOSTIC_CONFIGURATION_INVALID/u.test(String(error)),
    );
    // The one outcome worse than refusing: answering about a user while running as them.
    assert.equal(harness.factory.creations.length, 0, 'the refusal must not open any Connection at all');
  } finally {
    await harness.close();
  }
});
