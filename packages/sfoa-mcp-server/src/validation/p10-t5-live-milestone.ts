import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from '@salesforce/core';
import { DATA_MAX_RESPONSE_BYTES } from '@sfoa/mcp-provider-sfoa-data';
import {
  PLATFORM_DIAGNOSTIC_SECTIONS,
  PLATFORM_DIAGNOSTICS_DEFAULT_WINDOW_HOURS,
  PLATFORM_DIAGNOSTICS_MAX_LIMIT_PER_SECTION,
  PLATFORM_DIAGNOSTICS_MAX_TEXT_CHARACTERS,
  SCHEDULED_JOB_STALL_GRACE_MS,
  assessScheduledJobStall,
  type PlatformDiagnosticSection,
} from '@sfoa/mcp-provider-sfoa-context';
import {
  JwtConnectionFactory,
  JsonLineRuntimeLogger,
  createIdentityRuntime,
  type RequestScope,
  type SalesforceConnectionFactory,
  type SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import {
  AsyncAuditPipeline,
  DatabaseRuntimeLogger,
  MySqlAuditBatchSink,
  MySqlControlPlaneStore,
  MySqlIdentityRepository,
  assertAllMigrationsApplied,
  auditDatabaseConfig,
  createControlPlaneDatabase,
  type ControlPlaneDatabaseClient,
} from '@sfoa/control-plane';
import { loadRemoteRuntimeConfig } from '../config.js';
import { startRemoteMcpServer } from '../http-server.js';
import {
  MySqlRuntimeDiscoveryPolicySnapshotSource,
  MySqlRuntimePolicySnapshotSource,
  snapshotDiagnosticRoute,
} from '../policy-snapshot.js';
import { createAttachmentIngress } from '../runtime.js';
import { maskIdentifier } from './p10-diagnostic-probe.js';
import {
  AdditiveToolPolicySnapshotSource,
  MeasuringConnectionFactory,
  call,
  closeQuietly,
  combine,
  failGate,
  flushAuditTrail,
  gate,
  maskIdsInText,
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
  salesforceMessageOf,
  sleep,
  stringOrNull,
  type P10LiveGate,
  type P10LiveOrgFacts,
} from './p10-live-support.js';

/**
 * The P10-T5 live milestone: `get_platform_diagnostics` measured on a live org.
 *
 * The Tool's whole claim is that three sources a human would otherwise open in three Setup pages are merged
 * into one evidence timeline an incident can be aligned to. Four of its claims are facts about *this* org
 * rather than about the code, and no fixture settles any of them:
 *
 * 1. **Each section is the org's own rows.** Every section is compared against the harness's independent read
 *    of the same source, through the same DIAGNOSTIC pairing, over the window the answer itself reported. A
 *    section that answered with the right *number* of the wrong rows would pass a count check, so the
 *    comparison is of readings, not of totals.
 *
 * 2. **The timeline is the merge of those sections and nothing else.** The harness rebuilds the expected
 *    timeline from the entries the answer carried — including the scheduled-job rule that a `SUSPECTED` job
 *    enters at the time it was due to fire and every other job at the time it last fired — sorts it with the
 *    same ordering the executor uses, and requires the two lists to be identical. Combined with (1), that is
 *    the claim the Tool exists for: the merged list is the org's own events, on one clock.
 *
 * 3. **A genuinely empty source and an unreadable one are different states on the wire.** ADR-0029 §3's
 *    hardest distinction, and this org is the instrument for it: its `CronTrigger` table holds no row, and
 *    its `AsyncApexJob` table holds no `Failed`/`Aborted` row. Both sections must therefore be `READ` with a
 *    count and a caveat — never `UNAVAILABLE` — and the failure section must carry the status vocabulary that
 *    makes a zero-entry answer evidenced rather than silent.
 *
 * 4. **The query surface is the whitelist.** All three objects are standard-API surfaces, and ADR-0029 §4a
 *    records that this org enforces nothing on that surface for the DIAGNOSTIC identity. The harness brackets
 *    every Tool call and asserts, on the wire, that no statement inside the bracket read anything else — and
 *    that no statement inside it was a write.
 *
 * 5. **A real failure, not only an empty window.** Everything above is measured against the rows this org
 *    happens to hold, and this org holds no `Failed`/`Aborted` `AsyncApexJob` row at all — so the failure
 *    section is measured in its hardest state and never in its ordinary one. The last leg supplies the
 *    ordinary one: on a sandbox it compiles a deliberately-failing `Database.Batchable` onto the org, runs
 *    it, waits for the platform to mark the job `Failed`, and then asks the Tool to report it. It is gated on
 *    `Organization.IsSandbox` exactly as T2's and T3's constructing legs are, and it deletes the class again
 *    whatever else happened — including when a leg above it has already failed.
 *
 * **What this milestone writes: one Apex class, on a sandbox only, only through the leg in (5), and only to
 * delete it again.** It constructs no configuration and changes no Control Plane row — the grant that enables
 * the Tool is a snapshot wrapper in memory, exactly as T2, T3 and T4 do it, so a passing run can never be a
 * run that quietly granted itself the Tool it is supposed to prove can be granted. The one row the leg cannot
 * undo is the `AsyncApexJob` row itself: the platform exposes no delete for it, so a sandbox that has run
 * this milestone holds one constructed `Failed` row until Salesforce ages it out. Every read above that leg
 * is taken before it, so the sections are still described as the run found them.
 */

/** The one Tool of this milestone. */
export const P10_T5_TOOL_NAMES = Object.freeze(['get_platform_diagnostics']);

/**
 * The exact input keys the Tool may advertise.
 *
 * A set equality rather than a scan for forbidden names, for T2's reason: this Tool reads the org's own change
 * history, so a fourth key admitting a username, an identity or a raw SOQL fragment is exactly the kind of
 * field a scan tuned to a list of known-bad names would miss. Nothing here selects an identity or a query: the
 * three keys are a window, a section subset and a per-section bound.
 */
export const P10_T5_TOOL_INPUT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  get_platform_diagnostics: Object.freeze(['limitPerSection', 'sections', 'windowHours']),
});

/** ADR-0029 §4a's T5 whitelist, as narrowed by ADR-0033. Nothing else may follow a `FROM` inside a Tool window. */
const PLATFORM_STATUS_OBJECTS = Object.freeze(['SetupAuditTrail', 'AsyncApexJob', 'CronTrigger'] as const);

/** The signature of a write on the wire. This Tool must never issue one. */
const DML_PATTERN = /\b(?:INSERT|UPDATE|DELETE|UPSERT|MERGE)\b/iu;

/** The window the presence legs widen to when the default window holds nothing to align. */
const WIDENED_WINDOW_HOURS = 168;

/**
 * The executor's own read bound, restated here because the comparison is only a comparison if both sides read
 * under the same one. A change to `ASYNC_FAILURE_SCAN_LIMIT` in `platform-diagnostics-executor.ts` has to be
 * mirrored here: the gate would otherwise be comparing the Tool's bounded page against an unbounded one and
 * reporting the difference as a Tool defect.
 */
const ASYNC_FAILURE_SCAN_LIMIT = 200;

/** How far this server's clock may sit from the harness's before the window's upper edge is called odd. */
const CLOCK_TOLERANCE_MS = 5 * 60_000;

/**
 * The Apex the constructed-failure leg compiles onto a sandbox, runs, and deletes again.
 *
 * The name is fixed rather than generated, so a run that crashed before its cleanup is recognisable by the
 * next one: the leg adopts a class of this name rather than colliding with it, and removes it either way.
 *
 * **The failure is raised in `start`, and the first live run is why.** The obvious fixture — a batch that
 * throws from `execute` — was measured on this org and does *not* produce a `Failed` job: two chunks threw,
 * `AsyncApexJob.NumberOfErrors` came back `2`, and the job's status was `Completed`. That is the platform's
 * own vocabulary, not a defect in the read: `execute` runs per chunk and the framework contains a chunk's
 * exception, so it reserves `Failed` for a failure at the job's own level. `start` is the first thing that
 * runs at that level, so it is where this fixture fails — and `System.assert(false, …)` is the one form of
 * failure the Apex compiler cannot let the return statement below it be reached from.
 */
const FIXTURE_APEX_CLASS_NAME = 'SfoaP10T5FailingBatch';

/** The class body, line by line, so the failing line and the locator are readable in this file itself. */
const FIXTURE_APEX_BODY = Object.freeze([
  `public class ${FIXTURE_APEX_CLASS_NAME} implements Database.Batchable<sObject> {`,
  '  public Database.QueryLocator start(Database.BatchableContext context) {',
  "    System.assert(false, 'SfoaP10T5: this batch exists to fail.');",
  "    return Database.getQueryLocator('SELECT Id FROM User');",
  '  }',
  '  public void execute(Database.BatchableContext context, List<sObject> scope) {}',
  '  public void finish(Database.BatchableContext context) {}',
  '}',
].join('\n'));

/** The one statement the anonymous-Apex run makes: submit the class above to the batch queue. */
const FIXTURE_APEX_EXECUTION = `Database.executeBatch(new ${FIXTURE_APEX_CLASS_NAME}());`;

/**
 * How long this leg waits for the job to reach a terminal status, and how often it looks.
 *
 * A sandbox's batch queue is normally serviced within seconds, but "normally" is not a bound: the poll is
 * bounded rather than unconditional so a job that never runs is a recorded state rather than a hung harness,
 * and it is long enough that an ordinary queue delay is not read as a job that never ran.
 */
const FIXTURE_POLL_ATTEMPTS = 20;
const FIXTURE_POLL_INTERVAL_MS = 3_000;

/** The statuses that mean the platform is done with a job, whatever its verdict was. */
const TERMINAL_JOB_STATUSES = Object.freeze(['Completed', 'Failed', 'Aborted'] as const);

/**
 * How the leg reaches the Tooling API. Structural, so a jsforce signature change cannot pass silently — the
 * same house pattern T2's anonymous-Apex runner uses, for the same reason: these methods are present on
 * jsforce's `Tooling` at runtime but absent from the package's own typings.
 */
type ToolingFixtureApi = Readonly<{
  query(statement: string): Promise<unknown>;
  sobject(name: string): Readonly<{
    create(record: Readonly<Record<string, unknown>>): Promise<unknown>;
    destroy(id: string): Promise<unknown>;
  }>;
  executeAnonymous(body: string): Promise<unknown>;
}>;

/** A SOQL string literal. Every value here is this harness's own, but a literal is still escaped as one. */
function soqlLiteral(value: string): string {
  return `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;
}

export type P10T5LiveReport = Readonly<{
  phase: 'P10';
  task: 'T5';
  generatedAt: string;
  /**
   * `MEASURED` — the Control Plane routes a verified Diagnostic identity, so the Tool was enabled in memory
   * and every gate ran.
   * `REFUSED` — it does not, and the runtime would refuse any request that enables a diagnostic Tool, so
   * nothing was attempted.
   */
  mode: 'MEASURED' | 'REFUSED';
  platformUserIdMasked: string;
  org: P10LiveOrgFacts;
  diagnosticIdentity: Readonly<{
    configured: boolean;
    enabled: boolean | null;
    verificationStatus: string | null;
    salesforceUsernameMasked: string | null;
  }>;
  toolInventory: P10LiveGate;
  /** The default call: three sections, each `READ`, with the shape the contract fixes. */
  sectionCoverage: P10LiveGate;
  /** The setup-changes section against the harness's own `SetupAuditTrail` read of the same window. */
  setupChangeFidelity: P10LiveGate;
  /** The failure section against the harness's own `AsyncApexJob` read, vocabulary included. */
  asyncFailureFidelity: P10LiveGate;
  /** The scheduled-jobs section against the harness's own `CronTrigger` read. */
  scheduledJobFidelity: P10LiveGate;
  /** A source the org holds no row for is `READ` with a count, and is never reported as `UNAVAILABLE`. */
  emptySourceClarity: P10LiveGate;
  /** Every entry the answer carries is inside the window the answer itself declares. */
  windowHonesty: P10LiveGate;
  /** The timeline is exactly the merge of the sections that were read, oldest first, and nothing else. */
  mergedTimeline: P10LiveGate;
  /** A subset call returns exactly the sections it asked for, and says so in its note. */
  sectionSelection: P10LiveGate;
  /** The stall flag is hedged, is counted consistently, and never reported as a diagnosis. */
  stallFlag: P10LiveGate;
  /** The dual response budget holds at the largest input the schemas admit. */
  budget: P10LiveGate;
  /**
   * A `Failed` `AsyncApexJob` this run constructs on a sandbox and then finds through the Tool — the failure
   * section's ordinary state, measured on an org that would otherwise only ever show it the empty one.
   * `NOT TESTED` off a sandbox, naming ADR-0029's ban.
   */
  constructedFailure: P10LiveGate;
  /** Inside every Tool window: whitelisted objects only, no DML, and the window literal unquoted. */
  surface: P10LiveGate;
  credentialSafety: P10LiveGate;
  connections: Readonly<{ total: number; distinctSalesforceUsernames: readonly string[] }>;
  auditPersistence: P10LiveGate;
  overall: 'PASS' | 'PARTIAL' | 'FAIL';
}>;

type RecordMark = Readonly<{ statements: number }>;
type RecordWindow = Readonly<{ arguments: Record<string, unknown>; statements: readonly string[] }>;

/**
 * Records what each Tool call sent to the org, so the whitelist claim is made on evidence.
 *
 * The harness makes reads of its own on the same Connection — the independent per-source reads the fidelity
 * gates are built from — so asserting over everything sent would fold the scaffolding into a claim about the
 * Tool. Each call is bracketed by a mark and only the bracketed window is asserted.
 *
 * `request` and the `sobject` handle are recorded too, not because this Tool is expected to use either but
 * because a write would reach the org through one of them: the surface gate's "no DML" leg has to be able to
 * see the doors it expects nothing through. Both are forwarded bound to the real target, so the recorder
 * changes nothing about how the Connection behaves.
 */
class StatementRecordingFactory implements SalesforceConnectionFactory {
  public readonly statements: string[] = [];
  public readonly apiRequests: string[] = [];
  public readonly dmlOperations: string[] = [];

  public constructor(private readonly delegate: SalesforceConnectionFactory) {}

  public mark(): RecordMark {
    return Object.freeze({ statements: this.statements.length });
  }

  public since(mark: RecordMark, argumentsValue: Readonly<Record<string, unknown>>): RecordWindow {
    return Object.freeze({
      arguments: { ...argumentsValue },
      statements: Object.freeze(this.statements.slice(mark.statements)),
    });
  }

  public async create(route: SalesforceIdentityRoute): Promise<Connection> {
    const connection = await this.delegate.create(route);
    const owner = this;
    return new Proxy(connection, {
      get(target, property, receiver) {
        if (property === 'query' || property === 'queryMore') {
          const original = Reflect.get(target, property, receiver) as unknown as
            (...args: unknown[]) => Promise<unknown>;
          return async function record(...args: unknown[]): Promise<unknown> {
            if (typeof args[0] === 'string') owner.statements.push(args[0]);
            return await original.apply(target, args);
          };
        }
        if (property === 'request') {
          const original = Reflect.get(target, property, receiver) as unknown as
            (...args: unknown[]) => Promise<unknown>;
          return async function recordRequest(...args: unknown[]): Promise<unknown> {
            const first = args[0];
            owner.apiRequests.push(typeof first === 'string'
              ? first
              : String(recordOf(first)?.url ?? recordOf(first)?.method ?? 'request'));
            return await original.apply(target, args);
          };
        }
        if (property === 'sobject') {
          const original = Reflect.get(target, property, receiver) as unknown as
            (objectApiName: string, ...rest: unknown[]) => unknown;
          return function recordSObject(objectApiName: string, ...rest: unknown[]): unknown {
            const handle = original.apply(target, [objectApiName, ...rest]) as object;
            return new Proxy(handle, {
              get(handleTarget, handleProperty, handleReceiver) {
                const value = Reflect.get(handleTarget, handleProperty, handleReceiver) as unknown;
                if (typeof value !== 'function') return value;
                if (handleProperty === 'create' || handleProperty === 'update' || handleProperty === 'destroy') {
                  return function recordWrite(...args: unknown[]): unknown {
                    owner.dmlOperations.push(`${objectApiName}.${String(handleProperty)}`);
                    return (value as (...inner: unknown[]) => unknown).apply(handleTarget, args);
                  };
                }
                return function forward(...args: unknown[]): unknown {
                  return (value as (...inner: unknown[]) => unknown).apply(handleTarget, args);
                };
              },
            });
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as Connection;
  }
}

export async function runP10T5LiveMilestone(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<P10T5LiveReport> {
  const config = await loadRemoteRuntimeConfig(projectRoot, environment);
  const controlPlane = config.controlPlane;
  if (controlPlane.mode !== 'mysql') {
    throw new Error('The P10-T5 live milestone requires the MySQL Control Plane: the DIAGNOSTIC identity and the identity routes are read from it.');
  }
  const databaseConfig = controlPlane.database;
  if (!databaseConfig) throw new Error('The P10-T5 live milestone requires the MySQL Control Plane database configuration.');
  if (!config.clientToken) throw new Error('The P10-T5 live milestone requires an independent internal client token.');
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
  // The same two wrappers as T3 and T4, in the same order: `StatementRecordingFactory` answers "what did the
  // Tool send", `MeasuringConnectionFactory` answers "which identity did it open a Connection as".
  const recordingFactory = new StatementRecordingFactory(new JwtConnectionFactory({
    instanceUrl: config.identity.instanceUrl,
    clientId: config.identity.clientId,
    privateKeyPath: config.identity.privateKeyPath,
  }));
  const measuringFactory = new MeasuringConnectionFactory(recordingFactory);
  const identityRuntime = createIdentityRuntime(config.identity, {
    connectionFactory: measuringFactory,
    identityRepository: new MySqlIdentityRepository(database),
    logger: databaseLogger,
  });
  const policySnapshotSource = new MySqlRuntimePolicySnapshotSource(database);

  let server: Awaited<ReturnType<typeof startRemoteMcpServer>> | undefined;
  let scaffoldingScope: RequestScope | undefined;
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
      const reason = `get_platform_diagnostics cannot be enabled because ${missing}. The runtime refuses every request `
        + 'when a diagnostic Tool is enabled without an enabled, verification-passed Diagnostic identity, so the '
        + 'milestone was not attempted: configure and verify the Diagnostic identity through the Admin Control '
        + 'Plane, then re-run.';
      const auditPersistence = runAuditPersistence(await flushAuditTrail(auditPipeline), null);
      await closeQuietly(store, database, auditDatabase, auditPipeline);
      return refusalReport(generatedAt, platformUserId, diagnosticIdentity, reason, auditPersistence);
    }

    // The harness reads the same three sources through the same DIAGNOSTIC pairing the server uses for a
    // `tools/call`, which is what makes each comparison a comparison of *readings* rather than of identities.
    scaffoldingScope = await identityRuntime.scopeFactory.createForRoute(
      { platformUserId, correlationId: `p10-t5-milestone-${Date.now()}` },
      diagnosticRoute,
    );
    const scaffolding = await scaffoldingScope.getConnection();
    const org = await readOrgFacts(scaffolding);

    await assertAllMigrationsApplied(database);
    const attachmentIngress = createAttachmentIngress(config, store);
    server = await startRemoteMcpServer({
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
      policySnapshotSource: new AdditiveToolPolicySnapshotSource(policySnapshotSource, P10_T5_TOOL_NAMES),
      discoveryPolicySnapshotSource: new MySqlRuntimeDiscoveryPolicySnapshotSource(database),
      ...(attachmentIngress === undefined ? {} : { attachmentIngress }),
    });

    const expectedNames = [...new Set([...snapshot.enabledTools, ...P10_T5_TOOL_NAMES])].sort();
    const results: CallToolResult[] = [];
    const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
      requestInit: {
        headers: {
          authorization: `Bearer ${clientToken}`,
          [config.platformUserHeader]: platformUserId,
        },
      },
    });
    const client = new Client({ name: 'p10-t5-live-milestone', version: '0.1.0-p10' });
    await client.connect(transport);
    try {
      const listings = await client.listTools();
      const toolInventory = runToolInventory({
        tools: listings.tools,
        milestoneTools: P10_T5_TOOL_NAMES,
        expectedNames,
        inputKeys: P10_T5_TOOL_INPUT_KEYS,
      });

      const windows: RecordWindow[] = [];
      const diagnostics = async (
        argumentsValue: Readonly<Record<string, unknown>>,
      ): Promise<Readonly<{ result: CallToolResult; output: Record<string, unknown> | undefined }>> => {
        const mark = recordingFactory.mark();
        const result = await call(client, results, 'get_platform_diagnostics', argumentsValue);
        windows.push(recordingFactory.since(mark, argumentsValue));
        return Object.freeze({ result, output: outputOf(result) });
      };

      // 1. The default call, and the contract shape it answers with.
      const defaults = await diagnostics({});
      const sectionCoverage = runSectionCoverage(defaults.output, defaults.result);

      // 2. The setup-changes section against the org, over the window the answer itself reported. When the
      // default window holds no change to align, the leg is re-measured on the widest window the schema admits
      // rather than reported as a failure: a quiet day is a fact about the org, not a Tool defect.
      let setupSource = defaults;
      let setupWidened = false;
      if (entryCount(sectionOf(defaults.output, 'SETUP_CHANGES')) === 0) {
        setupWidened = true;
        setupSource = await diagnostics({ windowHours: WIDENED_WINDOW_HOURS });
      }
      const setupRead = await readIndependentSetupChanges(scaffolding, setupSource.output);
      const setupChangeFidelity = runSetupChangeFidelity(setupSource.output, setupSource.result, setupRead, setupWidened);

      // 3. The failure section against the org, over the same wrapped statement and the same aggregate count
      // the Tool itself sends.
      const asyncRead = await readIndependentAsyncFailures(scaffolding, setupSource.output);
      const asyncFailureFidelity = runAsyncFailureFidelity(setupSource.output, asyncRead);

      // 4. The scheduled-jobs section, and the state distinction an empty source has to keep.
      const cronRead = await readIndependentScheduledJobs(scaffolding);
      const scheduledJobFidelity = runScheduledJobFidelity(setupSource.output, cronRead);
      const emptySourceClarity = runEmptySourceClarity(setupSource.output, cronRead, asyncRead);

      // 5. The window, the merge and the subset call.
      const windowHonesty = runWindowHonesty(setupSource.output, defaults.output);
      const mergedTimeline = runMergedTimeline(setupSource.output);
      const subset = await diagnostics({ sections: ['SETUP_CHANGES', 'ASYNC_FAILURES'] });
      const sectionSelection = runSectionSelection(subset.output, subset.result);

      // 6. The stall flag and the dual budget, at the widest window and the largest per-section bound.
      const stallFlag = runStallFlag(setupSource.output);
      const wide = await diagnostics({
        windowHours: WIDENED_WINDOW_HOURS,
        limitPerSection: PLATFORM_DIAGNOSTICS_MAX_LIMIT_PER_SECTION,
      });
      const budget = runBudget(wide.result, wide.output, defaults.result);

      // 7. The constructed failure: the one leg that makes the org hold the state the failure section exists
      // to report, rather than reading a state the org happens to be in. It runs last because it is the one
      // leg that changes the org, and every read above it is meant to describe the org as the run found it.
      const constructedFailure = await runConstructedFailureLeg(scaffolding, diagnostics, org);

      const surface = runSurface(windows);
      const credentialSafety = runCredentialSafety(results, clientToken, await readAccessToken(scaffolding));

      await client.close().catch(() => undefined);
      const shutdown = await server.close().catch(() => undefined);
      const auditPersistence = runAuditPersistence(await flushAuditTrail(auditPipeline), shutdown);

      return Object.freeze({
        phase: 'P10',
        task: 'T5',
        generatedAt,
        mode: 'MEASURED',
        platformUserIdMasked: maskIdentifier(platformUserId),
        org,
        diagnosticIdentity,
        toolInventory,
        sectionCoverage,
        setupChangeFidelity,
        asyncFailureFidelity,
        scheduledJobFidelity,
        emptySourceClarity,
        windowHonesty,
        mergedTimeline,
        sectionSelection,
        stallFlag,
        budget,
        constructedFailure,
        surface,
        credentialSafety,
        connections: Object.freeze({
          total: measuringFactory.measurements.length,
          distinctSalesforceUsernames: measuredSalesforceUsernames(measuringFactory),
        }),
        auditPersistence,
        overall: combine([
          toolInventory, sectionCoverage, setupChangeFidelity, asyncFailureFidelity, scheduledJobFidelity,
          emptySourceClarity, windowHonesty, mergedTimeline, sectionSelection, stallFlag, budget,
          constructedFailure, surface, credentialSafety, auditPersistence,
        ]),
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  } finally {
    if (server !== undefined) await server.close().catch(() => undefined);
    if (scaffoldingScope !== undefined) await scaffoldingScope.close().catch(() => undefined);
    await closeQuietly(store, database, auditDatabase, auditPipeline);
  }
}

function refusalReport(
  generatedAt: string,
  platformUserId: string,
  diagnosticIdentity: P10T5LiveReport['diagnosticIdentity'],
  reason: string,
  auditPersistence: P10LiveGate,
): P10T5LiveReport {
  return Object.freeze({
    phase: 'P10',
    task: 'T5',
    generatedAt,
    mode: 'REFUSED',
    platformUserIdMasked: maskIdentifier(platformUserId),
    org: Object.freeze({ isSandbox: null, instanceName: null, apiVersion: null, organizationIdMasked: null }),
    diagnosticIdentity,
    toolInventory: notTested(reason),
    sectionCoverage: notTested(reason),
    setupChangeFidelity: notTested(reason),
    asyncFailureFidelity: notTested(reason),
    scheduledJobFidelity: notTested(reason),
    emptySourceClarity: notTested(reason),
    windowHonesty: notTested(reason),
    mergedTimeline: notTested(reason),
    sectionSelection: notTested(reason),
    stallFlag: notTested(reason),
    budget: notTested(reason),
    constructedFailure: notTested(
      `${reason} Nothing was compiled or run: this leg needs the Tool call it observes through.`,
    ),
    surface: notTested(reason),
    credentialSafety: notTested('No Tool call was made.'),
    connections: Object.freeze({ total: 0, distinctSalesforceUsernames: Object.freeze([]) }),
    auditPersistence,
    overall: 'PARTIAL',
  });
}

// ---------------------------------------------------------------------------------------------
// Reading the answer. Every gate below reasons about `structuredContent`, never about prose.
// ---------------------------------------------------------------------------------------------

/** The window an answer declares, or `null` when it declared none. */
type ObservedWindow = Readonly<{ from: string; to: string; hours: number }>;

function windowOf(output: Readonly<Record<string, unknown>> | undefined): ObservedWindow | null {
  const window = recordOf(output?.window);
  const from = stringOrNull(window?.from);
  const to = stringOrNull(window?.to);
  const hours = asNumber(window?.hours);
  return from === null || to === null || hours === null ? null : Object.freeze({ from, to, hours });
}

/** How each section is keyed inside `sections`. The enum is the contract's name; this is the payload's. */
const SECTION_OUTPUT_KEYS: Readonly<Record<PlatformDiagnosticSection, string>> = Object.freeze({
  SETUP_CHANGES: 'setupChanges',
  ASYNC_FAILURES: 'asyncFailures',
  SCHEDULED_JOBS: 'scheduledJobs',
});

function sectionOf(
  output: Readonly<Record<string, unknown>> | undefined,
  name: PlatformDiagnosticSection,
): Record<string, unknown> | undefined {
  return recordOf(recordOf(output?.sections)?.[SECTION_OUTPUT_KEYS[name]]);
}

/** The sections an answer actually carries, in the contract's own order. */
function sectionsOf(output: Readonly<Record<string, unknown>> | undefined): readonly PlatformDiagnosticSection[] {
  return PLATFORM_DIAGNOSTIC_SECTIONS.filter((name) => sectionOf(output, name) !== undefined);
}

function entriesOf(section: Readonly<Record<string, unknown>> | undefined): readonly Record<string, unknown>[] {
  return readRecords(section?.entries);
}

function entryCount(section: Readonly<Record<string, unknown>> | undefined): number {
  return entriesOf(section).length;
}

/** The strings inside an array-valued field. `readRecords` keeps objects, and caveats and reasons are strings. */
function stringsOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function caveatsOf(section: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  return stringsOf(section?.caveats);
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function millisOf(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The first text block a Tool answered with, which is what an Agent reads. */
function textOf(result: CallToolResult): string {
  const block = result.content.find((entry) => entry.type === 'text');
  return block !== undefined && block.type === 'text' ? block.text : '';
}

// ---------------------------------------------------------------------------------------------
// The harness's own readings, which are what the Tool's answers are compared against.
// ---------------------------------------------------------------------------------------------

type IndependentRead<Entry> = Readonly<{
  entries: readonly Entry[];
  /** `null` when the harness's own read could not establish a count — never 0 by default. */
  totalCount: number | null;
  /** The statement the harness sent, bounded for the report. */
  statement: string;
  errorCode: string | null;
}>;

type IndependentSetupChange = Readonly<{ id: string; occurredAt: string }>;
type IndependentAsyncFailure = Readonly<{ id: string; occurredAt: string; status: string | null }>;
type IndependentScheduledJob = Readonly<{
  id: string;
  state: string | null;
  nextFireTime: string | null;
  previousFireTime: string | null;
}>;

function failedRead<Entry>(statement: string, errorCode: string): IndependentRead<Entry> {
  return Object.freeze({ entries: Object.freeze([]), totalCount: null, statement, errorCode });
}

/**
 * The setup-changes read, over the window the Tool reported.
 *
 * The window's lower edge is the literal the Tool itself put in `window.from`, so the harness sends the same
 * question — that is what makes the comparison a comparison of two *readings* rather than of two questions.
 * The upper edge has no clause, exactly as the Tool's does: this Tool deliberately keeps a row newer than
 * `window.to` and reports the clock difference, because the two edges are stamped by two different clocks and
 * the newest change is the one an incident is read for.
 *
 * The read is bounded by one row *more* than the Tool returned, up to the hard maximum the input admits. The
 * extra row is what turns "the Tool returned N rows" into "the Tool returned the newest N rows": with it, the
 * row immediately below the cut is visible and can be required to be no newer than the oldest row the Tool
 * kept. The hard maximum bounds the read when the Tool returned nothing at all.
 */
async function readIndependentSetupChanges(
  connection: Connection,
  toolOutput: Readonly<Record<string, unknown>> | undefined,
): Promise<IndependentRead<IndependentSetupChange> & Readonly<{ nextRowAt: string | null }>> {
  const window = windowOf(toolOutput);
  if (window === null) {
    return Object.freeze({ ...failedRead<IndependentSetupChange>('(window)', 'NO_WINDOW_REPORTED'), nextRowAt: null });
  }
  const returned = entryCount(sectionOf(toolOutput, 'SETUP_CHANGES'));
  const limit = Math.min(Math.max(returned + 1, 1), PLATFORM_DIAGNOSTICS_MAX_LIMIT_PER_SECTION);
  const statement = `SELECT Id, CreatedDate FROM SetupAuditTrail WHERE CreatedDate >= ${window.from} `
    + `ORDER BY CreatedDate DESC LIMIT ${limit}`;
  try {
    const payload = await connection.query(statement) as unknown as Readonly<{ records?: unknown }>;
    const rows = readRecords(payload.records).flatMap((row) => {
      const id = stringOrNull(row.Id);
      const occurredAt = stringOrNull(row.CreatedDate);
      return id === null || occurredAt === null ? [] : [Object.freeze({ id, occurredAt })];
    });
    const countStatement = `SELECT COUNT() FROM SetupAuditTrail WHERE CreatedDate >= ${window.from}`;
    const countPayload = await connection.query(countStatement) as unknown as Readonly<{
      records?: unknown;
      totalSize?: unknown;
    }>;
    const countRow = readRecords(countPayload.records)[0];
    const counted = countRow === undefined
      ? asNumber(countPayload.totalSize)
      // `COUNT()`'s synthetic alias is not a fixed name, so the number is taken as the first numeric field
      // that is not the record's `attributes` envelope — the same reading the executor does, and the reason
      // this agrees with the Tool's `totalCount` rather than merely resembling it.
      : asNumber(Object.entries(countRow).find(([field, value]) => field !== 'attributes' && asNumber(value) !== null)?.[1]);
    return Object.freeze({
      entries: Object.freeze(rows.slice(0, returned)),
      totalCount: counted,
      statement: `${statement} | ${countStatement}`,
      errorCode: null,
      nextRowAt: returned === 0 ? null : stringOrNull(rows[returned]?.occurredAt),
    });
  } catch (error) {
    return Object.freeze({
      ...failedRead<IndependentSetupChange>(statement, salesforceErrorCodeOf(error) ?? 'UNKNOWN'),
      nextRowAt: null,
    });
  }
}

/**
 * The failure read: the Tool's own statement, and the same aggregate count beside it.
 *
 * `AsyncApexJob.CreatedDate` was the one filter this Tool could not use until the T5 probe measured it, so the
 * harness reads the wrapped conjunction the Tool now sends — status filter, window filter, newest first — and
 * then the count over that same conjunction. Reading it this way is what makes the comparison an equality of
 * two readings rather than of two designs: if the Tool's statement and this one ever drift apart, the numbers
 * diverge and the gate says so.
 */
async function readIndependentAsyncFailures(
  connection: Connection,
  toolOutput: Readonly<Record<string, unknown>> | undefined,
): Promise<IndependentRead<IndependentAsyncFailure>
& Readonly<{ vocabularyKeys: readonly string[] | null; totalFromCount: number | null }>> {
  const absent = Object.freeze({ vocabularyKeys: null, totalFromCount: null });
  const window = windowOf(toolOutput);
  if (window === null) {
    return Object.freeze({ ...failedRead<IndependentAsyncFailure>('(window)', 'NO_WINDOW_REPORTED'), ...absent });
  }
  const statement = 'SELECT Id, Status, CreatedDate FROM AsyncApexJob WHERE Status IN (\'Failed\',\'Aborted\') '
    + `AND CreatedDate >= ${window.from} ORDER BY CreatedDate DESC LIMIT ${ASYNC_FAILURE_SCAN_LIMIT}`;
  const countStatement = 'SELECT COUNT() FROM AsyncApexJob WHERE Status IN (\'Failed\',\'Aborted\') '
    + `AND CreatedDate >= ${window.from}`;
  try {
    const payload = await connection.query(statement) as unknown as Readonly<{ records?: unknown }>;
    const rows = readRecords(payload.records);
    const entries = rows.flatMap((row) => {
      const id = stringOrNull(row.Id);
      const occurredAt = stringOrNull(row.CreatedDate);
      return id === null || occurredAt === null
        ? []
        : [Object.freeze({ id, occurredAt, status: stringOrNull(row.Status) })];
    });
    const countPayload = await connection.query(countStatement) as unknown as Readonly<{
      records?: unknown;
      totalSize?: unknown;
    }>;
    const countRow = readRecords(countPayload.records)[0];
    const counted = countRow === undefined
      ? asNumber(countPayload.totalSize)
      : asNumber(Object.entries(countRow).find(([field, value]) => field !== 'attributes' && asNumber(value) !== null)?.[1]);
    return Object.freeze({
      entries: Object.freeze(entries),
      // The Tool reads its total from the same aggregate form, so the harness's number is comparable to the
      // Tool's by construction rather than by resemblance.
      totalCount: counted,
      statement: `${statement} | ${countStatement}`,
      errorCode: null,
      vocabularyKeys: await readStatusVocabularyKeys(connection),
      totalFromCount: counted,
    });
  } catch (error) {
    return Object.freeze({
      ...failedRead<IndependentAsyncFailure>(statement, salesforceErrorCodeOf(error) ?? 'UNKNOWN'),
      ...absent,
    });
  }
}

/**
 * The status literals this org's `AsyncApexJob` table actually holds.
 *
 * This is the evidence under a zero-entry failure section: a filter that matched nothing is only trustworthy
 * if the table it ran against is readable and its literals are the org's own. The harness compares the *keys*
 * rather than the counts, because a job finishing between the Tool's read and the harness's would move a count
 * without changing the vocabulary, and a gate that failed on that would be reporting the org's own activity as
 * a Tool defect.
 */
async function readStatusVocabularyKeys(connection: Connection): Promise<readonly string[] | null> {
  try {
    const payload = await connection.query(
      'SELECT Status, COUNT(Id) total FROM AsyncApexJob GROUP BY Status',
    ) as unknown as Readonly<{ records?: unknown }>;
    const keys = readRecords(payload.records)
      .map((row) => stringOrNull(row.Status))
      .filter((status): status is string => status !== null);
    return Object.freeze([...new Set(keys)].sort());
  } catch {
    return null;
  }
}

/** The scheduled-job read. Current state, so the window does not narrow it — exactly as for the Tool. */
async function readIndependentScheduledJobs(
  connection: Connection,
): Promise<IndependentRead<IndependentScheduledJob> & Readonly<{ readAt: number }>> {
  const statement = 'SELECT Id, CronJobDetail.Name, CronJobDetail.JobType, State, NextFireTime, PreviousFireTime, '
    + 'TimesTriggered FROM CronTrigger LIMIT 200';
  const readAt = Date.now();
  try {
    const payload = await connection.query(statement) as unknown as Readonly<{
      records?: unknown;
      totalSize?: unknown;
    }>;
    const entries = readRecords(payload.records).flatMap((row) => {
      const id = stringOrNull(row.Id);
      return id === null
        ? []
        : [Object.freeze({
          id,
          state: stringOrNull(row.State),
          nextFireTime: stringOrNull(row.NextFireTime),
          previousFireTime: stringOrNull(row.PreviousFireTime),
        })];
    });
    return Object.freeze({
      // The same fallback the executor makes: the org's own `totalSize` when it reports one, and the scanned
      // set otherwise. Two numbers read the same way are the only two numbers worth comparing.
      entries: Object.freeze(entries),
      totalCount: asNumber(payload.totalSize) ?? entries.length,
      statement,
      errorCode: null,
      readAt,
    });
  } catch (error) {
    return Object.freeze({
      ...failedRead<IndependentScheduledJob>(statement, salesforceErrorCodeOf(error) ?? 'UNKNOWN'),
      readAt,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// The gates.
// ---------------------------------------------------------------------------------------------

/**
 * The default call's shape.
 *
 * Three sections, each `READ`, on the fixed DIAGNOSTIC role, over a window whose two edges agree with the
 * hours it declares, with a hint and text an Agent can act on. The per-section fields the three sections differ
 * in are asserted by their own schemas — `oldestRetainedAt`, `observedStatusCounts` and `suspectedStallCount`
 * are required in *every* state — so a section that omitted one would have failed before reaching here.
 */
function runSectionCoverage(
  output: Readonly<Record<string, unknown>> | undefined,
  result: CallToolResult,
): P10LiveGate {
  const present = sectionsOf(output);
  const window = windowOf(output);
  const states = present.map((name) => {
    const section = sectionOf(output, name);
    return Object.freeze({
      section: name,
      status: stringOrNull(section?.status),
      entries: entryCount(section),
      totalCount: section?.totalCount ?? null,
      truncated: section?.truncated ?? null,
      caveats: caveatsOf(section).length,
    });
  });
  const text = textOf(result);
  return gate(
    result.isError !== true
      && output?.success === true
      && output?.executionRole === 'DIAGNOSTIC'
      && output?.api === 'STANDARD'
      && window !== null
      && window.hours === PLATFORM_DIAGNOSTICS_DEFAULT_WINDOW_HOURS
      && states.length === PLATFORM_DIAGNOSTIC_SECTIONS.length
      && states.every((state) => state.status === 'READ')
      && output?.readSectionCount === PLATFORM_DIAGNOSTIC_SECTIONS.length
      && output?.unavailableSectionCount === 0
      && stringOrNull(output?.hint) !== null
      && text.length > 0,
    Object.freeze({
      executionRole: stringOrNull(output?.executionRole),
      api: stringOrNull(output?.api),
      window,
      readSectionCount: asNumber(output?.readSectionCount),
      unavailableSectionCount: asNumber(output?.unavailableSectionCount),
      truncated: output?.truncated ?? null,
      sections: states,
      hintCharacters: stringOrNull(output?.hint)?.length ?? 0,
      textCharacters: text.length,
    }),
    'The default call did not answer with all three sections read, on the fixed DIAGNOSTIC role, over the '
    + 'default window, or it answered without a hint or without text.',
  );
}

/**
 * The setup-changes section against the harness's own read of the same window.
 *
 * Timestamps first, then ids. The section is ordered newest-first by a timestamp, and two rows may share one,
 * so the org is free to return tied rows in either order between the Tool's read and the harness's — a
 * row-by-row id comparison would fail on the org's own tie order and report it as a Tool defect. What is not
 * free is the set of *instants*: the Tool's list must carry the same timestamps as the harness's newest N, in
 * the same non-increasing order, and every id it names must be a row the org holds. The extra row the harness
 * reads below the cut is what turns "N rows" into "the newest N rows".
 */
function runSetupChangeFidelity(
  output: Readonly<Record<string, unknown>> | undefined,
  result: CallToolResult,
  independent: IndependentRead<IndependentSetupChange> & Readonly<{ nextRowAt: string | null }>,
  widened: boolean,
): P10LiveGate {
  if (independent.errorCode !== null) return failIndependently(independent, 'the SetupAuditTrail read');
  const section = sectionOf(output, 'SETUP_CHANGES');
  const entries = entriesOf(section);
  const window = windowOf(output);
  const detail = (extra: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => Object.freeze({
    widenedTo168Hours: widened,
    independentRows: independent.entries.length,
    independentTotalCount: independent.totalCount,
    returnedEntries: entries.length,
    toolTotalCount: section?.totalCount ?? null,
    ...extra,
  });
  const toolTimes = entries.map((entry) => stringOrNull(entry.occurredAt));
  const expectedTimes = independent.entries.map((entry) => entry.occurredAt);
  if (expectedTimes.length === 0) {
    // The harness read the widest window the input admits and found no row at all. That is a fact about the
    // org — and it is the one state in which there is nothing on this source to align a timeline to — so the
    // row-level fidelity claim is not measured rather than being called a pass or a failure. The section's own
    // count is still required to agree with the org's, because "there is nothing here" is itself a claim.
    return gate(
      section?.status === 'READ' && entryCount(section) === 0 && section.totalCount === independent.totalCount,
      detail({ entryCount: entryCount(section), vacuous: true }),
      'This org returned no SetupAuditTrail row inside the widest window the schema admits, and the section did '
      + 'not report that as a READ section holding no row with the org\'s own count.',
    ).status === 'PASS'
      ? notTested(
        'This org returned no SetupAuditTrail row inside the widest window the schema admits, so there was no '
        + 'change to align the timeline to: the section\'s row-level fidelity could not be measured. Its empty '
        + 'state was measured — a READ section, no entries, and the org\'s own count of zero.',
        detail({ entryCount: entryCount(section), emptyStateReportedAsRead: true }),
      )
      : gate(
        false,
        detail({ entryCount: entryCount(section) }),
        'This org returned no SetupAuditTrail row at all, and the section did not report that as a READ section '
        + 'holding no row with a count of zero — an empty source must not be rendered as an unread one.',
      );
  }
  const toolIds = entries.flatMap((entry) => {
    const id = stringOrNull(entry.id);
    return id === null ? [] : [id];
  });
  const known = new Set(independent.entries.map((entry) => entry.id));
  const unknown = toolIds.filter((id) => !known.has(id));
  const timesAgree = toolTimes.length === expectedTimes.length
    && toolTimes.every((value, index) => value !== null && millisOf(value) === millisOf(expectedTimes[index] ?? null));
  const nonIncreasing = toolTimes.every((value, index) => index === 0
    || (millisOf(value) ?? Number.NEGATIVE_INFINITY)
      <= (millisOf(toolTimes[index - 1] ?? null) ?? Number.NEGATIVE_INFINITY));
  const nextMs = millisOf(independent.nextRowAt);
  const oldestKeptMs = millisOf(toolTimes[toolTimes.length - 1] ?? null);
  // The newest-N claim: the row just below the cut is never newer than the oldest row the Tool kept.
  const cutIsATimestampCut = nextMs === null || oldestKeptMs === null || nextMs <= oldestKeptMs;
  const incomplete = entries.filter((entry) => stringOrNull(entry.id) === null
    || stringOrNull(entry.occurredAt) === null
    || stringOrNull(entry.action) === null
    || stringOrNull(entry.section) === null);
  return gate(
    result.isError !== true
      && section?.status === 'READ'
      && section.totalCount === independent.totalCount
      && timesAgree
      && nonIncreasing
      && cutIsATimestampCut
      && unknown.length === 0
      && incomplete.length === 0
      && (window === null
        || millisOf(toolTimes[0] ?? null) === null
        || (millisOf(toolTimes[0] ?? null) ?? 0) >= (millisOf(window.from) ?? 0)),
    detail({
      vacuous: false,
      timestampsMatchTheIndependentRead: timesAgree,
      timestampsNonIncreasing: nonIncreasing,
      nextRowBelowTheCutAt: independent.nextRowAt,
      cutFallsAtATimestampBoundary: cutIsATimestampCut,
      idsNotInTheOrg: unknown.slice(0, 5),
      entriesMissingARequiredField: incomplete.length,
      newestToolTimestamp: toolTimes[0] ?? null,
      newestOrgTimestamp: expectedTimes[0] ?? null,
      actions: [...new Set(entries.map((entry) => stringOrNull(entry.action)).filter((value) => value !== null))].slice(0, 8),
      createdBy: [...new Set(entries.map((entry) => stringOrNull(entry.createdBy)).filter((value) => value !== null))].slice(0, 4),
    }),
    'The setup-changes section did not match this org\'s own SetupAuditTrail rows for the window the answer '
    + 'reported: a timestamp disagreed with an independent read, the list was not the newest rows in order, an '
    + 'entry named a row the org does not hold, or the window count disagreed.',
  );
}

/**
 * The failure section against the harness's own read.
 *
 * This org holds no `Failed`/`Aborted` row, so on it the claim being measured is the harder one: zero matching
 * rows has to be *evidenced* — the section must report the status vocabulary of the table it read, and that
 * vocabulary must be the org's own. A zero-entry answer with no vocabulary beside it is indistinguishable from
 * a filter that matched the wrong literals, which is exactly the state ADR-0029 §3 forbids an aggregator from
 * rendering as "nothing happened".
 */
function runAsyncFailureFidelity(
  output: Readonly<Record<string, unknown>> | undefined,
  independent: IndependentRead<IndependentAsyncFailure>
  & Readonly<{ vocabularyKeys: readonly string[] | null; totalFromCount: number | null }>,
): P10LiveGate {
  if (independent.errorCode !== null) return failIndependently(independent, 'the AsyncApexJob read');
  const section = sectionOf(output, 'ASYNC_FAILURES');
  const entries = entriesOf(section);
  const vocabulary = recordOf(section?.observedStatusCounts);
  const sectionKeys = vocabulary === undefined ? null : Object.keys(vocabulary).sort();
  const toolTimes = entries.map((entry) => stringOrNull(entry.occurredAt));
  const expectedTimes = independent.entries.map((entry) => entry.occurredAt);
  const newestRows = toolTimes.length <= expectedTimes.length
    && toolTimes.every((value, index) => value !== null && millisOf(value) === millisOf(expectedTimes[index] ?? null));
  const known = new Set(independent.entries.map((entry) => entry.id));
  const unknown = entries.flatMap((entry) => {
    const id = stringOrNull(entry.id);
    return id === null || !known.has(id) ? [id ?? '(no id)'] : [];
  });
  const vocabularyAgrees = sectionKeys !== null
    && independent.vocabularyKeys !== null
    && sameStrings(sectionKeys, independent.vocabularyKeys);
  const zeroEntries = entries.length === 0;
  return gate(
    section?.status === 'READ'
      && section.totalCount === independent.totalCount
      && newestRows
      && unknown.length === 0
      && vocabularyAgrees
      && (!zeroEntries || section.totalCount === 0),
    Object.freeze({
      independentEntries: independent.entries.length,
      independentTotalCount: independent.totalCount,
      returnedEntries: entries.length,
      toolTotalCount: section?.totalCount ?? null,
      // The Tool's total and the harness's are both the org's own answer to the same count statement. When the
      // two readings disagree it is worth seeing which spelling each side took, because the platform has two
      // (`totalSize` on empty records, and a synthetic column) and the Tool accepts both.
      totalFromTheHarnessCount: independent.totalFromCount,
      toolTimestampsAreTheNewestRows: newestRows,
      idsNotInTheOrg: unknown.slice(0, 5),
      zeroEntryState: zeroEntries,
      toolObservedStatusCounts: vocabulary ?? null,
      orgStatusVocabulary: independent.vocabularyKeys,
      vocabularyAgrees,
      statuses: [...new Set(entries.map((entry) => stringOrNull(entry.status)).filter((value) => value !== null))].slice(0, 5),
    }),
    'The failure section did not match this org\'s own AsyncApexJob rows for the reported window, or its status '
    + 'vocabulary — the evidence that a zero-entry answer is a filter that matched nothing rather than a filter '
    + 'that matched the wrong literals — disagreed with an independent read.',
  );
}

/**
 * The scheduled-jobs section against the harness's own read.
 *
 * `CronTrigger` is current state and carries no timestamp the section is ordered by, so this comparison is
 * membership and the count rather than a prefix: the claim is that every job the Tool named is a job the org
 * holds, and that neither side sees a different number of them.
 *
 * **When the org schedules nothing, the row-level claim is vacuous**, and the gate says so in its own detail
 * rather than passing quietly: with no rows on either side there is nothing to be right or wrong about. What is
 * *not* vacuous is still required — the section must be `READ` holding no row — and that state is measured in
 * full by `emptySourceClarity`.
 */
function runScheduledJobFidelity(
  output: Readonly<Record<string, unknown>> | undefined,
  independent: IndependentRead<IndependentScheduledJob> & Readonly<{ readAt: number }>,
): P10LiveGate {
  if (independent.errorCode !== null) return failIndependently(independent, 'the CronTrigger read');
  const section = sectionOf(output, 'SCHEDULED_JOBS');
  const entries = entriesOf(section);
  if (independent.entries.length === 0) {
    return gate(
      section?.status === 'READ' && entries.length === 0,
      Object.freeze({
        vacuous: true,
        vacuityReason: 'This org holds no CronTrigger row, so no scheduled job\'s entry fields could be compared '
          + 'against the org\'s own. What this state does require — a READ section holding no row — is asserted here '
          + 'and measured in full by the `emptySourceClarity` gate.',
        independentRows: 0,
        toolStatus: stringOrNull(section?.status),
        toolTotalCount: section?.totalCount ?? null,
      }),
      'This org schedules nothing, and the section did not report that as a READ section holding no row.',
    );
  }
  const known = new Set(independent.entries.map((entry) => entry.id));
  const unknown = entries.flatMap((entry) => {
    const id = stringOrNull(entry.id);
    return id === null || !known.has(id) ? [id ?? '(no id)'] : [];
  });
  return gate(
    section?.status === 'READ'
      && section.totalCount === independent.totalCount
      && unknown.length === 0,
    Object.freeze({
      vacuous: false,
      independentRows: independent.entries.length,
      independentTotalCount: independent.totalCount,
      returnedEntries: entries.length,
      toolTotalCount: section?.totalCount ?? null,
      idsNotInTheOrg: unknown.slice(0, 5),
      ordering: 'membership only: CronTrigger carries no timestamp this section is ordered by, so there is no '
        + '"newest N" claim to make and the section is compared as a set.',
    }),
    'The scheduled-jobs section did not match this org\'s own CronTrigger rows: it returned a job the org does '
    + 'not hold, or its count disagreed with an independent read.',
  );
}

/**
 * ADR-0029 §3's hardest distinction, measured on the one org where it can be: this org holds no `CronTrigger`
 * row and no `Failed`/`Aborted` `AsyncApexJob` row, so both sections are in the state a careless implementation
 * renders as a silent empty list.
 *
 * The claim is not "the lists are empty" — a harness could check that against any broken Tool. It is that an
 * empty list here is a `READ` section carrying a count and a caveat, and that the unreadable state is a
 * *different* one on the wire. That difference is what an Agent plans on: `totalCount: 0` with `status: READ`
 * says "nothing happened", while `totalCount: null` with `status: UNAVAILABLE` says "this could not be read".
 */
function runEmptySourceClarity(
  output: Readonly<Record<string, unknown>> | undefined,
  cron: IndependentRead<IndependentScheduledJob> & Readonly<{ readAt: number }>,
  async: IndependentRead<IndependentAsyncFailure> & Readonly<{ vocabularyKeys: readonly string[] | null }>,
): P10LiveGate {
  if (cron.errorCode !== null) return failIndependently(cron, 'the CronTrigger read');
  if (async.errorCode !== null) return failIndependently(async, 'the AsyncApexJob read');
  const jobs = sectionOf(output, 'SCHEDULED_JOBS');
  const jobsCaveats = caveatsOf(jobs).join(' ');
  const cronEmpty = cron.entries.length === 0;
  const cronLeg = cronEmpty
    ? jobs?.status === 'READ'
      && jobs.totalCount === 0
      && entryCount(jobs) === 0
      && (jobs.unavailableReason ?? null) === null
      && jobsCaveats.length > 0
    : null;
  const failures = sectionOf(output, 'ASYNC_FAILURES');
  const failureCaveats = caveatsOf(failures).join(' ');
  const asyncEmpty = async.entries.length === 0;
  const asyncLeg = asyncEmpty
    ? failures?.status === 'READ'
      && failures.totalCount === 0
      && entryCount(failures) === 0
      // Not "there are no rows" — this org has a real `AsyncApexJob` table with hundreds of rows in it, and
      // the section must still be a READ section whose count is the window's own count statement, not a
      // section that found nothing to say.
      && failures.truncated === false
    : null;
  return gate(
    (cronLeg ?? true) && (asyncLeg ?? true) && (cronLeg !== null || asyncLeg !== null),
    Object.freeze({
      cronTriggerRows: cron.entries.length,
      cronEmptyStateMeasured: cronLeg !== null,
      cronTriggerLeg: cronLeg,
      cronTriggerStatus: stringOrNull(jobs?.status),
      cronTriggerTotalCount: jobs?.totalCount ?? null,
      cronTriggerCaveatMentionsTheEmptyTable: /no CronTrigger row/u.test(jobsCaveats),
      asyncEmptyStateMeasured: asyncLeg !== null,
      asyncFailuresLeg: asyncLeg,
      asyncFailuresStatus: stringOrNull(failures?.status),
      asyncFailuresTotalCount: failures?.totalCount ?? null,
      asyncFailuresTruncated: failures?.truncated ?? null,
      asyncFailuresCaveats: failureCaveats.slice(0, 300),
    }),
    'A source this org holds no row for was not reported as a read section with a count of zero and a caveat: an '
    + 'empty source has to be distinguishable from an unreadable one.',
  );
}

/** Every entry the answer carries is inside the window the answer itself declares. */
function runWindowHonesty(
  output: Readonly<Record<string, unknown>> | undefined,
  defaults: Readonly<Record<string, unknown>> | undefined,
): P10LiveGate {
  const window = windowOf(output);
  if (window === null) {
    return failIndependently({ errorCode: 'NO_WINDOW_REPORTED', statement: '(window)' }, 'the declared window');
  }
  const from = millisOf(window.from);
  const to = millisOf(window.to);
  const defaultWindow = windowOf(defaults);
  const outside: string[] = [];
  for (const name of sectionsOf(output)) {
    for (const entry of entriesOf(sectionOf(output, name))) {
      const at = millisOf(stringOrNull(entry.occurredAt));
      if (from === null || at === null || at < from) {
        outside.push(`${name}:${String(entry.id)}@${String(entry.occurredAt)}`);
      }
    }
  }
  for (const entry of readRecords(recordOf(output?.alignment)?.timeline)) {
    const at = millisOf(stringOrNull(entry.occurredAt));
    if (from === null || at === null || at < from) {
      outside.push(`timeline:${String(entry.entryId)}@${String(entry.occurredAt)}`);
    }
  }
  const spanHours = from === null || to === null ? null : (to - from) / 3_600_000;
  const clockSkewMs = to === null ? null : Date.now() - to;
  return gate(
    from !== null
      && to !== null
      && from < to
      && spanHours !== null
      && Math.abs(spanHours - window.hours) < 0.01
      && clockSkewMs !== null
      && Math.abs(clockSkewMs) <= CLOCK_TOLERANCE_MS
      && outside.length === 0
      && (defaultWindow === null || defaultWindow.hours === PLATFORM_DIAGNOSTICS_DEFAULT_WINDOW_HOURS),
    Object.freeze({
      window,
      spanHours,
      // The upper edge is this server's clock, so a reader has to be able to see how far it sat from the
      // harness's at the moment of the call.
      serverClockSkewMs: clockSkewMs,
      defaultWindowHours: defaultWindow?.hours ?? null,
      outsideWindow: outside.slice(0, 5),
    }),
    'The answer carried an entry outside the window it declared, or its window\'s two edges disagreed with the '
    + 'hours it declared, or its upper edge is not this server\'s clock.',
  );
}

/**
 * The merge, rebuilt from the answer's own sections and required to be identical to the timeline it returned.
 *
 * Every line is reproduced — the section it came from, the instant it was stamped with, and the position — and
 * the two lists are compared in order rather than merely for membership. That includes the scheduled-job rule
 * the executor applies: a `SUSPECTED` job enters at the time it was *due* to fire and did not, every other job
 * at the time it last fired, a job whose relevant instant is older than the window contributes no line at all,
 * and a job contributes at most one. The comparison runs through the executor's own ordering, ties included, so
 * a timeline that merely *contains* the right lines in some other order is a failure: the order is the axis an
 * incident is read along.
 *
 * Combined with the per-section fidelity gates, which establish that each section *is* the org's own rows, this
 * is the claim the Tool exists for: the merged list is the org's own events on one clock, and nothing else is
 * on it.
 */
function runMergedTimeline(output: Readonly<Record<string, unknown>> | undefined): P10LiveGate {
  const from = millisOf(windowOf(output)?.from ?? null) ?? Number.NEGATIVE_INFINITY;
  const expected: { occurredAt: string; section: PlatformDiagnosticSection; entryId: string }[] = [];
  const sectionOfEntry = new Map<string, PlatformDiagnosticSection>();
  for (const name of sectionsOf(output)) {
    const section = sectionOf(output, name);
    if (section?.status !== 'READ') continue;
    for (const entry of entriesOf(section)) {
      const id = stringOrNull(entry.id);
      if (id === null) continue;
      sectionOfEntry.set(id, name);
      if (name === 'SCHEDULED_JOBS') {
        const due = stringOrNull(entry.stallAssessment) === 'SUSPECTED' ? stringOrNull(entry.nextFireTime) : null;
        const fired = stringOrNull(entry.previousFireTime);
        const dueMs = millisOf(due);
        const firedMs = millisOf(fired);
        if (due !== null && dueMs !== null && dueMs >= from) {
          expected.push({ occurredAt: due, section: name, entryId: id });
        } else if (fired !== null && firedMs !== null && firedMs >= from) {
          expected.push({ occurredAt: fired, section: name, entryId: id });
        }
        continue;
      }
      const occurredAt = stringOrNull(entry.occurredAt);
      if (occurredAt !== null) expected.push({ occurredAt, section: name, entryId: id });
    }
  }
  expected.sort(compareTimeline);
  const actual = readRecords(recordOf(output?.alignment)?.timeline).map((entry) => ({
    occurredAt: stringOrNull(entry.occurredAt),
    section: stringOrNull(entry.section),
    entryId: stringOrNull(entry.entryId),
  }));
  const disagreements = actual.flatMap((entry, index) => {
    const implied = expected[index];
    if (implied === undefined) return [`line ${index} (${String(entry.entryId)}) is not in any section's entries`];
    if (entry.entryId !== implied.entryId) {
      return [`line ${index}: the timeline has ${String(entry.entryId)}, the sections imply ${implied.entryId}`];
    }
    if (entry.section !== implied.section) {
      return [`line ${index}: ${implied.entryId} is attributed to ${String(entry.section)} but came from ${implied.section}`];
    }
    if (millisOf(entry.occurredAt) !== millisOf(implied.occurredAt)) {
      return [`line ${index}: ${implied.entryId} is stamped ${String(entry.occurredAt)} but its section implies ${implied.occurredAt}`];
    }
    return [];
  });
  if (actual.length < expected.length) {
    disagreements.push(`${expected.length - actual.length} line(s) the sections imply are missing from the timeline`);
  }
  const unattributed = actual.filter((entry) => entry.entryId === null
    || !sectionOfEntry.has(entry.entryId));
  const note = stringOrNull(recordOf(output?.alignment)?.note);
  return gate(
    disagreements.length === 0
      && unattributed.length === 0
      && note !== null
      && /candidate and not a cause/u.test(note),
    Object.freeze({
      timelineEntries: actual.length,
      entriesImpliedByTheSections: expected.length,
      disagreements: disagreements.slice(0, 6),
      linesNamingNoSectionEntry: unattributed.slice(0, 5),
      ordering: 'reproduced, ties included: the instant, then the contract\'s section order, then the entry id — '
        + 'the same comparator the executor sorts with.',
      noteSaysCandidateNotCause: note !== null && /candidate and not a cause/u.test(note),
      timelineSections: actual.map((entry) => entry.section),
    }),
    'The merged timeline was not exactly the sections\' own entries: a line was unattributed, stamped with an '
    + 'instant no section implies, out of order, missing, or the note did not say that the nearest entry above a '
    + 'symptom is a candidate rather than a cause.',
  );
}

/** The executor's own ordering, reproduced: the instant first, then the contract's section order, then the id. */
function compareTimeline(
  left: Readonly<{ occurredAt: string; section: PlatformDiagnosticSection; entryId: string }>,
  right: Readonly<{ occurredAt: string; section: PlatformDiagnosticSection; entryId: string }>,
): number {
  const leftMs = millisOf(left.occurredAt) ?? Number.POSITIVE_INFINITY;
  const rightMs = millisOf(right.occurredAt) ?? Number.POSITIVE_INFINITY;
  if (leftMs !== rightMs) return leftMs - rightMs;
  const order = PLATFORM_DIAGNOSTIC_SECTIONS.indexOf(left.section)
    - PLATFORM_DIAGNOSTIC_SECTIONS.indexOf(right.section);
  return order !== 0 ? order : left.entryId.localeCompare(right.entryId, 'en-US');
}

/** A subset call returns exactly the sections it asked for, and the note says the merge covers a subset. */
function runSectionSelection(
  output: Readonly<Record<string, unknown>> | undefined,
  result: CallToolResult,
): P10LiveGate {
  const requested: readonly PlatformDiagnosticSection[] = Object.freeze(['SETUP_CHANGES', 'ASYNC_FAILURES']);
  const expectedSections = PLATFORM_DIAGNOSTIC_SECTIONS.filter((name) => requested.includes(name));
  const present = sectionsOf(output);
  const timelineSections = [...new Set(
    readRecords(recordOf(output?.alignment)?.timeline).map((entry) => stringOrNull(entry.section)),
  )].filter((section): section is string => section !== null);
  const note = stringOrNull(recordOf(output?.alignment)?.note) ?? '';
  return gate(
    result.isError !== true
      && output?.readSectionCount === requested.length
      && output?.unavailableSectionCount === 0
      && sameStrings(present, expectedSections)
      // A short timeline is ambiguous on its own — an unread section and an unasked-for one both simply
      // contribute no lines — so the note is where "this call asked for two of the three" has to be said.
      && /asked for 2 of the 3 sections/u.test(note)
      && timelineSections.every((section) => expectedSections.includes(section as PlatformDiagnosticSection)),
    Object.freeze({
      requested,
      presentSections: present,
      expectedSections,
      readSectionCount: asNumber(output?.readSectionCount),
      timelineSections,
      noteMentionsTheSubset: /asked for 2 of the 3 sections/u.test(note),
    }),
    'A call that named two sections did not answer with exactly those two, or its note did not say that the '
    + 'merge covers a subset so a quiet stretch on a section it did not name is absent evidence.',
  );
}

/**
 * The stall flag: hedged, consistently counted, and never a verdict.
 *
 * The rule itself is unit-tested against every `CronTrigger` shape the schema admits; what only a live org can
 * establish is that the flag survives the wire as a hedge, that the count reported beside the rows agrees with
 * the rows, and that the classification the Tool shipped is the one the *published* rule produces from the same
 * fields — the harness re-runs `assessScheduledJobStall` over each entry's own values and requires agreement, so
 * a Tool that flagged a running job or missed a late waiting one is caught here.
 *
 * On an org that schedules nothing every one of those claims is vacuously true, and the gate names that in its
 * own detail instead of letting a green word stand for a measurement that was never made.
 */
function runStallFlag(output: Readonly<Record<string, unknown>> | undefined): P10LiveGate {
  const section = sectionOf(output, 'SCHEDULED_JOBS');
  if (section?.status !== 'READ') {
    return failIndependently(
      { errorCode: 'SCHEDULED_JOBS_NOT_READ', statement: '(section state)' },
      'the scheduled-jobs section',
    );
  }
  const entries = entriesOf(section);
  const flagged = entries.filter((entry) => stringOrNull(entry.stallAssessment) === 'SUSPECTED');
  const reported = asNumber(section.suspectedStallCount);
  // The Tool counts over everything it read and lists only what it kept, so with a cut the two legitimately
  // differ — but only in one direction, and only when a cut actually happened.
  const totalCount = asNumber(section.totalCount);
  const cut = totalCount === null || totalCount > entries.length;
  const countAgrees = reported !== null && (cut ? reported >= flagged.length : reported === flagged.length);
  const hedged = flagged.every((entry) => /not a diagnosis/u.test(stringsOf(entry.stallReasons).join(' ')));
  // The instant the Tool judged against is the window's upper edge — the same clock it stamped the window with,
  // and therefore the same `now` that produced the verdicts below.
  const nowMs = millisOf(windowOf(output)?.to ?? null) ?? Date.now();
  const lateEnough = flagged.every((entry) => {
    const at = millisOf(stringOrNull(entry.nextFireTime));
    return at !== null && nowMs - at > SCHEDULED_JOB_STALL_GRACE_MS;
  });
  const unrecognized = entries.filter((entry) => !['SUSPECTED', 'NOT_SUSPECTED', 'INDETERMINATE']
    .includes(stringOrNull(entry.stallAssessment) ?? ''));
  const disagreeing = entries.filter((entry) => assessScheduledJobStall({
    state: stringOrNull(entry.state),
    nextFireTime: stringOrNull(entry.nextFireTime),
    previousFireTime: stringOrNull(entry.previousFireTime),
    nowMs,
  }).assessment !== stringOrNull(entry.stallAssessment));
  return gate(
    countAgrees && hedged && lateEnough && unrecognized.length === 0 && disagreeing.length === 0,
    Object.freeze({
      rows: entries.length,
      flagged: flagged.length,
      reportedSuspectedStallCount: reported,
      countAgreesWithTheRows: countAgrees,
      entryCapApplied: cut,
      flaggedRowsArePastTheGrace: lateEnough,
      everyFlagIsHedged: hedged,
      unrecognizedAssessments: unrecognized.map((entry) => stringOrNull(entry.stallAssessment)).slice(0, 5),
      disagreeingWithThePublishedRule: disagreeing.map((entry) => stringOrNull(entry.id)).slice(0, 5),
      // Named rather than hidden: with no rows, "every row is classified consistently" is true and proves
      // nothing about the rule, and a reader has to be able to see that from the report alone.
      vacuous: entries.length === 0,
      sampleReasons: flagged.length === 0
        ? []
        : stringsOf(flagged[0]?.stallReasons).map((reason) => reason.slice(0, 200)),
    }),
    'The stall flag was not consistent with the rows it was reported beside, was not hedged as a flag rather '
    + 'than a diagnosis, or disagreed with the published rule applied to the same fields.',
  );
}

/**
 * The dual budget, measured at the largest input the schemas admit.
 *
 * `limitPerSection: 100` over a 168-hour window is the widest answer this Tool can be asked for. The structured
 * payload is measured against `DATA_MAX_RESPONSE_BYTES` — the same quantity the executor measures when it walks
 * its ladder, so the two numbers are comparable — and the rendered text against
 * `PLATFORM_DIAGNOSTICS_MAX_TEXT_CHARACTERS`. The whole `CallToolResult` is reported beside them but not gated
 * on: it adds this transport's envelope, which is neither of the budgets the Tool declared.
 *
 * When a section was cut, the answer has to say so: a bare `truncated: true`, or a top-level flag disagreeing
 * with the per-section ones, would leave a reader unable to tell a short answer from a shortened one.
 */
function runBudget(
  wide: CallToolResult,
  wideOutput: Readonly<Record<string, unknown>> | undefined,
  narrow: CallToolResult,
): P10LiveGate {
  const wideStructuredBytes = Buffer.byteLength(JSON.stringify(wideOutput ?? {}), 'utf8');
  const narrowStructuredBytes = Buffer.byteLength(JSON.stringify(outputOf(narrow) ?? {}), 'utf8');
  const wideTextCharacters = textOf(wide).length;
  const wideWindow = windowOf(wideOutput);
  const sections = PLATFORM_DIAGNOSTIC_SECTIONS.map((name) => {
    const section = sectionOf(wideOutput, name);
    return Object.freeze({
      section: name,
      present: section !== undefined,
      status: stringOrNull(section?.status),
      entries: entryCount(section),
      totalCount: asNumber(section?.totalCount),
      truncated: section?.truncated ?? null,
      caveatCount: caveatsOf(section).length,
    });
  });
  const truncatedSections = sections.filter((section) => section.truncated === true);
  // A section marked truncated has to be explicable: either a caveat says why, or the window holds more rows
  // than it returned. A bare `truncated: true` with neither is the one shape that would leave a reader unable
  // to tell a short answer from a shortened one.
  const explained = truncatedSections.every((section) => section.caveatCount > 0
    || (section.totalCount !== null && section.totalCount > section.entries));
  return gate(
    wide.isError !== true
      && wideStructuredBytes <= DATA_MAX_RESPONSE_BYTES
      && wideTextCharacters <= PLATFORM_DIAGNOSTICS_MAX_TEXT_CHARACTERS
      && narrowStructuredBytes <= DATA_MAX_RESPONSE_BYTES
      && wideWindow !== null
      && wideWindow.hours === WIDENED_WINDOW_HOURS
      && (wideOutput?.truncated === true) === (truncatedSections.length > 0)
      && explained,
    Object.freeze({
      structuredBudgetBytes: DATA_MAX_RESPONSE_BYTES,
      textBudgetCharacters: PLATFORM_DIAGNOSTICS_MAX_TEXT_CHARACTERS,
      widestStructuredBytes: wideStructuredBytes,
      widestTextCharacters: wideTextCharacters,
      widestResultBytesReportedNotGated: Buffer.byteLength(JSON.stringify(wide), 'utf8'),
      defaultStructuredBytes: narrowStructuredBytes,
      widestWindowHours: wideWindow?.hours ?? null,
      truncationObserved: truncatedSections.length > 0,
      truncatedSections: truncatedSections.map((section) => section.section),
      sections,
    }),
    'The widest answer the schemas admit did not fit the structured or the text budget, the top-level truncation '
    + 'flag disagreed with the sections\', or a section reported truncation with nothing saying why.',
  );
}

// ---------------------------------------------------------------------------------------------
// The constructed failure
// ---------------------------------------------------------------------------------------------

/** How the orchestrator hands one Tool call to a leg: the call's result, and its structured content. */
type DiagnosticsCall = (argumentsValue: Readonly<Record<string, unknown>>) => Promise<
Readonly<{ result: CallToolResult; output: Record<string, unknown> | undefined }>>;

/** What establishing the fixture class left behind: the id to clean up with, and how it came to exist. */
type FixtureEstablishment = Readonly<{
  state: 'CONSTRUCTED' | 'ALREADY' | 'FAILED';
  classId: string | null;
  detail: Readonly<Record<string, unknown>>;
}>;

/** Everything the observation measured, and every claim about it that did not hold. */
type FailureObservation = Readonly<{
  problems: readonly string[];
  detail: Readonly<Record<string, unknown>>;
}>;

/**
 * A `Failed` `AsyncApexJob` this run makes, and then finds through the Tool.
 *
 * Every other leg of this milestone measures the Tool against the rows the org happens to hold, and this org
 * holds no `Failed`/`Aborted` `AsyncApexJob` row at all — so the failure section is measured in its hardest
 * state (an evidenced zero) and never in its ordinary one. This leg supplies the ordinary one, end to end:
 *
 * 1. compile a deliberately-failing `Database.Batchable` onto the org through the Tooling API;
 * 2. submit it with one block of anonymous Apex;
 * 3. poll `AsyncApexJob` until the platform marks the job terminal, and require `Failed` — the platform's own
 *    verdict, not this harness's expectation of it;
 * 4. ask the Tool for it, with a one-hour window and only the failure section requested, and require the
 *    entry, its status, its class name and its timestamp to be the row the org holds — and the merged
 *    timeline to carry the same entry id;
 * 5. delete the class again, whatever happened above.
 *
 * The order is the point. Steps 1–4 are the acceptance in the P10 plan — *"构造一个 Failed 的 AsyncApexJob
 * （如抛异常的 batch 测试类）确认 ASYNC_FAILURES 命中"* — and step 5 is what keeps a measurement from being a
 * change: the class is the only part of this leg the org would keep, and the platform offers no delete for
 * the `AsyncApexJob` row itself, so that row outlives the run by design and is named as such in the evidence.
 *
 * **Sandbox only.** This is the milestone's one writing leg, and ADR-0029's sandbox-only rule is the same one
 * T2's and T3's constructing legs answer to: on anything the platform does not call a sandbox, nothing is
 * compiled, nothing is run, and the leg reports `NOT TESTED` naming the ban.
 */
async function runConstructedFailureLeg(
  connection: Connection,
  diagnostics: DiagnosticsCall,
  org: P10LiveOrgFacts,
): Promise<P10LiveGate> {
  if (org.isSandbox !== true) {
    return notTested(
      'The constructed-failure leg compiles an Apex class onto the org, and ADR-0029\'s sandbox-only rule forbids '
        + 'that anywhere the platform does not call a sandbox: nothing was compiled, nothing was run, and the org was '
        + 'not written to. The failure section was still measured, in full, against the rows this org does hold.',
      Object.freeze({ state: 'REFUSED', sandbox: org.isSandbox, fixtureClassName: FIXTURE_APEX_CLASS_NAME }),
    );
  }
  const tooling = connection.tooling as unknown as ToolingFixtureApi;
  const establishment = await establishFixtureClass(tooling);
  if (establishment.classId === null) {
    return failGate(
      'The Apex class this leg compiles onto the sandbox could not be established, so no `Failed` '
        + '`AsyncApexJob` was constructed and the failure section was not observed in its ordinary state.',
      Object.freeze({ state: establishment.state, sandbox: org.isSandbox, ...establishment.detail }),
    );
  }
  // The observation is wrapped rather than left to escape: a Salesforce refusal in the middle of it still
  // owes the org the cleanup below, and a harness that dies holding the class it compiled has left the
  // sandbox worse than it found it.
  let observation: FailureObservation;
  try {
    observation = await observeConstructedFailure(connection, diagnostics, establishment.classId);
  } catch (error) {
    observation = Object.freeze({
      problems: Object.freeze([
        `The observation itself was refused with ${salesforceErrorCodeOf(error) ?? 'no Salesforce error code'}.`,
      ]),
      detail: Object.freeze({
        salesforceErrorCode: salesforceErrorCodeOf(error),
        salesforceMessage: salesforceMessageOf(error),
      }),
    });
  }
  const cleanup = await removeFixtureClass(tooling, establishment.classId);
  return gate(
    observation.problems.length === 0 && cleanup.ok === true,
    Object.freeze({
      state: establishment.state,
      sandbox: org.isSandbox,
      fixtureClassName: FIXTURE_APEX_CLASS_NAME,
      establishment: establishment.detail,
      ...observation.detail,
      cleanup,
      problems: observation.problems,
    }),
    observation.problems.length > 0
      ? `The constructed failure was not observed through the Tool: ${observation.problems.join(' ')}`
      : 'The Apex class this leg compiled onto the sandbox was not deleted again, or its deletion was not '
        + 'confirmed, so the run would have left the org holding metadata it created.',
  );
}

/**
 * The fixture class, adopted if a previous run left one behind and created if not.
 *
 * The lookup is resilient on purpose: a failed *lookup* is recorded and the create is still attempted, because
 * the two failures have different causes and only the second one is fatal. The create is not resilient — a
 * class that did not compile is a leg that cannot measure anything, and it is reported as `FAILED` with the
 * platform's own words rather than retried.
 */
async function establishFixtureClass(tooling: ToolingFixtureApi): Promise<FixtureEstablishment> {
  const lookupStatement = `SELECT Id, Name, Status FROM ApexClass WHERE Name = ${soqlLiteral(FIXTURE_APEX_CLASS_NAME)}`;
  let lookupErrorCode: string | null = null;
  let lookupErrorMessage: string | null = null;
  try {
    const payload = await tooling.query(lookupStatement) as unknown as Readonly<{ records?: unknown }>;
    const existing = readRecords(payload.records)[0];
    const classId = existing === undefined ? null : stringOrNull(existing.Id) ?? stringOrNull(existing.id);
    if (classId !== null) {
      return Object.freeze({
        state: 'ALREADY',
        classId,
        detail: Object.freeze({
          lookupStatement,
          // A class of this name with no prior run to own it would be somebody's own Apex, and this leg would
          // be about to delete it. Nothing else in the org can carry this name, and the name is this harness's,
          // but the status is recorded so a reader can see what was adopted rather than only that something was.
          adoptedClassStatus: existing === undefined ? null : stringOrNull(existing.Status),
          note: 'A class of this name already existed — the leftover of a run that did not reach its cleanup — and '
            + 'this run adopted it instead of colliding with it. It is deleted at the end of this leg either way.',
        }),
      });
    }
  } catch (error) {
    lookupErrorCode = salesforceErrorCodeOf(error);
    lookupErrorMessage = salesforceMessageOf(error);
  }
  try {
    const created = await tooling.sobject('ApexClass').create({
      Name: FIXTURE_APEX_CLASS_NAME,
      Body: FIXTURE_APEX_BODY,
    });
    const classId = createdRecordId(created);
    if (classId === null) {
      return Object.freeze({
        state: 'FAILED',
        classId: null,
        detail: Object.freeze({
          lookupStatement,
          lookupErrorCode,
          lookupErrorMessage,
          createUnconfirmed: true,
          createErrors: createErrorsOf(created),
        }),
      });
    }
    return Object.freeze({
      state: 'CONSTRUCTED',
      classId,
      detail: Object.freeze({
        lookupStatement,
        lookupErrorCode,
        lookupErrorMessage,
        bodyLines: FIXTURE_APEX_BODY.split('\n').length,
      }),
    });
  } catch (error) {
    return Object.freeze({
      state: 'FAILED',
      classId: null,
      detail: Object.freeze({
        lookupStatement,
        lookupErrorCode,
        lookupErrorMessage,
        salesforceErrorCode: salesforceErrorCodeOf(error),
        salesforceMessage: salesforceMessageOf(error),
      }),
    });
  }
}

/**
 * Submitting the fixture, waiting for the platform's verdict, and finding that verdict through the Tool.
 *
 * Nothing here throws for a Salesforce *refusal* — each step records a problem and the leg reports `FAIL`,
 * which is the difference between "the org said no" (a finding, and this file's subject) and "the harness
 * crashed" (an accident). What does escape is anything outside that contract; the caller wraps it.
 */
async function observeConstructedFailure(
  connection: Connection,
  diagnostics: DiagnosticsCall,
  classId: string,
): Promise<FailureObservation> {
  const problems: string[] = [];
  const run = recordOf(await (connection.tooling as unknown as ToolingFixtureApi)
    .executeAnonymous(FIXTURE_APEX_EXECUTION));
  const compiled = run?.compiled === true;
  const submitted = run?.success === true;
  if (!compiled || !submitted) {
    // The platform's `exceptionMessage` is deliberately not recorded: a compile error quotes the source it
    // was handed, and that source is this file's — so the verdicts and the message's length are recorded and
    // the text is not. The same rule T2's anonymous-Apex runner follows.
    problems.push(`The anonymous-Apex submission did not run (compiled=${compiled}, success=${submitted}).`);
  }
  const pollStatement = 'SELECT Id, Status, JobType, NumberOfErrors, ExtendedStatus, CreatedDate FROM '
    + `AsyncApexJob WHERE ApexClassId = ${soqlLiteral(classId)} ORDER BY CreatedDate DESC LIMIT 5`;
  let job: Record<string, unknown> | undefined;
  let lastObservedStatus: string = 'NOT_YET_VISIBLE';
  for (let attempt = 0; attempt < FIXTURE_POLL_ATTEMPTS; attempt += 1) {
    const payload = await connection.query(pollStatement) as unknown as Readonly<{ records?: unknown }>;
    const rows = readRecords(payload.records);
    job = rows.find((row) => {
      const status = stringOrNull(row.Status);
      return status !== null && TERMINAL_JOB_STATUSES.includes(status as typeof TERMINAL_JOB_STATUSES[number]);
    });
    if (job !== undefined) break;
    const newest = rows[0];
    lastObservedStatus = newest === undefined ? 'NOT_YET_VISIBLE' : stringOrNull(newest.Status) ?? 'UNKNOWN';
    await sleep(FIXTURE_POLL_INTERVAL_MS);
  }
  const jobId = job === undefined ? null : stringOrNull(job.Id);
  const jobStatus = job === undefined ? null : stringOrNull(job.Status);
  const jobCreatedDate = job === undefined ? null : stringOrNull(job.CreatedDate);
  if (jobId === null || jobStatus === null) {
    problems.push(
      `No terminal \`AsyncApexJob\` row appeared for the fixture class within `
        + `${(FIXTURE_POLL_ATTEMPTS * FIXTURE_POLL_INTERVAL_MS) / 1000}s (last status seen: ${lastObservedStatus}).`,
    );
    return Object.freeze({
      problems: Object.freeze(problems),
      detail: Object.freeze({
        submitted,
        compiled,
        lastObservedStatus,
        pollAttempts: FIXTURE_POLL_ATTEMPTS,
        pollStatement,
      }),
    });
  }
  if (jobStatus !== 'Failed') {
    // One finding, not the cascade that follows from it. A job the platform did not mark `Failed` is outside
    // the section's own filter, so asking the Tool for it would produce three more problems that all restate
    // this one — and the section's behaviour on a window it matches nothing in is already measured in full by
    // `asyncFailureFidelity` and `emptySourceClarity` above.
    problems.push(
      `The constructed job reached \`${jobStatus}\` rather than \`Failed\`, so it is outside the section's own `
        + 'status filter and the Tool was not asked for it. `Completed` with a non-zero error count is the '
        + 'platform containing a chunk\'s failure rather than failing the job.',
    );
    return Object.freeze({
      problems: Object.freeze(problems),
      detail: Object.freeze({
        submitted,
        compiled,
        pollAttempts: FIXTURE_POLL_ATTEMPTS,
        pollStatement,
        jobId,
        jobStatus,
        jobCreatedDate,
        jobNumberOfErrors: job === undefined ? null : asNumber(job.NumberOfErrors),
        toolCallSkipped: 'The job is not a `Failed`/`Aborted` row, so the failure section could not contain it '
          + 'and the Tool was not called.',
      }),
    });
  }
  // The observation, on the Tool's own terms: a one-hour window, only the section under test. A window that
  // cannot contain the job would make the entry's absence mean nothing, so the assertion below is that the
  // entry for *this* job id is present, not merely that the section holds something.
  const observedCall = await diagnostics({ sections: ['ASYNC_FAILURES'], windowHours: 1 });
  const output = observedCall.output;
  const section = sectionOf(output, 'ASYNC_FAILURES');
  const entries = entriesOf(section);
  const entry = entries.find((candidate) => stringOrNull(candidate.id) === jobId);
  const timeline = readRecords(recordOf(output?.alignment)?.timeline);
  const timelineEntry = timeline.find((line) => stringOrNull(line.entryId) === jobId
    && stringOrNull(line.section) === 'ASYNC_FAILURES');
  if (observedCall.result.isError === true) problems.push('The Tool call returned an error result.');
  if (section?.status !== 'READ') {
    problems.push(`The failure section reported \`${stringOrNull(section?.status) ?? 'nothing'}\` rather than \`READ\`.`);
  }
  if (entry === undefined) {
    problems.push('The failure section did not carry the constructed job\'s own row.');
  } else {
    if (stringOrNull(entry.status) !== jobStatus) {
      problems.push(`The entry reported status \`${stringOrNull(entry.status) ?? 'null'}\` where the org holds \`${jobStatus}\`.`);
    }
    if (stringOrNull(entry.apexClass) !== FIXTURE_APEX_CLASS_NAME) {
      problems.push(`The entry named class \`${stringOrNull(entry.apexClass) ?? 'null'}\` rather than the fixture's.`);
    }
    if (millisOf(stringOrNull(entry.occurredAt)) !== millisOf(jobCreatedDate)) {
      problems.push('The entry\'s timestamp is not the `CreatedDate` the org holds for that job.');
    }
    if (!((asNumber(entry.numberOfErrors) ?? 0) >= 1)) {
      problems.push('The entry reported no error count for a job the platform failed.');
    }
  }
  if (timelineEntry === undefined) {
    problems.push('The merged timeline did not carry the constructed entry.');
  }
  const totalCount = asNumber(section?.totalCount);
  if (totalCount === null || totalCount < 1) {
    problems.push('The failure section counted the window as empty while it held the constructed row.');
  }
  return Object.freeze({
    problems: Object.freeze(problems),
    detail: Object.freeze({
      submitted,
      compiled,
      pollAttempts: FIXTURE_POLL_ATTEMPTS,
      pollStatement,
      jobId,
      jobStatus,
      jobCreatedDate,
      jobNumberOfErrors: job === undefined ? null : asNumber(job.NumberOfErrors),
      // The platform's own words about why it failed, which is what a reader would see in Setup. Bounded and
      // id-masked by the clip: it is org-authored text rather than this harness's own sentence.
      jobExtendedStatus: job === undefined || stringOrNull(job.ExtendedStatus) === null
        ? null
        : maskIdsInText(String(job.ExtendedStatus)).slice(0, 300),
      toolEntryFound: entry !== undefined,
      toolSectionStatus: stringOrNull(section?.status),
      toolSectionTotalCount: totalCount,
      timelineCarriesIt: timelineEntry !== undefined,
      timelineEntrySummary: timelineEntry === undefined ? null : stringOrNull(timelineEntry.summary),
      windowAsked: 1,
      sectionsAsked: Object.freeze(['ASYNC_FAILURES']),
    }),
  });
}

/** Deleting the fixture class, and saying plainly whether the delete happened. */
async function removeFixtureClass(
  tooling: ToolingFixtureApi,
  classId: string,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    const result = await tooling.sobject('ApexClass').destroy(classId);
    const ok = destroySucceeded(result);
    return Object.freeze({
      attempted: true,
      ok,
      salesforceErrorCode: ok ? null : 'DELETE_NOT_CONFIRMED',
      salesforceMessage: ok ? null : createErrorsOf(result),
    });
  } catch (error) {
    return Object.freeze({
      attempted: true,
      ok: false,
      salesforceErrorCode: salesforceErrorCodeOf(error),
      salesforceMessage: salesforceMessageOf(error),
    });
  }
}

/** jsforce answers a single-record create with one result object and a bulk one with an array. */
function createdRecordId(value: unknown): string | null {
  const single = recordOf(value);
  if (single !== undefined) return stringOrNull(single.id) ?? stringOrNull(single.Id);
  const first = readRecords(value)[0];
  return first === undefined ? null : stringOrNull(first.id) ?? stringOrNull(first.Id);
}

/** The platform's own words about a refused write, masked and bounded, as one line. */
function createErrorsOf(value: unknown): string | null {
  const single = recordOf(value) ?? readRecords(value)[0];
  if (single === undefined) return null;
  const errors = readRecords(single.errors);
  const text = errors
    .map((entry) => [stringOrNull(entry.statusCode), stringOrNull(entry.message)]
      .filter((part): part is string => part !== null)
      .join(': '))
    .filter((line) => line.length > 0)
    .join('; ');
  return text.length === 0 ? null : maskIdsInText(text).slice(0, 300);
}

/** A write is confirmed only when every result the platform returned says so. A silent `{}` is not a yes. */
function destroySucceeded(value: unknown): boolean {
  const single = recordOf(value);
  if (single !== undefined) return single.success === true;
  const results = readRecords(value);
  return results.length > 0 && results.every((entry) => entry.success === true);
}

/**
 * The wire claim: inside each Tool call's own window, this Tool read only the three whitelisted objects.
 *
 * ADR-0029 §4a's reason for the whitelist is that the org enforces nothing here — the DIAGNOSTIC identity can
 * read any standard object through this API, measured on 955 `Lead` rows. So "which objects did it name" is not
 * a style question: it is the entire boundary, and the wire is where it is visible.
 */
function runSurface(windows: readonly RecordWindow[]): P10LiveGate {
  const targets = windows.flatMap((window) => window.statements.map((statement) => Object.freeze({
    arguments: window.arguments,
    target: /\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/u.exec(statement)?.[1] ?? null,
  })));
  const offWhitelist = targets.filter((entry) => entry.target === null
    || !PLATFORM_STATUS_OBJECTS.includes(entry.target as typeof PLATFORM_STATUS_OBJECTS[number]));
  const dml = windows.flatMap((window) => window.statements.filter((statement) => DML_PATTERN.test(statement)));
  const windowed = windows.flatMap((window) => window.statements.filter((statement) => /CreatedDate >=/u.test(statement)));
  const quoted = windowed.filter((statement) => /CreatedDate >= '/u.test(statement));
  const countedWithId = windows.flatMap((window) =>
    window.statements.filter((statement) => /COUNT\(Id\) FROM SetupAuditTrail/u.test(statement)));
  return gate(
    windows.length > 0
      && targets.length > 0
      && offWhitelist.length === 0
      && dml.length === 0
      && windowed.length > 0
      && quoted.length === 0
      && countedWithId.length === 0,
    Object.freeze({
      toolWindows: windows.length,
      statements: targets.length,
      whitelist: PLATFORM_STATUS_OBJECTS,
      distinctTargets: [...new Set(targets.map((entry) => entry.target))].sort(),
      offWhitelist: offWhitelist.slice(0, 5),
      dml: dml.slice(0, 3),
      windowedStatements: windowed.length,
      quotedDateTimeLiterals: quoted.map((statement) => statement.slice(0, 120)).slice(0, 3),
      countIdOnSetupAuditTrail: countedWithId.map((statement) => statement.slice(0, 120)).slice(0, 3),
    }),
    'A statement inside a Tool call read something outside the whitelist, issued a write, or spelled the window '
    + 'as a quoted dateTime literal — which the platform refuses as a string literal, not as a time.',
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * A refusal of the harness's own read is a finding about the measurement, and it never reads as clean.
 *
 * It is `FAIL` rather than `NOT TESTED` on purpose: a comparison that could not run must not sit beside a
 * comparison that passed and look the same. The detail separates the two — the Salesforce code is recorded so a
 * reader can tell "this identity cannot read that object" from "this harness sent a bad query" — but the run's
 * overall verdict is not allowed to be green while a claim went unmeasured for a reason the run caused.
 */
function failIndependently(
  independent: Readonly<{ errorCode: string | null; statement: string }>,
  label: string,
): P10LiveGate {
  return Object.freeze({
    status: 'FAIL' as const,
    detail: Object.freeze({
      failureReason: `The harness's own ${label} was refused, so the Tool's answer could not be compared against `
        + 'the org. This is a failure of the measurement rather than of the Tool, and it is reported as a failure '
        + 'rather than as an untested leg because a comparison that could not run must not read as one that passed.',
      salesforceErrorCode: independent.errorCode,
      statement: independent.statement.slice(0, 300),
    }),
  });
}
