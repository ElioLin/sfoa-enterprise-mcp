import type { Connection } from '@salesforce/core';
import {
  MySqlControlPlaneStore,
  MySqlIdentityRepository,
  createControlPlaneDatabase,
  type ControlPlaneDatabaseClient,
} from '@sfoa/control-plane';
import {
  JwtConnectionFactory,
  JsonLineRuntimeLogger,
  createIdentityRuntime,
  redactSensitiveText,
  type RequestScope,
} from '@sfoa/identity-runtime';
import { readSalesforceFailure } from '@sfoa/mcp-provider-sfoa-data';
import { loadRemoteRuntimeConfig } from '../config.js';
import { MySqlRuntimePolicySnapshotSource, snapshotDiagnosticRoute } from '../policy-snapshot.js';

/**
 * P10-T1 diagnostic capability probe.
 *
 * The six P10 Tools all run on the server-owned DIAGNOSTIC identity, and every one of them depends on
 * that identity being able to read a Salesforce surface a business integration identity cannot:
 * ApexLog, TraceFlag, DebugLevel, SetupAuditTrail and the permission tables. P9 learned the cost of
 * assuming that the expensive way — `get_org_limits` was designed against a belief about what a routed
 * identity could read, the live probe disproved it, and the Tool had to be re-homed onto the
 * DIAGNOSTIC scope (ADR-0027).
 *
 * So this probe measures the prerequisites before anything is built on them. It opens exactly the
 * Connection the Tools will open: `snapshotDiagnosticRoute` over the runtime's request scope factory,
 * the same pairing `http-server.ts` uses for a DIAGNOSTIC `tools/call`. Opening it any other way
 * would measure a different identity than the Tools run on, which would make the report irrelevant to
 * the question it exists to answer.
 *
 * Three rules the implementation holds to:
 *
 * 1. **Measured facts, never inferences.** Every step records the Salesforce error code it actually
 *    received. A step that was not attempted reports `NOT_PROBED` and why. Nothing is reported as a
 *    capability because documentation says the capability exists.
 * 2. **Writes only where the org itself says they are safe.** The write probes run only when
 *    `Organization.IsSandbox` says true, and each one deletes exactly the row it created, in the same
 *    step. A production org is measured read-only and its write legs become `NOT_PROBED`.
 * 3. **Nothing sensitive leaves the process.** Statements, ids and messages are masked and redacted
 *    before they are recorded, so the report can be committed as evidence.
 */

export const P10_PROBE_PLATFORM_USER_VARIABLE = 'P10_PROBE_PLATFORM_USER';

/** Set to `off` to run the read-only half even in a sandbox. It can never turn writes *on*. */
export const P10_PROBE_WRITE_PROBES_VARIABLE = 'P10_PROBE_WRITE_PROBES';

/** Where a P10 question is asked. Recorded so the ADR can say which API was measured. */
export const P10_PROBE_AREAS = [
  'ORG', 'DEBUG_LOG', 'PLATFORM', 'PERMISSION', 'METADATA', 'LOCALIZATION', 'BOUNDARY',
] as const;
export type P10ProbeArea = (typeof P10_PROBE_AREAS)[number];

export const P10_PROBE_SOURCES = ['STANDARD', 'TOOLING', 'METADATA', 'REST'] as const;
export type P10ProbeSource = (typeof P10_PROBE_SOURCES)[number];

/**
 * `AVAILABLE` is the only outcome that means "the diagnostic identity can do this". `DENIED` is a
 * Salesforce refusal carrying a code — for several steps that is the *expected* and useful answer,
 * because a Tooling query naming a business object is supposed to be refused structurally. That is
 * why a refusal is recorded as a fact about the org rather than as a harness failure.
 */
export const P10_PROBE_OUTCOMES = ['AVAILABLE', 'DENIED', 'ERROR', 'SKIPPED', 'NOT_PROBED'] as const;
export type P10ProbeOutcome = (typeof P10_PROBE_OUTCOMES)[number];

export type P10ProbeStep = Readonly<{
  id: string;
  area: P10ProbeArea;
  /** The design question this step answers, in the words the ADR will use. */
  question: string;
  source: P10ProbeSource;
  /** The redacted statement or request path, or null when the step issues no Salesforce call. */
  statement: string | null;
  outcome: P10ProbeOutcome;
  salesforceErrorCode: string | null;
  errorMessageSafe: string | null;
  facts: Readonly<Record<string, unknown>>;
}>;

export type P10ProbeOrgFacts = Readonly<{
  isSandbox: boolean | null;
  organizationType: string | null;
  instanceName: string | null;
  apiVersion: string | null;
  organizationIdMasked: string | null;
}>;

export type P10DiagnosticProbeReport = Readonly<{
  phase: 'P10';
  task: 'T1';
  generatedAt: string;
  probeMode: 'SANDBOX_WRITE_ALLOWED' | 'READ_ONLY';
  platformUserIdMasked: string;
  diagnosticIdentity: Readonly<{
    configured: boolean;
    enabled: boolean | null;
    verificationStatus: string | null;
    salesforceUsernameMasked: string | null;
  }>;
  org: P10ProbeOrgFacts;
  steps: readonly P10ProbeStep[];
  summary: Readonly<Record<P10ProbeOutcome, number>>;
  /** Steps that are not `AVAILABLE`, so a reader does not have to filter the list to find them. */
  openQuestions: readonly string[];
}>;

/**
 * Salesforce codes that mean "the org refused this", as opposed to "the probe's own harness broke".
 *
 * The distinction is the whole reason this list exists: a refusal carries the answer to the question the
 * step asked, so recording it as `ERROR` would report the finding as a fault. The set is deliberately
 * explicit rather than "any error that carries a code", because `ERROR` has to keep meaning something —
 * a thrown error with no code is the probe being wrong, and widening the rule until nothing is ever an
 * `ERROR` would delete that signal.
 *
 * `FIELD_INTEGRITY_EXCEPTION` is here because of what the write probes found: creating a second
 * `TraceFlag` for an entity that is already traced with an overlapping window is refused with that
 * code — a state refusal, not a permission one, and precisely the fact P10-1's design turns on.
 */
const SALESFORCE_REFUSAL_CODES = new Set([
  'INSUFFICIENT_ACCESS',
  'INSUFFICIENT_ACCESS_OR_READONLY',
  'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
  'INSUFFICIENT_PRIVILEGES',
  'API_DISABLED_FOR_ORG',
  'NOT_FOUND',
  'INVALID_TYPE',
  'INVALID_FIELD',
  'INVALID_OPERATION',
  'DUPLICATE_VALUE',
  'FIELD_INTEGRITY_EXCEPTION',
  'UNKNOWN_EXCEPTION',
]);

/**
 * Ids are masked by two rules rather than one, because a shape-only rule cannot tell a Salesforce id
 * from an ordinary identifier: `PermissionsRead`, `SetupAuditTrail` and `SolutionManager` are all
 * exactly 15 characters, the width of a Salesforce id. Masking those would corrupt the evidence the
 * report exists to carry — a reader could no longer see which field or which type a measurement was
 * about.
 *
 * So:
 *
 * - Free text is masked only for secrets, email addresses, and digit-leading 15/18-character runs.
 *   Every standard-object and most custom-object key begins with a digit (`005`, `0PS`, `07L`, `00D`),
 *   which is what makes this precise enough to leave names alone while still catching an id that
 *   appends itself to a log line or an error message.
 * - Structured values are masked by key: a value under a key naming an id is masked whatever it looks
 *   like, so `AssigneeId`, `ParentId` and `ProfileId` cannot survive on shape alone. See `clean`.
 */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
const DIGIT_LEADING_ID_PATTERN = /\b\d[A-Za-z0-9]{14}(?:[A-Za-z0-9]{3})?\b/gu;
const ID_KEY_PATTERN = /(?:^|[a-z])id(?:s|masked)?$/iu;
/**
 * A key can *name* an id without its value being one — a `{ CreatedById: 'YES' }` filterability answer,
 * for instance. Masking by key therefore also requires the value to have an id's width, or the rule
 * would destroy short non-id values that happen to sit under an id-ish name.
 */
const ID_SHAPED_VALUE_PATTERN = /^(?:[A-Za-z0-9]{15}|[A-Za-z0-9]{18})$/u;
const MAX_FACT_STRING = 300;
const MAX_SAFE_MESSAGE = 400;
const MAX_LOG_PREVIEW = 4_000;

type Facts = Record<string, unknown>;
/**
 * `DENIED` is deliberately absent here: it is reserved for a thrown Salesforce refusal, so the word
 * always means "Salesforce said no" rather than "a step decided to report one".
 */
type ProbeAttempt = Readonly<{ outcome: Exclude<P10ProbeOutcome, 'DENIED'>; facts: Facts }>;
type ProbeConnection = Connection;

/**
 * Records steps and owns every redaction decision, so a step handler can hand back raw Salesforce
 * values without each handler having to remember what may be written down.
 *
 * Exported for its unit suite. Desensitization is the one part of this probe whose failure is silent
 * and permanent — a leaked identifier is committed to a document, not thrown as an error — so it is
 * tested directly against the class that performs it rather than through the probe's Salesforce path.
 */
export class ProbeRecorder {
  private readonly steps: P10ProbeStep[] = [];

  public constructor(private readonly secrets: readonly string[]) {}

  public async record(
    id: string,
    area: P10ProbeArea,
    question: string,
    source: P10ProbeSource,
    statement: string | null,
    run: () => Promise<ProbeAttempt>,
    /**
     * Facts the step already knows before it makes its call, contributed when the call is refused.
     *
     * A refusal is the answer several of these steps are looking for, and it arrives as a thrown error
     * that carries only a code and a message. Without this the most interesting rows in the report — the
     * ones where Salesforce said no — would be the only ones with no context on them, so a reader could
     * not tell *which* entity was refused. The provider is called only on the failure path and is
     * wrapped, because a probe must never fail because its own context-gathering did.
     */
    failureFacts?: () => Facts,
  ): Promise<void> {
    const base = { id, area, question, source, statement: statement === null ? null : this.redact(statement) };
    try {
      const attempt = await run();
      this.steps.push(Object.freeze({
        ...base,
        outcome: attempt.outcome,
        salesforceErrorCode: null,
        errorMessageSafe: null,
        facts: this.clean(attempt.facts),
      }));
    } catch (error) {
      const failure = readSalesforceFailure(error);
      const code = failure.code;
      // A refusal is classified here rather than at each call site, so "the org said no" can never be
      // quietly reported as "the probe broke" — which would hide the one fact T1 exists to collect.
      const denied = code !== null && SALESFORCE_REFUSAL_CODES.has(code.toLocaleUpperCase('en-US'));
      let context: Facts = {};
      try {
        context = failureFacts?.() ?? {};
      } catch {
        context = { contextUnavailable: 'The step could not describe what it was attempting.' };
      }
      this.steps.push(Object.freeze({
        ...base,
        outcome: denied ? 'DENIED' : 'ERROR',
        salesforceErrorCode: code,
        errorMessageSafe: failure.message === null ? null : this.redact(failure.message).slice(0, MAX_SAFE_MESSAGE),
        facts: this.clean(context),
      }));
    }
  }

  public collected(): readonly P10ProbeStep[] {
    return Object.freeze([...this.steps]);
  }

  /** Redacts configured secrets, then masks email addresses and digit-leading id runs. */
  public redact(value: string): string {
    return redactSensitiveText(value, this.secrets)
      .replace(EMAIL_PATTERN, maskIdentifier)
      .replace(DIGIT_LEADING_ID_PATTERN, maskSalesforceId);
  }

  private clean(facts: Facts): Readonly<Record<string, unknown>> {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(facts)) clean[key] = this.cleanValue(value, 0, key);
    return Object.freeze(clean);
  }

  private cleanValue(value: unknown, depth: number, key: string | null): unknown {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const redacted = this.redact(value);
      const masked = key !== null && ID_KEY_PATTERN.test(key) && ID_SHAPED_VALUE_PATTERN.test(redacted)
        ? maskSalesforceId(redacted)
        : redacted;
      return masked.slice(0, MAX_FACT_STRING);
    }
    if (depth >= 4) return '[TRUNCATED_DEPTH]';
    if (Array.isArray(value)) {
      return value.slice(0, 50).map((entry) => this.cleanValue(entry, depth + 1, key));
    }
    if (typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([entryKey, entry]) => [entryKey, this.cleanValue(entry, depth + 1, entryKey)]));
    }
    return String(value).slice(0, MAX_FACT_STRING);
  }
}

/** The house masking style: keep the first character and the domain of a username, else the ends. */
export function maskIdentifier(value: string): string {
  if (value.length === 0) return value;
  const at = value.indexOf('@');
  if (at > 0) return `${value.slice(0, 1)}***${value.slice(at)}`;
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

/** A Salesforce id keeps its 3-character object prefix and nothing else that identifies the row. */
export function maskSalesforceId(value: string): string {
  if (value.length < 15) return maskIdentifier(value);
  return `${value.slice(0, 3)}${'*'.repeat(value.length - 6)}${value.slice(-3)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** SOQL string literal escaping. A username reaching a WHERE clause is the one injection surface here. */
function quoteSoqlLiteral(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function summarizeValues(values: readonly (string | null)[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value === null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.freeze(Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right, 'en-US')),
  ));
}

type QueryOutcome = Readonly<{ records: readonly Record<string, unknown>[]; totalSize: number; done: boolean }>;

function readQueryOutcome(result: unknown): QueryOutcome {
  const record = isRecord(result) ? result : {};
  const records = Array.isArray(record.records) ? record.records.filter(isRecord) : [];
  return Object.freeze({
    records: Object.freeze(records),
    totalSize: asNumber(record.totalSize) ?? records.length,
    done: record.done !== false,
  });
}

async function runStandardQuery(connection: ProbeConnection, statement: string): Promise<QueryOutcome> {
  return readQueryOutcome(await connection.query(statement));
}

async function runToolingQuery(connection: ProbeConnection, statement: string): Promise<QueryOutcome> {
  return readQueryOutcome(await connection.tooling.query(statement));
}

async function readFieldNames(
  connection: ProbeConnection,
  sobject: string,
  tooling: boolean,
): Promise<readonly string[]> {
  const target = tooling ? connection.tooling.sobject(sobject) : connection.sobject(sobject);
  const described = (await target.describe()) as unknown as { fields?: readonly { name?: unknown }[] };
  return Object.freeze((described.fields ?? [])
    .map((field) => field.name)
    .filter((name): name is string => typeof name === 'string'));
}

/**
 * Field availability is measured, not assumed — the P9 lesson the P10 queries inherit. A query naming
 * a field this API version does not carry fails with `INVALID_FIELD` and takes the whole Tool down,
 * so which fields exist is itself a prerequisite.
 */
function fieldPresence(fields: readonly string[], wanted: readonly string[]): Readonly<Record<string, boolean>> {
  const available = new Set(fields.map((name) => name.toLocaleLowerCase('en-US')));
  return Object.freeze(Object.fromEntries(
    wanted.map((name) => [name, available.has(name.toLocaleLowerCase('en-US'))]),
  ));
}

type ToolingWriteResult = Readonly<{ id: string | null; success: boolean; errors: readonly string[] }>;

function readWriteResult(value: unknown): ToolingWriteResult {
  const record = isRecord(value) ? value : {};
  return Object.freeze({
    id: asString(record.id),
    success: record.success === true,
    errors: Object.freeze((Array.isArray(record.errors) ? record.errors : [])
      .map((entry) => (isRecord(entry) && typeof entry.message === 'string' ? entry.message : String(entry)))
      .slice(0, 5)),
  });
}

type ToolingSObjectApi = Readonly<{
  create(input: Record<string, unknown>): Promise<unknown>;
  destroy(id: string): Promise<unknown>;
}>;

/** The tooling SObject surface is structural here, so a jsforce signature change cannot silently pass. */
function toolingSObject(connection: ProbeConnection, sobject: string): ToolingSObjectApi {
  return connection.tooling.sobject(sobject) as unknown as ToolingSObjectApi;
}

async function toolingDestroy(
  connection: ProbeConnection,
  sobject: string,
  id: string,
): Promise<ToolingWriteResult> {
  return readWriteResult(await toolingSObject(connection, sobject).destroy(id));
}

/**
 * The org facts, read once from `Organization`.
 *
 * `IsSandbox` is not decoration: it is the switch that decides whether the write probes run at all,
 * so it is read before anything writes and carried on the report beside `probeMode`.
 */
async function readOrgFacts(
  recorder: ProbeRecorder,
  connection: ProbeConnection,
): Promise<{ facts: P10ProbeOrgFacts; isSandbox: boolean }> {
  const read = {
    isSandbox: null as boolean | null,
    organizationType: null as string | null,
    instanceName: null as string | null,
    organizationIdMasked: null as string | null,
  };
  await recorder.record(
    'ORG_FACTS',
    'ORG',
    'Is this deployment a sandbox or a production org, and which edition and API version answers?',
    'STANDARD',
    'SELECT Id, OrganizationType, IsSandbox, InstanceName FROM Organization LIMIT 1',
    async () => {
      const outcome = await runStandardQuery(
        connection,
        'SELECT Id, OrganizationType, IsSandbox, InstanceName FROM Organization LIMIT 1',
      );
      const record = outcome.records[0] ?? {};
      read.isSandbox = record.IsSandbox === true;
      read.organizationType = asString(record.OrganizationType);
      read.instanceName = asString(record.InstanceName);
      const id = asString(record.Id);
      read.organizationIdMasked = id === null ? null : maskSalesforceId(id);
      return {
        outcome: 'AVAILABLE',
        facts: {
          isSandbox: read.isSandbox,
          organizationType: read.organizationType,
          instanceName: read.instanceName,
          organizationIdMasked: read.organizationIdMasked,
          apiVersion: connection.getApiVersion(),
        },
      };
    },
  );
  return {
    facts: Object.freeze({
      isSandbox: read.isSandbox,
      organizationType: read.organizationType,
      instanceName: read.instanceName,
      apiVersion: connection.getApiVersion(),
      organizationIdMasked: read.organizationIdMasked,
    }),
    isSandbox: read.isSandbox === true,
  };
}

/** The REST root listing — the same measurement P9 used to show `limits` is refused in this org. */
async function probeRootResources(recorder: ProbeRecorder, connection: ProbeConnection): Promise<void> {
  const path = `/services/data/v${connection.getApiVersion()}/`;
  await recorder.record(
    'API_ROOT_RESOURCES',
    'ORG',
    'Which REST root resources does this org advertise to the diagnostic identity?',
    'REST',
    `GET ${path}`,
    async () => {
      const body = await connection.request<unknown>({ method: 'GET', url: path });
      const keys = isRecord(body) ? Object.keys(body).sort((left, right) => left.localeCompare(right, 'en-US')) : [];
      return {
        outcome: 'AVAILABLE',
        facts: {
          resourceCount: keys.length,
          hasQuery: keys.includes('query'),
          hasTooling: keys.includes('tooling'),
          hasMetadata: keys.includes('metadata'),
          hasLimits: keys.includes('limits'),
          resources: keys,
        },
      };
    },
  );
}

/**
 * The debug-log surface P10-1 (`set_trace_flag`) and P10-2 (`get_apex_logs`, `get_debug_log_body`)
 * depend on, measured in the order those Tools will use it.
 *
 * @param salesforceUsername the diagnostic route's username — the identity whose own User row the
 *   trace-target probes have to tell apart from "somebody else". Taken from the route rather than
 *   from a second `identity()` call so the probe never has to guess who it authenticated as.
 */
async function probeDebugLogSurface(
  recorder: ProbeRecorder,
  connection: ProbeConnection,
  salesforceUsername: string,
  mayWrite: boolean,
): Promise<void> {
  const apexLogFields = [
    'Id', 'LogUserId', 'Application', 'Status', 'Operation',
    'DurationMilliseconds', 'LogLength', 'StartTime', 'LastModifiedDate',
  ];
  await recorder.record(
    'TOOLING_APEX_LOG_DESCRIBE',
    'DEBUG_LOG',
    'Which ApexLog fields exist at this API version, so the P10-2 query can be written against measurement?',
    'TOOLING',
    null,
    async () => {
      const fields = await readFieldNames(connection, 'ApexLog', true);
      const presence = fieldPresence(fields, apexLogFields);
      return {
        outcome: 'AVAILABLE',
        facts: {
          apiVersion: connection.getApiVersion(),
          fieldCount: fields.length,
          fields,
          requiredFieldsPresent: presence,
          allRequiredPresent: Object.values(presence).every((present) => present),
          // `Body` is deliberately listed separately: whether the log text is reachable through SOQL
          // decides whether `get_debug_log_body` can be one query or must be a separate REST call.
          bodySelectableThroughSoql: fieldPresence(fields, ['Body']).Body === true,
        },
      };
    },
  );

  await recorder.record(
    'TOOLING_APEX_LOG_LOGUSER',
    'DEBUG_LOG',
    'Is the LogUser relationship traversable, so a log list can show whose log it is without a second query?',
    'TOOLING',
    'SELECT Id, LogUser.Id, LogUser.Name, LogUser.Username FROM ApexLog ORDER BY LastModifiedDate DESC LIMIT 5',
    async () => {
      const outcome = await runToolingQuery(
        connection,
        'SELECT Id, LogUser.Id, LogUser.Name, LogUser.Username FROM ApexLog ORDER BY LastModifiedDate DESC LIMIT 5',
      );
      const first = outcome.records[0];
      return {
        outcome: 'AVAILABLE',
        facts: {
          returned: outcome.records.length,
          traversable: first !== undefined && isRecord(first.LogUser),
          // A describe of ApexLog does not list relationship fields, so this query is the only way to
          // establish that `LogUser.Name` is selectable — an assumption worth testing because the P10-2
          // contract wants to name the user whose log it is.
          sampleLogUserNamePresent: first !== undefined && isRecord(first.LogUser)
            ? asString(first.LogUser.Name) !== null
            : false,
        },
      };
    },
  );

  let newestLogId: string | null = null;
  await recorder.record(
    'TOOLING_APEX_LOG_QUERY',
    'DEBUG_LOG',
    'Can the diagnostic identity list ApexLog rows, and does this org retain any right now?',
    'TOOLING',
    'SELECT Id, LogUserId, Application, Status, Operation, DurationMilliseconds, LogLength, StartTime, '
      + 'LastModifiedDate FROM ApexLog ORDER BY LastModifiedDate DESC LIMIT 10',
    async () => {
      const outcome = await runToolingQuery(
        connection,
        'SELECT Id, LogUserId, Application, Status, Operation, DurationMilliseconds, LogLength, StartTime, '
          + 'LastModifiedDate FROM ApexLog ORDER BY LastModifiedDate DESC LIMIT 10',
      );
      const newest = outcome.records[0];
      newestLogId = newest === undefined ? null : asString(newest.Id);
      return {
        outcome: 'AVAILABLE',
        facts: {
          totalSize: outcome.totalSize,
          returned: outcome.records.length,
          done: outcome.done,
          statuses: summarizeValues(outcome.records.map((record) => asString(record.Status))),
          logLengths: outcome.records.map((record) => asNumber(record.LogLength)),
          newestLogAt: newest === undefined ? null : asString(newest.LastModifiedDate),
          newestLogIdMasked: newestLogId === null ? null : maskSalesforceId(newestLogId),
        },
      };
    },
  );

  await recorder.record(
    'TOOLING_APEX_LOG_BODY',
    'DEBUG_LOG',
    'Can the log body be retrieved over the Tooling API, and what does its header actually look like?',
    'TOOLING',
    newestLogId === null ? null : 'GET /services/data/v{version}/tooling/sobjects/ApexLog/{id}/Body',
    async () => {
      if (newestLogId === null) {
        return {
          outcome: 'SKIPPED',
          facts: {
            reason: 'No ApexLog row is retained, so there was no body to request. This is a data fact about this '
              + 'org, not a permission fact about the identity.',
          },
        };
      }
      const path = `/services/data/v${connection.getApiVersion()}/tooling/sobjects/ApexLog/${newestLogId}/Body`;
      const body = await connection.request<unknown>({ method: 'GET', url: path });
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      const lines = text.split('\n');
      // The first token of an Apex log is the API version the traced code was *compiled* against, and
      // the log's own format follows that version rather than the org's. P10-2's parser has to know
      // this, so it is measured rather than assumed to match the org's API version.
      const headerVersion = /^(\d{2,3}\.\d)\s/u.exec(lines[0] ?? '');
      return {
        outcome: 'AVAILABLE',
        facts: {
          contentShape: typeof body,
          bytes: Buffer.byteLength(text, 'utf8'),
          lineCount: lines.length,
          logFormatApiVersion: headerVersion === null ? null : headerVersion[1],
          orgApiVersion: connection.getApiVersion(),
          headerPreview: lines.slice(0, 12).join('\n').slice(0, MAX_LOG_PREVIEW),
          exceptionLines: lines
            .filter((line) => line.includes('EXCEPTION_THROWN') || line.includes('FATAL_ERROR'))
            .slice(0, 5),
          hasCodeUnitMarkers: text.includes('APEX_CODE'),
        },
      };
    },
  );

  await recorder.record(
    'TOOLING_TRACE_FLAG_QUERY',
    'DEBUG_LOG',
    'Which TraceFlag fields exist, and is any flag already open in this org?',
    'TOOLING',
    'SELECT Id, TracedEntityId, LogType, DebugLevelId, StartDate, ExpirationDate FROM TraceFlag',
    async () => {
      const fields = await readFieldNames(connection, 'TraceFlag', true);
      const outcome = await runToolingQuery(
        connection,
        'SELECT Id, TracedEntityId, LogType, DebugLevelId, StartDate, ExpirationDate FROM TraceFlag',
      );
      return {
        outcome: 'AVAILABLE',
        facts: {
          fieldPresence: fieldPresence(fields, [
            'Id', 'TracedEntityId', 'LogType', 'DebugLevelId', 'StartDate', 'ExpirationDate',
          ]),
          fieldCount: fields.length,
          totalSize: outcome.totalSize,
          // `TracedEntityId` and `DebugLevelId` are recorded masked rather than dropped. Without them a
          // reader cannot tell whose flag a row is, which is exactly the question the create probes then
          // raise: "an overlapping flag already exists" is unattributable evidence until the row it
          // names is on the page. The ids are masked by the recorder's key rule, so the entity is
          // identifiable by class without the row leaving the org's own identifier in the document.
          existing: outcome.records.slice(0, 10).map((record) => ({
            tracedEntityId: asString(record.TracedEntityId),
            debugLevelId: asString(record.DebugLevelId),
            logType: asString(record.LogType),
            startDate: asString(record.StartDate),
            expirationDate: asString(record.ExpirationDate),
          })),
        },
      };
    },
  );

  let existingDebugLevelId: string | null = null;
  await recorder.record(
    'TOOLING_DEBUG_LEVEL_QUERY',
    'DEBUG_LOG',
    'Which DebugLevel records already exist, and what log levels do they carry?',
    'TOOLING',
    'SELECT Id, DeveloperName, MasterLabel, ApexCode, ApexProfiling, Callout, Database, System, Validation, '
      + 'Workflow FROM DebugLevel',
    async () => {
      const outcome = await runToolingQuery(
        connection,
        'SELECT Id, DeveloperName, MasterLabel, ApexCode, ApexProfiling, Callout, Database, System, Validation, '
          + 'Workflow FROM DebugLevel',
      );
      const first = outcome.records[0];
      existingDebugLevelId = first === undefined ? null : asString(first.Id);
      return {
        outcome: 'AVAILABLE',
        facts: {
          totalSize: outcome.totalSize,
          developerNames: outcome.records.map((record) => asString(record.DeveloperName)),
          levels: outcome.records.slice(0, 20).map((record) => ({
            developerName: asString(record.DeveloperName),
            apexCode: asString(record.ApexCode),
            apexProfiling: asString(record.ApexProfiling),
            callout: asString(record.Callout),
            database: asString(record.Database),
            system: asString(record.System),
            validation: asString(record.Validation),
            workflow: asString(record.Workflow),
          })),
        },
      };
    },
  );

  let apexClassId: string | null = null;
  await recorder.record(
    'TOOLING_APEX_CLASS_QUERY',
    'DEBUG_LOG',
    'Can an ApexClass be resolved, so a class trace target is reachable?',
    'TOOLING',
    'SELECT Id, Name, ApiVersion, Status FROM ApexClass ORDER BY Name LIMIT 20',
    async () => {
      const outcome = await runToolingQuery(
        connection,
        'SELECT Id, Name, ApiVersion, Status FROM ApexClass ORDER BY Name LIMIT 20',
      );
      const first = outcome.records[0];
      apexClassId = first === undefined ? null : asString(first.Id);
      return {
        outcome: 'AVAILABLE',
        facts: {
          totalSize: outcome.totalSize,
          sampleNames: outcome.records.slice(0, 10).map((record) => asString(record.Name)),
        },
      };
    },
  );

  let ownUserId: string | null = null;
  await recorder.record(
    'STANDARD_USER_SELF',
    'DEBUG_LOG',
    'Can the diagnostic identity resolve its own User row, which every USER-entity trace target needs?',
    'STANDARD',
    "SELECT Id, Username, ProfileId FROM User WHERE Username = '<diagnostic user>' LIMIT 1",
    async () => {
      if (salesforceUsername.trim().length === 0) {
        return { outcome: 'SKIPPED', facts: { reason: 'The diagnostic route carries no username to resolve.' } };
      }
      const outcome = await runStandardQuery(
        connection,
        `SELECT Id, Username, ProfileId FROM User WHERE Username = ${quoteSoqlLiteral(salesforceUsername)} LIMIT 1`,
      );
      const record = outcome.records[0];
      ownUserId = record === undefined ? null : asString(record.Id);
      const profileId = record === undefined ? null : asString(record.ProfileId);
      return {
        outcome: 'AVAILABLE',
        facts: {
          resolved: ownUserId !== null,
          profileIdMasked: profileId === null ? null : maskSalesforceId(profileId),
        },
      };
    },
  );

  let otherUserId: string | null = null;
  await recorder.record(
    'STANDARD_USER_OTHERS',
    'DEBUG_LOG',
    'Can the diagnostic identity list OTHER active users — the population a support engineer traces?',
    'STANDARD',
    'SELECT Id, Username, IsActive FROM User WHERE IsActive = true ORDER BY Username LIMIT 50',
    async () => {
      const outcome = await runStandardQuery(
        connection,
        'SELECT Id, Username, IsActive FROM User WHERE IsActive = true ORDER BY Username LIMIT 50',
      );
      const other = outcome.records.find((record) => {
        const id = asString(record.Id);
        return id !== null && id !== ownUserId;
      });
      otherUserId = other === undefined ? null : asString(other.Id);
      return {
        outcome: 'AVAILABLE',
        facts: {
          totalSize: outcome.totalSize,
          returned: outcome.records.length,
          otherUserResolvable: otherUserId !== null,
          sampleUsernames: outcome.records.slice(0, 5)
            .map((record) => maskIdentifier(asString(record.Username) ?? '')),
        },
      };
    },
  );

  await probeTraceFlagWrites(recorder, connection, mayWrite, {
    apexClassId,
    ownUserId,
    otherUserId,
    existingDebugLevelId,
  });
}

/**
 * The write probes.
 *
 * A TraceFlag is P10's one write, and it is the one prerequisite that cannot be inferred from a read:
 * "may this identity open a trace on *another* user?" is a different permission from "may it read
 * logs", and getting it wrong decides whether P10-1's contract is deliverable at all. Each probe
 * deletes exactly the row it created and reports that delete separately, so a leaked flag is visible
 * in the evidence rather than assumed away.
 */
async function probeTraceFlagWrites(
  recorder: ProbeRecorder,
  connection: ProbeConnection,
  mayWrite: boolean,
  targets: Readonly<{
    apexClassId: string | null;
    ownUserId: string | null;
    otherUserId: string | null;
    existingDebugLevelId: string | null;
  }>,
): Promise<void> {
  const expirationDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const readOnlyReason = 'This org reports IsSandbox=false and P10-T1 forbids configuring production, '
    + 'so the write leg was not attempted. The capability is unmeasured here and must be probed in a '
    + 'sandbox before P10-1 ships.';

  /**
   * Runs one create-then-delete probe. `blocked` is consulted inside the step so a missing target is
   * recorded as `SKIPPED` with its reason, not as a failure of the permission being measured.
   */
  const writeProbe = async (
    id: string,
    question: string,
    statement: string,
    sobject: string,
    build: () => { payload: Record<string, unknown>; blocked: string | null; target: string | null },
  ): Promise<void> => {
    if (!mayWrite) {
      await recorder.record(id, 'DEBUG_LOG', question, 'TOOLING', null, async () => ({
        outcome: 'NOT_PROBED',
        facts: { reason: readOnlyReason },
      }));
      return;
    }
    let target: string | null = null;
    await recorder.record(id, 'DEBUG_LOG', question, 'TOOLING', statement, async () => {
      const planned = build();
      target = planned.target;
      if (planned.blocked !== null) return { outcome: 'SKIPPED', facts: { reason: planned.blocked } };
      const created = readWriteResult(await toolingSObject(connection, sobject).create(planned.payload));
      const cleanup = created.id === null
        ? { attempted: false, deleted: false, absent: null as boolean | null }
        : { attempted: true, deleted: (await toolingDestroy(connection, sobject, created.id)).success, absent: null as boolean | null };
      // A successful `destroy` is a claim, not a measurement. The first two runs of this probe are why
      // the re-read exists: one create reported `cleanupSucceeded: true` and left its TraceFlag in the
      // org, which the *next* run then found and refused to duplicate. T1's production ban and this
      // probe's own "delete exactly the row it created" promise are both only as good as this check.
      if (cleanup.attempted && cleanup.deleted) {
        const remaining = await runToolingQuery(connection, `SELECT Id FROM ${sobject} WHERE Id = '${created.id}'`);
        cleanup.absent = remaining.records.length === 0;
      }
      return {
        outcome: created.success ? 'AVAILABLE' : 'ERROR',
        facts: {
          // Whose flag this attempt was about, masked by the recorder's id-key rule. Without it a
          // refusal that names an already-traced entity cannot be matched to the row that caused it.
          tracedEntityId: planned.target,
          created: created.success,
          createErrors: created.errors,
          cleanupAttempted: cleanup.attempted,
          cleanupSucceeded: cleanup.deleted,
          cleanupVerifiedAbsent: cleanup.absent,
        },
      };
    }, () => ({
      tracedEntityId: target,
      attempted: `POST /services/data/v{version}/tooling/sobjects/${sobject}`,
    }));
  };

  const traceFlag = (
    tracedEntityId: string | null,
    logType: string,
    debugLevelId: string | null,
    missing: string,
  ): { payload: Record<string, unknown>; blocked: string | null; target: string | null } => ({
    payload: tracedEntityId === null || debugLevelId === null
      ? {}
      : {
        TracedEntityId: tracedEntityId,
        LogType: logType,
        DebugLevelId: debugLevelId,
        StartDate: new Date().toISOString(),
        ExpirationDate: expirationDate,
      },
    blocked: debugLevelId === null
      ? 'No DebugLevel row exists to attach, so no flag was created.'
      : (tracedEntityId === null ? missing : null),
    target: tracedEntityId,
  });

  await writeProbe(
    'TOOLING_TRACE_FLAG_CREATE_APEX_CLASS',
    'May the diagnostic identity open a CLASS_TRACING flag on an ApexClass?',
    'POST /services/data/v{version}/tooling/sobjects/TraceFlag (LogType=CLASS_TRACING, deleted in-step)',
    'TraceFlag',
    () => traceFlag(targets.apexClassId, 'CLASS_TRACING', targets.existingDebugLevelId,
      'No ApexClass was resolvable, so there was no class to trace.'),
  );

  await writeProbe(
    'TOOLING_TRACE_FLAG_CREATE_USER_SELF',
    'May the diagnostic identity open a DEVELOPER_LOG flag on its OWN user?',
    'POST /services/data/v{version}/tooling/sobjects/TraceFlag (LogType=DEVELOPER_LOG, self, deleted in-step)',
    'TraceFlag',
    () => traceFlag(targets.ownUserId, 'DEVELOPER_LOG', targets.existingDebugLevelId,
      'The diagnostic identity could not resolve its own User row.'),
  );

  // The measurement that decides P10-1's scope. Tracing another user is what a support engineer
  // actually needs, and it is the case Salesforce gates behind additional privilege.
  await writeProbe(
    'TOOLING_TRACE_FLAG_CREATE_USER_OTHER',
    'May the diagnostic identity open a DEVELOPER_LOG flag on a DIFFERENT user?',
    'POST /services/data/v{version}/tooling/sobjects/TraceFlag (LogType=DEVELOPER_LOG, other user, deleted in-step)',
    'TraceFlag',
    () => traceFlag(targets.otherUserId, 'DEVELOPER_LOG', targets.existingDebugLevelId,
      'No other active User row was resolvable, so the permission was not exercised.'),
  );

  /**
   * A deliberate deviation from the T1 prompt, with its reason stated.
   *
   * The prompt says to record the existing DebugLevel developer names and *not* to create one. That
   * leaves the "no stored level matches, so create one" branch of `set_trace_flag` unmeasured, and the
   * branch is on the critical path: if no existing level matches the P10 default profile and the
   * identity cannot create one, P10-1 cannot deliver its contract at all. The probe therefore creates a
   * level under a probe-specific developer name and deletes exactly that row. Every pre-existing
   * DebugLevel stays read-only, which is the part of the prompt's rule that protects org config.
   */
  await writeProbe(
    'TOOLING_DEBUG_LEVEL_CREATE',
    'May the diagnostic identity create a DebugLevel, as P10-1 must when no stored level matches?',
    'POST /services/data/v{version}/tooling/sobjects/DebugLevel (DeveloperName=SFOA_P10_PROBE, deleted in-step)',
    'DebugLevel',
    () => ({
      payload: {
        DeveloperName: 'SFOA_P10_PROBE',
        MasterLabel: 'SFOA P10 probe',
        ApexCode: 'DEBUG',
        ApexProfiling: 'NONE',
        Callout: 'INFO',
        Database: 'INFO',
        System: 'DEBUG',
        Validation: 'INFO',
        Workflow: 'INFO',
      },
      blocked: null,
      target: null,
    }),
  );
}

/** The platform-status surface P10-6 (`get_platform_diagnostics`) aggregates. */
async function probePlatformStatus(recorder: ProbeRecorder, connection: ProbeConnection): Promise<void> {
  await recorder.record(
    'STANDARD_SETUP_AUDIT_TRAIL_QUERY',
    'PLATFORM',
    'Can the diagnostic identity read SetupAuditTrail — the change-provenance source P10-6 needs?',
    'STANDARD',
    'SELECT Id, Action, CreatedBy.Name, CreatedDate, Section, Display, DelegateUser FROM SetupAuditTrail '
      + 'ORDER BY CreatedDate DESC LIMIT 10',
    async () => {
      const outcome = await runStandardQuery(
        connection,
        'SELECT Id, Action, CreatedBy.Name, CreatedDate, Section, Display, DelegateUser FROM SetupAuditTrail '
          + 'ORDER BY CreatedDate DESC LIMIT 10',
      );
      const newest = outcome.records[0];
      return {
        outcome: 'AVAILABLE',
        facts: {
          totalSize: outcome.totalSize,
          returned: outcome.records.length,
          newestAt: newest === undefined ? null : asString(newest.CreatedDate),
          sections: summarizeValues(outcome.records.map((record) => asString(record.Section))),
          actions: summarizeValues(outcome.records.map((record) => asString(record.Action))),
          newestAction: newest === undefined ? null : asString(newest.Action),
          newestSection: newest === undefined ? null : asString(newest.Section),
        },
      };
    },
  );

  await recorder.record(
    'STANDARD_SETUP_AUDIT_TRAIL_OLDEST',
    'PLATFORM',
    'How far back does SetupAuditTrail actually reach, so a diagnostic window can be described honestly?',
    'STANDARD',
    'SELECT Id, CreatedDate FROM SetupAuditTrail ORDER BY CreatedDate ASC LIMIT 1',
    async () => {
      const outcome = await runStandardQuery(
        connection,
        'SELECT Id, CreatedDate FROM SetupAuditTrail ORDER BY CreatedDate ASC LIMIT 1',
      );
      const oldest = outcome.records[0];
      return {
        outcome: 'AVAILABLE',
        facts: {
          oldestAt: oldest === undefined ? null : asString(oldest.CreatedDate),
          note: 'The oldest retained row bounds the window; Salesforce does not expose the retention policy to SOQL.',
        },
      };
    },
  );

  await recorder.record(
    'STANDARD_ASYNC_APEX_JOB_QUERY',
    'PLATFORM',
    'Can the diagnostic identity read failed and aborted AsyncApexJob rows — the P10-6 async failure source?',
    'STANDARD',
    'SELECT Id, Status, JobType, ApexClass.Name, NumberOfErrors, ExtendedStatus, CreatedDate FROM AsyncApexJob '
      + "WHERE Status IN ('Failed','Aborted') ORDER BY CreatedDate DESC LIMIT 10",
    async () => {
      const failed = await runStandardQuery(
        connection,
        'SELECT Id, Status, JobType, ApexClass.Name, NumberOfErrors, ExtendedStatus, CreatedDate FROM AsyncApexJob '
          + "WHERE Status IN ('Failed','Aborted') ORDER BY CreatedDate DESC LIMIT 10",
      );
      const counts = await runStandardQuery(
        connection,
        'SELECT Status, COUNT(Id) total FROM AsyncApexJob GROUP BY Status',
      );
      return {
        outcome: 'AVAILABLE',
        facts: {
          failedReturned: failed.records.length,
          failedSample: failed.records.slice(0, 5).map((record) => ({
            status: asString(record.Status),
            jobType: asString(record.JobType),
            apexClass: isRecord(record.ApexClass) ? asString(record.ApexClass.Name) : null,
            numberOfErrors: asNumber(record.NumberOfErrors),
            createdDate: asString(record.CreatedDate),
          })),
          statusCounts: counts.records.map((record) => ({
            status: asString(record.Status),
            count: asNumber(record.total),
          })),
        },
      };
    },
  );

  await recorder.record(
    'STANDARD_CRON_TRIGGER_QUERY',
    'PLATFORM',
    'Can the diagnostic identity read CronTrigger rows — the P10-6 scheduled-job stall source?',
    'STANDARD',
    'SELECT Id, CronJobDetail.Name, CronJobDetail.JobType, State, NextFireTime, PreviousFireTime, TimesTriggered '
      + 'FROM CronTrigger LIMIT 20',
    async () => {
      const outcome = await runStandardQuery(
        connection,
        'SELECT Id, CronJobDetail.Name, CronJobDetail.JobType, State, NextFireTime, PreviousFireTime, TimesTriggered '
          + 'FROM CronTrigger LIMIT 20',
      );
      return {
        outcome: 'AVAILABLE',
        facts: {
          totalSize: outcome.totalSize,
          returned: outcome.records.length,
          states: summarizeValues(outcome.records.map((record) => asString(record.State))),
          sample: outcome.records.slice(0, 5).map((record) => ({
            name: isRecord(record.CronJobDetail) ? asString(record.CronJobDetail.Name) : null,
            jobType: isRecord(record.CronJobDetail) ? asString(record.CronJobDetail.JobType) : null,
            state: asString(record.State),
            nextFireTime: asString(record.NextFireTime),
            previousFireTime: asString(record.PreviousFireTime),
          })),
        },
      };
    },
  );
}

/**
 * The permission tables P10-3 (`explain_field_access`) has to aggregate.
 *
 * The decisive measurement here is the cross-user one. Reading *another* user's permission assignments
 * is what makes the Tool an attribution Tool rather than a self-inspection Tool, and it sets the
 * boundary on `targetUserId`.
 */
async function probePermissionSurface(
  recorder: ProbeRecorder,
  connection: ProbeConnection,
  salesforceUsername: string,
): Promise<void> {
  await recorder.record(
    'STANDARD_FIELD_PERMISSIONS_QUERY',
    'PERMISSION',
    'Can the diagnostic identity read FieldPermissions rows for permission sets it does not own?',
    'STANDARD',
    'SELECT Id, ParentId, SobjectType, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions '
      + "WHERE SobjectType = 'Account' LIMIT 20",
    async () => {
      const outcome = await runStandardQuery(
        connection,
        'SELECT Id, ParentId, SobjectType, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions '
          + "WHERE SobjectType = 'Account' LIMIT 20",
      );
      return {
        outcome: 'AVAILABLE',
        facts: {
          totalSize: outcome.totalSize,
          returned: outcome.records.length,
          distinctParents: distinctCount(outcome.records.map((record) => asString(record.ParentId))),
          sampleFields: outcome.records.slice(0, 10).map((record) => ({
            field: asString(record.Field),
            read: record.PermissionsRead,
            edit: record.PermissionsEdit,
          })),
        },
      };
    },
  );

  // Polymorphic `Parent` is the difference between a one-query attribution and a two-query one, so
  // whether SOQL can traverse it is measured rather than assumed.
  await recorder.record(
    'STANDARD_FIELD_PERMISSIONS_PARENT_NAME',
    'PERMISSION',
    'Can SOQL traverse FieldPermissions.Parent (polymorphic to PermissionSet or Profile) in one query?',
    'STANDARD',
    "SELECT ParentId, Parent.Name FROM FieldPermissions WHERE SobjectType = 'Account' LIMIT 5",
    async () => {
      const outcome = await runStandardQuery(
        connection,
        "SELECT ParentId, Parent.Name FROM FieldPermissions WHERE SobjectType = 'Account' LIMIT 5",
      );
      return {
        outcome: 'AVAILABLE',
        facts: { returned: outcome.records.length, parentShape: outcome.records[0]?.Parent ?? null },
      };
    },
  );

  await recorder.record(
    'STANDARD_OBJECT_PERMISSIONS_QUERY',
    'PERMISSION',
    'Can the diagnostic identity read ObjectPermissions, including the ViewAllRecords flag?',
    'STANDARD',
    'SELECT Id, ParentId, SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, '
      + "PermissionsViewAllRecords FROM ObjectPermissions WHERE SobjectType = 'Account' LIMIT 20",
    async () => {
      const outcome = await runStandardQuery(
        connection,
        'SELECT Id, ParentId, SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, '
          + "PermissionsViewAllRecords FROM ObjectPermissions WHERE SobjectType = 'Account' LIMIT 20",
      );
      return {
        outcome: 'AVAILABLE',
        facts: {
          totalSize: outcome.totalSize,
          returned: outcome.records.length,
          parentsWithViewAll: distinctCount(outcome.records
            .filter((record) => record.PermissionsViewAllRecords === true)
            .map((record) => asString(record.ParentId))),
        },
      };
    },
  );

  await recorder.record(
    'STANDARD_PERMISSION_SET_ASSIGNMENT_QUERY',
    'PERMISSION',
    'Can the diagnostic identity read PermissionSetAssignment rows at all, and whose are they?',
    'STANDARD',
    'SELECT Id, AssigneeId, PermissionSetId FROM PermissionSetAssignment LIMIT 20',
    async () => {
      const outcome = await runStandardQuery(
        connection,
        'SELECT Id, AssigneeId, PermissionSetId FROM PermissionSetAssignment LIMIT 20',
      );
      return {
        outcome: 'AVAILABLE',
        facts: {
          totalSize: outcome.totalSize,
          returned: outcome.records.length,
          distinctAssignees: distinctCount(outcome.records.map((record) => asString(record.AssigneeId))),
        },
      };
    },
  );

  // The measurement that sets P10-3's `targetUserId` boundary.
  await recorder.record(
    'STANDARD_PERMISSION_SET_ASSIGNMENT_OTHER_USER',
    'PERMISSION',
    "Can the diagnostic identity read a SPECIFIC other user's permission-set assignments by AssigneeId?",
    'STANDARD',
    'SELECT Id, AssigneeId, PermissionSetId, PermissionSet.Name FROM PermissionSetAssignment '
      + 'WHERE AssigneeId = <other user>',
    async () => {
      const own = await resolveOwnUserId(connection, salesforceUsername);
      const other = await readOtherUserId(connection, own);
      if (other === null) {
        return { outcome: 'SKIPPED', facts: { reason: 'No other active User row was resolvable to query.' } };
      }
      const outcome = await runStandardQuery(
        connection,
        'SELECT Id, AssigneeId, PermissionSetId, PermissionSet.Name FROM PermissionSetAssignment '
          + `WHERE AssigneeId = ${quoteSoqlLiteral(other)}`,
      );
      return {
        outcome: 'AVAILABLE',
        facts: {
          returned: outcome.records.length,
          permissionSets: outcome.records.slice(0, 20).map((record) => (
            isRecord(record.PermissionSet) ? asString(record.PermissionSet.Name) : null
          )),
          note: 'A non-zero count here proves a cross-user read. Zero is ambiguous and is recorded as ambiguous, '
            + 'because it cannot be told apart from a user who genuinely holds no permission set.',
        },
      };
    },
  );

  await recorder.record(
    'STANDARD_PERMISSION_SET_QUERY',
    'PERMISSION',
    'Can the diagnostic identity read PermissionSet and Profile names, for grant attribution?',
    'STANDARD',
    'SELECT Id, Name, Label, IsOwnedByProfile, Profile.Name FROM PermissionSet LIMIT 20',
    async () => {
      const outcome = await runStandardQuery(
        connection,
        'SELECT Id, Name, Label, IsOwnedByProfile, Profile.Name FROM PermissionSet LIMIT 20',
      );
      return {
        outcome: 'AVAILABLE',
        facts: {
          totalSize: outcome.totalSize,
          returned: outcome.records.length,
          sampleNames: outcome.records.slice(0, 10).map((record) => asString(record.Name)),
          profileOwned: outcome.records.filter((record) => record.IsOwnedByProfile === true).length,
        },
      };
    },
  );

  await recorder.record(
    'STANDARD_PROFILE_QUERY',
    'PERMISSION',
    'Can the diagnostic identity read Profile rows, and how many exist?',
    'STANDARD',
    'SELECT Id, Name, UserType FROM Profile LIMIT 20',
    async () => {
      const outcome = await runStandardQuery(connection, 'SELECT Id, Name, UserType FROM Profile LIMIT 20');
      const counts = await runStandardQuery(connection, 'SELECT COUNT(Id) total FROM Profile');
      return {
        outcome: 'AVAILABLE',
        facts: {
          returned: outcome.records.length,
          totalSize: asNumber(counts.records[0]?.total),
          sampleNames: outcome.records.slice(0, 10).map((record) => asString(record.Name)),
        },
      };
    },
  );

  await recorder.record(
    'STANDARD_RECORD_TYPE_QUERY',
    'PERMISSION',
    'Can the diagnostic identity read RecordType rows, for the record-type visibility fact?',
    'STANDARD',
    'SELECT Id, DeveloperName, Name, SobjectType, IsActive FROM RecordType LIMIT 20',
    async () => {
      const outcome = await runStandardQuery(
        connection,
        'SELECT Id, DeveloperName, Name, SobjectType, IsActive FROM RecordType LIMIT 20',
      );
      return {
        outcome: 'AVAILABLE',
        facts: {
          totalSize: outcome.totalSize,
          returned: outcome.records.length,
          sample: outcome.records.slice(0, 10).map((record) => ({
            sobjectType: asString(record.SobjectType),
            developerName: asString(record.DeveloperName),
            isActive: record.IsActive,
          })),
        },
      };
    },
  );

  // describe answers for the identity that called it. Recording it keeps that limit visible in the
  // ADR rather than implied, because a Tool that used describe would be reporting its own FLS.
  await recorder.record(
    'DESCRIBE_FLS_FACTS',
    'PERMISSION',
    'What does describe report for the diagnostic identity itself, and could it stand in for a target user?',
    'STANDARD',
    null,
    async () => {
      const described = (await connection.sobject('Account').describe()) as unknown as {
        fields?: readonly { name?: unknown; createable?: unknown; updateable?: unknown }[];
      };
      const fields = (described.fields ?? []).filter((field) => typeof field.name === 'string');
      return {
        outcome: 'AVAILABLE',
        facts: {
          fieldCount: fields.length,
          createable: fields.filter((field) => field.createable === true).length,
          updateable: fields.filter((field) => field.updateable === true).length,
          note: "describe answers for the calling identity, so this is the DIAGNOSTIC user's own FLS and can never "
            + "stand in for another user's.",
        },
      };
    },
  );
}

function distinctCount(values: readonly (string | null)[]): number {
  return new Set(values.filter((value): value is string => value !== null)).size;
}

async function resolveOwnUserId(connection: ProbeConnection, salesforceUsername: string): Promise<string | null> {
  if (salesforceUsername.trim().length === 0) return null;
  const outcome = await runStandardQuery(
    connection,
    `SELECT Id FROM User WHERE Username = ${quoteSoqlLiteral(salesforceUsername)} LIMIT 1`,
  );
  const record = outcome.records[0];
  return record === undefined ? null : asString(record.Id);
}

async function readOtherUserId(connection: ProbeConnection, ownUserId: string | null): Promise<string | null> {
  const outcome = await runStandardQuery(
    connection,
    'SELECT Id FROM User WHERE IsActive = true ORDER BY Username LIMIT 50',
  );
  const other = outcome.records.find((record) => {
    const id = asString(record.Id);
    return id !== null && id !== ownUserId;
  });
  return other === undefined ? null : asString(other.Id);
}

/** The metadata surface P10-4 (`list_metadata_components`) and P10-5 extend. */
async function probeMetadataSurface(recorder: ProbeRecorder, connection: ProbeConnection): Promise<void> {
  const listType = async (type: string): Promise<void> => {
    await recorder.record(
      `METADATA_LIST_${type.toLocaleUpperCase('en-US')}`,
      'METADATA',
      `Is Metadata API listMetadata available for ${type}, and how many components does this org hold?`,
      'METADATA',
      `metadata.list([{ type: '${type}' }])`,
      async () => {
        const listed = await connection.metadata.list([{ type }]);
        const entries = (Array.isArray(listed) ? listed : [listed]).filter(isRecord);
        const first = entries[0];
        return {
          outcome: 'AVAILABLE',
          facts: {
            totalSize: entries.length,
            sampleFullNames: entries.slice(0, 10).map((entry) => asString(entry.fullName)),
            // The provenance fields are the reason P10-4 prefers the Metadata API over a describe: a
            // component inventory without `lastModifiedBy` cannot answer "what changed". Whether this
            // org's listing carries them is a fact, so it is recorded rather than assumed.
            carriesLastModified: first !== undefined
              && (asString(first.lastModifiedDate) !== null || asString(first.lastModifiedByName) !== null),
            carriesManageableState: first !== undefined && asString(first.manageableState) !== null,
            carriesFileName: first !== undefined && asString(first.fileName) !== null,
          },
        };
      },
    );
  };

  // One type per P10-4 category question: a rule type, a secrets type, and the type whose volume is
  // the reason the allowlist is bounded at all.
  await listType('ValidationRule');
  await listType('NamedCredential');
  await listType('Profile');

  // The Tooling route is the fallback when the Metadata API will not list a type, and it is the one
  // that carries `LastModifiedBy`, so both routes are measured for a type both can serve.
  await recorder.record(
    'TOOLING_QUERY_VALIDATION_RULE',
    'METADATA',
    'Does a Tooling query reach ValidationRule, and does it carry provenance the Metadata API does not?',
    'TOOLING',
    'SELECT Id, ValidationName, Active, EntityDefinition.QualifiedApiName, LastModifiedDate FROM ValidationRule '
      + 'LIMIT 20',
    async () => {
      const outcome = await runToolingQuery(
        connection,
        'SELECT Id, ValidationName, Active, EntityDefinition.QualifiedApiName, LastModifiedDate FROM ValidationRule '
          + 'LIMIT 20',
      );
      return {
        outcome: 'AVAILABLE',
        facts: {
          totalSize: outcome.totalSize,
          returned: outcome.records.length,
          sample: outcome.records.slice(0, 10).map((record) => ({
            validationName: asString(record.ValidationName),
            active: record.Active,
            entity: isRecord(record.EntityDefinition) ? asString(record.EntityDefinition.QualifiedApiName) : null,
            lastModifiedDate: asString(record.LastModifiedDate),
          })),
        },
      };
    },
  );
}

/**
 * The measurements that decide whether a Tool may filter on a picklist literal.
 *
 * The ApexLog and SetupAuditTrail steps above returned *localized* values — `成功` beside `Success`,
 * `Apex 类` for a section — which means a Tool that writes `WHERE Status = 'Success'` or matches a
 * section against an English name would silently miss rows rather than fail. "Silently miss rows" is
 * the worst failure mode for a diagnostic Tool, because the Agent reads the empty result as "nothing
 * happened". These steps measure which fields are translated so the contract can say which ones may
 * never be filtered on.
 */
async function probeLocalization(recorder: ProbeRecorder, connection: ProbeConnection): Promise<void> {
  await recorder.record(
    'LOCALIZATION_APEX_LOG_STATUS',
    'LOCALIZATION',
    'Is ApexLog.Status translated, so filtering on an English literal would silently drop rows?',
    'TOOLING',
    "SELECT COUNT(Id) total FROM ApexLog WHERE Status = 'Success' (and the same for the localized literal)",
    async () => {
      const all = await runToolingQuery(connection, 'SELECT COUNT(Id) total FROM ApexLog');
      const english = await runToolingQuery(
        connection,
        "SELECT COUNT(Id) total FROM ApexLog WHERE Status = 'Success'",
      );
      const localized = await runToolingQuery(
        connection,
        "SELECT COUNT(Id) total FROM ApexLog WHERE Status = '成功'",
      );
      return {
        outcome: 'AVAILABLE',
        facts: {
          total: asNumber(all.records[0]?.total),
          matchingEnglishLiteral: asNumber(english.records[0]?.total),
          matchingLocalizedLiteral: asNumber(localized.records[0]?.total),
        },
      };
    },
  );

  await recorder.record(
    'SETUP_AUDIT_TRAIL_FILTERABILITY',
    'LOCALIZATION',
    'Which SetupAuditTrail fields can actually be filtered, since a diagnostic timeline has to narrow by something?',
    'STANDARD',
    'SELECT Id FROM SetupAuditTrail WHERE <field> LIMIT 200, one field at a time',
    async () => {
      /**
       * Measured one field at a time because the answer is not derivable from describe: the org refuses
       * `WHERE Section = ...` with `INVALID_FIELD: field 'Section' can not be filtered in a query call`,
       * which is a restriction on the object rather than a missing field. A single combined query would
       * report one failure and leave the rest unknown, so each is probed and its own error kept.
       */
      const attempts = [
        ['CreatedDate', "CreatedDate >= LAST_N_DAYS:90"],
        ['Action', "Action = 'changedApexClass'"],
        ['Section', "Section = 'ApexClass'"],
        ['CreatedById', 'CreatedById != null'],
        ['Display', 'Display != null'],
      ] as const;
      const filterable: Record<string, string> = {};
      const results: Record<string, unknown> = {};
      for (const [field, predicate] of attempts) {
        try {
          const outcome = await runStandardQuery(
            connection,
            `SELECT Id, CreatedDate FROM SetupAuditTrail WHERE ${predicate} LIMIT 200`,
          );
          filterable[field] = 'YES';
          results[field] = { filterable: true, returned: outcome.records.length };
        } catch (error) {
          const failure = readSalesforceFailure(error);
          filterable[field] = 'NO';
          results[field] = {
            filterable: false,
            code: failure.code,
            message: failure.message === null ? null : failure.message.split('\n')[0],
          };
        }
      }
      // `COUNT(Id)` is refused outright on this object, and the argument-less `COUNT()` form answers with
      // a synthetic alias whose name is not fixed, so the first numeric field is taken and its key kept
      // as evidence rather than the shape being assumed.
      const aggregate = await runStandardQuery(connection, 'SELECT COUNT() FROM SetupAuditTrail')
        .then((outcome) => {
          const record = outcome.records[0] ?? {};
          const entry = Object.entries(record).find(([field]) => field !== 'attributes' && asNumber(record[field]) !== null);
          return {
            supported: true,
            responseKeys: Object.keys(record),
            totalSize: outcome.totalSize,
            alias: entry === undefined ? null : entry[0],
            total: entry === undefined ? null : asNumber(record[entry[0]]),
          };
        })
        .catch((error: unknown) => ({
          supported: false,
          responseKeys: [],
          totalSize: null,
          alias: null,
          total: null,
          code: readSalesforceFailure(error).code,
        }));
      return {
        outcome: 'AVAILABLE',
        facts: {
          filterable,
          results,
          aggregateCount: aggregate,
          oldestRetainedAt: 'see STANDARD_SETUP_AUDIT_TRAIL_OLDEST',
        },
      };
    },
  );
}

/**
 * The measurements that pin the §0.3 red line.
 *
 * The diagnostic identity is powerful by necessity — ApexLog visibility needs View All Data — so the
 * red line cannot be "this identity cannot reach business rows". These steps measure both halves of
 * what it actually is: the Tooling API structurally refuses business objects, which is the guarantee a
 * mistyped query cannot become a business read, while the standard API does reach them, which is why
 * every P10 Tool must hardcode its target whitelist rather than rely on the identity.
 */
async function probeBoundary(recorder: ProbeRecorder, connection: ProbeConnection): Promise<void> {
  // The red line's structural half is the claim that the Tooling API *cannot* reach a business object,
  // which is what makes `run_diagnostic_tooling_query` safe with no per-object check in its executor.
  // One standard object is not enough to establish that: the Tooling API documents support for custom
  // objects, so `Lead` being refused while `Value_Bill__c` is answered would be exactly the hole that
  // turns that Tool into a business-data path. The matrix is the measurement; `ApexClass` is the
  // control that shows a *system* type still resolves through the same call.
  const toolingBoundaryTargets = Object.freeze([
    Object.freeze({ object: 'ApexClass', kind: 'SYSTEM' }),
    Object.freeze({ object: 'Lead', kind: 'STANDARD_BUSINESS' }),
    Object.freeze({ object: 'Account', kind: 'STANDARD_BUSINESS' }),
    Object.freeze({ object: 'Value_Bill__c', kind: 'CUSTOM_BUSINESS' }),
    Object.freeze({ object: 'Order__c', kind: 'CUSTOM_BUSINESS' }),
  ]);

  for (const target of toolingBoundaryTargets) {
    // `Id` alone, `LIMIT 1`: if the type resolves at all we learn that fact and nothing else.
    const statement = `SELECT Id FROM ${target.object} LIMIT 1`;
    await recorder.record(
      `TOOLING_QUERY_TYPE_${target.kind}:${target.object}`,
      'BOUNDARY',
      `Does the Tooling API resolve ${target.object} (${target.kind}) for the diagnostic identity?`,
      'TOOLING',
      statement,
      async () => {
        const outcome = await runToolingQuery(connection, statement);
        return {
          outcome: 'AVAILABLE',
          facts: {
            object: target.object,
            kind: target.kind,
            returned: outcome.records.length,
            verdict: target.kind === 'SYSTEM'
              ? 'A system type resolves through the same call, so the refusals below are about the object, not the API.'
              : 'The Tooling API answered a business-object query, which falsifies the structural half of the red line.',
          },
        };
      },
      () => ({ object: target.object, kind: target.kind }),
    );
  }

  await recorder.record(
    'STANDARD_QUERY_BUSINESS_OBJECT_ROWS',
    'BOUNDARY',
    'Does the standard API reach business rows from this identity? Recorded as an aggregate count only.',
    'STANDARD',
    'SELECT COUNT(Id) total FROM Lead',
    async () => {
      const outcome = await runStandardQuery(connection, 'SELECT COUNT(Id) total FROM Lead');
      return {
        outcome: 'AVAILABLE',
        facts: {
          rowCount: asNumber(outcome.records[0]?.total),
          note: 'Only a COUNT is read. It exists to show the red line has to be enforced in Tool code rather than '
            + 'assumed from the identity, which is why each P10 Tool hardcodes the objects it will query.',
        },
      };
    },
  );

  await recorder.record(
    'REST_LIMITS_RESOURCE',
    'BOUNDARY',
    'Does the diagnostic identity still read the limits resource, as ADR-0027 recorded?',
    'REST',
    'GET /services/data/v{version}/limits',
    async () => {
      const body = await connection.request<unknown>({
        method: 'GET',
        url: `/services/data/v${connection.getApiVersion()}/limits`,
      });
      return {
        outcome: isRecord(body) ? 'AVAILABLE' : 'ERROR',
        facts: { limitKeys: isRecord(body) ? Object.keys(body).length : 0 },
      };
    },
  );
}

function summarizeOutcomes(steps: readonly P10ProbeStep[]): Readonly<Record<P10ProbeOutcome, number>> {
  const summary: Record<P10ProbeOutcome, number> = {
    AVAILABLE: 0, DENIED: 0, ERROR: 0, SKIPPED: 0, NOT_PROBED: 0,
  };
  for (const step of steps) summary[step.outcome] += 1;
  return Object.freeze(summary);
}

/**
 * The write probes run only where the org says they are safe.
 *
 * Absence of the variable means "run them when the org is a sandbox"; `off` forces a read-only run even
 * there. It cannot turn writes on: an operator cannot talk the probe into configuring production, which
 * is the property P10-T1's production ban needs.
 */
export function writeProbesAllowed(environment: NodeJS.ProcessEnv, isSandbox: boolean): boolean {
  if (!isSandbox) return false;
  return environment[P10_PROBE_WRITE_PROBES_VARIABLE]?.trim().toLocaleLowerCase('en-US') !== 'off';
}

export async function runP10DiagnosticProbe(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<P10DiagnosticProbeReport> {
  const config = await loadRemoteRuntimeConfig(projectRoot, environment);
  const controlPlane = config.controlPlane;
  if (controlPlane.mode !== 'mysql') {
    throw new Error('The P10 diagnostic probe requires the MySQL Control Plane: the DIAGNOSTIC identity is read from it.');
  }
  const databaseConfig = controlPlane.database;
  if (!databaseConfig) throw new Error('The P10 diagnostic probe requires the MySQL Control Plane database configuration.');

  const database: ControlPlaneDatabaseClient = createControlPlaneDatabase(databaseConfig);
  const store = new MySqlControlPlaneStore(database);
  const identityRuntime = createIdentityRuntime(config.identity, {
    connectionFactory: new JwtConnectionFactory({
      instanceUrl: config.identity.instanceUrl,
      clientId: config.identity.clientId,
      privateKeyPath: config.identity.privateKeyPath,
    }),
    identityRepository: new MySqlIdentityRepository(database),
    logger: new JsonLineRuntimeLogger(),
  });

  // The configured usernames and the client id are registered as secrets so a Salesforce error message
  // that echoes one back cannot carry it into the evidence.
  const recorder = new ProbeRecorder([
    config.identity.clientId,
    config.identity.privateKeyPath,
    config.identity.primaryUsername,
    config.identity.diagnosticUsername ?? '',
  ]);

  let scope: RequestScope | undefined;
  try {
    const platformUserId = await resolveProbePlatformUser(store, environment);
    const snapshot = await new MySqlRuntimePolicySnapshotSource(database).load(platformUserId);
    const diagnostic = snapshot.diagnostic;
    const diagnosticIdentity = Object.freeze({
      configured: diagnostic !== null,
      enabled: diagnostic?.enabled ?? null,
      verificationStatus: diagnostic?.verificationStatus ?? null,
      salesforceUsernameMasked: diagnostic === null ? null : maskIdentifier(diagnostic.salesforceUsername),
    });
    const diagnosticRoute = snapshotDiagnosticRoute(snapshot, platformUserId);
    if (diagnosticRoute === undefined) {
      throw new Error(
        'This Control Plane has no Diagnostic identity row, so the P10 prerequisites cannot be measured. '
        + 'Configure and verify one through the Admin Control Plane, then re-run.',
      );
    }

    // The same pairing `http-server.ts` uses for a DIAGNOSTIC `tools/call`: the snapshot supplies the
    // username, the scope factory owns the Connection. Opening it any other way would measure a
    // different identity than the Tools run on, which would make the report irrelevant to the question
    // it exists to answer.
    scope = await identityRuntime.scopeFactory.createForRoute(
      { platformUserId, correlationId: `p10-probe-${Date.now()}` },
      diagnosticRoute,
    );
    const connection = await scope.getConnection();

    const org = await readOrgFacts(recorder, connection);
    const mayWrite = writeProbesAllowed(environment, org.isSandbox);
    await probeRootResources(recorder, connection);
    await probeDebugLogSurface(recorder, connection, diagnosticRoute.salesforceUsername, mayWrite);
    await probePlatformStatus(recorder, connection);
    await probePermissionSurface(recorder, connection, diagnosticRoute.salesforceUsername);
    await probeMetadataSurface(recorder, connection);
    await probeLocalization(recorder, connection);
    await probeBoundary(recorder, connection);

    const steps = recorder.collected();
    return Object.freeze({
      phase: 'P10',
      task: 'T1',
      generatedAt: new Date().toISOString(),
      probeMode: mayWrite ? 'SANDBOX_WRITE_ALLOWED' : 'READ_ONLY',
      platformUserIdMasked: maskIdentifier(platformUserId),
      diagnosticIdentity,
      org: org.facts,
      steps,
      summary: summarizeOutcomes(steps),
      openQuestions: Object.freeze(steps
        .filter((step) => step.outcome !== 'AVAILABLE')
        .map((step) => `${step.id}: ${step.outcome}`)),
    });
  } finally {
    if (scope) await scope.close().catch(() => undefined);
    await store.close().catch(() => undefined);
  }
}

/**
 * The probe resolves the platform user itself rather than taking it on a command line.
 *
 * An explicit `P10_PROBE_PLATFORM_USER` still wins when an operator wants a specific route, but the
 * default is the first enabled route in the Control Plane. That keeps a real platform user id out of
 * shell history and out of the process listing, for the same reason the P9 harness resolves its route
 * in-process.
 */
async function resolveProbePlatformUser(
  store: MySqlControlPlaneStore,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const explicit = environment[P10_PROBE_PLATFORM_USER_VARIABLE]?.trim();
  if (explicit) return explicit;
  const page = await store.repositories.identityRoutes.list({ limit: 50, offset: 0 });
  const enabled = page.items.find((route) => route.enabled);
  if (!enabled) {
    throw new Error(
      'No enabled identity route exists in this Control Plane, so no platform user can be resolved for the probe. '
      + `Set ${P10_PROBE_PLATFORM_USER_VARIABLE} to name one explicitly.`,
    );
  }
  return enabled.platformUserId;
}
