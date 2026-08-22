import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import type { DmlAllowlistPolicy } from './allowlist.js';
import { DmlRuntimeError, extractSafeSalesforceErrors, toSalesforceDmlError } from './errors.js';
import type { CreateRecordInput, SalesforceFieldValue, UpdateRecordInput } from './schemas.js';

export class DmlExecutor {
  public constructor(
    private readonly orgService: OrgService,
    private readonly allowlist: DmlAllowlistPolicy,
  ) {}

  public async create(input: CreateRecordInput): Promise<string> {
    this.allowlist.assertAllowed(input.objectApiName, 'CREATE');
    try {
      const connection = await this.getRequestConnection();
      const result = await connection.sobject(input.objectApiName).create(copyFields(input.fields));
      if (!result.success) {
        throw new DmlRuntimeError(
          'MCP_SALESFORCE_DML_FAILED',
          'Salesforce rejected the CREATE operation. Check Salesforce permissions, field access, required values, validation rules, and automation.',
          extractSafeSalesforceErrors(result.errors),
        );
      }
      return result.id;
    } catch (error) {
      if (error instanceof DmlRuntimeError) throw error;
      throw toSalesforceDmlError(error, 'CREATE');
    }
  }

  public async update(input: UpdateRecordInput): Promise<string> {
    this.allowlist.assertAllowed(input.objectApiName, 'UPDATE');
    try {
      const connection = await this.getRequestConnection();
      const result = await connection.sobject(input.objectApiName).update({
        Id: input.recordId,
        ...copyFields(input.fields),
      });
      if (!result.success) {
        throw new DmlRuntimeError(
          'MCP_SALESFORCE_DML_FAILED',
          'Salesforce rejected the UPDATE operation. Check Salesforce permissions, field access, record access, validation rules, and automation.',
          extractSafeSalesforceErrors(result.errors),
        );
      }
      return result.id;
    } catch (error) {
      if (error instanceof DmlRuntimeError) throw error;
      throw toSalesforceDmlError(error, 'UPDATE');
    }
  }

  private async getRequestConnection(): Promise<Connection> {
    const allowedUsernames = await this.orgService.getAllowedOrgUsernames();
    if (allowedUsernames.size !== 1) {
      throw new DmlRuntimeError(
        'MCP_DML_IDENTITY_CONTEXT_INVALID',
        'P3 mutation requires exactly one request-scoped Salesforce identity.',
      );
    }
    const [username] = allowedUsernames;
    if (!username) {
      throw new DmlRuntimeError(
        'MCP_DML_IDENTITY_CONTEXT_INVALID',
        'P3 mutation could not resolve the request-scoped Salesforce identity.',
      );
    }
    return this.orgService.getConnection(username);
  }
}

function copyFields(fields: Readonly<Record<string, SalesforceFieldValue>>): Record<string, SalesforceFieldValue> {
  return { ...fields };
}
