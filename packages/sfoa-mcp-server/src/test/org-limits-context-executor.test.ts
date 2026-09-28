import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ContextRuntimeError,
  GetOrgLimitsMcpTool,
  ORG_LIMIT_HIGHLIGHT_SLOTS,
  SFOA_CONTEXT_TOOL_NAMES,
  type OrgLimitsReader,
} from '@sfoa/mcp-provider-sfoa-context';
import { DATA_MAX_RESPONSE_BYTES } from '@sfoa/mcp-provider-sfoa-data';
import type { RequestContext, RequestScope, RuntimeLogEvent } from '@sfoa/identity-runtime';
import { createSalesforceIdentityRoute } from '@sfoa/identity-runtime';
import { ContextToolFacade, assertContextToolPurposesMatchRoleMap } from '../context-tool-facade.js';
import { ScopedOrgLimitsExecutor } from '../org-limits-context-executor.js';
import {
  RecordingConnectionFactory,
  TEST_DIAGNOSTIC_USERNAME,
  TEST_PLATFORM_USER_A,
  TEST_USERNAME_A,
  createTestIdentityRuntime,
} from './helpers.js';

/**
 * Host-side coverage for `get_org_limits`.
 *
 * The Tool moved out of the Data provider because the limits resource is an org configuration read
 * that no business identity in this deployment is granted: it now runs on the fixed server-owned
 * DIAGNOSTIC identity, and this is the layer that can prove it. The pure derivation is covered in
 * `@sfoa/mcp-provider-sfoa-context`; what is covered here is the part that needs a Connection — the
 * role guard, the byte budget, and the failure mapping.
 */
class RecordingLogger {
  public readonly events: RuntimeLogEvent[] = [];

  public log(event: RuntimeLogEvent): void {
    this.events.push(event);
  }
}

type Scopes = Readonly<{
  diagnostic: RequestScope;
  user: RequestScope;
  factory: RecordingConnectionFactory;
  close(): Promise<void>;
}>;

async function createScopes(
  factory: RecordingConnectionFactory = new RecordingConnectionFactory(),
): Promise<Scopes> {
  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-p9-limits-'));
  const runtime = createTestIdentityRuntime(root, factory, new RecordingLogger(), TEST_DIAGNOSTIC_USERNAME);
  const diagnosticFactory = runtime.diagnosticScopeFactory;
  if (!diagnosticFactory) assert.fail('the test runtime must expose a DIAGNOSTIC scope factory');
  const diagnostic = await diagnosticFactory.create({
    platformUserId: TEST_PLATFORM_USER_A,
    correlationId: 'limits-diagnostic',
  });
  const user = await runtime.scopeFactory.create({
    platformUserId: TEST_PLATFORM_USER_A,
    correlationId: 'limits-user',
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

test('a USER request scope can never read the limits, and never opens a Connection trying', async () => {
  const scopes = await createScopes();
  try {
    // The executor guard is depth behind the facade's own role check — the facade decides what a
    // request may do, this decides which identity a Connection may be opened for. Proving the guard
    // is what makes the two-layer story true rather than aspirational.
    const error = await rejection(new ScopedOrgLimitsExecutor(scopes.user).execute({}));
    assert.equal(error.code, 'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED');
    assert.match(error.message, /get_org_limits requires the fixed server-owned DIAGNOSTIC request scope/u);
    assert.deepEqual(scopes.factory.limitsCalls, []);
    assert.deepEqual(scopes.factory.creations, []);
  } finally {
    await scopes.close();
  }
});

test('the facade refuses a USER route for get_org_limits, audits it as BLOCKED, and never reaches the executor', async () => {
  const logger = new RecordingLogger();
  let executions = 0;
  const reader: OrgLimitsReader = {
    execute: async () => {
      executions += 1;
      throw new Error('the facade must not reach the executor on a USER route');
    },
  };
  const facade = new ContextToolFacade({
    tool: new GetOrgLimitsMcpTool(reader),
    context: {
      platformUserId: TEST_PLATFORM_USER_A,
      correlationId: 'limits-facade-user',
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

  const result = await facade.execute({}, {} as never);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.errorCode, 'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED');
  assert.match(String(result.structuredContent?.message), /fixed to the DIAGNOSTIC execution role/u);
  assert.equal(executions, 0);
  const terminal = logger.events.find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
  assert.equal(terminal?.result, 'BLOCKED');
  assert.equal(terminal?.outcome, 'DENIED');
  assert.equal(terminal?.executionRole, 'USER');
  assert.equal(terminal?.errorCode, 'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED');
});

test('a DIAGNOSTIC scope reads the limits through the server-owned identity and reports the derived facts', async () => {
  const scopes = await createScopes();
  try {
    const output = await new ScopedOrgLimitsExecutor(scopes.diagnostic).execute({});

    assert.equal(output.success, true);
    assert.equal(output.executionRole, 'DIAGNOSTIC');
    assert.equal(output.api, 'REST');
    assert.equal(output.verbose, false);
    assert.equal(output.totalLimits, 4);
    assert.equal(output.returnedLimits, 4);
    assert.equal(output.unreadableLimits, 0);
    assert.equal(output.truncated, false);
    assert.equal(output.hint, undefined);
    assert.deepEqual(Object.keys(output.highlights ?? {}), [...ORG_LIMIT_HIGHLIGHT_SLOTS]);
    assert.deepEqual(output.highlights?.dailyApiRequests, {
      key: 'DailyApiRequests', present: true, max: 100_000, remaining: 99_000, used: 1_000,
    });
    // Slots this org does not meter are reported, not omitted: "not metered" and "nothing left" are
    // different answers and an Agent sizing a job has to be able to tell them apart.
    assert.deepEqual(output.highlights?.dailyAsyncApexExecutions, {
      key: null, present: false, max: null, remaining: null, used: null,
    });

    // The read is attributed to the server-owned DIAGNOSTIC username, not to the trigger user.
    assert.deepEqual(scopes.factory.limitsCalls, [{
      platformUserId: TEST_PLATFORM_USER_A,
      salesforceUsername: TEST_DIAGNOSTIC_USERNAME,
    }]);
  } finally {
    await scopes.close();
  }
});

test('verbose changes the report, never the structured table', async () => {
  const scopes = await createScopes();
  try {
    const executor = new ScopedOrgLimitsExecutor(scopes.diagnostic);
    const terse = await executor.execute({});
    const verbose = await executor.execute({ verbose: true });

    assert.equal(terse.verbose, false);
    assert.equal(verbose.verbose, true);
    assert.deepEqual(verbose.limits, terse.limits);
    assert.deepEqual(verbose.highlights, terse.highlights);
    assert.deepEqual(Object.keys(verbose).sort(), Object.keys(terse).sort());
  } finally {
    await scopes.close();
  }
});

test('an entry the org lists but reports no number for is counted, not dropped and not zeroed', async () => {
  const scopes = await createScopes(new RecordingConnectionFactory({
    limits: () => ({
      DailyApiRequests: { Max: 100, Remaining: 40 },
      ConcurrencyLimit: { Max: 'many' },
    }),
  }));
  try {
    const output = await new ScopedOrgLimitsExecutor(scopes.diagnostic).execute({});

    assert.equal(output.totalLimits, 2);
    assert.equal(output.returnedLimits, 2);
    assert.equal(output.unreadableLimits, 1);
    assert.deepEqual(output.limits?.ConcurrencyLimit, { max: null, remaining: null, used: null, measured: false });
  } finally {
    await scopes.close();
  }
});

test('an oversized limits table is trimmed at a reproducible point and the five slots survive', async () => {
  // ~145 bytes per entry puts 2 000 keys well past the 262 144-byte budget, while the five highlight
  // slots stay at the front of the order and are therefore never the part that is cut.
  const entries: Record<string, unknown> = { DailyApiRequests: { Max: 100, Remaining: 40 } };
  for (let index = 0; index < 2_000; index += 1) {
    entries[`LongLimitKey_${index}_${'x'.repeat(64)}`] = { Max: index, Remaining: index };
  }
  const scopes = await createScopes(new RecordingConnectionFactory({ limits: () => entries }));
  try {
    const executor = new ScopedOrgLimitsExecutor(scopes.diagnostic);
    const output = await executor.execute({});

    assert.equal(output.truncated, true);
    assert.equal(output.totalLimits, 2_001);
    assert.ok((output.returnedLimits ?? 0) > 0);
    assert.ok((output.returnedLimits ?? 0) < output.totalLimits);
    assert.deepEqual(Object.keys(output.highlights ?? {}), [...ORG_LIMIT_HIGHLIGHT_SLOTS]);
    assert.equal(output.highlights?.dailyApiRequests.present, true);
    assert.match(output.hint ?? '', /highlight slots are always kept/u);
    assert.match(output.hint ?? '', new RegExp(`${DATA_MAX_RESPONSE_BYTES}-byte response budget`, 'u'));
    assert.ok(JSON.stringify(output).length <= DATA_MAX_RESPONSE_BYTES);

    const again = await executor.execute({});
    assert.deepEqual(Object.keys(again.limits ?? {}), Object.keys(output.limits ?? {}));
  } finally {
    await scopes.close();
  }
});

test('an org that reports nothing readable is a failure, never an empty table', async () => {
  const scopes = await createScopes(new RecordingConnectionFactory({ limits: () => ({}) }));
  try {
    const error = await rejection(new ScopedOrgLimitsExecutor(scopes.diagnostic).execute({}));

    // `{limits: {}}` would read to an Agent as "this org has no limits" — the opposite of the truth.
    assert.equal(error.code, 'MCP_LIMITS_READ_FAILED');
    assert.match(error.message, /no readable governor-limit entry/u);
    assert.match(error.suggestion ?? '', /never as unlimited/u);
  } finally {
    await scopes.close();
  }
});

test('an org that refuses the limits resource is an access denial whose remedy is not a business-identity grant', async () => {
  for (const code of [
    'API_DISABLED_FOR_ORG',
    'INSUFFICIENT_ACCESS',
    'INSUFFICIENT_ACCESS_OR_READONLY',
    'INSUFFICIENT_PRIVILEGES',
    'NOT_FOUND',
    'INVALID_TYPE',
  ]) {
    const scopes = await createScopes(new RecordingConnectionFactory({
      limitsError: Object.assign(new Error('limits resource is not enabled'), { errorCode: code }),
    }));
    try {
      const error = await rejection(new ScopedOrgLimitsExecutor(scopes.diagnostic).execute({}));

      assert.equal(error.code, 'MCP_LIMITS_ACCESS_DENIED', `${code} must map to the denial`);
      assert.equal(error.salesforceErrorCode, code);
      // The Tool already runs on the DIAGNOSTIC identity, so the old remedy — "give the business user
      // more access" — is not the available one, and the suggestion has to say so. That sentence is
      // what stops an operator from widening an identity the role exists to keep out of org config.
      assert.match(error.suggestion ?? '', /server-owned DIAGNOSTIC identity/u);
      assert.match(error.suggestion ?? '', /not the remedy/u);
      assert.match(error.suggestion ?? '', /Salesforce Setup/u);
    } finally {
      await scopes.close();
    }
  }
});

test('an unexpected provider failure is a read failure and never echoes the raw error to the client', async () => {
  const scopes = await createScopes(new RecordingConnectionFactory({
    limitsError: new Error('socket hang up'),
  }));
  try {
    const error = await rejection(new ScopedOrgLimitsExecutor(scopes.diagnostic).execute({}));

    assert.equal(error.code, 'MCP_LIMITS_READ_FAILED');
    assert.equal(error.salesforceErrorCode, undefined);
    assert.doesNotMatch(error.message, /socket hang up/u);
  } finally {
    await scopes.close();
  }
});

test('the audit purpose map is total over the context role map, so a moved Tool cannot go unaudited', () => {
  // Moving a Tool between providers is exactly when its audit purpose is easiest to forget: the
  // facade's map is keyed by Tool name, and a name that arrives without an entry would otherwise be
  // audited as `UNKNOWN` — a row an operator reads as a semantic-capture failure. This is the
  // assertion that turns the next omission into a test failure.
  assert.doesNotThrow(() => assertContextToolPurposesMatchRoleMap());
  assert.ok(SFOA_CONTEXT_TOOL_NAMES.includes('get_org_limits'));
});
