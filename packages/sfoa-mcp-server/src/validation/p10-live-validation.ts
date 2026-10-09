import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AGENT_RECOGNIZED_TOOL_NAMES, DIAGNOSTICS_TOOL_NAMES } from '@sfoa/agent-playbook';
import {
  JwtConnectionFactory,
  JsonLineRuntimeLogger,
  createIdentityRuntime,
  type RequestScope,
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
  P10_T2_TOOL_INPUT_KEYS,
  P10_T2_TOOL_NAMES,
  runP10T2LiveMilestone,
  type P10T2LiveReport,
} from './p10-t2-live-milestone.js';
import {
  P10_T3_TOOL_NAMES,
  runP10T3LiveMilestone,
  type P10T3LiveReport,
} from './p10-t3-live-milestone.js';
import {
  P10_T4_TOOL_NAMES,
  runP10T4LiveMilestone,
  type P10T4LiveReport,
} from './p10-t4-live-milestone.js';
import {
  P10_T5_TOOL_INPUT_KEYS,
  P10_T5_TOOL_NAMES,
  runP10T5LiveMilestone,
  type P10T5LiveReport,
} from './p10-t5-live-milestone.js';
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
  maskIdsInText,
  maskUsernamesInText,
  measuredSalesforceUsernames,
  notTested,
  outputOf,
  readAccessToken,
  readOrgFacts,
  recordOf,
  resolveMilestonePlatformUser,
  runAuditPersistence,
  runCredentialSafety,
  runToolInventory,
  sameArray,
  stringOrNull,
  toolFailureDetail,
  type P10LiveGate,
  type P10LiveOrgFacts,
} from './p10-live-support.js';

/**
 * The P10 live validation: what the phase is closed on, rather than what any one Tool of it claimed.
 *
 * The six diagnostic Tools each shipped with their own milestone and their own live harness, and this file
 * deliberately re-measures none of them. It composes the four milestone runners in one process, in the order
 * the phase planned them, and then measures the three claims that belong to the phase as a whole:
 *
 * 1. **Every Tool reached the audit trail.** The evidence is a numeric watermark — `MAX(id)` taken before
 *    anything runs, then a per-Tool row count above it — rather than a time window, because the audit host's
 *    clock is not the application's and a window would make the gate's own arithmetic a second thing to
 *    verify. Which Tools are *required* to have left a row is derived from each milestone's own report
 *    (`the write leg ran`, `the list leg ran`) rather than asserted for all six, so a Tool whose leg was
 *    legitimately not measured is not reported as a Tool that failed to audit.
 *
 * 2. **No credential shape is in that trail.** The scan is a set of SQL `LIKE` counts over the four columns
 *    a credential could sit in, using exactly the value shapes `audit-sanitization.ts` is required to strip.
 *    It counts rather than reads: no scanned column is ever pulled into this process or into the report, so a
 *    hit is reported as `pattern × column` and a number, never as the text that matched. Key *names* are not
 *    scanned — `refresh_token` survives sanitization by design, since it is the value beside it that is
 *    replaced — because a pattern that matches a correctly sanitized row is a pattern that reports defects
 *    that are not there.
 *
 * 3. **A partial enablement stays partial.** The Console enables these Tools one at a time, so the harness
 *    runs one session with exactly three of the six (plus whatever the route already enables) and checks the
 *    two halves of the cross-Tool hint rule: a hint may not name a Tool `tools/list` does not advertise, and
 *    the hint pipeline must still be demonstrably live — the positive control requires the
 *    `get_platform_diagnostics` hint to name the advertised `get_apex_logs`, so the absences this session
 *    observes cannot be satisfied by a hint builder that simply said nothing.
 *
 * The audit flush barrier P9 had to fix is repeated here in the same order — `client.close()`, then
 * `server.close()`, then assert the drain, then flush — because a run whose own trail is incomplete cannot
 * report a clean `overall`, and the failure mode it prevents (`MCP_AUDIT_PIPELINE_CLOSED`) loses exactly the
 * evidence this file exists to collect.
 */

/**
 * The six Tools P10 delivered. `get_metadata_component_context` is deliberately not among them: it predates
 * the phase and is only in T4's Toolset because the metadata pair is meaningless measured alone.
 */
export const P10_LIVE_TOOL_NAMES = Object.freeze([
  ...P10_T2_TOOL_NAMES,
  ...P10_T3_TOOL_NAMES,
  ...P10_T4_TOOL_NAMES.filter((name) => name !== 'get_metadata_component_context'),
  ...P10_T5_TOOL_NAMES,
]);

/**
 * The three Tools the partial-enablement session enables, chosen so the session can observe both halves of
 * the hint rule at once: `set_trace_flag` and `get_apex_logs` pull in the debug-log toolset, whose list hint
 * names `get_debug_log_body` only when it is advertised — and it is not, here — while
 * `get_platform_diagnostics` is the positive control, because its hint names `get_apex_logs` when that Tool
 * is advertised and it is.
 */
export const P10_PARTIAL_ENABLEMENT_TOOL_NAMES = Object.freeze([
  'set_trace_flag',
  'get_apex_logs',
  'get_platform_diagnostics',
]);

/**
 * The one Tool that is not a P10 Tool and is still granted to this session: the Playbook's DIAGNOSTICS status
 * line is a cross-Tool surface too, and it can only be read from a session that advertises the guidance Tool.
 *
 * It is named separately from the trio rather than folded into it, because the claim under test is about the
 * three *diagnostic* Tools and a reader has to be able to see that the fourth grant is a guidance Tool outside
 * the six. The grant is a union, so a route that already enables it is unaffected.
 */
const P10_PARTIAL_ENABLEMENT_GUIDANCE_TOOL = 'get_agent_playbook';

/** The input keys the three partial-enablement Tools advertise, as their own contracts declare them. */
const PARTIAL_ENABLEMENT_INPUT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  set_trace_flag: P10_T2_TOOL_INPUT_KEYS.set_trace_flag ?? [],
  get_apex_logs: P10_T2_TOOL_INPUT_KEYS.get_apex_logs ?? [],
  get_platform_diagnostics: P10_T5_TOOL_INPUT_KEYS.get_platform_diagnostics ?? [],
});

/** The one partial-enablement Tool that writes, and therefore the one that must not claim `readOnlyHint`. */
const PARTIAL_ENABLEMENT_WRITE_TOOLS = Object.freeze(['set_trace_flag']);

/**
 * The sentence `apexLogsHint` degrades to when `get_debug_log_body` is not advertised.
 *
 * Asserted verbatim rather than by substring of a longer phrase: the branch exists so an Agent is told the
 * body is fetched separately *without* being handed a Tool name its own `tools/list` does not carry, and a
 * reworded sentence that happens to still avoid the name is a different branch than the one measured here.
 */
const BODYLESS_LOG_HINT = 'The log body is fetched separately, by log id.';

/**
 * The four value shapes `audit-sanitization.ts` is required to remove, as `LIKE` patterns.
 *
 * Each is a *value* witness rather than a key witness. The sanitizer replaces the value under a secret-shaped
 * key and keeps the key, so a pattern matching `refresh_token` would match a correctly sanitized row; these
 * four cannot, because the sanitizer leaves `[REDACTED]` where the shape was. Three details make each pattern
 * broader than the literal it spells, and none of them narrower: MySQL's default collation is case-insensitive,
 * `_` inside a `LIKE` matches any single character (so `sfoa_ub1_` also covers `sfoa_ub1X`), and `%` at both
 * ends admits the shape anywhere in the text. `%eyJ%.eyJ%` requires a JWT header segment *and* a payload
 * segment, because base64 of `{"` is a common coincidence in any JSON-encoded blob and two dot-separated
 * segments is not.
 */
const AUDIT_CREDENTIAL_PATTERNS = Object.freeze([
  Object.freeze({ id: 'bearer-scheme', like: '%Bearer %', note: 'an Authorization header value' }),
  Object.freeze({ id: 'jwt-shape', like: '%eyJ%.eyJ%', note: 'a JWT with header and payload segments' }),
  Object.freeze({ id: 'user-bound-token', like: '%sfoa_ub1_%', note: 'a user-bound MCP token' }),
  Object.freeze({ id: 'private-key-block', like: '%PRIVATE KEY%', note: 'a PEM private key marker' }),
]);

/** The four columns a credential could sit in, across the two tables that store audit text. */
const AUDIT_LOG_TEXT_COLUMNS = Object.freeze([
  'request_summary_json',
  'response_summary_json',
  'error_message_safe',
] as const);

const P10_ENABLEMENT_SOURCE = 'in-process additive snapshot: the P10 Tools are enabled for this run only and '
  + 'the Control Plane holds no grant for them, so a green run here is not a statement about any route\'s '
  + 'configuration';

/** A recognized Tool's absence from a hint, or its presence, as the two gates below read it. */
type HintReading = Readonly<{ tool: string; text: string }>;

type AuditExpectation = Readonly<{
  tool: string;
  expected: boolean;
  basis: string;
}>;

type CredentialScanReading = Readonly<{
  pattern: string;
  column: string;
  surface: 'AUDIT_LOG' | 'PAYLOAD_EVIDENCE';
  runScoped: number;
  allTime: number;
}>;

/** One milestone's outcome: the report it produced, and the gate this file derives from it. */
type P10MilestoneOutcome<T> = Readonly<{
  report: T | null;
  error: string | null;
  gate: P10LiveGate;
}>;

type PartialSectionGates = Readonly<{
  /**
   * Whether the session reached its own verdicts at all.
   *
   * A thrown session is neither a refutation nor a skip, and the gates below are each a claim about something
   * that was measured — so the throw is reported here, in one place, and the phase verdict consumes it. The
   * alternative, marking every unmeasured gate `FAIL`, would say four Tools misbehaved when one exception
   * interrupted the run that was going to measure them.
   */
  sessionCompleted: P10LiveGate;
  toolInventory: P10LiveGate;
  disabledToolsAbsent: P10LiveGate;
  hintGating: P10LiveGate;
  degradedBranch: P10LiveGate;
  positiveControl: P10LiveGate;
  playbookStatusLine: P10LiveGate;
  credentialSafety: P10LiveGate;
  auditPersistence: P10LiveGate;
}>;

type PartialSectionResult = Readonly<{
  org: P10LiveOrgFacts | null;
  /** The three P10 Tools the session turned on: the claim "only part of the diagnostic surface is enabled". */
  requestedTools: readonly string[];
  /** The non-P10 Tool granted alongside them so the Playbook status line can be read. */
  guidanceToolEnabled: string;
  /** Everything the session asked the policy source to enable, the route's own grant included. */
  grantedForThisSession: readonly string[];
  routeEnabledTools: readonly string[];
  routePreEnabledDiagnosticsTools: readonly string[];
  advertised: readonly string[];
  calls: readonly Readonly<Record<string, unknown>>[];
  callsAttempted: readonly string[];
  hints: readonly HintReading[];
  gates: PartialSectionGates;
}>;

/** The org-facts and identity facts the run was driven on, reported in every path including a refusal. */
type DiagnosticIdentityReading = Readonly<{
  configured: boolean;
  enabled: boolean | null;
  verificationStatus: string | null;
  salesforceUsernameMasked: string | null;
}>;

/** One source's Connection count, so the phase aggregate can be read back to whoever opened them. */
type ConnectionTally = Readonly<{ total: number; distinctSalesforceUsernames: readonly string[] }>;

export type P10LiveValidationReport = Readonly<{
  phase: 'P10';
  task: 'T2+T3+T4+T5+T6';
  generatedAt: string;
  platformUserIdMasked: string;
  enablementSource: string;
  /**
   * The Diagnostic identity the whole run was driven on. It is in the report rather than only in the
   * milestone reports because it is the prerequisite every Tool of the phase shares: a run that refused to
   * start is a statement about this row, and a reader has to be able to see which row it was.
   */
  diagnosticIdentity: DiagnosticIdentityReading;
  /**
   * Where the audit gate's window started. `MAX(id)` at the moment before the first Tool call rather than a
   * timestamp, so the gate does not depend on which clock wrote the rows.
   */
  auditWindow: Readonly<{ watermark: string; platformUserIdMasked: string; toolNames: readonly string[] }>;
  milestones: Readonly<{
    t2: P10MilestoneOutcome<P10T2LiveReport>;
    t3: P10MilestoneOutcome<P10T3LiveReport>;
    t4: P10MilestoneOutcome<P10T4LiveReport>;
    t5: P10MilestoneOutcome<P10T5LiveReport>;
  }>;
  partialEnablement: PartialSectionResult;
  auditCoverage: P10LiveGate;
  auditCredentialScan: P10LiveGate;
  /**
   * The partial session's own credential check. Each milestone holds its own inside its report, and each
   * milestone's `overall` already folds it in, so this field is the fifth check rather than the only one.
   */
  credentialSafety: P10LiveGate;
  /**
   * Every Salesforce Connection this acceptance run opened, as masked usernames, split by the source that
   * opened it. Each milestone owns a Connection factory of its own, so a phase-level list is only complete if
   * it is assembled from the five reports rather than measured once here — and the whole value of the list is
   * that it can be read as "no Tool answered from an identity this run did not open".
   */
  connections: Readonly<{
    total: number;
    distinctSalesforceUsernames: readonly string[];
    bySource: Readonly<Record<'t2' | 't3' | 't4' | 't5' | 'partialEnablement', ConnectionTally | null>>;
  }>;
  /** The partial session's drain-and-flush assertion; the milestones each assert their own inside their reports. */
  auditPersistence: P10LiveGate;
  overall: 'PASS' | 'PARTIAL' | 'FAIL';
}>;

export async function runP10LiveValidation(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<P10LiveValidationReport> {
  const config = await loadRemoteRuntimeConfig(projectRoot, environment);
  const controlPlane = config.controlPlane;
  if (controlPlane.mode !== 'mysql') {
    throw new Error('The P10 live validation requires the MySQL Control Plane: the DIAGNOSTIC identity, the identity routes and the audit trail are read from it.');
  }
  const databaseConfig = controlPlane.database;
  if (!databaseConfig) throw new Error('The P10 live validation requires the MySQL Control Plane database configuration.');
  if (!config.clientToken) throw new Error('The P10 live validation requires an independent internal client token.');
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

    // The same precondition every milestone checks, and for the same reason: the runtime refuses *every*
    // request when a diagnostic Tool is enabled without an enabled, verification-passed Diagnostic identity,
    // so running the milestones against such a Control Plane would produce four reports that describe the
    // prerequisite rather than the Tools. The refusal is reported once, at the top, with every gate below it
    // marked NOT TESTED.
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
      const reason = `The P10 Tools cannot be enabled because ${missing}. The runtime refuses every request when a `
        + 'diagnostic Tool is enabled without an enabled, verification-passed Diagnostic identity, so the validation '
        + 'was not attempted: configure and verify the Diagnostic identity through the Admin Control Plane, then '
        + 're-run.';
      const auditPersistence = runAuditPersistence(await flushAuditTrail(auditPipeline), null);
      return refusalReport(generatedAt, platformUserId, diagnosticIdentity, reason, auditPersistence);
    }

    // 1. The window opens before the first Tool call and nothing between here and the counting below writes a
    //    row for one of the six Tools, which is what makes `id > watermark` the whole attribution rule.
    const watermark = await readAuditWatermark(auditDatabase);

    // 2. The four milestones, in the order the phase planned them, sequentially: each starts its own server and
    //    its own pools, drives its own legs, and flushes its own trail before returning. Running them one after
    //    another rather than in parallel is deliberate — every one of them enables its Tools in-process on a
    //    shared Control Plane, and two of them measuring the same org at once would put their writes into each
    //    other's windows (`T5`'s constructed failure compiles Apex, `T2`'s logs are read from a window that
    //    would then hold it).
    const t2 = await runMilestone('T2', () => runP10T2LiveMilestone(projectRoot, environment));
    const t3 = await runMilestone('T3', () => runP10T3LiveMilestone(projectRoot, environment));
    const t4 = await runMilestone('T4', () => runP10T4LiveMilestone(projectRoot, environment));
    const t5 = await runMilestone('T5', () => runP10T5LiveMilestone(projectRoot, environment));

    const partial = await runPartialEnablementSection({
      projectRoot,
      environment,
      config,
      clientToken,
      platformUserId,
      snapshotEnabledTools: snapshot.enabledTools,
      diagnosticRoute,
      identityRuntime,
      policySnapshotSource,
      store,
      database,
      auditPipeline,
      measuringFactory,
    });

    // 3. The phase's own gates, measured after every writer above has flushed.
    const auditCoverage = await runAuditCoverage(auditDatabase, {
      watermark,
      platformUserId,
      expectations: auditExpectations({ t2, t3, t4, t5, partial }),
    });
    const auditCredentialScan = await runAuditCredentialScan(auditDatabase, watermark);

    const partialConnections: ConnectionTally = Object.freeze({
      total: measuringFactory.measurements.length,
      distinctSalesforceUsernames: measuredSalesforceUsernames(measuringFactory),
    });
    const connectionsBySource = Object.freeze({
      t2: t2.report?.connections ?? null,
      t3: t3.report?.connections ?? null,
      t4: t4.report?.connections ?? null,
      t5: t5.report?.connections ?? null,
      partialEnablement: partialConnections,
    });

    return Object.freeze({
      phase: 'P10',
      task: 'T2+T3+T4+T5+T6',
      generatedAt,
      platformUserIdMasked: maskIdentifier(platformUserId),
      enablementSource: P10_ENABLEMENT_SOURCE,
      diagnosticIdentity,
      auditWindow: Object.freeze({
        watermark,
        platformUserIdMasked: maskIdentifier(platformUserId),
        toolNames: P10_LIVE_TOOL_NAMES,
      }),
      milestones: Object.freeze({ t2, t3, t4, t5 }),
      partialEnablement: partial,
      auditCoverage,
      auditCredentialScan,
      credentialSafety: partial.gates.credentialSafety,
      connections: Object.freeze({
        total: Object.values(connectionsBySource)
          .reduce((sum, tally) => sum + (tally?.total ?? 0), 0),
        distinctSalesforceUsernames: Object.freeze([...new Set(Object.values(connectionsBySource)
          .flatMap((tally) => tally?.distinctSalesforceUsernames ?? []))].sort()),
        bySource: connectionsBySource,
      }),
      auditPersistence: partial.gates.auditPersistence,
      overall: combine([
        t2.gate, t3.gate, t4.gate, t5.gate,
        partial.gates.sessionCompleted,
        partial.gates.toolInventory,
        partial.gates.disabledToolsAbsent,
        partial.gates.hintGating,
        partial.gates.degradedBranch,
        partial.gates.positiveControl,
        partial.gates.playbookStatusLine,
        auditCoverage,
        auditCredentialScan,
        partial.gates.credentialSafety,
        partial.gates.auditPersistence,
      ]),
    });
  } finally {
    await closeQuietly(store, database, auditDatabase, auditPipeline);
  }
}

function refusalReport(
  generatedAt: string,
  platformUserId: string,
  diagnosticIdentity: DiagnosticIdentityReading,
  reason: string,
  auditPersistence: P10LiveGate,
): P10LiveValidationReport {
  const outcome = notTested(reason);
  const partialGates: PartialSectionGates = Object.freeze({
    sessionCompleted: outcome,
    toolInventory: outcome,
    disabledToolsAbsent: outcome,
    hintGating: notTested(`${reason} No hint was read, so no hint could be scanned for a Tool that is not advertised.`),
    degradedBranch: notTested(reason),
    positiveControl: notTested(reason),
    playbookStatusLine: notTested(reason),
    credentialSafety: notTested('No Tool call was made.'),
    auditPersistence,
  });
  return Object.freeze({
    phase: 'P10',
    task: 'T2+T3+T4+T5+T6',
    generatedAt,
    platformUserIdMasked: maskIdentifier(platformUserId),
    enablementSource: P10_ENABLEMENT_SOURCE,
    diagnosticIdentity,
    auditWindow: Object.freeze({ watermark: '0', platformUserIdMasked: maskIdentifier(platformUserId), toolNames: P10_LIVE_TOOL_NAMES }),
    milestones: Object.freeze({
      t2: Object.freeze({ report: null, error: null, gate: outcome }),
      t3: Object.freeze({ report: null, error: null, gate: outcome }),
      t4: Object.freeze({ report: null, error: null, gate: outcome }),
      t5: Object.freeze({ report: null, error: null, gate: outcome }),
    }),
    partialEnablement: Object.freeze({
      org: null,
      requestedTools: P10_PARTIAL_ENABLEMENT_TOOL_NAMES,
      guidanceToolEnabled: P10_PARTIAL_ENABLEMENT_GUIDANCE_TOOL,
      grantedForThisSession: Object.freeze([
        ...P10_PARTIAL_ENABLEMENT_TOOL_NAMES,
        P10_PARTIAL_ENABLEMENT_GUIDANCE_TOOL,
      ]),
      routeEnabledTools: Object.freeze([]),
      routePreEnabledDiagnosticsTools: Object.freeze([]),
      advertised: Object.freeze([]),
      calls: Object.freeze([]),
      callsAttempted: Object.freeze([]),
      hints: Object.freeze([]),
      gates: partialGates,
    }),
    auditCoverage: notTested(`${reason} No Tool call was audited, so no row was required above the watermark.`, {}),
    auditCredentialScan: notTested('No Tool call was made, so this run put no text into the audit trail to scan.'),
    credentialSafety: partialGates.credentialSafety,
    connections: Object.freeze({
      total: 0,
      distinctSalesforceUsernames: Object.freeze([]),
      bySource: Object.freeze({
        t2: null, t3: null, t4: null, t5: null, partialEnablement: null,
      }),
    }),
    auditPersistence,
    overall: 'PARTIAL',
  });
}

// ---------------------------------------------------------------------------------------------
// Composing the four milestones.
// ---------------------------------------------------------------------------------------------

/**
 * A milestone mapped onto one gate, without re-reading any of its own gates.
 *
 * The three states map exactly: `PASS` is a milestone whose every leg passed, `PARTIAL` is one that measured
 * what it was allowed to and skipped the rest (a sandbox-only write on a production org, or a refusal that
 * diagnosed its own prerequisite), and `FAIL` is one that refuted a claim. Collapsing `PARTIAL` into `FAIL`
 * here would make the phase's own verdict unreadable — the same error the milestone reports exist to avoid.
 *
 * A milestone that throws is the fourth case, and it maps to `FAIL` rather than to a skip. `NOT TESTED` means
 * the run measured a refusal the deployment stated in a form the Tool reported — a production org declining the
 * trace write — and an exception is not that: its cause is unknown until someone reads it, so the run cannot
 * claim it merely skipped. The message travels in the gate detail rather than only on stderr, because this
 * milestone is one of four and a stack trace at the end of a long live run would cost the three that did report.
 */
async function runMilestone<T extends {
  overall: 'PASS' | 'PARTIAL' | 'FAIL';
  mode: string;
}>(
  label: string,
  runner: () => Promise<T>,
): Promise<P10MilestoneOutcome<T>> {
  try {
    const report = await runner();
    const notPassed = Object.entries(report as unknown as Record<string, unknown>)
      .filter(([, value]) => isGate(value) && (value as P10LiveGate).status !== 'PASS')
      .map(([key, value]) => `${key}: ${(value as P10LiveGate).status}`);
    const detail = Object.freeze({ overall: report.overall, mode: report.mode, gatesNotPassed: notPassed });
    if (report.overall === 'PASS') {
      return Object.freeze({ report, error: null, gate: gate(true, detail, '') });
    }
    if (report.overall === 'PARTIAL') {
      return Object.freeze({
        report,
        error: null,
        gate: notTested(
          `The ${label} milestone ran in mode ${report.mode} and did not measure everything it was asked to, which is `
          + 'a statement about what this deployment allowed rather than about the Tools.',
          detail,
        ),
      });
    }
    return Object.freeze({
      report,
      error: null,
      gate: failGate(
        `The ${label} milestone refuted a claim it was able to measure. The failure is in that milestone's own `
        + 'report, gate by gate.',
        detail,
      ),
    });
  } catch (error) {
    const message = maskUsernamesInText(maskIdsInText(error instanceof Error ? error.message : String(error)));
    return Object.freeze({
      report: null,
      error: maskIdsInText(message).slice(0, 1_000),
      gate: failGate(
        `The ${label} milestone threw instead of reporting, so nothing about it was measured. The message is carried `
        + 'here rather than left on stderr.',
        { message: maskIdsInText(message).slice(0, 1_000) },
      ),
    });
  }
}

function isGate(value: unknown): boolean {
  const record = recordOf(value);
  return record !== undefined && typeof record.status === 'string' && record.detail !== undefined;
}

// ---------------------------------------------------------------------------------------------
// The partial-enablement session.
// ---------------------------------------------------------------------------------------------

type PartialSectionContext = Readonly<{
  projectRoot: string;
  environment: NodeJS.ProcessEnv;
  config: Awaited<ReturnType<typeof loadRemoteRuntimeConfig>>;
  clientToken: string;
  platformUserId: string;
  snapshotEnabledTools: readonly string[];
  diagnosticRoute: SalesforceIdentityRoute;
  identityRuntime: ReturnType<typeof createIdentityRuntime>;
  policySnapshotSource: MySqlRuntimePolicySnapshotSource;
  store: MySqlControlPlaneStore;
  database: ControlPlaneDatabaseClient;
  auditPipeline: AsyncAuditPipeline;
  measuringFactory: MeasuringConnectionFactory;
}>;

/**
 * The session that measures what a *partial* enablement looks like from the outside.
 *
 * It is a session of its own rather than a leg of any milestone because the fact under test is not a Tool's
 * output: it is what three Tools being on and three being off does to `tools/list`, to the hints the enabled
 * Tools return, and to the Playbook's own DIAGNOSTICS status line. The route's own enablement is read first
 * and subtracted, because `AdditiveToolPolicySnapshotSource` can only add — a deployment that already enables
 * one of the other three would otherwise be reported as a harness that failed to disable it.
 */
async function runPartialEnablementSection(context: PartialSectionContext): Promise<PartialSectionResult> {
  const { config, clientToken, platformUserId, diagnosticRoute, identityRuntime } = context;
  const results: CallToolResult[] = [];
  const hints: HintReading[] = [];
  const calls: Record<string, unknown>[] = [];
  const callsAttempted: string[] = [];
  const advertisedSet = new Set<string>();
  let advertised: readonly string[] = Object.freeze([]);
  let routePreEnabled: readonly string[] = Object.freeze([]);

  const grantedForThisSession = Object.freeze([
    ...P10_PARTIAL_ENABLEMENT_TOOL_NAMES,
    P10_PARTIAL_ENABLEMENT_GUIDANCE_TOOL,
  ]);
  const routeEnabledTools = Object.freeze([...new Set([
    ...context.snapshotEnabledTools,
    ...grantedForThisSession,
  ])].sort());
  const expectedNames = routeEnabledTools;

  let server: Awaited<ReturnType<typeof startRemoteMcpServer>> | undefined;
  let scaffoldingScope: RequestScope | undefined;
  let toolInventory = notTested('The partial-enablement session did not reach its Tool inventory.');
  let disabledToolsAbsent = notTested('The partial-enablement session did not reach its Tool inventory.');
  let credentialSafety = notTested('The partial-enablement session made no Tool call.');
  let auditPersistence = notTested('The partial-enablement session started no server.');
  let org: P10LiveOrgFacts | null = null;

  try {
    scaffoldingScope = await identityRuntime.scopeFactory.createForRoute(
      { platformUserId, correlationId: `p10-validation-partial-${Date.now()}` },
      diagnosticRoute,
    );
    const scaffolding = await scaffoldingScope.getConnection();
    org = await readOrgFacts(scaffolding);

    await assertAllMigrationsApplied(context.database);
    const attachmentIngress = createAttachmentIngress(config, context.store);
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
      policySnapshotSource: new AdditiveToolPolicySnapshotSource(
        context.policySnapshotSource,
        grantedForThisSession,
      ),
      discoveryPolicySnapshotSource: new MySqlRuntimeDiscoveryPolicySnapshotSource(context.database),
      ...(attachmentIngress === undefined ? {} : { attachmentIngress }),
    });

    const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
      requestInit: {
        headers: {
          authorization: `Bearer ${clientToken}`,
          [config.platformUserHeader]: platformUserId,
        },
      },
    });
    const client = new Client({ name: 'p10-live-validation-partial', version: '0.1.0-p10' });
    await client.connect(transport);
    try {
      const listings = await client.listTools();
      advertised = Object.freeze(listings.tools.map((tool) => tool.name).sort());
      for (const name of advertised) advertisedSet.add(name);
      routePreEnabled = Object.freeze(
        P10_LIVE_TOOL_NAMES
          .filter((name) => context.snapshotEnabledTools.includes(name)
            && !P10_PARTIAL_ENABLEMENT_TOOL_NAMES.includes(name))
          .sort(),
      );

      toolInventory = runToolInventory({
        tools: listings.tools,
        milestoneTools: P10_PARTIAL_ENABLEMENT_TOOL_NAMES,
        expectedNames,
        inputKeys: PARTIAL_ENABLEMENT_INPUT_KEYS,
        writeTools: PARTIAL_ENABLEMENT_WRITE_TOOLS,
      });
      disabledToolsAbsent = runDisabledToolsAbsent({
        advertised,
        routePreEnabledDiagnosticsTools: routePreEnabled,
      });

      // 1. `get_apex_logs` with no arguments at all: the call an Agent actually makes first, and the one whose
      //    hint has to tell it that the body is fetched separately — without naming the Tool that fetches it.
      const logList = await call(client, results, 'get_apex_logs', {});
      callsAttempted.push('get_apex_logs');
      const logOutput = outputOf(logList);
      const logHint = stringOrNull(logOutput?.hint) ?? '';
      hints.push(Object.freeze({ tool: 'get_apex_logs', text: logHint }));
      calls.push(Object.freeze({
        tool: 'get_apex_logs',
        arguments: Object.freeze({}),
        returnedCount: asNumber(logOutput?.returnedCount) ?? null,
        timeWindowMinutes: asNumber(logOutput?.timeWindowMinutes) ?? null,
        failed: logOutput?.ok === false,
        ...(logOutput?.ok === false ? { failure: toolFailureDetail(logOutput) } : {}),
      }));

      // 2. `get_platform_diagnostics` with no arguments: all three sections are requested by default, which is
      //    what makes the `get_apex_logs` sentence in its hint a positive control rather than a coincidence —
      //    that sentence is gated on an ASYNC_FAILURES fact existing, and a default call always produces one.
      const diagnostics = await call(client, results, 'get_platform_diagnostics', {});
      callsAttempted.push('get_platform_diagnostics');
      const diagnosticsOutput = outputOf(diagnostics);
      const diagnosticsHint = stringOrNull(diagnosticsOutput?.hint) ?? '';
      hints.push(Object.freeze({ tool: 'get_platform_diagnostics', text: diagnosticsHint }));
      calls.push(Object.freeze({
        tool: 'get_platform_diagnostics',
        arguments: Object.freeze({}),
        sections: Object.keys(recordOf(diagnosticsOutput?.sections) ?? {}).sort(),
        failed: diagnosticsOutput?.ok === false,
        ...(diagnosticsOutput?.ok === false ? { failure: toolFailureDetail(diagnosticsOutput) } : {}),
      }));

      // 3. The Playbook's own DIAGNOSTICS status line, for the same session. It is the surface an Agent reads
      //    before it chooses a Tool, so a line that named a Tool this session cannot call would misdirect it
      //    before any hint got the chance to.
      const playbookAdvertised = advertisedSet.has('get_agent_playbook');
      let playbookGate = notTested(
        'The session granted get_agent_playbook additively and tools/list still did not advertise it, so the '
        + 'Playbook status line could not be read. The Tool inventory gate carries that as the failure it is.',
      );
      if (playbookAdvertised) {
        const playbook = await call(client, results, 'get_agent_playbook', { workflow: 'DIAGNOSIS' });
        callsAttempted.push('get_agent_playbook');
        const playbookOutput = outputOf(playbook);
        calls.push(Object.freeze({
          tool: 'get_agent_playbook',
          arguments: Object.freeze({ workflow: 'DIAGNOSIS' }),
          failed: playbookOutput?.ok === false,
          ...(playbookOutput?.ok === false ? { failure: toolFailureDetail(playbookOutput) } : {}),
        }));
        playbookGate = runPlaybookStatusLine(playbookOutput, advertisedSet);
      }

      credentialSafety = runCredentialSafety(results, clientToken, await readAccessToken(scaffolding));

      await client.close().catch(() => undefined);
      const shutdown = await server.close().catch(() => undefined);
      auditPersistence = runAuditPersistence(await flushAuditTrail(context.auditPipeline), shutdown);
      server = undefined;

      return Object.freeze({
        org,
        requestedTools: P10_PARTIAL_ENABLEMENT_TOOL_NAMES,
        guidanceToolEnabled: P10_PARTIAL_ENABLEMENT_GUIDANCE_TOOL,
        grantedForThisSession,
        routeEnabledTools,
        routePreEnabledDiagnosticsTools: routePreEnabled,
        advertised,
        calls: Object.freeze(calls),
        callsAttempted: Object.freeze([...callsAttempted]),
        hints: Object.freeze(hints),
        gates: Object.freeze({
          sessionCompleted: gate(true, {}, ''),
          toolInventory,
          disabledToolsAbsent,
          hintGating: runHintGating({ advertised, hints }),
          degradedBranch: runDegradedBranch(hints),
          positiveControl: runPositiveControl({ advertised, hints }),
          playbookStatusLine: playbookGate,
          credentialSafety,
          auditPersistence,
        }),
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch (error) {
    const message = maskUsernamesInText(maskIdsInText(error instanceof Error ? error.message : String(error)));
    const failure = `The partial-enablement session threw instead of measuring: ${message}`;
    // The session did not reach its own barrier, so it runs here — and only when the server actually started,
    // because the initial `NOT TESTED` is the honest reading for a session that never got that far. The client
    // is already closed by the inner `finally`, so this is the same order the success path uses: drain the
    // server, assert the drain, flush the trail. A failed session is the one whose record matters most.
    if (server !== undefined) {
      const shutdown = await server.close().catch(() => undefined);
      auditPersistence = runAuditPersistence(await flushAuditTrail(context.auditPipeline), shutdown);
      server = undefined;
    }
    return Object.freeze({
      org,
      requestedTools: P10_PARTIAL_ENABLEMENT_TOOL_NAMES,
      guidanceToolEnabled: P10_PARTIAL_ENABLEMENT_GUIDANCE_TOOL,
      grantedForThisSession,
      routeEnabledTools,
      routePreEnabledDiagnosticsTools: routePreEnabled,
      advertised,
      calls: Object.freeze(calls),
      callsAttempted: Object.freeze([...callsAttempted]),
      hints: Object.freeze(hints),
      gates: Object.freeze({
        sessionCompleted: failGate(failure, Object.freeze({
          measuredCalls: results.length,
          hintsRead: hints.length,
          advertised: advertised.length,
        })),
        toolInventory,
        disabledToolsAbsent,
        // Guarded rather than computed: with no hint read, the scan would find no offender and report a
        // vacuous PASS for the one claim this session exists to make.
        hintGating: hints.length === 0
          ? notTested(`${failure} No hint was read, so nothing was scanned for a Tool that is not advertised.`)
          : runHintGating({ advertised, hints }),
        degradedBranch: runDegradedBranch(hints),
        positiveControl: runPositiveControl({ advertised, hints }),
        playbookStatusLine: notTested(failure),
        credentialSafety,
        auditPersistence,
      }),
    });
  } finally {
    if (server !== undefined) await server.close().catch(() => undefined);
    if (scaffoldingScope !== undefined) await scaffoldingScope.close().catch(() => undefined);
  }
}

/**
 * The absence half: none of the six P10 Tools that this session does not enable may appear in `tools/list`.
 *
 * Read against the route's own enablement rather than against the trio alone. `AdditiveToolPolicySnapshotSource`
 * can only add Tools, so a route that already enables `explain_field_access` will advertise it, and the fact
 * worth reporting is that this session added three and no more — the difference is named in the report rather
 * than being absorbed into a set equality the reader cannot see through.
 */
function runDisabledToolsAbsent(input: Readonly<{
  advertised: readonly string[];
  routePreEnabledDiagnosticsTools: readonly string[];
}>): P10LiveGate {
  const absentByDesign = P10_LIVE_TOOL_NAMES.filter((name) => !P10_PARTIAL_ENABLEMENT_TOOL_NAMES.includes(name));
  const leaked = absentByDesign.filter((name) => input.advertised.includes(name));
  return gate(leaked.length === 0, Object.freeze({
    requested: P10_PARTIAL_ENABLEMENT_TOOL_NAMES,
    notRequested: absentByDesign,
    advertised: input.advertised,
    leaked,
    routePreEnabledDiagnosticsTools: input.routePreEnabledDiagnosticsTools,
  }), 'A P10 Tool this session did not enable was advertised by tools/list, so the enablement was not the '
    + 'whole of what this session could call.');
}

/**
 * The hint rule, applied to every hint this session read.
 *
 * Scanned against the full recognized Tool list rather than against the six P10 names: the rule is about what
 * an Agent can act on, and a hint that named `create_records` in a session that cannot create records is the
 * same defect as one that named `get_debug_log_body`. Substring matching is sound here because the names are
 * long, underscore-separated identifiers that no prose word contains by accident.
 */
function runHintGating(input: Readonly<{
  advertised: readonly string[];
  hints: readonly HintReading[];
}>): P10LiveGate {
  const advertisedSet = new Set(input.advertised);
  const offenders = input.hints.flatMap((entry) => AGENT_RECOGNIZED_TOOL_NAMES
    .filter((name) => !advertisedSet.has(name) && entry.text.includes(name))
    .map((name) => `${entry.tool} names ${name}, which this session does not advertise`));
  return gate(offenders.length === 0, Object.freeze({
    advertised: input.advertised,
    namesNotAdvertised: AGENT_RECOGNIZED_TOOL_NAMES.filter((name) => !advertisedSet.has(name)),
    hints: input.hints,
    offenders: [...new Set(offenders)],
  }), 'A hint named a Tool this session\'s tools/list does not advertise, which sends an Agent to a name it '
    + 'cannot call.');
}

/**
 * The witness half of the same rule: the absent Tool's *branch* was taken, not merely avoided.
 *
 * An empty hint, or one that happened to be short, would satisfy the absence check above without the gating
 * having been exercised at all. The `get_debug_log_body` branch is the one this session can witness, because
 * that Tool is recognized, not advertised here, and named by the sibling hint's other branch.
 *
 * A quiet log window is a fact about the org and not a Tool defect, and the hint then takes the empty-window
 * branch instead — so that case is reported as NOT TESTED with the branch that was taken, never as a pass.
 */
function runDegradedBranch(hints: readonly HintReading[]): P10LiveGate {
  const text = hints.find((entry) => entry.tool === 'get_apex_logs')?.text ?? '';
  const detail = Object.freeze({ hint: text, expectedSentence: BODYLESS_LOG_HINT });
  if (text.includes(BODYLESS_LOG_HINT)) {
    return gate(!text.includes('get_debug_log_body'), detail, 'The body-less branch was taken but the hint still '
      + 'named get_debug_log_body.');
  }
  return notTested(
    'The get_apex_logs hint did not reach the body-less branch, so the degradation this session exists to observe '
    + 'was not exercised. A window holding no log takes the empty-window branch instead, which is a fact about the '
    + 'org rather than a defect.',
    detail,
  );
}

/**
 * The positive control, without which every absence above is vacuous.
 *
 * The `get_platform_diagnostics` hint names `get_apex_logs` only when that Tool is advertised *and* an
 * ASYNC_FAILURES section fact exists — and a default call always produces one. So this session's advertisement
 * of `get_apex_logs` must be visible in that hint: it proves the hint builders are reading the same advertised
 * set `tools/list` returned, which is what makes "the other hint did not name `get_debug_log_body`" a
 * measurement rather than a silence.
 */
function runPositiveControl(input: Readonly<{
  advertised: readonly string[];
  hints: readonly HintReading[];
}>): P10LiveGate {
  const text = input.hints.find((entry) => entry.tool === 'get_platform_diagnostics')?.text ?? '';
  const advertisedSet = new Set(input.advertised);
  const named = AGENT_RECOGNIZED_TOOL_NAMES.filter((name) => text.includes(name));
  const unadvertisedNamed = named.filter((name) => !advertisedSet.has(name));
  return gate(named.includes('get_apex_logs') && unadvertisedNamed.length === 0, Object.freeze({
    hint: text,
    named,
    unadvertisedNamed,
    hintLength: text.length,
    // The hint is bounded by its own schema at 1 000 characters and a cut would silently drop the sentence this
    // control reads, so the truncation marker is reported rather than left to be inferred from a failure.
    truncated: text.length === 1_000 && text.endsWith('…'),
  }), 'The get_platform_diagnostics hint did not name the advertised get_apex_logs — the hint pipeline is not '
    + 'reading the session\'s advertised set — or it named a Tool that is not advertised.');
}

/**
 * The live Playbook status line for the DIAGNOSTICS section.
 *
 * The same rule as the hints, one surface earlier: this is the line an Agent reads to decide which diagnostic
 * path exists at all. It must list exactly the diagnostic Tools this session advertises — no more, or it
 * promises a Tool that is not there, and no fewer, or it hides one that is. The `enabledTools` array the same
 * response carries is checked against the recognized tools `tools/list` returned, which is the one place the
 * Playbook's capability list and the MCP surface can be compared directly.
 */
function runPlaybookStatusLine(
  output: Readonly<Record<string, unknown>> | undefined,
  advertisedSet: ReadonlySet<string>,
): P10LiveGate {
  const guidance = stringOrNull(output?.guidance);
  if (guidance === null) {
    return failGate('get_agent_playbook returned no guidance text, so the DIAGNOSTICS status line could not be read.', {});
  }
  const headingIndex = guidance.indexOf('## DIAGNOSTICS — ');
  const statusIndex = headingIndex === -1 ? -1 : guidance.indexOf('\n- Status:', headingIndex);
  if (statusIndex === -1) {
    return failGate('The DIAGNOSIS workflow rendered no DIAGNOSTICS status line, so there was nothing to compare '
      + 'against the advertised diagnostic Tool set.', {
      hasDiagnosticsSection: headingIndex !== -1,
      guidanceLength: guidance.length,
    });
  }
  const statusLine = guidance.slice(statusIndex + 1, guidance.indexOf('\n', statusIndex + 1) === -1
    ? undefined
    : guidance.indexOf('\n', statusIndex + 1));
  const expected = DIAGNOSTICS_TOOL_NAMES.filter((name) => advertisedSet.has(name));
  const named = [...statusLine.matchAll(/`([^`]+)`/gu)].map((match) => match[1] ?? '');
  // `none` is `codeList`'s word for an empty list, not a Tool name.
  const listed = Object.freeze(named.filter((name) => name !== 'none'));
  const reportedEnabled = Array.isArray(output?.enabledTools)
    ? output.enabledTools.filter((name): name is string => typeof name === 'string')
    : [];
  const expectedEnabled = AGENT_RECOGNIZED_TOOL_NAMES.filter((name) => advertisedSet.has(name));
  const enabledToolsMatch = sameArray([...reportedEnabled].sort(), [...expectedEnabled].sort());

  return gate(sameArray([...listed].sort(), [...expected].sort()) && enabledToolsMatch, Object.freeze({
    statusLine,
    listed,
    expected,
    reportedEnabledTools: Object.freeze([...reportedEnabled].sort()),
    expectedEnabledTools: Object.freeze([...expectedEnabled].sort()),
    enabledToolsMatch,
  }), 'The Playbook DIAGNOSTICS status line did not list exactly the diagnostic Tools this session advertises, '
    + 'or its capability list disagreed with tools/list about which recognized Tools are enabled.');
}

// ---------------------------------------------------------------------------------------------
// The audit gates.
// ---------------------------------------------------------------------------------------------

/** `MAX(id)`, as a decimal string: the row id below which nothing this run did can appear. */
async function readAuditWatermark(database: ControlPlaneDatabaseClient): Promise<string> {
  const row = await database
    .selectFrom('sfoa_audit_log')
    .select(database.fn.max<string>('id').as('watermark'))
    .executeTakeFirst();
  const value = row?.watermark;
  return value === null || value === undefined || String(value).length === 0 ? '0' : String(value);
}

/**
 * A count of rows, coerced.
 *
 * The pool is configured `bigNumberStrings`, so `COUNT(*)` arrives as a decimal string even though Kysely
 * types it as a number; `Number` on it is exact for any count an audit table will hold.
 */
function toCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Per-Tool audit rows written above the watermark. */
async function readToolRowCounts(
  database: ControlPlaneDatabaseClient,
  watermark: string,
): Promise<ReadonlyMap<string, number>> {
  const rows = await database
    .selectFrom('sfoa_audit_log')
    .select(['tool_name', database.fn.countAll<number>().as('total')])
    .where('id', '>', watermark)
    .where('tool_name', 'in', P10_LIVE_TOOL_NAMES as unknown as string[])
    .groupBy('tool_name')
    .execute();
  const counts = new Map<string, number>();
  for (const row of rows) {
    const name = stringOrNull(row.tool_name);
    if (name !== null) counts.set(name, toCount(row.total));
  }
  return counts;
}

/**
 * Which Tools this run is required to have audited, derived from what each milestone reported it did.
 *
 * Derived rather than asserted for all six, because a Tool whose leg was legitimately not measured — the trace
 * write on a production org, the body read when the window held no log — has no row to require, and a gate that
 * demanded one would report the deployment's own refusal as a missing audit trail. Each expectation carries the
 * basis it was derived from, so a green audit gate can be read without opening four milestone reports.
 */
function auditExpectations(input: Readonly<{
  t2: P10MilestoneOutcome<P10T2LiveReport>;
  t3: P10MilestoneOutcome<P10T3LiveReport>;
  t4: P10MilestoneOutcome<P10T4LiveReport>;
  t5: P10MilestoneOutcome<P10T5LiveReport>;
  partial: PartialSectionResult;
}>): readonly AuditExpectation[] {
  const expectations: AuditExpectation[] = [];
  const t2 = input.t2.report;
  const t3 = input.t3.report;
  const t4 = input.t4.report;
  const t5 = input.t5.report;

  expectations.push(Object.freeze({
    tool: 'set_trace_flag',
    expected: t2 !== null && t2.writeLeg.status === 'PASS',
    basis: t2 === null
      ? 'the T2 milestone did not run to a report'
      : `T2 write leg: ${t2.writeLeg.status} (the trace write is sandbox-only)`,
  }));
  expectations.push(Object.freeze({
    tool: 'get_apex_logs',
    expected: t2 !== null && t2.mode !== 'REFUSED',
    basis: t2 === null ? 'the T2 milestone did not run to a report' : `T2 mode ${t2.mode}: the list leg always runs`,
  }));
  expectations.push(Object.freeze({
    tool: 'get_debug_log_body',
    expected: t2 !== null && t2.bodyLeg.status !== 'NOT TESTED',
    basis: t2 === null ? 'the T2 milestone did not run to a report' : `T2 body leg: ${t2.bodyLeg.status}`,
  }));
  expectations.push(Object.freeze({
    tool: 'explain_field_access',
    expected: t3 !== null && t3.mode !== 'REFUSED',
    basis: t3 === null ? 'the T3 milestone did not run to a report' : `T3 mode ${t3.mode}`,
  }));
  expectations.push(Object.freeze({
    tool: 'list_metadata_components',
    expected: t4 !== null && t4.mode === 'MEASURED',
    basis: t4 === null ? 'the T4 milestone did not run to a report' : `T4 mode ${t4.mode}`,
  }));
  expectations.push(Object.freeze({
    tool: 'get_platform_diagnostics',
    expected: (t5 !== null && t5.mode === 'MEASURED')
      || input.partial.callsAttempted.includes('get_platform_diagnostics'),
    basis: t5 === null ? 'the T5 milestone did not run to a report' : `T5 mode ${t5.mode}`,
  }));
  // The partial-enablement session is a caller too, and it is the only one whose calls this file made itself.
  if (input.partial.callsAttempted.includes('get_apex_logs')
    && !expectations.some((entry) => entry.tool === 'get_apex_logs' && entry.expected)) {
    expectations.push(Object.freeze({
      tool: 'get_apex_logs',
      expected: true,
      basis: 'the partial-enablement session listed logs through it',
    }));
  }
  return Object.freeze(expectations);
}

/**
 * The phase's audit claim: every Tool this run exercised left at least one row behind it.
 *
 * Attribution is the watermark and the Tool name, with the platform user reported alongside rather than
 * filtered on: at the moment these Tools are enabled in-process and the route holds no grant for them, a row
 * above the watermark naming one of them can only have come from this run. The counts are of *rows*, not of
 * calls — a Tool that made three calls and wrote three rows is not distinguishable here from one that made one,
 * and the claim being made is the one the requirement states: the Tool reached the trail at all.
 */
async function runAuditCoverage(
  database: ControlPlaneDatabaseClient,
  input: Readonly<{
    watermark: string;
    platformUserId: string;
    expectations: readonly AuditExpectation[];
  }>,
): Promise<P10LiveGate> {
  try {
    const counts = await readToolRowCounts(database, input.watermark);
    const readings = P10_LIVE_TOOL_NAMES.map((tool) => {
      const expectation = input.expectations.find((entry) => entry.tool === tool);
      return Object.freeze({
        tool,
        rows: counts.get(tool) ?? 0,
        required: expectation?.expected ?? false,
        basis: expectation?.basis ?? 'no milestone reported exercising this Tool',
      });
    });
    const missing = readings.filter((entry) => entry.required && entry.rows === 0).map((entry) => entry.tool);
    return gate(missing.length === 0, Object.freeze({
      watermark: input.watermark,
      platformUserIdMasked: maskIdentifier(input.platformUserId),
      readings,
      missing,
    }), 'A Tool this run exercised left no row in the audit trail above the run\'s watermark, so the P7 evidence '
      + 'for it is missing.');
  } catch (error) {
    return failGate('The audit coverage count could not be read, so the phase\'s audit claim is unverified.', {
      message: maskUsernamesInText(maskIdsInText(error instanceof Error ? error.message : String(error))),
    });
  }
}

/**
 * The credential scan: `LIKE` counts, never reads.
 *
 * The gate runs the same four patterns over the four columns a credential could reach, and reports
 * `pattern × column` with a number. No matching text is ever selected, so a hit cannot put the credential into
 * this process, into the report, or into a log — which is the whole reason the check is expressed as counts.
 *
 * Two scopes are reported and only one of them is gated. `runScoped` (rows above the watermark) is what this
 * acceptance run asserts. `allTime` covers every row the six Tools have ever written, including the earlier
 * phases' runs; it is *not* gated, because a historical row is not a fact this run can fix and a phase
 * acceptance that failed on one would be reporting the past as a regression. It is carried in the detail so
 * that the number is on the record and a reader who sees it non-zero can raise it deliberately.
 */
async function runAuditCredentialScan(
  database: ControlPlaneDatabaseClient,
  watermark: string,
): Promise<P10LiveGate> {
  const readings: CredentialScanReading[] = [];
  try {
    for (const pattern of AUDIT_CREDENTIAL_PATTERNS) {
      for (const column of AUDIT_LOG_TEXT_COLUMNS) {
        const runScoped = await countAuditLogLike(database, { column, pattern: pattern.like, watermark });
        const allTime = await countAuditLogLike(database, { column, pattern: pattern.like, watermark: null });
        readings.push(Object.freeze({
          pattern: pattern.id,
          column,
          surface: 'AUDIT_LOG' as const,
          runScoped,
          allTime,
        }));
      }
      const runScoped = await countPayloadEvidenceLike(database, { pattern: pattern.like, watermark });
      const allTime = await countPayloadEvidenceLike(database, { pattern: pattern.like, watermark: null });
      readings.push(Object.freeze({
        pattern: pattern.id,
        column: 'safe_payload',
        surface: 'PAYLOAD_EVIDENCE' as const,
        runScoped,
        allTime,
      }));
    }
  } catch (error) {
    return failGate('The credential scan over the audit trail could not be run, so the trail was not cleared.', {
      message: maskUsernamesInText(maskIdsInText(error instanceof Error ? error.message : String(error))),
    });
  }

  const hits = readings.filter((entry) => entry.runScoped > 0)
    .map((entry) => `${entry.pattern} × ${entry.column} (${entry.surface}): ${entry.runScoped}`);
  const historical = readings.filter((entry) => entry.allTime > 0)
    .map((entry) => `${entry.pattern} × ${entry.column} (${entry.surface}): ${entry.allTime}`);
  return gate(hits.length === 0, Object.freeze({
    watermark,
    patterns: AUDIT_CREDENTIAL_PATTERNS,
    readings,
    hits,
    /** Context only, never gated: rows written before this run, which this run cannot change. */
    allTimeHits: historical,
    note: 'Counts only. No scanned column is selected into this process or written to this report.',
  }), 'The audit trail this run wrote contains a credential-shaped string — the persistence boundary\'s '
    + 'sanitizer did not strip it. The pattern and column above name where to look; the value is deliberately '
    + 'not carried here.');
}

async function countAuditLogLike(
  database: ControlPlaneDatabaseClient,
  input: Readonly<{
    column: typeof AUDIT_LOG_TEXT_COLUMNS[number];
    pattern: string;
    watermark: string | null;
  }>,
): Promise<number> {
  let query = database
    .selectFrom('sfoa_audit_log')
    .select(database.fn.countAll<number>().as('total'))
    .where('tool_name', 'in', P10_LIVE_TOOL_NAMES as unknown as string[])
    .where(input.column, 'like', input.pattern);
  if (input.watermark !== null) query = query.where('id', '>', input.watermark);
  const row = await query.executeTakeFirst();
  return toCount(row?.total);
}

async function countPayloadEvidenceLike(
  database: ControlPlaneDatabaseClient,
  input: Readonly<{ pattern: string; watermark: string | null }>,
): Promise<number> {
  let query = database
    .selectFrom('sfoa_audit_log')
    .innerJoin('sfoa_audit_payload_evidence', 'sfoa_audit_payload_evidence.audit_id', 'sfoa_audit_log.id')
    .select(database.fn.countAll<number>().as('total'))
    .where('sfoa_audit_log.tool_name', 'in', P10_LIVE_TOOL_NAMES as unknown as string[])
    .where('sfoa_audit_payload_evidence.safe_payload', 'like', input.pattern);
  if (input.watermark !== null) query = query.where('sfoa_audit_log.id', '>', input.watermark);
  const row = await query.executeTakeFirst();
  return toCount(row?.total);
}
