import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from '@salesforce/core';
import {
  createIdentityRuntime,
  JwtConnectionFactory,
  JsonLineRuntimeLogger,
  type RequestScope,
  type SalesforceConnectionFactory,
  type SalesforceIdentityRoute,
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
  call,
  closeQuietly,
  combine,
  failGate,
  flushAuditTrail,
  gate,
  maskedIdOf,
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
  salesforceErrorCodeOf,
  salesforceMessageOf,
  sameArray,
  stringOrNull,
  toolFailureDetail,
  type P10LiveGate,
  type P10LiveOrgFacts,
} from './p10-live-support.js';

/**
 * The P10-T3 live milestone: GAP-M2's question answered on a live org.
 *
 * `explain_field_access` claims three things that no fixture can settle, and each of them is a claim
 * about *someone else's* org:
 *
 * 1. **A closed field reads as closed, and the answer names the layer that closed it.** The unit suite
 *    hands the conclusion builder rows; what it cannot hand it is a real `FieldPermissions` table on a
 *    real profile, where the row may be absent, may be stored under either of two spellings of the field
 *    name, and may sit beside a standalone permission set that grants what the profile denies. The
 *    milestone therefore *constructs* the configuration in a sandbox and checks the Tool's report against
 *    the harness's own independent read of the same tables — the machine equivalent of opening Setup in
 *    another tab and comparing.
 *
 * 2. **The union is reported as a union.** The most common way a "why can this person not see this field"
 *    investigation goes wrong is that the reader stops at the profile. So the milestone does not stop at
 *    the denial: it grants the same field back through a temporary permission set and requires the Tool to
 *    flip to `visible: true`, list the standalone grant, and name the disagreement.
 *
 * 3. **The subject boundary is the deployment's own route set.** The unit and protocol suites assert the
 *    wiring against fixtures. Here it is asserted against the org: an Id outside the routes is refused,
 *    and refused *identically* to an Id that does not exist, which is the property that keeps the Tool
 *    from being an existence oracle about a customer's users.
 *
 * **What this harness writes, and what it refuses to write.** Constructing a closed field means writing
 * FLS, and constructing the union means creating a permission set, so the whole milestone is gated on the
 * org's own `IsSandbox` flag exactly as T2 is: on anything the platform does not call a sandbox, nothing
 * is created, nothing is updated, and the construction legs report `NOT TESTED` naming the ban. Even on a
 * sandbox the write is the *minimum* that answers the question — if the org already denies the subject
 * read on some field of the object, that field is used and no profile row is touched at all (mode
 * `OBSERVED`). Everything created is deleted again and the deletion is verified by re-reading, because a
 * milestone that leaves a permission set behind in a shared org has damaged the thing it was measuring.
 *
 * **The §0.3 red line is measured here rather than asserted.** `fieldApiNames` is a set of *keys into the
 * permission configuration* and never a read of the field's values. That is a claim about the SQL that
 * actually went to the org, so this harness wraps the Connection it hands the runtime and records every
 * SOQL statement the Tool issues, then checks each one against the whitelist of Setup-layer objects the
 * executor declares. A field-value read is not something this run could miss.
 */

/** The one Tool of this milestone. */
export const P10_T3_TOOL_NAMES = Object.freeze(['explain_field_access']);

/**
 * The exact input keys the Tool may advertise.
 *
 * Asserted as a set equality rather than as a scan for forbidden names: the T2 prohibition that no Tool
 * accepts a Salesforce username or token carries forward, and a Tool that accepts *anything* this file
 * does not name is a contract change that has to be seen. A forbidden-name scan would pass a newly added
 * `salesforceUsername`; this cannot.
 */
const P10_T3_TOOL_INPUT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  explain_field_access: Object.freeze(['fieldApiNames', 'includeRecordTypeContext', 'objectApiName', 'targetUserId']),
});

/** The object both cases are measured on. Standard, present in every org, and describable by a service account. */
const MILESTONE_OBJECT = 'Account';

/** The fully-open field: the one field every org grants read and edit on, and the positive control of the run. */
const OPEN_FIELD = 'Name';

/**
 * The fields the closure is constructed on, in preference order, if the org does not already close one.
 *
 * Deliberately obscure-but-standard fields. The construction is reverted by the cleanup gate, but a field
 * that no real user of this sandbox works with makes the window in which it is closed harmless, which is
 * worth the small cost of naming a list rather than picking `Industry` and hoping.
 *
 * The list is consulted only for fields the org **already has a row for**, because a live run measured that
 * a `FieldPermissions` row cannot be created with `PermissionsRead` false at all (`FIELD_INTEGRITY_EXCEPTION`,
 * "Read permission is required for: Account.TickerSymbol"). Closing a field is therefore an *update* of a row
 * the org already grants, which is also the edit an administrator makes by unchecking Read in Setup.
 */
const CONSTRUCTION_FIELD_PREFERENCE = Object.freeze([
  'SicDesc', 'TickerSymbol', 'Ownership', 'Rating', 'Site', 'Fax', 'AccountNumber',
]);

/** How many `FieldPermissions` rows the discovery read may return. The executor's own bound, for the same reason. */
const FIELD_PERMISSION_ROW_LIMIT = 2_000;

/** How many of the subject's permission sets the scaffolding reads. The executor's own bound. */
const PERMISSION_SET_LIMIT = 200;

/** The prefix of the permission set this harness creates. Recognisable in a report, and greppable in the org. */
const PROBE_PERMISSION_SET_PREFIX = 'P10_FLS_Probe_';

/** A syntactically valid user Id that cannot be one of this deployment's routes. */
const OUT_OF_BOUND_USER_ID = `005${'A'.repeat(12)}`;

/** A syntactically valid user Id that does not exist in the org. */
const NONEXISTENT_USER_ID = `005${'B'.repeat(12)}`;

/**
 * The Salesforce Id prefixes that may appear in an answer about field access.
 *
 * `005` user, `0PS` permission set, `00e` profile, `012` record type. The list is exhaustive on purpose:
 * the privacy gate asserts every id-shaped token in every response starts with one of them, so a business
 * record id — and above all a field *value* — arriving in an answer would fail the run rather than being
 * reported as a curiosity.
 */
const ALLOWED_ID_PREFIXES = Object.freeze(['005', '0PS', '00e', '012']);

/**
 * The Id prefixes that mean business data reached the answer: account, contact, opportunity, lead, case,
 * task/event, and the two custom-object families.
 */
const BUSINESS_ID_PATTERN = /\b(?:001|003|006|00Q|00T|00U|500|01p|a0[A-Za-z0-9])[0-9A-Za-z]{11,15}\b/u;

export type P10T3LiveReport = Readonly<{
  phase: 'P10';
  task: 'T3';
  generatedAt: string;
  /**
   * `CONSTRUCTED` — a sandbox, and the org did not already deny the subject read on this object, so the
   * harness closed one field's FLS itself and reverted it.
   * `OBSERVED` — a sandbox, and a field the subject is already denied was found, so nothing was written
   * until the union leg created its temporary permission set.
   * `READ_ONLY` — the org is not a sandbox, so neither closure nor grant was constructed (ADR-0029's
   * production ban) and only the reads the org already held were exercised.
   * `REFUSED` — the Control Plane cannot route a verified Diagnostic identity, so the Tool cannot be
   * enabled and nothing was attempted.
   */
  mode: 'CONSTRUCTED' | 'OBSERVED' | 'READ_ONLY' | 'REFUSED';
  platformUserIdMasked: string;
  org: P10LiveOrgFacts;
  diagnosticIdentity: Readonly<{
    configured: boolean;
    enabled: boolean | null;
    verificationStatus: string | null;
    salesforceUsernameMasked: string | null;
  }>;
  toolInventory: P10LiveGate;
  subject: P10LiveGate;
  selfSubject: P10LiveGate;
  namedTarget: P10LiveGate;
  /**
   * The precondition of every field conclusion: an object-level read row for the subject's profile.
   *
   * It is its own gate because it is the one leg whose failure explains all the others. With no such row the
   * Tool answers INDETERMINATE for every field, which is correct of the Tool and useless to an investigator
   * unless the report says which layer was missing.
   */
  objectLayer: P10LiveGate;
  /** Which fields the run measured on, and whether each control was observed or constructed. */
  controls: Readonly<{
    closedField: string | null;
    closedSource: string;
    openField: string | null;
    openSource: string;
    /** Field-level rows the org held for the subject's sets before this run wrote anything. */
    rowsReadBefore: number;
    describedFieldCount: number;
    /**
     * True when the run wrote a row on a *profile-owned* set — which changes field access for every user of
     * that profile, not only the subject, until the revert lands.
     *
     * It is reported separately because it is the one thing about this run an operator would want to know
     * before reading any of the conclusions: a shared sandbox where a profile was briefly edited is a
     * different situation from one where only a single user's own permission set changed.
     */
    profileWideWindow: boolean;
  }>;
  closedField: P10LiveGate;
  openField: P10LiveGate;
  unionConflict: P10LiveGate;
  setupCrossCheck: P10LiveGate;
  boundary: P10LiveGate;
  dataPlane: P10LiveGate;
  privacy: P10LiveGate;
  cleanup: P10LiveGate;
  credentialSafety: P10LiveGate;
  connections: Readonly<{ total: number; distinctSalesforceUsernames: readonly string[] }>;
  auditPersistence: P10LiveGate;
  overall: 'PASS' | 'PARTIAL' | 'FAIL';
}>;

/** One method a Tool invoked on an sObject handle: the channel below SOQL that a value read would use. */
type SObjectInvocation = Readonly<{ object: string; method: string }>;

/** Where the recorders stood when a window opened, so a window can be sliced out of them. */
type RecordMark = Readonly<{ statements: number; sobjectCalls: number }>;

/** What a Tool sent between two marks. */
type RecordWindow = Readonly<{ statements: readonly string[]; sobjectCalls: readonly SObjectInvocation[] }>;

/**
 * Records what the runtime sends to the org, so the data-plane red line can be checked on the wire.
 *
 * The harness makes reads of its own on the same Connection — `Organization`, the permission tables it uses
 * as the independent cross-check, and the writes that construct and revert the two configurations. Asserting
 * over everything sent would fold the scaffolding into a claim about the Tool, so each Tool call is bracketed
 * by a mark and only the bracketed window is asserted.
 *
 * Both channels the executor uses are recorded, because the red line has two halves. `connection.query`
 * carries the SOQL, where the claim is that every `FROM` target is a Setup-layer object and that the object
 * under investigation is never one of them. `connection.sobject(name)` carries the describe call the
 * executor makes *for the business object* — legitimately, for metadata — so the claim there cannot be about
 * the name; it is that the only method ever invoked on it is `describe`. A `find` or `retrieve` on that
 * handle would be the field-value read the red line forbids, and it would be invisible to a check that only
 * read `query`.
 */
class RecordingQueryFactory implements SalesforceConnectionFactory {
  public readonly statements: string[] = [];
  public readonly sobjectCalls: SObjectInvocation[] = [];

  public constructor(private readonly delegate: SalesforceConnectionFactory) {}

  public mark(): RecordMark {
    return Object.freeze({ statements: this.statements.length, sobjectCalls: this.sobjectCalls.length });
  }

  public since(mark: RecordMark): RecordWindow {
    return Object.freeze({
      statements: Object.freeze(this.statements.slice(mark.statements)),
      sobjectCalls: Object.freeze(this.sobjectCalls.slice(mark.sobjectCalls)),
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
            // Masked as it is recorded rather than when it is printed, because a statement is the one place
            // the raw text *is* the value: the Tool's `Username IN (…)` literal carries the deployment's
            // configured route usernames, and the report is written to a file and quoted into `docs/sfoa`.
            // Everything downstream reads the masked form, so nothing can print the other one by accident.
            owner.statements.push(maskUsernamesInText(statement));
            return await original.call(target, statement);
          };
        }
        if (property === 'sobject') {
          const original = Reflect.get(target, property, receiver) as unknown as (name: string) => unknown;
          return function recordHandle(name: string): unknown {
            const handle = original.call(target, name);
            // Returns a further proxy rather than the handle itself: the recorder has to see the method, not
            // just the object name, and it must leave the handle's own behaviour untouched so the describe
            // the executor relies on is the real one.
            if (typeof handle !== 'object' || handle === null) return handle;
            return new Proxy(handle as object, {
              get(handleTarget, handleProperty, handleReceiver) {
                const value = Reflect.get(handleTarget, handleProperty, handleReceiver) as unknown;
                if (typeof value !== 'function') return value;
                return function recordInvocation(...args: unknown[]): unknown {
                  owner.sobjectCalls.push(Object.freeze({ object: name, method: String(handleProperty) }));
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

type ScaffoldingRow = Readonly<Record<string, unknown>>;

export async function runP10T3LiveMilestone(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<P10T3LiveReport> {
  const config = await loadRemoteRuntimeConfig(projectRoot, environment);
  const controlPlane = config.controlPlane;
  if (controlPlane.mode !== 'mysql') {
    throw new Error('The P10-T3 live milestone requires the MySQL Control Plane: the DIAGNOSTIC identity and the identity routes are read from it.');
  }
  const databaseConfig = controlPlane.database;
  if (!databaseConfig) throw new Error('The P10-T3 live milestone requires the MySQL Control Plane database configuration.');
  if (!config.clientToken) throw new Error('The P10-T3 live milestone requires an independent internal client token.');
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
  // Two wrappers over one delegate, in a fixed order: `MeasuringConnectionFactory` answers "which identity
  // did this run open a Connection as", `RecordingQueryFactory` answers "what did the Tool send". Both are
  // the same delegate underneath, so the milestone cannot be measuring a org it did not drive.
  const recordingFactory = new RecordingQueryFactory(new JwtConnectionFactory({
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
      const reason = `explain_field_access cannot be enabled because ${missing}. The runtime refuses every request `
        + 'when a diagnostic Tool is enabled without an enabled, verification-passed Diagnostic identity, so the '
        + 'milestone was not attempted: configure and verify the Diagnostic identity through the Admin Control '
        + 'Plane, then re-run.';
      const auditPersistence = runAuditPersistence(await flushAuditTrail(auditPipeline), null);
      await closeQuietly(store, database, auditDatabase, auditPipeline);
      return refusalReport(generatedAt, platformUserId, diagnosticIdentity, reason, auditPersistence);
    }

    // The milestone reads its own permission tables on the same DIAGNOSTIC pairing the server uses for a
    // `tools/call`. That is what makes the cross-check independent of the Tool while still being a read of
    // the same org through the same identity: a difference between the two is a difference in the reading,
    // never a difference in who was asking.
    scaffoldingScope = await identityRuntime.scopeFactory.createForRoute(
      { platformUserId, correlationId: `p10-t3-milestone-${Date.now()}` },
      diagnosticRoute,
    );
    const scaffolding = await scaffoldingScope.getConnection();
    const org = await readOrgFacts(scaffolding);
    const writeAllowed = org.isSandbox === true;

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
      policySnapshotSource: new AdditiveToolPolicySnapshotSource(policySnapshotSource, P10_T3_TOOL_NAMES),
      discoveryPolicySnapshotSource: new MySqlRuntimeDiscoveryPolicySnapshotSource(database),
      ...(attachmentIngress === undefined ? {} : { attachmentIngress }),
    });

    const expectedNames = [...new Set([...snapshot.enabledTools, ...P10_T3_TOOL_NAMES])].sort();
    const results: CallToolResult[] = [];
    const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
      requestInit: {
        headers: {
          authorization: `Bearer ${clientToken}`,
          [config.platformUserHeader]: platformUserId,
        },
      },
    });
    const client = new Client({ name: 'p10-t3-live-milestone', version: '0.1.0-p10' });
    await client.connect(transport);
    try {
      const listings = await client.listTools();
      const toolInventory = runToolInventory({
        tools: listings.tools,
        milestoneTools: P10_T3_TOOL_NAMES,
        expectedNames,
        inputKeys: P10_T3_TOOL_INPUT_KEYS,
      });

      // The first call names no subject, so the answer is about the requesting user's own route. That is the
      // only place the milestone learns the subject's User Id: taking it from the Tool rather than from a read
      // of its own keeps the subject resolution that the rest of the run measures on the path under test.
      const openMark = recordingFactory.mark();
      const selfResult = await call(client, results, 'explain_field_access', {
        objectApiName: MILESTONE_OBJECT,
        fieldApiNames: [OPEN_FIELD],
        includeRecordTypeContext: true,
      });
      const openWindow = recordingFactory.since(openMark);
      const selfOutput = outputOf(selfResult);
      const subjectUserId = stringOrNull(recordOf(selfOutput?.userContext)?.userId);
      const selfSubject = runSelfSubject(selfOutput, selfResult);

      const subject = subjectUserId === null
        ? notTested('The Tool returned no subject user id, so no subject-scoped case could be measured.')
        : await runSubjectFacts(scaffolding, subjectUserId);

      const namedTargetMark = recordingFactory.mark();
      const namedTarget = subjectUserId === null
        ? notTested('The Tool returned no subject user id, so the named-target case could not be measured.')
        : await runNamedTarget(client, results, subjectUserId, selfOutput);
      const namedTargetWindow = recordingFactory.since(namedTargetMark);

      // ---------------------------------------------------------------------------------------------
      // Discovery, then construction only for what the org does not already hold.
      //
      // The order is the point. A run that writes first and asks afterwards cannot tell "the Tool read the
      // configuration I made" from "the Tool read a configuration that happened to be there", and both the
      // closed case and the union case below are claims about exactly that difference.
      // ---------------------------------------------------------------------------------------------
      const parents = subjectUserId === null ? [] : await readSubjectParentIds(scaffolding, subjectUserId);
      const parentIds = parents.map((parent) => parent.id);
      // The profile-owned set is the layer the closed case is defined on: it is what Setup shows on the
      // profile page, and a denial stored there is the one a reader can go and confirm by hand.
      const profileParent = parents.find((parent) => parent.isOwnedByProfile) ?? null;
      const describedFields = await readDescribedFieldNames(scaffolding, MILESTONE_OBJECT);
      const rows = parentIds.length === 0
        ? []
        : await readFieldPermissionRows(scaffolding, MILESTONE_OBJECT, parentIds);

      // The state the run owes back, read before the first write and compared against the same read taken
      // after the last one. See `readOrgPermissionSnapshot` for why that is a stronger claim than bookkeeping.
      const before = await readOrgPermissionSnapshot(scaffolding, MILESTONE_OBJECT, parentIds, subjectUserId);

      const objectLayer = await establishObjectLayer({
        connection: scaffolding,
        objectApiName: MILESTONE_OBJECT,
        profileParent,
        writeAllowed,
      });
      const closedControl = await establishClosedField({
        connection: scaffolding,
        objectApiName: MILESTONE_OBJECT,
        profileParent,
        rows,
        describedFields,
        writeAllowed,
      });
      const closedFieldName = closedControl.fieldApiName;
      const openControl = await establishOpenControl({
        connection: scaffolding,
        rows,
        describedFields,
        subjectUserId,
        exclude: closedFieldName === null ? [] : [closedFieldName],
        writeAllowed,
      });

      // Both controls in one call, so the contrast between the closed field and the open one is one response
      // rather than two that could have been answered from different states. `includeRecordTypeContext` is
      // left at its default here, which is what evidences that the context is carried when it is not off.
      const measuredFields = [closedFieldName, openControl.fieldApiName]
        .filter((field): field is string => field !== null);
      const closedMark = recordingFactory.mark();
      const closedResult = measuredFields.length === 0
        ? undefined
        : await call(client, results, 'explain_field_access', {
          objectApiName: MILESTONE_OBJECT,
          fieldApiNames: measuredFields,
          targetUserId: subjectUserId ?? undefined,
        });
      const closedWindow = recordingFactory.since(closedMark);
      const closedOutput = closedResult === undefined ? undefined : outputOf(closedResult);
      const closedField = runClosedField(closedOutput, closedControl);
      const openField = runOpenField(closedOutput, openControl);

      // The cross-check reads the org *after* the Tool answered and *before* the union grant is created, so
      // it sees exactly the configuration the Tool saw. Re-reading here rather than reusing the discovery rows
      // is what makes it a comparison: on the constructed path those rows predate the write, and a grant list
      // compared against a table read before the field was closed would disagree with any correct answer.
      const crossCheckRows = parentIds.length === 0
        ? rows
        : await readFieldPermissionRows(scaffolding, MILESTONE_OBJECT, parentIds);
      const setupCrossCheck = runSetupCrossCheck({
        rows: crossCheckRows,
        parents,
        closedField,
        closedFieldName,
        describedFields,
      });

      // The union leg. Granting the closed field back through a temporary permission set is the one thing
      // that distinguishes "the Tool read the profile" from "the Tool read the profile and everything else
      // the subject holds" — and it is the configuration an investigator gets wrong by stopping at Setup.
      const grant: Readonly<{
        gate: P10LiveGate;
        plan: RevertPlan | null;
        wrote: boolean;
      }> = closedFieldName === null || subjectUserId === null || !writeAllowed
        ? Object.freeze({
          gate: notTested(
            writeAllowed
              ? 'There was no closed field to grant back, so the union case was not measured.'
              : 'The org is not a sandbox, so no permission set was created to open the closed field back up '
                + '(ADR-0029).',
            Object.freeze({
              closedField: closedFieldName,
              isSandbox: writeAllowed,
            }),
          ),
          plan: null,
          wrote: false,
        })
        : await createTemporaryGrant({
          connection: scaffolding,
          writeAllowed,
          subjectUserId,
          fieldApiName: closedFieldName,
          purpose: 'UNION',
        });
      const unionMark = recordingFactory.mark();
      const unionResult = grant.gate.status === 'PASS' && measuredFields.length > 0
        ? await call(client, results, 'explain_field_access', {
          objectApiName: MILESTONE_OBJECT,
          fieldApiNames: measuredFields,
          targetUserId: subjectUserId ?? undefined,
          // Off, so the same run evidences the other half of the switch: an omitted argument is not "off", and
          // a response that carried no `recordTypeContext` when it was explicitly switched off is a different
          // observation from one that carried none because the read failed.
          includeRecordTypeContext: false,
        })
        : undefined;
      const unionWindow = recordingFactory.since(unionMark);
      const unionConflict = runUnionConflict({
        grantGate: grant.gate,
        output: unionResult === undefined ? undefined : outputOf(unionResult),
        closedFieldName,
        openFieldName: openControl.fieldApiName,
        createdName: grant.gate.status === 'PASS' && grant.plan?.kind === 'DELETE_SET'
          ? grant.plan.name
          : null,
      });

      const cleanup = await runCleanup({
        connection: scaffolding,
        plans: [objectLayer.plan, closedControl.plan, openControl.plan, grant.plan]
          .filter((plan): plan is RevertPlan => plan !== null),
        objectApiName: MILESTONE_OBJECT,
        parentIds,
        subjectUserId,
        before,
      });

      // The boundary, measured on the org rather than on a fixture: one Id outside the deployment's routes
      // and one Id that does not exist, and the two refusals have to be the same refusal.
      const boundaryMark = recordingFactory.mark();
      const outOfBound = await call(client, results, 'explain_field_access', {
        objectApiName: MILESTONE_OBJECT,
        fieldApiNames: [OPEN_FIELD],
        targetUserId: OUT_OF_BOUND_USER_ID,
      });
      const nonexistent = await call(client, results, 'explain_field_access', {
        objectApiName: MILESTONE_OBJECT,
        fieldApiNames: [OPEN_FIELD],
        targetUserId: NONEXISTENT_USER_ID,
      });
      const boundaryWindow = recordingFactory.since(boundaryMark);
      const boundary = runBoundary(outOfBound, nonexistent, boundaryWindow.statements);

      const dataPlane = runDataPlane(
        [openWindow, namedTargetWindow, closedWindow, unionWindow, boundaryWindow],
        subjectUserId === null ? [] : [subjectUserId],
      );
      const privacy = runPrivacy(results, subjectUserId);
      const credentialSafety = runCredentialSafety(results, clientToken, await readAccessToken(scaffolding));

      await client.close().catch(() => undefined);
      const shutdown = await server.close().catch(() => undefined);
      const auditPersistence = runAuditPersistence(await flushAuditTrail(auditPipeline), shutdown);

      // `CONSTRUCTED` is about *this run's* writes, not about whether a permission set exists. The union leg
      // always creates one, so counting it would make every sandbox run read as constructed even when the org
      // supplied both controls itself — and the difference between the two is the difference between "the Tool
      // read the configuration I made" and "the Tool read the org".
      const mode: P10T3LiveReport['mode'] = !writeAllowed
        ? 'READ_ONLY'
        : objectLayer.wrote || closedControl.wrote || openControl.wrote
          ? 'CONSTRUCTED'
          : 'OBSERVED';

      return Object.freeze({
        phase: 'P10',
        task: 'T3',
        generatedAt,
        mode,
        platformUserIdMasked: maskIdentifier(platformUserId),
        org,
        diagnosticIdentity,
        toolInventory,
        subject,
        selfSubject,
        namedTarget,
        objectLayer: objectLayer.gate,
        controls: Object.freeze({
          closedField: closedControl.fieldApiName,
          closedSource: closedControl.source,
          openField: openControl.fieldApiName,
          openSource: openControl.source,
          rowsReadBefore: rows.length,
          describedFieldCount: describedFields.length,
          profileWideWindow: objectLayer.wrote || closedControl.wrote,
        }),
        closedField,
        openField,
        unionConflict,
        setupCrossCheck,
        boundary,
        dataPlane,
        privacy,
        cleanup,
        credentialSafety,
        connections: Object.freeze({
          total: measuringFactory.measurements.length,
          distinctSalesforceUsernames: Object.freeze([...measuredSalesforceUsernames(measuringFactory)]),
        }),
        auditPersistence,
        overall: combine([
          toolInventory, subject, selfSubject, namedTarget, objectLayer.gate, closedField, openField,
          unionConflict, setupCrossCheck, boundary, dataPlane, privacy, cleanup, credentialSafety,
          auditPersistence,
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
  diagnosticIdentity: P10T3LiveReport['diagnosticIdentity'],
  reason: string,
  auditPersistence: P10LiveGate,
): P10T3LiveReport {
  return Object.freeze({
    phase: 'P10',
    task: 'T3',
    generatedAt,
    mode: 'REFUSED',
    platformUserIdMasked: maskIdentifier(platformUserId),
    org: Object.freeze({ isSandbox: null, instanceName: null, apiVersion: null, organizationIdMasked: null }),
    diagnosticIdentity,
    toolInventory: notTested(reason),
    subject: notTested(reason),
    selfSubject: notTested(reason),
    namedTarget: notTested(reason),
    objectLayer: notTested(reason),
    controls: Object.freeze({
      closedField: null,
      closedSource: 'NOT TESTED',
      openField: null,
      openSource: 'NOT TESTED',
      rowsReadBefore: 0,
      describedFieldCount: 0,
      profileWideWindow: false,
    }),
    closedField: notTested(reason),
    openField: notTested(reason),
    unionConflict: notTested(reason),
    setupCrossCheck: notTested(reason),
    boundary: notTested(reason),
    dataPlane: notTested(reason),
    privacy: notTested(reason),
    cleanup: notTested('Nothing was constructed.'),
    credentialSafety: notTested('No Tool call was made.'),
    connections: Object.freeze({ total: 0, distinctSalesforceUsernames: Object.freeze([]) }),
    auditPersistence,
    overall: 'PARTIAL',
  });
}

// ---------------------------------------------------------------------------------------------
// The Tool-side gates.
// ---------------------------------------------------------------------------------------------

function fieldAt(output: Readonly<Record<string, unknown>> | undefined, index: number): Record<string, unknown> | undefined {
  const fields = output?.fields;
  return Array.isArray(fields) ? recordOf(fields[index]) : undefined;
}

function explanationFor(
  output: Readonly<Record<string, unknown>> | undefined,
  fieldApiName: string,
): Record<string, unknown> | undefined {
  const fields = output?.fields;
  if (!Array.isArray(fields)) return undefined;
  return fields.flatMap((entry) => {
    const record = recordOf(entry);
    return record === undefined ? [] : [record];
  }).find((entry) => stringOrNull(entry.fieldApiName) === fieldApiName);
}

function conclusionOf(explanation: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return recordOf(explanation?.conclusion);
}

/**
 * The first call, and the one that establishes whose access is being explained.
 *
 * `isRequestingUser` is asserted rather than recorded because it is the answer to "whose access is this": a
 * Tool that resolved the DIAGNOSTIC account instead of the caller's route would answer about the wrong user,
 * and every other gate in this file would still pass.
 *
 * What is *not* asserted here is the conclusion, and the reason is the ordering of the run rather than any
 * weakness in the claim. This call happens before the run has read a single permission table — deliberately,
 * since the subject's User Id comes from the Tool rather than from a read that would bypass the resolution
 * under test — so the org at this moment may carry no object-level row at all, and the Tool would be right to
 * answer INDETERMINATE. Whether the Tool can give a *definite* positive answer is asserted later, on the open
 * control, once this run has established the layer that answer depends on. The observation made here is
 * recorded instead, because "the first unaided call was INDETERMINATE and here is why" is itself the finding
 * the INDETERMINATE semantics exist for.
 */
function runSelfSubject(
  output: Readonly<Record<string, unknown>> | undefined,
  result: CallToolResult,
): P10LiveGate {
  if (output === undefined) return failGate('explain_field_access returned no structured content.');
  if (output.success !== true) {
    return failGate(
      `explain_field_access failed live: ${String(output.errorCode ?? 'no error code')}.`,
      toolFailureDetail(output),
    );
  }
  const userContext = recordOf(output.userContext);
  const explanation = explanationFor(output, OPEN_FIELD);
  const conclusion = conclusionOf(explanation);
  const sourceChain = Array.isArray(conclusion?.sourceChain) ? conclusion.sourceChain : [];
  const recordTypeContext = recordOf(output.recordTypeContext);
  const facts = output.executionRole === 'DIAGNOSTIC'
    && output.api === 'STANDARD'
    && output.objectApiName === MILESTONE_OBJECT
    && userContext !== undefined
    && userContext.isRequestingUser === true
    && stringOrNull(userContext.username) !== null
    && conclusion !== undefined
    // The record-type context is on by default, and the schema says so; a response that dropped it would make
    // the `includeRecordTypeContext: false` comparison in the union leg vacuous.
    && recordTypeContext !== undefined
    && recordTypeContext.availableToSubject === 'INDETERMINATE';

  return gate(facts, Object.freeze({
    isError: result.isError === true,
    executionRole: output.executionRole,
    api: output.api,
    objectApiName: output.objectApiName,
    userIdMasked: maskedIdOfValue(userContext?.userId),
    usernameMasked: userContext?.username === undefined ? null : maskIdentifier(String(userContext.username)),
    isRequestingUser: userContext?.isRequestingUser ?? null,
    isActive: userContext?.isActive ?? null,
    permissionSets: readRecords(userContext?.permissionSets).map((entry) => Object.freeze({
      name: entry.name ?? null,
      isOwnedByProfile: entry.isOwnedByProfile ?? null,
      profileName: entry.profileName ?? null,
    })),
    objectAccess: userContext?.objectAccess ?? null,
    field: OPEN_FIELD,
    // Recorded, not asserted: this call predates every read this run makes, so an INDETERMINATE here is a
    // fact about the org's initial state — the evidence the INDETERMINATE semantics rest on — rather than a
    // failure of the Tool. The definite positive answer is asserted on the open control below.
    firstCallConclusion: Object.freeze({
      visible: conclusion?.visible ?? null,
      editable: conclusion?.editable ?? null,
      sourceChain,
    }),
    recordTypes: readRecords(recordTypeContext?.recordTypes).length,
    availableToSubject: recordTypeContext?.availableToSubject ?? null,
    hint: output.hint ?? null,
  }), 'The first call did not explain the requesting user\'s own access on the fixed DIAGNOSTIC identity '
    + 'with the record-type context carried.');
}

/** The named-target case: the same subject, named by Id, has to produce the same subject record. */
async function runNamedTarget(
  client: Client,
  results: CallToolResult[],
  subjectUserId: string,
  selfOutput: Readonly<Record<string, unknown>> | undefined,
): Promise<P10LiveGate> {
  const result = await call(client, results, 'explain_field_access', {
    objectApiName: MILESTONE_OBJECT,
    fieldApiNames: [OPEN_FIELD],
    targetUserId: subjectUserId,
  });
  const output = outputOf(result);
  if (output === undefined) return failGate('The named-target call returned no structured content.');
  if (output.success !== true) {
    return failGate(
      `The named-target call failed live: ${String(output.errorCode ?? 'no error code')}.`,
      toolFailureDetail(output),
    );
  }
  const userContext = recordOf(output.userContext);
  const selfContext = recordOf(selfOutput?.userContext);
  const conclusion = conclusionOf(explanationFor(output, OPEN_FIELD));
  // The claim is identity, not visibility: naming the subject by Id has to resolve to the same user and to
  // say so in `isRequestingUser`. Like the self call, this predates the run's reads, so the conclusion is
  // reported rather than asserted — the field-level positive control is asserted on the open control later.
  const facts = userContext !== undefined
    && userContext.isRequestingUser === false
    && stringOrNull(userContext.userId) === subjectUserId
    && stringOrNull(selfContext?.userId) === subjectUserId;

  return gate(facts, Object.freeze({
    targetUserIdMasked: maskSalesforceId(subjectUserId),
    resolvedUserIdMasked: maskedIdOfValue(userContext?.userId),
    isRequestingUser: userContext?.isRequestingUser ?? null,
    sameSubjectAsSelfCall: stringOrNull(userContext?.userId) === stringOrNull(selfContext?.userId),
    firstCallConclusion: Object.freeze({
      visible: conclusion?.visible ?? null,
      editable: conclusion?.editable ?? null,
    }),
  }), 'Naming the requesting user by Id did not resolve to the same subject the unaided call reported.');
}

/**
 * What the deployment's route set actually contained, and which route the caller was on.
 *
 * Reported rather than asserted beyond the two facts the rest of the run needs: the caller's own route has
 * to be a *business* route (the Tool runs as the DIAGNOSTIC account and explains a different user, which is
 * the entire design), and the set the boundary is enforced against has to be non-empty for a named target
 * to be resolvable at all.
 */
async function runSubjectFacts(connection: Connection, subjectUserId: string): Promise<P10LiveGate> {
  const rows = await queryRows(
    connection,
    `SELECT Id, Username, IsActive, Profile.Name FROM User WHERE Id = '${escapeSoqlLiteral(subjectUserId)}' LIMIT 1`,
  );
  const row = rows[0];
  const facts = row !== undefined;
  return gate(facts, Object.freeze({
    userIdMasked: maskSalesforceId(subjectUserId),
    usernameMasked: maskedIdentifier(row?.Username),
    isActive: row?.IsActive ?? null,
    profileName: recordOf(row?.Profile)?.Name ?? null,
  }), 'The subject Id the Tool resolved is not a user this org returned, so nothing downstream could be '
    + 'measured about them.');
}

/**
 * The closed field, and the layer that closed it.
 *
 * The claim is not "the Tool said false" — a Tool that answered `false` to everything would satisfy that.
 * The claim is that the *evidence* names the layer: a definite `false` (never `INDETERMINATE`, which would
 * mean the layer was never read), a source chain that reports the profile baseline as read and the grant
 * set as empty, and a grant list in which any profile-owned row carries `permissionsRead: false`.
 */
function runClosedField(
  output: Readonly<Record<string, unknown>> | undefined,
  control: EstablishedControl,
): P10LiveGate {
  const closedFieldName = control.fieldApiName;
  if (closedFieldName === null) {
    return notTested(
      'The run established no closed field to measure, so the closed case was not measured. The leg\'s own '
      + 'gate carries the reason.',
      Object.freeze({ control: control.gate.detail, controlStatus: control.gate.status }),
    );
  }
  if (control.gate.status !== 'PASS') {
    return failGate(
      'The field this run closed could not be established, so the closed case is not measured.',
      control.gate.detail,
    );
  }
  if (output === undefined) return failGate('The closed-field call returned no structured content.');
  if (output.success !== true) {
    return failGate(
      `The closed-field call failed live: ${String(output.errorCode ?? 'no error code')}.`,
      toolFailureDetail(output),
    );
  }
  const explanation = explanationFor(output, closedFieldName);
  const conclusion = conclusionOf(explanation);
  const grants = readRecords(explanation?.grants);
  const sourceChain = Array.isArray(conclusion?.sourceChain) ? conclusion.sourceChain.map(String) : [];
  const chainText = sourceChain.join(' | ');
  const facts = conclusion !== undefined
    && conclusion.visible === false
    && conclusion.editable === false
    // The reading was complete: the object layer was readable and the baseline layer was in the list that
    // was asked. Without both, `false` would be a claim the evidence does not support.
    && /object-visibility: read=true/u.test(chainText)
    && /profileBaselineReadable=true/u.test(chainText)
    && /read=false edit=false/u.test(chainText)
    && grants.every((grant) => grant.permissionsRead === false && grant.permissionsEdit === false);

  return gate(facts, Object.freeze({
    field: closedFieldName,
    control: Object.freeze({ source: control.source, status: control.gate.status, detail: control.gate.detail }),
    visible: conclusion?.visible ?? null,
    editable: conclusion?.editable ?? null,
    sourceChain,
    conflicts: conclusion?.conflicts ?? [],
    grants: grants.map((grant) => Object.freeze({
      parentType: grant.parentType ?? null,
      parentName: grant.parentName ?? null,
      parentIdMasked: maskedIdOfValue(grant.parentId),
      permissionsRead: grant.permissionsRead ?? null,
      permissionsEdit: grant.permissionsEdit ?? null,
    })),
    describeFacts: explanation?.describeFacts ?? null,
  }), `The field this run closed for the subject did not read as a definite denial: the Tool must report `
    + 'visible=false with a source chain naming the profile baseline as readable and the grant set as empty, '
    + 'and must never report that as INDETERMINATE.');
}

/**
 * The positive control: a field the subject can read *and* edit, in the same response as the closed one.
 *
 * The field is measured rather than named. `Account.Name` is the field a reader would expect here, but
 * whether this org stores a permission row granting it is a fact about the org, and asserting the answer
 * before reading it would fail for a reason that is not a defect. `establishOpenControl` finds a field the
 * org already grants, or grants one, and this asserts what the Tool says about it — including that the
 * object layer underneath was readable, so a `true` here is a definite one rather than the Tool's default.
 */
function runOpenField(
  output: Readonly<Record<string, unknown>> | undefined,
  control: EstablishedControl,
): P10LiveGate {
  const openFieldName = control.fieldApiName;
  if (openFieldName === null) {
    return notTested(
      'The run established no field the subject is granted read and edit on, so the positive control was not '
      + 'measured. The leg\'s own gate carries the reason.',
      Object.freeze({ control: control.gate.detail, controlStatus: control.gate.status }),
    );
  }
  if (control.gate.status !== 'PASS') {
    return failGate(
      'The open field this run needed as a positive control could not be established, so the contrast with the '
      + 'closed field is not measured.',
      control.gate.detail,
    );
  }
  const explanation = explanationFor(output, openFieldName);
  const conclusion = conclusionOf(explanation);
  const sourceChain = Array.isArray(conclusion?.sourceChain) ? conclusion.sourceChain.map(String) : [];
  const facts = conclusion?.visible === true
    && conclusion.editable === true
    && /object-visibility: read=true/u.test(sourceChain.join(' | '));

  return gate(facts, Object.freeze({
    field: openFieldName,
    control: Object.freeze({ source: control.source, status: control.gate.status, detail: control.gate.detail }),
    visible: conclusion?.visible ?? null,
    editable: conclusion?.editable ?? null,
    sourceChain,
  }), `${MILESTONE_OBJECT}.${openFieldName} did not read as a definite readable, editable field for the `
    + 'subject in the same call that reported a closed field, so the contrast between the two is not one '
    + 'response.');
}

/**
 * The union leg: what a temporary standalone grant does to the answer.
 *
 * The claim is that a layer *other than the profile* is what turned a definite denial into a definite grant,
 * and that the answer names it. Three things have to move together: the conclusion flips to visible **and**
 * editable; the grant list carries a `PERMISSION_SET` parent — the set this run just created, read and edit;
 * and the source chain's own counts agree with the grant rows, which is what distinguishes "the Tool reported
 * the union" from "the Tool reported something self-consistent".
 *
 * The conflict text is asserted only when the profile layer also carries a grant row, because that is the only
 * configuration in which the Tool has a disagreement to describe. On the configuration this run actually
 * builds — the profile row *removed*, so the profile contributes no grant at all — `conflicts` is correctly
 * empty: the third live run measured that, and asserting otherwise would have made the milestone demand a
 * sentence the evidence does not contain. What the union is visible *through* there is the chain's
 * `0 profile-owned and 1 standalone` and the flip itself.
 */
function runUnionConflict(input: Readonly<{
  grantGate: P10LiveGate;
  output: Readonly<Record<string, unknown>> | undefined;
  closedFieldName: string | null;
  openFieldName: string | null;
  createdName: string | null;
}>): P10LiveGate {
  if (input.grantGate.status !== 'PASS') {
    return notTested(
      'The temporary permission set that opens the closed field was not created, so the union case was not '
      + 'measured. Its own gate carries the reason.',
      Object.freeze({ grant: input.grantGate.detail }),
    );
  }
  if (input.closedFieldName === null) {
    return notTested('There was no closed field to open.');
  }
  const output = input.output;
  if (output === undefined) return failGate('The union call returned no structured content.');
  const recordTypeContext = recordOf(output.recordTypeContext);
  if (output.success !== true) {
    return failGate(
      `The union call failed live: ${String(output.errorCode ?? 'no error code')}.`,
      toolFailureDetail(output),
    );
  }
  const explanation = explanationFor(output, input.closedFieldName);
  const conclusion = conclusionOf(explanation);
  const grants = readRecords(explanation?.grants);
  const standalone = grants.filter((grant) => grant.parentType === 'PERMISSION_SET');
  const profileGrants = grants.filter((grant) => grant.parentType === 'PROFILE');
  const conflicts = Array.isArray(conclusion?.conflicts) ? conclusion.conflicts.map(String) : [];
  const chainText = Array.isArray(conclusion?.sourceChain) ? conclusion.sourceChain.map(String).join(' | ') : '';
  const counts = /field-grants: \d+ row\(s\) over (\d+) profile-owned and (\d+) standalone/u.exec(chainText);
  const chainAccountsForTheRows = counts !== null
    && Number(counts[1]) === profileGrants.length
    && Number(counts[2]) === standalone.length
    && standalone.length > 0;
  const conflictExpected = profileGrants.length > 0;
  const conflictPresent = conflicts.some((conflict) => /No profile-owned grant carries (read|edit)/u.test(conflict));
  const facts = conclusion?.visible === true
    && conclusion?.editable === true
    && standalone.some((grant) => stringOrNull(grant.parentName) === input.createdName
      && grant.permissionsRead === true && grant.permissionsEdit === true)
    && chainAccountsForTheRows
    && (!conflictExpected || conflictPresent)
    // Explicitly switched off for this call, so the response must not carry it: the two calls together are
    // the evidence that the argument is honoured rather than accepted and ignored.
    && recordTypeContext === undefined;

  return gate(facts, Object.freeze({
    field: input.closedFieldName,
    createdPermissionSetMasked: input.createdName === null ? null : maskIdentifier(input.createdName),
    visible: conclusion?.visible ?? null,
    editable: conclusion?.editable ?? null,
    sourceChain: conclusion?.sourceChain ?? [],
    conflicts,
    conflictExpected,
    conflictPresent,
    chainAccountsForTheRows,
    grants: grants.map((grant) => Object.freeze({
      parentType: grant.parentType ?? null,
      parentName: grant.parentName ?? null,
      permissionsRead: grant.permissionsRead ?? null,
      permissionsEdit: grant.permissionsEdit ?? null,
    })),
    recordTypeContextSuppressed: recordTypeContext === undefined,
    openFieldStillOpen: input.openFieldName === null
      ? null
      : conclusionOf(explanationFor(output, input.openFieldName))?.visible ?? null,
  }), 'Granting the closed field back through a standalone permission set did not make the Tool report it as '
    + 'editable with the new grant named and the source chain\'s counts agreeing with the grant rows.');
}

/**
 * The boundary, measured as a property rather than as a message.
 *
 * An Id outside the route set and an Id that does not exist anywhere in the org must produce the same
 * refusal, byte for byte. If they differ — by wording, by a different code, by one of them succeeding —
 * the Tool is an existence oracle: it would let a caller enumerate a customer's user Ids.
 *
 * The cost is asserted too, and it is the structural half of the same claim. Membership is enforced by the
 * `Username IN (…)` clause inside the subject lookup, so a refusal is *one* query that returns no row —
 * not a read of the permission tables followed by a decision to withhold them. Two calls therefore cost
 * exactly two statements. A refusal that had read further would have learned something about the Id before
 * refusing, whatever its message said.
 *
 * Nothing but the refusal may come back with it: an answer that carried a conclusion alongside the refusal
 * is one an Agent would act on, and the whole point of refusing is that there is nothing to act on.
 */
function runBoundary(
  outOfBound: CallToolResult,
  nonexistent: CallToolResult,
  statements: readonly string[],
): P10LiveGate {
  const outOfBoundText = refusalText(outOfBound);
  const nonexistentText = refusalText(nonexistent);
  const outOfBoundCode = errorCodeOf(outOfBound);
  const nonexistentCode = errorCodeOf(nonexistent);
  const facts = outOfBound.isError === true
    && nonexistent.isError === true
    && outOfBoundCode === 'MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED'
    && nonexistentCode === 'MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED'
    && outOfBoundText === nonexistentText
    && outOfBoundText.length > 0
    && !/INDETERMINATE/u.test(outOfBoundText)
    && !/sourceChain|"grants"/u.test(outOfBoundText)
    && statements.length === 2;

  return gate(facts, Object.freeze({
    outOfBoundIdMasked: maskSalesforceId(OUT_OF_BOUND_USER_ID),
    nonexistentIdMasked: maskSalesforceId(NONEXISTENT_USER_ID),
    outOfBoundErrorCode: outOfBoundCode,
    nonexistentErrorCode: nonexistentCode,
    refusalTextsIdentical: outOfBoundText === nonexistentText,
    refusalLength: outOfBoundText.length,
    carriesConclusion: /sourceChain|"grants"/u.test(outOfBoundText),
    statementsForTwoRefusals: statements.length,
    // One statement per refusal, and the shape of it is the subject lookup — so the reader can see that a
    // refusal touched nothing but the table that decides it.
    statements: statements.map((statement) => statement.replace(/\s+/gu, ' ').slice(0, 200)),
  }), 'An Id outside the deployment\'s routes was not refused identically to an Id that does not exist, the '
    + 'refusal cost more than the one subject lookup the boundary is supposed to be, or a conclusion came back '
    + 'with it — any of which makes the Tool an existence oracle about this org\'s users.');
}

/**
 * A refusal as one string.
 *
 * `content` and `structuredContent` are both included, and the error code is read from whichever carries it,
 * because which of the two the transport preserves on an `isError` result is a property of the SDK rather
 * than of this Tool — and a comparison that silently ran over an empty string would pass for the wrong
 * reason. Any per-request id is stripped: the claim is about the answer, not about the request that produced
 * it.
 */
function refusalText(result: CallToolResult): string {
  return [
    JSON.stringify(result.content ?? []),
    JSON.stringify(result.structuredContent ?? {}),
  ].join('\n').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, '<request-id>');
}

function errorCodeOf(result: CallToolResult): string | null {
  const structured = stringOrNull(recordOf(result.structuredContent)?.errorCode);
  if (structured !== null) return structured;
  const text = (result.content ?? [])
    .flatMap((part) => {
      const record = recordOf(part);
      return record?.type === 'text' ? [String(record.text ?? '')] : [];
    })
    .join(' ');
  return /^\s*\[([A-Z0-9_]+)\]/u.exec(text)?.[1] ?? null;
}

// ---------------------------------------------------------------------------------------------
// The data-plane and privacy gates. These are the §0.3 red line, stated as measurements.
// ---------------------------------------------------------------------------------------------

function recordedStatements(windows: readonly RecordWindow[]): readonly string[] {
  return windows.flatMap((window) => window.statements);
}

/**
 * The data-plane assertion, over what actually went to the org during the Tool calls.
 *
 * Three claims, on the two channels the executor uses.
 *
 * Every `FROM` target the Tool's SOQL names is on the whitelist of Setup-layer objects this file restates
 * rather than imports — importing the executor's own constant would let a widened whitelist widen the check
 * with it, which is the one way this gate could be made to pass by the change it exists to catch.
 *
 * The object under investigation never appears as a `FROM` target. That is the same claim one level down and
 * the one a reader of the evidence page will look for: `objectApiName` is a filter value, never a table.
 *
 * The only method ever invoked on that object's sObject handle is `describe`. The executor does call
 * `sobject(objectApiName)` — for metadata, which is legitimate — so a name-based check would be vacuous
 * here. What must hold is that nothing asked it for data: `find`, `retrieve`, `soql` or any other read on
 * that handle would be the field-value read of §0.3, and none may appear.
 */
function runDataPlane(
  windows: readonly RecordWindow[],
  subjectIds: readonly string[],
): P10LiveGate {
  const whitelist = new Set([
    'User', 'PermissionSetAssignment', 'PermissionSet', 'ObjectPermissions', 'FieldPermissions', 'RecordType',
  ]);
  const statements = recordedStatements(windows);
  const invocations = windows.flatMap((window) => window.sobjectCalls);
  const targets = statements.flatMap((statement) =>
    [...statement.matchAll(/\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1] ?? ''));
  const offWhitelist = [...new Set(targets)].filter((target) => !whitelist.has(target));
  const businessTargets = targets.filter((target) => target === MILESTONE_OBJECT);
  const businessMethods = invocations
    .filter((invocation) => invocation.object === MILESTONE_OBJECT)
    .map((invocation) => invocation.method);
  const businessDataReads = businessMethods.filter((method) => method !== 'describe');
  const facts = statements.length > 0
    && offWhitelist.length === 0
    && businessTargets.length === 0
    && businessDataReads.length === 0;

  return gate(facts, Object.freeze({
    toolStatements: statements.length,
    windows: windows.length,
    distinctTargets: [...new Set(targets)].sort(),
    whitelist: [...whitelist].sort(),
    offWhitelist,
    businessObjectReads: businessTargets.length,
    businessDescribeCalls: businessMethods.filter((method) => method === 'describe').length,
    businessDataReads,
    // The subject is passed as a *value* and never as a query target, which is why this can be reported at
    // all: the run knows the id it sent and can say whether any statement named it as an object.
    statementsMentionSubjectId: statements.filter((statement) =>
      subjectIds.some((id) => statement.includes(id))).length,
    sobjectHandlesTouched: [...new Set(invocations.map((invocation) => invocation.object))].sort(),
    sample: statements.slice(0, 8).map((statement) => statement.replace(/\s+/gu, ' ').slice(0, 240)),
  }), 'A Tool call issued SOQL against an object outside the declared Setup-layer whitelist, targeted the object '
    + 'under investigation as a table rather than as a filter value, or asked that object\'s handle for '
    + 'something other than its metadata — any of which is the §0.3 data-plane red line.');
}

/**
 * The privacy gate: an answer about permissions must not carry business data.
 *
 * Asserted three ways, because any one alone is escapable.
 *
 * No id-shaped token in any response may look like a business record — account, contact, opportunity,
 * lead, case — which catches a leaked row id, in the structured content or in the prose that renders it.
 *
 * Every id the *structured* answer carries under a key that names an identifier must start with one of the
 * four Setup-layer prefixes. This is the check the pattern above cannot make: it catches a leak hidden at a
 * key whose name gives the pattern nothing to match on, by inverting the question — instead of asking "does
 * anything look like business data", it asks "is every id here one this Tool has any business returning".
 *
 * The subject's own id appears in exactly one field. `userContext.userId` is *supposed* to carry it — it is
 * how the answer says whose access was explained — so a raw search proves nothing. Blanking that one field
 * and requiring the id to be absent everywhere else is the property worth having: a User id is Setup-layer
 * configuration and may appear where the schema defines a place for it, and nowhere else.
 */
function runPrivacy(results: readonly CallToolResult[], subjectUserId: string | null): P10LiveGate {
  const rendered = results.map((result) => JSON.stringify(result));
  const businessIds = [...new Set(rendered.flatMap((text) =>
    [...text.matchAll(new RegExp(BUSINESS_ID_PATTERN.source, 'gu'))].map((match) => match[0] ?? '')))];
  const structural = collectStructuralIds(results);
  const unexpectedStructural = structural.filter((entry) =>
    !ALLOWED_ID_PREFIXES.some((prefix) => entry.id.startsWith(prefix)));
  const subjectOutsideItsField = subjectUserId === null
    ? 0
    : results.filter((result) => withoutSubjectIdField(result.structuredContent).includes(subjectUserId)).length;
  const facts = businessIds.length === 0
    && unexpectedStructural.length === 0
    && subjectOutsideItsField === 0;

  return gate(facts, Object.freeze({
    responsesInspected: results.length,
    businessRecordIdsFound: businessIds.map(maskSalesforceId),
    structuralIdsChecked: structural.length,
    unexpectedStructuralIds: unexpectedStructural.map((entry) => Object.freeze({
      key: entry.key, valueMasked: maskSalesforceId(entry.id),
    })),
    // Reported as the subject id being present at all, because "it is absent" would be a stronger claim than
    // the Tool makes: `userContext.userId` carries it deliberately, and the prose line names it too.
    responsesWhereSubjectIdLeftItsField: subjectOutsideItsField,
    subjectIdPresentInAnswer: subjectUserId !== null,
    allowedIdPrefixes: [...ALLOWED_ID_PREFIXES],
  }), 'A permission explanation carried a business record id, an id outside the Setup-layer prefixes an answer '
    + 'about permissions may carry, or the subject id somewhere the schema does not define a place for it.');
}

/** The structured answer with `userContext.userId` blanked, so the subject id can be searched for elsewhere. */
function withoutSubjectIdField(value: unknown): string {
  const copy = recordOf(JSON.parse(JSON.stringify(recordOf(value) ?? {})) as unknown);
  const userContext = recordOf(copy?.userContext);
  if (userContext !== undefined && 'userId' in userContext) userContext.userId = '<the subject>';
  return JSON.stringify(copy ?? {});
}

/** Every id-shaped value at a key whose name says it is an id, so the prefix check has something to check. */
function collectStructuralIds(results: readonly CallToolResult[]): readonly Readonly<{ key: string; id: string }>[] {
  const found: { key: string; id: string }[] = [];
  const visit = (value: unknown, key: string): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key);
      return;
    }
    const record = recordOf(value);
    if (record !== undefined) {
      for (const [childKey, childValue] of Object.entries(record)) visit(childValue, childKey);
      return;
    }
    if (typeof value !== 'string') return;
    // Only keys that name an identifier, and only well-formed ids: a display name or a username is not an id
    // and checking it would produce noise a reader would learn to skip.
    if (!/(?:^|[a-z])Id$/u.test(key) && key !== 'availableToExecutionIdentity') return;
    for (const match of value.matchAll(/\b[0-9A-Za-z]{15}(?:[0-9A-Za-z]{3})?\b/gu)) {
      found.push({ key, id: match[0] ?? '' });
    }
  };
  for (const result of results) visit(result.structuredContent, 'structuredContent');
  return Object.freeze(found.map((entry) => Object.freeze(entry)));
}

// ---------------------------------------------------------------------------------------------
// The scaffolding: reading the permission tables, constructing the two configurations.
// ---------------------------------------------------------------------------------------------

/** The executor's `ParentId IN (…)` guard, applied here so a subject with no sets reads nothing. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${escapeSoqlLiteral(value)}'`).join(', ');
}

async function queryRows(connection: Connection, statement: string): Promise<readonly ScaffoldingRow[]> {
  const payload = await connection.query(statement) as unknown as Readonly<{ records?: readonly unknown[] }>;
  return readRecords(payload.records);
}

function escapeSoqlLiteral(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/'/gu, '\\\'');
}

type ParentFacts = Readonly<{
  id: string;
  name: string | null;
  label: string | null;
  isOwnedByProfile: boolean;
}>;

/**
 * The subject's permission sets, read in the two steps the Tool itself uses.
 *
 * `IsOwnedByProfile` and `Profile.Name` were measured on `PermissionSet` and not on the assignment table, so
 * the cross-check reads them the same way rather than betting that a field the Tool's own author did not
 * bet on is selectable here.
 */
async function readSubjectParentIds(connection: Connection, userId: string): Promise<readonly ParentFacts[]> {
  const assignments = await queryRows(
    connection,
    `SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${escapeSoqlLiteral(userId)}' `
    + `LIMIT ${PERMISSION_SET_LIMIT}`,
  );
  const ids = [...new Set(assignments.map((row) => stringOrNull(row.PermissionSetId)).filter((id): id is string => id !== null))];
  if (ids.length === 0) return Object.freeze([]);
  const sets = await queryRows(
    connection,
    `SELECT Id, Name, Label, IsOwnedByProfile FROM PermissionSet WHERE Id IN (${inList(ids)}) LIMIT ${PERMISSION_SET_LIMIT}`,
  );
  return Object.freeze(sets.flatMap((row) => {
    const id = stringOrNull(row.Id);
    return id === null ? [] : [Object.freeze({
      id,
      name: stringOrNull(row.Name),
      label: stringOrNull(row.Label),
      isOwnedByProfile: row.IsOwnedByProfile === true,
    })];
  }));
}

type FieldPermissionRow = Readonly<{
  id: string;
  parentId: string;
  field: string;
  bareField: string;
  permissionsRead: boolean;
  permissionsEdit: boolean;
}>;

async function readFieldPermissionRows(
  connection: Connection,
  objectApiName: string,
  parentIds: readonly string[],
): Promise<readonly FieldPermissionRow[]> {
  if (parentIds.length === 0) return Object.freeze([]);
  const rows = await queryRows(
    connection,
    `SELECT Id, ParentId, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions `
    + `WHERE SobjectType = '${escapeSoqlLiteral(objectApiName)}' AND ParentId IN (${inList(parentIds)}) `
    + `LIMIT ${FIELD_PERMISSION_ROW_LIMIT}`,
  );
  return Object.freeze(rows.flatMap((row) => {
    const id = stringOrNull(row.Id);
    const parentId = stringOrNull(row.ParentId);
    const field = stringOrNull(row.Field);
    if (id === null || parentId === null || field === null) return [];
    return [Object.freeze({
      id,
      parentId,
      field,
      bareField: bareFieldName(field),
      permissionsRead: row.PermissionsRead === true,
      permissionsEdit: row.PermissionsEdit === true,
    })];
  }));
}

/** `Account.Name` and `Name` are the same field; the org stores one or the other, and this is the join. */
function bareFieldName(stored: string): string {
  const dot = stored.lastIndexOf('.');
  return dot === -1 ? stored : stored.slice(dot + 1);
}

/** The object's describable field names, which is how the harness knows a construction target exists. */
async function readDescribedFieldNames(connection: Connection, objectApiName: string): Promise<readonly string[]> {
  try {
    const described = await connection.sobject(objectApiName).describe() as unknown as Readonly<{ fields?: readonly unknown[] }>;
    const fields = Array.isArray(described?.fields) ? described.fields : [];
    return Object.freeze(fields.flatMap((entry) => {
      const name = stringOrNull(recordOf(entry)?.name);
      return name === null ? [] : [name];
    }));
  } catch {
    return Object.freeze([]);
  }
}

/**
 * A field the org already denies the subject on the profile layer, if there is one.
 *
 * Restricted to rows on the *profile-owned* set, because that is what makes the denial a definite one: the
 * Tool reports `profileBaselineReadable` from whether a profile-owned row exists for the field at all, and a
 * denial stored only on a standalone set that no profile layer backs comes back INDETERMINATE rather than
 * `false`. Reading that as a closure would be reporting the Tool's caution as a denial.
 *
 * Only an explicit `PermissionsRead=false` row counts, and only when no row anywhere grants the field read.
 * A field with no row at all is deliberately not a candidate here — whether an absent row means "denied" or
 * "default, therefore readable" is a platform rule this run has not measured, and a milestone resting on an
 * unmeasured rule would be reporting a guess as evidence. What it does with such a field is construct the row
 * instead, which is an observation of the Tool reading a configuration this run made.
 */
function pickDeniedField(
  profileRows: readonly FieldPermissionRow[],
  allRows: readonly FieldPermissionRow[],
  describedFields: readonly string[],
): string | null {
  const described = new Set(describedFields);
  const denies = profileRows.find((row) => !row.permissionsRead
    && !row.permissionsEdit
    && (described.size === 0 || described.has(row.bareField)));
  if (denies === undefined) return null;
  // A field one layer denies and another still grants is already the union case, which this run builds for
  // itself rather than borrows: taking it here would leave the closed gate asserting a denial the Tool is
  // right to report as a grant.
  return allRows.some((row) => row.bareField === denies.bareField && row.permissionsRead) ? null : denies.bareField;
}

/**
 * A field the org already grants the subject read *and* edit on: the positive control, taken from the org's
 * own rows rather than assumed.
 *
 * Naming a field in advance and asserting it is open is the trap here. `Account.Name` is open in the sense
 * that a reader can see it, but whether this org stores a `FieldPermissions` row saying so is exactly the
 * question — and a control built on the assumption fails for a reason that is not a defect in the Tool. So
 * the control is measured: a row that grants read and edit is a row the Tool must report as a grant.
 */
function pickOpenField(
  rows: readonly FieldPermissionRow[],
  describedFields: readonly string[],
  exclude: readonly string[],
): string | null {
  const described = new Set(describedFields);
  const candidates = rows.filter((row) => row.permissionsRead && row.permissionsEdit
    && !exclude.includes(row.bareField)
    && (described.size === 0 || described.has(row.bareField)));
  // `Name` first when the org grants it, because it is the field the protocol suite's fixture uses and the
  // one a reader of the evidence page will look for; otherwise the first grant the org has.
  const preferred = candidates.find((row) => row.bareField === OPEN_FIELD);
  return (preferred ?? candidates[0])?.bareField ?? null;
}

/**
 * A field this run can close by **updating a row the org already has** — the only path a live org left open.
 *
 * The first live run established the constraint by measuring it: inserting a `FieldPermissions` row with
 * `PermissionsRead` false is refused outright ("Read permission is required for: Account.TickerSymbol"), so a
 * field with no row cannot be closed by a create. A field the org already grants read on does have a row, and
 * flipping that row to `read=false edit=false` is the same edit an administrator makes by unchecking Read in
 * Setup — and the row's prior values are captured for the revert plan, so the snapshot comparison still holds.
 *
 * Two exclusions, both about the claim the closed gate is allowed to make:
 * - the field the other control uses, so the contrast in the combined call stays a contrast;
 * - a field **another** parent layer grants read on, because closing only the profile row would leave the
 *   field open through the other layer and the closed gate would then assert a denial the Tool is right to
 *   report as a grant. That configuration is the union case, which the run builds deliberately further down.
 *
 * The obscure-field preference is applied inside the candidates rather than over all fields, for the same
 * reason as before: the window is reverted, and a field no real user works with makes it harmless.
 */
function pickClosableField(
  profileRows: readonly FieldPermissionRow[],
  allRows: readonly FieldPermissionRow[],
  describedFields: readonly string[],
  exclude: readonly string[],
): string | null {
  const described = new Set(describedFields);
  const closable = profileRows.filter((row) => row.permissionsRead
    && !exclude.includes(row.bareField)
    && (described.size === 0 || described.has(row.bareField))
    && !allRows.some((other) => other.parentId !== row.parentId
      && other.bareField === row.bareField
      && other.permissionsRead));
  const preferred = CONSTRUCTION_FIELD_PREFERENCE
    .map((field) => closable.find((row) => row.bareField === field))
    .find((row) => row !== undefined);
  // Then anything but the field the other control wants for itself: closing `Name` is the most disruptive
  // field this run could pick, and the positive control reading `Name` is what a reader of the evidence page
  // looks for. The tie-break is only reached when the org grants the profile none of the obscure fields.
  const fallback = closable.find((row) => row.bareField !== OPEN_FIELD) ?? closable[0];
  return (preferred ?? fallback)?.bareField ?? null;
}

/**
 * A field with no read grant anywhere, which the run would have to *create* a row for.
 *
 * Kept as the second path rather than deleted, because a live org refusing a write is a measurement about the
 * platform and not a fact about this harness: on an org or an API version where the insert is accepted the run
 * takes this path, and when it is refused the report carries the platform's own words instead of a shrug. What
 * the first live run measured is that this path is refused on the sandbox it was measured against.
 */
function pickUngrantedField(
  describedFields: readonly string[],
  rows: readonly FieldPermissionRow[],
  exclude: readonly string[],
): string | null {
  const described = new Set(describedFields);
  const granted = new Set(rows.filter((row) => row.permissionsRead).map((row) => row.bareField));
  return CONSTRUCTION_FIELD_PREFERENCE.find((field) => !exclude.includes(field)
    && !granted.has(field)
    && (described.size === 0 || described.has(field))) ?? null;
}

/** The field a temporary grant is written against: `Name` when the object has it, then the same list. */
function pickGrantTarget(describedFields: readonly string[], exclude: readonly string[]): string | null {
  const described = new Set(describedFields);
  return [OPEN_FIELD, ...CONSTRUCTION_FIELD_PREFERENCE]
    .find((field) => !exclude.includes(field) && (described.size === 0 || described.has(field))) ?? null;
}

// ---------------------------------------------------------------------------------------------
// The state the run has to leave exactly as it found it.
// ---------------------------------------------------------------------------------------------

/**
 * Everything about the subject's permission configuration that this run could disturb.
 *
 * Taken before the first write and again after the last one, and compared as two sorted lists of canonical
 * lines. This is a stronger claim than bookkeeping each row the run touched: a permission set it failed to
 * delete, a field permission it forgot it had written, a row that arrived from somewhere else — all of them
 * show up as a line present afterwards that was not present before. The alternative, checking that "the
 * things I remember creating are gone", can only find the losses it already knows about.
 */
type OrgPermissionSnapshot = readonly string[];

async function readOrgPermissionSnapshot(
  connection: Connection,
  objectApiName: string,
  parentIds: readonly string[],
  subjectUserId: string | null,
): Promise<OrgPermissionSnapshot> {
  if (parentIds.length === 0) return Object.freeze([]);
  const lines: string[] = [];
  const objectRows = await queryRows(
    connection,
    'SELECT ParentId, PermissionsRead, PermissionsEdit, PermissionsViewAllRecords FROM ObjectPermissions '
      + `WHERE SobjectType = '${escapeSoqlLiteral(objectApiName)}' AND ParentId IN (${inList(parentIds)})`,
  );
  for (const row of objectRows) {
    lines.push(`object|${String(row.ParentId)}|${String(row.PermissionsRead)}|${String(row.PermissionsEdit)}`
      + `|${String(row.PermissionsViewAllRecords)}`);
  }
  const fieldRows = await readFieldPermissionRows(connection, objectApiName, parentIds);
  for (const row of fieldRows) {
    lines.push(`field|${row.parentId}|${row.field}|${String(row.permissionsRead)}|${String(row.permissionsEdit)}`);
  }
  if (subjectUserId !== null) {
    const assignments = await queryRows(
      connection,
      `SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${escapeSoqlLiteral(subjectUserId)}' `
        + `LIMIT ${PERMISSION_SET_LIMIT}`,
    );
    for (const row of assignments) lines.push(`assignment|${String(row.PermissionSetId)}`);
  }
  return Object.freeze([...lines].sort());
}

/**
 * The lines the two snapshots do not agree on, in **either** direction.
 *
 * Both directions, and the third live run is why. The comparison originally returned only the lines present
 * afterwards that had not been present before — the shape a leftover row has, and not the shape a *removed*
 * row has. That run closed a field by taking its `FieldPermissions` row away, failed to put it back (the
 * restore `update` was refused with `INVALID_ID_FIELD`), and the snapshot went from 207 lines to 206 while
 * this function returned nothing. The gate failed only because the plan recorded its own failure; a run that
 * had simply forgotten the row would have gone green on an org it had altered. A comparison that looks in one
 * direction is a comparison that cannot see half of what it exists to see.
 */
function snapshotDrift(before: OrgPermissionSnapshot, after: OrgPermissionSnapshot): readonly string[] {
  const earlier = new Set(before);
  const later = new Set(after);
  const added = after.filter((line) => !earlier.has(line)).map((line) => `added|${line}`);
  const removed = before.filter((line) => !later.has(line)).map((line) => `removed|${line}`);
  return Object.freeze([...added, ...removed].sort());
}

// ---------------------------------------------------------------------------------------------
// Establishing the three facts the measurement rests on, and remembering how to undo each.
// ---------------------------------------------------------------------------------------------

/**
 * How to put one change back.
 *
 * `DELETE_SET` carries the whole cascade because the order is not optional — Salesforce refuses to delete a
 * permission set a user still holds — and keeping the three ids together is what stops a cleanup from
 * deleting the set and orphaning the assignment.
 */
type RevertPlan =
  | Readonly<{ kind: 'DELETE_ROW'; object: string; id: string; label: string }>
  | Readonly<{
    kind: 'RESTORE_ROW';
    object: string;
    id: string;
    values: Readonly<Record<string, unknown>>;
    label: string;
  }>
  | Readonly<{
    kind: 'RECREATE_ROW';
    object: string;
    values: Readonly<Record<string, unknown>>;
    label: string;
  }>
  | Readonly<{
    kind: 'DELETE_SET';
    name: string;
    permissionSetId: string | null;
    assignmentId: string | null;
    fieldPermissionIds: readonly string[];
    label: string;
  }>;

/** The outcome of establishing one row, and what undoing it would take. */
type RowPreparation = Readonly<{
  /** True when the row now says what the measurement needs it to say. */
  ok: boolean;
  /**
   * `ALREADY` writes nothing; the two write states are the ones the cleanup owes something for. `REFUSED` is
   * "the run was not allowed to" and reports as `NOT TESTED`; `FAILED` is "it was allowed and Salesforce said
   * no", which is a defect in the run and reports as `FAIL`.
   */
  state: 'ALREADY' | 'CREATED' | 'UPDATED' | 'REFUSED' | 'FAILED';
  plan: RevertPlan | null;
  detail: Readonly<Record<string, unknown>>;
}>;

/** One of the three legs that has to hold before anything can be concluded: its gate, its undo, its name. */
type EstablishedControl = Readonly<{
  gate: P10LiveGate;
  plan: RevertPlan | null;
  fieldApiName: string | null;
  /** True when this leg changed the org — the difference between a constructed run and an observed one. */
  wrote: boolean;
  /** `ALREADY_…`, `CREATED`, `NOT TESTED` — what a reader needs to judge the leg without the detail. */
  source: string;
}>;

function refusedPreparation(reason: string, detail: Readonly<Record<string, unknown>>): RowPreparation {
  return Object.freeze({ ok: false, state: 'REFUSED', plan: null, detail: Object.freeze({ reason, ...detail }) });
}

/**
 * The boundary between a leg that failed and a harness that crashed.
 *
 * A Salesforce refusal inside one of these legs is a finding about the deployment — most often that the
 * DIAGNOSTIC identity cannot write `FieldPermissions` — and a finding belongs in a gate. Letting it escape as
 * an exception would abort the run before `runCleanup`, which is the one part of this file that must run
 * whatever else happened: a harness that dies holding a permission set it created has left the sandbox worse
 * than it found it, and that is the outcome ADR-0029's sandbox-only rule exists to prevent.
 */
function failedPreparation(
  label: string,
  plan: RevertPlan | null,
  error: unknown,
  extra: Readonly<Record<string, unknown>> = {},
): RowPreparation {
  const code = salesforceErrorCodeOf(error);
  const message = salesforceMessageOf(error);
  return Object.freeze({
    ok: false,
    state: 'FAILED',
    plan,
    detail: Object.freeze({
      reason: `${label}: Salesforce refused it with ${code ?? 'no Salesforce error code'}.`,
      salesforceErrorCode: code,
      // The platform's own words, because the code alone is a finding a reader cannot act on: the first T3
      // live run recorded `FIELD_INTEGRITY_EXCEPTION` on a `FieldPermissions` row and nothing that said
      // which part of the row the platform objected to.
      ...(message === null ? {} : { salesforceMessage: message }),
      ...extra,
    }),
  });
}

/** A leg that could not be established: `NOT TESTED` when the run was not allowed to, `FAIL` when it tried. */
function unavailableControl(
  preparation: RowPreparation,
  source: string,
  failure: string,
): EstablishedControl {
  return Object.freeze({
    gate: preparation.state === 'REFUSED'
      ? notTested(String(preparation.detail.reason ?? 'The configuration this leg needs could not be established.'),
        preparation.detail)
      : failGate(failure, preparation.detail),
    plan: preparation.plan,
    fieldApiName: null,
    wrote: false,
    source,
  });
}

/**
 * Establishes the subject's object-level read row, which every field conclusion below it depends on.
 *
 * This is not a convenience, it is the precondition of measuring anything. With no `ObjectPermissions` row
 * for the subject's profile on this object, `objectAccess.read` is `null` and the Tool's conclusion is
 * INDETERMINATE for every field on it — the Tool being careful, not the deployment being broken. A run that
 * skipped this step would report ten INDETERMINATE fields and call it a result.
 *
 * The row is created granting read *and* edit, which is what an internal user's own profile carries. Edit is
 * never read by the conclusion; it is set so the row is not a stranger to the org's own conventions.
 */
async function ensureObjectReadRow(input: Readonly<{
  connection: Connection;
  objectApiName: string;
  parent: ParentFacts;
  writeAllowed: boolean;
}>): Promise<RowPreparation> {
  try {
    return await ensureObjectReadRowInner(input);
  } catch (error) {
    // No plan: the row is only ever created by a call that returned an id, and a call that returned none did
    // not write. If that reasoning is ever wrong, the snapshot comparison in `runCleanup` is what catches it.
    return failedPreparation('The object-level read row could not be established', null, error, Object.freeze({
      parentIdMasked: maskSalesforceId(input.parent.id),
      objectApiName: input.objectApiName,
    }));
  }
}

async function ensureObjectReadRowInner(input: Readonly<{
  connection: Connection;
  objectApiName: string;
  parent: ParentFacts;
  writeAllowed: boolean;
}>): Promise<RowPreparation> {
  const rows = await queryRows(
    input.connection,
    'SELECT Id, PermissionsRead, PermissionsEdit FROM ObjectPermissions '
      + `WHERE SobjectType = '${escapeSoqlLiteral(input.objectApiName)}' `
      + `AND ParentId = '${escapeSoqlLiteral(input.parent.id)}' LIMIT 1`,
  );
  const row = rows[0];
  const id = stringOrNull(row?.Id);
  if (row === undefined) {
    if (!input.writeAllowed) {
      return refusedPreparation(
        'The org stores no object-level row for this subject on this object, and it is not a sandbox, so none '
        + 'could be constructed (ADR-0029). Every field conclusion for this subject is INDETERMINATE until one '
        + 'exists, which is the Tool being careful rather than the deployment being wrong.',
        Object.freeze({ parentIdMasked: maskSalesforceId(input.parent.id), objectApiName: input.objectApiName }),
      );
    }
    const created = await createRow(input.connection, 'ObjectPermissions', Object.freeze({
      ParentId: input.parent.id,
      SobjectType: input.objectApiName,
      PermissionsRead: true,
      PermissionsEdit: true,
    }));
    if (created === null) {
      throw new Error('The object-level read row was created but Salesforce returned no id for it.');
    }
    return Object.freeze({
      ok: true,
      state: 'CREATED',
      plan: Object.freeze({
        kind: 'DELETE_ROW', object: 'ObjectPermissions', id: created,
        label: 'ObjectPermissions (object-level read, created)',
      }),
      detail: Object.freeze({ state: 'CREATED', rowIdMasked: maskSalesforceId(created) }),
    });
  }
  if (row.PermissionsRead === true) {
    return Object.freeze({
      ok: true,
      state: 'ALREADY',
      plan: null,
      detail: Object.freeze({
        state: 'ALREADY',
        rowIdMasked: id === null ? null : maskSalesforceId(id),
        permissionsRead: true,
        permissionsEdit: row.PermissionsEdit ?? null,
      }),
    });
  }
  if (!input.writeAllowed) {
    return refusedPreparation(
      'The org\'s object-level row for this subject does not grant read, and the org is not a sandbox, so it '
      + 'was not modified (ADR-0029). "The subject cannot read this object" is then a conclusion this run '
      + 'reports, rather than a field layer it measures anything beneath.',
      Object.freeze({
        parentIdMasked: maskSalesforceId(input.parent.id),
        rowPermissionsRead: row.PermissionsRead ?? null,
      }),
    );
  }
  await updateRow(input.connection, 'ObjectPermissions', Object.freeze({
    Id: row.Id, PermissionsRead: true, PermissionsEdit: true,
  }));
  return Object.freeze({
    ok: true,
    state: 'UPDATED',
    plan: Object.freeze({
      kind: 'RESTORE_ROW',
      object: 'ObjectPermissions',
      id: id ?? '',
      values: Object.freeze({
        PermissionsRead: row.PermissionsRead === true,
        PermissionsEdit: row.PermissionsEdit === true,
      }),
      label: 'ObjectPermissions (object-level read, restored)',
    }),
    detail: Object.freeze({
      state: 'UPDATED',
      rowIdMasked: id === null ? null : maskSalesforceId(id),
      priorPermissionsRead: row.PermissionsRead ?? null,
      priorPermissionsEdit: row.PermissionsEdit ?? null,
    }),
  });
}

/**
 * Establishes one field's row on one parent to exactly the read/edit asked for.
 *
 * This is the write the T3 prompt means by "construct a field-FLS-closed configuration": a profile's field
 * level security is stored on the permission set Salesforce creates for the profile, so `PermissionsRead`
 * false on that row is closing the field for every user of the profile. It is the most invasive thing this
 * run does, which is why it is refused outright on a non-sandbox, why the row's prior values are captured
 * before the write, and why the whole snapshot is compared afterwards.
 */
async function ensureFieldRow(input: Readonly<{
  connection: Connection;
  objectApiName: string;
  parent: ParentFacts;
  fieldApiName: string;
  read: boolean;
  edit: boolean;
  writeAllowed: boolean;
}>): Promise<RowPreparation> {
  try {
    return await ensureFieldRowInner(input);
  } catch (error) {
    // No plan, for the same reason as the object row: a `create` that returned no id did not write. An
    // `update` that threw may or may not have applied, and that is precisely what the snapshot comparison in
    // `runCleanup` is for — it compares the org against the state before the first write rather than against
    // this run's memory of what it did.
    return failedPreparation('The field-level row could not be established', null, error, Object.freeze({
      field: input.fieldApiName,
      parentIdMasked: maskSalesforceId(input.parent.id),
    }));
  }
}

async function ensureFieldRowInner(input: Readonly<{
  connection: Connection;
  objectApiName: string;
  parent: ParentFacts;
  fieldApiName: string;
  read: boolean;
  edit: boolean;
  writeAllowed: boolean;
}>): Promise<RowPreparation> {
  const rows = (await readFieldPermissionRows(input.connection, input.objectApiName, [input.parent.id]))
    .filter((row) => row.bareField === input.fieldApiName);
  const row = rows[0];
  if (row === undefined) {
    if (!input.writeAllowed) {
      return refusedPreparation(
        'The org stores no field-level row for this subject on this field, and it is not a sandbox, so none '
        + 'could be constructed (ADR-0029).',
        Object.freeze({ field: input.fieldApiName, parentIdMasked: maskSalesforceId(input.parent.id) }),
      );
    }
    const created = await createRow(input.connection, 'FieldPermissions', Object.freeze({
      ParentId: input.parent.id,
      SobjectType: input.objectApiName,
      Field: `${input.objectApiName}.${input.fieldApiName}`,
      PermissionsRead: input.read,
      PermissionsEdit: input.edit,
    }));
    if (created === null) {
      throw new Error('The field-level row was created but Salesforce returned no id for it.');
    }
    return Object.freeze({
      ok: true,
      state: 'CREATED',
      plan: Object.freeze({
        kind: 'DELETE_ROW', object: 'FieldPermissions', id: created,
        label: `FieldPermissions (${input.fieldApiName}, created)`,
      }),
      detail: Object.freeze({
        state: 'CREATED', field: input.fieldApiName, rowIdMasked: maskSalesforceId(created),
      }),
    });
  }
  if (row.permissionsRead === input.read && row.permissionsEdit === input.edit) {
    return Object.freeze({
      ok: true,
      state: 'ALREADY',
      plan: null,
      detail: Object.freeze({
        state: 'ALREADY',
        field: input.fieldApiName,
        rowIdMasked: maskSalesforceId(row.id),
        permissionsRead: row.permissionsRead,
        permissionsEdit: row.permissionsEdit,
      }),
    });
  }
  if (!input.writeAllowed) {
    return refusedPreparation(
      'The org\'s field-level row for this subject does not say what this measurement needs, and the org is '
      + 'not a sandbox, so it was not modified (ADR-0029). The row is reported as the org has it.',
      Object.freeze({
        field: input.fieldApiName,
        rowPermissionsRead: row.permissionsRead,
        rowPermissionsEdit: row.permissionsEdit,
      }),
    );
  }
  try {
    await updateRow(input.connection, 'FieldPermissions', Object.freeze({
      Id: row.id, PermissionsRead: input.read, PermissionsEdit: input.edit,
    }));
  } catch (error) {
    // The measured fallback. A live sandbox refused the insert of a `PermissionsRead=false` row, so this run
    // tries the edit first; if the platform refuses the edit as well, the deny is written the other way — by
    // removing the profile's row, which is the configuration Setup shows as an unchecked Read box. It is only
    // reached for a closure (`!input.read`): taking a field away by deletion and giving it back by creation
    // must never be how a *grant* is established, so a refusal there is re-thrown as itself.
    if (input.read) throw error;
    return await removeGrantingRow({ ...input, row, current: row, mechanism: 'DELETE_THE_GRANTING_ROW',
      updateRefusal: error });
  }
  // The edit was accepted, which is a different question from what the platform *did* with it. The third live
  // run recorded the answer: setting `PermissionsRead` false and `PermissionsEdit` false removes the row, so
  // the restore that would have followed — an `update` back by id — failed with `INVALID_ID_FIELD` and left
  // the field closed. The row is therefore re-read and the plan is built from what is actually there.
  const settled = (await readFieldPermissionRows(input.connection, input.objectApiName, [input.parent.id]))
    .filter((candidate) => candidate.bareField === input.fieldApiName)[0];
  if (settled === undefined) {
    return freezeRemovedRow({ ...input, current: row, mechanism: 'THE_PLATFORM_REMOVED_THE_ROW' });
  }
  if (settled.permissionsRead !== input.read || settled.permissionsEdit !== input.edit) {
    throw new Error(`The org accepted the edit but still reports FieldPermissions ${input.fieldApiName} as `
      + `read=${String(settled.permissionsRead)} edit=${String(settled.permissionsEdit)}.`);
  }
  return Object.freeze({
    ok: true,
    state: 'UPDATED',
    plan: Object.freeze({
      kind: 'RESTORE_ROW',
      object: 'FieldPermissions',
      id: settled.id,
      values: Object.freeze({
        PermissionsRead: row.permissionsRead,
        PermissionsEdit: row.permissionsEdit,
      }),
      label: `FieldPermissions (${input.fieldApiName}, restored)`,
    }),
    detail: Object.freeze({
      state: 'UPDATED',
      field: input.fieldApiName,
      rowIdMasked: maskSalesforceId(settled.id),
      mechanism: 'UPDATE_THE_EXISTING_ROW',
      priorPermissionsRead: row.permissionsRead,
      priorPermissionsEdit: row.permissionsEdit,
    }),
  });
}

/**
 * Closes a field by removing the row the org granted it with, when the edit was refused outright.
 *
 * Two things make this sound rather than a guess. The profile's row *is* the grant — its absence is what an
 * administrator sees as an unchecked Read box, and it is what the tool reports as a definite `false` rather
 * than as a gap, because the subject's profile-owned permission set is still in the list that was read. And
 * the restore is exact: the row is re-created with the values it had, and the cleanup's snapshot compares
 * `field|parent|read|edit` lines rather than row ids, so a new id is a faithful restoration.
 *
 * The prior values are re-read rather than reused from discovery, because a refused update may still have
 * applied on the platform's side, and the row this is about to delete must be described as it actually is.
 */
async function removeGrantingRow(input: Readonly<{
  connection: Connection;
  objectApiName: string;
  parent: ParentFacts;
  fieldApiName: string;
  writeAllowed: boolean;
  row: FieldPermissionRow;
  current: FieldPermissionRow;
  mechanism: string;
  updateRefusal: unknown;
}>): Promise<RowPreparation> {
  const current = (await readFieldPermissionRows(input.connection, input.objectApiName, [input.parent.id]))
    .filter((candidate) => candidate.bareField === input.fieldApiName)[0] ?? input.row;
  await destroyRow(input.connection, 'FieldPermissions', current.id);
  return freezeRemovedRow({ ...input, current });
}

/**
 * The plan for a field this run closed by taking its row away — the same plan on both removal paths.
 *
 * `PermissionsRead` is written back as it was read, which on a profile grant is `true`; that is also the only
 * value the platform accepts on a create, which the first live run measured when it refused a deny row.
 */
function freezeRemovedRow(input: Readonly<{
  objectApiName: string;
  parent: ParentFacts;
  fieldApiName: string;
  current: FieldPermissionRow;
  mechanism: string;
  updateRefusal?: unknown;
}>): RowPreparation {
  const refusalCode = input.updateRefusal === undefined ? null : salesforceErrorCodeOf(input.updateRefusal);
  const refusalMessage = input.updateRefusal === undefined ? null : salesforceMessageOf(input.updateRefusal);
  return Object.freeze({
    ok: true,
    state: 'UPDATED',
    plan: Object.freeze({
      kind: 'RECREATE_ROW',
      object: 'FieldPermissions',
      values: Object.freeze({
        ParentId: input.parent.id,
        SobjectType: input.objectApiName,
        // Both spellings, for the same reason the executor sends both: the org accepts either and this run
        // must not depend on which one it happened to read back.
        Field: `${input.objectApiName}.${input.fieldApiName}`,
        PermissionsRead: input.current.permissionsRead,
        PermissionsEdit: input.current.permissionsEdit,
      }),
      label: `FieldPermissions (${input.fieldApiName}, re-created)`,
    }),
    detail: Object.freeze({
      state: 'UPDATED',
      field: input.fieldApiName,
      rowIdMasked: maskSalesforceId(input.current.id),
      mechanism: input.mechanism,
      priorPermissionsRead: input.current.permissionsRead,
      priorPermissionsEdit: input.current.permissionsEdit,
      ...(refusalCode === null ? {} : { updateRefusalCode: refusalCode }),
      ...(refusalMessage === null ? {} : { updateRefusalMessage: refusalMessage }),
    }),
  });
}

/**
 * Creates the temporary standalone grant that adds a permission the profile layer does not carry.
 *
 * Used twice and for the same reason: a permission set is the layer that *adds*, so it is how this run shows
 * a grant the profile does not have — once as the positive control when the org's own rows give none, and
 * once to open the closed field back up so the union can be seen. Creating it here and deleting it afterwards
 * leaves the org as it was found, which is the only way a milestone may write to a shared sandbox at all.
 */
async function createTemporaryGrant(input: Readonly<{
  connection: Connection;
  writeAllowed: boolean;
  subjectUserId: string;
  fieldApiName: string;
  purpose: 'OPEN_CONTROL' | 'UNION';
}>): Promise<Readonly<{ gate: P10LiveGate; plan: RevertPlan | null; wrote: boolean }>> {
  if (!input.writeAllowed) {
    return Object.freeze({
      gate: notTested(
        'The org is not a sandbox, so no permission set was created on it (ADR-0029: writes are sandbox-only).',
        Object.freeze({ purpose: input.purpose, isSandbox: false }),
      ),
      plan: null,
      wrote: false,
    });
  }
  const name = `${PROBE_PERMISSION_SET_PREFIX}${input.purpose}_${Date.now()}`;
  let permissionSetId: string | null = null;
  let fieldPermissionId: string | null = null;
  let assignmentId: string | null = null;
  const plan = (): RevertPlan => Object.freeze({
    kind: 'DELETE_SET',
    name,
    permissionSetId,
    assignmentId,
    fieldPermissionIds: Object.freeze(fieldPermissionId === null ? [] : [fieldPermissionId]),
    label: `PermissionSet (${input.purpose}, created)`,
  });
  try {
    permissionSetId = await createRow(input.connection, 'PermissionSet', Object.freeze({
      Name: name,
      Label: `P10 FLS probe (${input.purpose}) ${new Date().toISOString()}`,
      Description: 'Created and deleted by the P10-T3 live milestone. Safe to delete.',
    }));
    if (permissionSetId === null) throw new Error('The created permission set returned no id.');
    fieldPermissionId = await createRow(input.connection, 'FieldPermissions', Object.freeze({
      ParentId: permissionSetId,
      SobjectType: MILESTONE_OBJECT,
      Field: `${MILESTONE_OBJECT}.${input.fieldApiName}`,
      PermissionsRead: true,
      PermissionsEdit: true,
    }));
    assignmentId = await createRow(input.connection, 'PermissionSetAssignment', Object.freeze({
      AssigneeId: input.subjectUserId,
      PermissionSetId: permissionSetId,
    }));
    return Object.freeze({
      gate: gate(true, Object.freeze({
        purpose: input.purpose,
        nameMasked: maskIdentifier(name),
        field: input.fieldApiName,
        permissionSetIdMasked: maskSalesforceId(permissionSetId),
      }), 'The temporary permission set was not created.'),
      plan: plan(),
      wrote: true,
    });
  } catch (error) {
    // The partial state is returned so the cleanup still removes what did get created: a permission set made
    // before its field permission failed is exactly the kind of orphan a shared sandbox must not keep.
    return Object.freeze({
      gate: failGate(
        `The temporary permission set for the ${input.purpose} case could not be created: Salesforce refused it `
        + `with ${salesforceErrorCodeOf(error) ?? 'no Salesforce error code'}. Creating a permission set needs `
        + '"Manage Profiles and Permission Sets", which the DIAGNOSTIC identity may not hold — and this is the '
        + 'one leg of the milestone that cannot be worked around by reading harder.',
        Object.freeze({
          purpose: input.purpose,
          salesforceErrorCode: salesforceErrorCodeOf(error),
          permissionSetCreated: permissionSetId !== null,
          fieldPermissionCreated: fieldPermissionId !== null,
          assignmentCreated: assignmentId !== null,
        }),
      ),
      plan: plan(),
      wrote: permissionSetId !== null || fieldPermissionId !== null || assignmentId !== null,
    });
  }
}

/** The object layer, as a leg: the gate is about the row, the name is the object rather than a field. */
async function establishObjectLayer(input: Readonly<{
  connection: Connection;
  objectApiName: string;
  profileParent: ParentFacts | null;
  writeAllowed: boolean;
}>): Promise<EstablishedControl> {
  if (input.profileParent === null) {
    return Object.freeze({
      gate: notTested(
        'The Tool resolved no subject, or the subject holds no profile-owned permission set, so there was no '
        + 'row to establish the object-level read on and no layer to conclude anything beneath.',
      ),
      plan: null,
      fieldApiName: null,
      wrote: false,
      source: 'NO_PROFILE_LAYER',
    });
  }
  const preparation = await ensureObjectReadRow({
    connection: input.connection,
    objectApiName: input.objectApiName,
    parent: input.profileParent,
    writeAllowed: input.writeAllowed,
  });
  if (!preparation.ok) {
    return unavailableControl(preparation, 'NOT_ESTABLISHED',
      'The object-level read row this run needed is not readable, and creating it did not succeed.');
  }
  return Object.freeze({
    gate: gate(true, Object.freeze({
      source: preparation.state,
      objectApiName: input.objectApiName,
      ...preparation.detail,
    }), 'The object-level read row could not be established.'),
    plan: preparation.plan,
    fieldApiName: null,
    wrote: preparation.state === 'CREATED' || preparation.state === 'UPDATED',
    source: preparation.state,
  });
}

/**
 * The closed field, as a leg: the org's own denial if it has one, otherwise a row this run modifies.
 *
 * The three paths are kept apart in the report because they are different claims. `ALREADY_DENIED_BY_THE_ORG`
 * means the run watched the Tool read a denial it did not create — the stronger observation. `UPDATED` means
 * the run closed a field by flipping a row the org already had, which is the path the live sandbox left open.
 * `CREATED` means the run made a row where there was none, which the first live run measured to be refused.
 */
async function establishClosedField(input: Readonly<{
  connection: Connection;
  objectApiName: string;
  profileParent: ParentFacts | null;
  rows: readonly FieldPermissionRow[];
  describedFields: readonly string[];
  writeAllowed: boolean;
}>): Promise<EstablishedControl> {
  if (input.profileParent === null) {
    return Object.freeze({
      gate: notTested('The subject holds no profile-owned permission set, so there was no layer to close a field on.'),
      plan: null,
      fieldApiName: null,
      wrote: false,
      source: 'NO_PROFILE_LAYER',
    });
  }
  const profileParent = input.profileParent;
  const profileRows = input.rows.filter((row) => row.parentId === profileParent.id);
  const alreadyDenied = pickDeniedField(profileRows, input.rows, input.describedFields);
  if (alreadyDenied !== null) {
    return Object.freeze({
      gate: gate(true, Object.freeze({
        source: 'ALREADY_DENIED_BY_THE_ORG',
        field: alreadyDenied,
        reason: 'The org already denies the subject read and edit on this field on the profile layer, and no '
          + 'other layer grants it, so the closed case is an observation of the Tool reading a configuration '
          + 'this run did not create.',
      }), 'The org already denies this field, so nothing was written for it.'),
      plan: null,
      fieldApiName: alreadyDenied,
      wrote: false,
      source: 'ALREADY_DENIED_BY_THE_ORG',
    });
  }
  // The update path first, because it is the one the platform permits. `pickUngrantedField` is consulted only
  // when no granted row exists to flip; its create is refused on this org, and when it is the report says so
  // in Salesforce's words rather than silently recording a closure that never happened.
  const closable = pickClosableField(profileRows, input.rows, input.describedFields, []);
  const candidate = closable ?? pickUngrantedField(input.describedFields, input.rows, []);
  if (candidate === null) {
    return Object.freeze({
      gate: notTested(
        'No field on this object could be closed: the org grants the subject read on no field the harness is '
        + 'willing to write field-level security for, and its object has no field the harness recognises.',
        Object.freeze({ describedFields: input.describedFields.length, rowsRead: input.rows.length }),
      ),
      plan: null,
      fieldApiName: null,
      wrote: false,
      source: 'NO_FIELD_TO_CLOSE',
    });
  }
  const preparation = await ensureFieldRow({
    connection: input.connection,
    objectApiName: input.objectApiName,
    parent: profileParent,
    fieldApiName: candidate,
    read: false,
    edit: false,
    writeAllowed: input.writeAllowed,
  });
  if (!preparation.ok) {
    return unavailableControl(preparation, 'NOT_ESTABLISHED',
      'The field-level row this run needed in order to close a field could not be established.');
  }
  return Object.freeze({
    gate: gate(true, Object.freeze({
      source: preparation.state,
      field: candidate,
      path: stringOrNull(preparation.detail.mechanism)
        ?? (closable === null ? 'CREATE_A_DENY_ROW' : 'UPDATE_AN_EXISTING_GRANT'),
      priorState: preparation.detail,
    }), 'The field could not be closed for the subject.'),
    plan: preparation.plan,
    fieldApiName: candidate,
    wrote: preparation.state === 'CREATED' || preparation.state === 'UPDATED',
    source: preparation.state,
  });
}

/**
 * The positive control, as a leg: a field the org already grants read and edit on, or one this run grants.
 *
 * Both halves are the same claim — the Tool must report a field that is open as open — but only the first is
 * free. When the org stores no row granting read and edit anywhere, the control is a temporary permission
 * set, and then it also proves something the free half cannot: that the permission-set layer reaches the
 * conclusion at all.
 */
async function establishOpenControl(input: Readonly<{
  connection: Connection;
  rows: readonly FieldPermissionRow[];
  describedFields: readonly string[];
  subjectUserId: string | null;
  exclude: readonly string[];
  writeAllowed: boolean;
}>): Promise<EstablishedControl> {
  const alreadyOpen = pickOpenField(input.rows, input.describedFields, input.exclude);
  if (alreadyOpen !== null) {
    return Object.freeze({
      gate: gate(true, Object.freeze({
        source: 'ALREADY_GRANTED_BY_THE_ORG',
        field: alreadyOpen,
        reason: 'The org already carries a row granting this field read and edit, so the positive control is an '
          + 'observation of the Tool reading the org rather than a grant this run created.',
      }), 'The org already grants this field, so nothing was written for it.'),
      plan: null,
      fieldApiName: alreadyOpen,
      wrote: false,
      source: 'ALREADY_GRANTED_BY_THE_ORG',
    });
  }
  const target = pickGrantTarget(input.describedFields, input.exclude);
  if (target === null || input.subjectUserId === null) {
    return Object.freeze({
      gate: notTested(
        'This object has no field the harness could grant as a positive control, or the Tool resolved no subject '
        + 'to grant it to.',
        Object.freeze({
          describedFields: input.describedFields.length,
          subjectResolved: input.subjectUserId !== null,
        }),
      ),
      plan: null,
      fieldApiName: null,
      wrote: false,
      source: 'NO_FIELD_TO_GRANT',
    });
  }
  const created = await createTemporaryGrant({
    connection: input.connection,
    writeAllowed: input.writeAllowed,
    subjectUserId: input.subjectUserId,
    fieldApiName: target,
    purpose: 'OPEN_CONTROL',
  });
  return Object.freeze({
    gate: created.gate,
    plan: created.plan,
    fieldApiName: created.gate.status === 'PASS' ? target : null,
    wrote: created.wrote,
    source: created.gate.status === 'PASS' ? 'CONSTRUCTED' : 'NOT_ESTABLISHED',
  });
}

/** A `create` that returns the new row's id, or throws — jsforce reports a failure inside the result. */
async function createRow(
  connection: Connection,
  objectName: string,
  values: Readonly<Record<string, unknown>>,
): Promise<string | null> {
  const result = await (connection.sobject(objectName) as unknown as Readonly<{
    create(input: Readonly<Record<string, unknown>>): Promise<unknown>;
  }>).create(values);
  const record = recordOf(result);
  if (record?.success === false) throw rowRefusal(objectName, record);
  return stringOrNull(record?.id);
}

async function updateRow(
  connection: Connection,
  objectName: string,
  values: Readonly<Record<string, unknown>>,
): Promise<void> {
  const result = await (connection.sobject(objectName) as unknown as Readonly<{
    update(input: Readonly<Record<string, unknown>>): Promise<unknown>;
  }>).update(values);
  const record = recordOf(result);
  if (record?.success === false) throw rowRefusal(objectName, record);
}

/**
 * A refused row, carrying the platform's own per-field errors.
 *
 * `{ success: false }` on its own is the same defect the T2 evidence page records twice over: a report that
 * says the platform said no without saying why costs a second investigation. The `errors` array jsforce
 * returns on a failed DML row names the field and the reason, so it is lifted into the thrown error — one
 * `errorCode` for the gate, the messages joined for the reader. Only the first few are kept, because a
 * refusal on a single row is one problem and a long list is not a report.
 */
function rowRefusal(objectName: string, record: Readonly<Record<string, unknown>>): Error {
  const errors = readRecords(record.errors);
  const detail = errors
    .slice(0, 3)
    .map((entry) => [stringOrNull(entry.errorCode), stringOrNull(entry.message)].filter((part) => part !== null).join(': '))
    .filter((part) => part.length > 0)
    .join('; ');
  const error = new Error(`${objectName}: ${detail.length === 0 ? 'Salesforce refused the row without naming a reason.' : detail}`);
  return Object.assign(error, { errorCode: stringOrNull(errors[0]?.errorCode) });
}

async function destroyRow(connection: Connection, objectName: string, id: string): Promise<void> {
  await (connection.sobject(objectName) as unknown as Readonly<{
    destroy(recordId: string): Promise<unknown>;
  }>).destroy(id);
}

/**
 * Puts the org back, and then checks that it is back.
 *
 * Two halves, and the second is the one that matters. The plans are executed in order — a permission set's
 * assignment before the set itself, because Salesforce refuses the other order — and each failure is recorded
 * rather than thrown, so one stuck row does not leave the rest of them in place.
 *
 * Then the same reads that found the rows are run again and compared against the snapshot taken before the
 * first write. That comparison is what makes "the org is as it was" a measurement: the plans can only undo
 * what this run remembers doing, while the snapshot catches everything it did not.
 */
async function runCleanup(input: Readonly<{
  connection: Connection;
  plans: readonly RevertPlan[];
  objectApiName: string;
  parentIds: readonly string[];
  subjectUserId: string | null;
  before: OrgPermissionSnapshot;
}>): Promise<P10LiveGate> {
  const removed: string[] = [];
  const failures: string[] = [];
  for (const plan of input.plans) {
    try {
      if (plan.kind === 'DELETE_ROW') {
        await destroyRow(input.connection, plan.object, plan.id);
      } else if (plan.kind === 'RESTORE_ROW') {
        await updateRow(input.connection, plan.object, Object.freeze({ Id: plan.id, ...plan.values }));
      } else if (plan.kind === 'RECREATE_ROW') {
        // The row was deleted rather than edited, so it comes back as a new row with the values it had. The
        // snapshot comparison is by value rather than by id, which is what makes a re-created row an exact
        // restore — and why an id-based check would have reported a false drift here.
        const restored = await createRow(input.connection, plan.object, plan.values);
        if (restored === null) {
          throw new Error(`${plan.object} came back without an id, so the row this run deleted was not restored.`);
        }
      } else {
        // A permission set cannot be deleted while a user still holds it, so the cascade is ordered.
        if (plan.assignmentId !== null) {
          await destroyRow(input.connection, 'PermissionSetAssignment', plan.assignmentId);
        }
        for (const id of plan.fieldPermissionIds) {
          await destroyRow(input.connection, 'FieldPermissions', id);
        }
        if (plan.permissionSetId !== null) {
          await destroyRow(input.connection, 'PermissionSet', plan.permissionSetId);
        }
        // The name is checked as well as the id: a set that was created but whose id never came back would
        // otherwise be invisible here, and it is the one leftover a reader could not find by hand.
        const leftover = await queryRows(
          input.connection,
          `SELECT Id FROM PermissionSet WHERE Name = '${escapeSoqlLiteral(plan.name)}' LIMIT 1`,
        );
        if (leftover.length > 0) {
          failures.push(`${plan.label}: a permission set named ${maskIdentifier(plan.name)} is still in the org`);
          continue;
        }
      }
      removed.push(plan.label);
    } catch (error) {
      failures.push(`${plan.label}: ${salesforceErrorCodeOf(error) ?? 'unknown error'}`);
    }
  }

  const after = await readOrgPermissionSnapshot(
    input.connection, input.objectApiName, input.parentIds, input.subjectUserId,
  );
  const drift = snapshotDrift(input.before, after);
  const facts = failures.length === 0 && drift.length === 0;

  return gate(facts, Object.freeze({
    reverted: removed,
    failures,
    snapshotLinesBefore: input.before.length,
    snapshotLinesAfter: after.length,
    // Empty when the org is as it was. Every line here is a fact about a deployment this run changed and did
    // not change back, which makes it the most important thing the report can carry.
    drift,
    plansExecuted: input.plans.length,
  }), 'The run did not put the org back the way it found it: a row or permission set it created is still '
    + 'there, or something it changed was not restored. Every measurement above is then a measurement of a '
    + 'deployment this run left altered.');
}

/**
 * The cross-check against Setup.
 *
 * This is the machine's stand-in for opening the profile in the Setup UI and comparing. It is deliberately
 * a *different* reading of the same tables rather than a reuse of the Tool's query: the harness asks the
 * org for the subject's grants itself and asserts that the Tool's grant list is that list, so the milestone
 * can distinguish "the Tool reported the org" from "the Tool reported something self-consistent".
 *
 * The `true` half of the comparison — that the harness's own read agrees the field is denied — is the part
 * a human eyeballing Setup would be checking, so its failure is what "the Tool disagreed with Setup" means
 * in this report.
 */
function runSetupCrossCheck(input: Readonly<{
  rows: readonly FieldPermissionRow[];
  parents: readonly ParentFacts[];
  closedField: P10LiveGate;
  closedFieldName: string | null;
  describedFields: readonly string[];
}>): P10LiveGate {
  if (input.closedFieldName === null) {
    return notTested('No closed field was measured, so there was nothing to cross-check against Setup.');
  }
  if (input.closedField.status !== 'PASS') {
    return notTested('The closed-field gate did not pass, so its report was not cross-checked.', Object.freeze({
      closedField: input.closedField.detail,
    }));
  }
  const byParent = new Map(input.parents.map((parent) => [parent.id, parent]));
  const ownRows = input.rows.filter((row) => row.bareField === input.closedFieldName);
  const ownGrants = ownRows.map((row) => Object.freeze({
    parentType: byParent.get(row.parentId)?.isOwnedByProfile === true ? 'PROFILE' : 'PERMISSION_SET',
    parentName: byParent.get(row.parentId)?.name ?? null,
    permissionsRead: row.permissionsRead,
    permissionsEdit: row.permissionsEdit,
  }));
  const reported = readRecords(input.closedField.detail.grants).map((grant) => Object.freeze({
    parentType: grant.parentType ?? null,
    parentName: grant.parentName ?? null,
    permissionsRead: grant.permissionsRead ?? null,
    permissionsEdit: grant.permissionsEdit ?? null,
  }));
  const key = (grants: readonly Readonly<{
    parentType: unknown; parentName: unknown; permissionsRead: unknown; permissionsEdit: unknown;
  }>[]): readonly string[] => grants
    .map((grant) => `${String(grant.parentType)}/${String(grant.parentName)}/${String(grant.permissionsRead)}/${String(grant.permissionsEdit)}`)
    .sort();
  const deniesRead = ownGrants.length === 0 || ownGrants.every((grant) => grant.permissionsRead === false);
  const facts = sameArray(key(ownGrants), key(reported)) && deniesRead;

  return gate(facts, Object.freeze({
    field: input.closedFieldName,
    ownReadOfTheOrg: Object.freeze({
      rowsForThisField: ownRows.length,
      grants: ownGrants,
      deniedToTheSubject: deniesRead,
      interpretation: ownRows.length === 0
        ? 'The org stores no FieldPermissions row for this subject on this field, and every row that was read for '
          + 'the object grants nothing on it — which is the configuration Setup shows as the field being absent '
          + 'from the profile.'
        : 'The org stores an explicit row for this subject on this field and it grants neither read nor edit.',
    }),
    reportedByTheTool: reported,
    grantListsMatch: sameArray(key(ownGrants), key(reported)),
    profileRowKind: input.rows.some((row) => byParent.get(row.parentId)?.isOwnedByProfile === true)
      ? 'PRESENT_ON_A_PROFILE_OWNED_SET'
      : 'NO_PROFILE_OWNED_ROW_READ',
    describedFieldCount: input.describedFields.length,
  }), 'The Tool\'s grant list for the closed field is not the grant list this harness read from the same tables, '
    + 'or the harness\'s own read does not agree that the subject is denied — which is what "the Tool disagrees '
    + 'with Setup" means here.');
}

function maskedIdOfValue(value: unknown): string | null {
  return maskedIdOf(value);
}

function maskedIdentifier(value: unknown): string | null {
  const text = stringOrNull(value);
  return text === null ? null : maskIdentifier(text);
}
