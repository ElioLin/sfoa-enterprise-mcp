import { randomUUID } from 'node:crypto';
import {
  fieldApiNameSchema,
  normalizeSalesforceUsername,
  objectApiNameSchema,
  type DiagnosticConfigRecord,
  type DmlPolicyRecord,
  type IdentityCredentialRecord,
  type IdentityRouteRecord,
  type ManagedDmlFieldRuleRecord,
  type RuntimeSettingKey,
  type RuntimeSettingRecord,
  type ToolControlRecord,
} from './contracts.js';
import { ControlPlaneError } from './errors.js';
import { IdentityCredentialCipher } from './identity-credential.js';
import type {
  ControlPlaneRepositories,
  DiagnosticConfigWriteInput,
  DmlPolicyCreateInput,
  DmlPolicyUpdateInput,
  IdentityRouteCreateInput,
  IdentityRouteUpdateInput,
  ManagedDmlFieldRuleCreateInput,
  ManagedDmlFieldRuleUpdateInput,
  ToolControlWriteInput,
} from './repositories.js';
import type { TransactionalControlPlaneStore } from './store.js';

export type ToolEnableDecision = Readonly<{ allowed: boolean; reason?: string }>;
export type IdentityCredentialAccess = Readonly<{
  route: IdentityRouteRecord;
  credential: IdentityCredentialRecord;
  token: string;
}>;
export type IdentityCredentialRead = Readonly<{
  route: IdentityRouteRecord;
  credential: IdentityCredentialRecord | null;
  token: string | null;
}>;
export type IdentityRouteCreation = IdentityCredentialAccess;
export type IdentityCredentialRegenerateInput = Readonly<{
  credentialId: string | null;
  credentialRowVersion: string | null;
  routeRowVersion: string;
}>;

export class ControlPlaneAdminService {
  public constructor(
    private readonly store: TransactionalControlPlaneStore,
    private readonly canEnableTool: (toolName: string) => ToolEnableDecision,
    private readonly credentialCipher: IdentityCredentialCipher,
  ) {}

  public async createIdentityRoute(input: IdentityRouteCreateInput, actorAdmin: string): Promise<IdentityRouteCreation> {
    return this.store.transaction(async (repositories) => {
      await assertUserDistinctFromDiagnostic(repositories.diagnostic.get(), input.salesforceUsername, input.enabled);
      const created = await repositories.identityRoutes.create(input);
      const generated = this.credentialCipher.generate(created.id);
      const credential = await repositories.identityCredentials.create({
        identityRouteId: created.id,
        credentialType: 'USER_BOUND',
        tokenHash: generated.tokenHash,
        tokenCiphertext: generated.tokenCiphertext,
        tokenLast4: generated.tokenLast4,
        generatedAt: generated.generatedAt,
      });
      await appendAdminAudit(repositories, actorAdmin, 'CREATE_IDENTITY_ROUTE', created.id, {
        platformUserId: created.platformUserId,
        salesforceUsername: created.salesforceUsername,
        enabled: created.enabled,
        credentialCreated: true,
        credentialId: credential.id,
        tokenLast4: credential.tokenLast4,
      }, {
        platformUserId: created.platformUserId,
        salesforceUsername: created.salesforceUsername,
        identityCredentialId: credential.id,
      });
      return Object.freeze({ route: created, credential, token: generated.token });
    });
  }

  public async updateIdentityRoute(id: string, input: IdentityRouteUpdateInput, actorAdmin: string): Promise<IdentityRouteRecord> {
    return this.store.transaction(async (repositories) => {
      await assertUserDistinctFromDiagnostic(repositories.diagnostic.get(), input.salesforceUsername, input.enabled);
      const current = await repositories.identityRoutes.getById(id);
      if (!current) throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', 'Identity route was not found.');
      const updated = await repositories.identityRoutes.update(id, input);
      const operation = !current.enabled && updated.enabled
        ? 'ENABLE_IDENTITY_ROUTE'
        : current.enabled && !updated.enabled ? 'DISABLE_IDENTITY_ROUTE' : 'UPDATE_IDENTITY_ROUTE';
      await appendAdminAudit(repositories, actorAdmin, operation, id, {
        platformUserId: updated.platformUserId,
        salesforceUsername: updated.salesforceUsername,
        enabled: updated.enabled,
        rowVersion: updated.rowVersion,
      }, {
        platformUserId: updated.platformUserId,
        salesforceUsername: updated.salesforceUsername,
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
      }, {
        platformUserId: updated.platformUserId,
        salesforceUsername: updated.salesforceUsername,
      });
      return updated;
    });
  }

  public async readIdentityCredential(identityRouteId: string): Promise<IdentityCredentialRead> {
    return this.store.transaction(async (repositories) => {
      const route = await repositories.identityRoutes.getById(identityRouteId);
      if (!route) throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', 'Identity route was not found.');
      const credential = await repositories.identityCredentials.getActiveByRouteId(identityRouteId);
      if (!credential) return Object.freeze({ route, credential: null, token: null });
      return Object.freeze({ route, credential, token: this.credentialCipher.decrypt(credential) });
    });
  }

  public async regenerateIdentityCredential(
    identityRouteId: string,
    input: IdentityCredentialRegenerateInput,
    actorAdmin: string,
  ): Promise<IdentityCredentialAccess> {
    return this.store.transaction(async (repositories) => {
      const route = await repositories.identityRoutes.getById(identityRouteId);
      if (!route) throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', 'Identity route was not found.');
      assertVersion(route.rowVersion, input.routeRowVersion);
      const current = await repositories.identityCredentials.getActiveByRouteId(identityRouteId);
      if (current) {
        if (input.credentialId !== current.id || input.credentialRowVersion !== current.rowVersion) {
          throw concurrentModification();
        }
        await repositories.identityCredentials.revoke(current.id, current.rowVersion, new Date());
      } else if (input.credentialId !== null || input.credentialRowVersion !== null) {
        throw concurrentModification();
      }
      const generated = this.credentialCipher.generate(identityRouteId);
      const credential = await repositories.identityCredentials.create({
        identityRouteId,
        credentialType: 'USER_BOUND',
        tokenHash: generated.tokenHash,
        tokenCiphertext: generated.tokenCiphertext,
        tokenLast4: generated.tokenLast4,
        generatedAt: generated.generatedAt,
      });
      await appendAdminAudit(repositories, actorAdmin, 'REGENERATE_USER_BOUND_CREDENTIAL', identityRouteId, {
        routeId: identityRouteId,
        previousCredentialId: current?.id ?? null,
        credentialId: credential.id,
        tokenLast4: credential.tokenLast4,
      }, {
        platformUserId: route.platformUserId,
        salesforceUsername: route.salesforceUsername,
        identityCredentialId: credential.id,
      });
      return Object.freeze({ route, credential, token: generated.token });
    });
  }

  public async deleteIdentityRoute(id: string, rowVersion: string, actorAdmin: string): Promise<void> {
    await this.store.transaction(async (repositories) => {
      const route = await repositories.identityRoutes.getById(id);
      if (!route) throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', 'Identity route was not found.');
      assertVersion(route.rowVersion, rowVersion);
      if (route.enabled) {
        throw new ControlPlaneError(
          'MCP_IDENTITY_ROUTE_DELETE_REQUIRES_DISABLED',
          'Identity route must be disabled before permanent deletion.',
        );
      }
      const credentials = await repositories.identityCredentials.listByRouteId(id);
      const active = credentials.find((credential) => credential.status === 'ACTIVE');
      if (active) await repositories.identityCredentials.revoke(active.id, active.rowVersion, new Date());
      await repositories.identityCredentials.deleteByRouteId(id);
      await repositories.identityRoutes.delete(id, rowVersion);
      await appendAdminAudit(repositories, actorAdmin, 'DELETE_IDENTITY_ROUTE', id, {
        routeId: id,
        platformUserId: route.platformUserId,
        salesforceUsername: route.salesforceUsername,
        credentialIds: credentials.map((credential) => credential.id),
      }, {
        platformUserId: route.platformUserId,
        salesforceUsername: route.salesforceUsername,
        ...(active ? { identityCredentialId: active.id } : {}),
      });
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
      if (input.enabled) {
        const enabledRules = await repositories.managedDmlFieldRules.listEnabledByDmlPolicyIds([id]);
        for (const rule of enabledRules) assertManagedRuleOperations(input, rule);
      }
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

  public async createManagedDmlFieldRule(
    dmlPolicyId: string,
    input: Omit<ManagedDmlFieldRuleCreateInput, 'dmlPolicyId'>,
    actorAdmin: string,
  ): Promise<ManagedDmlFieldRuleRecord> {
    return this.store.transaction(async (repositories) => {
        const policy = await repositories.dmlPolicies.getById(dmlPolicyId);
        if (!policy) throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', 'DML policy was not found.');
        assertManagedDmlFieldRule(input);
        assertManagedRuleOperations(policy, input);
        await assertManagedTargetIsUnique(repositories, dmlPolicyId, input.targetFieldApiName);
        const created = await repositories.managedDmlFieldRules.create({ ...input, dmlPolicyId });
      await appendAdminAudit(
        repositories,
        actorAdmin,
        'CREATE_DML_MANAGED_FIELD_RULE',
        created.id,
        safeManagedDmlFieldSummary(created, policy.objectApiName),
      );
      return created;
    });
  }

  public async updateManagedDmlFieldRule(
    dmlPolicyId: string,
    id: string,
    input: ManagedDmlFieldRuleUpdateInput,
    actorAdmin: string,
  ): Promise<ManagedDmlFieldRuleRecord> {
    return this.store.transaction(async (repositories) => {
      const [policy, current] = await Promise.all([
        repositories.dmlPolicies.getById(dmlPolicyId),
        repositories.managedDmlFieldRules.getById(id),
      ]);
      if (!policy || !current || current.dmlPolicyId !== dmlPolicyId) {
        throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', 'Managed DML field rule was not found for this policy.');
        }
        assertManagedDmlFieldRule(input);
        assertManagedRuleOperations(policy, input);
        await assertManagedTargetIsUnique(repositories, dmlPolicyId, input.targetFieldApiName, id);
        const updated = await repositories.managedDmlFieldRules.update(id, input);
      await appendAdminAudit(
        repositories,
        actorAdmin,
        'UPDATE_DML_MANAGED_FIELD_RULE',
        id,
        safeManagedDmlFieldSummary(updated, policy.objectApiName),
      );
      return updated;
    });
  }

  public async disableManagedDmlFieldRule(
    dmlPolicyId: string,
    id: string,
    rowVersion: string,
    actorAdmin: string,
  ): Promise<ManagedDmlFieldRuleRecord> {
    return this.store.transaction(async (repositories) => {
      const [policy, current] = await Promise.all([
        repositories.dmlPolicies.getById(dmlPolicyId),
        repositories.managedDmlFieldRules.getById(id),
      ]);
      if (!policy || !current || current.dmlPolicyId !== dmlPolicyId) {
        throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', 'Managed DML field rule was not found for this policy.');
      }
      const updated = await repositories.managedDmlFieldRules.disable(id, rowVersion);
      await appendAdminAudit(
        repositories,
        actorAdmin,
        'DISABLE_DML_MANAGED_FIELD_RULE',
        id,
        safeManagedDmlFieldSummary(updated, policy.objectApiName),
      );
      return updated;
    });
  }

  public async deleteManagedDmlFieldRule(
    dmlPolicyId: string,
    id: string,
    rowVersion: string,
    actorAdmin: string,
  ): Promise<void> {
    await this.store.transaction(async (repositories) => {
      const [policy, current] = await Promise.all([
        repositories.dmlPolicies.getById(dmlPolicyId),
        repositories.managedDmlFieldRules.getById(id),
      ]);
      if (!policy || !current || current.dmlPolicyId !== dmlPolicyId) {
        throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', 'Managed DML field rule was not found for this policy.');
      }
      if (current.enabled) {
        throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', 'Disable the managed field rule before permanent deletion.');
      }
      await repositories.managedDmlFieldRules.delete(id, rowVersion);
      await appendAdminAudit(
        repositories,
        actorAdmin,
        'DELETE_DML_MANAGED_FIELD_RULE',
        id,
        safeManagedDmlFieldSummary(current, policy.objectApiName),
      );
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
  context: Readonly<{
    platformUserId?: string;
    salesforceUsername?: string;
    identityCredentialId?: string;
  }> = {},
): Promise<void> {
  try {
    await repositories.audits.append({
      occurredAt: new Date(),
      correlationId: randomUUID(),
      channel: 'ADMIN',
      actorAdmin,
      ...(context.platformUserId ? { platformUserId: context.platformUserId } : {}),
      ...(context.salesforceUsername ? { salesforceUsername: context.salesforceUsername } : {}),
      ...(context.identityCredentialId ? { identityCredentialId: context.identityCredentialId } : {}),
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

function assertVersion(actual: string, expected: string): void {
  if (actual !== expected) throw concurrentModification();
}

function concurrentModification(): ControlPlaneError {
  return new ControlPlaneError(
    'MCP_ADMIN_CONCURRENT_MODIFICATION',
    'The configuration changed since it was loaded. Refresh and retry with the current rowVersion.',
  );
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

function assertManagedDmlFieldRule(
  input: Pick<ManagedDmlFieldRuleCreateInput,
    | 'targetFieldApiName'
    | 'strategy'
    | 'applyOnCreate'
    | 'applyOnUpdate'
    | 'lookupObjectApiName'
    | 'lookupMatchFieldApiName'>,
): void {
  if (!fieldApiNameSchema.safeParse(input.targetFieldApiName).success) {
    throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', 'Managed target field API name is invalid.');
  }
  if (!input.applyOnCreate && !input.applyOnUpdate) {
    throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', 'A managed field rule must apply on CREATE, UPDATE, or both.');
  }
  if (input.strategy === 'PLATFORM_USER_LOOKUP') {
    if (!input.lookupObjectApiName || !objectApiNameSchema.safeParse(input.lookupObjectApiName).success
      || !input.lookupMatchFieldApiName || !fieldApiNameSchema.safeParse(input.lookupMatchFieldApiName).success) {
      throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', 'Platform-user lookup rules require valid lookup object and match field API names.');
    }
    return;
  }
  if (!input.applyOnCreate || input.applyOnUpdate || input.lookupObjectApiName !== null || input.lookupMatchFieldApiName !== null) {
    throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', 'AI-created marker rules apply on CREATE only and do not accept lookup configuration.');
  }
}

function assertManagedRuleOperations(
  policy: Pick<DmlPolicyRecord, 'allowCreate' | 'allowUpdate'>,
  rule: Pick<ManagedDmlFieldRuleCreateInput, 'applyOnCreate' | 'applyOnUpdate'>,
): void {
  if ((rule.applyOnCreate && !policy.allowCreate) || (rule.applyOnUpdate && !policy.allowUpdate)) {
    throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', 'Managed field rule operations must be enabled by the parent DML policy.');
  }
}

async function assertManagedTargetIsUnique(
  repositories: ControlPlaneRepositories,
  dmlPolicyId: string,
  targetFieldApiName: string,
  excludedRuleId?: string,
): Promise<void> {
  const normalizedTarget = targetFieldApiName.toLocaleLowerCase('en-US');
  let offset = 0;
  do {
    const page = await repositories.managedDmlFieldRules.listByDmlPolicyId(dmlPolicyId, { limit: 100, offset });
    if (page.items.some((rule) => rule.id !== excludedRuleId
      && rule.targetFieldApiName.toLocaleLowerCase('en-US') === normalizedTarget)) {
      throw new ControlPlaneError('MCP_CONTROL_PLANE_CONFLICT', '该字段已配置 MCP 托管规则。');
    }
    if (!page.hasMore || page.nextOffset === null) return;
    offset = page.nextOffset;
  } while (true);
}

function safeManagedDmlFieldSummary(record: ManagedDmlFieldRuleRecord, objectApiName: string): unknown {
  return {
    objectApiName,
    targetFieldApiName: record.targetFieldApiName,
    strategy: record.strategy,
    applyOnCreate: record.applyOnCreate,
    applyOnUpdate: record.applyOnUpdate,
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
