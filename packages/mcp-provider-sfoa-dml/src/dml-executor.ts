import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import type { DmlAllowlistPolicy } from './allowlist.js';
import { DmlRuntimeError, extractSafeSalesforceErrors, toSalesforceDmlError } from './errors.js';
import type { CreateRecordInput, SalesforceFieldValue, UpdateRecordInput } from './schemas.js';

export type MutationExecutionObserver = Readonly<{
  onMutationStarted(operation: 'CREATE' | 'UPDATE'): void;
  runWithSubmittedFields?<T>(
    fields: Readonly<Record<string, SalesforceFieldValue>>,
    callback: () => Promise<T>,
  ): Promise<T>;
  onMutationCompleted?(operation: 'CREATE' | 'UPDATE', recordId: string): void;
}>;

export class DmlExecutor {
  public constructor(
    private readonly orgService: OrgService,
    private readonly allowlist: DmlAllowlistPolicy,
    private readonly mutationObserver?: MutationExecutionObserver,
  ) {}

  public async create(input: CreateRecordInput): Promise<string> {
    this.allowlist.assertAllowed(input.objectApiName, 'CREATE');
    try {
      const connection = await this.getRequestConnection();
      const sobject = connection.sobject(input.objectApiName);
      // The Host observes this exact pre-dispatch boundary; local gates above remain NOT_STARTED.
      this.mutationObserver?.onMutationStarted('CREATE');
      const submittedFields = copyFields(input.fields);
      // A top-level recordTypeId is authoritative: fold it into the payload as the
      // canonical RecordTypeId field (case-insensitive duplicates are schema-rejected
      // as a conflict) so the record is always created under the context-analyzed type.
      if (input.recordTypeId) {
        const duplicateKey = Object.keys(submittedFields)
          .find((name) => name.toLocaleLowerCase('en-US') === 'recordtypeid');
        if (duplicateKey !== undefined) delete submittedFields[duplicateKey];
        submittedFields.RecordTypeId = input.recordTypeId;
      }
      const dispatch = async () => await sobject.create(submittedFields);
      const result = this.mutationObserver?.runWithSubmittedFields
        ? await this.mutationObserver.runWithSubmittedFields(submittedFields, dispatch)
        : await dispatch();
      if (!result.success) {
        throw new DmlRuntimeError(
          'MCP_SALESFORCE_DML_FAILED',
          'Salesforce rejected the CREATE operation. Check Salesforce permissions, field access, required values, validation rules, and automation.',
          extractSafeSalesforceErrors(result.errors),
        );
      }
      this.mutationObserver?.onMutationCompleted?.('CREATE', result.id);
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
      const sobject = connection.sobject(input.objectApiName);
      // The Host observes this exact pre-dispatch boundary; local gates above remain NOT_STARTED.
      this.mutationObserver?.onMutationStarted('UPDATE');
      const submittedFields = copyFields(input.fields);
      const dispatch = async () => await sobject.update({
        Id: input.recordId,
        ...submittedFields,
      });
      const result = this.mutationObserver?.runWithSubmittedFields
        ? await this.mutationObserver.runWithSubmittedFields(submittedFields, dispatch)
        : await dispatch();
      if (!result.success) {
        throw new DmlRuntimeError(
          'MCP_SALESFORCE_DML_FAILED',
          'Salesforce rejected the UPDATE operation. Check Salesforce permissions, field access, record access, validation rules, and automation.',
          extractSafeSalesforceErrors(result.errors),
        );
      }
      this.mutationObserver?.onMutationCompleted?.('UPDATE', result.id);
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
