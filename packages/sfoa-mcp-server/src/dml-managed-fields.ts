import {
  runWithSalesforceApiPurpose,
  runWithSalesforceQuerySemantic,
  type SalesforceConnectionProvider,
} from '@sfoa/identity-runtime';
import {
  fieldApiNameSchema,
  objectApiNameSchema,
  platformUserIdSchema,
  type ManagedDmlFieldRuleRecord,
} from '@sfoa/control-plane';
import type { DmlOperation } from '@sfoa/mcp-provider-sfoa-dml';
import type { RequestContext } from '@sfoa/identity-runtime';
import { RemoteRuntimeError } from './errors.js';

export type RuntimeManagedDmlFieldRule = Readonly<ManagedDmlFieldRuleRecord & {
  objectApiName: string;
}>;

export type AppliedManagedDmlField = Readonly<{
  fieldApiName: string;
  strategy: ManagedDmlFieldRuleRecord['strategy'];
  agentValueOverridden: boolean;
}>;

export type ManagedDmlInputResolution = Readonly<{
  input: Readonly<Record<string, unknown>>;
  applied: readonly AppliedManagedDmlField[];
}>;

export class ManagedDmlFieldResolver {
  public constructor(
    private readonly connectionProvider: SalesforceConnectionProvider,
    private readonly context: RequestContext,
    private readonly rules: readonly RuntimeManagedDmlFieldRule[],
  ) {}

  public async resolve(
    operation: DmlOperation,
    input: Readonly<Record<string, unknown>>,
  ): Promise<ManagedDmlInputResolution> {
    if (typeof input.objectApiName !== 'string' || !isRecord(input.fields)) {
      return Object.freeze({ input, applied: Object.freeze([]) });
    }
    const normalizedObject = input.objectApiName.toLocaleLowerCase('en-US');
    const candidates = this.rules.filter((rule) => rule.enabled
      && rule.objectApiName.toLocaleLowerCase('en-US') === normalizedObject);
    for (const rule of candidates) assertValidRule(rule);
    const applicable = candidates.filter((rule) =>
      operation === 'CREATE' ? rule.applyOnCreate : rule.applyOnUpdate);
    if (applicable.length === 0) return Object.freeze({ input, applied: Object.freeze([]) });

    const fields: Record<string, unknown> = { ...input.fields };
    const applied: AppliedManagedDmlField[] = [];
    const targets = new Set<string>();
    for (const rule of applicable) {
      const normalizedTarget = rule.targetFieldApiName.toLocaleLowerCase('en-US');
      if (targets.has(normalizedTarget)) throw invalidConfig('Managed field rules contain a duplicate target field.');
      targets.add(normalizedTarget);
      const agentFieldName = Object.keys(fields).find((fieldName) =>
        fieldName.toLocaleLowerCase('en-US') === normalizedTarget);
      const agentValueOverridden = agentFieldName !== undefined;
      if (agentFieldName && agentFieldName !== rule.targetFieldApiName) delete fields[agentFieldName];
      fields[rule.targetFieldApiName] = rule.strategy === 'AI_CREATED_MARKER'
        ? true
        : await this.resolvePlatformUserLookup(rule);
      applied.push(Object.freeze({
        fieldApiName: rule.targetFieldApiName,
        strategy: rule.strategy,
        agentValueOverridden,
      }));
    }
    return Object.freeze({
      input: Object.freeze({ ...input, fields: Object.freeze(fields) }),
      applied: Object.freeze(applied),
    });
  }

  private async resolvePlatformUserLookup(rule: RuntimeManagedDmlFieldRule): Promise<string> {
    const platformUserId = platformUserIdSchema.safeParse(this.context.platformUserId);
    if (!platformUserId.success || !rule.lookupObjectApiName || !rule.lookupMatchFieldApiName) {
      throw invalidConfig('Platform-user lookup configuration is invalid.');
    }
    const soql = `SELECT Id FROM ${rule.lookupObjectApiName} WHERE ${rule.lookupMatchFieldApiName} = '${escapeSoqlString(platformUserId.data)}' LIMIT 2`;
    let response: unknown;
    try {
      const connection = await this.connectionProvider.getConnection();
      response = await runWithSalesforceApiPurpose('SERVER_MANAGED_LOOKUP', () =>
        runWithSalesforceQuerySemantic({ queryType: 'DATA_SOQL', soqlStatement: soql }, async () =>
          await connection.query(soql)));
    } catch (error) {
      throw new RemoteRuntimeError(
        'MCP_DML_MANAGED_LOOKUP_FAILED',
        `MCP could not resolve the trusted platform identity for managed field ${rule.targetFieldApiName}.`,
        { cause: error, correlationId: this.context.correlationId },
      );
    }
    const records = isRecord(response) && Array.isArray(response.records) ? response.records : undefined;
    if (!records) {
      throw new RemoteRuntimeError(
        'MCP_DML_MANAGED_LOOKUP_FAILED',
        `MCP received an invalid lookup response for managed field ${rule.targetFieldApiName}.`,
        { correlationId: this.context.correlationId },
      );
    }
    if (records.length === 0) {
      throw new RemoteRuntimeError(
        'MCP_DML_MANAGED_LOOKUP_NOT_FOUND',
        `No Salesforce lookup record matches the trusted platform identity for managed field ${rule.targetFieldApiName}.`,
        { correlationId: this.context.correlationId },
      );
    }
    if (records.length >= 2) {
      throw new RemoteRuntimeError(
        'MCP_DML_MANAGED_LOOKUP_AMBIGUOUS',
        `Multiple Salesforce lookup records match the trusted platform identity for managed field ${rule.targetFieldApiName}.`,
        { correlationId: this.context.correlationId },
      );
    }
    const first = records[0];
    const id = isRecord(first) && typeof first.Id === 'string' ? first.Id : undefined;
    if (!id || !/^(?:[A-Za-z0-9]{15}|[A-Za-z0-9]{18})$/u.test(id)) {
      throw new RemoteRuntimeError(
        'MCP_DML_MANAGED_LOOKUP_FAILED',
        `MCP received an invalid record identifier for managed field ${rule.targetFieldApiName}.`,
        { correlationId: this.context.correlationId },
      );
    }
    return id;
  }
}

function assertValidRule(rule: RuntimeManagedDmlFieldRule): void {
  if (!objectApiNameSchema.safeParse(rule.objectApiName).success
    || !fieldApiNameSchema.safeParse(rule.targetFieldApiName).success
    || (!rule.applyOnCreate && !rule.applyOnUpdate)) {
    throw invalidConfig('Managed field rule contains an invalid Salesforce identifier or operation scope.');
  }
  if (rule.strategy === 'PLATFORM_USER_LOOKUP') {
    if (!rule.lookupObjectApiName || !objectApiNameSchema.safeParse(rule.lookupObjectApiName).success
      || !rule.lookupMatchFieldApiName || !fieldApiNameSchema.safeParse(rule.lookupMatchFieldApiName).success) {
      throw invalidConfig('Platform-user lookup rule is missing a valid lookup object or match field.');
    }
    return;
  }
  if (rule.strategy !== 'AI_CREATED_MARKER'
    || !rule.applyOnCreate
    || rule.applyOnUpdate
    || rule.lookupObjectApiName !== null
    || rule.lookupMatchFieldApiName !== null) {
    throw invalidConfig('AI-created marker rule must apply on CREATE only and cannot contain lookup configuration.');
  }
}

function invalidConfig(message: string): RemoteRuntimeError {
  return new RemoteRuntimeError('MCP_DML_MANAGED_FIELD_CONFIG_INVALID', message);
}

function escapeSoqlString(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
