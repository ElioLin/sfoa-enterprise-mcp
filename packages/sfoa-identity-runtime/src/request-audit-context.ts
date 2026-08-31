import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  RequestAuditCollector,
  type AuditSnapshot,
  type SalesforceApiSemanticEvidence,
  type SalesforceApiSemanticEnrichment,
  type SalesforceAuditFields,
  type SalesforceAuditFieldValue,
  type SalesforceDmlOperation,
  type SalesforceApiPurpose,
  type SalesforceQueryType,
} from './request-audit-collector.js';

export type RequestAuditChannel = 'MCP_HTTP' | 'MCP_STDIO';
export type RequestAuditIdentitySource = 'INTERNAL_SERVICE_HEADER' | 'USER_BOUND_TOKEN' | 'BUNTU_TOKEN';

export type RequestAuditContext = Readonly<{
  auditId: string;
  correlationId: string;
  startedAt: string;
  channel: RequestAuditChannel;
  clientId: string | null;
  toolName: string;
  operation: string | null;
  objectApiName: string | null;
  recordId: string | null;
  platformUserId: string | null;
  identitySource: RequestAuditIdentitySource | null;
  identityCredentialId: string | null;
  executionRole: 'USER' | 'DIAGNOSTIC' | null;
  salesforceUsername: string | null;
  conversationId: string | null;
  turnId: string | null;
  externalRunId: string | null;
  agentId: string | null;
  modelProvider: string | null;
  modelName: string | null;
}>;

export type RequestAuditClientMetadata = Readonly<{
  conversationId?: unknown;
  turnId?: unknown;
  externalRunId?: unknown;
  agentId?: unknown;
  modelProvider?: unknown;
  modelName?: unknown;
}>;

export type CreateRequestAuditContextInput = Readonly<{
  correlationId?: string;
  channel: RequestAuditChannel;
  clientId?: string;
  toolName: string;
  operation?: string;
  objectApiName?: string;
  recordId?: string;
  clientMetadata?: RequestAuditClientMetadata;
}>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_METADATA_LENGTH = 256;
// Fits MySQL TEXT even under utf8mb4; the normal ASCII case retains a generous 65 KB.
export const MAX_AUDIT_SOQL_LENGTH = 65_000;
export const MAX_AUDIT_DML_FIELDS = 200;
export const MAX_AUDIT_FIELD_STRING_LENGTH = 4_096;
export const MAX_AUDIT_FIELDS_JSON_BYTES = 16_384;

export class RequestAuditContextController {
  private context: RequestAuditContext;
  private sequence = 0;
  private auditCallClaimed = false;
  private readonly auditCollector: RequestAuditCollector;

  private constructor(context: RequestAuditContext) {
    this.context = context;
    this.auditCollector = new RequestAuditCollector(() => this.snapshot(), () => this.nextSequence());
  }

  public static create(
    input: CreateRequestAuditContextInput,
    uuidFactory: () => string = randomUUID,
    nowFactory: () => Date = () => new Date(),
  ): RequestAuditContextController {
    const metadata = input.clientMetadata ?? {};
    return new RequestAuditContextController(Object.freeze({
      auditId: uuidFactory(),
      correlationId: validCorrelationId(input.correlationId) ?? uuidFactory(),
      startedAt: new Date(nowFactory().getTime()).toISOString(),
      channel: input.channel,
      clientId: boundedText(input.clientId, 128),
      toolName: boundedText(input.toolName, 128) ?? 'unknown_tool',
      operation: boundedText(input.operation, 64),
      objectApiName: boundedText(input.objectApiName, 128),
      recordId: boundedText(input.recordId, 128),
      platformUserId: null,
      identitySource: null,
      identityCredentialId: null,
      executionRole: null,
      salesforceUsername: null,
      conversationId: boundedMetadata(metadata.conversationId),
      turnId: boundedMetadata(metadata.turnId),
      externalRunId: boundedMetadata(metadata.externalRunId),
      agentId: boundedMetadata(metadata.agentId),
      modelProvider: boundedMetadata(metadata.modelProvider),
      modelName: boundedMetadata(metadata.modelName),
    }));
  }

  public snapshot(): RequestAuditContext {
    return this.context;
  }

  public withResolvedIdentity(input: Readonly<{
    clientId?: string;
    platformUserId: string;
    identitySource: RequestAuditIdentitySource;
    identityCredentialId?: string;
  }>): this {
    this.context = Object.freeze({
      ...this.context,
      clientId: boundedText(input.clientId, 128) ?? this.context.clientId,
      platformUserId: boundedText(input.platformUserId, 128),
      identitySource: input.identitySource,
      identityCredentialId: boundedText(input.identityCredentialId, 128),
    });
    return this;
  }

  public withSalesforceRoute(input: Readonly<{
    salesforceUsername: string;
    executionRole: 'USER' | 'DIAGNOSTIC';
  }>): this {
    this.context = Object.freeze({
      ...this.context,
      salesforceUsername: boundedText(input.salesforceUsername, 320),
      executionRole: input.executionRole,
    });
    return this;
  }

  public withOperation(input: Readonly<{
    operation?: string;
    objectApiName?: string;
    recordId?: string;
  }>): this {
    this.context = Object.freeze({
      ...this.context,
      operation: boundedText(input.operation, 64) ?? this.context.operation,
      objectApiName: boundedText(input.objectApiName, 128) ?? this.context.objectApiName,
      recordId: boundedText(input.recordId, 128) ?? this.context.recordId,
    });
    return this;
  }

  public nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  public claimAuditCallPersistence(): boolean {
    if (this.auditCallClaimed) return false;
    this.auditCallClaimed = true;
    return true;
  }

  public collector(): RequestAuditCollector {
    return this.auditCollector;
  }

  public finalizeAudit(completedAt?: Date): AuditSnapshot | undefined {
    return this.auditCollector.finalize(completedAt);
  }
}

type RequestAuditStore = Readonly<{
  controller: RequestAuditContextController;
  salesforceApiPurpose: SalesforceApiPurpose;
  salesforceCallSemanticScope: SalesforceCallSemanticScope | null;
}>;

type SemanticBindingState = {
  readonly publicApiCallIds: string[];
  partialReported: boolean;
};

export type SalesforceQuerySemanticInput = Readonly<{
  queryType: SalesforceQueryType;
  soqlStatement: string;
}>;

export type SalesforceDmlSemanticInput = Readonly<{
  operation: SalesforceDmlOperation;
  objectApiName: string;
  recordId?: string;
  requestedFields: Readonly<Record<string, unknown>>;
  managedFields: Readonly<Record<string, unknown>>;
}>;

export type SalesforceSubmittedDmlSemanticInput = Readonly<{
  submittedFields: Readonly<Record<string, unknown>>;
}>;

export type SalesforceQueryResultStatistics = Readonly<{
  totalSize: unknown;
  records: unknown;
  done: unknown;
  nextRecordsUrl?: unknown;
}>;

/**
 * Request-owned semantic scope. Mutable binding state is confined to the current
 * ALS branch; nested submitted-field scopes share only their own DML binding IDs.
 */
export class SalesforceCallSemanticScope {
  private constructor(
    private readonly controller: RequestAuditContextController,
    private readonly evidence: SalesforceApiSemanticEvidence,
    private readonly binding: SemanticBindingState,
    private readonly partial: boolean,
  ) {}

  public static query(
    controller: RequestAuditContextController,
    input: SalesforceQuerySemanticInput,
  ): SalesforceCallSemanticScope {
    const soql = boundedSoql(input.soqlStatement);
    const object = safeExtractSoqlObject(input.soqlStatement);
    return new SalesforceCallSemanticScope(controller, Object.freeze({
      ...emptySemanticEvidence(),
      queryType: input.queryType,
      soqlStatement: soql.value,
      objectApiName: object.value,
    }), { publicApiCallIds: [], partialReported: false }, soql.partial || object.partial);
  }

  public static dml(
    controller: RequestAuditContextController,
    input: SalesforceDmlSemanticInput,
  ): SalesforceCallSemanticScope {
    const requested = boundedAuditFields(input.requestedFields);
    const managed = boundedAuditFields(input.managedFields);
    const objectApiName = boundedSemanticToken(input.objectApiName, 128);
    const recordId = input.recordId === undefined ? { value: null, partial: false } : boundedSemanticToken(input.recordId, 128);
    return new SalesforceCallSemanticScope(controller, Object.freeze({
      ...emptySemanticEvidence(),
      dmlOperation: input.operation,
      objectApiName: objectApiName.value,
      recordId: recordId.value,
      requestedFields: requested.value,
      managedFields: managed.value,
    }), { publicApiCallIds: [], partialReported: false },
    requested.partial || managed.partial || objectApiName.partial || recordId.partial);
  }

  public withSubmittedFields(input: SalesforceSubmittedDmlSemanticInput): SalesforceCallSemanticScope {
    const submitted = boundedAuditFields(input.submittedFields);
    return new SalesforceCallSemanticScope(this.controller, Object.freeze({
      ...this.evidence,
      submittedFields: submitted.value,
    }), this.binding, this.partial || submitted.partial);
  }

  public bind(publicApiCallId: string): SalesforceApiSemanticEvidence {
    if (this.binding.publicApiCallIds.length < 256) this.binding.publicApiCallIds.push(publicApiCallId);
    else this.reportPartial();
    if (this.partial) this.reportPartial();
    return this.evidence;
  }

  public enrichLatest(enrichment: SalesforceApiSemanticEnrichment): void {
    const publicApiCallId = this.binding.publicApiCallIds.at(-1);
    if (!publicApiCallId) {
      this.reportPartial();
      return;
    }
    this.controller.collector().enrichSalesforceApiCall(publicApiCallId, enrichment);
  }

  public enrichQueryResult(result: SalesforceQueryResultStatistics): void {
    try {
      const totalSize = boundedCount(result.totalSize);
      const returnedRecords = Array.isArray(result.records) ? boundedCount(result.records.length) : null;
      const done = typeof result.done === 'boolean' ? result.done : null;
      const hasNextRecords = typeof result.nextRecordsUrl === 'string' && result.nextRecordsUrl.length > 0;
      if (totalSize === null || returnedRecords === null || done === null) this.reportPartial();
      this.enrichLatest({ totalSize, returnedRecords, done, hasNextRecords });
    } catch {
      this.reportPartial();
    }
  }

  public enrichRecordId(recordId: string): void {
    const bounded = boundedSemanticToken(recordId, 128);
    if (bounded.partial || bounded.value === null) this.reportPartial();
    this.enrichLatest({ recordId: bounded.value });
  }

  private reportPartial(): void {
    if (this.binding.partialReported) return;
    this.binding.partialReported = true;
    this.controller.collector().recordSalesforceApiCaptureFailure();
  }
}

const requestAuditStorage = new AsyncLocalStorage<RequestAuditStore>();

export function runWithRequestAuditContext<T>(
  context: RequestAuditContextController,
  callback: () => T,
): T {
  return requestAuditStorage.run(Object.freeze({
    controller: context,
    salesforceApiPurpose: 'UNKNOWN',
    salesforceCallSemanticScope: null,
  }), callback);
}

export function currentRequestAuditContext(): RequestAuditContextController | undefined {
  return requestAuditStorage.getStore()?.controller;
}

export function currentSalesforceApiPurpose(): SalesforceApiPurpose {
  return requestAuditStorage.getStore()?.salesforceApiPurpose ?? 'UNKNOWN';
}

export function runWithSalesforceApiPurpose<T>(purpose: SalesforceApiPurpose, callback: () => T): T {
  const store = requestAuditStorage.getStore();
  if (!store) return callback();
  return requestAuditStorage.run(Object.freeze({ ...store, salesforceApiPurpose: purpose }), callback);
}

export function currentSalesforceCallSemanticScope(): SalesforceCallSemanticScope | undefined {
  return requestAuditStorage.getStore()?.salesforceCallSemanticScope ?? undefined;
}

export function runWithSalesforceQuerySemantic<T>(input: SalesforceQuerySemanticInput, callback: () => T): T {
  const store = requestAuditStorage.getStore();
  if (!store) return callback();
  try {
    const scope = SalesforceCallSemanticScope.query(store.controller, input);
    return requestAuditStorage.run(Object.freeze({ ...store, salesforceCallSemanticScope: scope }), callback);
  } catch {
    store.controller.collector().recordSalesforceApiCaptureFailure();
    return callback();
  }
}

export function runWithSalesforceDmlSemantic<T>(input: SalesforceDmlSemanticInput, callback: () => T): T {
  const store = requestAuditStorage.getStore();
  if (!store) return callback();
  try {
    const scope = SalesforceCallSemanticScope.dml(store.controller, input);
    return requestAuditStorage.run(Object.freeze({ ...store, salesforceCallSemanticScope: scope }), callback);
  } catch {
    store.controller.collector().recordSalesforceApiCaptureFailure();
    return callback();
  }
}

export function runWithSalesforceSubmittedDmlSemantic<T>(
  input: SalesforceSubmittedDmlSemanticInput,
  callback: () => T,
): T {
  const store = requestAuditStorage.getStore();
  const current = store?.salesforceCallSemanticScope;
  if (!store) return callback();
  if (!current) {
    store.controller.collector().recordSalesforceApiCaptureFailure();
    return callback();
  }
  try {
    return requestAuditStorage.run(Object.freeze({
      ...store,
      salesforceCallSemanticScope: current.withSubmittedFields(input),
    }), callback);
  } catch {
    store.controller.collector().recordSalesforceApiCaptureFailure();
    return callback();
  }
}

function emptySemanticEvidence(): SalesforceApiSemanticEvidence {
  return {
    queryType: null,
    soqlStatement: null,
    totalSize: null,
    returnedRecords: null,
    done: null,
    hasNextRecords: null,
    dmlOperation: null,
    objectApiName: null,
    recordId: null,
    requestedFields: null,
    managedFields: null,
    submittedFields: null,
  };
}

function boundedSoql(value: string): Readonly<{ value: string | null; partial: boolean }> {
  const withoutNul = value.replace(/\u0000/gu, '');
  if (withoutNul.length === 0) return Object.freeze({ value: null, partial: value.length > 0 });
  const lengthBounded = withoutNul.slice(0, MAX_AUDIT_SOQL_LENGTH);
  const byteBounded = truncateUtf8(lengthBounded, MAX_AUDIT_SOQL_LENGTH);
  return Object.freeze({
    value: byteBounded,
    partial: withoutNul.length !== value.length || byteBounded.length !== withoutNul.length,
  });
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(value.charAt(low - 1))) low -= 1;
  return value.slice(0, low);
}

function boundedAuditFields(input: Readonly<Record<string, unknown>>): Readonly<{
  value: SalesforceAuditFields;
  partial: boolean;
}> {
  const output: Record<string, SalesforceAuditFieldValue> = {};
  let bytes = 2;
  let capturedCount = 0;
  let partial = false;
  const entries = Object.entries(input);
  for (const [index, [rawKey, rawValue]] of entries.entries()) {
    if (index >= MAX_AUDIT_DML_FIELDS) {
      partial = true;
      break;
    }
    const key = rawKey.replace(/[\u0000-\u001F\u007F]/gu, '').slice(0, 128);
    if (!key) {
      partial = true;
      continue;
    }
    const normalized = boundedAuditFieldValue(rawValue);
    partial ||= normalized.partial || key !== rawKey;
    if (normalized.skip) continue;
    const entryBytes = Buffer.byteLength(JSON.stringify(key), 'utf8') + 1
      + Buffer.byteLength(JSON.stringify(normalized.value), 'utf8') + (capturedCount > 0 ? 1 : 0);
    if (bytes + entryBytes > MAX_AUDIT_FIELDS_JSON_BYTES) {
      partial = true;
      break;
    }
    output[key] = normalized.value;
    bytes += entryBytes;
    capturedCount += 1;
  }
  return Object.freeze({ value: Object.freeze(output), partial });
}

function boundedAuditFieldValue(value: unknown): Readonly<{
  value: SalesforceAuditFieldValue;
  partial: boolean;
  skip: boolean;
}> {
  if (value === null || typeof value === 'boolean') return Object.freeze({ value, partial: false, skip: false });
  if (typeof value === 'string') return Object.freeze({
    value: value.slice(0, MAX_AUDIT_FIELD_STRING_LENGTH),
    partial: value.length > MAX_AUDIT_FIELD_STRING_LENGTH,
    skip: false,
  });
  if (typeof value === 'number') return Object.freeze({
    value: Number.isFinite(value) ? value : null,
    partial: !Number.isFinite(value),
    skip: false,
  });
  return Object.freeze({ value: null, partial: true, skip: value === undefined });
}

function boundedSemanticToken(value: string, maxLength: number): Readonly<{ value: string | null; partial: boolean }> {
  const sanitized = value.replace(/[\u0000-\u001F\u007F]/gu, '').trim();
  return Object.freeze({
    value: sanitized.length === 0 ? null : sanitized.slice(0, maxLength),
    partial: sanitized !== value.trim() || sanitized.length > maxLength,
  });
}

function boundedCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 4_294_967_295
    ? value
    : null;
}

function safeExtractSoqlObject(soql: string): Readonly<{ value: string | null; partial: boolean }> {
  try {
    let depth = 0;
    let quoted = false;
    for (let index = 0; index < soql.length; index += 1) {
      const character = soql[index];
      if (quoted) {
        if (character === '\\') index += 1;
        else if (character === "'") quoted = false;
        continue;
      }
      if (character === "'") {
        quoted = true;
        continue;
      }
      if (character === '(') depth += 1;
      else if (character === ')') depth = Math.max(0, depth - 1);
      else if (
        depth === 0
        && (index === 0 || /\s/u.test(soql[index - 1] ?? ''))
        && /^FROM\b/iu.test(soql.slice(index))
      ) {
        const match = /^FROM\s+([A-Za-z][A-Za-z0-9_]{0,127})(?:\s|$)/iu.exec(soql.slice(index));
        return Object.freeze({ value: match?.[1] ?? null, partial: false });
      }
    }
    return Object.freeze({ value: null, partial: false });
  } catch {
    return Object.freeze({ value: null, partial: true });
  }
}

function validCorrelationId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return SAFE_ID.test(trimmed) ? trimmed : undefined;
}

function boundedMetadata(value: unknown): string | null {
  return typeof value === 'string' ? boundedText(value, MAX_METADATA_LENGTH) : null;
}

function boundedText(value: string | undefined, maxLength: number): string | null {
  if (value === undefined) return null;
  const sanitized = value.replace(/[\u0000-\u001F\u007F]/gu, '').trim();
  if (sanitized.length === 0) return null;
  return sanitized.slice(0, maxLength);
}
