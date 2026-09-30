import type { Connection } from '@salesforce/core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  DEFAULT_AUDIT_FLUSH_TIMEOUT_MS,
  type AsyncAuditPipeline,
  type AuditPipelineHealth,
  type ControlPlaneDatabaseClient,
  type MySqlControlPlaneStore,
  type RequestPolicySnapshot,
  freezeSnapshot,
} from '@sfoa/control-plane';
import type { SalesforceConnectionFactory, SalesforceIdentityRoute } from '@sfoa/identity-runtime';
import type { GracefulShutdownResult } from '../http-server.js';
import type { RuntimePolicySnapshotSource } from '../policy-snapshot.js';
import {
  maskIdentifier,
  maskSalesforceId,
  P10_PROBE_PLATFORM_USER_VARIABLE,
} from './p10-diagnostic-probe.js';

/**
 * The parts of a P10 live milestone that are the same for every one of them.
 *
 * `p10-t2-live-milestone.ts` grew these first and kept them module-private, with a note saying the two P10
 * harnesses would be unified once T6 builds `validate:p10` over both. T3 is the second consumer, and the
 * reason to move them now is not line count: every function here decides something the *evidence page*
 * depends on — what counts as `PASS`, whether a credential leaked, whether the run's own audit trail
 * survived. A copy of `runAuditPersistence` in a second file is a second definition of "the record is
 * complete", and two evidence pages about one deployment that disagree only because a helper was copied
 * are worse than either of them being wrong on its own.
 *
 * So this module is the shared measurement vocabulary. What stays in a milestone file is what is true of
 * *that* milestone: its Tools, its gates, and the claim it makes. What moved here is what is true of
 * running any of them against a live org — the gate algebra, the Connection factory that records which
 * identities were opened, the read-through-Tool plumbing, and the three run-level checks (credential
 * safety, audit persistence, orphan-free shutdown) that are identical by construction.
 *
 * Nothing here writes to the Control Plane, and nothing here prints a credential: `readAccessToken` exists
 * only so the run can search its own responses for the token it was given, and every id and username that
 * reaches a report passes through `maskIdentifier` or `maskSalesforceId` first.
 */

export type P10LiveStatus = 'PASS' | 'FAIL' | 'NOT TESTED';

export type P10LiveGate = Readonly<{
  status: P10LiveStatus;
  detail: Readonly<Record<string, unknown>>;
}>;

/** The org facts every milestone reports, read through the milestone's own DIAGNOSTIC Connection. */
export type P10LiveOrgFacts = Readonly<{
  isSandbox: boolean | null;
  instanceName: string | null;
  apiVersion: string | null;
  organizationIdMasked: string | null;
}>;

export type ConnectionMeasurement = Readonly<{
  platformUserId: string;
  salesforceUsername: string;
  connection: Connection;
}>;

/**
 * Wraps the real factory so the run can say which identities it opened Connections as.
 *
 * That list is the milestone's own answer to "did this Tool run as the caller?", which is a claim no Tool
 * response can make about itself: a wrong-identity read returns a plauasible answer from the wrong user's
 * point of view. Recording it here rather than inferring it from a response is what makes the claim
 * checkable.
 */
export class MeasuringConnectionFactory implements SalesforceConnectionFactory {
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
 * Enables a milestone's Tools without writing to the Control Plane.
 *
 * They ship default-disabled, exactly as P10 requires, and an Admin grant is what turns them on. Keeping
 * that grant out of the database means a live run never leaves the local Control Plane altered — and,
 * more importantly, means the run cannot pass by having quietly granted itself the Tools it is supposed
 * to prove can be granted.
 *
 * **It forwards the whole interface, and the optional member is the reason this note exists.** The first
 * T3 live run lost `explain_field_access`'s `targetUserId` boundary here: the decorator implemented only
 * `load`, the host's `?.()` call then saw no such method, and the empty set it defaulted to is a *valid*
 * answer — "this deployment configures no routes" — so the Tool refused every named target and the report
 * read as a fact about the deployment rather than as a harness that had dropped a method. Fail-closed
 * defaulting is right and the loss was still silent, which is what a decorator over an optional member
 * does unless it is written to hand the member on.
 */
export class AdditiveToolPolicySnapshotSource implements RuntimePolicySnapshotSource {
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

  /**
   * Forwarded verbatim. A delegate without the member yields the empty list the host itself defaults to,
   * which is the fail-closed bound rather than a second opinion about it.
   */
  public async listConfiguredSalesforceUsernames(): Promise<readonly string[]> {
    const delegate = this.delegate.listConfiguredSalesforceUsernames;
    return delegate === undefined ? Object.freeze([]) : await delegate.call(this.delegate);
  }
}

/**
 * The platform user a milestone drives, resolved in-process rather than taken from a command line.
 *
 * A real platform user id in shell history and in the process listing is a disclosure a harness has no
 * reason to make. An explicit `P10_PROBE_PLATFORM_USER` still wins when an operator needs a named route,
 * which is the one case where the id is already in the operator's hands.
 */
export async function resolveMilestonePlatformUser(
  store: MySqlControlPlaneStore,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const explicit = environment[P10_PROBE_PLATFORM_USER_VARIABLE]?.trim();
  if (explicit) return explicit;
  const page = await store.repositories.identityRoutes.list({ limit: 50, offset: 0 });
  const enabled = page.items.find((route) => route.enabled);
  if (!enabled) {
    throw new Error(
      'No enabled identity route exists in this Control Plane, so no platform user can be resolved for the milestone. '
      + `Set ${P10_PROBE_PLATFORM_USER_VARIABLE} to name one explicitly.`,
    );
  }
  return enabled.platformUserId;
}

// ---------------------------------------------------------------------------------------------
// The gate algebra. Three states rather than a boolean, because "the platform would not let this
// identity do it" is a fact about the deployment that must not be reported as a Tool defect.
// ---------------------------------------------------------------------------------------------

export function gate(
  condition: boolean,
  detail: Readonly<Record<string, unknown>>,
  failure: string,
): P10LiveGate {
  return Object.freeze({
    status: condition ? 'PASS' : 'FAIL',
    detail: Object.freeze(condition ? detail : { ...detail, failureReason: failure }),
  });
}

export function failGate(failure: string, detail: Readonly<Record<string, unknown>> = {}): P10LiveGate {
  return Object.freeze({
    status: 'FAIL',
    detail: Object.freeze({ ...detail, failureReason: failure }),
  });
}

export function notTested(reason: string, detail: Readonly<Record<string, unknown>> = {}): P10LiveGate {
  return Object.freeze({ status: 'NOT TESTED', detail: Object.freeze({ ...detail, reason }) });
}

/**
 * A run is `PASS` only when every gate passed, and `FAIL` as soon as one did — `NOT TESTED` never
 * upgrades to `PASS` and never downgrades to `FAIL`. `PARTIAL` is the whole point of the third state: a
 * sandbox-only step skipped on a production org is a measurement the run was not allowed to make, and
 * calling that a failure would train a reader to ignore the word.
 */
export function combine(gates: readonly P10LiveGate[]): 'PASS' | 'PARTIAL' | 'FAIL' {
  if (gates.every((entry) => entry.status === 'PASS')) return 'PASS';
  if (gates.every((entry) => entry.status === 'FAIL')) return 'FAIL';
  return gates.some((entry) => entry.status === 'FAIL') ? 'FAIL' : 'PARTIAL';
}

export function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// ---------------------------------------------------------------------------------------------
// Reading a Tool's answer. A milestone reasons about `structuredContent`, never about prose.
// ---------------------------------------------------------------------------------------------

export async function call(
  client: Client,
  results: CallToolResult[],
  name: string,
  argumentsValue: Readonly<Record<string, unknown>>,
): Promise<CallToolResult> {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: argumentsValue }));
  results.push(result);
  return result;
}

export function outputOf(result: CallToolResult | undefined): Record<string, unknown> | undefined {
  return recordOf(result?.structuredContent);
}

export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function readRecords(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap((entry) => {
    const record = recordOf(entry);
    return record === undefined ? [] : [record];
  }) : [];
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Masked for the report: a Salesforce id is org configuration and is never printed whole. */
export function maskedIdOf(value: unknown): string | null {
  const id = stringOrNull(value);
  return id === null ? null : maskSalesforceId(id);
}

export function salesforceErrorCodeOf(error: unknown): string | null {
  const code = recordOf(error)?.errorCode;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/**
 * The platform's own words about a refusal, masked and bounded.
 *
 * The same argument as `toolFailureDetail`'s, one layer down: a harness that records only
 * `FIELD_INTEGRITY_EXCEPTION` has recorded that Salesforce said no without recording *why*, and the why is
 * the whole finding — the T2 §4.1 investigation existed because a report said `MCP_APEX_LOG_READ_FAILED`
 * and nothing more. A Salesforce message is org-authored text and names the rows involved, so ids inside it
 * are masked here and the length is bounded so one verbose refusal cannot dominate the report.
 */
export function salesforceMessageOf(error: unknown): string | null {
  const message = stringOrNull(error instanceof Error ? error.message : recordOf(error)?.message);
  return message === null ? null : maskIdsInText(message).slice(0, 400);
}

/**
 * A failed Tool's own account of why, carried into the gate detail.
 *
 * The executors build these four fields deliberately: the server-owned `errorCode`, the Salesforce code
 * behind it, a remediation `suggestion`, and — where ADR-0029 §2 applies — the missing `prerequisite`.
 * Keeping only the first is what made the first T2 live run report `MCP_APEX_LOG_READ_FAILED` with no way
 * to tell *which* clause the platform had refused; the root cause had to be found afterwards with a
 * throwaway probe against the same scope. A report that costs a second investigation to read is not
 * evidence, and ADR-0029's degradation contract is precisely a claim about how a source reports itself, so
 * the whole record is quoted here rather than summarised.
 *
 * Salesforce ids inside the message are masked. A refusal names the rows involved and this report is
 * written to a file that is kept beside the other `docs/sfoa` evidence. The message itself is Tool-authored
 * text, never a caller's, and the run's own credential-safety gate scans every Tool output for the tokens
 * that were live during it.
 */
export function toolFailureDetail(output: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const message = stringOrNull(output.message);
  return Object.freeze({
    errorCode: stringOrNull(output.errorCode),
    message: message === null ? null : maskIdsInText(message),
    salesforceErrorCode: stringOrNull(output.salesforceErrorCode),
    suggestion: stringOrNull(output.suggestion),
    prerequisite: stringOrNull(output.prerequisite),
  });
}

/** Salesforce ids inside free text, masked: 15 or 18 characters and letter-initial, as ids are. */
export function maskIdsInText(text: string): string {
  return text.replace(/\b[A-Za-z][0-9A-Za-z]{14}(?:[0-9A-Za-z]{3})?\b/gu, (id) => maskSalesforceId(id));
}

/**
 * Email addresses inside free text, masked the same way a username is everywhere else in these reports.
 *
 * It exists for one caller: the recorded SOQL. A statement the Tool sent carries the deployment's configured
 * route usernames inside its `Username IN (…)` literal, and the report is written to a file and quoted into
 * `docs/sfoa`. Every other place a username reaches the report it arrives already masked — this is the one
 * path where the raw text is the value, so the masking has to happen where the statement is recorded rather
 * than where it is printed. Ids are left alone: a statement that mentions a subject id is a fact the data-plane
 * gate counts, and `masked` there would break the count without protecting anything the id list does not
 * already mask at the point of use.
 */
export function maskUsernamesInText(text: string): string {
  return text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, (username) => maskIdentifier(username));
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

// ---------------------------------------------------------------------------------------------
// The three checks that are the same for every live run.
// ---------------------------------------------------------------------------------------------

export function runCredentialSafety(
  results: readonly CallToolResult[],
  clientToken: string,
  accessToken: string | null,
): P10LiveGate {
  const secrets = [clientToken, accessToken]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  const offenders: string[] = [];
  for (const result of results) {
    const rendered = JSON.stringify(result);
    for (const secret of secrets) {
      if (rendered.includes(secret)) offenders.push('a Tool response carried a credential it was given');
    }
  }
  return gate(offenders.length === 0, Object.freeze({
    toolResponsesInspected: results.length,
    secretsSearched: secrets.length,
    offenders: [...new Set(offenders)],
  }), 'A Tool response echoed a credential back into the transcript.');
}

export async function flushAuditTrail(
  auditPipeline: AsyncAuditPipeline,
): Promise<Readonly<{ flushed: boolean; dropped: number | null; health: AuditPipelineHealth }>> {
  const outcome = await auditPipeline.close(DEFAULT_AUDIT_FLUSH_TIMEOUT_MS).catch(() => undefined);
  return Object.freeze({
    flushed: outcome?.flushed === true,
    dropped: outcome === undefined ? null : outcome.dropped,
    health: auditPipeline.getHealth(),
  });
}

/**
 * The run's own trail, checked before its results are believed.
 *
 * The milestone's evidence for the audit requirement is the rows this run wrote, so a run that lost part
 * of its trail cannot report a clean `overall` — not because a Tool misbehaved, but because the record of
 * what it did is incomplete. The shutdown is checked too: `close()` races its drain against a grace
 * timeout and abandons what is left when it loses, so a clean flush can sit over a short trail. `null`
 * means no server was started and there was nothing to drain.
 */
export function runAuditPersistence(
  audits: Readonly<{ flushed: boolean; dropped: number | null; health: AuditPipelineHealth }>,
  shutdown: GracefulShutdownResult | null | undefined,
): P10LiveGate {
  return gate(
    audits.flushed
      && audits.dropped === 0
      && audits.health.droppedSnapshots === 0
      && audits.health.writerFailureCount === 0
      && (shutdown === null || (shutdown !== undefined && shutdown.drained === true)),
    Object.freeze({ ...audits, shutdown: shutdown ?? null }),
    'The run did not persist the whole of its own audit trail, so the P7 evidence for this milestone is '
    + 'incomplete. The live facts above still hold; what is missing is the record of them.',
  );
}

export async function closeQuietly(
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

// ---------------------------------------------------------------------------------------------
// The two reads a milestone makes on its own Connection rather than through a Tool — because they
// are about the org and the identity, which no Tool of these Toolsets answers for.
// ---------------------------------------------------------------------------------------------

export async function readOrgFacts(connection: Connection): Promise<P10LiveOrgFacts> {
  const apiVersion = typeof connection.getApiVersion === 'function' ? connection.getApiVersion() : null;
  try {
    const payload = await connection.query(
      'SELECT IsSandbox, InstanceName, OrganizationType, Id FROM Organization LIMIT 1',
    ) as unknown as Readonly<{ records?: readonly Record<string, unknown>[] }>;
    const row = readRecords(payload.records)[0] ?? {};
    const organizationId = stringOrNull(row.Id);
    return Object.freeze({
      isSandbox: row.IsSandbox === true,
      instanceName: stringOrNull(row.InstanceName),
      apiVersion: typeof apiVersion === 'string' ? apiVersion : null,
      organizationIdMasked: organizationId === null ? null : maskSalesforceId(organizationId),
    });
  } catch {
    return Object.freeze({
      isSandbox: null,
      instanceName: null,
      apiVersion: typeof apiVersion === 'string' ? apiVersion : null,
      organizationIdMasked: null,
    });
  }
}

/** Read only to be searched for in the responses; never printed, and never written to the report. */
export async function readAccessToken(connection: Connection): Promise<string | null> {
  const token = (connection as unknown as Readonly<Record<string, unknown>>).accessToken;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

// ---------------------------------------------------------------------------------------------
// The Tool inventory, which is the governance half of every milestone.
// ---------------------------------------------------------------------------------------------

/** The part of an advertised Tool this check reads. Structural, so the SDK's own type can be passed in. */
export type AdvertisedTool = Readonly<{
  name: string;
  inputSchema?: Readonly<{ properties?: Record<string, unknown> }>;
  annotations?: Readonly<Record<string, unknown>>;
}>;

/**
 * The Tool inventory gate, generalized over the Toolset under test.
 *
 * A milestone's value depends on its Tools being *advertised* exactly as the grant says, so the whole
 * advertised set is compared rather than only the milestone's own names: a Tool that appeared or
 * disappeared is a governance fact a live run should not be able to walk past. Input keys are compared as
 * sorted sets rather than scanned for forbidden names, because a scan for `username`/`token` would pass a
 * newly added `salesforceAlias` — a set equality cannot.
 *
 * `writeTools` names the Tools that must advertise `readOnlyHint: false`. It is a list rather than a
 * predicate so the expectation is legible in the report, and it defaults to empty: a milestone whose
 * Tools are all reads states that by saying nothing.
 */
export function runToolInventory(input: Readonly<{
  tools: readonly AdvertisedTool[];
  milestoneTools: readonly string[];
  expectedNames: readonly string[];
  inputKeys: Readonly<Record<string, readonly string[]>>;
  writeTools?: readonly string[];
}>): P10LiveGate {
  const advertised = input.tools.map((tool) => tool.name).sort();
  const inspected = input.tools.filter((tool) => input.milestoneTools.includes(tool.name));
  const writeTools = input.writeTools ?? [];
  const keyMismatches = inspected.flatMap((tool) => {
    const actual = Object.keys(tool.inputSchema?.properties ?? {}).sort();
    const expected = [...(input.inputKeys[tool.name] ?? [])].sort();
    return sameArray(actual, expected)
      ? []
      : [`${tool.name}: advertised ${actual.join(', ') || 'nothing'} but the contract defines ${expected.join(', ')}`];
  });
  const annotationMismatches = inspected.flatMap((tool) => {
    const expectedReadOnly = !writeTools.includes(tool.name);
    return tool.annotations?.readOnlyHint === expectedReadOnly
      ? []
      : [`${tool.name}: readOnlyHint is ${String(tool.annotations?.readOnlyHint)} but should be ${expectedReadOnly}`];
  });
  const missing = input.milestoneTools.filter((name) => !advertised.includes(name));

  return gate(
    missing.length === 0 && sameArray(advertised, input.expectedNames)
      && keyMismatches.length === 0 && annotationMismatches.length === 0,
    Object.freeze({
      advertised,
      expectedFromSnapshot: input.expectedNames,
      missingMilestoneTools: missing,
      inputKeys: Object.fromEntries(inspected.map((tool) => [
        tool.name,
        Object.keys(tool.inputSchema?.properties ?? {}).sort(),
      ])),
      annotations: Object.fromEntries(inspected.map((tool) => [tool.name, tool.annotations ?? {}])),
      keyMismatches,
      annotationMismatches,
    }),
    'The advertised Tool inventory did not match the grant, a milestone Tool exposed an input key its contract '
    + 'does not define, or a milestone Tool carried the wrong readOnlyHint.',
  );
}

/** Every Salesforce username this run opened a Connection as, deduped and masked. */
export function measuredSalesforceUsernames(factory: MeasuringConnectionFactory): readonly string[] {
  return [...new Set(factory.measurements.map((entry) => maskIdentifier(entry.salesforceUsername)))];
}
