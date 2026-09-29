import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from '@salesforce/core';
import {
  createIdentityRuntime,
  JwtConnectionFactory,
  JsonLineRuntimeLogger,
  normalizeSalesforceIdentity,
  type SalesforceConnectionFactory,
  type SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import {
  MySqlIdentityRepository,
  AsyncAuditPipeline,
  assertAllMigrationsApplied,
  auditDatabaseConfig,
  createControlPlaneDatabase,
  DatabaseRuntimeLogger,
  DEFAULT_AUDIT_FLUSH_TIMEOUT_MS,
  freezeSnapshot,
  MySqlAuditBatchSink,
  MySqlControlPlaneStore,
  type ControlPlaneDatabaseClient,
  type RequestPolicySnapshot,
} from '@sfoa/control-plane';
import {
  BULK_QUERY_RESULTS_DEFAULT_MAX_RECORDS,
  DESCRIBE_SOBJECT_DEFAULT_FIELD_LIMIT,
  DESCRIBE_SOBJECT_MAX_CHILD_RELATIONSHIPS,
  DESCRIBE_SOBJECT_MAX_PICKLIST_VALUES,
  LIST_SOBJECTS_MAX_LIMIT,
  QUERY_RECORDS_MAX_MAX_ROWS,
  SEARCH_RECORDS_MAX_LIMIT,
  SFOA_DATA_TOOL_NAMES,
} from '@sfoa/mcp-provider-sfoa-data';
import {
  ORG_LIMIT_HIGHLIGHT_ALIASES,
  ORG_LIMIT_HIGHLIGHT_SLOTS,
} from '@sfoa/mcp-provider-sfoa-context';
import { loadRemoteRuntimeConfig } from '../config.js';
import { startRemoteMcpServer } from '../http-server.js';
import { createAttachmentIngress } from '../runtime.js';
import {
  MySqlRuntimeDiscoveryPolicySnapshotSource,
  MySqlRuntimePolicySnapshotSource,
  type RuntimePolicySnapshotSource,
} from '../policy-snapshot.js';

export type P9LiveStatus = 'PASS' | 'FAIL' | 'NOT TESTED';

export type P9LiveGate = Readonly<{
  status: P9LiveStatus;
  detail: Readonly<Record<string, unknown>>;
}>;

export type P9LiveValidationReport = Readonly<{
  phase: 'P9';
  task: 'T1+T2+T3+T4';
  generatedAt: string;
  objectApiName: string;
  /**
   * The object the Bulk export gate runs against. It is usually `objectApiName`, but the export
   * needs an object large enough for the row-count cross-check to mean anything, so the gate can
   * be pointed at a different one without moving the gates that only need a live object.
   */
  bulkObjectApiName: string;
  /**
   * The row floor this run's Bulk export gate applied, and where it came from.
   *
   * Reported at the top level rather than only inside the gate because it qualifies the whole
   * run's credibility: a `bulkQuery` PASS at 10 000 rows and one at 100 000 rows are different
   * claims, and a reader must not have to open the gate to tell which was made.
   */
  bulkMinimumRows: Readonly<{ rows: number; source: 'plan' | typeof BULK_MINIMUM_ROWS_VARIABLE }>;
  filter: string;
  /**
   * Where the Data Tool enablement came from for this run. The Tools deliberately have no
   * `sfoa_tool_control` row yet, so a live run extends the MySQL snapshot additively instead
   * of writing to the Control Plane. The report states it rather than implying a real grant.
   */
  enablementSource: string;
  toolInventory: P9LiveGate;
  requestIdentity: P9LiveGate;
  listSobjects: P9LiveGate;
  describeSobject: P9LiveGate;
  queryRecords: P9LiveGate;
  orgLimits: P9LiveGate;
  searchRecords: P9LiveGate;
  bulkQuery: P9LiveGate;
  schemaSelfRepair: P9LiveGate;
  credentialSafety: P9LiveGate;
  connections: Readonly<{
    total: number;
    distinctSalesforceUsernames: readonly string[];
  }>;
  overall: 'PASS' | 'PARTIAL' | 'FAIL';
}>;

const PLATFORM_USER_VARIABLE = 'P9_LIVE_PLATFORM_USER';

/**
 * A batch of 2000 rows is the REST API ceiling for one SOQL page, so an object holding fewer
 * rows than this cannot exercise the continuation walk at all: the first batch would already
 * be the whole result. Below it the query gate reports NOT TESTED rather than a PASS that
 * proves nothing about paging.
 */
const SINGLE_BATCH_ROWS = 2_000;

/** The row budget that proves the continuation walk reaches a declared-complete result. */
const QUERY_RECORDS_PROBE_MARGIN = 1_000;

/** A row budget below the org's row count, used to prove the truncation declaration. */
const QUERY_RECORDS_TRUNCATION_MAX_ROWS = 500;

/** The object the Bulk export gate is pointed at, when it has to differ from `P9_LIVE_OBJECT`. */
const BULK_OBJECT_VARIABLE = 'P9_LIVE_BULK_OBJECT';

/**
 * Row floor of the Bulk export gate, as the P9 plan's T4 acceptance states it.
 *
 * The cross-check this gate exists for — the summed `returnedCount` of every page against the
 * org's own `COUNT()`, read independently over the same live Connection — is the only evidence
 * that the paging delivered **every** row rather than merely stopping cleanly. A result set of
 * a few thousand rows reaches its last page in two calls and cannot distinguish a working walk
 * from one that ends early by luck, so the gate refuses to report a PASS below a floor rather
 * than reporting one that proves nothing. `P9_LIVE_BULK_OBJECT` points the gate at an object
 * large enough; the plan asks for one of at least this many rows.
 */
const BULK_EXPORT_MINIMUM_ROWS = 100_000;

/**
 * Overrides the floor above, so the gate can be run on an org whose largest object is smaller
 * than the plan assumed.
 *
 * The floor exists to make the walk a walk, not to fix a number: what a run has to be able to
 * distinguish is a loop that paged to the real end from one that stopped early by luck. An org
 * that cannot supply 100 000 rows in any object can still exercise that distinction — the
 * deployment this gate was first run against tops out at 37 496 rows on `Contact`, which is 19
 * pages of the default 2 000 and 19 cursor advances — but the run must then **say** it was made
 * at a reduced scale rather than quietly reporting the plan's floor as met. The report carries
 * both numbers (`plannedMinimumRows` and `minimumRows`) plus `minimumRowsSource`, so a PASS on a
 * relaxed floor is never mistakable for a PASS at the planned one.
 */
const BULK_MINIMUM_ROWS_VARIABLE = 'P9_LIVE_BULK_MIN_ROWS';

/**
 * The lowest floor the override may set.
 *
 * Below five pages at the default page size the gate is measuring a single request with extra
 * steps: nearly any implementation reaches a last page in one or two calls, so a PASS there would
 * be evidence of nothing. The bound is here rather than in the operator's judgement because an
 * override that can be set arbitrarily low is an override that can manufacture a green run.
 */
const BULK_EXPORT_MINIMUM_OVERRIDE_ROWS = SINGLE_BATCH_ROWS * 5;

/** How long the gate waits between state polls while Salesforce runs the job. */
const BULK_EXPORT_POLL_INTERVAL_MS = 2_000;

/** A Bulk query job is asynchronous; this bounds how long the gate waits for one to finish. */
const BULK_EXPORT_MAX_POLLS = 60;

/** Pages allowed beyond the arithmetic minimum before the walk is called non-terminating. */
const BULK_EXPORT_PAGE_MARGIN = 5;

/**
 * Tool names a `query_records` hint might name. One that is not advertised must never appear:
 * sending an Agent after a Tool `tools/list` does not contain costs it a turn to find out.
 */
const HINT_TOOL_CANDIDATES = Object.freeze([
  'submit_bulk_query', 'get_org_limits', 'query_records', 'run_soql_query',
  'list_sobjects', 'describe_sobject',
]);

/**
 * The same gate, widened by the one Tool only a Bulk result page can name.
 *
 * `get_bulk_query_results` is deliberately not in `HINT_TOOL_CANDIDATES`: that list is what a
 * `query_records` hint is scanned against, and a search hint that named the result-reading half
 * of an export it never started would be advice an Agent cannot act on. A Bulk page hint is the
 * opposite case — naming it is the whole point of the hint — so it is checked against the list
 * plus its own name rather than against a list that must stay narrow.
 */
const BULK_HINT_TOOL_CANDIDATES = Object.freeze([
  ...HINT_TOOL_CANDIDATES, 'get_bulk_query_results',
]);

/** Tool input keys that would let a caller pick an identity, an endpoint or a credential. */
const FORBIDDEN_INPUT_KEYS = Object.freeze([
  'username', 'usernameoralias', 'salesforceusername', 'platformuserid', 'accesstoken', 'refreshtoken',
  'token', 'password', 'clientsecret', 'privatekey', 'instanceurl', 'directory', 'apiversion',
]);

type ConnectionMeasurement = Readonly<{
  platformUserId: string;
  salesforceUsername: string;
  connection: Connection;
}>;

class MeasuringConnectionFactory implements SalesforceConnectionFactory {
  public readonly measurements: ConnectionMeasurement[] = [];

  public constructor(private readonly delegate: SalesforceConnectionFactory) {}

  public async create(route: SalesforceIdentityRoute): Promise<Connection> {
    const connection = await this.delegate.create(route);
    this.measurements.push(Object.freeze({
      platformUserId: route.platformUserId,
      salesforceUsername: route.salesforceUsername,
      connection,
    }));
    return connection;
  }
}

/**
 * Adds the P9 Data Tool names to whatever the Control Plane snapshot already grants.
 *
 * This is a validation-harness affordance, not a runtime behaviour: the Data Tools ship
 * default-disabled and an Admin grants them through the Control Plane. Keeping the grant out
 * of the database means a live run never leaves the local Control Plane altered.
 */
class AdditiveDataToolsPolicySnapshotSource implements RuntimePolicySnapshotSource {
  public constructor(
    private readonly delegate: RuntimePolicySnapshotSource,
    private readonly extraToolNames: readonly string[],
  ) {}

  public async load(platformUserId: string): Promise<RequestPolicySnapshot> {
    const snapshot = await this.delegate.load(platformUserId);
    return freezeSnapshot({
      ...snapshot,
      enabledTools: [...new Set([...snapshot.enabledTools, ...this.extraToolNames])],
    });
  }
}

type LiveSobjectEntry = Readonly<{
  name: string;
  label: string;
  labelPlural: string;
  keyPrefix: string | null;
  custom: boolean;
  queryable: boolean;
  createable: boolean;
  updateable: boolean;
  searchable: boolean;
}>;

type LivePicklistValue = Readonly<{ value: string; label: string; active: boolean; defaultValue: boolean }>;

type LiveField = Readonly<{
  name: string;
  label: string;
  type: string;
  nillable: boolean;
  createable: boolean;
  updateable: boolean;
  filterable: boolean;
  sortable: boolean;
  custom: boolean;
  deprecatedAndHidden: boolean;
  referenceTo: readonly string[];
  relationshipName: string | null;
  picklistValues: readonly LivePicklistValue[];
}>;

type LiveChildRelationship = Readonly<{
  childSObject: string;
  field: string;
  relationshipName: string | null;
  cascadeDelete: boolean;
  restrictedDelete: boolean;
  deprecatedAndHidden: boolean;
}>;

export function missingP9LiveVariables(environment: NodeJS.ProcessEnv = process.env): string[] {
  return environment[PLATFORM_USER_VARIABLE]?.trim() ? [] : [PLATFORM_USER_VARIABLE];
}

/**
 * The row floor the Bulk export gate will enforce for this run.
 *
 * Returning the source alongside the number is what keeps a relaxed run honest: the report says
 * which floor was applied, so `minimumRows: 10000` next to `minimumRowsSource: 'P9_LIVE_BULK_MIN_ROWS'`
 * cannot be read as the plan's requirement having been met.
 */
function resolveBulkMinimumRows(
  environment: NodeJS.ProcessEnv,
): Readonly<{ rows: number; source: 'plan' | typeof BULK_MINIMUM_ROWS_VARIABLE }> {
  const raw = environment[BULK_MINIMUM_ROWS_VARIABLE]?.trim();
  if (raw === undefined || raw === '') return Object.freeze({ rows: BULK_EXPORT_MINIMUM_ROWS, source: 'plan' });
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < BULK_EXPORT_MINIMUM_OVERRIDE_ROWS) {
    throw new Error(
      `${BULK_MINIMUM_ROWS_VARIABLE} must be an integer of at least ${BULK_EXPORT_MINIMUM_OVERRIDE_ROWS}: `
      + 'below that the walk is a single request with extra steps, and a PASS would prove nothing about paging.',
    );
  }
  return Object.freeze({ rows: parsed, source: BULK_MINIMUM_ROWS_VARIABLE });
}

export async function runP9LiveValidation(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<P9LiveValidationReport> {
  const missing = missingP9LiveVariables(environment);
  if (missing.length > 0) throw new Error(`Missing mandatory P9 live inputs: ${missing.join(', ')}`);
  const platformUserId = environment[PLATFORM_USER_VARIABLE]?.trim() as string;
  const config = await loadRemoteRuntimeConfig(projectRoot, environment);
  const controlPlane = config.controlPlane;
  if (controlPlane.mode !== 'mysql') {
    throw new Error('The P9 live validation requires the MySQL Control Plane so the P7 Audit chain is persisted.');
  }
  const databaseConfig = controlPlane.database;
  if (!databaseConfig) throw new Error('The P9 live validation requires the MySQL Control Plane database configuration.');
  if (!config.clientToken) throw new Error('The P9 live validation requires an independent internal client token.');
  const clientToken = config.clientToken;
  const objectApiName = environment.P9_LIVE_OBJECT?.trim() || config.identity.testObject || 'Account';
  // The export gate needs an object with enough rows for the cross-check to mean something, so it
  // is separately pointable: a deployment whose only large object is not the one the other gates
  // use can still run the export leg.
  const bulkObjectApiName = environment[BULK_OBJECT_VARIABLE]?.trim() || objectApiName;
  const bulkMinimumRows = resolveBulkMinimumRows(environment);
  const filter = environment.P9_LIVE_FILTER?.trim() || objectApiName.slice(0, 3);
  const dataToolNames = [...SFOA_DATA_TOOL_NAMES];
  const generatedAt = new Date().toISOString();

  const database = createControlPlaneDatabase(databaseConfig);
  const auditDatabase = createControlPlaneDatabase(auditDatabaseConfig(databaseConfig));
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
  const snapshot = await policySnapshotSource.load(platformUserId);
  const route = snapshot.identityRoute;
  // `get_org_limits` runs on the server-owned DIAGNOSTIC identity, and the runtime refuses *every*
  // request when a diagnostic Tool is enabled without an enabled diagnostic configuration. So this
  // run may only enable the Tool when this Control Plane can actually route that identity; otherwise
  // the enablement would abort the seven gates that have nothing to do with quotas. A diagnostic
  // configuration that exists but has not passed verification is treated as absent for the same
  // reason: the runtime would route it, and the gate would be measuring an unverified identity.
  const diagnosticEnabled = snapshot.diagnostic !== null
    && snapshot.diagnostic.enabled === true
    && snapshot.diagnostic.verificationStatus === 'PASS';
  /** Tools this run enables that live outside the Data provider, so the inventory check knows them. */
  const movedToolNames = diagnosticEnabled ? ['get_org_limits'] : [];
  const additiveToolNames = [...dataToolNames, ...movedToolNames];
  const enablementSource =
    `the MySQL Control Plane snapshot for ${platformUserId}, extended additively with `
    + `${dataToolNames.join(', ')} for this run (the Tools have no sfoa_tool_control row)`
    + (diagnosticEnabled
      ? `, and additionally with ${movedToolNames.join(', ')} because this Control Plane has an enabled, `
        + 'verification-passed Diagnostic identity that get_org_limits now requires'
      : ', and without get_org_limits because this Control Plane has no enabled, verification-passed '
        + 'Diagnostic identity to run it on');

  if (route === null || route.enabled !== true) {
    await closeQuietly(store, database, auditDatabase, auditPipeline);
    const reason = `Identity route ${platformUserId} is ${route === null ? 'absent' : 'disabled'} in this Control Plane.`;
    return Object.freeze({
      phase: 'P9',
      task: 'T1+T2+T3+T4',
      generatedAt,
      objectApiName,
      bulkObjectApiName,
      bulkMinimumRows,
      filter,
      enablementSource,
      toolInventory: notTested(reason),
      requestIdentity: notTested(reason),
      listSobjects: notTested(reason),
      describeSobject: notTested(reason),
      queryRecords: notTested(reason),
      orgLimits: notTested(reason),
      searchRecords: notTested(reason),
      bulkQuery: notTested(reason),
      schemaSelfRepair: notTested(reason),
      credentialSafety: notTested('No Tool call was made.'),
      connections: Object.freeze({ total: 0, distinctSalesforceUsernames: Object.freeze([]) }),
      overall: 'PARTIAL',
    });
  }

  await assertAllMigrationsApplied(database);
  // The harness starts its own in-process server, so it has to bind the same attachment ingress the
  // deployed runtime binds. A Control Plane that enables an attachment Tool refuses every request
  // when no ingress is bound — before any Tool runs — so without this the gates could only ever run
  // against a Control Plane that has the capability switched off, and would fail with
  // MCP_ATTACHMENT_CONFIGURATION_INVALID everywhere else.
  const attachmentIngress = createAttachmentIngress(config, store);
  const server = await startRemoteMcpServer({
    // The live harness binds an ephemeral loopback port, so it accepts the loopback Host and
    // Origin values rather than the deployed allowlist.
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
    policySnapshotSource: new AdditiveDataToolsPolicySnapshotSource(policySnapshotSource, additiveToolNames),
    discoveryPolicySnapshotSource: new MySqlRuntimeDiscoveryPolicySnapshotSource(database),
    ...(attachmentIngress === undefined ? {} : { attachmentIngress }),
  });
  const expectedNames = [...new Set([...snapshot.enabledTools, ...additiveToolNames])].sort();
  const results: CallToolResult[] = [];

  try {
    const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
      requestInit: {
        headers: {
          authorization: `Bearer ${clientToken}`,
          [config.platformUserHeader]: platformUserId,
        },
      },
    });
    const client = new Client({ name: 'p9-live-validation', version: '0.1.0-p9' });
    await client.connect(transport);
    try {
      const toolInventory = await runToolInventory(client, expectedNames, additiveToolNames);
      // The first Tool call is what opens the request-scoped Connection. Every independent
      // org fact below is read through that same live, already-authenticated Connection, so a
      // disagreement is a disagreement about Salesforce's own answer, not about a fixture.
      const bounded = await call(client, results, 'list_sobjects', { filter, limit: 5 });
      const connection = await establishedConnection(measuringFactory);
      if (connection === null) {
        throw new Error('The list_sobjects request did not create a request-scoped Salesforce Connection.');
      }
      const liveIdentity = await readIdentity(connection);
      const requestIdentity = gate(
        normalizeSalesforceIdentity(route.salesforceUsername) === normalizeSalesforceIdentity(liveIdentity.username ?? ''),
        {
          routedUsername: normalizeSalesforceIdentity(route.salesforceUsername),
          liveUsername: normalizeSalesforceIdentity(liveIdentity.username ?? ''),
          routeEnabled: route.enabled,
        },
        'Salesforce answered a different user than the routed identity.',
      );
      const realEntries = sortEntries(await readDescribeGlobal(connection));
      const listSobjects = await runListSobjects(client, results, bounded, filter, realEntries);
      const describeSobject = await runDescribeSobject(client, results, objectApiName, connection);
      const queryRecords = await runQueryRecords(client, results, objectApiName, connection, expectedNames);
      const orgLimits = await runOrgLimits(
        client,
        results,
        measuringFactory,
        snapshot.diagnostic?.salesforceUsername ?? null,
        diagnosticEnabled,
      );
      const searchRecords = await runSearchRecords(client, results, connection, objectApiName, expectedNames);
      const bulkQuery = await runBulkQuery(
        client,
        results,
        connection,
        bulkObjectApiName,
        expectedNames,
        bulkMinimumRows,
      );
      const schemaSelfRepair = await runSchemaSelfRepair(client, results, objectApiName);
      const credentialSafety = runCredentialSafety(results, clientToken, await readAccessToken(connection));
      const usernames = [...new Set(measuringFactory.measurements.map((entry) => entry.salesforceUsername))];

      return Object.freeze({
        phase: 'P9',
        task: 'T1+T2+T3+T4',
        generatedAt,
        objectApiName,
        bulkObjectApiName,
        bulkMinimumRows,
        filter,
        enablementSource,
        toolInventory,
        requestIdentity,
        listSobjects,
        describeSobject,
        queryRecords,
        orgLimits,
        searchRecords,
        bulkQuery,
        schemaSelfRepair,
        credentialSafety,
        connections: Object.freeze({
          total: measuringFactory.measurements.length,
          distinctSalesforceUsernames: Object.freeze(usernames),
        }),
        overall: combine([
          toolInventory, requestIdentity, listSobjects, describeSobject,
          queryRecords, orgLimits, searchRecords, bulkQuery, schemaSelfRepair, credentialSafety,
        ]),
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  } finally {
    await server.close();
    await closeQuietly(store, database, auditDatabase, auditPipeline);
  }
}

async function runToolInventory(
  client: Client,
  expectedNames: readonly string[],
  additiveToolNames: readonly string[],
): Promise<P9LiveGate> {
  const listed = await client.listTools();
  const advertisedNames = listed.tools.map((tool) => tool.name).sort();
  // The schema-leak and annotation checks follow the Tools this run actually added, not the Data
  // provider's list: `get_org_limits` moved to the context provider, so keying off `SFOA_DATA_TOOL_NAMES`
  // would silently stop checking its input keys — the one thing this gate exists to catch.
  const inspectedTools = listed.tools.filter((tool) => additiveToolNames.includes(tool.name));
  const leakedKeys = inspectedTools.flatMap((tool) => Object.keys(tool.inputSchema.properties ?? {})
    .filter((key) => FORBIDDEN_INPUT_KEYS.includes(key.toLowerCase()))
    .map((key) => `${tool.name}.${key}`));
  const annotationsOk = inspectedTools.every((tool) => tool.annotations?.readOnlyHint === true
    && tool.annotations.destructiveHint === false
    && tool.annotations.idempotentHint === true
    && tool.annotations.openWorldHint === true);
  const allAdvertised = additiveToolNames.every((name) => advertisedNames.includes(name));

  return gate(
    allAdvertised && sameArray(advertisedNames, expectedNames) && leakedKeys.length === 0 && annotationsOk,
    {
      advertised: advertisedNames,
      expectedFromSnapshot: expectedNames,
      additiveToolsAdvertised: inspectedTools.map((tool) => tool.name),
      additiveToolInputKeys: Object.fromEntries(
        inspectedTools.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties ?? {}).sort()]),
      ),
      forbiddenInputKeys: leakedKeys,
      readOnlyAnnotations: annotationsOk,
    },
    'The advertised Tool inventory disagreed with the grant, or an added Tool exposed a forbidden input key.',
  );
}

async function runListSobjects(
  client: Client,
  results: CallToolResult[],
  bounded: CallToolResult,
  filter: string,
  allEntries: readonly LiveSobjectEntry[],
): Promise<P9LiveGate> {
  const boundedOutput = outputOf(bounded);
  if (boundedOutput === undefined) return failGate('list_sobjects returned no structured content.');
  if (boundedOutput.success !== true) {
    return failGate(`list_sobjects failed live: ${String(boundedOutput.errorCode ?? 'no error code')}.`);
  }
  const realMatching = allEntries.filter((entry) => startsWithFilter(entry.name, filter));
  const entries = readEntries(boundedOutput.sobjects);
  const expectedTotal = realMatching.length;
  const expectedReturned = Math.min(5, expectedTotal);
  const byName = new Map(realMatching.map((entry) => [entry.name, entry]));
  const factMismatches = entries.flatMap((entry) => {
    const real = byName.get(String(entry.name));
    if (real === undefined) return [`${String(entry.name)} does not match the filter in the org`];
    return (['label', 'labelPlural', 'keyPrefix', 'custom', 'queryable', 'createable', 'updateable', 'searchable'] as const)
      .filter((key) => entry[key] !== real[key])
      .map((key) => `${String(entry.name)}.${key}: tool=${JSON.stringify(entry[key])} org=${JSON.stringify(real[key])}`);
  });
  const filterRespected = entries.every((entry) => startsWithFilter(String(entry.name), filter));

  // A limit at or above the matching count must be able to declare the result complete.
  const wideLimit = Math.min(LIST_SOBJECTS_MAX_LIMIT, Math.max(1, expectedTotal));
  const wide = await call(client, results, 'list_sobjects', { filter, limit: wideLimit });
  const wideOutput = outputOf(wide);
  const wideReturned = readEntries(wideOutput?.sobjects).length;
  const wideExpected = Math.min(wideLimit, expectedTotal);
  const truncationFacts = boundedOutput.totalCount === expectedTotal
    && boundedOutput.returnedCount === expectedReturned
    && boundedOutput.truncated === expectedTotal > expectedReturned
    && (boundedOutput.truncated !== true || typeof boundedOutput.hint === 'string')
    && wideOutput?.totalCount === expectedTotal
    && wideReturned === wideExpected
    && wideOutput.truncated === expectedTotal > wideExpected
    && (wideOutput.truncated !== true || typeof wideOutput.hint === 'string');

  return gate(
    factMismatches.length === 0 && filterRespected && entries.length === expectedReturned && truncationFacts,
    {
      filter,
      orgMatchingCount: expectedTotal,
      bounded: {
        limit: 5,
        returned: entries.length,
        totalCount: boundedOutput.totalCount,
        truncated: boundedOutput.truncated,
        hintPresent: typeof boundedOutput.hint === 'string',
        executionRole: boundedOutput.executionRole,
      },
      widened: {
        limit: wideLimit,
        returned: wideReturned,
        totalCount: wideOutput?.totalCount,
        truncated: wideOutput?.truncated,
        hintPresent: typeof wideOutput?.hint === 'string',
      },
      sample: entries.slice(0, 5).map((entry) => String(entry.name)),
      factMismatches: factMismatches.slice(0, 10),
      filterRespected,
    },
    'list_sobjects facts, filter or truncation declaration disagreed with the org.',
  );
}

async function runDescribeSobject(
  client: Client,
  results: CallToolResult[],
  objectApiName: string,
  connection: Connection,
): Promise<P9LiveGate> {
  const real = await readDescribe(connection, objectApiName);
  const realFieldNames = real.fields.map((field) => field.name);
  const expectedFields = Math.min(DESCRIBE_SOBJECT_DEFAULT_FIELD_LIMIT, real.fields.length);
  const expectedChildren = Math.min(DESCRIBE_SOBJECT_MAX_CHILD_RELATIONSHIPS, real.childRelationships.length);

  const full = await call(client, results, 'describe_sobject', { objectApiName });
  const fullOutput = outputOf(full);
  if (fullOutput === undefined) return failGate('describe_sobject returned no structured content.');
  if (fullOutput.success !== true) {
    return failGate(`describe_sobject failed live: ${String(fullOutput.errorCode ?? 'no error code')}.`);
  }
  const fields = readEntries(fullOutput.fields);
  const children = readEntries(fullOutput.childRelationships);
  const realByField = new Map(real.fields.map((field) => [field.name, field]));
  const fieldMismatches = fields.flatMap((field) => {
    const expected = realByField.get(String(field.apiName));
    if (expected === undefined) return [`${String(field.apiName)} is not an org field of ${objectApiName}`];
    const scalars = (['label', 'type', 'nillable', 'createable', 'updateable', 'filterable', 'sortable', 'custom',
      'deprecatedAndHidden', 'relationshipName'] as const)
      .filter((key) => field[key] !== expected[key])
      .map((key) => `${String(field.apiName)}.${key}: tool=${JSON.stringify(field[key])} org=${JSON.stringify(expected[key])}`);
    const references = sameArray(readStringArray(field.referenceTo), [...expected.referenceTo])
      ? []
      : [`${String(field.apiName)}.referenceTo: tool=${JSON.stringify(field.referenceTo)} org=${JSON.stringify(expected.referenceTo)}`];
    const expectedPicklist = expected.picklistValues.slice(0, DESCRIBE_SOBJECT_MAX_PICKLIST_VALUES);
    const picklistDiffs = picklistDifferences(readEntries(field.picklistValues), expectedPicklist);
    const picklist = picklistDiffs.length === 0
      ? []
      : [`${String(field.apiName)}.picklistValues: ${picklistDiffs.join(', ')}`];
    const picklistTruncation = field.picklistValuesTruncated
      === (expected.picklistValues.length > DESCRIBE_SOBJECT_MAX_PICKLIST_VALUES)
      ? []
      : [`${String(field.apiName)}.picklistValuesTruncated disagreed with the org (org has ${expected.picklistValues.length})`];
    return [...scalars, ...references, ...picklist, ...picklistTruncation];
  });
  const childMismatches = children.flatMap((child, index) => {
    const expected = real.childRelationships[index];
    if (expected === undefined) return [`child relationship ${index} is not present in the org`];
    return (['childSObject', 'field', 'relationshipName', 'cascadeDelete', 'restrictedDelete', 'deprecatedAndHidden'] as const)
      .filter((key) => child[key] !== expected[key])
      .map((key) => `child[${index}].${key}: tool=${JSON.stringify(child[key])} org=${JSON.stringify(expected[key])}`);
  });
  const headerMismatches = (['label', 'labelPlural', 'keyPrefix', 'custom', 'queryable', 'createable',
    'updateable', 'searchable'] as const)
    .filter((key) => fullOutput[key] !== real[key])
    .map((key) => `${key}: tool=${JSON.stringify(fullOutput[key])} org=${JSON.stringify(real[key])}`);

  // `truncated` is a document-level declaration: it is true when the field list was cut, when the
  // child relationship list was cut, or when any returned field's picklist was cut. Reading it as a
  // statement about fields alone fails an object whose fields fit while its children do not — Lead
  // holds 101 fields under the 200-field default limit but 72 child relationships against a cap of
  // 50, so the Tool correctly reports `truncated: true` with no field missing.
  const picklistCuts = real.fields
    .slice(0, fields.length)
    .filter((field) => field.picklistValues.length > DESCRIBE_SOBJECT_MAX_PICKLIST_VALUES)
    .length;
  const expectedTruncated = real.fields.length > expectedFields
    || real.childRelationships.length > expectedChildren
    || picklistCuts > 0;

  const fullFacts = fullOutput.totalFields === real.fields.length
    && fullOutput.returnedFields === expectedFields
    && fields.length === expectedFields
    && fullOutput.truncated === expectedTruncated
    && (typeof fullOutput.hint === 'string') === expectedTruncated
    && sameArray(fields.map((field) => String(field.apiName)), realFieldNames.slice(0, expectedFields))
    && fullOutput.totalChildRelationships === real.childRelationships.length
    && fullOutput.returnedChildRelationships === expectedChildren
    && children.length === expectedChildren
    && fullOutput.fieldsIncluded === true
    && fullOutput.objectApiName === objectApiName;

  const capped = await call(client, results, 'describe_sobject', { objectApiName, fieldLimit: 3 });
  const cappedOutput = outputOf(capped);
  const cappedFields = readEntries(cappedOutput?.fields);
  const capFacts = cappedOutput?.returnedFields === 3
    && cappedFields.length === 3
    && cappedOutput.totalFields === real.fields.length
    && cappedOutput.truncated === true
    && typeof cappedOutput.hint === 'string'
    && sameArray(cappedFields.map((field) => String(field.apiName)), realFieldNames.slice(0, 3));

  const excluded = await call(client, results, 'describe_sobject', { objectApiName, includeFields: false });
  const excludedOutput = outputOf(excluded);
  const excludeFacts = excludedOutput?.fieldsIncluded === false && excludedOutput.fields === undefined;

  return gate(
    fieldMismatches.length === 0 && childMismatches.length === 0 && headerMismatches.length === 0
      && fullFacts && capFacts && excludeFacts,
    {
      objectApiName,
      orgFieldCount: real.fields.length,
      orgChildRelationshipCount: real.childRelationships.length,
      returnedFields: fields.length,
      returnedChildRelationships: children.length,
      executionRole: fullOutput.executionRole,
      truncated: fullOutput.truncated,
      expectedTruncated,
      picklistCuts,
      hintPresent: typeof fullOutput.hint === 'string',
      cappedFieldNames: cappedFields.map((field) => String(field.apiName)),
      cappedTruncated: cappedOutput?.truncated,
      cappedHintPresent: typeof cappedOutput?.hint === 'string',
      fieldsIncludedWhenExcluded: excludedOutput?.fieldsIncluded,
      fieldMismatches: fieldMismatches.slice(0, 10),
      childMismatches: childMismatches.slice(0, 10),
      headerMismatches,
    },
    'describe_sobject facts or truncation declaration disagreed with the org.',
  );
}

/**
 * Cross-checks `query_records` completeness against the org rather than against itself.
 *
 * The Tool's whole reason to exist is that the official `run_soql_query` cannot say whether an
 * answer is the whole answer, so the only meaningful test is a count the Tool did not produce:
 * the org's own `COUNT()` read over the same live Connection. Three probes follow — a walk with
 * the row budget set above the org's size, which must report a result consistent with the org's
 * count (complete when every row fits the payload, and a declared RESPONSE_BUDGET cut when it
 * does not); a 500-row cap, which must declare exactly why it is not complete; and a scalar
 * aggregate, which must come back bounded and complete.
 */
async function runQueryRecords(
  client: Client,
  results: CallToolResult[],
  objectApiName: string,
  connection: Connection,
  advertisedNames: readonly string[],
): Promise<P9LiveGate> {
  const reading = await readCount(connection, objectApiName);
  const realTotal = reading.count;
  if (realTotal === null) {
    return notTested(
      `COUNT() of ${objectApiName} returned no row count — ${reading.observed} — `
      + 'so a completeness claim cannot be cross-checked against the org.',
    );
  }
  if (realTotal <= SINGLE_BATCH_ROWS) {
    return notTested(
      `${objectApiName} holds ${realTotal} rows, at or below one 2000-row batch, so the continuation walk would never run. `
      + 'Point P9_LIVE_OBJECT at an object with more rows to exercise it.',
    );
  }
  if (realTotal > QUERY_RECORDS_MAX_MAX_ROWS) {
    return notTested(
      `${objectApiName} holds ${realTotal} rows, above the Tool's ${QUERY_RECORDS_MAX_MAX_ROWS}-row ceiling, `
      + 'so no single call could be complete and the completeness claim is untestable here.',
    );
  }
  const statement = `SELECT Id FROM ${objectApiName}`;
  const probeBudget = Math.min(QUERY_RECORDS_MAX_MAX_ROWS, realTotal + QUERY_RECORDS_PROBE_MARGIN);

  const probe = await call(client, results, 'query_records', { query: statement, maxRows: probeBudget });
  const probeOutput = outputOf(probe);
  if (probeOutput === undefined) return failGate('query_records returned no structured content.');
  // A standard object the org declares unused is refused by design before any Salesforce call;
  // that is the guard working, not the gate failing.
  if (probeOutput.errorCode === 'MCP_SOBJECT_NOT_IN_USE') {
    return notTested(
      `${objectApiName} is declared not in use in this org, so query_records refuses it by design: ${String(probeOutput.message)}`,
    );
  }
  if (probeOutput.success !== true) {
    return failGate(`query_records failed live: ${String(probeOutput.errorCode ?? 'no error code')}.`);
  }

  const fetched = integerOf(probeOutput.fetched);
  const returnedCount = integerOf(probeOutput.returnedCount);
  // A response budget may legitimately shorten the returned slice, but only as a declared, named
  // cut — a silent one is exactly the failure this Tool exists to prevent. Which of the two
  // budgets binds depends on the record width, so the gate asserts the declaration, not the count.
  const budgetCut = returnedCount < fetched;
  const probeFacts = probeOutput.executionRole === 'USER'
    && probeOutput.totalSize === realTotal
    && fetched === realTotal
    && returnedCount >= 0
    && probeOutput.done === true
    && probeOutput.truncated === budgetCut
    && probeOutput.complete === !budgetCut
    && (!budgetCut || probeOutput.truncatedReason === 'RESPONSE_BUDGET');

  const capped = await call(client, results, 'query_records', {
    query: statement,
    maxRows: QUERY_RECORDS_TRUNCATION_MAX_ROWS,
  });
  const cappedOutput = outputOf(capped);
  const cappedHint = typeof cappedOutput?.hint === 'string' ? cappedOutput.hint : '';
  const namedTools = HINT_TOOL_CANDIDATES.filter((name) => cappedHint.includes(name));
  // The row cap binds *fetching*; the response budget can bind the returned slice on top of it,
  // and the enum then names that second cut, because it is what an Agent holding these records
  // has to work around — raising maxRows would not return more. Both shapes are contract-correct,
  // so what is asserted is the contract rather than a row count: the cap is what stopped the
  // walk, and whatever shortened the slice is declared. Measured live on a record this wide, the
  // 500-row cap fetches 500 and the payload budget returns 392 of them, so the "returnedCount
  // equals the cap" form of this assertion is only true for records narrow enough to fit.
  const cappedFetched = integerOf(cappedOutput?.fetched);
  const cappedReturned = integerOf(cappedOutput?.returnedCount);
  const cappedBudgetCut = cappedReturned >= 0 && cappedReturned < cappedFetched;
  const capFacts = cappedOutput?.success === true
    && cappedOutput.executionRole === 'USER'
    && cappedOutput.totalSize === realTotal
    && cappedFetched === QUERY_RECORDS_TRUNCATION_MAX_ROWS
    && cappedReturned >= 0
    && cappedReturned <= QUERY_RECORDS_TRUNCATION_MAX_ROWS
    && cappedOutput.complete === false
    && cappedOutput.truncated === true
    && cappedOutput.truncatedReason === (cappedBudgetCut ? 'RESPONSE_BUDGET' : 'MAX_ROWS')
    && (cappedBudgetCut === false || cappedHint.includes('MAX_ROWS + RESPONSE_BUDGET'))
    && cappedHint.length > 0
    && namedTools.every((name) => advertisedNames.includes(name));

  // The scraped shape of the org's own reading of a scalar aggregate: Salesforce answers a bare
  // COUNT() with the value in `totalSize` and no records, so the Tool must move that value into
  // `aggregateValue` and leave `totalSize` null rather than report a correct count as truncated.
  const orgScalarAggregate = await readScalarAggregate(connection, objectApiName);
  const aggregate = await call(client, results, 'query_records', {
    query: `SELECT COUNT() FROM ${objectApiName}`,
  });
  const aggregateOutput = outputOf(aggregate);
  const aggregateFacts = aggregateOutput?.success === true
    && aggregateOutput.aggregate === true
    && aggregateOutput.complete === true
    && aggregateOutput.truncated === false
    && aggregateOutput.totalSize === null
    && aggregateOutput.aggregateValue === realTotal
    && readArray(aggregateOutput.records).length === 0
    && orgScalarAggregate === realTotal;

  return gate(probeFacts && capFacts && aggregateFacts, {
    objectApiName,
    statement,
    orgCount: realTotal,
    probe: {
      maxRows: probeBudget,
      totalSize: probeOutput.totalSize,
      fetched: probeOutput.fetched,
      returnedCount: probeOutput.returnedCount,
      pages: probeOutput.pages,
      done: probeOutput.done,
      complete: probeOutput.complete,
      truncated: probeOutput.truncated,
      truncatedReason: probeOutput.truncatedReason,
      executionRole: probeOutput.executionRole,
    },
    capped: {
      maxRows: QUERY_RECORDS_TRUNCATION_MAX_ROWS,
      fetched: cappedOutput?.fetched,
      returnedCount: cappedOutput?.returnedCount,
      payloadCutTheSlice: cappedBudgetCut,
      complete: cappedOutput?.complete,
      truncated: cappedOutput?.truncated,
      truncatedReason: cappedOutput?.truncatedReason,
      hintPresent: cappedHint.length > 0,
      toolNamesInHint: namedTools,
      unadvertisedToolNamesInHint: namedTools.filter((name) => !advertisedNames.includes(name)),
    },
    aggregate: {
      declared: aggregateOutput?.aggregate,
      complete: aggregateOutput?.complete,
      truncated: aggregateOutput?.truncated,
      totalSize: aggregateOutput?.totalSize,
      aggregateValue: aggregateOutput?.aggregateValue,
      returnedCount: readArray(aggregateOutput?.records).length,
      orgScalarAggregate,
    },
  }, 'query_records completeness, truncation or aggregate declaration disagreed with the org.');
}

type CountReading = Readonly<{ count: number | null; observed: string }>;

/**
 * Reads the org's own row count, and reports **what the org actually answered** when it cannot.
 *
 * A bare `SELECT COUNT()` cannot serve here: Salesforce answers it with the count in
 * `totalSize` and **no records at all** (verified live — `SELECT COUNT() FROM Account` came
 * back `totalSize: 797, records: []`), so it is not a shape this reader can treat as a row
 * count without already knowing the answer it is trying to establish. `COUNT(Id) <alias>`
 * names its field and comes back as an ordinary `AggregateResult` row, which is what an
 * independent cross-check needs. The scalar-aggregate shape is exercised separately, by the
 * aggregate probe, where the Tool's own reading of it is what is under test.
 *
 * A bare `null` would also leave the operator unable to tell an org condition (the object is
 * not queryable by this identity, the statement was refused) from a defect in this reader, and
 * the difference decides whether the gate is honestly untestable or silently broken. The
 * observed shape is therefore carried out with the count. Only the Salesforce error *code* is
 * reported, never its message, so no org text reaches the report.
 */
async function readCount(connection: Connection, objectApiName: string): Promise<CountReading> {
  try {
    const payload = await connection.query(
      `SELECT COUNT(Id) total FROM ${objectApiName}`,
    ) as unknown as Readonly<Record<string, unknown>>;
    const records = readArray(payload.records);
    const first = records[0];
    const values = first === undefined ? [] : Object.values(first).filter(isNonNegativeInteger);
    return Object.freeze({
      count: values[0] ?? null,
      observed: first === undefined
        ? `the org returned ${records.length} records for COUNT(Id)`
        : `the count record carried the fields ${Object.keys(first).join(', ') || 'none'}`,
    });
  } catch (error) {
    return Object.freeze({
      count: null,
      observed: `the COUNT(Id) query was refused with ${salesforceErrorCodeOf(error) ?? 'no Salesforce error code'}`,
    });
  }
}

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

function salesforceErrorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as Readonly<Record<string, unknown>>).errorCode;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/**
 * Reads the org's own answer to a bare `COUNT()`, which is the shape the Tool has to special-case.
 *
 * The value is in `totalSize` with no records — that is the fact the Tool's scalar-aggregate
 * branch exists for — so this reads it the same way to confirm the org really does answer that
 * way, rather than the Tool having invented the interpretation. Returns `-1` when the shape is
 * not what the Tool assumes, which fails the gate instead of passing it vacuously.
 */
async function readScalarAggregate(connection: Connection, objectApiName: string): Promise<number> {
  try {
    const payload = await connection.query(
      `SELECT COUNT() FROM ${objectApiName}`,
    ) as unknown as Readonly<Record<string, unknown>>;
    if (readArray(payload.records).length > 0) return -1;
    const reported = payload.totalSize;
    return typeof reported === 'number' && Number.isInteger(reported) && reported >= 0 ? reported : -1;
  } catch {
    return -1;
  }
}

function integerOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : -1;
}

/**
 * Cross-checks `get_org_limits` against the org's own answer, or reports why the read cannot be
 * exercised here at all.
 *
 * The Tool now runs on the server-owned DIAGNOSTIC identity, so the Tool call comes first and the
 * reference reading is taken over the Connection that call opened — which is the only way to prove
 * two things at once: that the routing decision really produced a diagnostic scope, and that the
 * numbers the Tool returned are the ones that identity sees. The earlier shape read the org first
 * through the request USER Connection, which cannot be the reference any more: the Tool does not use
 * that identity, so comparing against it would compare two different users' views of the org.
 *
 * A Control Plane with no enabled, verification-passed Diagnostic identity never reaches here — the
 * caller does not enable the Tool in that case, because enabling a diagnostic Tool without one makes
 * the runtime refuse *every* request. When it does reach here, the refusal branch below is the one
 * this org has historically taken: reading the limits resource is an org-configuration read, and the
 * business identities this deployment routes are not granted it. Whether the diagnostic identity is
 * is exactly the open question this gate now answers, and a refusal here is a fact about the org
 * rather than a gap in the harness — it is reported as NOT TESTED naming the Salesforce code,
 * because a structured denial proves nothing about the read that could not be done.
 */
async function runOrgLimits(
  client: Client,
  results: CallToolResult[],
  measuringFactory: MeasuringConnectionFactory,
  diagnosticUsername: string | null,
  diagnosticEnabled: boolean,
): Promise<P9LiveGate> {
  if (!diagnosticEnabled) {
    return notTested(
      'This Control Plane has no enabled, verification-passed Diagnostic identity, so get_org_limits was not '
      + 'enabled for this run — enabling it without one would make the runtime refuse every request.',
      { diagnosticConfigured: false },
    );
  }

  const result = await call(client, results, 'get_org_limits', {});
  const output = outputOf(result);
  if (output === undefined) return failGate('get_org_limits returned no structured content.');

  // The role has to be asserted before the numbers are: a USER-role answer would mean the Tool ran on
  // the business identity, where a missing permission is the expected outcome, and cross-checking its
  // numbers against the diagnostic identity's would then be comparing two different answers.
  const roleFacts = output.success === true && output.executionRole === 'DIAGNOSTIC';
  if (output.success !== true) {
    const denialOutput = output;
    const denied = result.isError === true
      && denialOutput.success === false
      && denialOutput.errorCode === 'MCP_LIMITS_ACCESS_DENIED'
      && typeof denialOutput.suggestion === 'string';
    const evidence = Object.freeze({
      toolErrorCode: denialOutput.errorCode,
      toolSalesforceErrorCode: denialOutput.salesforceErrorCode,
      denialIsStructured: denied,
      diagnosticConfigured: true,
    });
    if (!denied) {
      return failGate(
        `get_org_limits failed with ${String(denialOutput.errorCode ?? 'no error code')} instead of either a successful `
        + 'read or a structured MCP_LIMITS_ACCESS_DENIED.',
      );
    }
    return notTested(
      `The org refused the limits resource to the DIAGNOSTIC identity this Tool runs on with `
      + `${String(denialOutput.salesforceErrorCode ?? 'no Salesforce error code')}, so no successful read can be `
      + 'cross-checked and this gate is not a PASS. The refusal path was exercised instead and behaved as '
      + 'contracted: the Tool returned a structured MCP_LIMITS_ACCESS_DENIED.',
      evidence,
    );
  }
  if (!roleFacts) {
    return failGate(
      `get_org_limits succeeded with executionRole=${String(output.executionRole)}; it must run on the DIAGNOSTIC identity.`,
    );
  }

  // The Tool call opened a DIAGNOSTIC scope, so the most recent Connection is that scope's. Its
  // username is checked against the Control Plane's configured diagnostic identity first: without
  // that check a routing regression would silently turn the reference reading into a second reading
  // of whatever identity the Tool did use, and the comparison below would be vacuously true.
  const diagnosticConnection = await establishedConnection(measuringFactory);
  if (diagnosticConnection === null) {
    return failGate('The get_org_limits request did not create a request-scoped Salesforce Connection.');
  }
  const diagnosticIdentity = await readIdentity(diagnosticConnection);
  const routedDiagnosticUsername = normalizeSalesforceIdentity(diagnosticUsername ?? '');
  const liveDiagnosticUsername = normalizeSalesforceIdentity(diagnosticIdentity.username ?? '');
  if (routedDiagnosticUsername.length === 0 || routedDiagnosticUsername !== liveDiagnosticUsername) {
    return failGate(
      'The get_org_limits request was answered by a different Salesforce user than the configured Diagnostic identity.',
    );
  }

  const reading = await readOrgLimits(diagnosticConnection);
  if (reading.entries === null || reading.entries.size === 0) {
    // The Tool answered successfully but the same identity cannot reproduce the reading. That is a
    // disagreement about what the org said, not a permissions fact, so it fails rather than skips.
    return failGate(
      `get_org_limits reported a successful read, but the same DIAGNOSTIC Connection could not reproduce it (${reading.observed}).`,
    );
  }
  const orgEntries = reading.entries;

  const limits = recordOf(output.limits);
  const highlights = recordOf(output.highlights);
  if (limits === undefined) return failGate('get_org_limits returned no limits map.');
  if (highlights === undefined) return failGate('get_org_limits returned no highlights.');

  // The Tool call and the reference read above are two live reads of a counter that the gate's own
  // API traffic consumes, so `DailyApiRequests.remaining` cannot hold the same value in both and a
  // strict comparison would fail a correct Tool on any org that is in use. The comparison is split
  // by what is allowed to move:
  //
  // - `max` is a quota ceiling. It does not move, so it is compared strictly, always.
  // - The Tool's `used` is first checked against its *own* `max - remaining`. That check is
  //   time-independent, so an operand-order bug is still caught on a counter that moves between
  //   the two readings — which comparing against the org's later reading could not do.
  // - `remaining` and `used` are then compared against the org's reading, and any disagreement is
  //   re-measured once against a fresh reference read. A value the org itself did not move between
  //   those two readings is stable and must still match exactly; a value that did move is in flight
  //   and only `max` is asserted for it. What was waived for that reason is reported as
  //   `toleratedMoves`, so the waiver is evidence rather than silence.
  type LimitBound = 'max' | 'remaining' | 'used';
  type LimitMismatch = Readonly<{ key: string; bound: LimitBound; text: string }>;

  const orgValue = (entries: OrgLimitsReadingEntries, key: string, bound: LimitBound): number | null => {
    const entry = entries.get(key);
    if (entry === undefined) return null;
    if (bound === 'max') return entry.max;
    if (bound === 'remaining') return entry.remaining;
    return entry.max !== null && entry.remaining !== null && entry.max >= entry.remaining
      ? entry.max - entry.remaining
      : null;
  };

  // Time-independent: a Tool whose `used` is not its own `max - remaining` is wrong whatever the org
  // is doing, so this runs before any comparison against the reference reading.
  const selfInconsistent = Object.entries(limits).flatMap(([key, value]) => {
    const entry = recordOf(value);
    if (entry === undefined) return [];
    const max = typeof entry.max === 'number' ? entry.max : null;
    const remaining = typeof entry.remaining === 'number' ? entry.remaining : null;
    if (entry.used !== null && typeof entry.used !== 'number') {
      return [`${key}.used: tool=${JSON.stringify(entry.used)} is neither a number nor null`];
    }
    const expected = max !== null && remaining !== null && max >= remaining ? max - remaining : null;
    return entry.used === expected
      ? []
      : [`${key}.used: tool=${JSON.stringify(entry.used)} is not its own max-remaining=${JSON.stringify(expected)}`];
  });

  const entryMismatchesFor = (entries: OrgLimitsReadingEntries): readonly LimitMismatch[] =>
    Object.entries(limits).flatMap(([key, value]) => {
      const org = entries.get(key);
      if (org === undefined) return [{ key, bound: 'max' as const, text: `${key} is not a key the org reported` }];
      const entry = recordOf(value);
      if (entry === undefined) return [{ key, bound: 'max' as const, text: `${key} is not an object` }];
      return (['max', 'remaining', 'used'] as const).flatMap((bound) => {
        const expected = orgValue(entries, key, bound);
        return entry[bound] === expected
          ? []
          : [{ key, bound, text: `${key}.${bound}: tool=${JSON.stringify(entry[bound])} org=${JSON.stringify(expected)}` }];
      });
    });

  // A slot the Tool reports as absent is a claim about the org, so it is checked the same way a
  // number is: `present: false` is only honest when no key this Tool would have read is there.
  const highlightMismatchesFor = (entries: OrgLimitsReadingEntries): readonly LimitMismatch[] =>
    ORG_LIMIT_HIGHLIGHT_SLOTS.flatMap((slot): readonly LimitMismatch[] => {
      const highlight = recordOf(highlights[slot]);
      if (highlight === undefined) return [{ key: slot, bound: 'max', text: `${slot} is missing from highlights` }];
      const key = typeof highlight.key === 'string' && highlight.key.length > 0 ? highlight.key : null;
      if (highlight.present !== true) {
        const orgAliasKeys = ORG_LIMIT_HIGHLIGHT_ALIASES[slot].filter((candidate) => entries.has(candidate));
        return key === null && highlight.max === null && highlight.remaining === null && orgAliasKeys.length === 0
          ? []
          : [{ key: slot, bound: 'max', text: `${slot}: reported absent, but the org reports ${orgAliasKeys.join(', ') || String(key)}` }];
      }
      if (key === null) return [{ key: slot, bound: 'max', text: `${slot}: present without naming the key that filled it` }];
      if (!entries.has(key)) return [{ key: slot, bound: 'max', text: `${slot}: key ${key} is not a key the org reported` }];
      return (['max', 'remaining'] as const).flatMap((bound) => {
        const expected = orgValue(entries, key, bound);
        return highlight[bound] === expected
          ? []
          : [{ key, bound, text: `${slot} (${key}).${bound}: tool=${JSON.stringify(highlight[bound])} org=${JSON.stringify(expected)}` }];
      });
    });

  const firstPass = [...entryMismatchesFor(orgEntries), ...highlightMismatchesFor(orgEntries)];
  // Only a disagreement is worth a second reference read: the PASS path stays one reading.
  const reread = firstPass.length === 0 ? null : await readOrgLimits(diagnosticConnection);
  const orgAfter = reread?.entries ?? orgEntries;
  // A value is only "in flight" when both readings report the key and the org moved it. A key that
  // vanished from the second reading is not movement, so it keeps its mismatch and still fails.
  const movedBetweenReadings = (mismatch: LimitMismatch): boolean => mismatch.bound !== 'max'
    && orgEntries.has(mismatch.key) && orgAfter.has(mismatch.key)
    && orgValue(orgAfter, mismatch.key, mismatch.bound) !== orgValue(orgEntries, mismatch.key, mismatch.bound);

  const afterReread = [...entryMismatchesFor(orgAfter), ...highlightMismatchesFor(orgAfter)];
  const entryMismatches = [
    ...afterReread.filter((mismatch) => !movedBetweenReadings(mismatch)).map((mismatch) => mismatch.text),
    ...selfInconsistent,
  ];
  const toleratedMoves = [...new Set(
    [...firstPass, ...afterReread].filter(movedBetweenReadings).map((mismatch) => mismatch.text),
  )];

  const returnedLimits = Object.keys(limits).length;
  const orgMeasured = [...orgEntries.values()].filter((entry) => entry.max !== null || entry.remaining !== null).length;
  const facts = output.totalLimits === orgEntries.size
    && output.returnedLimits === returnedLimits
    && output.unreadableLimits === orgEntries.size - orgMeasured
    && output.truncated === (returnedLimits < orgEntries.size)
    && (output.truncated !== true || typeof output.hint === 'string')
    && sameArray(Object.keys(highlights), [...ORG_LIMIT_HIGHLIGHT_SLOTS]);

  // `verbose` may change what the text says, never which limits come back — but the second call is
  // a second live read, so a *value* may legitimately move between them (an API allowance ticking
  // down). What the contract fixes is the key set, and that is what is compared.
  const verboseResult = await call(client, results, 'get_org_limits', { verbose: true });
  const verboseOutput = outputOf(verboseResult);
  const verboseLimits = recordOf(verboseOutput?.limits);
  const verboseFacts = verboseOutput?.success === true
    && verboseOutput.executionRole === 'DIAGNOSTIC'
    && verboseOutput.verbose === true
    && output.verbose === false
    && verboseLimits !== undefined
    && sameArray(Object.keys(verboseLimits).sort(), Object.keys(limits).sort());

  return gate(
    entryMismatches.length === 0 && facts && verboseFacts,
    {
      executionRole: output.executionRole,
      referenceIdentity: liveDiagnosticUsername,
      orgLimitCount: orgEntries.size,
      orgMeasuredCount: orgMeasured,
      // The org's own key names are org configuration, not credentials, and naming them is what
      // makes this gate's evidence checkable.
      orgKeys: [...orgEntries.keys()].slice(0, 20),
      returnedLimits,
      unreadableLimits: output.unreadableLimits,
      truncated: output.truncated,
      highlightSlots: Object.keys(highlights),
      presentSlots: ORG_LIMIT_HIGHLIGHT_SLOTS.filter((slot) => recordOf(highlights[slot])?.present === true),
      verbose: { reported: verboseOutput?.verbose, defaultReported: output.verbose, keySetUnchanged: verboseFacts },
      referenceReread: reread === null ? 'not needed' : reread.observed,
      entryMismatches: entryMismatches.slice(0, 10),
      // Counters the org itself moved between the two reference readings. Asserted on `max` only,
      // and listed here so the waiver is visible instead of being an invisible tolerance.
      toleratedMoves: toleratedMoves.slice(0, 10),
    },
    'get_org_limits disagreed with the org\'s own limits reading.',
  );
}

type OrgLimitsReadingEntries = ReadonlyMap<string, Readonly<{ max: number | null; remaining: number | null }>>;

type OrgLimitsReading = Readonly<{
  entries: OrgLimitsReadingEntries | null;
  observed: string;
}>;

/**
 * Reads the org's own limits through the live Connection, keeping only what an independent check
 * needs: the key set and the two numbers.
 *
 * Only the Salesforce error *code* is carried out on a refusal, never its message, so no org text
 * reaches the report — the same rule `readCount` follows.
 */
async function readOrgLimits(connection: Connection): Promise<OrgLimitsReading> {
  try {
    const payload = await connection.limits() as unknown;
    const record = recordOf(payload);
    if (record === undefined) return Object.freeze({ entries: null, observed: 'a payload that is not a limit map' });
    const entries = new Map<string, Readonly<{ max: number | null; remaining: number | null }>>();
    for (const [key, value] of Object.entries(record)) {
      if (key.length === 0) continue;
      const entry = recordOf(value);
      entries.set(key, Object.freeze({
        max: numberOrNull(entry?.Max),
        remaining: numberOrNull(entry?.Remaining),
      }));
    }
    return Object.freeze({ entries, observed: `a map of ${entries.size} limits` });
  } catch (error) {
    return Object.freeze({
      entries: null,
      observed: `${salesforceErrorCodeOf(error) ?? 'no Salesforce error code'}`,
    });
  }
}

/**
 * Cross-checks `search_records` against the org's own answer to the same statement.
 *
 * SOSL reports no total and hands out no cursor (findings §2), so nothing in the payload can be
 * compared to itself: the only independent reference is the org's own record list for the exact
 * statement the Tool reported sending. Two probes follow — an unscoped keyword search held to the
 * Tool's maximum limit, and the same term scoped to one object — and each is judged against the
 * org's count, not the Tool's.
 *
 * The term itself never reaches the report. It is read from a real record of the org, and an org's
 * customer data is not this gate's to publish: only its length, the field it came from and the
 * counts are recorded, which is what keeps the evidence checkable without carrying the data.
 */
async function runSearchRecords(
  client: Client,
  results: CallToolResult[],
  connection: Connection,
  objectApiName: string,
  advertisedNames: readonly string[],
): Promise<P9LiveGate> {
  const term = await readSearchTerm(connection, objectApiName);
  if (term === null) {
    return notTested(
      `No search term of at least two characters could be read from a ${objectApiName} record's `
      + `${SEARCH_TERM_FIELDS.join(' or ')} field, so a live SOSL search cannot be derived for this object.`,
    );
  }
  const scopedFields = ['Id', term.field];
  const probes: readonly SearchProbeRequest[] = [
    {
      label: 'unscoped',
      statement: expectedKeywordStatement(term.value, [], [], SEARCH_RECORDS_MAX_LIMIT),
      limit: SEARCH_RECORDS_MAX_LIMIT,
      argumentsValue: { search: term.value, limit: SEARCH_RECORDS_MAX_LIMIT },
      scopedTo: null,
    },
    {
      label: 'scoped',
      statement: expectedKeywordStatement(term.value, [objectApiName], scopedFields, SEARCH_RECORDS_MAX_LIMIT),
      limit: SEARCH_RECORDS_MAX_LIMIT,
      argumentsValue: {
        search: term.value,
        objects: [objectApiName],
        fields: scopedFields,
        limit: SEARCH_RECORDS_MAX_LIMIT,
      },
      scopedTo: objectApiName,
    },
  ];

  const probeDetails: Readonly<Record<string, unknown>>[] = [];
  const mismatches: string[] = [];
  for (const probe of probes) {
    const reading = await readSearchCount(connection, probe.statement);
    if (reading.count === null) {
      return notTested(
        `${probe.label}: the org refused the same SOSL statement with ${reading.observed}, so this probe is not a PASS.`,
      );
    }
    const probeResult = await call(client, results, 'search_records', probe.argumentsValue);
    const output = outputOf(probeResult);
    if (output === undefined) return failGate(`search_records returned no structured content (${probe.label}).`);
    if (output.success !== true) {
      const code = String(output.errorCode ?? 'no error code');
      // A transient platform fault is a real SOSL outcome (findings §7) and not a defect in the
      // Tool, so it makes the probe untestable rather than failed.
      if (code === 'MCP_SEARCH_RECORDS_FAILED' && output.salesforceErrorCode === 'SERVER_UNAVAILABLE') {
        return notTested(
          `${probe.label}: Salesforce answered the search with SERVER_UNAVAILABLE, which the findings record as transient.`,
        );
      }
      return failGate(`search_records failed live (${probe.label}): ${code}.`);
    }
    const check = crossCheckSearchOutput(output, probe, reading.count, advertisedNames);
    probeDetails.push(check.detail);
    mismatches.push(...check.mismatches.map((entry) => `${probe.label}.${entry}`));
  }

  return gate(
    mismatches.length === 0,
    {
      objectApiName,
      termLength: term.value.length,
      termField: term.field,
      probes: probeDetails,
      mismatches: mismatches.slice(0, 10),
    },
    'search_records completeness, grouping or truncation declaration disagreed with the org.',
  );
}

type SearchTerm = Readonly<{ value: string; field: string }>;

/** Record text fields a search term can be read from, in the order they are tried. */
const SEARCH_TERM_FIELDS: readonly string[] = Object.freeze(['Name', 'Subject']);

/**
 * The live search term: the longest run of letters and digits in one record's own text field.
 *
 * Reducing a field value to a single alphanumeric token keeps the gate's prediction of the composed
 * statement exact — such a term can never need escaping, so a difference between the statement the
 * Tool reported and the one predicted here is a defect rather than a difference of opinion about
 * SOSL's reserved characters. The escaping table itself is pinned byte for byte by the unit layer,
 * which is where it belongs.
 */
async function readSearchTerm(connection: Connection, objectApiName: string): Promise<SearchTerm | null> {
  for (const field of SEARCH_TERM_FIELDS) {
    let payload: Readonly<Record<string, unknown>>;
    try {
      payload = await connection.query(
        `SELECT Id, ${field} FROM ${objectApiName} LIMIT 1`,
      ) as unknown as Readonly<Record<string, unknown>>;
    } catch {
      // The object may not have this field at all (Case and Task have no Name), which is a fact
      // about the object rather than a gate failure: try the next one.
      continue;
    }
    const first = readArray(payload.records)[0];
    const raw = first === undefined ? undefined : first[field];
    if (typeof raw !== 'string') continue;
    const token = longestAlphanumericToken(raw);
    if (token === null) continue;
    return Object.freeze({ value: token, field });
  }
  return null;
}

function longestAlphanumericToken(value: string): string | null {
  const tokens = value.split(/\s+/u)
    .map((entry) => entry.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter((entry) => entry.length >= 2);
  return tokens.length === 0
    ? null
    : tokens.reduce((left, right) => (right.length > left.length ? right : left));
}

/** The statement `search_records` composes for a bare keyword, as its own contract documents it. */
function expectedKeywordStatement(
  term: string,
  objects: readonly string[],
  fields: readonly string[],
  limit: number,
): string {
  const scope = objects.length === 0
    ? ''
    : ` RETURNING ${objects.map((name) => `${name}(${fields.join(', ')})`).join(', ')}`;
  return `FIND {${term}} IN ALL FIELDS${scope} LIMIT ${limit}`;
}

type SearchProbeRequest = Readonly<{
  label: string;
  statement: string;
  limit: number;
  argumentsValue: Readonly<Record<string, unknown>>;
  /** The one object this probe was scoped to, or null when it was unscoped. */
  scopedTo: string | null;
}>;

type SearchReading = Readonly<{ count: number | null; observed: string }>;

/**
 * The org's own count for one SOSL statement, read over the live Connection.
 *
 * SOSL answers with records and nothing else, so the count *is* the whole of what can be compared.
 * A refusal carries only its Salesforce code, never its message.
 */
async function readSearchCount(connection: Connection, statement: string): Promise<SearchReading> {
  try {
    const payload = await connection.search(statement) as unknown as Readonly<Record<string, unknown>>;
    const records = readArray(payload.searchRecords);
    return Object.freeze({ count: records.length, observed: `the org returned ${records.length} records` });
  } catch (error) {
    return Object.freeze({
      count: null,
      observed: `${salesforceErrorCodeOf(error) ?? 'no Salesforce error code'}`,
    });
  }
}

/**
 * Everything the Tool's own contract commits it to, checked against the org's count.
 *
 * The truncation declaration is re-derived here rather than read back: a result is truncated exactly
 * when the cap was reached, a readable per-object cap was reached, or the response budget cut the
 * payload — and the reason names the constraint that bound the *returned* slice, in that precedence.
 * `complete` is then re-derived from the same facts, so a Tool that claimed more than its own
 * numbers support fails rather than passes.
 */
function crossCheckSearchOutput(
  output: Readonly<Record<string, unknown>>,
  probe: SearchProbeRequest,
  orgCount: number,
  advertisedNames: readonly string[],
): Readonly<{ detail: Readonly<Record<string, unknown>>; mismatches: readonly string[] }> {
  const mismatches: string[] = [];
  const groups = recordOf(output.resultsByObject) ?? {};
  const groupNames = Object.keys(groups);
  const groupOf = (name: string): Readonly<Record<string, unknown>> => recordOf(groups[name]) ?? {};
  const counts = groupNames.map((name) => numberOrNull(groupOf(name).count) ?? -1);
  const returnedCounts = groupNames.map((name) => numberOrNull(groupOf(name).returnedCount) ?? -1);
  const sumCounts = counts.reduce((total, value) => total + value, 0);
  const sumReturned = returnedCounts.reduce((total, value) => total + value, 0);
  const anyAtLimit = groupNames.some((name) => groupOf(name).atLimit === true);
  // The budget cut is measured against what Salesforce returned, not against `totalReturned`: a
  // record whose object type could not be read is counted in `totalReturned` and listed nowhere, so
  // the two only coincide when every record was classifiable.
  const budgetCut = sumReturned < sumCounts;
  const effectiveLimit = numberOrNull(output.effectiveLimit);
  const totalReturned = numberOrNull(output.totalReturned) ?? -1;
  const limitReached = effectiveLimit !== null && totalReturned >= effectiveLimit;
  const expectedTruncated = limitReached || anyAtLimit || budgetCut;
  const expectedReason = budgetCut
    ? 'RESPONSE_BUDGET'
    : limitReached
      ? 'LIMIT_REACHED'
      : anyAtLimit
        ? 'PER_OBJECT_LIMIT'
        : null;
  const unreadable = numberOrNull(output.unreadableRecords) ?? -1;
  const expectedComplete = !expectedTruncated && unreadable === 0 && effectiveLimit !== null
    && totalReturned < effectiveLimit;
  const hint = typeof output.hint === 'string' ? output.hint : '';
  const namedTools = HINT_TOOL_CANDIDATES.filter((name) => hint.includes(name));
  const misfiled = groupNames.flatMap((name) => readArray(groupOf(name).records)
    .filter((record) => readRecordObjectType(record) !== name)
    .map(() => name));

  const check = (condition: boolean, message: string): void => {
    if (!condition) mismatches.push(message);
  };
  check(output.executionRole === 'USER', `executionRole=${String(output.executionRole)}`);
  check(output.mode === 'KEYWORD', `mode=${String(output.mode)}`);
  check(output.statement === probe.statement, 'the statement sent is not the one this gate predicted for the input');
  check(output.limitSource === 'REQUEST', `limitSource=${String(output.limitSource)}`);
  check(effectiveLimit === probe.limit, `effectiveLimit=${String(output.effectiveLimit)} for limit=${probe.limit}`);
  check(totalReturned === orgCount, `totalReturned=${totalReturned} but the org returned ${orgCount} for the same statement`);
  check(output.returnedCount === sumReturned, `returnedCount=${String(output.returnedCount)} but the groups hold ${sumReturned}`);
  check(output.objectsReturned === groupNames.length, `objectsReturned=${String(output.objectsReturned)} for ${groupNames.length} groups`);
  check(output.truncated === expectedTruncated, `truncated=${String(output.truncated)} but the facts imply ${expectedTruncated}`);
  check(output.truncatedReason === expectedReason, `truncatedReason=${String(output.truncatedReason)} but the facts imply ${String(expectedReason)}`);
  check(output.complete === expectedComplete, `complete=${String(output.complete)} but the facts imply ${expectedComplete}`);
  check(output.truncated !== true || hint.length > 0, 'a truncated result carried no hint');
  check(namedTools.every((name) => advertisedNames.includes(name)), `the hint names unadvertised Tools: ${namedTools.filter((name) => !advertisedNames.includes(name)).join(', ')}`);
  check(misfiled.length === 0, `records filed under an object their own attributes.type does not name: ${misfiled.slice(0, 5).join(', ')}`);
  if (probe.scopedTo !== null) {
    check(
      groupNames.length === 1 && groupNames[0] === probe.scopedTo,
      `a search scoped to ${probe.scopedTo} returned ${groupNames.join(', ') || 'no'} groups`,
    );
  }

  return Object.freeze({
    detail: Object.freeze({
      limit: probe.limit,
      orgCount,
      mode: output.mode,
      statementMatchesPrediction: output.statement === probe.statement,
      groups: groupNames,
      totalReturned,
      returnedCount: output.returnedCount,
      unreadableRecords: output.unreadableRecords,
      objectsReturned: output.objectsReturned,
      effectiveLimit,
      limitSource: output.limitSource,
      truncated: output.truncated,
      truncatedReason: output.truncatedReason,
      complete: output.complete,
      budgetCut,
      limitReached,
      anyAtLimit,
      hintPresent: hint.length > 0,
      toolNamesInHint: namedTools,
    }),
    mismatches: Object.freeze(mismatches),
  });
}

/** The object a record was filed under, as Salesforce labelled it on the record itself. */
function readRecordObjectType(record: Readonly<Record<string, unknown>>): string | null {
  const attributes = recordOf(record.attributes);
  const type = attributes?.type ?? attributes?.sobjectType;
  return typeof type === 'string' && type.length > 0 ? type : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

/**
 * Cross-checks the Bulk API 2.0 export pair against the org's own row count.
 *
 * This is the one P9 gate whose evidence cannot be produced any other way. Every other Data Tool
 * answers inside one response, so its completeness claim can be compared to the org's own reading
 * of the same question. An export is deliberately *not* one response: the caller holds the job Id
 * and the cursor, and the only proof that the loop it drives really delivered every row is that
 * the rows it summed equal a count the loop did not produce. So the gate:
 *
 * 1. reads `COUNT(Id)` over the live Connection — the independent reference — and refuses to pass
 *    below the row floor this run applies (`BULK_EXPORT_MINIMUM_ROWS`, or `P9_LIVE_BULK_MIN_ROWS`
 *    when the org cannot supply the planned one), because a short result set cannot distinguish a
 *    correct walk from one that ends early;
 * 2. submits the export through `submit_bulk_query` and holds the returned `jobId`;
 * 3. polls `get_bulk_query_results` until the platform reaches `JobComplete`, asserting that the
 *    running states make **no** completeness claim at all (`locator`/`hasMore`/`complete` are
 *    omitted rather than reported false);
 * 4. walks the cursor to exhaustion, asserting on every page that the Tool's own fields agree with
 *    each other, that the page is not shortened, and that the platform's `numberRecordsProcessed`
 *    is the whole job's count rather than the page's;
 * 5. compares the summed `returnedCount` with the `COUNT(Id)` it read first.
 *
 * A Bulk query job is executed by Salesforce asynchronously, so an org that is slow to run one
 * makes this gate untestable rather than failed — as does a job the platform ends itself. Both
 * are reported as NOT TESTED naming the reason, because neither is a fact about the Tool.
 */
async function runBulkQuery(
  client: Client,
  results: CallToolResult[],
  connection: Connection,
  objectApiName: string,
  advertisedNames: readonly string[],
  minimumRows: Readonly<{ rows: number; source: 'plan' | typeof BULK_MINIMUM_ROWS_VARIABLE }>,
): Promise<P9LiveGate> {
  const reading = await readCount(connection, objectApiName);
  const orgCount = reading.count;
  if (orgCount === null) {
    return notTested(
      `COUNT() of ${objectApiName} returned no row count — ${reading.observed} — `
      + 'so an export cannot be cross-checked against the org.',
    );
  }
  if (orgCount < minimumRows.rows) {
    return notTested(
      `${objectApiName} holds ${orgCount} rows, below the ${minimumRows.rows}-row floor this run applies `
      + `(from ${minimumRows.source === 'plan' ? "the P9 plan's T4 acceptance" : minimumRows.source}): `
      + 'a small result set reaches its last page in a couple of calls, so summing the pages would prove nothing '
      + `about the walk. Point ${BULK_OBJECT_VARIABLE} at an object of at least ${minimumRows.rows} rows, or lower `
      + `${BULK_MINIMUM_ROWS_VARIABLE} to a floor this org can actually supply.`,
      {
        objectApiName,
        orgCount,
        minimumRows: minimumRows.rows,
        minimumRowsSource: minimumRows.source,
        plannedMinimumRows: BULK_EXPORT_MINIMUM_ROWS,
      },
    );
  }

  const statement = `SELECT Id FROM ${objectApiName}`;
  const pageSize = BULK_QUERY_RESULTS_DEFAULT_MAX_RECORDS;
  const submits = await call(client, results, 'submit_bulk_query', { query: statement });
  const submitOutput = outputOf(submits);
  if (submitOutput === undefined) return failGate('submit_bulk_query returned no structured content.');
  // A standard object the org declares unused is refused by design before any Salesforce call;
  // that is the guard working, not the gate failing.
  if (submitOutput.errorCode === 'MCP_SOBJECT_NOT_IN_USE') {
    return notTested(
      `${objectApiName} is declared not in use in this org, so submit_bulk_query refuses it by design: ${String(submitOutput.message)}`,
    );
  }
  if (submitOutput.errorCode === 'MCP_BULK_LIMIT_EXCEEDED') {
    return notTested(
      `The org refused the Bulk submission because its API allowance is exhausted: ${String(submitOutput.message)}`,
    );
  }
  if (submitOutput.success !== true) {
    return failGate(`submit_bulk_query failed live: ${String(submitOutput.errorCode ?? 'no error code')}.`);
  }

  const jobId = typeof submitOutput.jobId === 'string' ? submitOutput.jobId : '';
  const submitState = typeof submitOutput.state === 'string' ? submitOutput.state : null;
  const submitApiUsage = apiUsageShapeOf(submitOutput.apiUsage);
  // The submission's own contract: it says which operation it created (always `query`, because
  // there is no input that could express another), it names a job whose Id could be handed back,
  // and it reports the org's counter rather than a pre-flight reading it cannot make.
  const submitFacts = submitOutput.executionRole === 'USER'
    && submitOutput.operation === 'query'
    && SALESFORCE_ID.test(jobId)
    && typeof submitOutput.apiVersion === 'string' && submitOutput.apiVersion.length > 0
    && (submitState === null || submitState.length > 0)
    && submitApiUsage !== 'invalid';

  const startedAt = Date.now();
  const pageBudget = Math.ceil(orgCount / pageSize) + BULK_EXPORT_PAGE_MARGIN;
  const pendingMismatches: string[] = [];
  const pageDetails: Readonly<Record<string, unknown>>[] = [];
  const mismatches: string[] = [...(submitFacts ? [] : ['the submission did not satisfy its own declared contract'])];
  const check = (condition: boolean, message: string): void => {
    if (!condition) mismatches.push(message);
  };

  // The job is asynchronous, so the first readable page arrives from whichever poll first sees
  // `JobComplete` — there is no separate "wait, then read" step, and a poll that reports a
  // running state must claim nothing about rows.
  let page: Readonly<Record<string, unknown>> | null = null;
  let polls = 0;
  let pendingStates = 0;
  let lastState: string | null = submitState;
  let apiUsage: ApiUsageShape = submitApiUsage;
  while (page === null && polls < BULK_EXPORT_MAX_POLLS) {
    polls += 1;
    const polled = await call(client, results, 'get_bulk_query_results', { jobId });
    const output = outputOf(polled);
    if (output === undefined) return failGate('get_bulk_query_results returned no structured content.');
    if (output.errorCode === 'MCP_BULK_LIMIT_EXCEEDED') {
      return notTested(
        `The org refused a Bulk read because its API allowance is exhausted: ${String(output.message)}`,
        { jobId, polls },
      );
    }
    if (output.success !== true) {
      return failGate(`get_bulk_query_results failed live: ${String(output.errorCode ?? 'no error code')}.`);
    }
    apiUsage = mergeApiUsage(apiUsage, apiUsageShapeOf(output.apiUsage));
    lastState = typeof output.state === 'string' ? output.state : null;
    if (lastState === 'Failed' || lastState === 'Aborted') {
      return notTested(
        `Salesforce ended the Bulk query job as ${lastState}, so there is no result set to page: `
        + `${typeof output.stateMessage === 'string' ? output.stateMessage : 'no reason was reported'}.`,
        { jobId, state: lastState, polls },
      );
    }
    if (lastState === 'JobComplete') {
      page = output;
      break;
    }
    // Running states make no completeness claim: `locator`, `hasMore` and `complete` are absent
    // rather than false, because "there is no next page" and "there are no rows yet" are the same
    // shape to a caller that reads only the fields.
    pendingStates += 1;
    pendingMismatches.push(...pendingShapeMismatches(output));
    await sleep(BULK_EXPORT_POLL_INTERVAL_MS);
  }
  if (page === null) {
    return failGate(
      `The Bulk query job did not reach JobComplete within ${BULK_EXPORT_MAX_POLLS} polls `
      + `(last state ${String(lastState)}).`,
    );
  }

  let requestedLocator: string | null = null;
  let cumulative = 0;
  let pagesRead = 0;
  let totalRecords: number | null = null;
  let exhaustingPage: Readonly<Record<string, unknown>> | null = null;
  while (page !== null) {
    pagesRead += 1;
    const records = readArray(page.records);
    const returnedCount = integerOf(page.returnedCount);
    const nextLocator = typeof page.locator === 'string' && page.locator.length > 0 ? page.locator : null;
    const hasMore = page.hasMore === true;
    const pageTotal = integerOf(page.totalRecords);
    cumulative += returnedCount > 0 ? returnedCount : 0;
    totalRecords = pageTotal > 0 ? pageTotal : totalRecords;
    apiUsage = mergeApiUsage(apiUsage, apiUsageShapeOf(page.apiUsage));

    check(page.executionRole === 'USER', `page ${pagesRead}: executionRole=${String(page.executionRole)}`);
    check(page.state === 'JobComplete', `page ${pagesRead}: state=${String(page.state)}`);
    check(returnedCount === records.length, `page ${pagesRead}: returnedCount=${String(page.returnedCount)} for ${records.length} rows`);
    check(returnedCount >= 0 && returnedCount <= pageSize, `page ${pagesRead}: returnedCount=${String(page.returnedCount)} against a requested ${pageSize}`);
    // A page that fits the budget is returned whole, so its row count is what Salesforce served.
    // The counter is the *whole job's* processed count — the platform's own number — which is why
    // it is compared against the `COUNT()` read before the export rather than against the page.
    check(pageTotal === orgCount, `page ${pagesRead}: totalRecords=${String(page.totalRecords)} but the org holds ${orgCount} rows`);
    // `numberRecordsProcessed` is the same platform counter under its own name, and a query job
    // does not always report it — so it is held to the org's count when it is reported at all,
    // rather than making the gate fail on an absent value the Tool is right to pass through.
    check(
      typeof page.numberRecordsProcessed !== 'number' || page.numberRecordsProcessed === orgCount,
      `page ${pagesRead}: numberRecordsProcessed=${String(page.numberRecordsProcessed)} but the org holds ${orgCount} rows`,
    );
    check(
      page.numberRecordsFailed === 0 || page.numberRecordsFailed === null || page.numberRecordsFailed === undefined,
      `page ${pagesRead}: numberRecordsFailed=${String(page.numberRecordsFailed)}`,
    );
    check(hasMore === (nextLocator !== null), `page ${pagesRead}: hasMore=${String(page.hasMore)} with locator=${nextLocator === null ? 'null' : 'present'}`);
    check(page.complete === !hasMore, `page ${pagesRead}: complete=${String(page.complete)} with hasMore=${String(page.hasMore)}`);
    check(!hasMore || typeof page.locator === 'string', `page ${pagesRead}: hasMore with a locator that is not a string`);
    check(hasMore || page.locator === null, `page ${pagesRead}: the last page's locator is ${JSON.stringify(page.locator)} rather than null`);
    check(records.length === 0 || records.every(isCsvRow), `page ${pagesRead}: a row carried a value that is not a string, which Bulk API 2.0 CSV results cannot produce`);
    check(typeof page.hint === 'string' && page.hint.length > 0, `page ${pagesRead}: no hint was returned`);
    const hint = typeof page.hint === 'string' ? page.hint : '';
    const namedTools = BULK_HINT_TOOL_CANDIDATES.filter((name) => hint.includes(name));
    check(namedTools.every((name) => advertisedNames.includes(name)), `page ${pagesRead}: the hint names unadvertised Tools: ${namedTools.filter((name) => !advertisedNames.includes(name)).join(', ')}`);
    if (hasMore) {
      // A cursor is a position, not an offset: a page that hands back the cursor it was given has
      // made no progress, and the walk below would never terminate.
      check(nextLocator !== requestedLocator, `page ${pagesRead}: the cursor did not advance`);
    }
    pageDetails.push(Object.freeze({
      page: pagesRead,
      requestedLocator: requestedLocator === null ? null : 'present',
      returnedCount,
      cumulative,
      hasMore,
      complete: page.complete,
      totalRecords: page.totalRecords,
      numberRecordsProcessed: page.numberRecordsProcessed,
      hintNamesTools: namedTools,
    }));

    if (!hasMore) {
      exhaustingPage = page;
      break;
    }
    if (pagesRead >= pageBudget) {
      return failGate(
        `The Bulk result walk read ${pagesRead} pages without exhausting a ${orgCount}-row result set at ${pageSize} rows per page.`,
      );
    }
    requestedLocator = nextLocator;
    const next = await call(client, results, 'get_bulk_query_results', {
      jobId,
      locator: nextLocator,
      maxRecords: pageSize,
    });
    const nextOutput = outputOf(next);
    if (nextOutput === undefined) return failGate('get_bulk_query_results returned no structured content.');
    if (nextOutput.success !== true) {
      return failGate(`get_bulk_query_results failed live on page ${pagesRead + 1}: ${String(nextOutput.errorCode ?? 'no error code')}.`);
    }
    page = nextOutput;
  }

  check(pendingMismatches.length === 0, `a running job claimed a completeness it could not have: ${pendingMismatches.slice(0, 3).join('; ')}`);
  // The cross-check the gate exists for: what the caller's loop summed, against a count the loop
  // never participated in producing.
  check(cumulative === orgCount, `the walk returned ${cumulative} rows but the org's own COUNT(Id) is ${orgCount}`);
  check(totalRecords === orgCount, `the job reported ${String(totalRecords)} rows in total but the org's own COUNT(Id) is ${orgCount}`);
  check(exhaustingPage?.complete === true, 'the walk ended without a page declaring the result set complete');
  check(exhaustingPage?.locator === null, `the final page carried a cursor (${String(exhaustingPage?.locator)}) alongside complete`);

  const elapsedMs = Date.now() - startedAt;
  return gate(mismatches.length === 0, {
    objectApiName,
    statement,
    orgCount,
    minimumRows: minimumRows.rows,
    minimumRowsSource: minimumRows.source,
    // The plan's own floor, carried even on a relaxed run so the report states both scales: a PASS
    // under `minimumRowsSource: P9_LIVE_BULK_MIN_ROWS` must never read as a PASS at 100 000 rows.
    plannedMinimumRows: BULK_EXPORT_MINIMUM_ROWS,
    executionRole: submitOutput.executionRole,
    operation: submitOutput.operation,
    jobId,
    apiVersion: submitOutput.apiVersion,
    submittedState: submitState,
    polls,
    runningStatesObserved: pendingStates,
    pages: pagesRead,
    rowsSummedAcrossPages: cumulative,
    totalRecords,
    pageSize,
    elapsedMs,
    // The quota fact the responses themselves carried — `Sforce-Limit-Info`, as the org reported
    // it. There is no pre-flight (ADR-0027 option (b)), so this is the only allowance evidence a
    // Bulk run produces.
    apiUsage,
    pageDetails: pageDetails.slice(0, 6),
    mismatches: mismatches.slice(0, 10),
  }, 'The Bulk export walk, its page contract or its row-count cross-check disagreed with the org.');
}

/**
 * The claims a still-running Bulk job must **not** be making.
 *
 * Reported as a list rather than a boolean so a failure names which field was invented. The
 * three omitted fields are the whole point: an Agent that reads `complete: false` off a job that
 * has simply not finished yet concludes the export is truncated, and one that reads `locator:
 * null` concludes it is done.
 */
function pendingShapeMismatches(output: Readonly<Record<string, unknown>>): string[] {
  const state = typeof output.state === 'string' ? output.state : 'unknown';
  return [
    ...(output.locator === undefined ? [] : [`${state}: locator was reported (${JSON.stringify(output.locator)}) before the job completed`]),
    ...(output.hasMore === undefined ? [] : [`${state}: hasMore was reported (${JSON.stringify(output.hasMore)}) before the job completed`]),
    ...(output.complete === undefined ? [] : [`${state}: complete was reported (${JSON.stringify(output.complete)}) before the job completed`]),
    ...(readArray(output.records).length === 0 ? [] : [`${state}: rows were returned before the job completed`]),
    ...(integerOf(output.returnedCount) === 0 ? [] : [`${state}: returnedCount=${String(output.returnedCount)} before the job completed`]),
    ...(output.totalRecords === null ? [] : [`${state}: totalRecords=${String(output.totalRecords)} before the job completed`]),
    ...(typeof output.hint === 'string' && output.hint.length > 0 ? [] : [`${state}: no hint was returned`]),
  ];
}

/**
 * A Bulk API 2.0 CSV result row: every value a string.
 *
 * This is the one property of the wire format an Agent has to know to read the rows at all — a
 * numeric field arrives as `"42"`, not `42`, and an absent field arrives as `""` rather than
 * `null` — so the gate asserts it rather than trusting the contract note in the description.
 */
function isCsvRow(record: Readonly<Record<string, unknown>>): boolean {
  return Object.values(record).every((value) => typeof value === 'string');
}

/**
 * How a Bulk response's `Sforce-Limit-Info` counter classified: `absent` when the response
 * carried none, `valid` when it carried the documented shape, `invalid` when it carried
 * something else. Merged across a run so one malformed counter is never washed out.
 */
type ApiUsageShape = 'absent' | 'valid' | 'invalid';

/**
 * Classifies the `apiUsage` counter a Bulk response reported.
 *
 * The counter is optional by design — Salesforce does not attach `Sforce-Limit-Info` to every
 * response — so an absent one is a fact about the response rather than a defect in the Tool. A
 * present one that is not the documented three-number shape, or whose `remaining` is not its own
 * `limit - used`, is.
 */
function apiUsageShapeOf(value: unknown): ApiUsageShape {
  if (value === undefined) return 'absent';
  const entry = recordOf(value);
  if (entry === undefined) return 'invalid';
  const used = integerOf(entry.used);
  const limit = integerOf(entry.limit);
  const remaining = integerOf(entry.remaining);
  return used >= 0 && limit > 0 && remaining >= 0 && remaining === Math.max(limit - used, 0)
    ? 'valid'
    : 'invalid';
}

/** Keeps the strongest classification seen: a malformed counter is never washed out by a later one. */
function mergeApiUsage(current: ApiUsageShape, next: ApiUsageShape): ApiUsageShape {
  if (current === 'invalid' || next === 'invalid') return 'invalid';
  if (current === 'valid' || next === 'valid') return 'valid';
  return 'absent';
}

/** A Salesforce record Id, in either its 15- or 18-character form. */
const SALESFORCE_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function runSchemaSelfRepair(
  client: Client,
  results: CallToolResult[],
  objectApiName: string,
): Promise<P9LiveGate> {
  const requested = `${objectApiName}ZzP9NoSuchObject`;
  const result = await call(client, results, 'describe_sobject', { objectApiName: requested });
  const output = outputOf(result);
  if (output === undefined) return failGate('describe_sobject returned no structured content for an unknown object.');
  const suggestion = typeof output.suggestion === 'string' ? output.suggestion : '';
  return gate(
    result.isError === true
      && output.success === false
      && output.errorCode === 'MCP_SOBJECT_NOT_FOUND'
      && typeof output.salesforceErrorCode === 'string' && output.salesforceErrorCode.length > 0
      && /list_sobjects/u.test(suggestion),
    {
      requested,
      isError: result.isError === true,
      errorCode: output.errorCode,
      salesforceErrorCode: output.salesforceErrorCode,
      suggestionNamesListSobjects: /list_sobjects/u.test(suggestion),
    },
    'An unknown object did not produce an actionable self-repair result.',
  );
}

function runCredentialSafety(
  results: readonly CallToolResult[],
  clientToken: string,
  accessToken: string | null,
): P9LiveGate {
  const rendered = results.map((result) => JSON.stringify(result)).join('\n');
  const patterns: Readonly<Record<string, RegExp>> = Object.freeze({
    salesforceSessionId: /00D[A-Za-z0-9]{8,}!/u,
    bearerHeader: /\bBearer\s/u,
    jwt: /eyJ[A-Za-z0-9_-]{8,}\./u,
    privateKey: /-----BEGIN/u,
    credentialField: /(?:access_?token|refresh_?token|client_?secret|private_?key|session_?id)["']?\s*[:=]/iu,
    stackFrame: /at\s+[\w.$<>]+ \([^)]*:\d+:\d+\)/u,
    sourceFrame: /[A-Za-z0-9_-]+\.ts:\d+/u,
  });
  const matched = Object.entries(patterns)
    .filter(([, pattern]) => pattern.test(rendered))
    .map(([name]) => name);
  const containsClientToken = rendered.includes(clientToken);
  const containsAccessToken = accessToken !== null && accessToken.length > 0 && rendered.includes(accessToken);
  return gate(
    matched.length === 0 && !containsClientToken && !containsAccessToken,
    {
      // Booleans only: the tokens themselves are never echoed into the report.
      resultsInspected: results.length,
      bytesInspected: rendered.length,
      matchedPatterns: matched,
      containsClientToken,
      containsAccessToken,
    },
    'A Tool result carried credential or internal-detail material.',
  );
}

/** Reads the Connection the governed request actually opened; a missing one is a fact, not a wait. */
async function establishedConnection(factory: MeasuringConnectionFactory): Promise<Connection | null> {
  return factory.measurements.at(-1)?.connection ?? null;
}

async function call(
  client: Client,
  results: CallToolResult[],
  name: string,
  argumentsValue: Readonly<Record<string, unknown>>,
): Promise<CallToolResult> {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: argumentsValue }));
  results.push(result);
  return result;
}

function outputOf(result: CallToolResult | undefined): Record<string, unknown> | undefined {
  const structured = result?.structuredContent;
  return typeof structured === 'object' && structured !== null && !Array.isArray(structured)
    ? structured as Record<string, unknown>
    : undefined;
}

async function readIdentity(connection: Connection): Promise<Readonly<{ username: string | null }>> {
  const identity = await connection.identity() as unknown as Readonly<Record<string, unknown>>;
  return Object.freeze({ username: typeof identity.username === 'string' ? identity.username : null });
}

async function readAccessToken(connection: Connection): Promise<string | null> {
  const token = (connection as unknown as Readonly<Record<string, unknown>>).accessToken;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

async function readDescribeGlobal(connection: Connection): Promise<LiveSobjectEntry[]> {
  const payload = await connection.describeGlobal() as unknown as Readonly<Record<string, unknown>>;
  return readArray(payload.sobjects).flatMap((candidate) => {
    if (typeof candidate.name !== 'string') return [];
    return [Object.freeze({
      name: candidate.name,
      label: stringOf(candidate.label),
      labelPlural: stringOf(candidate.labelPlural),
      keyPrefix: typeof candidate.keyPrefix === 'string' ? candidate.keyPrefix : null,
      custom: candidate.custom === true,
      queryable: candidate.queryable === true,
      createable: candidate.createable === true,
      updateable: candidate.updateable === true,
      searchable: candidate.searchable === true,
    })];
  });
}

async function readDescribe(
  connection: Connection,
  objectApiName: string,
): Promise<LiveSobjectEntry & Readonly<{
  fields: readonly LiveField[];
  childRelationships: readonly LiveChildRelationship[];
}>> {
  const payload = await connection.describe(objectApiName) as unknown as Readonly<Record<string, unknown>>;
  const fields = readArray(payload.fields).flatMap((candidate) => {
    if (typeof candidate.name !== 'string') return [];
    return [Object.freeze({
      name: candidate.name,
      label: stringOf(candidate.label),
      type: stringOf(candidate.type),
      nillable: candidate.nillable === true,
      createable: candidate.createable === true,
      updateable: candidate.updateable === true,
      filterable: candidate.filterable === true,
      sortable: candidate.sortable === true,
      custom: candidate.custom === true,
      deprecatedAndHidden: candidate.deprecatedAndHidden === true,
      referenceTo: Object.freeze(readStringArray(candidate.referenceTo)),
      relationshipName: typeof candidate.relationshipName === 'string' ? candidate.relationshipName : null,
      picklistValues: Object.freeze(readArray(candidate.picklistValues).flatMap((value) => {
        if (typeof value.value !== 'string') return [];
        return [Object.freeze({
          value: value.value,
          label: stringOf(value.label),
          active: value.active === true,
          defaultValue: value.defaultValue === true,
        })];
      })),
    })];
  });
  const childRelationships = readArray(payload.childRelationships).flatMap((candidate) => {
    if (typeof candidate.childSObject !== 'string' || typeof candidate.field !== 'string') return [];
    return [Object.freeze({
      childSObject: candidate.childSObject,
      field: candidate.field,
      relationshipName: typeof candidate.relationshipName === 'string' ? candidate.relationshipName : null,
      cascadeDelete: candidate.cascadeDelete === true,
      restrictedDelete: candidate.restrictedDelete === true,
      deprecatedAndHidden: candidate.deprecatedAndHidden === true,
    })];
  });
  return Object.freeze({
    name: typeof payload.name === 'string' ? payload.name : objectApiName,
    label: stringOf(payload.label),
    labelPlural: stringOf(payload.labelPlural),
    keyPrefix: typeof payload.keyPrefix === 'string' ? payload.keyPrefix : null,
    custom: payload.custom === true,
    queryable: payload.queryable === true,
    createable: payload.createable === true,
    updateable: payload.updateable === true,
    searchable: payload.searchable === true,
    fields: Object.freeze(fields),
    childRelationships: Object.freeze(childRelationships),
  });
}

function readArray(value: unknown): Readonly<Record<string, unknown>>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry))
    : [];
}

function readEntries(value: unknown): Readonly<Record<string, unknown>>[] {
  return readArray(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function samePicklistValues(
  left: readonly Readonly<Record<string, unknown>>[],
  right: readonly LivePicklistValue[],
): boolean {
  return picklistDifferences(left, right).length === 0;
}

/**
 * Describes how the Tool's picklist view differs from the org's, bounded so a mismatch names
 * the exact property instead of only reporting that something disagreed.
 */
function picklistDifferences(
  left: readonly Readonly<Record<string, unknown>>[],
  right: readonly LivePicklistValue[],
): string[] {
  if (left.length !== right.length) {
    return [`count: tool=${left.length} org=${right.length}`];
  }
  const differences: string[] = [];
  for (const [index, value] of left.entries()) {
    const expected = right[index];
    if (expected === undefined) continue;
    for (const key of ['value', 'label', 'active', 'defaultValue'] as const) {
      if (value[key] !== expected[key]) {
        differences.push(`[${index}].${key}: tool=${JSON.stringify(value[key])} org=${JSON.stringify(expected[key])}`);
      }
    }
    if (differences.length >= 4) break;
  }
  return differences;
}

function sortEntries(entries: readonly LiveSobjectEntry[]): LiveSobjectEntry[] {
  return [...entries].sort((left, right) => left.name.localeCompare(right.name));
}

function startsWithFilter(name: string, filter: string): boolean {
  return name.toLocaleLowerCase('en-US').startsWith(filter.toLocaleLowerCase('en-US'));
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function gate(condition: boolean, detail: Readonly<Record<string, unknown>>, failure: string): P9LiveGate {
  return Object.freeze({
    status: condition ? 'PASS' : 'FAIL',
    detail: Object.freeze(condition ? detail : { ...detail, failure }),
  });
}

function failGate(failure: string): P9LiveGate {
  return Object.freeze({ status: 'FAIL', detail: Object.freeze({ failure }) });
}

function notTested(reason: string, detail: Readonly<Record<string, unknown>> = {}): P9LiveGate {
  return Object.freeze({ status: 'NOT TESTED', detail: Object.freeze({ reason, ...detail }) });
}

function combine(gates: readonly P9LiveGate[]): 'PASS' | 'PARTIAL' | 'FAIL' {
  if (gates.some((entry) => entry.status === 'FAIL')) return 'FAIL';
  return gates.some((entry) => entry.status === 'NOT TESTED') ? 'PARTIAL' : 'PASS';
}

async function closeQuietly(
  store: MySqlControlPlaneStore,
  database: ControlPlaneDatabaseClient,
  auditDatabase: ControlPlaneDatabaseClient,
  auditPipeline: AsyncAuditPipeline,
): Promise<void> {
  await auditPipeline.close(DEFAULT_AUDIT_FLUSH_TIMEOUT_MS).catch(() => undefined);
  await store.close().catch(() => undefined);
  await Promise.all([
    database.destroy().catch(() => undefined),
    auditDatabase.destroy().catch(() => undefined),
  ]);
}
