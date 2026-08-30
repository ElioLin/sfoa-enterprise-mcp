import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { RequestAuditCollector, type AuditSnapshot } from './request-audit-collector.js';

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

const requestAuditStorage = new AsyncLocalStorage<RequestAuditContextController>();

export function runWithRequestAuditContext<T>(
  context: RequestAuditContextController,
  callback: () => T,
): T {
  return requestAuditStorage.run(context, callback);
}

export function currentRequestAuditContext(): RequestAuditContextController | undefined {
  return requestAuditStorage.getStore();
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
