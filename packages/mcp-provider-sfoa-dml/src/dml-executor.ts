import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import type { DmlAllowlistPolicy } from './allowlist.js';
import { DmlRuntimeError, extractSafeSalesforceErrors, toSalesforceDmlError } from './errors.js';
import type { CreateRecordInput, SalesforceFieldValue, UpdateRecordInput } from './schemas.js';
import { createRecordsInputSchema, updateRecordsInputSchema, recordIdSchema,
  BATCH_DUPLICATE_RECORD_ID_CODE, duplicateBatchRecordIds,
  type CreateRecordsInput, type UpdateRecordsInput, type BatchDmlOutput } from './schemas.js';

export type MutationExecutionObserver = Readonly<{
  onMutationStarted(operation: 'CREATE' | 'UPDATE'): void;
  runWithSubmittedFields?<T>(
    fields: Readonly<Record<string, SalesforceFieldValue>>,
    callback: () => Promise<T>,
  ): Promise<T>;
  onMutationCompleted?(operation: 'CREATE' | 'UPDATE', recordId: string): void;
  runWithSubmittedRecords?<T>(records: readonly Readonly<Record<string, SalesforceFieldValue>>[],
    callback: () => Promise<T>, options?: { allOrNone: boolean }): Promise<T>;
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

  public async createRecords(input: CreateRecordsInput): Promise<BatchDmlOutput> {
    return this.batch('CREATE', createRecordsInputSchema.parse(input));
  }

  public async updateRecords(input: UpdateRecordsInput): Promise<BatchDmlOutput> {
    return this.batch('UPDATE', updateRecordsInputSchema.parse(input));
  }

  private async batch(operation: 'CREATE' | 'UPDATE', input: CreateRecordsInput | UpdateRecordsInput): Promise<BatchDmlOutput> {
    // One Salesforce collection request cannot express two different updates to the same
    // record: the commit order alone would decide the final value. Reject it before any
    // allowlist read, Connection lookup or dispatch.
    if (operation === 'UPDATE') {
      const duplicates = duplicateBatchRecordIds(input.records as readonly { recordId?: unknown }[]);
      if (duplicates.length > 0) {
        throw new DmlRuntimeError(BATCH_DUPLICATE_RECORD_ID_CODE,
          `update_records received the same Salesforce record more than once. Duplicate record ID${duplicates.length === 1 ? '' : 's'}: ${duplicates.slice(0, 5).join(', ')}. Send at most one item per record so Salesforce collection order cannot decide the committed value.`,
          []);
      }
    }
    // Every row uses the same authority as a single mutation; no BATCH permission.
    for (const _item of input.records) this.allowlist.assertAllowed(input.objectApiName, operation);
    const connection = await this.getRequestConnection();
    if (!(Number(connection.getApiVersion()) >= 42)) throw new DmlRuntimeError('MCP_DML_CONFIGURATION_INVALID',
      'Batch DML requires Salesforce API 42 or newer for a single collection request.');
    const records = input.records.map((item) => {
      const fields = copyFields(item.fields);
      if ('recordTypeId' in item && item.recordTypeId) {
        for (const key of Object.keys(fields)) if (key.toLowerCase() === 'recordtypeid') delete fields[key];
        fields.RecordTypeId = item.recordTypeId;
      }
      return 'recordId' in item ? { ...fields, Id: item.recordId } : fields;
    });
    const sobject = connection.sobject(input.objectApiName);
    const dispatch = async () => {
      this.mutationObserver?.onMutationStarted(operation);
      const options = { allOrNone: input.allOrNone, allowRecursive: false };
      return operation === 'CREATE' ? sobject.create(records, options)
        : sobject.update(records as Array<Record<string, SalesforceFieldValue> & { Id: string }>, options);
    };
    try {
      const response = this.mutationObserver?.runWithSubmittedRecords
        ? await this.mutationObserver.runWithSubmittedRecords(records, dispatch, { allOrNone: input.allOrNone }) : await dispatch();
      // Collection SaveResults follow request order. Validate the complete envelope
      // before associating any client reference with a proven Salesforce ID.
      if (!Array.isArray(response) || response.length !== records.length
        || response.some((item) => typeof item.success !== 'boolean'
          || !Array.isArray(item.errors) || (item.success && !recordIdSchema.safeParse(item.id).success))
        || (input.allOrNone && response.some((item) => item.success) && response.some((item) => !item.success))) {
        throw new Error('Unverifiable collection response');
      }
      if (operation === 'UPDATE' && response.some((item, index) => item.success
        && item.id.slice(0, 15) !== String(records[index]?.Id).slice(0, 15))) throw new Error('Update result identity mismatch');
      const results: BatchDmlOutput['results'] = response.map((item, index) => ({
        index, ...(input.records[index]?.clientReferenceId ? { clientReferenceId: input.records[index]!.clientReferenceId } : {}),
        success: item.success, status: item.success ? 'SUCCESS' : 'FAILED',
        ...(item.success ? { recordId: item.id } : { errorCode: 'MCP_SALESFORCE_DML_FAILED',
          message: 'Salesforce rejected this record.', salesforceErrors: extractSafeSalesforceErrors(item.errors).slice(0, 3)
            .map((error) => ({ ...error, message: error.message.slice(0, 512), fields: error.fields.slice(0, 20) })) }),
      }));
      const succeeded = results.filter((item) => item.success).length;
      return { success: succeeded === results.length, status: succeeded === results.length ? 'SUCCESS'
        : succeeded > 0 ? 'PARTIAL_SUCCESS' : 'FAILED', total: results.length, succeeded,
        failed: results.length - succeeded, unknown: 0, allOrNone: input.allOrNone, results };
    } catch (error) {
      return batchFailureOutput(input, toSalesforceDmlError(error, operation));
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

export function batchFailureOutput(input: { records: readonly { clientReferenceId?: string }[]; allOrNone: boolean },
  error: Readonly<{ code: string; message: string; salesforceErrors: DmlRuntimeError['salesforceErrors'] }>): BatchDmlOutput {
  const unknown = error.code === 'MCP_DML_OUTCOME_UNKNOWN';
  const records = input.records.slice(0, 200);
  const salesforceErrors = error.salesforceErrors.slice(0, 3).map((item) => ({ ...item,
    message: item.message.slice(0, 512), fields: item.fields.slice(0, 20) }));
  return { success: false, status: unknown ? 'OUTCOME_UNKNOWN' : 'FAILED', total: records.length,
    succeeded: 0, failed: unknown ? 0 : records.length, unknown: unknown ? records.length : 0,
    allOrNone: input.allOrNone, errorCode: error.code, message: error.message.slice(0, 2000),
    results: records.map((item, index) => ({ index, clientReferenceId: item.clientReferenceId,
      success: false, status: unknown ? 'OUTCOME_UNKNOWN' : 'FAILED', errorCode: error.code,
      message: error.message.slice(0, 2000), salesforceErrors })) };
}

function copyFields(fields: Readonly<Record<string, SalesforceFieldValue>>): Record<string, SalesforceFieldValue> {
  return { ...fields };
}
