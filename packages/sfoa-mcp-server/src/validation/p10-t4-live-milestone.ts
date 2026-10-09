import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from '@salesforce/core';
import {
  METADATA_CONTEXT_TYPES,
  METADATA_LIST_MAX_LIMIT,
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
import { METADATA_CONTEXT_LIMITS } from '../diagnostic-context-adapters.js';
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
  flushAuditTrail,
  gate,
  maskUsernamesInText,
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
  stringOrNull,
  toolFailureDetail,
  type P10LiveGate,
  type P10LiveOrgFacts,
} from './p10-live-support.js';

/**
 * The P10-T4 live milestone: the metadata pair measured on a live org.
 *
 * `list_metadata_components` and the widened `get_metadata_component_context` claim four things that no
 * fixture can settle, and every one of them is a claim about *this* org:
 *
 * 1. **The inventory is the org's own.** The Tool's list is compared against the harness's independent
 *    `metadata.list` read on the same DIAGNOSTIC pairing — the machine equivalent of opening the Setup
 *    page for the type in another tab and comparing the rows. The comparison is membership and order, not
 *    a count: a listing that answered with the right *number* of the wrong names would pass a count check.
 *
 * 2. **The pair round-trips a name the org actually stores.** This org stores localized, URL-escaped
 *    component names (`WRN业务员%2F业务主管%2F市场开发`). The milestone therefore does not pick a name the
 *    harness invented: it takes one out of the listing — preferring one that is escaped — and hands it to
 *    the reader. The proof that it arrived undecoded is the file the retrieve produced, not the echo.
 *
 * 3. **A widened allowlist is a per-type measurement, not an extrapolation.** T0 probed three types and
 *    T4 admits twenty-two. A type's listability is a per-type authorization fact (prerequisite A-4), so
 *    this run enumerates **every** allowlisted type through the Tool and reports each one's answer. A type
 *    the org refuses and a type the Tool answers structurally are different facts, and only the second is
 *    the degradation contract ADR-0029 §3 requires.
 *
 * 4. **The Metadata API is the only surface reached.** The two Tools issue no SOQL at all, which is checked
 *    on the wire against the statements the runtime actually sent inside each call's window.
 *
 * **What this milestone writes: nothing.** Unlike T2 and T3 it constructs no configuration — it is a
 * measurement of what the org already holds, so it runs identically on a production org and needs no
 * sandbox gate. Everything it changes is in this process: the two Tools are granted *in memory* through
 * `AdditiveToolPolicySnapshotSource`, exactly as the earlier milestones do, so a live run never leaves the
 * Control Plane altered.
 */

/** The two Tools of this milestone, in the order an Agent walks them. */
export const P10_T4_TOOL_NAMES = Object.freeze(['list_metadata_components', 'get_metadata_component_context']);

/**
 * The exact input keys each Tool may advertise.
 *
 * A set equality rather than a scan for forbidden names, for T2's reason: `username`, `directory` or
 * `manifest` appearing here would mean a caller can choose an identity or a path, and a scan for the three
 * names T2 listed would not notice a fourth. `manifest` in particular is the one this pair must never
 * accept — the server generates the single-member manifest itself.
 */
const P10_T4_TOOL_INPUT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  list_metadata_components: Object.freeze(['developerNamePrefix', 'includeInactive', 'limit', 'metadataType']),
  get_metadata_component_context: Object.freeze(['fullName', 'metadataType']),
});

/** The type the inventory gate compares row for row: the org holds enough of them for order to mean something. */
const INVENTORY_TYPE = 'ValidationRule';

/** The newly allowlisted types, in preference order, for the positive/negative pair. */
const NEW_TYPE_PREFERENCE = Object.freeze(['NamedCredential', 'DuplicateRule']);

/** The types the `includeInactive` default is measured on, if the org holds a recycled component of any. */
const INACTIVE_PROBE_TYPES = Object.freeze(['Profile', INVENTORY_TYPE, 'Flow']);

/** A component name no org holds. Its only role is to make the reader refuse. */
const NONEXISTENT_COMPONENT = 'P10_T4_No_Such_Component';

/** The component-name characters that make a round trip worth measuring: a separator the org URL-escapes. */
const ESCAPED_SEPARATOR = '%2F';

/**
 * The codes a refusal may carry. The claim the negative legs make is not *which* code came back but that the
 * answer was a structured failure rather than a success with nothing in it — an empty `success: true` is the
 * one shape that would read as "this component is empty" when the truth is "there is no such component".
 */
const DECLARED_REFUSAL_CODES: readonly string[] = Object.freeze([
  'MCP_METADATA_CONTEXT_FAILED',
  'MCP_METADATA_CONTEXT_TOO_LARGE',
  'MCP_METADATA_TYPE_UNAVAILABLE',
  'MCP_METADATA_LIST_FAILED',
  'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED',
]);

export type P10T4LiveReport = Readonly<{
  phase: 'P10';
  task: 'T4';
  generatedAt: string;
  /**
   * `MEASURED` — the Control Plane routes a verified Diagnostic identity, so both Tools were enabled in
   * memory and every gate ran.
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
  /** The Tool's ValidationRule inventory against the harness's own `metadata.list` read of the same type. */
  listedInventory: P10LiveGate;
  /** A name taken out of the listing, read back through the reader — the pair, end to end. */
  pairRoundTrip: P10LiveGate;
  /** A newly allowlisted type, listed and read. */
  newTypeListing: P10LiveGate;
  /** A name that does not exist is refused structurally, never answered with an empty success. */
  missingComponent: P10LiveGate;
  /** `includeInactive`'s default, measured against whatever recycled components the org actually holds. */
  inactiveDefault: P10LiveGate;
  /** The reader's declared budgets, measured on the type whose size is why they exist. */
  budget: P10LiveGate;
  /** Every allowlisted type, through the Tool. This is A-4 as the Tool reports it, type by type. */
  allowlistCoverage: P10LiveGate;
  /** The Metadata API is the only org surface the pair reached: no SOQL inside any Tool's window. */
  surface: P10LiveGate;
  credentialSafety: P10LiveGate;
  connections: Readonly<{ total: number; distinctSalesforceUsernames: readonly string[] }>;
  auditPersistence: P10LiveGate;
  overall: 'PASS' | 'PARTIAL' | 'FAIL';
}>;

/** One independent entry, read by the harness rather than by the Tool. The two fields the comparison needs. */
type IndependentEntry = Readonly<{ fullName: string; manageableState: string | null }>;

type RecordMark = Readonly<{ statements: number; listedTypes: number }>;
type RecordWindow = Readonly<{ statements: readonly string[]; listedTypes: readonly string[] }>;

/**
 * Records what the pair sent to the org, so the two wire claims can be made on evidence.
 *
 * The harness makes reads of its own on the same Connection — the independent `metadata.list` calls the
 * comparison is built from — so asserting over everything sent would fold the scaffolding into a claim
 * about the Tool. Each Tool call is bracketed by a mark and only the bracketed window is asserted.
 *
 * `metadata.list` is recorded by *type* because two different things are checked with it: that the pair
 * reached no SOQL at all, and that every type the Tool asked the org for is one the allowlist admits. The
 * second is the enum's real enforcement point — the schema refuses a type the caller names, but only the
 * wire shows which type the Tool sent.
 */
class MetadataRecordingFactory implements SalesforceConnectionFactory {
  public readonly statements: string[] = [];
  public readonly listedTypes: string[] = [];

  public constructor(private readonly delegate: SalesforceConnectionFactory) {}

  public mark(): RecordMark {
    return Object.freeze({ statements: this.statements.length, listedTypes: this.listedTypes.length });
  }

  public since(mark: RecordMark): RecordWindow {
    return Object.freeze({
      statements: Object.freeze(this.statements.slice(mark.statements)),
      listedTypes: Object.freeze(this.listedTypes.slice(mark.listedTypes)),
    });
  }

  public async create(route: SalesforceIdentityRoute): Promise<Connection> {
    const connection = await this.delegate.create(route);
    const owner = this;
    return new Proxy(connection, {
      get(target, property, receiver) {
        if (property === 'query') {
          const original = Reflect.get(target, property, receiver) as unknown as
            (statement: string) => Promise<unknown>;
          return async function record(statement: string): Promise<unknown> {
            owner.statements.push(statement);
            return await original.call(target, statement);
          };
        }
        if (property === 'metadata') {
          const metadata = Reflect.get(target, property, receiver) as unknown;
          if (typeof metadata !== 'object' || metadata === null) return metadata;
          // A further proxy rather than the object itself: the recorder has to see the method call and the
          // type argument, and it must leave `list`'s own behaviour untouched so the reads the harness
          // compares against are the real ones.
          return new Proxy(metadata as object, {
            get(metadataTarget, metadataProperty, metadataReceiver) {
              const value = Reflect.get(metadataTarget, metadataProperty, metadataReceiver) as unknown;
              if (typeof value !== 'function') return value;
              // Bound to the real object for every method, exactly as T3 binds the `sobject` handle's: a
              // metadata object method invoked with the proxy as `this` would be a `this` the class never
              // expected. Only `list` is also recorded.
              if (metadataProperty !== 'list') {
                return function forward(...args: unknown[]): unknown {
                  return (value as (...inner: unknown[]) => unknown).apply(metadataTarget, args);
                };
              }
              return function recordList(
                queries: readonly Readonly<{ type: string }>[],
                ...rest: unknown[]
              ): unknown {
                for (const query of queries) owner.listedTypes.push(String(query.type));
                return (value as (...inner: unknown[]) => unknown).apply(metadataTarget, [queries, ...rest]);
              };
            },
          });
        }
        return Reflect.get(target, property, receiver);
      },
    }) as Connection;
  }
}

export async function runP10T4LiveMilestone(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<P10T4LiveReport> {
  const config = await loadRemoteRuntimeConfig(projectRoot, environment);
  const controlPlane = config.controlPlane;
  if (controlPlane.mode !== 'mysql') {
    throw new Error('The P10-T4 live milestone requires the MySQL Control Plane: the DIAGNOSTIC identity and the identity routes are read from it.');
  }
  const databaseConfig = controlPlane.database;
  if (!databaseConfig) throw new Error('The P10-T4 live milestone requires the MySQL Control Plane database configuration.');
  if (!config.clientToken) throw new Error('The P10-T4 live milestone requires an independent internal client token.');
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
  // The same two wrappers as T3, in the same order: `MetadataRecordingFactory` answers "what did the pair
  // send", `MeasuringConnectionFactory` answers "which identity did it open a Connection as".
  const recordingFactory = new MetadataRecordingFactory(new JwtConnectionFactory({
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
      const reason = `the metadata pair cannot be enabled because ${missing}. The runtime refuses every request `
        + 'when a diagnostic Tool is enabled without an enabled, verification-passed Diagnostic identity, so the '
        + 'milestone was not attempted: configure and verify the Diagnostic identity through the Admin Control '
        + 'Plane, then re-run.';
      const auditPersistence = runAuditPersistence(await flushAuditTrail(auditPipeline), null);
      await closeQuietly(store, database, auditDatabase, auditPipeline);
      return refusalReport(generatedAt, platformUserId, diagnosticIdentity, reason, auditPersistence);
    }

    // The harness reads the same type through the same DIAGNOSTIC pairing the server uses for a `tools/call`.
    // That is what makes the comparison a comparison of *readings* rather than of identities.
    scaffoldingScope = await identityRuntime.scopeFactory.createForRoute(
      { platformUserId, correlationId: `p10-t4-milestone-${Date.now()}` },
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
      policySnapshotSource: new AdditiveToolPolicySnapshotSource(policySnapshotSource, P10_T4_TOOL_NAMES),
      discoveryPolicySnapshotSource: new MySqlRuntimeDiscoveryPolicySnapshotSource(database),
      ...(attachmentIngress === undefined ? {} : { attachmentIngress }),
    });

    const expectedNames = [...new Set([...snapshot.enabledTools, ...P10_T4_TOOL_NAMES])].sort();
    const results: CallToolResult[] = [];
    const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
      requestInit: {
        headers: {
          authorization: `Bearer ${clientToken}`,
          [config.platformUserHeader]: platformUserId,
        },
      },
    });
    const client = new Client({ name: 'p10-t4-live-milestone', version: '0.1.0-p10' });
    await client.connect(transport);
    try {
      const listings = await client.listTools();
      const toolInventory = runToolInventory({
        tools: listings.tools,
        milestoneTools: P10_T4_TOOL_NAMES,
        expectedNames,
        inputKeys: P10_T4_TOOL_INPUT_KEYS,
      });

      const windows: RecordWindow[] = [];
      const listType = async (
        metadataType: string,
        argumentsValue: Readonly<Record<string, unknown>> = {},
      ): Promise<Readonly<{ result: CallToolResult; output: Record<string, unknown> | undefined; window: RecordWindow }>> => {
        const mark = recordingFactory.mark();
        const result = await call(client, results, 'list_metadata_components', { metadataType, ...argumentsValue });
        const window = recordingFactory.since(mark);
        windows.push(window);
        return Object.freeze({ result, output: outputOf(result), window });
      };
      const readComponent = async (
        metadataType: string,
        fullName: string,
      ): Promise<Readonly<{ result: CallToolResult; output: Record<string, unknown> | undefined; window: RecordWindow }>> => {
        const mark = recordingFactory.mark();
        const result = await call(client, results, 'get_metadata_component_context', { metadataType, fullName });
        const window = recordingFactory.since(mark);
        windows.push(window);
        return Object.freeze({ result, output: outputOf(result), window });
      };

      // 1. The inventory, against the harness's own read of the same type.
      const inventoryCall = await listType(INVENTORY_TYPE, { limit: METADATA_LIST_MAX_LIMIT });
      const independentInventory = await readIndependentListing(scaffolding, INVENTORY_TYPE);
      const listedInventory = runListedInventory(
        inventoryCall.output,
        inventoryCall.result,
        independentInventory,
        METADATA_LIST_MAX_LIMIT,
      );

      // 2. The pair. The subject is chosen from a listing rather than invented, and an escaped name is
      // preferred because it is the one whose round trip a decode would silently break.
      const profileCall = await listType('Profile', { limit: METADATA_LIST_MAX_LIMIT });
      const pairSubject = choosePairSubject(profileCall.output, inventoryCall.output);
      const pairRead = pairSubject === null
        ? null
        : await readComponent(pairSubject.metadataType, pairSubject.fullName);
      const pairRoundTrip = runPairRoundTrip(pairSubject, pairRead, profileCall.output, inventoryCall.output);

      // 3. A newly allowlisted type: one positive read and one refusal that must be structural.
      const newType = await chooseNewType((type) => readIndependentListing(scaffolding, type));
      const newTypeCall = newType === null ? null : await listType(newType.type, { limit: METADATA_LIST_MAX_LIMIT });
      const newTypeRead = newTypeCall === null || newType === null
        ? null
        : firstComponentName(newTypeCall.output) === null
          ? null
          : await readComponent(newType.type, firstComponentName(newTypeCall.output) as string);
      const newTypeListing = runNewTypeListing(newType, newTypeCall?.output, newTypeRead);
      const missingCall = await readComponent(newType?.type ?? INVENTORY_TYPE, NONEXISTENT_COMPONENT);
      const missingComponent = runMissingComponent(missingCall.result, missingCall.output);

      // 4. The `includeInactive` default, on whatever the org actually holds.
      const inactiveDefault = await runInactiveDefault(
        INACTIVE_PROBE_TYPES,
        (type) => readIndependentListing(scaffolding, type),
        (type) => listType(type, { limit: METADATA_LIST_MAX_LIMIT }),
        (type) => listType(type, { limit: METADATA_LIST_MAX_LIMIT, includeInactive: true }),
      );

      // 5. The budgets, measured on the type whose size is why they exist.
      const budgetProfile = await readComponent('Profile', pairSubject?.metadataType === 'Profile'
        ? pairSubject.fullName
        : 'Admin');
      const budget = runBudget(budgetProfile.output, budgetProfile.result);

      // 6. Every allowlisted type, through the Tool.
      const coverageEntries: Record<string, unknown>[] = [];
      for (const type of METADATA_CONTEXT_TYPES) {
        const listed = await listType(type, { limit: 1 });
        coverageEntries.push(describeCoverageEntry(type, listed.output, listed.result));
      }
      const allowlistCoverage = runAllowlistCoverage(coverageEntries);

      // 7. The surface: no SOQL inside any Tool window, and no type the allowlist does not admit.
      const surface = runSurface(windows);

      const credentialSafety = runCredentialSafety(results, clientToken, await readAccessToken(scaffolding));

      await client.close().catch(() => undefined);
      const shutdown = await server.close().catch(() => undefined);
      const auditPersistence = runAuditPersistence(await flushAuditTrail(auditPipeline), shutdown);

      return Object.freeze({
        phase: 'P10',
        task: 'T4',
        generatedAt,
        mode: 'MEASURED',
        platformUserIdMasked: maskIdentifier(platformUserId),
        org,
        diagnosticIdentity,
        toolInventory,
        listedInventory,
        pairRoundTrip,
        newTypeListing,
        missingComponent,
        inactiveDefault,
        budget,
        allowlistCoverage,
        surface,
        credentialSafety,
        connections: Object.freeze({
          total: measuringFactory.measurements.length,
          distinctSalesforceUsernames: measuredSalesforceUsernames(measuringFactory),
        }),
        auditPersistence,
        overall: combine([
          toolInventory, listedInventory, pairRoundTrip, newTypeListing, missingComponent, inactiveDefault,
          budget, allowlistCoverage, surface, credentialSafety, auditPersistence,
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
  diagnosticIdentity: P10T4LiveReport['diagnosticIdentity'],
  reason: string,
  auditPersistence: P10LiveGate,
): P10T4LiveReport {
  return Object.freeze({
    phase: 'P10',
    task: 'T4',
    generatedAt,
    mode: 'REFUSED',
    platformUserIdMasked: maskIdentifier(platformUserId),
    org: Object.freeze({ isSandbox: null, instanceName: null, apiVersion: null, organizationIdMasked: null }),
    diagnosticIdentity,
    toolInventory: notTested(reason),
    listedInventory: notTested(reason),
    pairRoundTrip: notTested(reason),
    newTypeListing: notTested(reason),
    missingComponent: notTested(reason),
    inactiveDefault: notTested(reason),
    budget: notTested(reason),
    allowlistCoverage: notTested(reason),
    surface: notTested(reason),
    credentialSafety: notTested('No Tool call was made.'),
    connections: Object.freeze({ total: 0, distinctSalesforceUsernames: Object.freeze([]) }),
    auditPersistence,
    overall: 'PARTIAL',
  });
}

// ---------------------------------------------------------------------------------------------
// The harness's own read. Independent of the Tool, same identity, same org, same type.
// ---------------------------------------------------------------------------------------------

async function readIndependentListing(connection: Connection, type: string): Promise<readonly IndependentEntry[]> {
  const listed = await connection.metadata.list([{ type }]);
  const entries = (Array.isArray(listed) ? listed : [listed]).flatMap((entry) => {
    const record = recordOf(entry);
    return record === undefined ? [] : [record];
  });
  return Object.freeze(entries.flatMap((record) => {
    const fullName = stringOrNull(record.fullName);
    return fullName === null ? [] : [Object.freeze({ fullName, manageableState: stringOrNull(record.manageableState) })];
  }));
}

/** The listing the Tool should have produced: the independent read minus the recycled entries. */
function liveEntries(entries: readonly IndependentEntry[]): readonly IndependentEntry[] {
  return entries.filter((entry) => entry.manageableState !== 'deleted');
}

function deletedEntries(entries: readonly IndependentEntry[]): readonly IndependentEntry[] {
  return entries.filter((entry) => entry.manageableState === 'deleted');
}

function componentNamesOf(output: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  return readRecords(output?.components).flatMap((entry) => {
    const fullName = stringOrNull(entry.fullName);
    return fullName === null ? [] : [fullName];
  });
}

function firstComponentName(output: Readonly<Record<string, unknown>> | undefined): string | null {
  return componentNamesOf(output)[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// The gates.
// ---------------------------------------------------------------------------------------------

/**
 * The inventory, compared row for row.
 *
 * A count check would pass a Tool that answered with the right *number* of the wrong names, so the
 * comparison is membership plus order: every name the Tool returned must be one the independent read
 * returned, in the same order the Tool's own sort contract promises, and the counts must agree with the
 * post-filter definition the contract states. `totalCount` is the matched count *before* the limit, which
 * is why it is compared against the filtered independent size rather than against the returned length.
 */
function runListedInventory(
  output: Readonly<Record<string, unknown>> | undefined,
  result: CallToolResult,
  independent: readonly IndependentEntry[],
  limit: number,
): P10LiveGate {
  const live = liveEntries(independent);
  if (live.length === 0) {
    return notTested(
      `This org lists no ${INVENTORY_TYPE} component to the diagnostic identity, so there was no inventory to compare.`,
      Object.freeze({ independentEntries: independent.length }),
    );
  }
  const expectedNames = live.map((entry) => entry.fullName).sort();
  const returned = componentNamesOf(output);
  const totalCount = numberOrNull(output?.totalCount);
  const returnedCount = numberOrNull(output?.returnedCount);
  const truncated = output?.truncated;
  const unknownNames = returned.filter((name) => !expectedNames.includes(name));
  const expectedReturned = expectedNames.slice(0, Math.min(limit, expectedNames.length));
  const facts = result.isError !== true
    && output?.success === true
    && output?.executionRole === 'DIAGNOSTIC'
    && output?.metadataType === INVENTORY_TYPE
    && totalCount === expectedNames.length
    && returnedCount === returned.length
    && truncated === (returned.length < expectedNames.length)
    && unknownNames.length === 0
    && sameNames(returned, expectedReturned);

  return gate(facts, Object.freeze({
    metadataType: INVENTORY_TYPE,
    limit,
    independentEntries: independent.length,
    independentLive: expectedNames.length,
    independentDeleted: deletedEntries(independent).length,
    totalCount,
    returnedCount,
    truncated: truncated ?? null,
    sampleReturned: returned.slice(0, 5),
    unknownNames: unknownNames.slice(0, 5),
    orderMatches: sameNames(returned, expectedReturned),
  }), `The ${INVENTORY_TYPE} inventory the Tool returned did not match this org's own listing: the counts, the `
    + 'membership or the order disagreed with an independent read of the same type through the same identity.');
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

type PairSubject = Readonly<{ metadataType: string; fullName: string; chosenBecause: string }>;

/**
 * The name the pair is measured on, taken out of a listing rather than invented.
 *
 * An escaped name wins: `%2F` is the one character class whose mishandling is silent — a decoded name
 * addresses a different component, or none, and the retrieve of a *different* component succeeds. Failing
 * to find one is not a failure of the Tool, so the fallback is the inventory type's own first name and the
 * report says which case it measured.
 */
function choosePairSubject(
  profileOutput: Readonly<Record<string, unknown>> | undefined,
  inventoryOutput: Readonly<Record<string, unknown>> | undefined,
): PairSubject | null {
  const profileNames = componentNamesOf(profileOutput);
  const escaped = profileNames.find((name) => name.includes(ESCAPED_SEPARATOR));
  if (escaped !== undefined) {
    return Object.freeze({ metadataType: 'Profile', fullName: escaped, chosenBecause: 'URL_ESCAPED_SEPARATOR' });
  }
  const localized = profileNames.find((name) => /[^\u0000-\u007f]/u.test(name));
  if (localized !== undefined) {
    return Object.freeze({ metadataType: 'Profile', fullName: localized, chosenBecause: 'LOCALIZED_NAME' });
  }
  const inventoryName = componentNamesOf(inventoryOutput)[0];
  if (inventoryName !== undefined) {
    return Object.freeze({ metadataType: INVENTORY_TYPE, fullName: inventoryName, chosenBecause: 'FIRST_LISTED' });
  }
  return null;
}

function runPairRoundTrip(
  subject: PairSubject | null,
  read: Readonly<{ result: CallToolResult; output: Record<string, unknown> | undefined }> | null,
  profileOutput: Readonly<Record<string, unknown>> | undefined,
  inventoryOutput: Readonly<Record<string, unknown>> | undefined,
): P10LiveGate {
  if (subject === null || read === null) {
    return notTested('No component name was available to round-trip: the Profile and inventory listings were both empty.', {
      profileComponents: componentNamesOf(profileOutput).length,
      inventoryComponents: componentNamesOf(inventoryOutput).length,
    });
  }
  const output = read.output;
  const files = readRecords(output?.files);
  // The proof the name survived the trip is the file the retrieve produced, not the echo of the input: an
  // echo would be byte-exact even if the adapter had decoded the name on its way to the manifest. For a
  // Profile — the type whose names carry the escaped separator — the retrieved file is named after the
  // stored component, so `%2F` must appear in it.
  const pathEvidence = subject.metadataType !== 'Profile'
    ? null
    : files.some((file) => String(file.relativePath ?? '').includes(subject.fullName));
  const contentBytes = files.reduce((total, file) => total + (numberOrNull(file.returnedBytes) ?? 0), 0);
  const facts = read.result.isError !== true
    && output?.success === true
    && output?.executionRole === 'DIAGNOSTIC'
    && output?.metadataType === subject.metadataType
    && output?.fullName === subject.fullName
    && files.length > 0
    && contentBytes > 0
    && pathEvidence !== false;

  return gate(facts, Object.freeze({
    metadataType: subject.metadataType,
    fullName: subject.fullName,
    chosenBecause: subject.chosenBecause,
    echoedFullName: stringOrNull(output?.fullName),
    echoedByteExact: output?.fullName === subject.fullName,
    returnedFiles: files.length,
    returnedBytes: contentBytes,
    escapedNameInFilePath: pathEvidence,
    samplePaths: files.slice(0, 3).map((file) => String(file.relativePath ?? '')),
  }), 'The name the listing returned did not round-trip through the reader: the answer did not echo it '
    + 'byte-for-byte, produced no file, or produced a file that does not carry the escaped name.');
}

type NewTypeChoice = Readonly<{ type: string; independentCount: number }>;

/** The first newly allowlisted type this org actually holds, so the positive leg has something to read. */
async function chooseNewType(
  readIndependent: (type: string) => Promise<readonly IndependentEntry[]>,
): Promise<NewTypeChoice | null> {
  for (const type of NEW_TYPE_PREFERENCE) {
    const entries = await readIndependent(type);
    if (entries.length > 0) return Object.freeze({ type, independentCount: entries.length });
  }
  return null;
}

function runNewTypeListing(
  choice: NewTypeChoice | null,
  output: Readonly<Record<string, unknown>> | undefined,
  read: Readonly<{ result: CallToolResult; output: Record<string, unknown> | undefined }> | null,
): P10LiveGate {
  if (choice === null) {
    return notTested('This org holds no component of any newly allowlisted type this run prefers, so the '
      + 'widening could not be exercised positively.');
  }
  const listed = componentNamesOf(output);
  const readOutput = read?.output;
  const files = readRecords(readOutput?.files);
  const subject = firstComponentName(output);
  const facts = output?.success === true
    && output?.metadataType === choice.type
    && listed.length > 0
    && read !== null
    && read.result.isError !== true
    && readOutput?.success === true
    && readOutput?.fullName === subject
    && files.length > 0;

  return gate(facts, Object.freeze({
    metadataType: choice.type,
    independentCount: choice.independentCount,
    listedCount: numberOrNull(output?.totalCount),
    returnedCount: listed.length,
    sampleListed: listed.slice(0, 5),
    readFullName: stringOrNull(readOutput?.fullName),
    readFiles: files.length,
  }), `The newly allowlisted type ${choice.type} was not both listed and read on this org, so the widening is `
    + 'not demonstrated for it.');
}

/**
 * A component that does not exist must be a structured refusal.
 *
 * The failure this exists to catch is the one that reads as success: retrieve answers an unknown member with
 * an empty package rather than an error, so an adapter that returned an empty file list as `success: true`
 * would tell an investigator "this component is empty" when the truth is "there is no such component".
 */
function runMissingComponent(
  result: CallToolResult,
  output: Readonly<Record<string, unknown>> | undefined,
): P10LiveGate {
  const errorCode = stringOrNull(output?.errorCode);
  const files = readRecords(output?.files);
  const facts = result.isError === true
    && errorCode !== null
    && DECLARED_REFUSAL_CODES.includes(errorCode)
    && output?.success !== true
    && files.length === 0;

  return gate(facts, Object.freeze({
    requestedName: NONEXISTENT_COMPONENT,
    isError: result.isError === true,
    errorCode,
    declared: errorCode === null ? false : DECLARED_REFUSAL_CODES.includes(errorCode),
    returnedFiles: files.length,
    failure: toolFailureDetail(output ?? {}),
  }), 'Reading a component that does not exist did not produce a structured refusal: an empty success or an '
    + 'undeclared error code reads as a fact about the component rather than as "there is no such component".');
}

async function runInactiveDefault(
  types: readonly string[],
  readIndependent: (type: string) => Promise<readonly IndependentEntry[]>,
  listDefault: (type: string) => Promise<Readonly<{ output: Record<string, unknown> | undefined }>>,
  listIncluding: (type: string) => Promise<Readonly<{ output: Record<string, unknown> | undefined }>>,
): Promise<P10LiveGate> {
  const measured: Record<string, unknown>[] = [];
  for (const type of types) {
    const independent = await readIndependent(type);
    const deleted = deletedEntries(independent).length;
    if (deleted === 0) {
      measured.push(Object.freeze({
        metadataType: type,
        independentEntries: independent.length,
        independentDeleted: 0,
        measured: false,
      }));
      continue;
    }
    const expectedLive = liveEntries(independent).length;
    const byDefault = await listDefault(type);
    const byChoice = await listIncluding(type);
    const defaultCount = numberOrNull(byDefault.output?.totalCount);
    const choiceCount = numberOrNull(byChoice.output?.totalCount);
    const defaultNames = componentNamesOf(byDefault.output);
    const deletedNames = deletedEntries(independent).map((entry) => entry.fullName);
    measured.push(Object.freeze({
      metadataType: type,
      independentEntries: independent.length,
      independentDeleted: deleted,
      independentLive: expectedLive,
      defaultTotalCount: defaultCount,
      includeInactiveTotalCount: choiceCount,
      defaultIncludeInactive: byDefault.output?.includeInactive ?? null,
      choiceIncludeInactive: byChoice.output?.includeInactive ?? null,
      deletedNamesExcludedByDefault: deletedNames.every((name) => !defaultNames.includes(name)),
      measured: true,
    }));
  }
  const measuredTypes = measured.filter((entry) => entry.measured === true);
  if (measuredTypes.length === 0) {
    // A legitimate fact about this org rather than a missing measurement: none of the probed types holds a
    // recycled component, so there is nothing for the default to filter and the run says so.
    return notTested(
      'None of the probed types holds a component this org marks as inactive, so the includeInactive default '
      + 'had nothing to filter. The default was therefore not exercised positively by this run.',
      Object.freeze({ probed: [...types], measured }),
    );
  }
  const facts = measuredTypes.every((entry) =>
    entry.defaultIncludeInactive === false
    && entry.choiceIncludeInactive === true
    && entry.defaultTotalCount !== undefined && entry.defaultTotalCount !== null
    && entry.includeInactiveTotalCount !== undefined && entry.includeInactiveTotalCount !== null
    && (entry.defaultTotalCount as number) === (entry.independentLive as number)
    && (entry.includeInactiveTotalCount as number) === (entry.independentEntries as number)
    && entry.deletedNamesExcludedByDefault === true);

  return gate(facts, Object.freeze({
    probed: [...types],
    measuredTypes: measuredTypes.map((entry) => entry.metadataType),
    measured,
  }), 'The listing did not honour the includeInactive default: recycled components were counted either by '
    + 'default or in the totals.');
}

/**
 * The reader's declared budgets, measured on a Profile.
 *
 * Profile is the type the prohibition names ("禁止超预算回传大文件（Profile 类尤其）") because a profile can
 * hold thousands of field-level entries. What is asserted is the bound the Tool declares, on the response it
 * actually produced, plus the honesty of the truncation flag: `truncated` must be true exactly when
 * something was left out, whether that was a whole file or the tail of one.
 */
function runBudget(
  output: Readonly<Record<string, unknown>> | undefined,
  result: CallToolResult,
): P10LiveGate {
  if (result.isError === true) {
    const failure = toolFailureDetail(output ?? {});
    // A Profile too large to return inside the bounds is refused rather than truncated, and that refusal
    // names the bound. It is a pass of the budget claim, not a failure, and it is reported as what it is.
    return gate(
      stringOrNull(failure.errorCode) === 'MCP_METADATA_CONTEXT_TOO_LARGE',
      Object.freeze({ outcome: 'REFUSED_OVER_BUDGET', failure }),
      'A Profile read failed for a reason other than the declared size bound, so the budget could not be measured.',
    );
  }
  const files = readRecords(output?.files);
  const omitted = readRecords(output?.omittedFiles);
  const returnedBytes = numberOrNull(output?.returnedBytes);
  const truncated = output?.truncated;
  const someFileTruncated = files.some((file) => file.truncated === true);
  const facts = output?.success === true
    && returnedBytes !== null
    && returnedBytes <= METADATA_CONTEXT_LIMITS.maxTotalBytes
    && files.length <= METADATA_CONTEXT_LIMITS.maxReturnedFiles
    && files.every((file) => (numberOrNull(file.returnedBytes) ?? Number.POSITIVE_INFINITY) <= METADATA_CONTEXT_LIMITS.maxFileBytes)
    && truncated === (omitted.length > 0 || someFileTruncated);

  return gate(facts, Object.freeze({
    outcome: 'READ',
    returnedFiles: files.length,
    returnedBytes,
    omittedFiles: omitted.length,
    truncated: truncated ?? null,
    declared: METADATA_CONTEXT_LIMITS,
    reportedLimits: recordOf(output?.limits) ?? null,
  }), 'The Profile response exceeded a declared budget, or its truncation flag disagreed with what was left out.');
}

function describeCoverageEntry(
  type: string,
  output: Readonly<Record<string, unknown>> | undefined,
  result: CallToolResult,
): Record<string, unknown> {
  if (result.isError === true) {
    const failure = toolFailureDetail(output ?? {});
    return Object.freeze({
      metadataType: type,
      status: 'REFUSED',
      structured: failure.errorCode !== null,
      errorCode: failure.errorCode,
      prerequisite: failure.prerequisite,
      salesforceErrorCode: failure.salesforceErrorCode,
    });
  }
  return Object.freeze({
    metadataType: type,
    status: 'LISTED',
    totalCount: numberOrNull(output?.totalCount),
    returnedCount: numberOrNull(output?.returnedCount),
    truncated: output?.truncated ?? null,
    sampleFullName: firstComponentName(output),
  });
}

/**
 * A-4, type by type, as the Tool reports it.
 *
 * The claim is that every type on the widened allowlist is servable by this identity. The gate therefore
 * fails when any type is refused — the allowlist is a statement about authorization, and a type that cannot
 * be listed makes it a false statement — while the detail records whether each refusal was *structured*,
 * which is the separate question ADR-0029 §3 asks. Both facts are needed: a refusal that came back as an
 * empty list is a contract violation regardless of how many types were served.
 */
function runAllowlistCoverage(entries: readonly Record<string, unknown>[]): P10LiveGate {
  const refused = entries.filter((entry) => entry.status === 'REFUSED');
  const unstructured = refused.filter((entry) => entry.structured !== true);
  const servedTypes = entries.filter((entry) => entry.status === 'LISTED').map((entry) => String(entry.metadataType));
  const refusedTypes = refused.map((entry) => String(entry.metadataType));
  const facts = entries.length === METADATA_CONTEXT_TYPES.length
    && refused.length === 0
    && unstructured.length === 0;

  return gate(facts, Object.freeze({
    allowlistSize: METADATA_CONTEXT_TYPES.length,
    measured: entries.length,
    served: servedTypes.length,
    refused: refusedTypes,
    unstructuredRefusals: unstructured.map((entry) => String(entry.metadataType)),
    perType: entries,
  }), 'At least one allowlisted metadata type was refused by this org, or a refusal was not structured: the '
    + 'allowlist claims a per-type authorization fact this deployment does not satisfy, and the degraded answer '
    + 'was not the structured refusal ADR-0029 §3 requires.');
}

/**
 * The surface, on the wire.
 *
 * Two claims, both about what the pair sent rather than about what it said. It reached no SOQL at all — the
 * metadata pair is a Metadata API Toolset, and a SOQL statement inside one of its windows would mean it had
 * gone to a record surface instead. And every type it asked the org for is one the allowlist admits, which is
 * the enforcement point a schema check cannot see: the schema refuses a *caller's* type, the wire shows what
 * the Tool itself sent.
 */
function runSurface(windows: readonly RecordWindow[]): P10LiveGate {
  const statements = windows.flatMap((window) => window.statements);
  const requestedTypes = [...new Set(windows.flatMap((window) => window.listedTypes))];
  const offAllowlist = requestedTypes.filter((type) => !METADATA_CONTEXT_TYPES.includes(type as never));
  const facts = windows.length > 0 && statements.length === 0 && offAllowlist.length === 0;

  return gate(facts, Object.freeze({
    toolWindows: windows.length,
    soqlStatements: statements.length,
    // Recorded, masked, and only when there are any: the strict claim is "none", so a failure here has to
    // show what was sent rather than only how many. Masked at the point of recording, as T3 does, because a
    // statement is the one place the raw text *is* the value.
    sampleStatements: statements.slice(0, 5).map(maskUsernamesInText),
    requestedTypes: requestedTypes.length,
    offAllowlist,
    types: requestedTypes,
  }), 'A Tool window sent SOQL, or asked the Metadata API for a type the allowlist does not admit.');
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
