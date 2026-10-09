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
  currentSalesforceApiPurpose,
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
 * `get_platform_diagnostics` at the protocol boundary, over the real Streamable HTTP surface.
 *
 * The host suite covers the aggregation, the degradation matrix and the budget as functions of a
 * `RequestScope`. Four claims are only true here, and no unit test can make any of them:
 *
 * 1. **Invisible until enabled.** Governance decides which names exist. A Tool an Admin has not enabled is
 *    not merely refused — it is absent from `tools/list`, so an Agent cannot plan around it, and a call to
 *    the name is denied before any Provider is composed.
 * 2. **Routed to the server-owned DIAGNOSTIC identity.** The role map decides that before the Tool body
 *    runs. This is the failure the whole classification exists to prevent — this Tool reads who changed the
 *    org, which must never be read as the caller.
 * 3. **The read is attributed to `PLATFORM_DIAGNOSTICS`.** The purpose is ambient state the facade installs
 *    around the Tool body, so a fixture that reads it from inside its own `query` is asserting the wiring
 *    rather than a naming convention.
 * 4. **ADR-0029 §3's aggregator clause holds on the wire.** One source's refusal must leave the other two
 *    answering and must still not be a failed call — and the audit row for that call has to say how many
 *    sections were unavailable rather than recording a bare success.
 */
const DIAGNOSTIC_TOOLS = ['get_platform_diagnostics'] as const;

/** ADR-0029 §4a's T5 whitelist, as the wire is allowed to name it. */
const WHITELIST = Object.freeze(['SetupAuditTrail', 'AsyncApexJob', 'CronTrigger'] as const);

const OLDEST_RETAINED_AT = '2026-04-08T07:40:48.000Z';

class RecordingLogger implements RuntimeLogger {
  public readonly events: RuntimeLogEvent[] = [];

  public log(event: RuntimeLogEvent): void {
    this.events.push(event);
  }

  public forTool(toolName: string): RuntimeLogEvent[] {
    return this.events.filter((event) => event.toolName === toolName);
  }
}

/** The statements the fixture was asked, each tagged with the API purpose ambient at the time. */
type AskedQuery = Readonly<{ statement: string; purpose: string }>;

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/**
 * Answers the six reads the aggregation makes, by the object each statement names.
 *
 * The data is one instance of the milestone scenario this Tool exists for: a setup change and a failed
 * asynchronous job both inside the window, and a scheduled job the platform still calls waiting although
 * its next fire time passed — so the merged timeline has one line per source and the stall flag has
 * something to flag. The setup-audit-trail filter is honoured the way an org honours it (the clause is a
 * bound, not a decoration), and the count answers in the record-less form the probe measured on this org.
 */
function platformAnswer(statement: string): unknown {
  const rows = (records: readonly Record<string, unknown>[], totalSize = records.length): unknown =>
    ({ records, totalSize, done: true });
  if (statement.includes('FROM SetupAuditTrail')) {
    if (statement.includes('COUNT()')) return rows([], 1);
    if (statement.includes('ORDER BY CreatedDate ASC')) {
      return rows([{ Id: '0Ym000000000000old', CreatedDate: OLDEST_RETAINED_AT }]);
    }
    const from = /CreatedDate >= (\S+)/u.exec(statement)?.[1];
    const all = [{
      Id: '0Ym000000000001AAA',
      Action: 'PermSetCreate',
      Section: 'Permission Sets',
      Display: 'Created permission set SFOA_Field_Editor',
      CreatedBy: { Name: 'Admin User' },
      DelegateUser: null,
      CreatedDate: minutesAgo(50),
    }];
    return rows(all.filter((record) =>
      from === undefined || Date.parse(record.CreatedDate) >= Date.parse(from)));
  }
  if (statement.includes('FROM AsyncApexJob')) {
    if (statement.includes('GROUP BY Status')) {
      return rows([
        { Status: 'Completed', total: 152 },
        { Status: 'Failed', total: 0 },
        { Status: 'Aborted', total: 0 },
      ]);
    }
    // The count over the wrapped conjunction, answered in the record-less form the probe measured: an empty
    // `records` array with the number in `totalSize`. It has to be answered before the entries branch below,
    // which would otherwise hand a count statement the failure row and let its `NumberOfErrors` pass for a
    // total.
    if (statement.includes('COUNT()')) return rows([], 1);
    return rows([{
      Id: '707000000000001AAA',
      Status: 'Failed',
      JobType: 'BatchApex',
      ApexClass: { Name: 'SFOA_Data_Sync' },
      NumberOfErrors: 3,
      ExtendedStatus: 'System.LimitException: Apex CPU time limit exceeded',
      CreatedDate: minutesAgo(40),
    }]);
  }
  if (statement.includes('FROM CronTrigger')) {
    return rows([{
      Id: '08e000000000001AAA',
      CronJobDetail: { Name: 'SFOA_Nightly_Reconcile', JobType: '7' },
      State: 'WAITING',
      NextFireTime: minutesAgo(90),
      PreviousFireTime: minutesAgo(400),
      TimesTriggered: 12,
    }]);
  }
  return rows([]);
}

type Harness = Readonly<{
  server: RemoteMcpServer;
  client: Client;
  factory: RecordingConnectionFactory;
  logger: RecordingLogger;
  asked: AskedQuery[];
  close(): Promise<void>;
}>;

async function startHarness(options: Readonly<{
  enabledTools: readonly string[];
  diagnosticUsername?: string;
  /** Statements this fixture refuses, as a substring match, so one section can be degraded on its own. */
  refusals?: readonly Readonly<{ match: string; error: unknown }>[];
}>): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-p10-diagnostics-http-'));
  const asked: AskedQuery[] = [];
  const refusals = options.refusals ?? [];
  const factory = new RecordingConnectionFactory({
    query: (statement) => {
      // Read from inside the request on purpose: the purpose is ambient state the facade installs around
      // the Tool body, so this is the one place a test can see what the read was attributed to.
      asked.push({ statement, purpose: currentSalesforceApiPurpose() });
      const refusal = refusals.find((candidate) => statement.includes(candidate.match));
      if (refusal !== undefined) throw refusal.error;
      return platformAnswer(statement);
    },
  });
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
  const client = new Client({ name: 'p10-diagnostics-http-test', version: '1.0.0' });
  await client.connect(transport);
  return {
    server,
    client,
    factory,
    logger,
    asked,
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

function sections(output: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const value = output.sections;
  assert.ok(typeof value === 'object' && value !== null, 'the answer must carry sections');
  return value as Record<string, Record<string, unknown>>;
}

function timeline(output: Record<string, unknown>): Record<string, unknown>[] {
  const alignment = output.alignment as Record<string, unknown> | undefined;
  const entries = alignment?.timeline;
  assert.ok(Array.isArray(entries), 'the answer must carry a merged timeline');
  return entries as Record<string, unknown>[];
}

/** The first entry of a section, narrowed: a section asserted `READ` above must have carried one. */
function firstEntry(section: Record<string, unknown>): Record<string, unknown> {
  const entry = (section.entries as Record<string, unknown>[] | undefined)?.[0];
  assert.ok(entry !== undefined, 'expected the section to carry at least one entry');
  return entry;
}

function fromTarget(statement: string): string | null {
  return /\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/u.exec(statement)?.[1] ?? null;
}

test('get_platform_diagnostics is absent from tools/list until an Admin enables it', async () => {
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS] });
  try {
    const names = (await harness.client.listTools()).tools.map((tool) => tool.name);
    for (const name of DIAGNOSTIC_TOOLS) {
      assert.equal(names.includes(name), false, `${name} must not be advertised while it is disabled`);
    }

    await assert.rejects(
      harness.client.callTool({ name: 'get_platform_diagnostics', arguments: {} }),
      (error: unknown) => /get_platform_diagnostics/u.test(String(error)),
    );
    const denial = harness.logger.forTool('get_platform_diagnostics')
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

test('an enabled call merges the three sources onto one clock and reads as PLATFORM_DIAGNOSTICS', async () => {
  const harness = await startHarness({
    enabledTools: [...DEFAULT_ENABLED_TOOLS, ...DIAGNOSTIC_TOOLS],
    diagnosticUsername: TEST_DIAGNOSTIC_USERNAME,
  });
  try {
    const listed = await harness.client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === 'get_platform_diagnostics');
    assert.ok(tool !== undefined, 'get_platform_diagnostics must be advertised once an Admin enables it');
    assert.deepEqual(
      Object.keys(tool.inputSchema.properties ?? {}).sort(),
      ['limitPerSection', 'sections', 'windowHours'],
    );
    // Read-only, and the annotation is a claim an Agent plans on: this Tool aggregates the org's own
    // change and failure history and must never be mistaken for one that can change any of it.
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(harness.factory.creations.length, 0, 'initialize and tools/list must not open a Connection');

    const result = await harness.client.callTool({ name: 'get_platform_diagnostics', arguments: {} });
    assert.equal(result.isError === true, false);
    const output = structured(result);
    assert.equal(output.success, true);
    assert.equal(output.executionRole, 'DIAGNOSTIC');
    assert.equal(output.api, 'STANDARD');
    assert.equal(output.truncated, false);
    assert.equal(output.readSectionCount, 3);
    assert.equal(output.unavailableSectionCount, 0);
    const window = output.window as Record<string, unknown>;
    assert.equal(window.hours, 24);
    assert.equal(typeof window.from, 'string');
    assert.equal(typeof window.to, 'string');
    assert.ok(Date.parse(String(window.from)) < Date.parse(String(window.to)));

    const all = sections(output);
    assert.deepEqual(Object.keys(all).sort(), ['asyncFailures', 'scheduledJobs', 'setupChanges']);
    const setup = all.setupChanges as Record<string, unknown>;
    assert.equal(setup.status, 'READ');
    assert.equal(setup.section, 'SETUP_CHANGES');
    assert.equal(setup.totalCount, 1);
    assert.equal(setup.truncated, false);
    assert.equal(setup.oldestRetainedAt, OLDEST_RETAINED_AT);
    const change = firstEntry(setup);
    assert.equal(change.action, 'PermSetCreate');
    assert.equal(change.createdBy, 'Admin User');
    // The org's localized label is reported and never matched on: `Section` is not even filterable.
    assert.equal(change.section, 'Permission Sets');
    assert.match(String(change.display), /SFOA_Field_Editor/u);

    const async = all.asyncFailures as Record<string, unknown>;
    assert.equal(async.status, 'READ');
    assert.equal(async.totalCount, 1);
    assert.deepEqual(async.observedStatusCounts, { Completed: 152, Failed: 0, Aborted: 0 });
    const failure = firstEntry(async);
    assert.equal(failure.status, 'Failed');
    assert.equal(failure.apexClass, 'SFOA_Data_Sync');
    assert.equal(failure.numberOfErrors, 3);

    const jobs = all.scheduledJobs as Record<string, unknown>;
    assert.equal(jobs.status, 'READ');
    assert.equal(jobs.suspectedStallCount, 1);
    const job = firstEntry(jobs);
    assert.equal(job.name, 'SFOA_Nightly_Reconcile');
    assert.equal(job.stallAssessment, 'SUSPECTED');
    // The one judgement this Tool makes is hedged on the wire as well as in the module: the flag is a
    // reading of the platform's own fields, and the reason says so rather than reporting a diagnosis.
    assert.match((job.stallReasons as string[]).join(' '), /not a diagnosis/u);

    // The merge, oldest first, with each line naming its own section — three sources are not comparable
    // evidence, which is the one thing a bare ordered list cannot say.
    const merged = timeline(output);
    assert.deepEqual(merged.map((entry) => entry.section), ['SCHEDULED_JOBS', 'SETUP_CHANGES', 'ASYNC_FAILURES']);
    assert.match(String(merged[0]?.summary), /was due to fire and did not/u);
    assert.match(String(merged[1]?.summary), /PermSetCreate by Admin User/u);
    assert.match(String(merged[2]?.summary), /Failed BatchApex SFOA_Data_Sync/u);
    assert.deepEqual(merged.map((entry) => entry.entryId), [
      '08e000000000001AAA', '0Ym000000000001AAA', '707000000000001AAA',
    ]);
    for (const [index, entry] of merged.entries()) {
      assert.ok(
        Date.parse(String(entry.occurredAt)) >= Date.parse(String(window.from)),
        `timeline entry ${index} must be inside the window`,
      );
    }
    const note = String((output.alignment as Record<string, unknown>).note);
    assert.match(note, /candidate and not a cause/u);

    const hint = String(output.hint);
    assert.ok(hint.length > 0 && hint.length <= 1_000);
    // A hint may only name a Tool `tools/list` advertises, and these two are not enabled here.
    assert.doesNotMatch(hint, /get_apex_logs/u);
    assert.doesNotMatch(hint, /get_metadata_component_context/u);
    assert.match(hint, /reaches back to 2026-04-08/u);

    // The read is attributed: the triggering platform user is the caller, the Salesforce username behind
    // it is the server-owned diagnostic identity, and the caller's own route is never used for it.
    assert.ok(harness.factory.creations.some((entry) =>
      entry.connectionRole === 'DIAGNOSTIC' && entry.salesforceUsername === TEST_DIAGNOSTIC_USERNAME));
    assert.equal(harness.factory.creations.some((entry) => entry.connectionRole === 'USER'), false,
      'a diagnostic Tool must not open a Connection as the caller');
    // ADR-0029 §4a's whitelist as it appears on the wire, and the one date filter this Tool pushes into
    // SOQL unquoted — a quoted dateTime is a *string* literal and the platform refuses it with
    // `INVALID_FIELD`, which is a mistake this Tool's sibling made once already.
    assert.ok(harness.asked.length > 0);
    for (const { statement } of harness.asked) {
      const target = fromTarget(statement);
      assert.ok(target !== null && (WHITELIST as readonly string[]).includes(target),
        `statement must read a whitelisted object: ${statement}`);
    }
    assert.ok(harness.asked.some(({ statement }) => /CreatedDate >= \d{4}-\d{2}-\d{2}T/u.test(statement)));
    assert.equal(harness.asked.some(({ statement }) => /CreatedDate >= '/u.test(statement)), false);
    // `COUNT()` rather than `COUNT(Id)`, which this org refuses on `SetupAuditTrail`.
    assert.ok(harness.asked.some(({ statement }) => /SELECT COUNT\(\) FROM SetupAuditTrail/u.test(statement)));
    assert.equal(harness.asked.some(({ statement }) => /COUNT\(Id\) FROM SetupAuditTrail/u.test(statement)), false);
    // The failure section's window is pushed into the query and counted over the same conjunction, so its
    // total is the window's own number rather than what a bounded newest-first scan could establish.
    assert.ok(harness.asked.some(({ statement }) =>
      /SELECT COUNT\(\) FROM AsyncApexJob WHERE Status IN \('Failed','Aborted'\) AND CreatedDate >= \d{4}-\d{2}-\d{2}T/u.test(statement)));

    for (const { purpose } of harness.asked) {
      assert.equal(purpose, 'PLATFORM_DIAGNOSTICS', 'every read of this call is attributed to its own purpose');
    }

    const terminal = harness.logger.forTool('get_platform_diagnostics')
      .find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
    assert.ok(terminal !== undefined, 'get_platform_diagnostics must emit a TOOL_TERMINAL audit event');
    assert.equal(terminal.result, 'PASS');
    assert.equal(terminal.executionRole, 'DIAGNOSTIC');
    assert.equal(terminal.salesforceUsername, TEST_DIAGNOSTIC_USERNAME);
    assert.equal(terminal.platformUserId, TEST_PLATFORM_USER_A);
    // An omitted argument is recorded as omitted rather than as the default the Tool resolved it to: the
    // row has to describe the call that was made, not the one the Tool would have made by default.
    assert.deepEqual(terminal.requestSummary, {
      windowHours: null,
      sections: [],
      sectionCount: 0,
      limitPerSection: null,
    });
    assert.deepEqual(terminal.responseSummary, {
      isError: false,
      readSectionCount: 3,
      unavailableSectionCount: 0,
      timelineEntryCount: merged.length,
      truncated: false,
    });
  } finally {
    await harness.close();
  }
});

test('one source refusing degrades that section alone, and the call is still a PASS that says how many were unavailable', async () => {
  const harness = await startHarness({
    enabledTools: [...DEFAULT_ENABLED_TOOLS, ...DIAGNOSTIC_TOOLS],
    diagnosticUsername: TEST_DIAGNOSTIC_USERNAME,
    refusals: [{
      match: 'FROM SetupAuditTrail',
      error: Object.assign(new Error('insufficient access'), { errorCode: 'INSUFFICIENT_ACCESS' }),
    }],
  });
  try {
    const result = await harness.client.callTool({ name: 'get_platform_diagnostics', arguments: {} });
    // ADR-0029 §3's aggregator clause: a source the identity cannot read is a state inside a successful
    // answer, never a failed call and never a silently empty section.
    assert.equal(result.isError === true, false);
    const output = structured(result);
    assert.equal(output.success, true);
    assert.equal(output.readSectionCount, 2);
    assert.equal(output.unavailableSectionCount, 1);
    assert.deepEqual(output.truncated, false);

    const setup = sections(output).setupChanges as Record<string, unknown>;
    assert.equal(setup.status, 'UNAVAILABLE');
    assert.equal(setup.section, 'SETUP_CHANGES');
    assert.deepEqual(setup.entries, []);
    // `null`, never 0 — 0 would be a claim about the org this call has not earned.
    assert.equal(setup.totalCount, null);
    assert.equal(setup.oldestRetainedAt, null);
    assert.equal(setup.errorCode, 'MCP_DIAGNOSTIC_PREREQUISITE_MISSING');
    assert.equal(setup.prerequisite, 'SetupAuditTrail readability on the diagnostic identity');
    assert.match(String(setup.unavailableReason), /missing evidence, not a quiet window/u);

    // The other two read normally, and the merge covers only what was read.
    const all = sections(output);
    assert.equal((all.asyncFailures as Record<string, unknown>).status, 'READ');
    assert.equal((all.scheduledJobs as Record<string, unknown>).status, 'READ');
    const merged = timeline(output);
    assert.deepEqual(merged.map((entry) => entry.section), ['SCHEDULED_JOBS', 'ASYNC_FAILURES']);
    // The note and the hint are where an incomplete timeline is said out loud, and the hint leads with it:
    // a timeline is a single ordered list, so an unread section simply contributes no lines to it.
    assert.match(String((output.alignment as Record<string, unknown>).note), /could not be read/u);
    const hint = String(output.hint);
    assert.match(hint, /^1 of 3 section\(s\) could not be read/u);
    assert.match(hint, /the setup audit trail \(missing: SetupAuditTrail readability on the diagnostic identity\)/u);
    assert.match(hint, /missing evidence rather than a quiet org/u);

    const terminal = harness.logger.forTool('get_platform_diagnostics')
      .find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
    assert.ok(terminal !== undefined);
    assert.equal(terminal.result, 'PASS');
    // The row answers §3's aggregator clause with the counts rather than with the success alone.
    assert.deepEqual(terminal.responseSummary, {
      isError: false,
      readSectionCount: 2,
      unavailableSectionCount: 1,
      timelineEntryCount: merged.length,
      truncated: false,
    });
  } finally {
    await harness.close();
  }
});

test('a runtime with no diagnostic identity refuses the call rather than downgrading to the caller', async () => {
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS, ...DIAGNOSTIC_TOOLS] });
  try {
    // Refused before the request even reaches a Tool: the role map classified the call DIAGNOSTIC and this
    // runtime has no server-owned diagnostic scope, so the refusal is a request-level error rather than a
    // Tool result. Either way the point is that it stops here.
    await assert.rejects(
      harness.client.callTool({ name: 'get_platform_diagnostics', arguments: {} }),
      (error: unknown) => /MCP_DIAGNOSTIC_CONFIGURATION_INVALID/u.test(String(error)),
    );
    // The one outcome worse than refusing: answering about the org's changes while running as the caller.
    assert.equal(harness.factory.creations.length, 0, 'the refusal must not open any Connection at all');
  } finally {
    await harness.close();
  }
});
