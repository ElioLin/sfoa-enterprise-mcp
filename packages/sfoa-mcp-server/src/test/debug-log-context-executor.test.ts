import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import {
  APEX_LOG_DEFAULT_LIMIT,
  APEX_LOG_DEFAULT_TIME_WINDOW_MINUTES,
  ContextRuntimeError,
  DEBUG_LEVEL_FIELDS,
  DEBUG_LEVEL_TIERS,
  DEBUG_LOG_BODY_DEFAULT_MAX_CHARACTERS,
  DEFAULT_DEBUG_LEVEL_TIER,
  GetApexLogsMcpTool,
  GetDebugLogBodyMcpTool,
  SetTraceFlagMcpTool,
  TRACE_FLAG_DEFAULT_DURATION_MINUTES,
  TRACED_ENTITY_LOG_TYPES,
  debugLevelCreatePayload,
  type ApexLogReader,
  type DebugLogBodyReader,
  type TraceFlagWriter,
} from '@sfoa/mcp-provider-sfoa-context';
import type { RequestContext, RequestScope, RuntimeLogEvent } from '@sfoa/identity-runtime';
import { createSalesforceIdentityRoute } from '@sfoa/identity-runtime';
import { ContextToolFacade } from '../context-tool-facade.js';
import {
  ScopedApexLogExecutor,
  ScopedDebugLogBodyExecutor,
  ScopedTraceFlagExecutor,
} from '../debug-log-context-executors.js';
import {
  TEST_DIAGNOSTIC_USERNAME,
  TEST_PLATFORM_USER_A,
  TEST_USERNAME_A,
  createTestIdentityRuntime,
} from './helpers.js';

/**
 * Host-side coverage for the T2 debug-log Toolset.
 *
 * The provider package owns what is pure — the schemas, the `DebugLevel` catalog, the log parser, the
 * hint gating and the `FROM`-target check — and covers it in `debug-log-toolset.test.ts`. What is
 * covered here is everything that needs a Connection and an identity: the last-guard role check, the
 * Salesforce call shapes the probe measured, the response budget, ADR-0029 §3's degradation contract,
 * and the facade's audit summaries.
 *
 * The fixture is purpose-built rather than reusing `RecordingConnectionFactory`, because these Tools
 * reach jsforce surfaces that helper deliberately does not model: `tooling.sobject(name).create/update`
 * and a versioned `request()` outside the Bulk endpoints. Modelling them here, against the exact SQL
 * this module issues, is what lets a test assert the *statement* a Tool sends — which is where the two
 * measured traps live: a `Status =` filter would silently drop localized rows, and a query naming a
 * field the Tooling API version does not carry fails the whole call.
 */

type WriteRecord = Readonly<{ sobject: string; operation: 'CREATE' | 'UPDATE'; record: Record<string, unknown> }>;
type RequestRecord = Readonly<{ method: string; url: string }>;

/**
 * A Connection whose Tooling surface answers from the fixture's own tables.
 *
 * Every read is routed by the same markers the production statements carry, so a test asserting on
 * `queries` is asserting on what the executor actually sent rather than on a paraphrase of it.
 */
class ToolingConnectionFactory {
  public readonly creations: string[] = [];
  public readonly queries: string[] = [];
  public readonly writes: WriteRecord[] = [];
  public readonly requests: RequestRecord[] = [];
  public readonly apiVersion: string = '65.0';

  /** `DebugLevel` rows, keyed by the `DeveloperName` or `Id` a statement looks them up by. */
  public debugLevels: Record<string, unknown>[] = [];
  public traceFlags: Record<string, unknown>[] = [];
  public apexLogs: Record<string, unknown>[] = [];
  /** The `COUNT(Id)` aggregate. `total: null` models the record-less form (probe §4). */
  public countRecords: Record<string, unknown>[] = [];
  public countTotalSize: number | null = 0;
  public bodies = new Map<string, unknown>();
  /** A `LogUserId` clause narrows the scan, exactly as SOQL would. */
  public honourLogUserId = true;

  /** Thrown by any query whose statement contains `match`. Specific beats general. */
  public queryErrors: { match: string; error: unknown }[] = [];
  public queryError: unknown;
  public bodyFetchError: unknown;
  public traceFlagCreateRefusal: unknown;
  public debugLevelCreateRefusal: unknown;
  public traceFlagCreateResult: unknown;
  public debugLevelCreateResult: unknown;
  public updateResult: unknown;
  /** Overrides what the re-read of a written flag reports, so verification can be made to fail. */
  public forcedExpirationOnRead: string | null | undefined;
  /** The Id the fixture hands back for a created row, in creation order. */
  public nextId = 1;

  public async create(route: { connectionRole: string; salesforceUsername: string }): Promise<Connection> {
    this.creations.push(route.salesforceUsername);
    const connection = {
      getApiVersion: () => this.apiVersion,
      tooling: {
        query: async (query: string) => this.runQuery(query),
        sobject: (sobject: string) => ({
          create: async (record: Record<string, unknown>) => {
            this.writes.push({ sobject, operation: 'CREATE', record: { ...record } });
            return this.runCreate(sobject, record);
          },
          update: async (record: Record<string, unknown>) => {
            this.writes.push({ sobject, operation: 'UPDATE', record: { ...record } });
            if (this.updateResult !== undefined) return this.updateResult as unknown;
            const row = this.traceFlags.find((entry) => entry.Id === record.Id);
            if (row !== undefined) {
              Object.assign(row, record, record.ExpirationDate === undefined
                ? {}
                : { ExpirationDate: asSalesforceStores(record.ExpirationDate) });
            }
            return { success: true, id: record.Id, errors: [] };
          },
        }),
      },
      request: async (request: Readonly<{ method?: string; url?: string }>) => {
        this.requests.push({ method: request.method ?? 'GET', url: request.url ?? '' });
        if (this.bodyFetchError !== undefined) throw this.bodyFetchError;
        const id = /\/ApexLog\/([^/]+)\/Body$/u.exec(request.url ?? '')?.[1] ?? '';
        if (!this.bodies.has(id)) {
          throw Object.assign(new Error(`ApexLog ${id} has no body`), { errorCode: 'NOT_FOUND' });
        }
        return this.bodies.get(id);
      },
    };
    return connection as unknown as Connection;
  }

  private runQuery(query: string): unknown {
    this.queries.push(query);
    const specific = this.queryErrors.find((entry) => query.includes(entry.match));
    if (specific) throw specific.error;
    if (this.queryError !== undefined) throw this.queryError;
    if (query.includes('COUNT(Id) total FROM ApexLog')) {
      return { records: this.countRecords, totalSize: this.countTotalSize, done: true };
    }
    if (query.includes('FROM DebugLevel WHERE DeveloperName = ')) {
      return result(this.debugLevels.filter((row) => row.DeveloperName === literal(query)));
    }
    if (query.includes('FROM DebugLevel WHERE Id = ')) {
      return result(this.debugLevels.filter((row) => row.Id === literal(query)));
    }
    if (query.includes('FROM TraceFlag WHERE TracedEntityId = ')) {
      return result(this.traceFlags.filter((row) => row.TracedEntityId === literal(query)));
    }
    if (query.includes('FROM TraceFlag WHERE Id = ')) {
      const id = literal(query);
      return result(this.traceFlags
        .filter((row) => row.Id === id)
        .map((row) => (this.forcedExpirationOnRead === undefined
          ? row
          : { ...row, ExpirationDate: this.forcedExpirationOnRead })));
    }
    if (query.includes('FROM ApexLog WHERE Id = ')) {
      return result(this.apexLogs.filter((row) => row.Id === literal(query)));
    }
    if (query.includes('FROM ApexLog WHERE LastModifiedDate >=')) {
      const userId = this.honourLogUserId ? clauseValue(query, 'LogUserId') : null;
      return result(userId === null ? this.apexLogs : this.apexLogs.filter((row) => row.LogUserId === userId));
    }
    throw new Error(`Unexpected Tooling query in the debug-log fixture: ${query}`);
  }

  private runCreate(sobject: string, record: Record<string, unknown>): unknown {
    const id = `${sobject === 'TraceFlag' ? '7tf' : '7dl'}${String(this.nextId++).padStart(12, '0')}AAA`;
    if (sobject === 'TraceFlag') {
      if (this.traceFlagCreateRefusal !== undefined) throw this.traceFlagCreateRefusal;
      if (this.traceFlagCreateResult !== undefined) return this.traceFlagCreateResult as unknown;
      this.traceFlags.push({
        Id: id,
        ...record,
        StartDate: asSalesforceStores(record.StartDate),
        ExpirationDate: asSalesforceStores(record.ExpirationDate),
      });
      return { success: true, id, errors: [] };
    }
    if (this.debugLevelCreateRefusal !== undefined) throw this.debugLevelCreateRefusal;
    if (this.debugLevelCreateResult !== undefined) return this.debugLevelCreateResult as unknown;
    this.debugLevels.push({ Id: id, ...record });
    return { success: true, id, errors: [] };
  }
}

/** The single quoted literal a routed statement carries — the value the fixture matches rows by. */
function literal(query: string): string | null {
  const match = /'((?:[^'\\]|\\.)*)'/u.exec(query);
  return match?.[1] === undefined ? null : unescapeSoql(match[1]);
}

/** The literal that follows `field =`, when the clause is present at all. */
function clauseValue(query: string, field: string): string | null {
  const at = query.indexOf(`${field} = `);
  return at < 0 ? null : literal(query.slice(at));
}

function unescapeSoql(value: string): string {
  return value.replaceAll("\\'", "'").replaceAll('\\\\', '\\');
}

function result(records: Record<string, unknown>[]): unknown {
  return { records, totalSize: records.length, done: true };
}

class RecordingLogger {
  public readonly events: RuntimeLogEvent[] = [];

  public log(event: RuntimeLogEvent): void {
    this.events.push(event);
  }
}

type Scopes = Readonly<{
  diagnostic: RequestScope;
  user: RequestScope;
  factory: ToolingConnectionFactory;
  close(): Promise<void>;
}>;

async function createScopes(factory = new ToolingConnectionFactory()): Promise<Scopes> {
  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-p10-debuglog-'));
  const runtime = createTestIdentityRuntime(root, factory, new RecordingLogger(), TEST_DIAGNOSTIC_USERNAME);
  const diagnosticFactory = runtime.diagnosticScopeFactory;
  if (!diagnosticFactory) assert.fail('the test runtime must expose a DIAGNOSTIC scope factory');
  const diagnostic = await diagnosticFactory.create({
    platformUserId: TEST_PLATFORM_USER_A,
    correlationId: 'debuglog-diagnostic',
  });
  const user = await runtime.scopeFactory.create({
    platformUserId: TEST_PLATFORM_USER_A,
    correlationId: 'debuglog-user',
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

/**
 * The Tool outputs are `z.infer` of schemas whose non-shared fields are `.optional()`, so a test has to
 * say which field it expects rather than lean on a non-null assertion. A missing hint fails here, and
 * that is the right failure: every hint assertion below is about the sentence a caller would read, and
 * no sentence is not a pass.
 */
function hintOf(output: { hint?: string | undefined }): string {
  const hint = output.hint;
  if (hint === undefined || hint.length === 0) assert.fail('expected the Tool output to carry a hint');
  return hint;
}

const ALL_TOOLS: readonly string[] = [
  'set_trace_flag',
  'get_apex_logs',
  'get_debug_log_body',
  'run_diagnostic_tooling_query',
];

/** A `DebugLevel` row as the org stores one, with every field spelled out. */
function debugLevelRow(
  id: string,
  developerName: string,
  levels: Readonly<Record<string, string>> = DEBUG_LEVEL_TIERS.DEBUG.levels,
): Record<string, unknown> {
  return { Id: id, DeveloperName: developerName, MasterLabel: developerName, ...levels };
}

/**
 * A `TraceFlag` date as the org stores one: **whole seconds**, rendered in Salesforce's `+0000` offset
 * notation rather than as a JavaScript `Z` instant.
 *
 * Both halves are load-bearing, and this helper exists because the fixture used to do neither — it echoed
 * whatever the Tool sent, byte for byte. That made it *kinder than the org*, and it is exactly why two
 * defects reached a live sandbox: `set_trace_flag` reported `verified: false` on a correct write, because
 * the request carried milliseconds (`…:47.812Z`) and the platform had already dropped them (`…:47.000+0000`),
 * so `stored >= requested` was false by the sub-second remainder. A fixture that answers more precisely
 * than production cannot fail that assertion, which is the same reason it cannot guard it.
 *
 * Converting through `Date` also pins that the code parses the platform's own notation. `expiryMs` reads
 * `+0000` correctly; `TraceFlag` row literals in the tests read ISO; both are now exercised here.
 */
function asSalesforceStores(instant: unknown): unknown {
  if (typeof instant !== 'string') return instant;
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) return instant;
  return `${new Date(Math.floor(ms / 1_000) * 1_000).toISOString().replace(/\.\d{3}Z$/u, '.000+0000')}`;
}

function traceFlagRow(overrides: Record<string, unknown>): Record<string, unknown> {
  const row = {
    Id: '7tf000000000900AAA',
    TracedEntityId: '005000000000001AAA',
    LogType: 'DEVELOPER_LOG',
    DebugLevelId: '7dl000000000900AAA',
    StartDate: new Date().toISOString(),
    ExpirationDate: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  };
  // Storage, not construction, is what `asSalesforceStores` models — so it is applied to the finished row,
  // which means an override carrying a JavaScript instant is normalized the same way the org would
  // normalize it. Seeding a millisecond-precision expiry therefore *cannot* buy a test a kinder fixture.
  return {
    ...row,
    StartDate: asSalesforceStores(row.StartDate),
    ExpirationDate: asSalesforceStores(row.ExpirationDate),
  };
}

/** The instant a `TraceFlag` date names, whatever notation it arrived in. */
function instantOf(value: unknown): number {
  return Date.parse(String(value));
}

function apexLogRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: '07L000000000001AAA',
    LogUserId: '005000000000001AAA',
    LogUser: { Name: 'Ada Lovelace', Username: 'ada@example.test' },
    Application: 'Unknown',
    Operation: '/apex/MyPage',
    Status: '成功',
    DurationMilliseconds: 42,
    LogLength: 1_024,
    StartTime: new Date().toISOString(),
    LastModifiedDate: new Date().toISOString(),
    ...overrides,
  };
}

const FAILING_LOG = [
  '56.0 APEX_CODE,FINEST;APEX_PROFILING,NONE;CALLOUT,NONE;DB,INFO;NBA,NONE;SYSTEM,DEBUG;VALIDATION,INFO;VISUALFORCE,NONE;WAVE,NONE;WORKFLOW,INFO',
  '00:00:00.1 (2)|CODE_UNIT_STARTED|[EXTERNAL]|01p000000000001|MyClass.myMethod',
  '00:00:00.2 (3)|USER_DEBUG|[1]|DEBUG|entering myMethod',
  '00:00:00.3 (4)|FATAL_ERROR|System.NullPointerException: Attempt to de-reference a null object',
  'Class.MyClass.myMethod: line 12, column 1',
  'Trigger.MyTrigger: line 3, column 1',
].join('\n');

// ---------------------------------------------------------------------------------------------
// The identity guard, at the executor and at the facade
// ---------------------------------------------------------------------------------------------

test('a USER request scope can never run any of the three debug-log Tools, and never opens a Connection trying', async () => {
  const scopes = await createScopes();
  try {
    // The executor guard is depth behind the facade's own role check: the facade decides what a
    // request may do, this decides which identity a Connection may be opened for. `set_trace_flag` is
    // the one that matters most — it writes — and it is checked alongside the two reads so a later
    // copy-paste of the guard cannot quietly cover only the read paths.
    const calls = [
      ['set_trace_flag', new ScopedTraceFlagExecutor(scopes.user, ALL_TOOLS).execute({
        tracedEntityKind: 'USER', tracedEntityId: '005000000000001AAA',
      })],
      ['get_apex_logs', new ScopedApexLogExecutor(scopes.user, ALL_TOOLS).execute({})],
      ['get_debug_log_body', new ScopedDebugLogBodyExecutor(scopes.user, ALL_TOOLS).execute({
        logId: '07L000000000001AAA',
      })],
    ] as const;
    for (const [toolName, promise] of calls) {
      const error = await rejection(promise);
      assert.equal(error.code, 'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED', toolName);
      assert.match(error.message, new RegExp(`${toolName} requires the fixed server-owned DIAGNOSTIC request scope`, 'u'));
    }
    assert.deepEqual(scopes.factory.creations, []);
    assert.deepEqual(scopes.factory.queries, []);
    assert.deepEqual(scopes.factory.writes, []);
  } finally {
    await scopes.close();
  }
});

for (const toolName of ['set_trace_flag', 'get_apex_logs', 'get_debug_log_body'] as const) {
  test(`the facade refuses a USER route for ${toolName}, audits it as BLOCKED, and never reaches the executor`, async () => {
    const logger = new RecordingLogger();
    let executions = 0;
    // A dead executor rather than a working one: the assertion is that the facade refuses *before*
    // the Tool runs, so an executor that returned a well-formed answer would prove nothing.
    const counting = {
      execute: async () => {
        executions += 1;
        throw new Error('the facade must not reach the executor on a USER route');
      },
    };
    const facade = new ContextToolFacade({
      tool: toolName === 'set_trace_flag'
        ? new SetTraceFlagMcpTool(counting as unknown as TraceFlagWriter)
        : toolName === 'get_apex_logs'
          ? new GetApexLogsMcpTool(counting as unknown as ApexLogReader)
          : new GetDebugLogBodyMcpTool(counting as unknown as DebugLogBodyReader),
      context: {
        platformUserId: TEST_PLATFORM_USER_A,
        correlationId: `debuglog-facade-user-${toolName}`,
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

    const result = await facade.execute(toolName === 'set_trace_flag'
      ? { tracedEntityKind: 'USER', tracedEntityId: '005000000000001AAA' }
      : toolName === 'get_apex_logs' ? {} : { logId: '07L000000000001AAA' }, {} as never);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.errorCode, 'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED');
    assert.match(String(result.structuredContent?.message), /fixed to the DIAGNOSTIC execution role/u);
    assert.equal(executions, 0);
    const terminal = logger.events.find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
    assert.equal(terminal?.result, 'BLOCKED');
    assert.equal(terminal?.outcome, 'DENIED');
    assert.equal(terminal?.errorCode, 'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED');
    // The request summary is still safe to write for a refused call: a blocked row that recorded
    // nothing about what was asked would leave an operator unable to tell a probe from a mistake.
    assert.equal((terminal?.requestSummary as Record<string, unknown> | undefined)?.connectionRole, undefined);
  });
}

// ---------------------------------------------------------------------------------------------
// set_trace_flag — resolve-or-create, create-or-extend, verify
// ---------------------------------------------------------------------------------------------

test('set_trace_flag creates the tier DebugLevel and the TraceFlag with the payloads the probe measured', async () => {
  const scopes = await createScopes();
  try {
    const output = await new ScopedTraceFlagExecutor(scopes.diagnostic, ALL_TOOLS).execute({
      tracedEntityKind: 'USER',
      tracedEntityId: '005000000000001AAA',
    });

    assert.equal(output.success, true);
    assert.equal(output.executionRole, 'DIAGNOSTIC');
    assert.equal(output.api, 'TOOLING');
    assert.equal(output.logType, 'DEVELOPER_LOG');
    assert.equal(output.debugLevelTier, DEFAULT_DEBUG_LEVEL_TIER);
    assert.equal(output.debugLevelCreated, true);
    assert.equal(output.debugLevelDeveloperName, DEBUG_LEVEL_TIERS.DEBUG.developerName);
    assert.equal(output.replacedExisting, false);
    assert.equal(output.previousExpirationDate, null);
    assert.equal(output.requestedDurationMinutes, TRACE_FLAG_DEFAULT_DURATION_MINUTES);
    // A write is verified rather than trusted: the probe's own cleanup once reported success on a row
    // that survived, so the re-read is what makes `verified` mean something.
    assert.equal(output.verified, true);
    assert.deepEqual(output.debugLevelLevels, DEBUG_LEVEL_TIERS.DEBUG.levels);
    assert.match(hintOf(output), /call get_apex_logs with a timeWindowMinutes/u);

    // The DebugLevel insert is exactly the tier's payload — no more fields than the probe exercised.
    assert.deepEqual(scopes.factory.writes[0], {
      sobject: 'DebugLevel',
      operation: 'CREATE',
      record: { ...debugLevelCreatePayload(DEBUG_LEVEL_TIERS.DEBUG) },
    });
    // The TraceFlag insert is the measured shape, and its window is the requested one from `now`.
    const flagWrite = scopes.factory.writes[1];
    assert.equal(flagWrite?.sobject, 'TraceFlag');
    assert.equal(flagWrite?.operation, 'CREATE');
    assert.equal(flagWrite?.record.TracedEntityId, '005000000000001AAA');
    assert.equal(flagWrite?.record.LogType, 'DEVELOPER_LOG');
    assert.equal(flagWrite?.record.DebugLevelId, output.debugLevelId);
    const windowMs = Date.parse(String(flagWrite?.record.ExpirationDate))
      - Date.parse(String(flagWrite?.record.StartDate));
    assert.equal(windowMs, TRACE_FLAG_DEFAULT_DURATION_MINUTES * 60_000);
    // Both ends of the window are whole seconds, because that is the precision Salesforce keeps. Asking
    // for a millisecond the platform will drop is what made the live milestone report a correct write as
    // unverified: the re-read returned the truncated second, and `stored >= requested` was false by the
    // remainder. This asserts the request cannot express a sub-second instant in the first place, so the
    // exact comparison in the executor stays exact instead of needing a tolerance.
    assert.match(String(flagWrite?.record.StartDate), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/u);
    assert.match(String(flagWrite?.record.ExpirationDate), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/u);
    // The re-read comes back in the org's own notation and with the org's precision, and the reported
    // expiry is that value — so this compares instants rather than strings, and is not fooled by the
    // `+0000` rendering the fixture now uses because the org does.
    assert.equal(instantOf(output.expirationDate), instantOf(flagWrite?.record.ExpirationDate));

    // Both the resolve and the create re-read go through the Tooling API, and the level is looked up
    // under this Tool's own prefix — never under a name an administrator might have authored.
    assert.ok(scopes.factory.queries[0]?.includes(`DeveloperName = '${DEBUG_LEVEL_TIERS.DEBUG.developerName}'`));
    assert.ok(scopes.factory.queries[1]?.includes('FROM DebugLevel WHERE Id = '));
  } finally {
    await scopes.close();
  }
});

test('a PROFILING trace creates a level whose ApexProfiling is FINEST, which the org\'s only stored level is not', async () => {
  const scopes = await createScopes();
  try {
    const output = await new ScopedTraceFlagExecutor(scopes.diagnostic, ALL_TOOLS).execute({
      tracedEntityKind: 'APEX_CLASS',
      tracedEntityId: '01p000000000001AAA',
      logLevel: 'PROFILING',
      durationMinutes: 10,
    });

    assert.equal(output.logType, TRACED_ENTITY_LOG_TYPES.APEX_CLASS);
    assert.equal(output.logType, 'CLASS_TRACING');
    assert.equal(output.requestedDurationMinutes, 10);
    assert.equal(output.debugLevelTier, 'PROFILING');
    assert.equal(scopes.factory.writes[0]?.record.ApexProfiling, 'FINEST');
    assert.equal(output.debugLevelLevels?.ApexProfiling, 'FINEST');
    // The three fields the probe never exercised are absent rather than sent as NONE.
    for (const field of ['NBA', 'Visualforce', 'Wave'] as const) {
      assert.equal(field in (scopes.factory.writes[0]?.record ?? {}), false, field);
    }
  } finally {
    await scopes.close();
  }
});

test('an existing level under this Tool\'s prefix is reused as stored, reported when it has drifted, and never rewritten', async () => {
  const factory = new ToolingConnectionFactory();
  // The measured trap: this org's only stored level samples profiling at INFO, so a tier that needs
  // full profiling cannot depend on whatever exists.
  factory.debugLevels = [debugLevelRow('7dl000000000900AAA', DEBUG_LEVEL_TIERS.DEBUG.developerName, {
    ...DEBUG_LEVEL_TIERS.DEBUG.levels, ApexProfiling: 'INFO',
  })];
  const scopes = await createScopes(factory);
  try {
    const output = await new ScopedTraceFlagExecutor(scopes.diagnostic, ALL_TOOLS).execute({
      tracedEntityKind: 'USER', tracedEntityId: '005000000000001AAA',
    });

    assert.equal(output.debugLevelCreated, false);
    assert.equal(output.debugLevelId, '7dl000000000900AAA');
    // The stored values are what is reported — not the tier's description of them.
    assert.equal(output.debugLevelLevels?.ApexProfiling, 'INFO');
    assert.match(output.message ?? '', /reused as stored, not as this Tool defines it/u);
    assert.match(output.message ?? '', /ApexProfiling is INFO instead of NONE/u);
    assert.match(output.message ?? '', /It was not modified/u);
    assert.match(output.suggestion ?? '', /stored DebugLevel differs from the tier this Tool defines/u);
    // A reused level is configuration this Tool does not own, so no DebugLevel write may happen at all.
    assert.deepEqual(scopes.factory.writes.map((write) => write.sobject), ['TraceFlag']);
  } finally {
    await scopes.close();
  }
});

test('an active flag of the same kind is extended, not duplicated, and its previous expiry is reported', async () => {
  const factory = new ToolingConnectionFactory();
  // Seeded through the org's own rendering, so `existingExpiry` below names exactly the value the fixture
  // stores — the seed is written at a millisecond instant and the org keeps seconds, and the point of the
  // assertions is that the *stored* expiry survives the extend, not the instant that was asked for.
  const existingExpiry = asSalesforceStores(new Date(Date.now() + 3_600_000).toISOString());
  factory.debugLevels = [debugLevelRow('7dl000000000900AAA', DEBUG_LEVEL_TIERS.DEBUG.developerName)];
  factory.traceFlags = [traceFlagRow({ ExpirationDate: existingExpiry })];
  const scopes = await createScopes(factory);
  try {
    const output = await new ScopedTraceFlagExecutor(scopes.diagnostic, ALL_TOOLS).execute({
      tracedEntityKind: 'USER', tracedEntityId: '005000000000001AAA', durationMinutes: 30,
    });

    assert.equal(output.replacedExisting, true);
    assert.equal(output.traceFlagId, '7tf000000000900AAA');
    // The value read back is the stored one, in the notation the org uses — not re-rendered by this code.
    assert.equal(output.previousExpirationDate, existingExpiry);
    assert.deepEqual(scopes.factory.writes.map((write) => write.operation), ['UPDATE']);
    // Never shortened: the caller asked for 30 minutes and the flag already had 60, so the stored
    // expiry is the one that survives — an in-flight investigation is not cut short by a later call. The
    // payload names that same second (rendered the way this Tool writes a request), and the re-read below
    // returns it in the org's own notation — the two are one instant in two spellings, so it is compared
    // as an instant while the value reported back is compared as the string the org actually returned.
    assert.equal(instantOf(scopes.factory.writes[0]?.record.ExpirationDate), instantOf(existingExpiry));
    assert.equal(output.expirationDate, existingExpiry);
    assert.equal(output.verified, true);
  } finally {
    await scopes.close();
  }
});

test('an expiry in the org\'s own +0000 notation is read as active, not as an unparseable epoch', async () => {
  const factory = new ToolingConnectionFactory();
  // Salesforce answers with `…+0000`, never with a `Z` instant, and `expiryMs` falls back to 0 — "long
  // expired" — for anything it cannot parse. A row it failed to parse would read as history, so this Tool
  // would create a second flag for an entity that already has an active one, and the platform would refuse
  // the create for overlap (probe §2). That failure would look like a stale flag rather than a parse bug,
  // which is why the notation is asserted here instead of left to the live run.
  const seeded = asSalesforceStores(new Date(Date.now() + 7_200_000).toISOString());
  assert.match(String(seeded), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000\+0000$/u);
  factory.debugLevels = [debugLevelRow('7dl000000000900AAA', DEBUG_LEVEL_TIERS.DEBUG.developerName)];
  factory.traceFlags = [traceFlagRow({ ExpirationDate: seeded })];
  const scopes = await createScopes(factory);
  try {
    const output = await new ScopedTraceFlagExecutor(scopes.diagnostic, ALL_TOOLS).execute({
      tracedEntityKind: 'USER', tracedEntityId: '005000000000001AAA', durationMinutes: 30,
    });

    assert.equal(output.replacedExisting, true);
    assert.deepEqual(scopes.factory.writes.map((write) => write.operation), ['UPDATE']);
    assert.equal(output.previousExpirationDate, seeded);
    assert.equal(output.verified, true);
  } finally {
    await scopes.close();
  }
});

test('a shorter request against a longer active flag extends rather than shortens, and re-points the level', async () => {
  const factory = new ToolingConnectionFactory();
  factory.debugLevels = [debugLevelRow('7dl000000000900AAA', DEBUG_LEVEL_TIERS.MINIMAL.developerName,
    DEBUG_LEVEL_TIERS.MINIMAL.levels)];
  // 5 minutes out: the caller's 30-minute request is longer, so this one *is* extended.
  const existingExpiry = new Date(Date.now() + 300_000).toISOString();
  factory.traceFlags = [traceFlagRow({ ExpirationDate: existingExpiry, DebugLevelId: '7dl000000000000AAA' })];
  const scopes = await createScopes(factory);
  try {
    const output = await new ScopedTraceFlagExecutor(scopes.diagnostic, ALL_TOOLS).execute({
      tracedEntityKind: 'USER', tracedEntityId: '005000000000001AAA', durationMinutes: 30, logLevel: 'MINIMAL',
    });

    const update = scopes.factory.writes[0];
    assert.deepEqual(Object.keys(update?.record ?? {}).sort(), ['DebugLevelId', 'ExpirationDate', 'Id']);
    assert.equal(update?.record.DebugLevelId, '7dl000000000900AAA');
    assert.ok(Date.parse(String(update?.record.ExpirationDate)) > Date.parse(existingExpiry));
    assert.equal(output.debugLevelTier, 'MINIMAL');
  } finally {
    await scopes.close();
  }
});

test('an expired flag is history, not an active trace, so a new one is created instead of extended', async () => {
  const factory = new ToolingConnectionFactory();
  // Salesforce does not garbage-collect TraceFlag — the probe found rows from 2015 — so "a row exists
  // for this entity" cannot be read as "a trace is open".
  factory.traceFlags = [traceFlagRow({ ExpirationDate: '2015-01-01T00:00:00.000Z' })];
  const scopes = await createScopes(factory);
  try {
    const output = await new ScopedTraceFlagExecutor(scopes.diagnostic, ALL_TOOLS).execute({
      tracedEntityKind: 'USER', tracedEntityId: '005000000000001AAA',
    });

    assert.equal(output.replacedExisting, false);
    assert.deepEqual(scopes.factory.writes.map((write) => write.operation), ['CREATE', 'CREATE']);
  } finally {
    await scopes.close();
  }
});

test('a flag of the other kind blocks the create, and the refusal names the flag that is in the way', async () => {
  const factory = new ToolingConnectionFactory();
  const conflict = traceFlagRow({ Id: '7tf000000000777AAA', LogType: 'CLASS_TRACING' });
  factory.traceFlags = [conflict];
  // jsforce *rejects* a refused create rather than resolving with `success: false` — the measured
  // shape of the overlap refusal. The executor has to catch it here, because the active flags are in
  // scope at this point and nowhere further out.
  factory.traceFlagCreateRefusal = Object.assign(
    new Error('A trace flag already exists for this entity.'),
    { errorCode: 'FIELD_INTEGRITY_EXCEPTION' },
  );
  const scopes = await createScopes(factory);
  try {
    const error = await rejection(new ScopedTraceFlagExecutor(scopes.diagnostic, ALL_TOOLS).execute({
      tracedEntityKind: 'USER', tracedEntityId: '005000000000001AAA',
    }));

    assert.equal(error.code, 'MCP_TRACE_FLAG_INVALID');
    assert.match(error.message, /a flag of a different kind is already active for this entity/u);
    assert.match(error.message, /7tf000000000777AAA \(CLASS_TRACING, expires/u);
    // Deliberately no prerequisite: nothing in ADR-0029 §2's deployment list is missing here. This is
    // the platform's own overlap rule answering a real configuration conflict, and letting it claim a
    // permission gap would send an operator to change a grant that is not the problem.
    assert.equal(error.prerequisite, undefined);
    assert.match(error.suggestion ?? '', /Let the conflicting flag expire/u);
  } finally {
    await scopes.close();
  }
});

test('a create that resolves with success:false is refused with the same wording as a rejected one', async () => {
  const factory = new ToolingConnectionFactory();
  factory.traceFlags = [traceFlagRow({ LogType: 'CLASS_TRACING' })];
  factory.traceFlagCreateResult = {
    success: false, id: null, errors: [{ message: 'Duplicate trace flag' }],
  };
  const scopes = await createScopes(factory);
  try {
    const error = await rejection(new ScopedTraceFlagExecutor(scopes.diagnostic, ALL_TOOLS).execute({
      tracedEntityKind: 'USER', tracedEntityId: '005000000000001AAA',
    }));

    assert.equal(error.code, 'MCP_TRACE_FLAG_INVALID');
    assert.match(error.message, /Salesforce said: Duplicate trace flag/u);
  } finally {
    await scopes.close();
  }
});

test('a create refused for want of permission is a named prerequisite, never a generic write failure', async () => {
  for (const code of ['INSUFFICIENT_ACCESS', 'INSUFFICIENT_PRIVILEGES', 'API_DISABLED_FOR_ORG']) {
    const factory = new ToolingConnectionFactory();
    factory.traceFlagCreateRefusal = Object.assign(new Error('not permitted'), { errorCode: code });
    const scopes = await createScopes(factory);
    try {
      const error = await rejection(new ScopedTraceFlagExecutor(scopes.diagnostic, ALL_TOOLS).execute({
        tracedEntityKind: 'USER', tracedEntityId: '005000000000001AAA',
      }));

      assert.equal(error.code, 'MCP_DIAGNOSTIC_PREREQUISITE_MISSING', code);
      assert.equal(error.prerequisite, 'A-3');
      assert.equal(error.salesforceErrorCode, code);
      assert.match(error.suggestion ?? '', /deployment prerequisite A-3/u);
    } finally {
      await scopes.close();
    }
  }
});

test('a DebugLevel the org refuses to create is a write failure whose remedy names A-3', async () => {
  const factory = new ToolingConnectionFactory();
  factory.debugLevelCreateResult = {
    success: false, id: null, errors: [{ message: 'insufficient access rights on object id' }],
  };
  const scopes = await createScopes(factory);
  try {
    const error = await rejection(new ScopedTraceFlagExecutor(scopes.diagnostic, ALL_TOOLS).execute({
      tracedEntityKind: 'USER', tracedEntityId: '005000000000001AAA',
    }));

    assert.equal(error.code, 'MCP_TRACE_FLAG_WRITE_FAILED');
    assert.match(error.message, /refused to create the SFOA_P10_DEBUG DebugLevel/u);
    assert.match(error.suggestion ?? '', /trace-administration permission \(deployment prerequisite A-3\)/u);
    assert.deepEqual(scopes.factory.writes.map((write) => write.sobject), ['DebugLevel']);
  } finally {
    await scopes.close();
  }
});

test('a write the re-read does not confirm is reported as unverified rather than as success', async () => {
  const factory = new ToolingConnectionFactory();
  // The stored row is shorter than the window the caller asked for, which is exactly the case a
  // trusted write response would have hidden.
  factory.forcedExpirationOnRead = new Date(Date.now() + 60_000).toISOString();
  const scopes = await createScopes(factory);
  try {
    const output = await new ScopedTraceFlagExecutor(scopes.diagnostic, ALL_TOOLS).execute({
      tracedEntityKind: 'USER', tracedEntityId: '005000000000001AAA', durationMinutes: 30,
    });

    assert.equal(output.verified, false);
    assert.match(output.suggestion ?? '', /a successful write is a claim, not a measurement/u);
    assert.match(output.suggestion ?? '', /Confirm it in Salesforce Setup/u);
  } finally {
    await scopes.close();
  }
});

test('an unexpected trace failure is a write failure that never echoes the raw Salesforce text', async () => {
  const factory = new ToolingConnectionFactory();
  factory.queryError = new Error('socket hang up');
  const scopes = await createScopes(factory);
  try {
    const error = await rejection(new ScopedTraceFlagExecutor(scopes.diagnostic, ALL_TOOLS).execute({
      tracedEntityKind: 'USER', tracedEntityId: '005000000000001AAA',
    }));

    assert.equal(error.code, 'MCP_TRACE_FLAG_WRITE_FAILED');
    assert.equal(error.salesforceErrorCode, undefined);
    assert.doesNotMatch(error.message, /socket hang up/u);
    assert.match(error.suggestion ?? '', /Retry once/u);
  } finally {
    await scopes.close();
  }
});

test('the trace hint degrades to an actionable sentence when the listing Tool is not advertised', async () => {
  const scopes = await createScopes();
  try {
    const output = await new ScopedTraceFlagExecutor(scopes.diagnostic, ['set_trace_flag']).execute({
      tracedEntityKind: 'USER', tracedEntityId: '005000000000001AAA',
    });

    assert.doesNotMatch(hintOf(output), /get_apex_logs/u);
    assert.match(hintOf(output), /Reproduce the problem now, while this trace is active/u);
  } finally {
    await scopes.close();
  }
});

// ---------------------------------------------------------------------------------------------
// get_apex_logs — the scan, the status filter, the two cuts, and the count
// ---------------------------------------------------------------------------------------------

test('the log listing reports the rows, the org\'s own status vocabulary, and the window total', async () => {
  const factory = new ToolingConnectionFactory();
  factory.apexLogs = [
    apexLogRow({ Id: '07L000000000003AAA', Status: '成功' }),
    apexLogRow({ Id: '07L000000000002AAA', Status: '成功' }),
    apexLogRow({ Id: '07L000000000001AAA', Status: 'Failed' }),
  ];
  factory.countRecords = [{ total: 9 }];
  factory.countTotalSize = 9;
  const scopes = await createScopes(factory);
  try {
    const output = await new ScopedApexLogExecutor(scopes.diagnostic, ALL_TOOLS).execute({});

    assert.equal(output.success, true);
    assert.equal(output.api, 'TOOLING');
    assert.equal(output.returnedCount, 3);
    assert.equal(output.scannedCount, 3);
    assert.equal(output.totalCount, 9);
    assert.equal(output.truncated, false);
    assert.equal(output.timeWindowMinutes, APEX_LOG_DEFAULT_TIME_WINDOW_MINUTES);
    assert.equal(output.caveat, undefined);
    // Verbatim and untranslated: `observedStatuses` exists so a caller never has to guess which
    // spelling the filter needs, and it is ordered by count so the dominant value reads first.
    assert.deepEqual(output.observedStatuses, [{ status: '成功', count: 2 }, { status: 'Failed', count: 1 }]);
    assert.equal(output.logs?.[0]?.logUserName, 'Ada Lovelace');
    assert.equal(output.logs?.[0]?.logUserUsername, 'ada@example.test');
    assert.match(hintOf(output), /3 log\(s\) listed of 9 in this window/u);
    assert.match(hintOf(output), /Call get_debug_log_body with one of the ids above/u);

    // The window is computed from `now`, and the statement is ordered and bounded — the scan bound is
    // what `truncated` reports against when the window holds more rows than one page.
    const scan = scopes.factory.queries.find((query) => query.includes('ORDER BY LastModifiedDate DESC'));
    assert.match(scan ?? '', /^SELECT Id, LogUserId, LogUser\.Name, LogUser\.Username, Application, Operation, Status, /u);
    assert.match(scan ?? '', /ORDER BY LastModifiedDate DESC LIMIT 200$/u);
    // The window bound is a `dateTime` literal and must go out **unquoted**: quoting it makes it a string
    // literal, which this org's Tooling API refuses outright (`INVALID_FIELD`, measured in the T2 live
    // milestone), failing the whole Tool. The lookahead is a real UTC instant, not text either side of a
    // quote — so this assertion would also catch a window that arrived as free text.
    assert.match(scan ?? '', /LastModifiedDate >= \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /u);
    assert.doesNotMatch(scan ?? '', /LastModifiedDate >= '/u);
  } finally {
    await scopes.close();
  }
});

test('no log statement ever filters on the Status text, because the org stores a localized value', async () => {
  const factory = new ToolingConnectionFactory();
  factory.apexLogs = [apexLogRow({ Status: '成功' }), apexLogRow({ Id: '07L000000000002AAA', Status: 'Failed' })];
  const scopes = await createScopes(factory);
  try {
    // A `WHERE Status = 'Success'` would match 1 of these rows and a `WHERE Status = '成功'` would match
    // the other, so pushing the filter into SOQL would silently drop most of the window. The filter is
    // applied in memory and its reach is reported as `scannedCount` instead.
    const output = await new ScopedApexLogExecutor(scopes.diagnostic, ALL_TOOLS).execute({ status: '成功' });

    assert.equal(output.returnedCount, 1);
    assert.equal(output.scannedCount, 2);
    assert.equal(output.statusFilter, '成功');
    for (const query of scopes.factory.queries) {
      assert.doesNotMatch(query, /Status =/u, query);
    }
  } finally {
    await scopes.close();
  }
});

test('a filter that matched nothing says the filter is why, and names the values the org does store', async () => {
  const factory = new ToolingConnectionFactory();
  factory.apexLogs = [apexLogRow({ Status: '成功' })];
  const scopes = await createScopes(factory);
  try {
    const output = await new ScopedApexLogExecutor(scopes.diagnostic, ALL_TOOLS).execute({ status: 'Success' });

    assert.equal(output.returnedCount, 0);
    assert.equal(output.scannedCount, 1);
    // This is the answer that must not read as "nothing went wrong": rows matched the window and were
    // excluded by a vocabulary mismatch, and the hint says so with the literal to try instead.
    assert.match(hintOf(output), /No scanned row matched the status filter/u);
    assert.match(hintOf(output), /the scanned rows carry '成功'/u);
    assert.match(hintOf(output), /or pass one of those values verbatim/u);
    assert.doesNotMatch(hintOf(output), /No log was found in this window/u);
  } finally {
    await scopes.close();
  }
});

test('an empty window is a result that says what it does not know, not a claim that the org is quiet', async () => {
  const scopes = await createScopes(new ToolingConnectionFactory());
  try {
    const output = await new ScopedApexLogExecutor(scopes.diagnostic, ALL_TOOLS).execute({ timeWindowMinutes: 15 });

    assert.equal(output.returnedCount, 0);
    assert.equal(output.scannedCount, 0);
    assert.equal(output.totalCount, 0);
    assert.equal(output.timeWindowMinutes, 15);
    // ADR-0029 §3's A-1: whether the diagnostic identity may read other users' logs was never
    // established, so an empty org-wide window has two readings and the caller is told both.
    assert.match(output.caveat ?? '', /may read logs written by users other than itself/u);
    assert.match(output.caveat ?? '', /deployment prerequisite \(A-1\) that has not been established/u);
    assert.match(output.caveat ?? '', /a permission boundary rather than a quiet org/u);
    assert.match(hintOf(output), /No log was found in this window/u);
    assert.match(hintOf(output), /retention is short/u);
  } finally {
    await scopes.close();
  }
});

test('a count that cannot be read is null with a sample caveat, never a zero the org did not report', async () => {
  const factory = new ToolingConnectionFactory();
  factory.apexLogs = [apexLogRow()];
  factory.countRecords = [{ expr0: 'not a number' }];
  factory.countTotalSize = null;
  const scopes = await createScopes(factory);
  try {
    const output = await new ScopedApexLogExecutor(scopes.diagnostic, ALL_TOOLS).execute({});

    assert.equal(output.totalCount, null);
    assert.match(output.suggestion ?? '', /Treat the list as a sample of the window/u);
    assert.match(hintOf(output), /1 log\(s\) listed\./u);
  } finally {
    await scopes.close();
  }
});

test('the count survives the record-less aggregate form Salesforce answers a COUNT with', async () => {
  const factory = new ToolingConnectionFactory();
  factory.apexLogs = [apexLogRow()];
  // `SetupAuditTrail` answers `SELECT COUNT()` with an empty record list and the number in `totalSize`
  // (probe §4), so code reading only `records[0].expr0` would report zero.
  factory.countRecords = [];
  factory.countTotalSize = 42;
  const scopes = await createScopes(factory);
  try {
    assert.equal((await new ScopedApexLogExecutor(scopes.diagnostic, ALL_TOOLS).execute({})).totalCount, 42);
  } finally {
    await scopes.close();
  }
});

test('a userId narrows the statement by LogUserId, and the scan reports only that user\'s rows', async () => {
  const factory = new ToolingConnectionFactory();
  factory.apexLogs = [
    apexLogRow({ Id: '07L000000000001AAA', LogUserId: '005000000000001AAA' }),
    apexLogRow({ Id: '07L000000000002AAA', LogUserId: '005000000000002AAA' }),
  ];
  const scopes = await createScopes(factory);
  try {
    const output = await new ScopedApexLogExecutor(scopes.diagnostic, ALL_TOOLS).execute({
      userId: '005000000000002AAA',
    });

    assert.equal(output.scannedCount, 1);
    assert.equal(output.logs?.[0]?.logUserId, '005000000000002AAA');
    const scan = scopes.factory.queries.find((query) => query.includes('ORDER BY LastModifiedDate DESC'));
    assert.match(scan ?? '', /AND LogUserId = '005000000000002AAA'/u);
    // `Status` is a selected field — that is how `observedStatuses` is built — but it is never a
    // clause, which is the whole point of fetching a bounded scan and matching in memory.
    assert.doesNotMatch(scan ?? '', /Status =/u);
  } finally {
    await scopes.close();
  }
});

test('limit bounds the returned page, and the scan bound is reported as an incomplete window', async () => {
  const factory = new ToolingConnectionFactory();
  factory.apexLogs = Array.from({ length: 5 }, (_, index) => apexLogRow({
    Id: `07L00000000000${index}AAA`,
  }));
  const scopes = await createScopes(factory);
  try {
    const output = await new ScopedApexLogExecutor(scopes.diagnostic, ALL_TOOLS).execute({ limit: 2 });

    assert.equal(output.returnedCount, 2);
    assert.equal(output.scannedCount, 5);
    assert.equal(output.truncated, true);
    // A `limit` cut is not a budget cut: the caller asked for 2 and got 2, so nothing was dropped to
    // fit the response and the hint must not claim the list is incomplete by size.
    assert.match(hintOf(output), /2 log\(s\) listed/u);
    assert.doesNotMatch(hintOf(output), /dropped to fit the server's response budget/u);
  } finally {
    await scopes.close();
  }
});

test('rows dropped to fit the response budget are reported as incomplete by size, which is a different fact', async () => {
  const factory = new ToolingConnectionFactory();
  // ~3 KB of user name per row across a full page puts the answer past the 262 144-byte budget, so
  // the cut is made by size rather than by `limit` — and a caller reading only the counts could not
  // tell the two apart.
  factory.apexLogs = Array.from({ length: 100 }, (_, index) => apexLogRow({
    Id: `07L${String(index).padStart(12, '0')}AAA`,
    LogUser: { Name: 'x'.repeat(3_000), Username: 'ada@example.test' },
  }));
  const scopes = await createScopes(factory);
  try {
    const output = await new ScopedApexLogExecutor(scopes.diagnostic, ALL_TOOLS).execute({ limit: 100 });

    assert.equal(output.truncated, true);
    // `limit` was 100 and a full page came back, so nothing was cut by count — the whole difference
    // between what matched and what was returned is the response budget.
    const returned = output.returnedCount ?? 0;
    assert.ok(returned > 0);
    assert.ok(returned < 100);
    assert.match(hintOf(output), /dropped to fit the server's response budget/u);
    assert.match(hintOf(output), /incomplete by size rather than by count/u);
    assert.ok(JSON.stringify(output).length <= 262_144);
  } finally {
    await scopes.close();
  }
});

test('a log listing the org refuses is a named prerequisite, and a broken read is never an empty list', async () => {
  for (const code of ['INSUFFICIENT_ACCESS', 'INVALID_TYPE', 'API_DISABLED_FOR_ORG']) {
    const factory = new ToolingConnectionFactory();
    factory.queryError = Object.assign(new Error('denied'), { errorCode: code });
    const scopes = await createScopes(factory);
    try {
      const error = await rejection(new ScopedApexLogExecutor(scopes.diagnostic, ALL_TOOLS).execute({}));
      assert.equal(error.code, 'MCP_DIAGNOSTIC_PREREQUISITE_MISSING', code);
      assert.equal(error.prerequisite, 'A-1');
      assert.equal(error.salesforceErrorCode, code);
    } finally {
      await scopes.close();
    }
  }

  const factory = new ToolingConnectionFactory();
  factory.queryError = new Error('socket hang up');
  const scopes = await createScopes(factory);
  try {
    const error = await rejection(new ScopedApexLogExecutor(scopes.diagnostic, ALL_TOOLS).execute({}));
    assert.equal(error.code, 'MCP_APEX_LOG_READ_FAILED');
    assert.match(error.suggestion ?? '', /never returns an empty list/u);
  } finally {
    await scopes.close();
  }
});

test('the listing hint degrades when the body Tool is not advertised', async () => {
  const factory = new ToolingConnectionFactory();
  factory.apexLogs = [apexLogRow()];
  const scopes = await createScopes(factory);
  try {
    const output = await new ScopedApexLogExecutor(scopes.diagnostic, ['get_apex_logs']).execute({});
    assert.doesNotMatch(hintOf(output), /get_debug_log_body/u);
    assert.match(hintOf(output), /The log body is fetched separately, by log id/u);
  } finally {
    await scopes.close();
  }
});

// ---------------------------------------------------------------------------------------------
// get_debug_log_body — the versioned body fetch, the whole-body parse, and retention
// ---------------------------------------------------------------------------------------------

test('the log body is fetched from the versioned Tooling endpoint and summarised from the whole log', async () => {
  const factory = new ToolingConnectionFactory();
  factory.apexLogs = [apexLogRow({ LogLength: FAILING_LOG.length })];
  factory.bodies.set('07L000000000001AAA', FAILING_LOG);
  const scopes = await createScopes(factory);
  try {
    const output = await new ScopedDebugLogBodyExecutor(scopes.diagnostic, ALL_TOOLS).execute({
      logId: '07L000000000001AAA',
    });

    assert.equal(output.success, true);
    assert.equal(output.api, 'TOOLING');
    assert.equal(output.body, FAILING_LOG);
    assert.equal(output.truncated, false);
    assert.equal(output.maxCharacters, DEBUG_LOG_BODY_DEFAULT_MAX_CHARACTERS);
    assert.equal(output.totalCharacters, FAILING_LOG.length);
    assert.equal(output.returnedCharacters, FAILING_LOG.length);
    assert.equal(output.totalBytes, Buffer.byteLength(FAILING_LOG, 'utf8'));
    assert.equal(output.logLength, FAILING_LOG.length);

    // The parser reads the log's own header version rather than this deployment's API version: the
    // probe found 54.0 and 56.0 headers on an org whose API is v68.0.
    assert.equal(output.headerSummary?.logApiVersion, '56.0');
    assert.equal(output.headerSummary?.validated, true);
    assert.equal(output.headerSummary?.parseStatus, 'PARSED');
    assert.equal(output.headerSummary?.exceptionType, 'System.NullPointerException');
    assert.equal(output.headerSummary?.apexClass, 'MyClass');
    assert.equal(output.headerSummary?.lineNumber, 12);
    // `DB` is the token in the header; `Database` is the sObject field the level is set on.
    assert.equal(output.headerSummary?.categories.find((entry) => entry.token === 'DB')?.field, 'Database');
    assert.deepEqual(output.headerSummary?.stackSummary.map((frame) => frame.apexClass), ['MyClass', 'MyTrigger']);

    assert.deepEqual(scopes.factory.requests, [{
      method: 'GET',
      url: '/services/data/v65.0/tooling/sobjects/ApexLog/07L000000000001AAA/Body',
    }]);
    // The row is read first, so a purged log is reported as purged rather than as an empty body.
    assert.match(scopes.factory.queries[0] ?? '', /^SELECT Id, LogLength, LastModifiedDate FROM ApexLog WHERE Id = /u);
    assert.match(hintOf(output), /The top stack frame names MyClass line 12/u);
    assert.match(hintOf(output), /Call run_diagnostic_tooling_query with/u);
  } finally {
    await scopes.close();
  }
});

test('the returned prefix is cut at maxCharacters while the summary still describes the whole log', async () => {
  const factory = new ToolingConnectionFactory();
  // The failure this Tool exists to locate is written at the *end* of a log — exactly where the
  // budget cuts — so a summary parsed from the returned prefix would miss it. The log still begins
  // with its own header; the filler sits between the header and the exception.
  const [header, ...frames] = FAILING_LOG.split('\n');
  const longLog = [
    header,
    ...Array.from({ length: 2_000 }, (_, index) => `00:00:00.0 (${index})|USER_DEBUG|[1]|DEBUG|filler`),
    ...frames,
  ].join('\n');
  assert.ok(header !== undefined);
  factory.apexLogs = [apexLogRow({ LogLength: longLog.length })];
  factory.bodies.set('07L000000000001AAA', longLog);
  const scopes = await createScopes(factory);
  try {
    const output = await new ScopedDebugLogBodyExecutor(scopes.diagnostic, ALL_TOOLS).execute({
      logId: '07L000000000001AAA', maxCharacters: 1_000,
    });

    assert.equal(output.truncated, true);
    assert.equal(output.returnedCharacters, 1_000);
    assert.equal(output.totalCharacters, longLog.length);
    assert.equal(output.maxCharacters, 1_000);
    assert.equal(output.headerSummary?.exceptionType, 'System.NullPointerException');
    assert.equal(output.headerSummary?.lineNumber, 12);
    assert.match(hintOf(output), /cut at 1000 characters/u);
    assert.match(hintOf(output), /re-open a trace with set_trace_flag at logLevel MINIMAL/u);
  } finally {
    await scopes.close();
  }
});

test('a log Salesforce no longer retains is a purged log with its own code, not an empty body', async () => {
  const scopes = await createScopes(new ToolingConnectionFactory());
  try {
    const error = await rejection(new ScopedDebugLogBodyExecutor(scopes.diagnostic, ALL_TOOLS).execute({
      logId: '07L000000000001AAA',
    }));

    assert.equal(error.code, 'MCP_DEBUG_LOG_BODY_NOT_FOUND');
    assert.equal(error.prerequisite, 'A-2');
    assert.match(error.message, /is retained/u);
    assert.match(error.suggestion ?? '', /Re-open a trace on the target and reproduce/u);
    // The body is never fetched for a row that is not there: the row read is what makes the answer
    // "purged" rather than "empty".
    assert.deepEqual(scopes.factory.requests, []);
  } finally {
    await scopes.close();
  }
});

test('a retained row with no text is also A-2, and says the body was purged while the row was not', async () => {
  const factory = new ToolingConnectionFactory();
  factory.apexLogs = [apexLogRow()];
  factory.bodies.set('07L000000000001AAA', '');
  const scopes = await createScopes(factory);
  try {
    const error = await rejection(new ScopedDebugLogBodyExecutor(scopes.diagnostic, ALL_TOOLS).execute({
      logId: '07L000000000001AAA',
    }));

    assert.equal(error.code, 'MCP_DEBUG_LOG_BODY_NOT_FOUND');
    assert.equal(error.prerequisite, 'A-2');
    assert.match(error.message, /has an empty body/u);
    assert.match(error.suggestion ?? '', /the body has been purged while the row has not/u);
  } finally {
    await scopes.close();
  }
});

test('a body that is not a debug log is returned unread and reported as unparsed', async () => {
  const factory = new ToolingConnectionFactory();
  factory.apexLogs = [apexLogRow()];
  factory.bodies.set('07L000000000001AAA', '<html>Service unavailable</html>');
  const scopes = await createScopes(factory);
  try {
    const output = await new ScopedDebugLogBodyExecutor(scopes.diagnostic, ALL_TOOLS).execute({
      logId: '07L000000000001AAA',
    });

    assert.equal(output.body, '<html>Service unavailable</html>');
    assert.equal(output.headerSummary?.parseStatus, 'NOT_A_LOG');
    assert.equal(output.headerSummary?.apexClass, null);
    assert.match(hintOf(output), /did not begin with a debug-log header/u);
    assert.match(hintOf(output), /has been returned unread rather than summarised/u);
  } finally {
    await scopes.close();
  }
});

test('a body the org refuses is a named A-1 prerequisite, and a purged body on fetch is A-2', async () => {
  for (const code of ['INSUFFICIENT_ACCESS', 'INSUFFICIENT_ACCESS_OR_READONLY', 'INSUFFICIENT_PRIVILEGES']) {
    const factory = new ToolingConnectionFactory();
    factory.apexLogs = [apexLogRow()];
    factory.bodyFetchError = Object.assign(new Error('denied'), { errorCode: code });
    const scopes = await createScopes(factory);
    try {
      const error = await rejection(new ScopedDebugLogBodyExecutor(scopes.diagnostic, ALL_TOOLS).execute({
        logId: '07L000000000001AAA',
      }));
      assert.equal(error.code, 'MCP_DIAGNOSTIC_PREREQUISITE_MISSING', code);
      assert.equal(error.prerequisite, 'A-1');
      assert.match(error.suggestion ?? '', /may also belong to another user/u);
    } finally {
      await scopes.close();
    }
  }

  for (const code of ['NOT_FOUND', 'ENTITY_IS_DELETED', 'INVALID_ID_FIELD']) {
    const factory = new ToolingConnectionFactory();
    factory.apexLogs = [apexLogRow()];
    factory.bodyFetchError = Object.assign(new Error('gone'), { errorCode: code });
    const scopes = await createScopes(factory);
    try {
      const error = await rejection(new ScopedDebugLogBodyExecutor(scopes.diagnostic, ALL_TOOLS).execute({
        logId: '07L000000000001AAA',
      }));
      // The row was still listed when it was read a moment ago, so this is retention catching up
      // between the two calls rather than a bug — and the caller gets the remedy, not the code.
      assert.equal(error.code, 'MCP_DEBUG_LOG_BODY_NOT_FOUND', code);
      assert.equal(error.prerequisite, 'A-2');
    } finally {
      await scopes.close();
    }
  }
});

test('the body hint degrades to reading Salesforce directly when the query Tool is not advertised', async () => {
  const factory = new ToolingConnectionFactory();
  factory.apexLogs = [apexLogRow()];
  factory.bodies.set('07L000000000001AAA', FAILING_LOG);
  const scopes = await createScopes(factory);
  try {
    const output = await new ScopedDebugLogBodyExecutor(scopes.diagnostic, ['get_debug_log_body']).execute({
      logId: '07L000000000001AAA',
    });
    assert.doesNotMatch(hintOf(output), /run_diagnostic_tooling_query/u);
    assert.match(hintOf(output), /read that class and line in Salesforce/u);
  } finally {
    await scopes.close();
  }
});

// ---------------------------------------------------------------------------------------------
// The facade's audit summaries for the three Tools
// ---------------------------------------------------------------------------------------------

test('the facade records the traced entity, the filter literal and the verification in the audit trail', async () => {
  const logger = new RecordingLogger();
  // ADR-0029 §4d makes this part of the contract rather than an optional extra: the debug-log set is
  // the one place where "which entity was traced, with which filter, and did the write verify" is the
  // whole point of the row, and none of it is reconstructible from the Tool name.
  const facade = new ContextToolFacade({
    tool: new SetTraceFlagMcpTool({
      execute: async (input) => ({
        success: true, executionRole: 'DIAGNOSTIC', api: 'TOOLING', traceFlagId: '7tf000000000001AAA',
        tracedEntityKind: input.tracedEntityKind, tracedEntityId: input.tracedEntityId,
        logType: 'DEVELOPER_LOG', debugLevelId: '7dl000000000001AAA',
        debugLevelDeveloperName: 'SFOA_P10_DEBUG', debugLevelTier: 'DEBUG', debugLevelCreated: false,
        startDate: '2026-09-30T00:00:00.000Z', expirationDate: '2026-09-30T00:30:00.000Z',
        previousExpirationDate: null, replacedExisting: false, requestedDurationMinutes: 30,
        verified: false, hint: 'x',
      }),
    }),
    context: {
      platformUserId: TEST_PLATFORM_USER_A,
      correlationId: 'debuglog-facade-summary',
      workspaceRoot: process.cwd(),
    } as unknown as RequestContext,
    route: createSalesforceIdentityRoute({
      platformUserId: TEST_PLATFORM_USER_A,
      salesforceUsername: TEST_DIAGNOSTIC_USERNAME,
      credentialProfile: 'sfoa-shared-jwt-diagnostic',
      connectionRole: 'DIAGNOSTIC',
      aliases: [],
    }),
    toolTimeoutMs: 1_000,
    logger,
    clientId: 'test-client',
  });

  const result = await facade.execute({
    tracedEntityKind: 'APEX_CLASS', tracedEntityId: '01p000000000001AAA', durationMinutes: 45, logLevel: 'PROFILING',
  }, {} as never);

  assert.equal(result.isError, undefined);
  const terminal = logger.events.find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
  assert.equal(terminal?.executionRole, 'DIAGNOSTIC');
  assert.deepEqual(terminal?.requestSummary, {
    tracedEntityKind: 'APEX_CLASS', tracedEntityId: '01p000000000001AAA', logLevel: 'PROFILING', durationMinutes: 45,
  });
  // `verified: false` is recorded rather than dropped, so a write that Salesforce accepted but did not
  // confirm is visible in the trail and not only in the response the Agent happened to read.
  assert.equal((terminal?.responseSummary as Record<string, unknown>).verified, false);
  assert.equal((terminal?.responseSummary as Record<string, unknown>).totalCount, undefined);
});

test('a log listing records the filter literal verbatim, which is what makes a vocabulary mismatch legible', async () => {
  const logger = new RecordingLogger();
  const facade = new ContextToolFacade({
    tool: new GetApexLogsMcpTool({
      execute: async () => ({
        success: true, executionRole: 'DIAGNOSTIC', api: 'TOOLING', logs: [], totalCount: 0, returnedCount: 0,
        scannedCount: 0, truncated: false, timeWindowMinutes: 30, windowStartedAt: '2026-09-30T00:00:00.000Z',
        observedStatuses: [], hint: 'x',
      }),
    }),
    context: {
      platformUserId: TEST_PLATFORM_USER_A,
      correlationId: 'debuglog-facade-listing',
      workspaceRoot: process.cwd(),
    } as unknown as RequestContext,
    route: createSalesforceIdentityRoute({
      platformUserId: TEST_PLATFORM_USER_A,
      salesforceUsername: TEST_DIAGNOSTIC_USERNAME,
      credentialProfile: 'sfoa-shared-jwt-diagnostic',
      connectionRole: 'DIAGNOSTIC',
      aliases: [],
    }),
    toolTimeoutMs: 1_000,
    logger,
    clientId: 'test-client',
  });

  await facade.execute({ timeWindowMinutes: 30, status: 'Success', limit: 5 }, {} as never);

  const terminal = logger.events.find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
  assert.deepEqual(terminal?.requestSummary, {
    timeWindowMinutes: 30, userId: null, status: 'Success', limit: 5,
  });
  const summary = terminal?.responseSummary as Record<string, unknown>;
  assert.equal(summary.returnedCount, 0);
  assert.equal(summary.scannedCount, 0);
  assert.equal(summary.truncated, false);
});

test('a log body request records the id and the character bound, and the response records the truncation', async () => {
  const logger = new RecordingLogger();
  const facade = new ContextToolFacade({
    tool: new GetDebugLogBodyMcpTool({
      execute: async (input) => ({
        success: true, executionRole: 'DIAGNOSTIC', api: 'TOOLING', logId: input.logId, body: 'x',
        totalBytes: 4_000, returnedBytes: 1, totalCharacters: 4_000, returnedCharacters: 1,
        maxCharacters: input.maxCharacters ?? DEBUG_LOG_BODY_DEFAULT_MAX_CHARACTERS, truncated: true,
        logLength: 4_000, lastModifiedDate: null,
      }),
    }),
    context: {
      platformUserId: TEST_PLATFORM_USER_A,
      correlationId: 'debuglog-facade-body',
      workspaceRoot: process.cwd(),
    } as unknown as RequestContext,
    route: createSalesforceIdentityRoute({
      platformUserId: TEST_PLATFORM_USER_A,
      salesforceUsername: TEST_DIAGNOSTIC_USERNAME,
      credentialProfile: 'sfoa-shared-jwt-diagnostic',
      connectionRole: 'DIAGNOSTIC',
      aliases: [],
    }),
    toolTimeoutMs: 1_000,
    logger,
    clientId: 'test-client',
  });

  await facade.execute({ logId: '07L000000000001AAA', maxCharacters: 2_000 }, {} as never);

  const terminal = logger.events.find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
  assert.deepEqual(terminal?.requestSummary, { logId: '07L000000000001AAA', maxCharacters: 2_000 });
  assert.equal((terminal?.responseSummary as Record<string, unknown>).truncated, true);
  // The body itself is never summarised into the audit — the row carries sizes and flags, not log text.
  assert.equal(JSON.stringify(terminal?.responseSummary).includes('"body"'), false);
});

/**
 * The three debug-log Tools carry the audit purposes the ADR requires, and the write is separate.
 *
 * Declared on the facade as a total map so a moved Tool is a compile error rather than an `UNKNOWN`
 * row; this is the assertion that the two new purposes are in it and that the write is not folded
 * into the read.
 */
test('the debug-log write is audited under its own purpose, separate from the two reads', async () => {
  const { readFile } = await import('node:fs/promises');
  // The compiled module, because it is the artifact under test — this test runs from `dist`. The map
  // is not observable from a call the way a summary is: the purpose is attached to the Salesforce API
  // audit records the instrumented Connection emits, which this fixture deliberately does not model.
  // Reading the table is therefore the only way to fail when someone folds the write into the read
  // purpose, and `assertContextToolPurposesMatchRoleMap` (covered beside `get_org_limits`) only
  // proves totality, not which purpose each Tool got.
  const source = await readFile(new URL('../context-tool-facade.js', import.meta.url), 'utf8');
  assert.match(source, /set_trace_flag: 'TRACE_FLAG'/u);
  assert.match(source, /get_apex_logs: 'DEBUG_LOG'/u);
  assert.match(source, /get_debug_log_body: 'DEBUG_LOG'/u);
});
