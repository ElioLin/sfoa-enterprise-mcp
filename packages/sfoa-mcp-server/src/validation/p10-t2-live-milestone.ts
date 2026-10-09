import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from '@salesforce/core';
import {
  createIdentityRuntime,
  JwtConnectionFactory,
  JsonLineRuntimeLogger,
  type RequestScope,
} from '@sfoa/identity-runtime';
import {
  AsyncAuditPipeline,
  assertAllMigrationsApplied,
  auditDatabaseConfig,
  createControlPlaneDatabase,
  DatabaseRuntimeLogger,
  MySqlAuditBatchSink,
  MySqlControlPlaneStore,
  MySqlIdentityRepository,
  type ControlPlaneDatabaseClient,
} from '@sfoa/control-plane';
import { DEBUG_LEVEL_TIER_PREFIX } from '@sfoa/mcp-provider-sfoa-context';
import { loadRemoteRuntimeConfig } from '../config.js';
import { startRemoteMcpServer } from '../http-server.js';
import {
  MySqlRuntimeDiscoveryPolicySnapshotSource,
  MySqlRuntimePolicySnapshotSource,
  snapshotDiagnosticRoute,
} from '../policy-snapshot.js';
import { createAttachmentIngress } from '../runtime.js';
import { maskIdentifier, maskSalesforceId } from './p10-diagnostic-probe.js';
import {
  AdditiveToolPolicySnapshotSource,
  MeasuringConnectionFactory,
  asNumber,
  call,
  closeQuietly,
  combine,
  failGate,
  flushAuditTrail,
  gate,
  maskedIdOf,
  measuredSalesforceUsernames,
  notTested,
  outputOf,
  readAccessToken,
  readOrgFacts,
  readRecords,
  recordOf,
  resolveMilestonePlatformUser,
  runAuditPersistence,
  runCredentialSafety,
  runToolInventory,
  salesforceErrorCodeOf,
  sleep,
  stringOrNull,
  toolFailureDetail,
  type P10LiveGate,
  type P10LiveOrgFacts,
} from './p10-live-support.js';

/**
 * Re-exported so the T2 report's own type stays readable from this file, which is where a reader looks for
 * it. The definitions moved to `p10-live-support.ts` when T3 became the second consumer of them.
 */
export type { P10LiveGate, P10LiveStatus } from './p10-live-support.js';

/**
 * The P10-T2 live milestone: GAP-M1's closed loop, measured on a live org.
 *
 * `set_trace_flag` → reproduce → `get_apex_logs` → `get_debug_log_body` is a *chain*, and every link of
 * it is only worth anything if the next link consumes what the previous one produced. A unit test can
 * prove each Tool's contract in isolation and still leave the chain unproven, because the thing that can
 * only fail live is the handoff: a trace flag the platform does not honour, a log that is written but not
 * visible to this identity, a header whose version the parser reads wrongly, a line number that is not
 * the line the exception was raised on.
 *
 * So this harness runs the chain the way an Agent would — through the deployed HTTP surface, so the P7
 * audit trail it produces is the trail of a real request rather than of a direct function call:
 *
 * 1. `set_trace_flag` over the MCP server, as an enabled DIAGNOSTIC Tool.
 * 2. Reproduce, by running Apex as the traced user. **This leg is not a Tool and must never become
 *    one:** executing arbitrary Apex is exactly the authority the red line in
 *    `P10_EXECUTION_PROMPTS.md` §0.3 exists to deny a diagnostic Tool, so the harness opens its own
 *    Connection on the same `snapshotDiagnosticRoute` pairing the server uses and runs the code itself.
 * 3. `get_apex_logs` over the MCP server, and the rows it returns are located by diffing against a list
 *    taken *before* the reproduction — every id below comes from the Tool, never from this file.
 * 4. `get_debug_log_body` over the MCP server, for both new ids, because that is how the Tool's own
 *    answers say which of the two is the failure.
 *
 * **What the reproduction can and cannot be.** The trace target has to be an entity whose execution this
 * harness can cause, and the only identity it can run Apex as is the diagnostic identity itself (there is
 * no `loginAs`, and manufacturing one would be a far larger authority than a milestone needs). So the
 * target is that identity's own `User` row and the log it produces is therefore its own. That is why the
 * cross-user half of ADR-0029's `A-1` stays a deployment check rather than something this run proves: T1
 * measured that this identity *may open* a flag for another user, and nothing here needs to overturn or
 * extend that.
 *
 * **What is measured rather than assumed.** The failing row is not identified by a hardcoded status
 * literal — `ApexLog.Status` is translated on this org (probe §1), so a literal would be a claim about a
 * translation rather than about the Tool. Instead a *control* execution that completes is run first and
 * both rows are told apart by what the Tool says about their bodies: the one that ends on a fatal error is
 * the failure. The two statuses the org stores for them are then compared, so "this row carries the
 * failure literal" is demonstrated by a contrast this run observed rather than asserted from a table.
 *
 * The control execution carries a second job. Whether this identity may run anonymous Apex at all was
 * never measured in T1, and it is the load-bearing unknown for step 2, so it is *measured* here — by the
 * control run itself, which is one execution rather than two — and a refusal is reported with its
 * Salesforce code instead of failing the milestone opaquely.
 */

/** The three Tools of this milestone, in the order the chain composes them. */
export const P10_T2_TOOL_NAMES = Object.freeze(['set_trace_flag', 'get_apex_logs', 'get_debug_log_body']);

/**
 * The exact input keys each Tool may advertise.
 *
 * Asserted as a set equality rather than as a scan for forbidden names: the T2 prohibition is that no
 * Tool accepts a Salesforce username or token, and a Tool that accepts *anything* this file does not name
 * is a contract change that has to be seen. A forbidden-name scan would pass a new `salesforceAlias` key;
 * this cannot.
 */
export const P10_T2_TOOL_INPUT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  set_trace_flag: Object.freeze(['durationMinutes', 'logLevel', 'tracedEntityId', 'tracedEntityKind']),
  get_apex_logs: Object.freeze(['limit', 'status', 'timeWindowMinutes', 'userId']),
  get_debug_log_body: Object.freeze(['logId', 'maxCharacters']),
});

/** How long the milestone's trace stays open. Long enough to cover the run, and it expires by itself. */
const TRACE_WINDOW_MINUTES = 30;

/** A token that appears in the logs the reproduction writes, so a `USER_DEBUG` line can be expected. */
const MILESTONE_MARKER = 'SFOA_P10_T2_MILESTONE';

/**
 * The control execution: the same shape as the reproduction with nothing wrong in it.
 *
 * It runs first for two reasons. It is the authority measurement — if the platform refuses this, the
 * diagnostic identity may not run anonymous Apex and the chain's middle step is impossible, which the
 * report says with the Salesforce code. And it writes the row the failing log is contrasted against, so
 * the status the org stores for a failure is demonstrated this run rather than assumed from a table.
 */
const CONTROL_APEX = `System.debug('${MILESTONE_MARKER}_CONTROL');`;

/**
 * The Apex the reproduction runs, and the line its exception is raised on.
 *
 * Anonymous Apex is the only Apex this harness can cause, so the "class" the log names is
 * `AnonymousBlock` and the line is relative to this block. The block is written to put the null
 * dereference on a known line, because the whole point of the milestone is that the class-and-line answer
 * is *right*; the `USER_DEBUG` line is there for the same reason one level down — it proves the trace
 * level reached `ApexCode`, which is the difference between a log and a file with a header. Whether the
 * platform numbers an anonymous block as authored is what the assertion below measures; `expectedLine`
 * and `lineNumber` are both reported, so a disagreement is diagnosable from one run.
 */
const REPRODUCTION_APEX = Object.freeze([
  `System.debug('${MILESTONE_MARKER}');`,
  'String nothing = null;',
  'Integer length = nothing.length();',
].join('\n'));

/** The 1-based line of the dereference above, as this file authored it. */
const EXPECTED_EXCEPTION_LINE = 3;

/** The exception this reproduction raises. Checked as a fragment: the log may qualify it further. */
const EXPECTED_EXCEPTION_TYPE = 'NullPointerException';

/** How far back the log list looks. Wide enough for the run, narrow enough to exclude older traffic. */
const LOG_WINDOW_MINUTES = 15;

/** Rows asked for per listing. The Tool caps this at 100, and the org retains far fewer. */
const LOG_LIMIT = 50;

/**
 * How long the harness waits for the two logs to become visible, and how often it looks.
 *
 * A log is written when the transaction ends, but the index that serves `LastModifiedDate` can lag by a
 * moment. Polling rather than sleeping once keeps a slow org from being read as a missing log, and the
 * bound keeps a genuinely missing log from being read as a slow org.
 */
const LOG_POLL_ATTEMPTS = 12;
const LOG_POLL_INTERVAL_MS = 2_500;

/**
 * The Apex that proves a trace is capturing, and the budget it is given to prove it.
 *
 * A TraceFlag does not begin capturing the moment `set_trace_flag` returns it. Measured on this deployment
 * on 2026-10-09: two executions one second after a flag was created wrote no row at all, an execution
 * ninety seconds later under the same flag was captured, and a reproduction running under a flag that was
 * already minutes old was captured within the first poll after it. The reproduction must therefore not run
 * inside that window, and no amount of polling at the listing end can recover it — a log the platform
 * never wrote is not a slow log.
 *
 * So the wait is measured rather than assumed, and it is measured with the same observable the rest of the
 * milestone uses: a new row in the Tool's own listing. Each round runs a throwaway execution and waits for
 * its row; a round that was itself executed before the flag took effect is never logged at all and proves
 * nothing by staying silent, which is why a second round re-runs the probe rather than extending the wait.
 */
const WARMUP_APEX = "System.debug('SFOA_P10_TRACE_WARMUP');";
const WARMUP_ROUNDS = 2;
const WARMUP_POLL_ATTEMPTS = 18;
const WARMUP_POLL_INTERVAL_MS = 5_000;

export type P10T2LiveReport = Readonly<{
  phase: 'P10';
  task: 'T2';
  generatedAt: string;
  /**
   * `CLOSED_LOOP` — a sandbox, so the trace was opened and the loop was driven end to end.
   * `READ_ONLY` — the org is not a sandbox, so this harness refused both the trace write and the
   * reproduction (ADR-0029's production ban) and reported them as NOT TESTED rather than performing
   * them. The read Tools still ran against whatever the window already held.
   * `REFUSED` — the Control Plane cannot route a verified Diagnostic identity, so the three Tools
   * cannot be enabled and nothing was attempted.
   */
  mode: 'CLOSED_LOOP' | 'READ_ONLY' | 'REFUSED';
  platformUserIdMasked: string;
  org: P10LiveOrgFacts;
  diagnosticIdentity: Readonly<{
    configured: boolean;
    enabled: boolean | null;
    verificationStatus: string | null;
    salesforceUsernameMasked: string | null;
  }>;
  toolInventory: P10LiveGate;
  writeLeg: P10LiveGate;
  /**
   * Whether the trace the write leg opened was shown to be capturing before anything was measured.
   *
   * It exists because the gap is real and long enough to lose a run: the first version of this milestone
   * executed the reproduction a second after the write leg returned, and on this deployment those
   * executions were never logged — `get_apex_logs` then reported an empty window, which the run read as a
   * refuted claim rather than as a trace that had not started capturing yet.
   */
  traceActivation: P10LiveGate;
  reproduction: P10LiveGate;
  listLeg: P10LiveGate;
  bodyLeg: P10LiveGate;
  hintChain: P10LiveGate;
  statusContrast: P10LiveGate;
  closedLoop: P10LiveGate;
  credentialSafety: P10LiveGate;
  connections: Readonly<{ total: number; distinctSalesforceUsernames: readonly string[] }>;
  auditPersistence: P10LiveGate;
  overall: 'PASS' | 'PARTIAL' | 'FAIL';
}>;

export async function runP10T2LiveMilestone(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<P10T2LiveReport> {
  const config = await loadRemoteRuntimeConfig(projectRoot, environment);
  const controlPlane = config.controlPlane;
  if (controlPlane.mode !== 'mysql') {
    throw new Error('The P10-T2 live milestone requires the MySQL Control Plane: the DIAGNOSTIC identity is read from it.');
  }
  const databaseConfig = controlPlane.database;
  if (!databaseConfig) throw new Error('The P10-T2 live milestone requires the MySQL Control Plane database configuration.');
  if (!config.clientToken) throw new Error('The P10-T2 live milestone requires an independent internal client token.');
  const clientToken = config.clientToken;
  const generatedAt = new Date().toISOString();

  const database: ControlPlaneDatabaseClient = createControlPlaneDatabase(databaseConfig);
  const auditDatabase: ControlPlaneDatabaseClient = createControlPlaneDatabase(auditDatabaseConfig(databaseConfig));
  const store = new MySqlControlPlaneStore(database);
  const fallbackLogger = new JsonLineRuntimeLogger();
  const auditPipeline = new AsyncAuditPipeline(new MySqlAuditBatchSink(auditDatabase), fallbackLogger);
  const databaseLogger = new DatabaseRuntimeLogger(
    store.repositories.audits,
    fallbackLogger,
    store.repositories.auditTraces,
    auditPipeline,
  );
  const measuringFactory = new MeasuringConnectionFactory(new JwtConnectionFactory({
    instanceUrl: config.identity.instanceUrl,
    clientId: config.identity.clientId,
    privateKeyPath: config.identity.privateKeyPath,
  }));
  const identityRuntime = createIdentityRuntime(config.identity, {
    connectionFactory: measuringFactory,
    identityRepository: new MySqlIdentityRepository(database),
    logger: databaseLogger,
  });
  const policySnapshotSource = new MySqlRuntimePolicySnapshotSource(database);

  let server: Awaited<ReturnType<typeof startRemoteMcpServer>> | undefined;
  let reproductionScope: RequestScope | undefined;
  try {
    const platformUserId = await resolveMilestonePlatformUser(store, environment);
    const snapshot = await policySnapshotSource.load(platformUserId);
    const diagnostic = snapshot.diagnostic;
    const diagnosticIdentity = Object.freeze({
      configured: diagnostic !== null,
      enabled: diagnostic?.enabled ?? null,
      verificationStatus: diagnostic?.verificationStatus ?? null,
      salesforceUsernameMasked: diagnostic === null ? null : maskIdentifier(diagnostic.salesforceUsername),
    });

    // The runtime refuses *every* request when a diagnostic Tool is enabled without an enabled,
    // verification-passed diagnostic configuration. Enabling the three Tools on a Control Plane that
    // cannot route that identity would therefore turn this milestone into three failures that say nothing
    // about the Tools, so the refusal is diagnosed here instead — and it is a diagnosis, not a skip: the
    // report says which half of the prerequisite is missing.
    const diagnosticEnabled = diagnostic !== null
      && diagnostic.enabled === true
      && diagnostic.verificationStatus === 'PASS';
    const diagnosticRoute = snapshotDiagnosticRoute(snapshot, platformUserId);
    if (!diagnosticEnabled || diagnosticRoute === undefined) {
      const missing = diagnostic === null
        ? 'this Control Plane has no Diagnostic identity row'
        : diagnostic.enabled !== true
          ? 'its Diagnostic identity row is not enabled'
          : diagnostic.verificationStatus !== 'PASS'
            ? `its Diagnostic identity verification status is ${diagnostic.verificationStatus}`
            : 'no Diagnostic identity route could be resolved for this platform user';
      const reason = `The three Tools cannot be enabled because ${missing}. The runtime refuses every request `
        + 'when a diagnostic Tool is enabled without an enabled, verification-passed Diagnostic identity, so the '
        + 'milestone was not attempted: configure and verify the Diagnostic identity through the Admin Control '
        + 'Plane, then re-run.';
      const auditPersistence = runAuditPersistence(await flushAuditTrail(auditPipeline), null);
      await closeQuietly(store, database, auditDatabase, auditPipeline);
      return refusalReport(generatedAt, platformUserId, diagnosticIdentity, reason, auditPersistence);
    }

    // The reproduction runs on the same pairing the server uses for a DIAGNOSTIC `tools/call`, so the Apex
    // it executes produces the log of the identity the Tools are reading for. Opening it any other way
    // would produce a log this identity might not be the author of, which is a different milestone.
    reproductionScope = await identityRuntime.scopeFactory.createForRoute(
      { platformUserId, correlationId: `p10-t2-milestone-${Date.now()}` },
      diagnosticRoute,
    );
    const reproductionConnection = await reproductionScope.getConnection();
    const org = await readOrgFacts(reproductionConnection);
    const self = await readSelfUser(reproductionConnection);
    if (self.userId.length === 0) {
      throw new Error('The Diagnostic connection reported no user id, so no trace can be targeted and no log filtered.');
    }

    // ADR-0029's production ban, enforced by the org's own answer rather than by an operator's flag: on
    // anything the platform does not call a sandbox neither a trace is opened nor Apex is run, and there is
    // no environment variable that can turn either on. Reading a system log is not what the ban is about,
    // so the read legs still run against whatever the window already holds.
    const writeAllowed = org.isSandbox === true;
    const mode: P10T2LiveReport['mode'] = writeAllowed ? 'CLOSED_LOOP' : 'READ_ONLY';

    await assertAllMigrationsApplied(database);
    // The harness starts its own in-process server, so it has to bind the same attachment ingress the
    // deployed runtime binds: a Control Plane that enables an attachment Tool refuses every request when no
    // ingress is bound, before any Tool runs.
    const attachmentIngress = createAttachmentIngress(config, store);
    server = await startRemoteMcpServer({
      // The harness binds an ephemeral loopback port, so it accepts the loopback Host and Origin values
      // rather than the deployed allowlist.
      config: Object.freeze({
        ...config,
        bindHost: '127.0.0.1',
        port: 0,
        allowedHosts: Object.freeze([]),
        allowedOrigins: Object.freeze([]),
        useLoopbackHostDefaults: true,
        useLoopbackOriginDefaults: true,
      }),
      identityRuntime,
      policySnapshotSource: new AdditiveToolPolicySnapshotSource(policySnapshotSource, P10_T2_TOOL_NAMES),
      discoveryPolicySnapshotSource: new MySqlRuntimeDiscoveryPolicySnapshotSource(database),
      ...(attachmentIngress === undefined ? {} : { attachmentIngress }),
    });

    const expectedNames = [...new Set([...snapshot.enabledTools, ...P10_T2_TOOL_NAMES])].sort();
    const results: CallToolResult[] = [];
    const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
      requestInit: {
        headers: {
          authorization: `Bearer ${clientToken}`,
          [config.platformUserHeader]: platformUserId,
        },
      },
    });
    const client = new Client({ name: 'p10-t2-live-milestone', version: '0.1.0-p10' });
    await client.connect(transport);
    try {
      const listings = await client.listTools();
      const toolInventory = runToolInventory({
        tools: listings.tools,
        milestoneTools: P10_T2_TOOL_NAMES,
        expectedNames,
        inputKeys: P10_T2_TOOL_INPUT_KEYS,
        // The one write in the debug-log set, and the one annotation that tells an Agent it is about to
        // change Setup state rather than read it.
        writeTools: ['set_trace_flag'],
      });

      const before = await call(client, results, 'get_apex_logs', {
        timeWindowMinutes: LOG_WINDOW_MINUTES,
        userId: self.userId,
        limit: LOG_LIMIT,
      });
      const beforeIds = listedLogIds(before);

      const writeLeg = writeAllowed
        ? await runWriteLeg(client, results, self.userId)
        : notTested(
          'The org is not a sandbox, so this harness refused to open a trace on it (ADR-0029: trace writes are '
          + 'sandbox-only) and the write leg was not attempted.',
          { isSandbox: org.isSandbox },
        );

      // A trace that is not yet capturing writes no log for the reproduction to be found in, so the wait
      // happens here — before anything is measured, and before anything is reported as measured.
      const activation = writeAllowed && writeLeg.status === 'PASS'
        ? await awaitTraceActivation(client, results, reproductionConnection, self.userId, beforeIds)
        : Object.freeze({
          gate: notTested(
            'No verified trace was opened, so there was nothing to wait for and no Apex was run: the measured legs '
            + 'below have nothing to measure.',
            Object.freeze({ writeLegStatus: writeLeg.status }),
          ),
          beforeIds,
        });
      const traceActivation = activation.gate;
      const measurable = writeAllowed && traceActivation.status === 'PASS';
      // The warm-up's own rows are the "before" of the measurement rather than part of it: the list leg
      // asserts an exact number of new rows and the body leg needs exactly one of them to end on a fatal
      // error, so a warm-up row left inside the diff would break both.
      const measuredBeforeIds = activation.beforeIds;

      // The control runs first and doubles as the authority measurement — see CONTROL_APEX. Running it
      // before the failing block also keeps the failing row the newest of the two, which is a hint the body
      // leg does not rely on but which the report would otherwise have to explain away.
      const control = measurable
        ? await runAnonymousApex(reproductionConnection, CONTROL_APEX)
        : notTested('The trace was not shown to be capturing, so the control execution was not run.');
      const failing = measurable && control.status === 'PASS'
        ? await runAnonymousApex(reproductionConnection, REPRODUCTION_APEX)
        : notTested('The control execution did not complete, so the failing block was not run.');
      const reproduction = reproductionGate(control, failing);

      const expectedNewLogs = measurable && reproduction.status === 'PASS' ? 2 : 0;
      const { listing, newIds } = await awaitNewLogs(client, results, self.userId, measuredBeforeIds, expectedNewLogs);
      // In READ_ONLY the loop was never driven, so the listing is still read as a measurement of the Tool
      // against whatever the window already held. When a trace was opened but never captured, the same
      // listing would be an assertion about a reproduction that was deliberately not run — so it is not one.
      const listLeg = !writeAllowed || measurable
        ? runListLeg(listing, measuredBeforeIds, newIds, expectedNewLogs)
        : notTested(
          'The trace was never shown to be capturing, so the listing was read but is not evidence about a '
          + 'reproduction this run did not perform.',
          Object.freeze({ newIds: newIds.length, expectedNewLogs }),
        );
      const bodies: readonly CandidateBody[] = measurable
        ? await readCandidateBodies(client, results, newIds)
        : Object.freeze([]);
      const candidates = classifyCandidates(bodies);
      const bodyLeg = measurable
        ? runBodyLeg(candidates.failing, candidates.control, bodies)
        : notTested('No row was identified as this run\'s reproduction, so no log body was read.');
      const statusContrast = measurable
        ? runStatusContrast(candidates, readStatusesFrom(listing, newIds))
        : notTested('No row was identified as this run\'s reproduction, so there was no status pair to contrast.');
      const hintChain = runHintChain(writeLeg, listLeg, bodyLeg);
      const closedLoop = runClosedLoop({
        writeLeg,
        reproduction,
        listLeg,
        bodyLeg,
        hintChain,
        statusContrast,
        candidates,
        self,
        writeAllowed,
      });
      const credentialSafety = runCredentialSafety(results, clientToken, await readAccessToken(reproductionConnection));

      await client.close().catch(() => undefined);
      const shutdown = await server.close().catch(() => undefined);
      const auditPersistence = runAuditPersistence(await flushAuditTrail(auditPipeline), shutdown);

      return Object.freeze({
        phase: 'P10',
        task: 'T2',
        generatedAt,
        mode,
        platformUserIdMasked: maskIdentifier(platformUserId),
        org,
        diagnosticIdentity,
        toolInventory,
        writeLeg,
        traceActivation,
        reproduction,
        listLeg,
        bodyLeg,
        hintChain,
        statusContrast,
        closedLoop,
        credentialSafety,
        connections: Object.freeze({
          total: measuringFactory.measurements.length,
          distinctSalesforceUsernames: Object.freeze([...measuredSalesforceUsernames(measuringFactory)]),
        }),
        auditPersistence,
        overall: combine([
          toolInventory, writeLeg, traceActivation, reproduction, listLeg, bodyLeg, hintChain, statusContrast,
          closedLoop, credentialSafety, auditPersistence,
        ]),
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  } finally {
    if (server !== undefined) await server.close().catch(() => undefined);
    if (reproductionScope !== undefined) await reproductionScope.close().catch(() => undefined);
    await closeQuietly(store, database, auditDatabase, auditPipeline);
  }
}

function refusalReport(
  generatedAt: string,
  platformUserId: string,
  diagnosticIdentity: P10T2LiveReport['diagnosticIdentity'],
  reason: string,
  auditPersistence: P10LiveGate,
): P10T2LiveReport {
  return Object.freeze({
    phase: 'P10',
    task: 'T2',
    generatedAt,
    mode: 'REFUSED',
    platformUserIdMasked: maskIdentifier(platformUserId),
    org: Object.freeze({ isSandbox: null, instanceName: null, apiVersion: null, organizationIdMasked: null }),
    diagnosticIdentity,
    toolInventory: notTested(reason),
    writeLeg: notTested(reason),
    traceActivation: notTested(reason),
    reproduction: notTested(reason),
    listLeg: notTested(reason),
    bodyLeg: notTested(reason),
    hintChain: notTested(reason),
    statusContrast: notTested(reason),
    closedLoop: notTested(reason),
    credentialSafety: notTested('No Tool call was made.'),
    connections: Object.freeze({ total: 0, distinctSalesforceUsernames: Object.freeze([]) }),
    auditPersistence,
    overall: 'PARTIAL',
  });
}

/**
 * The write leg: open the trace on the identity whose execution this harness can cause.
 *
 * `verified` is required rather than recorded and ignored. The Tool re-reads the row it wrote precisely
 * because T1 watched a delete report success on a row that survived; a milestone that accepted an
 * unverified write would be republishing the assumption that finding was made to kill.
 */
async function runWriteLeg(client: Client, results: CallToolResult[], tracedEntityId: string): Promise<P10LiveGate> {
  const result = await call(client, results, 'set_trace_flag', {
    tracedEntityKind: 'USER',
    tracedEntityId,
    durationMinutes: TRACE_WINDOW_MINUTES,
    logLevel: 'DEBUG',
  });
  const output = outputOf(result);
  if (output === undefined) return failGate('set_trace_flag returned no structured content.');
  if (output.success !== true) {
    return failGate(
      `set_trace_flag failed live: ${String(output.errorCode ?? 'no error code')}.`,
      toolFailureDetail(output),
    );
  }
  const expirationDate = stringOrNull(output.expirationDate);
  const expiresAt = expirationDate === null ? Number.NaN : Date.parse(expirationDate);
  const facts = output.executionRole === 'DIAGNOSTIC'
    && output.api === 'TOOLING'
    && output.logType === 'DEVELOPER_LOG'
    && typeof output.debugLevelDeveloperName === 'string'
    && output.debugLevelDeveloperName.startsWith(DEBUG_LEVEL_TIER_PREFIX)
    && output.debugLevelTier === 'DEBUG'
    && output.verified === true
    && Number.isFinite(expiresAt)
    && expiresAt > Date.now();

  return gate(facts, Object.freeze({
    executionRole: output.executionRole,
    api: output.api,
    traceFlagIdMasked: maskedIdOf(output.traceFlagId),
    tracedEntityKind: output.tracedEntityKind,
    tracedEntityIdMasked: maskedIdOf(output.tracedEntityId),
    logType: output.logType,
    debugLevelIdMasked: maskedIdOf(output.debugLevelId),
    debugLevelDeveloperName: output.debugLevelDeveloperName,
    debugLevelTier: output.debugLevelTier,
    debugLevelCreated: output.debugLevelCreated,
    replacedExisting: output.replacedExisting,
    previousExpirationDate: output.previousExpirationDate ?? null,
    startDate: output.startDate ?? null,
    expirationDate,
    requestedDurationMinutes: output.requestedDurationMinutes,
    verified: output.verified,
    hint: output.hint ?? null,
  }), 'set_trace_flag did not report a verified, active DEVELOPER_LOG trace on the tier this run asked for.');
}

/**
 * The reproduction gate, whose first half is the measurement that says whether it was possible at all.
 *
 * A refusal to run anonymous Apex is not a defect in the Toolset, so it is reported as the reason the chain
 * could not be driven rather than as a failure of T2 — but it is also not hidden, because a milestone that
 * quietly skipped its middle step would leave the handoff exactly as unproven as before. The refusal names
 * the Salesforce code and never the message: an anonymous-Apex error message quotes the source it was
 * given, and that source is this harness's.
 */
function reproductionGate(control: P10LiveGate, failing: P10LiveGate): P10LiveGate {
  if (control.status === 'NOT TESTED') return control;
  const controlRun = recordOf(control.detail.run);
  if (controlRun === undefined) return failGate('The control execution produced no measurement to read.');
  if (controlRun.outcome === 'REFUSED') {
    return notTested(
      'The diagnostic identity could not run anonymous Apex, so the chain\'s middle step was not performed: '
      + `Salesforce refused it with ${String(controlRun.salesforceErrorCode ?? 'no Salesforce error code')}.`,
      Object.freeze({ control: control.detail }),
    );
  }
  if (failing.status !== 'PASS') return failing;
  const failingRun = recordOf(failing.detail.run);
  if (failingRun === undefined) return failGate('The failing execution produced no measurement to read.');
  const facts = controlRun.compiled === true
    && controlRun.success === true
    && failingRun.compiled === true
    && failingRun.success === false
    && typeof failingRun.exceptionTypeFragment === 'string'
    && failingRun.exceptionTypeFragment.includes(EXPECTED_EXCEPTION_TYPE);

  return gate(facts, Object.freeze({
    control: control.detail,
    failing: failing.detail,
    expectedExceptionFragment: EXPECTED_EXCEPTION_TYPE,
    policy: 'anonymous Apex is run by this harness on an explicit DIAGNOSTIC scope and is deliberately not a Tool',
  }), 'The reproduction did not produce the expected contrast: a completed execution and a failing one carrying '
    + `a ${EXPECTED_EXCEPTION_TYPE}.`);
}

/**
 * The list leg: what the Tool returned, and which of those ids were written by this run.
 *
 * Only the facts a caller can rely on are asserted here; which row is *the* failing row is settled by the
 * body leg, because the Tool deliberately does not filter or label by status.
 */
function runListLeg(
  listing: Readonly<Record<string, unknown>> | undefined,
  beforeIds: readonly string[],
  newIds: readonly string[],
  expectedNewLogs: number,
): P10LiveGate {
  if (listing === undefined) return failGate('get_apex_logs returned no structured content.');
  if (listing.success !== true) {
    return failGate(
      `get_apex_logs failed live: ${String(listing.errorCode ?? 'no error code')}.`,
      toolFailureDetail(listing),
    );
  }
  const logs = readRecords(listing.logs);
  const observed = readRecords(listing.observedStatuses);
  const facts = listing.executionRole === 'DIAGNOSTIC'
    && listing.api === 'TOOLING'
    && listing.returnedCount === logs.length
    && listing.timeWindowMinutes === LOG_WINDOW_MINUTES
    && newIds.length === expectedNewLogs
    && newIds.every((id) => logs.some((entry) => stringOrNull(entry.id) === id))
    // The listing must carry the values it saw: `status` is not an enum, so a caller has no other way to
    // compose a filter that will match on this org.
    && (observed.length === 0
      || observed.every((entry) => typeof entry.status === 'string' && typeof entry.count === 'number'));

  return gate(facts, Object.freeze({
    executionRole: listing.executionRole,
    api: listing.api,
    returnedCount: listing.returnedCount,
    scannedCount: listing.scannedCount,
    totalCount: listing.totalCount ?? null,
    truncated: listing.truncated,
    timeWindowMinutes: listing.timeWindowMinutes,
    windowStartedAt: listing.windowStartedAt ?? null,
    observedStatuses: observed.map((entry) => Object.freeze({
      status: String(entry.status),
      count: Number(entry.count),
    })),
    beforeCount: beforeIds.length,
    newIdsMasked: newIds.map(maskSalesforceId),
    expectedNewLogs,
    caveat: listing.caveat ?? null,
    hint: listing.hint ?? null,
  }), `get_apex_logs did not list the ${expectedNewLogs} log(s) this run wrote (found ${newIds.length} new row(s) `
    + `out of ${beforeIds.length} seen before it).`);
}

type CandidateBody = Readonly<{
  id: string;
  output: Record<string, unknown> | undefined;
  header: Record<string, unknown> | undefined;
  hasFatalError: boolean;
}>;

/**
 * Reads the body of every new row **through the Tool**, which is how the two rows are told apart.
 *
 * Ordering in the listing is a hint and not evidence: two rows written a second apart can share a
 * `LastModifiedDate`, and reading `logs[0]` as "the newest" would then be a coin flip that reports as a
 * PASS half the time. So the Tool is asked about each candidate and its answers decide.
 */
async function readCandidateBodies(
  client: Client,
  results: CallToolResult[],
  newIds: readonly string[],
): Promise<readonly CandidateBody[]> {
  const bodies: CandidateBody[] = [];
  for (const id of newIds) {
    const output = outputOf(await call(client, results, 'get_debug_log_body', { logId: id }));
    const header = recordOf(output?.headerSummary);
    bodies.push(Object.freeze({
      id,
      output,
      header,
      hasFatalError: header !== undefined && header.fatalError !== null && header.fatalError !== undefined,
    }));
  }
  return Object.freeze(bodies);
}

function classifyCandidates(bodies: readonly CandidateBody[]): Readonly<{
  failing: CandidateBody | undefined;
  control: CandidateBody | undefined;
  candidates: number;
  fatalErrorRows: number;
}> {
  const withFatal = bodies.filter((body) => body.hasFatalError);
  const failing = withFatal.length === 1 ? withFatal[0] : undefined;
  return Object.freeze({
    failing,
    control: bodies.find((body) => body !== failing),
    candidates: bodies.length,
    fatalErrorRows: withFatal.length,
  });
}

/**
 * The body leg, for the row the Tool's own answers identified as the failure.
 *
 * The header summary is where the milestone's claim lands: the exception type, the class and the line.
 * `apexClass` is recorded as measured rather than asserted by name — anonymous Apex reports
 * `AnonymousBlock`, which is a fact about how the harness reproduced the problem and not about the parser
 * — while the *line* is asserted, because a line a caller cannot rely on is the same as no answer at all.
 * Both the expected and the observed line are reported, so a platform that numbers an anonymous block
 * differently is diagnosable from one run rather than by re-reading the parser.
 */
function runBodyLeg(
  failing: CandidateBody | undefined,
  control: CandidateBody | undefined,
  bodies: readonly CandidateBody[],
): P10LiveGate {
  if (failing === undefined) {
    // A Tool that failed on a row leaves `hasFatalError` false, which is indistinguishable from a log with
    // no exception — so the candidates' own failures are quoted here. Without them this outcome reads as
    // "the reproduction did not produce an exception", which is the wrong conclusion and the expensive one.
    const failures = bodies
      .filter((body) => body.output?.success !== true)
      .map((body) => Object.freeze({
        logIdMasked: maskSalesforceId(body.id),
        ...(body.output === undefined
          ? { errorCode: null, message: null, salesforceErrorCode: null, suggestion: null, prerequisite: null }
          : toolFailureDetail(body.output)),
      }));
    return failGate(
      'Exactly one of the rows this run wrote was expected to end on a fatal error, and the Tool did not report '
      + 'exactly one — so the chain cannot be followed to a specific log.',
      Object.freeze({ candidates: bodies.length, candidateFailures: Object.freeze(failures) }),
    );
  }
  const output = failing.output;
  if (output === undefined) return failGate('get_debug_log_body returned no structured content.');
  if (output.success !== true) {
    return failGate(
      `get_debug_log_body failed live: ${String(output.errorCode ?? 'no error code')}.`,
      toolFailureDetail(output),
    );
  }
  const header = failing.header;
  if (header === undefined) return failGate('get_debug_log_body returned no header summary.');
  const body = typeof output.body === 'string' ? output.body : null;
  const totalCharacters = asNumber(output.totalCharacters);
  const returnedCharacters = asNumber(output.returnedCharacters);
  const controlHeader = control?.header;

  const facts = output.executionRole === 'DIAGNOSTIC'
    && output.api === 'TOOLING'
    && output.logId === failing.id
    && header.parseStatus === 'PARSED'
    && typeof header.exceptionType === 'string'
    && header.exceptionType.includes(EXPECTED_EXCEPTION_TYPE)
    && header.lineNumber === EXPECTED_EXCEPTION_LINE
    && body !== null
    && body.length > 0
    && returnedCharacters === body.length
    && totalCharacters !== null
    && output.truncated === (body.length < totalCharacters)
    && typeof header.userDebugLineCount === 'number'
    && header.userDebugLineCount > 0
    // The control is what makes "this row is the failure" a contrast rather than a label: the other row this
    // run wrote must show no fatal error and must have finished.
    && controlHeader !== undefined
    && controlHeader.fatalError === null
    && controlHeader.executionFinished === true;

  return gate(facts, Object.freeze({
    executionRole: output.executionRole,
    api: output.api,
    logIdMasked: maskSalesforceId(failing.id),
    parseStatus: header.parseStatus,
    logApiVersion: header.logApiVersion,
    logApiVersionMajor: header.logApiVersionMajor,
    validated: header.validated,
    fatalErrorLength: typeof header.fatalError === 'string' ? header.fatalError.length : null,
    exceptionType: header.exceptionType,
    exceptionMessageLength: typeof header.exceptionMessage === 'string' ? header.exceptionMessage.length : null,
    apexClass: header.apexClass,
    lineNumber: header.lineNumber,
    columnNumber: header.columnNumber,
    expectedLine: EXPECTED_EXCEPTION_LINE,
    expectedExceptionFragment: EXPECTED_EXCEPTION_TYPE,
    categoryTokens: readRecords(header.categories).map((category) => String(category.token)),
    userDebugLineCount: header.userDebugLineCount,
    stackFrameCount: readRecords(header.stackSummary).length,
    thrownExceptionCount: readRecords(header.thrownExceptions).length,
    executionFinished: header.executionFinished,
    bodyCharacters: body?.length ?? null,
    totalCharacters: output.totalCharacters,
    returnedCharacters: output.returnedCharacters,
    totalBytes: output.totalBytes,
    returnedBytes: output.returnedBytes,
    maxCharacters: output.maxCharacters ?? null,
    truncated: output.truncated,
    logLength: output.logLength ?? null,
    controlLogIdMasked: control === undefined ? null : maskSalesforceId(control.id),
    controlParseStatus: controlHeader?.parseStatus ?? null,
    controlFatalError: controlHeader === undefined ? null : controlHeader.fatalError,
    controlExecutionFinished: controlHeader?.executionFinished ?? null,
    controlUserDebugLineCount: controlHeader?.userDebugLineCount ?? null,
    hint: output.hint ?? null,
  }), 'get_debug_log_body did not land on the exception this run raised, on the line it was raised on, with the '
    + 'control log showing no fatal error.');
}

/**
 * The status contrast, read from the Tool's listing rather than from a translation table.
 *
 * `ApexLog.Status` is localized on this org, so the milestone must not hardcode the word the org uses for a
 * failure. Instead it asserts the two rows this run wrote carry *different* statuses — which is what makes
 * "the failing row carries the failure literal" an observation — and reports both values verbatim, so the
 * actual vocabulary lands in the evidence file.
 */
function runStatusContrast(
  candidates: Readonly<{ failing: CandidateBody | undefined; control: CandidateBody | undefined }>,
  statuses: ReadonlyMap<string, string | null>,
): P10LiveGate {
  const failingStatus = candidates.failing === undefined ? null : statuses.get(candidates.failing.id) ?? null;
  const controlStatus = candidates.control === undefined ? null : statuses.get(candidates.control.id) ?? null;
  const facts = failingStatus !== null && controlStatus !== null && failingStatus !== controlStatus;

  return gate(facts, Object.freeze({
    failingStatus,
    controlStatus,
    differing: failingStatus !== null && controlStatus !== null && failingStatus !== controlStatus,
    interpretation: 'The two rows differ, so the org stores a distinct value for a failed execution. The value '
      + 'itself is reported verbatim and no translation of it is asserted anywhere in this harness.',
  }), 'The two logs this run wrote carried the same (or no) Status, so the Tool\'s listing does not distinguish '
    + 'the failure and the contrast this milestone relies on was not observed.');
}

/**
 * The chain's own claim: each hint names the next Tool, and names one this session advertises.
 *
 * This is the requirement the plan states in prose — the three hints compose into one deterministic path —
 * and it is a *protocol* fact rather than a documentation one, so it is checked against what each response
 * actually said. A hint naming a Tool the session does not advertise costs an Agent a turn to find out,
 * which is why the names are checked against the set the inventory gate already read from `tools/list`.
 */
function runHintChain(writeLeg: P10LiveGate, listLeg: P10LiveGate, bodyLeg: P10LiveGate): P10LiveGate {
  const writeHint = stringOrNull(writeLeg.detail.hint) ?? '';
  const listHint = stringOrNull(listLeg.detail.hint) ?? '';
  const bodyHint = stringOrNull(bodyLeg.detail.hint) ?? '';
  const facts = writeHint.includes('get_apex_logs')
    && (listLeg.status !== 'PASS' || listHint.includes('get_debug_log_body'))
    && (bodyLeg.status === 'NOT TESTED' || bodyHint.length > 0);

  return gate(facts, Object.freeze({
    writeHintNamesList: writeHint.includes('get_apex_logs'),
    listHintNamesBody: listHint.includes('get_debug_log_body'),
    listHintPresent: listHint.length > 0,
    bodyHintPresent: bodyHint.length > 0,
    writeLegStatus: writeLeg.status,
    listLegStatus: listLeg.status,
    bodyLegStatus: bodyLeg.status,
  }), 'The hints did not chain: set_trace_flag must name get_apex_logs as the next step, and a successful '
    + 'listing must name get_debug_log_body.');
}

/**
 * The milestone's single claim: the loop ran, and every link consumed the previous one's output.
 *
 * It is asserted as a chain rather than as six independent gates because the failure this milestone exists
 * to catch is precisely a break *between* two links, each of which can be individually correct. The log the
 * body leg read has to be one the listing returned; the line the summary reports has to be the line the
 * reproduction raised on; and the status the org stores for that row has to differ from the status it
 * stores for the control, which is what makes "this is the failing row" a measurement.
 */
function runClosedLoop(input: Readonly<{
  writeLeg: P10LiveGate;
  reproduction: P10LiveGate;
  listLeg: P10LiveGate;
  bodyLeg: P10LiveGate;
  hintChain: P10LiveGate;
  statusContrast: P10LiveGate;
  candidates: Readonly<{ failing: CandidateBody | undefined; control: CandidateBody | undefined }>;
  self: Readonly<{ userId: string; username: string | null }>;
  writeAllowed: boolean;
}>): P10LiveGate {
  if (!input.writeAllowed) {
    return notTested(
      'The org is not a sandbox, so no trace was opened and no Apex was run: the loop could not be driven. The read '
      + 'Tools were still exercised against whatever the window already held.',
      Object.freeze({ isSandbox: false }),
    );
  }
  if (input.reproduction.status === 'NOT TESTED') {
    return notTested(
      'The trace was opened but the reproduction could not run, so the loop is open. The reproduction gate carries '
      + 'the Salesforce code that refused it.',
      Object.freeze({ reproductionDetail: input.reproduction.detail }),
    );
  }
  // Named, because "3 of 6 legs did not pass" sends a reader to six other keys of the report to find out
  // which three, and the reason is already in each leg's own detail — quoting it here makes the single
  // gate that summarises the run usable on its own.
  const legs: readonly (readonly [string, P10LiveGate])[] = [
    ['writeLeg', input.writeLeg], ['reproduction', input.reproduction], ['listLeg', input.listLeg],
    ['bodyLeg', input.bodyLeg], ['hintChain', input.hintChain], ['statusContrast', input.statusContrast],
  ];
  const broken = legs.filter(([, leg]) => leg.status !== 'PASS');
  if (broken.length > 0) {
    return failGate(
      `The loop did not close: ${broken.length} of ${legs.length} legs did not pass.`,
      Object.freeze({
        brokenLegs: Object.freeze(broken.map(([name, leg]) => Object.freeze({
          leg: name,
          status: leg.status,
          failureReason: stringOrNull(leg.detail.failureReason) ?? null,
        }))),
      }),
    );
  }

  return gate(true, Object.freeze({
    tracingIdentityMasked: input.self.username === null ? null : maskIdentifier(input.self.username),
    tracedUserIdMasked: maskSalesforceId(input.self.userId),
    failingLogIdMasked: input.candidates.failing === undefined ? null : maskSalesforceId(input.candidates.failing.id),
    controlLogIdMasked: input.candidates.control === undefined ? null : maskSalesforceId(input.candidates.control.id),
    apexClass: input.bodyLeg.detail.apexClass,
    lineNumber: input.bodyLeg.detail.lineNumber,
    exceptionType: input.bodyLeg.detail.exceptionType,
    failingStatus: input.statusContrast.detail.failingStatus,
    controlStatus: input.statusContrast.detail.controlStatus,
    chain: [
      'set_trace_flag opened a verified DEVELOPER_LOG trace on the identity whose execution this run caused',
      'the reproduction wrote two logs: one that completed, one that ended on a fatal error',
      'get_apex_logs returned both rows, identified by diffing against the listing taken before them',
      'get_debug_log_body was called for both rows and the fatal error told them apart',
    ],
  }), 'The loop ran but did not close.');
}

/**
 * Waits for this run's logs to appear, and returns the listing that contains them.
 *
 * The poll is bounded in both directions on purpose: a slow index must not read as a missing log, and a
 * missing log must not read as a slow index. The last listing is returned even when the wait ran out, so the
 * report shows what the Tool said rather than only that nothing arrived. When this run expected no new rows
 * — a non-sandbox, or a refused reproduction — the first listing is the whole measurement.
 */
async function awaitNewLogs(
  client: Client,
  results: CallToolResult[],
  userId: string,
  beforeIds: readonly string[],
  expectedNewLogs: number,
): Promise<Readonly<{ listing: Readonly<Record<string, unknown>> | undefined; newIds: readonly string[] }>> {
  let listing: Readonly<Record<string, unknown>> | undefined;
  let newIds: readonly string[] = [];
  const attempts = expectedNewLogs === 0 ? 1 : LOG_POLL_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await call(client, results, 'get_apex_logs', {
      timeWindowMinutes: LOG_WINDOW_MINUTES,
      userId,
      limit: LOG_LIMIT,
    });
    listing = outputOf(result);
    newIds = listedLogIds(result).filter((id) => !beforeIds.includes(id));
    if (newIds.length >= expectedNewLogs) break;
    await sleep(LOG_POLL_INTERVAL_MS);
  }
  return Object.freeze({ listing, newIds });
}

/**
 * Runs the activation probe until the trace is demonstrably capturing, and returns the boundary the
 * measurement has to be diffed against.
 *
 * The returned `beforeIds` is a listing taken *after* activation rather than the caller's own — see
 * `measuredBeforeIds` at the call site for why the warm-up's rows have to fall on the "before" side.
 */
async function awaitTraceActivation(
  client: Client,
  results: CallToolResult[],
  connection: Connection,
  userId: string,
  beforeIds: readonly string[],
): Promise<Readonly<{ gate: P10LiveGate; beforeIds: readonly string[] }>> {
  const startedAt = Date.now();
  let rounds = 0;
  let pollAttempts = 0;
  let refused = false;
  let ids: readonly string[] = beforeIds;
  let activated = false;

  for (let round = 0; round < WARMUP_ROUNDS && !activated && !refused; round += 1) {
    rounds += 1;
    const run = await runAnonymousApex(connection, WARMUP_APEX);
    if (run.status !== 'PASS') {
      refused = true;
      break;
    }
    for (let attempt = 0; attempt < WARMUP_POLL_ATTEMPTS && !activated; attempt += 1) {
      pollAttempts += 1;
      const listing = await call(client, results, 'get_apex_logs', {
        timeWindowMinutes: LOG_WINDOW_MINUTES,
        userId,
        limit: LOG_LIMIT,
      });
      ids = listedLogIds(listing);
      activated = ids.some((id) => !beforeIds.includes(id));
      if (!activated) await sleep(WARMUP_POLL_INTERVAL_MS);
    }
  }

  return Object.freeze({
    gate: runTraceActivation({ rounds, pollAttempts, waitedMs: Date.now() - startedAt, activated, refused }),
    beforeIds: ids,
  });
}

/**
 * The activation gate: `PASS` only when a warm-up execution of this run appeared in the Tool's own listing.
 *
 * `NEVER_CAPTURED` is `NOT TESTED` rather than `FAIL`, for the reason the milestone's doctrine gives
 * everywhere else: the reproduction was not run, so nothing about the Tools was refuted. It is also the one
 * branch a reader must not mistake for a quiet org — the harness ran executions the platform did not
 * record, which is a deployment fact (ADR-0029's prerequisites) and not a statement about `get_apex_logs`.
 */
export function runTraceActivation(input: Readonly<{
  rounds: number;
  pollAttempts: number;
  waitedMs: number;
  activated: boolean;
  refused: boolean;
}>): P10LiveGate {
  if (input.refused) {
    return notTested(
      'The trace was opened but the warm-up execution that proves it is capturing could not be run, so the measured '
      + 'pair was not run either: a reproduction inside a trace that is not capturing writes no log for any later '
      + 'step to find.',
      Object.freeze({ ...input, activation: 'EXECUTION_REFUSED' }),
    );
  }
  if (!input.activated) {
    return notTested(
      `The trace never became effective: ${input.rounds} warm-up execution(s) and ${input.pollAttempts} listing(s) `
      + `over ${Math.round(input.waitedMs / 1_000)}s produced no new row, so this deployment was not capturing the `
      + 'traced identity\'s executions and the reproduction was not attempted. A FAIL here would blame the Tools for '
      + 'a log the platform never wrote.',
      Object.freeze({ ...input, activation: 'NEVER_CAPTURED' }),
    );
  }
  return gate(true, Object.freeze({
    ...input,
    activation: 'CAPTURED',
    note: 'A warm-up execution of this run appeared in get_apex_logs\' own listing, so the trace was capturing '
      + 'before the measured pair ran. The warm-up rows are excluded from the measurement by re-taking the listing '
      + 'here.',
  }), 'No warm-up execution of this run appeared in the log listing, so the trace was not capturing.');
}

/**
 * The anonymous-Apex surface, declared structurally so a jsforce signature change cannot pass silently.
 *
 * `executeAnonymous` is present on jsforce's `Tooling` API but absent from the package's top-level typings,
 * so it is reached through a cast — the same house pattern the Tooling sObject writers use.
 */
type AnonymousApexApi = Readonly<{ executeAnonymous(body: string): Promise<unknown> }>;

type AnonymousApexRun = Readonly<{
  outcome: 'OK' | 'REFUSED';
  compiled: boolean | null;
  success: boolean | null;
  /** From the platform's own `exceptionMessage`, split on its first colon: `System.NullPointerException`. */
  exceptionTypeFragment: string | null;
  exceptionMessageLength: number | null;
  line: number | null;
  column: number | null;
  salesforceErrorCode: string | null;
}>;

/**
 * Runs one block of anonymous Apex and normalizes the platform's answer to what this file reasons about.
 *
 * A refusal arrives two ways — jsforce rejects, or it resolves with `compiled: false` — and the two are kept
 * apart because only the first is a *permission* answer. Nothing here records the message text of an
 * anonymous-Apex failure: a compile error quotes the source it was given, and that source is this harness's,
 * so the code is recorded, the length is recorded, and the text is not.
 */
async function runAnonymousApex(connection: Connection, body: string): Promise<P10LiveGate> {
  const api = connection.tooling as unknown as AnonymousApexApi;
  let run: AnonymousApexRun;
  try {
    const raw = recordOf(await api.executeAnonymous(body));
    run = Object.freeze({
      outcome: 'OK',
      compiled: raw?.compiled === true ? true : raw?.compiled === false ? false : null,
      success: raw?.success === true ? true : raw?.success === false ? false : null,
      exceptionTypeFragment: typeof raw?.exceptionMessage === 'string' ? splitExceptionType(raw.exceptionMessage) : null,
      exceptionMessageLength: typeof raw?.exceptionMessage === 'string' ? raw.exceptionMessage.length : null,
      line: asNumber(raw?.line),
      column: asNumber(raw?.column),
      salesforceErrorCode: null,
    });
  } catch (error) {
    run = Object.freeze({
      outcome: 'REFUSED',
      compiled: null,
      success: null,
      exceptionTypeFragment: null,
      exceptionMessageLength: null,
      line: null,
      column: null,
      salesforceErrorCode: salesforceErrorCodeOf(error),
    });
  }
  const facts = run.outcome === 'OK' && run.compiled !== null;
  return gate(facts, Object.freeze({
    run,
    sourceLines: body.split('\n').length,
    expectedLogLine: body === REPRODUCTION_APEX ? EXPECTED_EXCEPTION_LINE : null,
  }), `Anonymous Apex did not run: ${run.outcome === 'REFUSED'
    ? `Salesforce refused it with ${run.salesforceErrorCode ?? 'no Salesforce error code'}`
    : 'the platform returned a result with no compilation verdict'}.`);
}

/** `System.NullPointerException: Attempt to de-reference a null object` → `System.NullPointerException`. */
function splitExceptionType(message: string): string | null {
  const colon = message.indexOf(':');
  const head = (colon <= 0 ? message : message.slice(0, colon)).trim();
  return head.length === 0 ? null : head.slice(0, 120);
}

/** The Status each new row carries, taken from the Tool's own listing entries. */
function readStatusesFrom(
  listing: Readonly<Record<string, unknown>> | undefined,
  newIds: readonly string[],
): ReadonlyMap<string, string | null> {
  const logs = readRecords(listing?.logs);
  const entries = newIds.flatMap((id) => {
    const entry = logs.find((candidate) => stringOrNull(candidate.id) === id);
    return entry === undefined ? [] : [[id, stringOrNull(entry.status)] as const];
  });
  return new Map(entries);
}

/** The traced entity, and the username it belongs to — the identity every log of this run is written by. */
async function readSelfUser(connection: Connection): Promise<Readonly<{ userId: string; username: string | null }>> {
  const identity = await connection.identity() as unknown as Readonly<Record<string, unknown>>;
  const userId = stringOrNull(identity.user_id) ?? stringOrNull(identity.userId) ?? '';
  return Object.freeze({ userId, username: stringOrNull(identity.username) });
}

/** The log ids a `get_apex_logs` answer carried, in the order the Tool returned them. */
function listedLogIds(result: CallToolResult | undefined): readonly string[] {
  return readRecords(outputOf(result)?.logs)
    .map((entry) => stringOrNull(entry.id))
    .filter((id): id is string => id !== null);
}

