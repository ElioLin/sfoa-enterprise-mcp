import { randomUUID } from 'node:crypto';
import {
  normalizeSalesforceUsername,
  type DiagnosticConfigRecord,
  type DmlPolicyRecord,
  type IdentityRouteRecord,
  type RuntimeSettingKey,
  type RuntimeSettingRecord,
  type ToolControlRecord,
} from './contracts.js';
import { ControlPlaneError } from './errors.js';
import type {
  ControlPlaneRepositories,
  DiagnosticConfigWriteInput,
  DmlPolicyCreateInput,
  DmlPolicyUpdateInput,
  IdentityRouteCreateInput,
  IdentityRouteUpdateInput,
  ToolControlWriteInput,
} from './repositories.js';
import type { TransactionalControlPlaneStore } from './store.js';

export type ToolEnableDecision = Readonly<{ allowed: boolean; reason?: string }>;

export class ControlPlaneAdminService {
  public constructor(
    private readonly store: TransactionalControlPlaneStore,
    private readonly canEnableTool: (toolName: string) => ToolEnableDecision,
  ) {}

  public async createIdentityRoute(input: IdentityRouteCreateInput, actorAdmin: string): Promise<IdentityRouteRecord> {
    return this.store.transaction(async (repositories) => {
      await assertUserDistinctFromDiagnostic(repositories.diagnostic.get(), input.salesforceUsername, input.enabled);
      const created = await repositories.identityRoutes.create(input);
      await appendAdminAudit(repositories, actorAdmin, 'CREATE_IDENTITY_ROUTE', created.id, {
        platformUserId: created.platformUserId,
        salesforceUsername: created.salesforceUsername,
        enabled: created.enabled,
      });
      return created;
    });
  }

  public async updateIdentityRoute(id: string, input: IdentityRouteUpdateInput, actorAdmin: string): Promise<IdentityRouteRecord> {
    return this.store.transaction(async (repositories) => {
      await assertUserDistinctFromDiagnostic(repositories.diagnostic.get(), input.salesforceUsername, input.enabled);
      const updated = await repositories.identityRoutes.update(id, input);
      await appendAdminAudit(repositories, actorAdmin, 'UPDATE_IDENTITY_ROUTE', id, {
        platformUserId: updated.platformUserId,
        salesforceUsername: updated.salesforceUsername,
        enabled: updated.enabled,
        rowVersion: updated.rowVersion,
      });
      return updated;
    });
  }

  public async disableIdentityRoute(id: string, rowVersion: string, actorAdmin: string): Promise<IdentityRouteRecord> {
    return this.store.transaction(async (repositories) => {
      const updated = await repositories.identityRoutes.disable(id, rowVersion);
      await appendAdminAudit(repositories, actorAdmin, 'DISABLE_IDENTITY_ROUTE', id, {
        platformUserId: updated.platformUserId,
        salesforceUsername: updated.salesforceUsername,
        enabled: false,
        rowVersion: updated.rowVersion,
      });
      return updated;
    });
  }

  public async updateTool(toolName: string, input: ToolControlWriteInput, actorAdmin: string): Promise<ToolControlRecord> {
    if (input.enabled) {
      const decision = this.canEnableTool(toolName);
      if (!decision.allowed) {
        throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', decision.reason ?? `Tool ${toolName} cannot be enabled.`);
      }
    }
    return this.store.transaction(async (repositories) => {
      const existing = await repositories.tools.getByName(toolName);
      if (existing && !input.rowVersion) {
        throw new ControlPlaneError(
          'MCP_ADMIN_CONCURRENT_MODIFICATION',
          'The Tool control now exists. Refresh and retry with its current rowVersion.',
        );
      }
      const updated = existing
        ? await repositories.tools.update(toolName, input)
        : await repositories.tools.createIfAbsent(toolName, input.enabled, input.remark);
      await appendAdminAudit(repositories, actorAdmin, 'UPDATE_TOOL_CONTROL', updated.id, {
        toolName,
        enabled: updated.enabled,
        rowVersion: updated.rowVersion,
      });
      return updated;
    });
  }

  public async createDmlPolicy(input: DmlPolicyCreateInput, actorAdmin: string): Promise<DmlPolicyRecord> {
    assertMeaningfulDml(input);
    return this.store.transaction(async (repositories) => {
      const created = await repositories.dmlPolicies.create(input);
      await appendAdminAudit(repositories, actorAdmin, 'CREATE_DML_POLICY', created.id, safeDmlSummary(created));
      return created;
    });
  }

  public async updateDmlPolicy(id: string, input: DmlPolicyUpdateInput, actorAdmin: string): Promise<DmlPolicyRecord> {
    assertMeaningfulDml(input);
    return this.store.transaction(async (repositories) => {
      const updated = await repositories.dmlPolicies.update(id, input);
      await appendAdminAudit(repositories, actorAdmin, 'UPDATE_DML_POLICY', id, safeDmlSummary(updated));
      return updated;
    });
  }

  public async disableDmlPolicy(id: string, rowVersion: string, actorAdmin: string): Promise<DmlPolicyRecord> {
    return this.store.transaction(async (repositories) => {
      const updated = await repositories.dmlPolicies.disable(id, rowVersion);
      await appendAdminAudit(repositories, actorAdmin, 'DISABLE_DML_POLICY', id, safeDmlSummary(updated));
      return updated;
    });
  }

  public async updateDiagnostic(input: DiagnosticConfigWriteInput, actorAdmin: string): Promise<DiagnosticConfigRecord> {
    if (Boolean(input.testMetadataType) !== Boolean(input.testMetadataFullName)) {
      throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', 'Diagnostic metadata type and fullName must both be supplied or both omitted.');
    }
    return this.store.transaction(async (repositories) => {
      if (input.enabled) {
        const active = await repositories.identityRoutes.listActiveSalesforceUsernames();
        if (active.some((username) => normalizeSalesforceUsername(username) === normalizeSalesforceUsername(input.salesforceUsername))) {
          throw new ControlPlaneError('MCP_CONTROL_PLANE_CONFLICT', 'Diagnostic Salesforce username must differ from every active USER route.');
        }
      }
      const updated = await repositories.diagnostic.upsert(input);
      await appendAdminAudit(repositories, actorAdmin, 'UPDATE_DIAGNOSTIC_CONFIG', updated.id, {
        salesforceUsername: updated.salesforceUsername,
        enabled: updated.enabled,
        testMetadataType: updated.testMetadataType,
        testMetadataFullName: updated.testMetadataFullName,
        rowVersion: updated.rowVersion,
      });
      return updated;
    });
  }

  public async recordDiagnosticVerification(
    input: Readonly<{
      rowVersion: string;
      status: 'PASS' | 'FAIL' | 'NOT_TESTED';
      errorCode: string | null;
      errorMessageSafe: string | null;
      evidenceSummary: unknown;
    }>,
    actorAdmin: string,
  ): Promise<DiagnosticConfigRecord> {
    return this.store.transaction(async (repositories) => {
      const updated = await repositories.diagnostic.recordVerification(input);
      await appendAdminAudit(repositories, actorAdmin, 'VERIFY_DIAGNOSTIC_CONFIG', updated.id, {
        verificationStatus: input.status,
        errorCode: input.errorCode,
        evidence: input.evidenceSummary,
        rowVersion: updated.rowVersion,
      });
      return updated;
    });
  }

  public async updateRuntimeSetting(
    key: RuntimeSettingKey,
    value: unknown,
    rowVersion: string | undefined,
    actorAdmin: string,
  ): Promise<RuntimeSettingRecord> {
    assertRuntimeSettingValue(key, value);
    return this.store.transaction(async (repositories) => {
      const updated = await repositories.runtimeSettings.upsert(key, value, rowVersion);
      await appendAdminAudit(repositories, actorAdmin, 'UPDATE_RUNTIME_SETTING', key, {
        settingKey: key,
        settingValue: value,
        rowVersion: updated.rowVersion,
      });
      return updated;
    });
  }
}

async function assertUserDistinctFromDiagnostic(
  diagnosticPromise: Promise<DiagnosticConfigRecord | undefined>,
  username: string,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  const diagnostic = await diagnosticPromise;
  if (diagnostic?.enabled && normalizeSalesforceUsername(diagnostic.salesforceUsername) === normalizeSalesforceUsername(username)) {
    throw new ControlPlaneError('MCP_CONTROL_PLANE_CONFLICT', 'Active USER route cannot use the enabled Diagnostic Salesforce username.');
  }
}

async function appendAdminAudit(
  repositories: ControlPlaneRepositories,
  actorAdmin: string,
  operation: string,
  recordId: string,
  summary: unknown,
): Promise<void> {
  try {
    await repositories.audits.append({
      occurredAt: new Date(),
      correlationId: randomUUID(),
      channel: 'ADMIN',
      actorAdmin,
      operation,
      recordId,
      result: 'PASS',
      outcome: 'SUCCESS',
      requestSummary: summary,
    });
  } catch (error) {
    throw new ControlPlaneError(
      'MCP_ADMIN_AUDIT_FAILED',
      'The configuration change was rolled back because its Admin audit record could not be persisted.',
      { cause: error },
    );
  }
}

function assertMeaningfulDml(input: Pick<DmlPolicyCreateInput, 'allowCreate' | 'allowUpdate' | 'enabled'>): void {
  if (input.enabled && !input.allowCreate && !input.allowUpdate) {
    throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', 'An enabled DML policy must allow CREATE, UPDATE, or both.');
  }
}

function safeDmlSummary(record: DmlPolicyRecord): unknown {
  return {
    objectApiName: record.objectApiName,
    allowCreate: record.allowCreate,
    allowUpdate: record.allowUpdate,
    enabled: record.enabled,
    rowVersion: record.rowVersion,
  };
}

function assertRuntimeSettingValue(key: RuntimeSettingKey, value: unknown): void {
  if (key === 'auditRetentionDays' && (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 3650)) {
    throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', 'auditRetentionDays must be an integer from 1 to 3650.');
  }
  if (key === 'adminDefaultPageSize' && (!Number.isInteger(value) || Number(value) < 10 || Number(value) > 100)) {
    throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', 'adminDefaultPageSize must be an integer from 10 to 100.');
  }
}
