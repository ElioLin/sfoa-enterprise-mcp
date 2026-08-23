import {
  ControlPlaneError,
  type AuditRecord,
  type DiagnosticConfigRecord,
  type DmlPolicyRecord,
  type IdentityRouteRecord,
  type Page,
  type RuntimeSettingKey,
  type RuntimeSettingRecord,
  type ToolControlRecord,
} from '../index.js';
import type {
  AuditWrite,
  ControlPlaneRepositories,
  DiagnosticConfigWriteInput,
  DmlPolicyCreateInput,
  DmlPolicyUpdateInput,
  IdentityRouteCreateInput,
  IdentityRouteUpdateInput,
  ListOptions,
  ToolControlWriteInput,
} from '../repositories.js';
import type { TransactionalControlPlaneStore } from '../store.js';

const TEST_TIME = '2026-01-01T00:00:00.000Z';

export class InMemoryControlPlaneStore implements TransactionalControlPlaneStore {
  private routes = new Map<string, IdentityRouteRecord>();
  private tools = new Map<string, ToolControlRecord>();
  private dmlPolicies = new Map<string, DmlPolicyRecord>();
  private diagnostic: DiagnosticConfigRecord | undefined;
  private settings = new Map<RuntimeSettingKey, RuntimeSettingRecord>();
  private audits: AuditRecord[] = [];
  private nextEntityId = 1;
  private nextAuditId = 1;
  private failAudit = false;

  public readonly repositories: ControlPlaneRepositories;

  public constructor() {
    this.repositories = Object.freeze({
      identityRoutes: {
        list: async (options) => makePage([...this.routes.values()].sort((a, b) => a.platformUserId.localeCompare(b.platformUserId)), options),
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
    });
  }

  public setAuditFailure(value: boolean): void {
    this.failAudit = value;
  }

  public async transaction<T>(work: (repositories: ControlPlaneRepositories) => Promise<T>): Promise<T> {
    const snapshot = {
      routes: new Map(this.routes),
      tools: new Map(this.tools),
      dmlPolicies: new Map(this.dmlPolicies),
      diagnostic: this.diagnostic,
      settings: new Map(this.settings),
      audits: [...this.audits],
      nextEntityId: this.nextEntityId,
      nextAuditId: this.nextAuditId,
    };
    try {
      return await work(this.repositories);
    } catch (error) {
      this.routes = snapshot.routes;
      this.tools = snapshot.tools;
      this.dmlPolicies = snapshot.dmlPolicies;
      this.diagnostic = snapshot.diagnostic;
      this.settings = snapshot.settings;
      this.audits = snapshot.audits;
      this.nextEntityId = snapshot.nextEntityId;
      this.nextAuditId = snapshot.nextAuditId;
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
    const record = Object.freeze({
      id: String(this.nextAuditId++),
      occurredAt: event.occurredAt.toISOString(),
      correlationId: event.correlationId,
      channel: event.channel,
      clientId: event.clientId ?? null,
      actorAdmin: event.actorAdmin ?? null,
      platformUserId: event.platformUserId ?? null,
      salesforceUsername: event.salesforceUsername ?? null,
      executionRole: event.executionRole ?? null,
      toolName: event.toolName ?? null,
      operation: event.operation ?? null,
      objectApiName: event.objectApiName ?? null,
      recordId: event.recordId ?? null,
      result: event.result,
      outcome: event.outcome ?? null,
      errorCode: event.errorCode ?? null,
      durationMs: event.durationMs ?? null,
      requestSummary: event.requestSummary ?? null,
      responseSummary: event.responseSummary ?? null,
      createdAt: TEST_TIME,
    });
    this.audits.push(record);
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

function incrementVersion(value: string): string {
  return String(Number(value) + 1);
}

function conflict(): ControlPlaneError {
  return new ControlPlaneError('MCP_CONTROL_PLANE_CONFLICT', 'The in-memory test entity already exists.');
}
