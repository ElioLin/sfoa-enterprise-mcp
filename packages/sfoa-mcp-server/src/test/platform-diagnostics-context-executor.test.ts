import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import {
  ContextRuntimeError,
  GetPlatformDiagnosticsMcpTool,
  PLATFORM_DIAGNOSTICS_DEFAULT_LIMIT_PER_SECTION,
  PLATFORM_DIAGNOSTICS_DEFAULT_WINDOW_HOURS,
  platformDiagnosticsInputSchema,
  platformDiagnosticsOutputSchema,
  type PlatformDiagnosticsOutput,
  type PlatformDiagnosticsReader,
} from '@sfoa/mcp-provider-sfoa-context';
import { createSalesforceIdentityRoute, type RequestContext, type RequestScope, type RuntimeLogEvent } from '@sfoa/identity-runtime';
import { ContextToolFacade } from '../context-tool-facade.js';
import {
  PLATFORM_DIAGNOSTICS_STANDARD_OBJECTS,
  ScopedPlatformDiagnosticsReader,
} from '../platform-diagnostics-executor.js';

import {
  TEST_DIAGNOSTIC_USERNAME,
  TEST_PLATFORM_USER_A,
  TEST_USERNAME_A,
  createTestIdentityRuntime,
} from './helpers.js';

/**
 * Host-side coverage for `get_platform_diagnostics`.
 *
 * The provider package owns what is pure — the schemas, the stall rule, the hint — and covers it in
 * `platform-diagnostics-toolset.test.ts`. What needs a Connection and an identity is covered here, and it
 * is exactly the four disciplines the executor's own header names: the §0.3 `FROM`-target whitelist, ADR-0029
 * §3's degradation matrix (including the assertion that an unreadable source is never an empty one), the
 * window being enforced where it can be and reported where it cannot, and the response budget's ladder.
 *
 * The fixture is purpose-built rather than reusing `RecordingConnectionFactory`, because this Tool's whole
 * answer is *which rows of which platform tables* it read and how it merged them. A fixture that answered
 * every query with one generic row would let the aggregation be wrong while these tests passed. Each table
 * genuinely honours the clauses the production statements carry — a window literal really narrows, a
 * `Status IN (…)` really filters, a `LIMIT` really bounds — so an assertion on the output is an assertion
 * about the statement that was actually sent.
 */

// ---------------------------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------------------------

/**
 * A Connection over the org's three platform-status tables.
 *
 * `honourSetupWindow` is the one deliberate dishonesty the fixture can be asked for: with it off, the
 * entries query returns rows older than the window it was given, which is the only way to reach the
 * executor's own belt-and-braces filter and prove "禁止超窗口回传" holds even when a future edit loosens the
 * SOQL filter.
 */
class DiagnosticsConnectionFactory {
  public readonly creations: string[] = [];
  public readonly queries: string[] = [];
  public apiVersion = '65.0';
  /** Thrown by `create` itself: the Connection could not be opened at all. */
  public createError: unknown;

  public setupAuditTrail: Record<string, unknown>[] = [];
  public asyncApexJobs: Record<string, unknown>[] = [];
  public cronTriggers: Record<string, unknown>[] = [];
  public statusVocabulary: Record<string, unknown>[] = [];
  /** The `CronTrigger` response's own `totalSize`; `null` means "the fixture reports the rows it returned". */
  public cronTotalSize: number | null = null;
  /** Which of the two measured `COUNT()` spellings the setup count answers with. */
  public countForm: 'totalSize' | 'record' = 'totalSize';
  public oldestRetainedAt: string | null = null;

  /** Thrown by any query whose statement contains `match`. Specific beats general. */
  public queryErrors: { match: string; error: unknown }[] = [];
  public honourSetupWindow = true;
  /**
   * The same deliberate dishonesty for the failure table: with it off, the entries query answers with rows
   * older than the window it was given, which is the only way to reach the executor's own belt-and-braces
   * filter on that section and prove "禁止超窗口回传" does not depend on the org honouring the clause.
   */
  public honourAsyncWindow = true;

  public async create(route: { connectionRole: string; salesforceUsername: string }): Promise<Connection> {
    this.creations.push(route.salesforceUsername);
    if (this.createError !== undefined) throw this.createError;
    const connection = {
      // `RequestScopedSalesforceConnection.initialize` reads the API version off the Connection before it
      // hands it to the executor, so a fixture without it fails at initialization rather than at an
      // assertion — every test would report an auth failure instead of the behaviour it means to check.
      getApiVersion: () => this.apiVersion,
      query: async (query: string) => this.runQuery(query),
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

    if (query.includes('FROM SetupAuditTrail')) {
      if (query.includes('ORDER BY CreatedDate ASC')) {
        return this.oldestRetainedAt === null
          ? result([])
          : result([{ Id: '0Pa000000000000AAA', CreatedDate: this.oldestRetainedAt }]);
      }
      if (query.includes('SELECT COUNT()')) return this.setupCount(query);
      return result(this.setupEntries(query));
    }
    if (query.includes('FROM AsyncApexJob')) {
      if (query.includes('GROUP BY Status')) return result(this.statusVocabulary);
      if (query.includes('SELECT COUNT()')) return this.asyncCount(query);
      return result(this.asyncFailures(query));
    }
    if (query.includes('FROM CronTrigger')) {
      const records = this.cronTriggers.slice(0, limitOf(query));
      return { records, totalSize: this.cronTotalSize ?? records.length, done: true };
    }
    throw new Error(`Unexpected platform-diagnostics query in the fixture: ${query}`);
  }

  private setupEntries(query: string): Record<string, unknown>[] {
    const from = unquotedDateTime(query, 'CreatedDate >= ');
    const rows = this.honourSetupWindow && from !== null
      ? this.setupAuditTrail.filter((row) => instantOf(row.CreatedDate) >= instantOf(from))
      : [...this.setupAuditTrail];
    return rows.sort((left, right) => instantOf(right.CreatedDate) - instantOf(left.CreatedDate)).slice(0, limitOf(query));
  }

  private setupCount(query: string): unknown {
    const from = unquotedDateTime(query, 'CreatedDate >= ');
    const rows = this.honourSetupWindow && from !== null
      ? this.setupAuditTrail.filter((row) => instantOf(row.CreatedDate) >= instantOf(from))
      : this.setupAuditTrail;
    // Both spellings the probe measured, because `readOptionalCount` accepts both: the record-less form
    // (an empty `records` array with the number in `totalSize`, measured at 260 911) and a value in the
    // first record's synthetic column.
    return this.countForm === 'totalSize'
      ? { records: [], totalSize: rows.length, done: true }
      : { records: [{ expr0: rows.length }], totalSize: 1, done: true };
  }

  private asyncFailures(query: string): Record<string, unknown>[] {
    return this.matchingAsyncRows(query, this.honourAsyncWindow).slice(0, limitOf(query));
  }

  /** The same count reading as the setup table's, over the status-and-window conjunction. */
  private asyncCount(query: string): unknown {
    // The count always narrows on the window: it is the org's own answer about its own table, and the flag
    // exists to hand the *entries* read rows it should not have returned.
    const rows = this.matchingAsyncRows(query, true);
    return this.countForm === 'totalSize'
      ? { records: [], totalSize: rows.length, done: true }
      : { records: [{ expr0: rows.length }], totalSize: 1, done: true };
  }

  /**
   * The rows the failure statement describes: the status filter is always honoured, and the window literal is
   * honoured unless a test turns `honourAsyncWindow` off to reach the executor's own guard.
   */
  private matchingAsyncRows(query: string, honourWindow: boolean): Record<string, unknown>[] {
    const statuses = inList(query, 'Status IN (');
    const from = unquotedDateTime(query, 'CreatedDate >= ');
    const rows = this.asyncApexJobs
      .filter((row) => statuses.includes(String(row.Status)))
      .filter((row) => !honourWindow || from === null || !(instantOf(row.CreatedDate) < instantOf(from)));
    return rows.sort((left, right) => instantOf(right.CreatedDate) - instantOf(left.CreatedDate));
  }
}

function result(records: Record<string, unknown>[]): unknown {
  return { records, totalSize: records.length, done: true };
}

function fromTarget(query: string): string | null {
  return /\bFROM ([A-Za-z_][A-Za-z0-9_]*)/u.exec(query)?.[1] ?? null;
}

function limitOf(query: string): number {
  const match = /LIMIT (\d+)\s*$/u.exec(query);
  return match?.[1] === undefined ? Number.POSITIVE_INFINITY : Number(match[1]);
}

/** Every quoted literal inside the `IN (…)` list that begins at `marker`. */
function inList(query: string, marker: string): string[] {
  const at = query.indexOf(marker);
  if (at < 0) return [];
  const rest = query.slice(at + marker.length);
  const end = rest.indexOf(')');
  const inner = end < 0 ? rest : rest.slice(0, end);
  const found: string[] = [];
  const pattern = /'((?:[^'\\]|\\.)*)'/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(inner)) !== null) found.push((match[1] ?? '').replaceAll("\\'", "'"));
  return found;
}

/**
 * The unquoted `dateTime` literal immediately after `marker`.
 *
 * Deliberately *not* a quoted-literal reader: the T2 milestone established that this position must be
 * unquoted (`… >= 2026-10-09T00:00:00.000Z ORDER BY …`), and a helper that accepted a quoted form would
 * make the executor's own regression invisible to every test that uses it.
 */
function unquotedDateTime(query: string, marker: string): string | null {
  const at = query.indexOf(marker);
  if (at < 0) return null;
  return /^\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)/u.exec(query.slice(at + marker.length))?.[1] ?? null;
}

function instantOf(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

// ---------------------------------------------------------------------------------------------
// Row builders — every timestamp is relative to the moment the test runs, because the executor
// windows on its own clock and a fixture with fixed dates would drift out of every window.
// ---------------------------------------------------------------------------------------------

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** An `AsyncApexJob.CreatedDate` is what a job's occurrence is dated by, so this is a "finished" stamp. */
function at(minutes: number): string {
  return minutesAgo(minutes);
}

function setupRow(index: number, agoMinutes: number, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    Id: `0Pa${String(index).padStart(12, '0')}AAA`,
    Action: 'ApexClassCreated',
    CreatedBy: { Name: 'Setup Admin' },
    CreatedDate: at(agoMinutes),
    // The org's localized labels. Reported and never matched on — `Section` is not even filterable on this
    // object (measured `INVALID_FIELD`), which is why a fixture carrying labels is the honest one.
    Section: 'Apex 类',
    Display: `Created Apex class SFOA_Class_${index}`,
    DelegateUser: null,
    ...overrides,
  };
}

function asyncRow(index: number, agoMinutes: number, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    Id: `707${String(index).padStart(12, '0')}AAA`,
    Status: 'Failed',
    JobType: 'BatchApex',
    ApexClass: { Name: `SFOA_Failing_Batch_${index}` },
    NumberOfErrors: 1,
    ExtendedStatus: 'System.LimitException: Too many SOQL queries: 101',
    CreatedDate: at(agoMinutes),
    ...overrides,
  };
}

function cronRow(index: number, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    Id: `08e${String(index).padStart(12, '0')}AAA`,
    CronJobDetail: { Name: `SFOA_Scheduled_${index}`, JobType: '7' },
    State: 'WAITING',
    NextFireTime: at(45),
    PreviousFireTime: at(1_485),
    TimesTriggered: 12,
    ...overrides,
  };
}

function vocabulary(status: string, count: number): Record<string, unknown> {
  return { Status: status, total: count };
}

/** The baseline org: one change, one failure, and no scheduled job at all — which is what the probe measured. */
function seeded(factory = new DiagnosticsConnectionFactory()): DiagnosticsConnectionFactory {
  factory.setupAuditTrail = [setupRow(1, 50)];
  factory.asyncApexJobs = [asyncRow(1, 40)];
  factory.statusVocabulary = [vocabulary('Completed', 152), vocabulary('Failed', 0), vocabulary('Aborted', 0)];
  factory.cronTriggers = [];
  factory.oldestRetainedAt = '2026-04-08T07:40:48.000Z';
  return factory;
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
  factory: DiagnosticsConnectionFactory;
  close(): Promise<void>;
}>;

async function createScopes(factory = seeded()): Promise<Scopes> {
  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-p10-platform-'));
  const runtime = createTestIdentityRuntime(root, factory, new RecordingLogger(), TEST_DIAGNOSTIC_USERNAME);
  const diagnosticFactory = runtime.diagnosticScopeFactory;
  if (!diagnosticFactory) assert.fail('the test runtime must expose a DIAGNOSTIC scope factory');
  const diagnostic = await diagnosticFactory.create({
    platformUserId: TEST_PLATFORM_USER_A,
    correlationId: 'platform-diagnostic',
  });
  const user = await runtime.scopeFactory.create({
    platformUserId: TEST_PLATFORM_USER_A,
    correlationId: 'platform-user',
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
async function diagnostics(
  scopes: Scopes,
  input: Readonly<Record<string, unknown>> = {},
  advertised: readonly string[] = ALL_TOOLS,
): Promise<PlatformDiagnosticsOutput> {
  const output = await new ScopedPlatformDiagnosticsReader(scopes.diagnostic, advertised).execute(input as never);
  // Every assertion below is about a field the wire contract carries, so parsing here means a shape the
  // schema would reject can never be asserted on as if it were a valid answer. The byte budget is asserted
  // too: it is this Tool's hard contract, and one call site is enough to keep every case inside it.
  assert.ok(
    Buffer.byteLength(JSON.stringify(output), 'utf8') <= 262_144,
    'every answer this Tool produces must fit the platform response budget',
  );
  return platformDiagnosticsOutputSchema.parse(output) as PlatformDiagnosticsOutput;
}

/**
 * One section, typed by its own key.
 *
 * Generic rather than `output.sections?.[name]` on the union: the three sections carry different fields
 * (`oldestRetainedAt`, `observedStatusCounts`, `suspectedStallCount`), and an assertion about one of them is
 * only meaningful against that section's own type — which is the same reason the output schema pins the field
 * per section rather than making it a shared optional.
 */
function section<Name extends 'setupChanges' | 'asyncFailures' | 'scheduledJobs'>(
  output: PlatformDiagnosticsOutput,
  name: Name,
): NonNullable<NonNullable<PlatformDiagnosticsOutput['sections']>[Name]> {
  const value = output.sections?.[name];
  if (value === undefined) assert.fail(`expected the output to carry the ${name} section`);
  return value;
}

function hintOf(output: PlatformDiagnosticsOutput): string {
  const hint = output.hint;
  if (hint === undefined || hint.length === 0) assert.fail('expected the Tool output to carry a hint');
  return hint;
}

const ALL_TOOLS: readonly string[] = ['get_apex_logs', 'get_metadata_component_context', 'get_platform_diagnostics'];

// ---------------------------------------------------------------------------------------------
// The §0.3 data red line: the query surface is a constant whitelist
// ---------------------------------------------------------------------------------------------

test('every FROM target in the executor is on the T5 whitelist, and the whitelist is the three platform-status objects', async () => {
  const { readFile } = await import('node:fs/promises');
  // The compiled module, because it is the artifact under test — this test runs from `dist`. Comments are
  // stripped by the compiler, so what is scanned is the code and only the code.
  const source = await readFile(new URL('../platform-diagnostics-executor.js', import.meta.url), 'utf8');
  const targets = [...source.matchAll(/\bFROM ([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1] ?? '');
  assert.ok(targets.length >= 5, `the source scan must find the module's own FROM targets, found ${targets.length}`);
  const allowed: readonly string[] = PLATFORM_DIAGNOSTICS_STANDARD_OBJECTS;
  for (const target of targets) {
    assert.ok(allowed.includes(target), `FROM ${target} is not on the T5 whitelist`);
  }
  assert.deepEqual([...PLATFORM_DIAGNOSTICS_STANDARD_OBJECTS].sort(), ['AsyncApexJob', 'CronTrigger', 'SetupAuditTrail']);
  assert.equal(Object.isFrozen(PLATFORM_DIAGNOSTICS_STANDARD_OBJECTS), true);
  // ADR-0029 §4a: the DIAGNOSTIC identity was measured reading 955 `Lead` rows over this same API, so the
  // whitelist *is* the guarantee. `ApexLog` is here deliberately: ADR-0033 records the narrowing of the §4a
  // T5 row from four objects to three — the log surface belongs to `get_apex_logs`, which reads it
  // better-scoped than a merged timeline could.
  for (const excluded of ['Account', 'Contact', 'Lead', 'Opportunity', 'Case', 'User', 'ApexLog']) {
    assert.equal(allowed.includes(excluded), false, `${excluded} must not be queryable by this Tool`);
  }
});

test('a live call reads only whitelisted objects, and its three sources are all on the whitelist', async () => {
  const scopes = await createScopes();
  try {
    await diagnostics(scopes, {});
    const allowed: readonly string[] = PLATFORM_DIAGNOSTICS_STANDARD_OBJECTS;
    assert.ok(scopes.factory.queries.length >= 6, 'the executor must have read its three sources');
    for (const target of scopes.factory.fromTargets) {
      assert.ok(allowed.includes(target), `FROM ${target} was sent but is not whitelisted`);
    }
    for (const name of allowed) {
      assert.ok(scopes.factory.fromTargets.includes(name), `${name} is whitelisted but never read`);
    }
  } finally {
    await scopes.close();
  }
});

// ---------------------------------------------------------------------------------------------
// The window: enforced in SOQL on both dated tables, and reported as sent
// ---------------------------------------------------------------------------------------------

test('the setup query carries an unquoted dateTime lower bound that is the window, and the window is reported as sent', async () => {
  const scopes = await createScopes();
  try {
    const output = await diagnostics(scopes, { windowHours: 6 });
    const entries = scopes.factory.queries.find((query) => query.includes('FROM SetupAuditTrail WHERE CreatedDate >='));
    if (entries === undefined) assert.fail('the setup entries query must carry the window clause');
    const literal = unquotedDateTime(entries, 'CreatedDate >= ');
    if (literal === null) assert.fail(`the window must be an unquoted dateTime literal, got: ${entries}`);
    // The T2 milestone measured the cost of quoting this: a quoted dateTime is a string literal and the
    // platform refuses it with `INVALID_FIELD`, taking the whole section down. `unquotedDateTime` reads this
    // position as unquoted on purpose, so a regression to `'…'` fails here rather than on the live org.
    assert.equal(entries.includes(`'${literal}'`), false, 'the window literal must not be quoted');
    assert.match(entries, /CreatedDate >= \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z ORDER BY CreatedDate DESC/u);
    const expected = Date.now() - 6 * 3_600_000;
    assert.ok(Math.abs(Date.parse(literal) - expected) < 60_000, 'the lower edge must be now minus windowHours');

    assert.equal(output.window?.hours, 6);
    assert.equal(output.window?.from, literal);
  } finally {
    await scopes.close();
  }
});

test('the defaults are the contract\'s own: a 24-hour window, 25 entries per section, all three sections', async () => {
  const scopes = await createScopes();
  try {
    const output = await diagnostics(scopes, {});
    assert.equal(output.window?.hours, PLATFORM_DIAGNOSTICS_DEFAULT_WINDOW_HOURS);
    assert.deepEqual(Object.keys(output.sections ?? {}), ['setupChanges', 'asyncFailures', 'scheduledJobs']);
    const entries = scopes.factory.queries.find((query) => query.includes('FROM SetupAuditTrail WHERE')) ?? '';
    assert.match(entries, new RegExp(`LIMIT ${PLATFORM_DIAGNOSTICS_DEFAULT_LIMIT_PER_SECTION}$`, 'u'));
    assert.equal(output.readSectionCount, 3);
    assert.equal(output.unavailableSectionCount, 0);
  } finally {
    await scopes.close();
  }
});

test('a row older than the window is dropped even when the query returns it, and it reaches no timeline', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.setupAuditTrail = [
      setupRow(1, 30),
      // Older than any window this test asks for. The fixture is told to ignore its own window clause, so
      // this row really is handed to the executor — which is the only way to reach the in-memory filter.
      setupRow(2, 5_000, { Display: 'Created long before the window' }),
    ];
    scopes.factory.honourSetupWindow = false;
    const output = await diagnostics(scopes, { windowHours: 24, sections: ['SETUP_CHANGES'] });

    const setupChanges = section(output, 'setupChanges');
    assert.deepEqual(setupChanges.entries.map((entry) => entry.id), [setupRow(1, 30).Id]);
    assert.equal(
      output.alignment?.timeline?.some((entry) => entry.entryId === setupRow(2, 5_000).Id),
      false,
      'a row outside the window must not reach the merged timeline',
    );
  } finally {
    await scopes.close();
  }
});

test('only the requested sections are read, and an unrequested one is absent rather than empty', async () => {
  const scopes = await createScopes();
  try {
    const output = await diagnostics(scopes, { sections: ['SETUP_CHANGES'] });
    assert.deepEqual(Object.keys(output.sections ?? {}), ['setupChanges']);
    assert.equal(scopes.factory.queries.some((query) => query.includes('FROM AsyncApexJob')), false);
    assert.equal(scopes.factory.queries.some((query) => query.includes('FROM CronTrigger')), false);
    assert.equal(output.readSectionCount, 1);
    assert.equal(output.alignment?.timeline?.every((entry) => entry.section === 'SETUP_CHANGES'), true);
  } finally {
    await scopes.close();
  }
});

// ---------------------------------------------------------------------------------------------
// ADR-0029 §3: one source's refusal degrades that source and nothing else
// ---------------------------------------------------------------------------------------------

test('a refused setup audit trail is UNAVAILABLE with the missing prerequisite, and the other two sections still answer', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.queryErrors = [{
      match: 'FROM SetupAuditTrail',
      error: Object.assign(new Error('insufficient access'), { errorCode: 'INSUFFICIENT_ACCESS' }),
    }];
    const output = await diagnostics(scopes, {});
    const setupChanges = section(output, 'setupChanges');
    assert.equal(setupChanges.status, 'UNAVAILABLE');
    assert.deepEqual(setupChanges.entries, []);
    // Never 0. A zero here would be a claim about the org that this read did not earn, and it is the one
    // mistake that would turn an unread source back into a silent empty one.
    assert.equal(setupChanges.totalCount, null);
    assert.equal(setupChanges.truncated, false);
    assert.equal(setupChanges.errorCode, 'MCP_DIAGNOSTIC_PREREQUISITE_MISSING');
    assert.match(String(setupChanges.prerequisite), /SetupAuditTrail readability/u);
    assert.equal(setupChanges.oldestRetainedAt, null);
    assert.match(String(setupChanges.unavailableReason), /missing evidence, not a quiet window/u);

    assert.equal(section(output, 'asyncFailures').status, 'READ');
    assert.equal(section(output, 'scheduledJobs').status, 'READ');
    assert.equal(output.readSectionCount, 2);
    assert.equal(output.unavailableSectionCount, 1);
    // A section that is missing from the merge is not inferable from a list with fewer lines, so the note
    // and the hint both say it. The hint leads with it rather than with "line up the nearest change".
    assert.match(String(output.alignment?.note), /SETUP_CHANGES could not be read/u);
    assert.match(hintOf(output), /^1 of 3 section\(s\) could not be read/u);
  } finally {
    await scopes.close();
  }
});

test('a non-permission read failure is its own code with no prerequisite, so a transient failure is never read as a decision', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.queryErrors = [{ match: 'FROM SetupAuditTrail', error: new Error('socket hang up') }];
    const output = await diagnostics(scopes, {});
    const setupChanges = section(output, 'setupChanges');
    assert.equal(setupChanges.status, 'UNAVAILABLE');
    assert.equal(setupChanges.errorCode, 'MCP_PLATFORM_DIAGNOSTICS_READ_FAILED');
    assert.equal(setupChanges.prerequisite, undefined);
    assert.match(String(setupChanges.unavailableReason), /an empty list would read as "nothing happened"/u);
  } finally {
    await scopes.close();
  }
});

test('a refused count or oldest-retained read degrades to null with a caveat, never to a failed section', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.queryErrors = [
      { match: 'SELECT COUNT() FROM SetupAuditTrail', error: new Error('count refused') },
      { match: 'ORDER BY CreatedDate ASC', error: new Error('oldest refused') },
    ];
    const output = await diagnostics(scopes, {});
    const setupChanges = section(output, 'setupChanges');
    // The entries were read, so the section was read: a bound a reader wants is not the evidence itself.
    assert.equal(setupChanges.status, 'READ');
    assert.equal(setupChanges.entries.length, 1);
    assert.equal(setupChanges.totalCount, null);
    assert.equal(setupChanges.oldestRetainedAt, null);
    assert.equal(setupChanges.caveats.some((caveat) => /true row count could not be read/u.test(caveat)), true);
    assert.equal(setupChanges.caveats.some((caveat) => /oldest row this org still retains could not be read/u.test(caveat)), true);
    // `truncated` is evidence-led: an unknown total is not evidence that anything was cut.
    assert.equal(setupChanges.truncated, false);
    assert.equal(hintOf(output).includes('reaches back to'), false);
  } finally {
    await scopes.close();
  }
});

test('a zero-row filter with an unreadable vocabulary is UNAVAILABLE, because nothing proves the filter matches this org', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.asyncApexJobs = [];
    scopes.factory.queryErrors = [{ match: 'GROUP BY Status', error: new Error('aggregate refused') }];
    const output = await diagnostics(scopes, {});
    const asyncFailures = section(output, 'asyncFailures');
    // The probe measured this org translating at least one status vocabulary (`ApexLog.Status`), so a filter
    // that matched nothing while the vocabulary beside it is unreadable cannot be reported as "nothing
    // failed": the zero would be a claim this read has not earned. The entries query *succeeded*, and the
    // section is still UNAVAILABLE — which is ADR-0029 §3's rule applied to a possibly mis-filtered source.
    assert.equal(asyncFailures.status, 'UNAVAILABLE');
    assert.equal(asyncFailures.totalCount, null);
    assert.equal(asyncFailures.observedStatusCounts, null);
    assert.equal(asyncFailures.errorCode, 'MCP_PLATFORM_DIAGNOSTICS_READ_FAILED');
    assert.match(String(asyncFailures.unavailableReason), /matched nothing rather than matching the wrong literals/u);
    // The other sections are untouched by it.
    assert.equal(section(output, 'setupChanges').status, 'READ');
    assert.equal(output.readSectionCount, 2);
  } finally {
    await scopes.close();
  }
});

test('a failed vocabulary read beside matching rows is a caveat rather than a section state', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.queryErrors = [{ match: 'GROUP BY Status', error: new Error('aggregate refused') }];
    const output = await diagnostics(scopes, {});
    const asyncFailures = section(output, 'asyncFailures');
    // The rows the filter matched are themselves proof that the filter matches this org, so the failed
    // corroboration is reported beside them instead of escalating.
    assert.equal(asyncFailures.status, 'READ');
    assert.equal(asyncFailures.entries.length, 1);
    assert.equal(asyncFailures.observedStatusCounts, null);
    assert.equal(
      asyncFailures.caveats.some((caveat) => /status vocabulary .* could not be read/u.test(caveat)),
      true,
    );
  } finally {
    await scopes.close();
  }
});

test('the status vocabulary is what makes a zero-entry failure section evidenced, and it is reported in full', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.asyncApexJobs = [];
    const output = await diagnostics(scopes, {});
    assert.deepEqual(section(output, 'asyncFailures').observedStatusCounts, { Completed: 152, Failed: 0, Aborted: 0 });
    assert.equal(section(output, 'asyncFailures').totalCount, 0);
  } finally {
    await scopes.close();
  }
});

test('a scheduled-job table with no row at all is READ with a count of zero, not UNAVAILABLE', async () => {
  const scopes = await createScopes();
  try {
    const output = await diagnostics(scopes, {});
    const scheduledJobs = section(output, 'scheduledJobs');
    // The probe measured this org holding zero `CronTrigger` rows. Zero rows is a fact about the org; an
    // unreadable table is a different statement, and the two must not be spelled the same way.
    assert.equal(scheduledJobs.status, 'READ');
    assert.equal(scheduledJobs.totalCount, 0);
    assert.equal(scheduledJobs.suspectedStallCount, 0);
    assert.deepEqual(scheduledJobs.entries, []);
    assert.equal(scheduledJobs.caveats.some((caveat) => /holds no CronTrigger row at all/u.test(caveat)), true);
  } finally {
    await scopes.close();
  }
});

test('an unreadable scheduled-job table is UNAVAILABLE with its own prerequisite, distinguishable from zero rows', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.queryErrors = [{
      match: 'FROM CronTrigger',
      error: Object.assign(new Error('no such type'), { errorCode: 'INVALID_TYPE' }),
    }];
    const output = await diagnostics(scopes, {});
    const scheduledJobs = section(output, 'scheduledJobs');
    assert.equal(scheduledJobs.status, 'UNAVAILABLE');
    assert.equal(scheduledJobs.totalCount, null);
    assert.equal(scheduledJobs.suspectedStallCount, null);
    assert.equal(scheduledJobs.errorCode, 'MCP_DIAGNOSTIC_PREREQUISITE_MISSING');
    assert.match(String(scheduledJobs.prerequisite), /CronTrigger readability/u);
    // The two sections that did read are unaffected, and the answer still reports how many did.
    assert.equal(output.readSectionCount, 2);
    assert.equal(output.unavailableSectionCount, 1);
    assert.equal(output.alignment?.timeline?.some((entry) => entry.section === 'SCHEDULED_JOBS'), false);
  } finally {
    await scopes.close();
  }
});

test('a Connection that cannot be opened at all fails the call, not a section: there is no state to report yet', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.createError = Object.assign(new Error('user not licensed'), { errorCode: 'API_DISABLED_FOR_ORG' });
    const error = await rejection(new ScopedPlatformDiagnosticsReader(scopes.diagnostic, ALL_TOOLS).execute({}));
    // A call-level failure, not a section state: nothing was reached, so no section has a state to declare.
    assert.equal(error.code, 'MCP_PLATFORM_DIAGNOSTICS_READ_FAILED');
    assert.match(error.message, /could not complete the platform-diagnostics aggregation/u);
    assert.match(String(error.suggestion), /check the diagnostic identity's API access/u);
    // The code the identity runtime wrapped it in, which is what `readSalesforceFailure` finds first — the
    // inner `API_DISABLED_FOR_ORG` sits behind a `cause` the walk does not reach past a code it already has.
    // This branch is the executor's own guard rather than the live path: `ContextToolFacade` opens the same
    // request-scoped Connection first and reports an authentication failure as `MCP_SALESFORCE_AUTH_FAILED`
    // itself, so what arrives here is a call that got past the facade and then could not connect.
    assert.equal(error.salesforceErrorCode, 'MCP_SALESFORCE_AUTH_FAILED');
  } finally {
    await scopes.close();
  }
});

test('a USER request scope can never run this Tool, and never opens a Connection trying', async () => {
  const scopes = await createScopes();
  try {
    const error = await rejection(new ScopedPlatformDiagnosticsReader(scopes.user, ALL_TOOLS).execute({}));
    assert.equal(error.code, 'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED');
    assert.match(error.message, /get_platform_diagnostics requires the fixed server-owned DIAGNOSTIC request scope/u);
    assert.deepEqual(scopes.factory.creations, []);
    assert.deepEqual(scopes.factory.queries, []);
  } finally {
    await scopes.close();
  }
});

// ---------------------------------------------------------------------------------------------
// The two reads the fixture has to spell exactly: the count form and a bounded scan
// ---------------------------------------------------------------------------------------------

test('both measured COUNT() spellings are read: the value in totalSize and the value in the first record', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.setupAuditTrail = [setupRow(1, 30), setupRow(2, 20), setupRow(3, 10)];
    const first = await diagnostics(scopes, { sections: ['SETUP_CHANGES'], limitPerSection: 2 });
    assert.equal(section(first, 'setupChanges').totalCount, 3);
    // The record form: the probe recorded the response's own keys rather than assuming an alias, so the
    // reader takes the first numeric field that is not the `attributes` envelope.
    scopes.factory.countForm = 'record';
    scopes.factory.queries.length = 0;
    const second = await diagnostics(scopes, { sections: ['SETUP_CHANGES'], limitPerSection: 2 });
    assert.equal(section(second, 'setupChanges').totalCount, 3);
    // Newest first, and the cap keeps the two newest: 10 and 20 minutes ago, not the row that carries index 1.
    assert.deepEqual(section(second, 'setupChanges').entries.map((entry) => entry.id),
      [setupRow(3, 10).Id, setupRow(2, 20).Id]);
    // A total larger than the entries the cap kept is evidence, not a budget cut — and it is what makes the
    // section's `truncated` honest even at a limit the caller chose.
    assert.equal(section(second, 'setupChanges').truncated, true);
  } finally {
    await scopes.close();
  }
});

test('the failure total is the window\'s own count, not what the scan could reach', async () => {
  const scopes = await createScopes();
  try {
    // More matching rows in the window than the scan bound. While `AsyncApexJob.CreatedDate` was unmeasured
    // the section read a bounded newest-first scan and had to report an unknown total once that bound filled;
    // the T5 probe measured the filter, so the clause and the count are both pushed into the query and the
    // number the section reports is the window's, whatever it read.
    scopes.factory.asyncApexJobs = Array.from({ length: 260 }, (_unused, index) => asyncRow(index, 300 - index));
    const output = await diagnostics(scopes, { sections: ['ASYNC_FAILURES'], limitPerSection: 5 });
    const asyncFailures = section(output, 'asyncFailures');
    assert.equal(asyncFailures.totalCount, 260);
    assert.equal(asyncFailures.truncated, true);
    assert.equal(asyncFailures.entries.length, 5);
    const count = scopes.factory.queries.find((query) => query.includes('SELECT COUNT() FROM AsyncApexJob'));
    assert.match(
      String(count),
      /WHERE Status IN \('Failed','Aborted'\) AND CreatedDate >= \d{4}-\d{2}-\d{2}T[\d:.]+Z$/u,
      'the count must be over the same windowed conjunction the entries read uses',
    );
    // One row below the bound changes nothing: the count was never the bound.
    scopes.factory.asyncApexJobs = Array.from({ length: 199 }, (_unused, index) => asyncRow(index, 300 - index));
    scopes.factory.queries.length = 0;
    const bounded = await diagnostics(scopes, { sections: ['ASYNC_FAILURES'], limitPerSection: 5 });
    assert.equal(section(bounded, 'asyncFailures').totalCount, 199);
  } finally {
    await scopes.close();
  }
});

test('the failure query carries the measured date filter unquoted, and a row older than the window reaches no timeline', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.asyncApexJobs = [asyncRow(1, 60), asyncRow(2, 10_000)];
    // The fixture is told to ignore its own window clause for this read, so the older row really is handed to
    // the executor — which is the only way to reach its guard and prove "禁止超窗口回传" survives a future edit
    // that loosens the SOQL filter.
    scopes.factory.honourAsyncWindow = false;
    const output = await diagnostics(scopes, { sections: ['ASYNC_FAILURES'] });
    assert.deepEqual(section(output, 'asyncFailures').entries.map((entry) => entry.id), [asyncRow(1, 60).Id]);
    assert.equal(
      output.alignment?.timeline?.some((entry) => entry.entryId === asyncRow(2, 10_000).Id),
      false,
      'a job older than the window must not reach the merged timeline',
    );
    const query = scopes.factory.queries.find((candidate) => candidate.includes('FROM AsyncApexJob WHERE')) ?? '';
    assert.match(
      query,
      /WHERE Status IN \('Failed','Aborted'\) AND CreatedDate >= \d{4}-\d{2}-\d{2}T[\d:.]+Z ORDER BY CreatedDate DESC LIMIT 200$/u,
    );
    // The T2 milestone measured the cost of quoting this position: a quoted dateTime is a string literal and
    // the platform refuses it with `INVALID_FIELD`, taking the whole section down.
    assert.equal(/CreatedDate >= '/u.test(query), false, 'the window literal must not be quoted');
  } finally {
    await scopes.close();
  }
});

test('a row whose CreatedDate cannot be read is left out and reported, never silently placed or dropped', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.asyncApexJobs = [asyncRow(1, 60), asyncRow(2, 30, { CreatedDate: null })];
    const output = await diagnostics(scopes, { sections: ['ASYNC_FAILURES'] });
    assert.deepEqual(section(output, 'asyncFailures').entries.map((entry) => entry.id), [asyncRow(1, 60).Id]);
    assert.equal(
      section(output, 'asyncFailures').caveats.some((caveat) => /1 matching row\(s\) carried no readable CreatedDate/u.test(caveat)),
      true,
    );
  } finally {
    await scopes.close();
  }
});

test('the flattened traversal spelling of a parent name is read as well as the nested one', async () => {
  const scopes = await createScopes();
  try {
    // jsforce returns `CreatedBy: { Name }` for `CreatedBy.Name`, but a flattened `'CreatedBy.Name'` key is
    // what some paths produce. Both are read, and neither is a reason to report an unknown actor.
    scopes.factory.setupAuditTrail = [
      setupRow(1, 50, { CreatedBy: undefined, 'CreatedBy.Name': 'Flattened Admin' }),
      setupRow(2, 20, { CreatedBy: undefined, 'CreatedBy.Name': undefined }),
    ];
    scopes.factory.asyncApexJobs = [asyncRow(1, 30, { ApexClass: undefined, 'ApexClass.Name': 'SFOA_Flat_Batch' })];
    const output = await diagnostics(scopes, {});
    const entries = section(output, 'setupChanges').entries;
    const flattened = entries.find((entry) => entry.id === setupRow(1, 50).Id);
    const unnamed = entries.find((entry) => entry.id === setupRow(2, 20).Id);
    assert.equal(flattened?.createdBy, 'Flattened Admin');
    // A row whose traversal value is absent reports an unknown actor rather than an empty string.
    assert.equal(unnamed?.createdBy, null);
    assert.equal(section(output, 'asyncFailures').entries[0]?.apexClass, 'SFOA_Flat_Batch');
  } finally {
    await scopes.close();
  }
});

// ---------------------------------------------------------------------------------------------
// The stall rule, as it is applied to the org's own shapes
// ---------------------------------------------------------------------------------------------

test('a waiting job past the grace window is SUSPECTED, with reasons phrased as facts', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.cronTriggers = [cronRow(1, { State: 'WAITING', NextFireTime: at(45) })];
    const output = await diagnostics(scopes, { sections: ['SCHEDULED_JOBS'] });
    const entry = section(output, 'scheduledJobs').entries[0];
    assert.equal(entry?.stallAssessment, 'SUSPECTED');
    assert.match(String(entry?.stallReasons[0]), /which is a waiting state, and its next fire time passed 45 minutes ago/u);
    assert.match(String(entry?.stallReasons[1]), /flag to investigate, not a diagnosis/u);
    assert.match(String(entry?.stallReasons[1]), /does not know why/u);
    assert.equal(section(output, 'scheduledJobs').suspectedStallCount, 1);
    // The flag is counted over everything read, and it is the one judgement this Tool makes — so the hint
    // repeats the hedge rather than letting the count stand as a verdict.
    assert.match(hintOf(output), /flagged SUSPECTED stalled/u);
    assert.match(hintOf(output), /not a diagnosis/u);
  } finally {
    await scopes.close();
  }
});

test('a job that is late but inside the grace window, still ahead, running, or deleted is never flagged', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.cronTriggers = [
      cronRow(1, { State: 'WAITING', NextFireTime: at(29) }),
      cronRow(2, { State: 'WAITING', NextFireTime: new Date(Date.now() + 3_600_000).toISOString() }),
      cronRow(3, { State: 'ACQUIRED', NextFireTime: at(120) }),
      cronRow(4, { State: 'EXECUTING', NextFireTime: at(120) }),
      cronRow(5, { State: 'DELETED', NextFireTime: at(120) }),
    ];
    const output = await diagnostics(scopes, { sections: ['SCHEDULED_JOBS'] });
    assert.deepEqual(section(output, 'scheduledJobs').entries.map((entry) => entry.stallAssessment),
      ['NOT_SUSPECTED', 'NOT_SUSPECTED', 'NOT_SUSPECTED', 'NOT_SUSPECTED', 'NOT_SUSPECTED']);
    assert.equal(section(output, 'scheduledJobs').suspectedStallCount, 0);
    assert.match(String(section(output, 'scheduledJobs').entries[0]?.stallReasons[0]), /inside the 30 minutes grace window/u);
    assert.match(String(section(output, 'scheduledJobs').entries[2]?.stallReasons[0]), /means the job is running now/u);
  } finally {
    await scopes.close();
  }
});

test('a state literal this rule has never seen is INDETERMINATE, because the vocabulary was never measurable', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.cronTriggers = [
      cronRow(1, { State: 'ZONKED' }),
      cronRow(2, { State: null }),
      cronRow(3, { State: 'PAUSED' }),
      cronRow(4, { State: 'WAITING', NextFireTime: null }),
    ];
    const output = await diagnostics(scopes, { sections: ['SCHEDULED_JOBS'] });
    assert.deepEqual(section(output, 'scheduledJobs').entries.map((entry) => entry.stallAssessment),
      ['INDETERMINATE', 'INDETERMINATE', 'INDETERMINATE', 'INDETERMINATE']);
    assert.match(String(section(output, 'scheduledJobs').entries[0]?.stallReasons[1]), /holds no CronTrigger rows/u);
    assert.equal(section(output, 'scheduledJobs').suspectedStallCount, 0);
  } finally {
    await scopes.close();
  }
});

// ---------------------------------------------------------------------------------------------
// The merged timeline
// ---------------------------------------------------------------------------------------------

test('the timeline merges the three sources oldest first, each entry naming its own section', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.setupAuditTrail = [setupRow(1, 50)];
    scopes.factory.asyncApexJobs = [asyncRow(1, 40)];
    scopes.factory.cronTriggers = [cronRow(1, { State: 'WAITING', NextFireTime: at(35), PreviousFireTime: at(1_475) })];
    const output = await diagnostics(scopes, {});
    assert.deepEqual(output.alignment?.timeline?.map((entry) => entry.section),
      ['SETUP_CHANGES', 'ASYNC_FAILURES', 'SCHEDULED_JOBS']);
    assert.deepEqual(output.alignment?.timeline?.map((entry) => entry.entryId),
      [setupRow(1, 50).Id, asyncRow(1, 40).Id, cronRow(1).Id]);
    assert.match(String(output.alignment?.timeline?.[0]?.summary), /ApexClassCreated by Setup Admin/u);
    assert.match(String(output.alignment?.timeline?.[1]?.summary), /Failed BatchApex SFOA_Failing_Batch_1, errors=1/u);
    // "was due to fire" is a claim about the schedule; "last fired" is a claim about what happened. The
    // merged list is the one place the two could be confused, so the wording is asserted.
    assert.match(String(output.alignment?.timeline?.[2]?.summary), /was due to fire and did not/u);
    assert.match(String(output.alignment?.timeline?.[2]?.summary), /state=WAITING, last fired/u);
  } finally {
    await scopes.close();
  }
});

test('a scheduled job contributes at most one line, and a job with no time inside the window contributes none', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.cronTriggers = [
      // SUSPECTED, and its last fire is inside the window too: the due time is the line, not both.
      cronRow(1, { State: 'WAITING', NextFireTime: at(45), PreviousFireTime: at(1_485) }),
      // Not late, last fired inside the window: the fire is the line.
      cronRow(2, { State: 'WAITING', NextFireTime: at(-30), PreviousFireTime: at(1_400) }),
      // Nothing inside the window at all.
      cronRow(3, { State: 'WAITING', NextFireTime: at(-60), PreviousFireTime: at(1_500) }),
    ];
    const output = await diagnostics(scopes, { windowHours: 24, sections: ['SCHEDULED_JOBS'] });
    const timeline = output.alignment?.timeline ?? [];
    assert.equal(timeline.filter((entry) => entry.entryId === cronRow(1).Id).length, 1);
    assert.match(String(timeline.find((entry) => entry.entryId === cronRow(1).Id)?.summary), /was due to fire and did not/u);
    assert.match(String(timeline.find((entry) => entry.entryId === cronRow(2).Id)?.summary), /last fired/u);
    assert.equal(timeline.some((entry) => entry.entryId === cronRow(3).Id), false);
    // Still current state, not history: the section reports every row it read whatever the window holds.
    assert.equal(section(output, 'scheduledJobs').entries.length, 3);
  } finally {
    await scopes.close();
  }
});

test('two entries on the same instant are ordered by section and then by id, so two calls read the same', async () => {
  const scopes = await createScopes();
  try {
    const shared = at(20);
    scopes.factory.setupAuditTrail = [setupRow(9, 20, { CreatedDate: shared }), setupRow(2, 20, { CreatedDate: shared })];
    scopes.factory.asyncApexJobs = [asyncRow(1, 20, { CreatedDate: shared })];
    const output = await diagnostics(scopes, {});
    assert.deepEqual(output.alignment?.timeline?.map((entry) => [entry.section, entry.entryId]), [
      ['SETUP_CHANGES', setupRow(2, 20).Id],
      ['SETUP_CHANGES', setupRow(9, 20).Id],
      ['ASYNC_FAILURES', asyncRow(1, 20).Id],
    ]);
    const again = await diagnostics(scopes, {});
    assert.deepEqual(again.alignment?.timeline, output.alignment?.timeline);
  } finally {
    await scopes.close();
  }
});

test('the alignment note says what the merge establishes and what it does not: candidate, not cause; two clocks', async () => {
  const scopes = await createScopes();
  try {
    const output = await diagnostics(scopes, {});
    const note = String(output.alignment?.note);
    assert.match(note, /oldest first, and each entry names its own section/u);
    assert.match(note, /it is a candidate and not a cause/u);
    assert.match(note, /the upper edge is .*this server's clock/u);
  } finally {
    await scopes.close();
  }
});

test('a section that was not requested is absent from the merge, and the note says the omission was the call\'s own', async () => {
  const scopes = await createScopes();
  try {
    const output = await diagnostics(scopes, { sections: ['ASYNC_FAILURES'] });
    // The distinction the note has to draw: sections missing because they could not be read (resolve a
    // prerequisite) versus sections missing because this call did not ask for them (re-run without the
    // argument). A reader sees the same short timeline either way.
    assert.match(String(output.alignment?.note), /asked for 1 of the 3 sections/u);
    assert.equal(/could not be read/u.test(String(output.alignment?.note)), false);
    assert.deepEqual(output.alignment?.timeline?.map((entry) => entry.section), ['ASYNC_FAILURES']);
    // A call that asks for all three says nothing about a subset.
    scopes.factory.queries.length = 0;
    const complete = await diagnostics(scopes, {});
    assert.equal(/asked for \d of the 3 sections/u.test(String(complete.alignment?.note)), false);
  } finally {
    await scopes.close();
  }
});

// ---------------------------------------------------------------------------------------------
// The response budget
// ---------------------------------------------------------------------------------------------

test('the budget cuts entries before it cuts fields, and every cut is declared per section', async () => {
  const scopes = await createScopes();
  try {
    // Sized so the top rung cannot fit and the field step is not what saves it: each entry carries a
    // 2 000-character `Display`, which the field step would clip to 500 — so an answer that keeps them whole
    // is an answer that fitted by dropping entries instead.
    const padded = 'D'.repeat(2_000);
    scopes.factory.setupAuditTrail = Array.from({ length: 100 }, (_unused, index) => setupRow(index, 300 - index, { Display: padded }));
    scopes.factory.asyncApexJobs = Array.from({ length: 100 }, (_unused, index) => asyncRow(index, 300 - index));
    scopes.factory.cronTriggers = Array.from({ length: 100 }, (_unused, index) => cronRow(index));
    const output = await diagnostics(scopes, { limitPerSection: 100 });

    const setupChanges = section(output, 'setupChanges');
    const kept = setupChanges.entries.length;
    assert.ok(kept >= 1 && kept < 100, `the ladder must have cut the entry lists, kept ${kept}`);
    assert.equal(setupChanges.truncated, true);
    assert.match(String(setupChanges.caveats.find((caveat) => /response budget kept/u.test(caveat))),
      new RegExp(`response budget kept ${kept} of this section's 100 entries`, 'u'));
    // Entries first: the fields are exactly what the org returned, so the cut was the entry count.
    assert.equal(setupChanges.entries.every((entry) => entry.display === padded), true);
    assert.equal(
      setupChanges.caveats.some((caveat) => /Free-text fields longer than/u.test(caveat)),
      false,
      'the field step must not have run while the largest entry rung still fitted',
    );
    assert.equal(output.truncated, true);
    // The timeline is built from the entries the answer carries, and the note says so rather than leaving a
    // reader to notice the list is shorter than the window.
    assert.match(String(output.alignment?.note), /is not the whole window/u);
    assert.ok((output.alignment?.timeline?.length ?? 0) <= kept * 3);
    assert.match(hintOf(output), /Entries were dropped to fit the server's response budget/u);
  } finally {
    await scopes.close();
  }
});

test('when no entry count fits, the field step clips the unbounded strings and says that it did', async () => {
  const scopes = await createScopes();
  try {
    // A single field larger than the whole budget: no rung of the entry ladder can fit it, which is the
    // state ADR-0033 records as unreachable on this org (`Display` is a platform-bounded field) and the
    // field step exists for. The clip is reported, so a shortened value is never shown as a whole one.
    scopes.factory.setupAuditTrail = [setupRow(1, 50, { Display: 'D'.repeat(300_000) })];
    scopes.factory.asyncApexJobs = [];
    const output = await diagnostics(scopes, { sections: ['SETUP_CHANGES'], limitPerSection: 1 });
    const entry = section(output, 'setupChanges').entries[0];
    assert.equal(entry?.display?.length, 500);
    assert.match(String(entry?.display), /…$/u);
    assert.match(String(section(output, 'setupChanges').caveats.find((caveat) => /Free-text fields/u.test(caveat))),
      /Free-text fields longer than 500 characters were clipped/u);
    // The timeline's own summaries are bounded independently, so the merged list stays a reading list.
    assert.ok((output.alignment?.timeline?.[0]?.summary.length ?? 0) <= 300);
  } finally {
    await scopes.close();
  }
});

test('a scheduled job\'s free text is clipped too, including its reasons, and the clip is declared', async () => {
  const scopes = await createScopes();
  try {
    scopes.factory.cronTriggers = [cronRow(1, { CronJobDetail: { Name: 'N'.repeat(300_000), JobType: '7' } })];
    scopes.factory.setupAuditTrail = [];
    scopes.factory.asyncApexJobs = [];
    const output = await diagnostics(scopes, { sections: ['SCHEDULED_JOBS'], limitPerSection: 1 });
    const entry = section(output, 'scheduledJobs').entries[0];
    assert.equal(entry?.name?.length, 500);
    assert.equal(
      section(output, 'scheduledJobs').caveats.some((caveat) => /Free-text fields longer than 500/u.test(caveat)),
      true,
    );
  } finally {
    await scopes.close();
  }
});

// ---------------------------------------------------------------------------------------------
// The facade: role gate, audit purpose and audit summaries
// ---------------------------------------------------------------------------------------------

test('the facade records the window and sections as sent, and the per-section outcome counts', async () => {
  const logger = new RecordingLogger();
  const scopes = await createScopes();
  try {
    scopes.factory.cronTriggers = [cronRow(1)];
    const reader = new ScopedPlatformDiagnosticsReader(scopes.diagnostic, ALL_TOOLS);
    const tool = new GetPlatformDiagnosticsMcpTool(reader);
    const facade = new ContextToolFacade({
      tool,
      context: {
        platformUserId: TEST_PLATFORM_USER_A,
        correlationId: 'platform-facade-summary',
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

    const result = await facade.execute({}, {} as never);
    assert.equal(result.isError, undefined);
    const terminal = logger.events.find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
    assert.equal(terminal?.executionRole, 'DIAGNOSTIC');
    // ADR-0029 §4d's rule for the diagnostic set: the row has to answer its own question. Here that is how
    // far back the read reached and which sections were asked for — and an omitted argument is recorded as
    // omitted rather than as the default the Tool happened to resolve it to.
    assert.deepEqual(terminal?.requestSummary, {
      windowHours: null,
      sections: [],
      sectionCount: 0,
      limitPerSection: null,
    });
    const summary = terminal?.responseSummary as Record<string, unknown>;
    // `success: true` on this Tool means the aggregation ran, not that every source was read — so the two
    // section counts are what the row answers §3's aggregator clause with.
    assert.equal(summary.readSectionCount, 3);
    assert.equal(summary.unavailableSectionCount, 0);
    assert.equal(summary.timelineEntryCount, (result.structuredContent as PlatformDiagnosticsOutput).alignment?.timeline?.length);
    assert.equal(summary.truncated, false);

    // A second call, sent explicitly. The row records what was sent, including the window in hours.
    const explicit = await facade.execute({ windowHours: 6, sections: ['SETUP_CHANGES'], limitPerSection: 5 }, {} as never);
    assert.equal(explicit.isError, undefined);
    const second = logger.events.filter((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL')[1];
    assert.deepEqual(second?.requestSummary, {
      windowHours: 6,
      sections: ['SETUP_CHANGES'],
      sectionCount: 1,
      limitPerSection: 5,
    });
  } finally {
    await scopes.close();
  }
});

test('a degraded call still succeeds, and the audit row carries the unavailable count rather than a bare success', async () => {
  const logger = new RecordingLogger();
  const scopes = await createScopes();
  try {
    scopes.factory.queryErrors = [{
      match: 'FROM CronTrigger',
      error: Object.assign(new Error('no such type'), { errorCode: 'INVALID_TYPE' }),
    }];
    const facade = new ContextToolFacade({
      tool: new GetPlatformDiagnosticsMcpTool(new ScopedPlatformDiagnosticsReader(scopes.diagnostic, ALL_TOOLS)),
      context: {
        platformUserId: TEST_PLATFORM_USER_A,
        correlationId: 'platform-facade-degraded',
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

    const result = await facade.execute({ sections: ['SETUP_CHANGES', 'SCHEDULED_JOBS'] }, {} as never);
    assert.equal(result.isError, undefined);
    const terminal = logger.events.find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
    assert.equal(terminal?.result, 'PASS');
    const summary = terminal?.responseSummary as Record<string, unknown>;
    assert.equal(summary.readSectionCount, 1);
    assert.equal(summary.unavailableSectionCount, 1);
  } finally {
    await scopes.close();
  }
});

test('the facade refuses a USER route, audits it as BLOCKED, and never reaches the executor', async () => {
  const logger = new RecordingLogger();
  let executions = 0;
  const reader: PlatformDiagnosticsReader = {
    execute: async () => {
      executions += 1;
      throw new Error('the facade must not reach the executor on a USER route');
    },
  };
  const facade = new ContextToolFacade({
    tool: new GetPlatformDiagnosticsMcpTool(reader),
    context: {
      platformUserId: TEST_PLATFORM_USER_A,
      correlationId: 'platform-facade-user',
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
  assert.equal(executions, 0);
  const terminal = logger.events.find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
  assert.equal(terminal?.result, 'BLOCKED');
  assert.equal(terminal?.outcome, 'DENIED');
});

test('the platform aggregation is audited under its own purpose, separate from every other diagnostic purpose', async () => {
  const { readFile } = await import('node:fs/promises');
  // The purpose is attached to the Salesforce API audit records the instrumented Connection emits, which
  // this fixture deliberately does not model, so reading the table is the only way to fail when a later edit
  // folds this Tool into `PERMISSION_EXPLAIN` or `DIAGNOSTIC_TOOLING`. Both folds would misname the read:
  // this Tool issues no Tooling query and no permission-table read.
  const source = await readFile(new URL('../context-tool-facade.js', import.meta.url), 'utf8');
  assert.match(source, /get_platform_diagnostics: 'PLATFORM_DIAGNOSTICS'/u);
});

test('the advertised Tool list is what bounds the hint, and an unadvertised Tool is never named', async () => {
  const scopes = await createScopes();
  try {
    const withTools = await diagnostics(scopes, {}, ALL_TOOLS);
    assert.match(hintOf(withTools), /get_metadata_component_context/u);
    assert.match(hintOf(withTools), /get_apex_logs/u);

    // The same call on a session that advertises nothing else: a hint naming a Tool the `tools/list` does
    // not carry would send an Agent to a name it cannot call.
    const alone = await diagnostics(scopes, {}, ['get_platform_diagnostics']);
    assert.equal(/get_metadata_component_context|get_apex_logs/u.test(hintOf(alone)), false);
  } finally {
    await scopes.close();
  }
});

test('the Tool\'s own input schema admits exactly the three arguments the audit row records', () => {
  assert.equal(platformDiagnosticsInputSchema.safeParse({}).success, true);
  assert.equal(platformDiagnosticsInputSchema.safeParse({ windowHours: 168, limitPerSection: 100 }).success, true);
  assert.equal(platformDiagnosticsInputSchema.safeParse({ windowHours: 169 }).success, false);
  assert.equal(platformDiagnosticsInputSchema.safeParse({ limitPerSection: 101 }).success, false);
  assert.equal(platformDiagnosticsInputSchema.safeParse({ sections: [] }).success, false);
  // The identity/surface fields every Context Tool refuses, on this Tool too.
  for (const forged of ['username', 'platformUserId', 'connectionRole', 'useToolingApi', 'diagnosticUsername']) {
    assert.equal(platformDiagnosticsInputSchema.safeParse({ [forged]: 'forged' }).success, false, `${forged} must be refused`);
  }
});
