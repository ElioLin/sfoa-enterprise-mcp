import { randomUUID } from 'node:crypto';
import {
  ControlPlaneError,
  encodeBoundedAuditPayload,
  type AuditEventRecord,
  type AuditPayloadEvidenceRecord,
  type AuditRecord,
  type DiagnosticConfigRecord,
  type DmlPolicyRecord,
  type IdentityCredentialRecord,
  type IdentityRouteRecord,
  type ManagedDmlFieldRuleRecord,
  type Page,
  type RuntimeSettingKey,
  type RuntimeSettingRecord,
  type SalesforceApiCallRecord,
  type ToolControlRecord,
} from '../index.js';
import type {
  AuditEventCreateInput,
  AuditPayloadEvidenceCreateInput,
  AuditWrite,
  ControlPlaneRepositories,
  ControlPlaneRepositoriesWithAuditTrace,
  DiagnosticConfigWriteInput,
  DmlPolicyCreateInput,
  DmlPolicyUpdateInput,
  IdentityRouteCreateInput,
  IdentityRouteUpdateInput,
  ListOptions,
  ManagedDmlFieldRuleCreateInput,
  ManagedDmlFieldRuleUpdateInput,
  SalesforceApiCallCreateInput,
  ToolControlWriteInput,
} from '../repositories.js';
import type { TransactionalControlPlaneStore } from '../store.js';

const TEST_TIME = '2026-01-01T00:00:00.000Z';

export class InMemoryControlPlaneStore implements TransactionalControlPlaneStore {
  private routes = new Map<string, IdentityRouteRecord>();
  private credentials = new Map<string, IdentityCredentialRecord>();
  private tools = new Map<string, ToolControlRecord>();
  private dmlPolicies = new Map<string, DmlPolicyRecord>();
  private managedDmlFieldRules = new Map<string, ManagedDmlFieldRuleRecord>();
  private diagnostic: DiagnosticConfigRecord | undefined;
  private settings = new Map<RuntimeSettingKey, RuntimeSettingRecord>();
  private audits: AuditRecord[] = [];
  private auditEvents: AuditEventRecord[] = [];
  private salesforceApiCalls: SalesforceApiCallRecord[] = [];
  private auditPayloads: AuditPayloadEvidenceRecord[] = [];
  private nextEntityId = 1;
  private nextAuditId = 1;
  private nextAuditDetailId = 1;
  private failAudit = false;

  public readonly repositories: ControlPlaneRepositoriesWithAuditTrace;

  public constructor() {
    this.repositories = Object.freeze({
      identityRoutes: {
        list: async (options) => {
          const keyword = options.keyword?.trim().toLocaleLowerCase('en-US');
          const routes = [...this.routes.values()].filter((record) => !keyword
            || record.platformUserId.toLocaleLowerCase('en-US').includes(keyword)
            || record.salesforceUsername.toLocaleLowerCase('en-US').includes(keyword));
          return makeTotalPage(routes.sort((a, b) => a.platformUserId.localeCompare(b.platformUserId)), options);
        },
        countActive: async () => [...this.routes.values()].filter((record) => record.enabled).length,
        getById: async (id) => this.routes.get(id),
        getByPlatformUserId: async (platformUserId) => [...this.routes.values()].find((record) => record.platformUserId === platformUserId),
        findActiveByPlatformUserId: async (platformUserId) => [...this.routes.values()].find(
          (record) => record.enabled && record.platformUserId === platformUserId,
        ),
        listActiveSalesforceUsernames: async () => Object.freeze(
          [...this.routes.values()].filter((record) => record.enabled).map((record) => record.salesforceUsername),
        ),
        create: async (input) => this.createRoute(input),
        update: async (id, input) => this.updateRoute(id, input),
        disable: async (id, rowVersion) => {
          const current = this.required(this.routes.get(id), 'Identity route');
          return this.updateRoute(id, { ...current, enabled: false, rowVersion });
        },
        delete: async (id, rowVersion) => {
          const current = this.required(this.routes.get(id), 'Identity route');
          this.assertVersion(current.rowVersion, rowVersion);
          this.routes.delete(id);
        },
      },
      identityCredentials: {
        getById: async (id) => this.credentials.get(id),
        getByTokenHash: async (tokenHash) => [...this.credentials.values()].find((record) => record.tokenHash === tokenHash),
        getActiveByRouteId: async (identityRouteId) => [...this.credentials.values()].find(
          (record) => record.identityRouteId === identityRouteId && record.status === 'ACTIVE',
        ),
        listActiveByRouteIds: async (identityRouteIds) => Object.freeze([...this.credentials.values()].filter(
          (record) => identityRouteIds.includes(record.identityRouteId) && record.status === 'ACTIVE',
        )),
        listByRouteId: async (identityRouteId) => Object.freeze([...this.credentials.values()].filter(
          (record) => record.identityRouteId === identityRouteId,
        )),
        create: async (input) => {
          if ([...this.credentials.values()].some(
            (record) => record.tokenHash === input.tokenHash
              || (record.identityRouteId === input.identityRouteId && record.status === 'ACTIVE'),
          )) throw conflict();
          const record = Object.freeze({
            id: this.entityId(),
            identityRouteId: input.identityRouteId,
            credentialType: input.credentialType,
            tokenHash: input.tokenHash,
            tokenCiphertext: input.tokenCiphertext,
            tokenLast4: input.tokenLast4,
            status: 'ACTIVE' as const,
            generatedAt: input.generatedAt.toISOString(),
            lastUsedAt: null,
            revokedAt: null,
            rowVersion: '1',
            createdAt: TEST_TIME,
            updatedAt: TEST_TIME,
          });
          this.credentials.set(record.id, record);
          return record;
        },
        revoke: async (id, rowVersion, revokedAt) => {
          const current = this.required(this.credentials.get(id), 'Identity credential');
          this.assertVersion(current.rowVersion, rowVersion);
          if (current.status !== 'ACTIVE') this.assertVersion(current.rowVersion, '__revoked__');
          const updated = Object.freeze({
            ...current,
            status: 'REVOKED' as const,
            tokenCiphertext: null,
            revokedAt: revokedAt.toISOString(),
            rowVersion: incrementVersion(current.rowVersion),
            updatedAt: TEST_TIME,
          });
          this.credentials.set(id, updated);
          return updated;
        },
        markLastUsed: async (id, usedAt) => {
          const current = this.credentials.get(id);
          if (!current || current.status !== 'ACTIVE') return;
          this.credentials.set(id, Object.freeze({ ...current, lastUsedAt: usedAt.toISOString(), updatedAt: TEST_TIME }));
        },
        deleteByRouteId: async (identityRouteId) => {
          for (const [id, credential] of this.credentials) {
            if (credential.identityRouteId === identityRouteId) this.credentials.delete(id);
          }
        },
      },
      tools: {
        list: async (options) => makePage([...this.tools.values()].sort((a, b) => a.toolName.localeCompare(b.toolName)), options),
        countEnabled: async () => [...this.tools.values()].filter((record) => record.enabled).length,
        getByName: async (toolName) => this.tools.get(toolName),
        listEnabledNames: async () => Object.freeze([...this.tools.values()].filter((record) => record.enabled).map((record) => record.toolName).sort()),
        createIfAbsent: async (toolName, enabled, remark) => {
          const existing = this.tools.get(toolName);
          if (existing) return existing;
          const created = Object.freeze({
            id: this.entityId(), toolName, enabled, remark, rowVersion: '1', createdAt: TEST_TIME, updatedAt: TEST_TIME,
          });
          this.tools.set(toolName, created);
          return created;
        },
        update: async (toolName, input) => this.updateTool(toolName, input),
      },
      dmlPolicies: {
        list: async (options) => makePage([...this.dmlPolicies.values()].sort((a, b) => a.objectApiName.localeCompare(b.objectApiName)), options),
        countEnabled: async () => [...this.dmlPolicies.values()].filter((record) => record.enabled).length,
        getById: async (id) => this.dmlPolicies.get(id),
        getByObjectApiName: async (objectApiName) => [...this.dmlPolicies.values()].find(
          (record) => record.objectApiName.toLocaleLowerCase('en-US') === objectApiName.toLocaleLowerCase('en-US'),
        ),
        listEnabled: async () => Object.freeze([...this.dmlPolicies.values()].filter((record) => record.enabled)),
        create: async (input) => this.createDml(input),
        update: async (id, input) => this.updateDml(id, input),
        disable: async (id, rowVersion) => {
          const current = this.required(this.dmlPolicies.get(id), 'DML policy');
          return this.updateDml(id, { ...current, enabled: false, rowVersion });
        },
      },
      managedDmlFieldRules: {
        listByDmlPolicyId: async (dmlPolicyId, options) => makePage(
          [...this.managedDmlFieldRules.values()]
            .filter((record) => record.dmlPolicyId === dmlPolicyId)
            .sort((a, b) => a.targetFieldApiName.localeCompare(b.targetFieldApiName)),
          options,
        ),
        getById: async (id) => this.managedDmlFieldRules.get(id),
        listEnabledByDmlPolicyIds: async (dmlPolicyIds) => Object.freeze(
          [...this.managedDmlFieldRules.values()].filter(
            (record) => record.enabled && dmlPolicyIds.includes(record.dmlPolicyId),
          ),
        ),
        create: async (input) => this.createManagedDmlFieldRule(input),
        update: async (id, input) => this.updateManagedDmlFieldRule(id, input),
        disable: async (id, rowVersion) => {
          const current = this.required(this.managedDmlFieldRules.get(id), 'Managed DML field rule');
          return this.updateManagedDmlFieldRule(id, { ...current, enabled: false, rowVersion });
        },
        delete: async (id, rowVersion) => {
          const current = this.required(this.managedDmlFieldRules.get(id), 'Managed DML field rule');
          this.assertVersion(current.rowVersion, rowVersion);
          this.managedDmlFieldRules.delete(id);
        },
      },
      diagnostic: {
        get: async () => this.diagnostic,
        upsert: async (input) => this.upsertDiagnostic(input),
        recordVerification: async (input) => {
          const current = this.required(this.diagnostic, 'Diagnostic config');
          this.assertVersion(current.rowVersion, input.rowVersion);
          const updated = Object.freeze({
            ...current,
            verificationStatus: input.status,
            lastVerifiedAt: TEST_TIME,
            lastErrorCode: input.errorCode,
            lastErrorMessageSafe: input.errorMessageSafe,
            rowVersion: incrementVersion(current.rowVersion),
            updatedAt: TEST_TIME,
          });
          this.diagnostic = updated;
          return updated;
        },
      },
      runtimeSettings: {
        list: async () => Object.freeze([...this.settings.values()].sort((a, b) => a.settingKey.localeCompare(b.settingKey))),
        get: async (key) => this.settings.get(key),
        upsert: async (key, value, rowVersion) => {
          const current = this.settings.get(key);
          if (current) this.assertVersion(current.rowVersion, rowVersion);
          const updated = Object.freeze({
            settingKey: key,
            settingValue: value,
            rowVersion: current ? incrementVersion(current.rowVersion) : '1',
            updatedAt: TEST_TIME,
          });
          this.settings.set(key, updated);
          return updated;
        },
      },
      audits: {
        append: async (event) => this.appendAudit(event),
        getById: async (id) => this.audits.find((record) => record.id === id),
        search: async (filter) => {
          const items = this.audits.filter((record) =>
            (!filter.result || record.result === filter.result) &&
            (!filter.toolName || record.toolName === filter.toolName) &&
            (!filter.correlationId || record.correlationId === filter.correlationId),
          );
          return makePage(items.reverse(), filter);
        },
        countSince: async () => Object.freeze({
          total: this.audits.length,
          pass: this.audits.filter((record) => record.result === 'PASS').length,
          blocked: this.audits.filter((record) => record.result === 'BLOCKED').length,
          error: this.audits.filter((record) => record.result === 'ERROR').length,
          unknown: this.audits.filter((record) => record.outcome === 'UNKNOWN').length,
        }),
      },
      auditTraces: {
        createCall: async (input) => this.appendAudit({ ...input, channel: 'MCP', toolName: input.toolName, auditKind: 'MCP_TOOL_CALL' }),
        getByPublicAuditId: async (publicAuditId) => this.audits.find((record) => record.publicAuditId === publicAuditId),
        createEvent: async (input) => this.createAuditEvent(input),
        listEvents: async (auditId, options) => makePage(
          this.auditEvents.filter((record) => record.auditId === auditId).sort((a, b) => a.sequence - b.sequence),
          options,
        ),
        createSalesforceApiCall: async (input) => this.createSalesforceApiCall(input),
        listSalesforceApiCalls: async (auditId, options) => makePage(
          this.salesforceApiCalls.filter((record) => record.auditId === auditId).sort((a, b) => a.sequence - b.sequence),
          options,
        ),
        createPayloadEvidence: async (input) => this.createAuditPayload(input),
        getPayloadEvidenceById: async (id) => this.auditPayloads.find((record) => record.id === id),
        listPayloadEvidence: async (auditId, options) => makePage(
          this.auditPayloads.filter((record) => record.auditId === auditId),
          options,
        ),
      },
    });
  }

  public setAuditFailure(value: boolean): void {
    this.failAudit = value;
  }

  public async transaction<T>(work: (repositories: ControlPlaneRepositories) => Promise<T>): Promise<T> {
    const snapshot = {
      routes: new Map(this.routes),
      credentials: new Map(this.credentials),
      tools: new Map(this.tools),
      dmlPolicies: new Map(this.dmlPolicies),
      managedDmlFieldRules: new Map(this.managedDmlFieldRules),
      diagnostic: this.diagnostic,
      settings: new Map(this.settings),
      audits: [...this.audits],
      auditEvents: [...this.auditEvents],
      salesforceApiCalls: [...this.salesforceApiCalls],
      auditPayloads: [...this.auditPayloads],
      nextEntityId: this.nextEntityId,
      nextAuditId: this.nextAuditId,
      nextAuditDetailId: this.nextAuditDetailId,
    };
    try {
      return await work(this.repositories);
    } catch (error) {
      this.routes = snapshot.routes;
      this.credentials = snapshot.credentials;
      this.tools = snapshot.tools;
      this.dmlPolicies = snapshot.dmlPolicies;
      this.managedDmlFieldRules = snapshot.managedDmlFieldRules;
      this.diagnostic = snapshot.diagnostic;
      this.settings = snapshot.settings;
      this.audits = snapshot.audits;
      this.auditEvents = snapshot.auditEvents;
      this.salesforceApiCalls = snapshot.salesforceApiCalls;
      this.auditPayloads = snapshot.auditPayloads;
      this.nextEntityId = snapshot.nextEntityId;
      this.nextAuditId = snapshot.nextAuditId;
      this.nextAuditDetailId = snapshot.nextAuditDetailId;
      throw error;
    }
  }

  private async createRoute(input: IdentityRouteCreateInput): Promise<IdentityRouteRecord> {
    if ([...this.routes.values()].some((record) => record.platformUserId === input.platformUserId)) throw conflict();
    const record = Object.freeze({
      ...input, id: this.entityId(), rowVersion: '1', createdAt: TEST_TIME, updatedAt: TEST_TIME,
    });
    this.routes.set(record.id, record);
    return record;
  }

  private async updateRoute(id: string, input: IdentityRouteUpdateInput): Promise<IdentityRouteRecord> {
    const current = this.required(this.routes.get(id), 'Identity route');
    this.assertVersion(current.rowVersion, input.rowVersion);
    if ([...this.routes.values()].some((record) => record.id !== id && record.platformUserId === input.platformUserId)) throw conflict();
    const updated = Object.freeze({ ...current, ...input, rowVersion: incrementVersion(current.rowVersion), updatedAt: TEST_TIME });
    this.routes.set(id, updated);
    return updated;
  }

  private async updateTool(toolName: string, input: ToolControlWriteInput): Promise<ToolControlRecord> {
    const current = this.required(this.tools.get(toolName), 'Tool control');
    this.assertVersion(current.rowVersion, input.rowVersion);
    const updated = Object.freeze({
      ...current, enabled: input.enabled, remark: input.remark,
      rowVersion: incrementVersion(current.rowVersion), updatedAt: TEST_TIME,
    });
    this.tools.set(toolName, updated);
    return updated;
  }

  private async createDml(input: DmlPolicyCreateInput): Promise<DmlPolicyRecord> {
    if ([...this.dmlPolicies.values()].some(
      (record) => record.objectApiName.toLocaleLowerCase('en-US') === input.objectApiName.toLocaleLowerCase('en-US'),
    )) throw conflict();
    const record = Object.freeze({ ...input, id: this.entityId(), rowVersion: '1', createdAt: TEST_TIME, updatedAt: TEST_TIME });
    this.dmlPolicies.set(record.id, record);
    return record;
  }

  private async updateDml(id: string, input: DmlPolicyUpdateInput): Promise<DmlPolicyRecord> {
    const current = this.required(this.dmlPolicies.get(id), 'DML policy');
    this.assertVersion(current.rowVersion, input.rowVersion);
    const updated = Object.freeze({ ...current, ...input, rowVersion: incrementVersion(current.rowVersion), updatedAt: TEST_TIME });
    this.dmlPolicies.set(id, updated);
    return updated;
  }

  private async createManagedDmlFieldRule(input: ManagedDmlFieldRuleCreateInput): Promise<ManagedDmlFieldRuleRecord> {
    if ([...this.managedDmlFieldRules.values()].some((record) => record.dmlPolicyId === input.dmlPolicyId
      && record.targetFieldApiName.toLocaleLowerCase('en-US') === input.targetFieldApiName.toLocaleLowerCase('en-US'))) {
      throw conflict();
    }
    const record = Object.freeze({ ...input, id: this.entityId(), rowVersion: '1', createdAt: TEST_TIME, updatedAt: TEST_TIME });
    this.managedDmlFieldRules.set(record.id, record);
    return record;
  }

  private async updateManagedDmlFieldRule(
    id: string,
    input: ManagedDmlFieldRuleUpdateInput,
  ): Promise<ManagedDmlFieldRuleRecord> {
    const current = this.required(this.managedDmlFieldRules.get(id), 'Managed DML field rule');
    this.assertVersion(current.rowVersion, input.rowVersion);
    if ([...this.managedDmlFieldRules.values()].some((record) => record.id !== id
      && record.dmlPolicyId === current.dmlPolicyId
      && record.targetFieldApiName.toLocaleLowerCase('en-US') === input.targetFieldApiName.toLocaleLowerCase('en-US'))) {
      throw conflict();
    }
    const updated = Object.freeze({ ...current, ...input, rowVersion: incrementVersion(current.rowVersion), updatedAt: TEST_TIME });
    this.managedDmlFieldRules.set(id, updated);
    return updated;
  }

  private async upsertDiagnostic(input: DiagnosticConfigWriteInput): Promise<DiagnosticConfigRecord> {
    if (this.diagnostic) this.assertVersion(this.diagnostic.rowVersion, input.rowVersion);
    const current = this.diagnostic;
    const updated = Object.freeze({
      id: '1' as const,
      salesforceUsername: input.salesforceUsername,
      enabled: input.enabled,
      verificationStatus: 'NOT_VERIFIED' as const,
      lastVerifiedAt: null,
      lastErrorCode: null,
      lastErrorMessageSafe: null,
      testMetadataType: input.testMetadataType,
      testMetadataFullName: input.testMetadataFullName,
      rowVersion: current ? incrementVersion(current.rowVersion) : '1',
      createdAt: current?.createdAt ?? TEST_TIME,
      updatedAt: TEST_TIME,
    });
    this.diagnostic = updated;
    return updated;
  }

  private async appendAudit(event: AuditWrite): Promise<AuditRecord> {
    if (this.failAudit) throw new Error('simulated audit persistence failure');
    const id = String(this.nextAuditId++);
    const record: AuditRecord = Object.freeze({
      id,
      publicAuditId: event.publicAuditId ?? `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
      auditKind: event.auditKind ?? (event.channel === 'ADMIN'
        ? 'ADMIN_ACTION'
        : event.operation === 'BUNTU_TOKEN_VALIDATE'
          ? 'IDENTITY_VALIDATION'
          : 'RUNTIME_EVENT'),
      occurredAt: event.occurredAt.toISOString(),
      startedAt: event.startedAt?.toISOString() ?? null,
      completedAt: event.completedAt?.toISOString() ?? null,
      correlationId: event.correlationId,
      channel: event.channel,
      clientId: event.clientId ?? null,
      actorAdmin: event.actorAdmin ?? null,
      platformUserId: event.platformUserId ?? null,
      salesforceUsername: event.salesforceUsername ?? null,
      executionRole: event.executionRole ?? null,
      identitySource: event.identitySource ?? null,
      identityCredentialId: event.identityCredentialId ?? null,
      toolName: event.toolName ?? null,
      operation: event.operation ?? null,
      objectApiName: event.objectApiName ?? null,
      recordId: event.recordId ?? null,
      result: event.result,
      outcome: event.outcome ?? null,
      errorCode: event.errorCode ?? null,
      errorMessageSafe: event.errorMessageSafe ?? null,
      auditIntegrityStatus: event.auditIntegrityStatus ?? 'PARTIAL',
      durationMs: event.durationMs ?? null,
      requestSummary: event.requestSummary ?? null,
      responseSummary: event.responseSummary ?? null,
      createdAt: TEST_TIME,
    });
    this.audits.push(record);
    return record;
  }

  private async createAuditEvent(input: AuditEventCreateInput): Promise<AuditEventRecord> {
    this.required(this.audits.find((record) => record.id === input.auditId && record.auditKind === 'MCP_TOOL_CALL'), 'Audit call');
    if (this.auditEvents.some((record) => record.auditId === input.auditId && record.sequence === input.sequence)) throw conflict();
    if (input.parentEventId) {
      this.required(this.auditEvents.find((record) => record.id === input.parentEventId && record.auditId === input.auditId), 'Parent audit event');
    }
    const record: AuditEventRecord = Object.freeze({
      id: String(this.nextAuditDetailId++),
      auditId: input.auditId,
      sequence: input.sequence,
      parentEventId: input.parentEventId ?? null,
      eventCategory: input.eventCategory,
      eventType: input.eventType,
      eventName: input.eventName,
      startedAt: input.startedAt.toISOString(),
      completedAt: input.completedAt?.toISOString() ?? null,
      durationMs: input.durationMs ?? null,
      status: input.status,
      errorCode: input.errorCode ?? null,
      safeSummary: input.safeSummary ?? null,
      createdAt: TEST_TIME,
    });
    this.auditEvents.push(record);
    return record;
  }

  private async createSalesforceApiCall(input: SalesforceApiCallCreateInput): Promise<SalesforceApiCallRecord> {
    this.required(this.audits.find((record) => record.id === input.auditId && record.auditKind === 'MCP_TOOL_CALL'), 'Audit call');
    if (this.salesforceApiCalls.some((record) => record.auditId === input.auditId && record.sequence === input.sequence)) throw conflict();
    if (input.auditEventId) {
      this.required(this.auditEvents.find((record) => record.id === input.auditEventId && record.auditId === input.auditId), 'Audit event');
    }
    const record: SalesforceApiCallRecord = Object.freeze({
      id: String(this.nextAuditDetailId++),
      publicApiCallId: input.publicApiCallId ?? randomUUID(),
      auditId: input.auditId,
      auditEventId: input.auditEventId ?? null,
      sequence: input.sequence,
      salesforceUsername: input.salesforceUsername ?? null,
      transportKind: input.transportKind,
      visibility: input.visibility,
      apiCategory: input.apiCategory,
      httpMethod: input.httpMethod ?? null,
      endpoint: input.endpoint ?? null,
      requestUrl: input.requestUrl ?? null,
      host: input.host ?? null,
      endpointPath: input.endpointPath ?? null,
      operationName: input.operationName ?? null,
      apiVersion: input.apiVersion ?? null,
      purpose: input.purpose,
      startedAt: input.startedAt.toISOString(),
      completedAt: input.completedAt?.toISOString() ?? null,
      durationMs: input.durationMs ?? null,
      httpStatus: input.httpStatus ?? null,
      result: input.result,
      salesforceErrorCode: input.salesforceErrorCode ?? null,
      salesforceErrorMessageSafe: input.salesforceErrorMessageSafe ?? null,
      requestSizeBytes: input.requestSizeBytes?.toString() ?? null,
      responseSizeBytes: input.responseSizeBytes?.toString() ?? null,
      contentType: input.contentType ?? null,
      queryType: input.queryType ?? null,
      soqlStatementSafe: input.soqlStatementSafe ?? null,
      totalSize: input.totalSize ?? null,
      returnedRecords: input.returnedRecords ?? null,
      done: input.done ?? null,
      hasNextRecords: input.hasNextRecords ?? null,
      dmlOperation: input.dmlOperation ?? null,
      objectApiName: input.objectApiName ?? null,
      recordId: input.recordId ?? null,
      requestedFields: input.requestedFields ?? null,
      managedFields: input.managedFields ?? null,
      submittedFields: input.submittedFields ?? null,
      createdAt: TEST_TIME,
    });
    this.salesforceApiCalls.push(record);
    return record;
  }

  private async createAuditPayload(input: AuditPayloadEvidenceCreateInput): Promise<AuditPayloadEvidenceRecord> {
    this.required(this.audits.find((record) => record.id === input.auditId && record.auditKind === 'MCP_TOOL_CALL'), 'Audit call');
    if (input.auditEventId) {
      this.required(this.auditEvents.find((record) => record.id === input.auditEventId && record.auditId === input.auditId), 'Audit event');
    }
    if (input.salesforceApiCallId) {
      this.required(this.salesforceApiCalls.find(
        (record) => record.id === input.salesforceApiCallId && record.auditId === input.auditId,
      ), 'Salesforce API call');
    }
    const encoded = encodeBoundedAuditPayload(input.safePayload);
    const record: AuditPayloadEvidenceRecord = Object.freeze({
      id: String(this.nextAuditDetailId++),
      auditId: input.auditId,
      salesforceApiCallId: input.salesforceApiCallId ?? null,
      auditEventId: input.auditEventId ?? null,
      payloadType: input.payloadType,
      contentType: input.contentType,
      originalSizeBytes: input.originalSizeBytes === undefined || input.originalSizeBytes === null
        ? null
        : String(input.originalSizeBytes),
      storedSizeBytes: encoded.storedSizeBytes,
      truncated: Boolean(input.truncated || encoded.truncated),
      contentSha256: input.contentSha256 ?? encoded.contentSha256,
      safePayload: encoded.safePayload,
      createdAt: TEST_TIME,
    });
    this.auditPayloads.push(record);
    return record;
  }

  private entityId(): string {
    return String(this.nextEntityId++);
  }

  private required<T>(value: T | undefined, name: string): T {
    if (value === undefined) throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', `${name} was not found.`);
    return value;
  }

  private assertVersion(actual: string, supplied: string | undefined): void {
    if (actual !== supplied) {
      throw new ControlPlaneError('MCP_ADMIN_CONCURRENT_MODIFICATION', 'Refresh and retry with the current rowVersion.');
    }
  }
}

function makePage<T>(records: readonly T[], options: ListOptions): Page<T> {
  const window = records.slice(options.offset, options.offset + options.limit + 1);
  const hasMore = window.length > options.limit;
  const items = Object.freeze(window.slice(0, options.limit));
  return Object.freeze({
    items,
    limit: options.limit,
    offset: options.offset,
    count: items.length,
    hasMore,
    nextOffset: hasMore ? options.offset + items.length : null,
  });
}

function makeTotalPage<T>(records: readonly T[], options: ListOptions): Page<T> & Readonly<{ total: number }> {
  return Object.freeze({ ...makePage(records, options), total: records.length });
}

function incrementVersion(value: string): string {
  return String(Number(value) + 1);
}

function conflict(): ControlPlaneError {
  return new ControlPlaneError('MCP_CONTROL_PLANE_CONFLICT', 'The in-memory test entity already exists.');
}
