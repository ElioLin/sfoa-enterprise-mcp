import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import {
  RecordActionContextExecutor, formContextRequestSchema, prepareQuickActionRequest, parseQuickActionOutcome,
  type PrecisionFormOptions, type RecordActionContextInput, type QuickActionDescriptor,
  ContextRuntimeError,
} from '@sfoa/mcp-provider-sfoa-context';
import {
  createRecordInputSchema, updateRecordInputSchema, createRecordsInputSchema, updateRecordsInputSchema,
  dmlSuccessToolResult, dmlExecutionErrorToolResult, DmlRuntimeError,
  toSalesforceDmlError, extractSafeSalesforceErrors,
  type DmlOperation, type MutationExecutionObserver, type SalesforceFieldValue,
} from '@sfoa/mcp-provider-sfoa-dml';
import { RemoteRuntimeError } from './errors.js';

type Input = Record<string, unknown>;
type Prepared = { input: Input; execute?: () => Promise<CallToolResult> };

/** Host-only, request-owned preparation; no audit reference is accepted as proof. */
export class FormDmlPreflight {
  private readonly executor: RecordActionContextExecutor;
  public constructor(orgService: OrgService, private readonly connection: () => Promise<Connection>,
    private readonly observer: MutationExecutionObserver, private readonly precision: PrecisionFormOptions) {
    this.executor = new RecordActionContextExecutor(orgService, undefined, precision);
  }

  public async prepare(operation: DmlOperation, input: Input, requestedInput: Input = input): Promise<Prepared> {
    if (Array.isArray(input.records)) {
      const parsed = (operation === 'CREATE' ? createRecordsInputSchema : updateRecordsInputSchema).parse(input);
      const records: Input[] = [];
      for (const [index, item] of parsed.records.entries()) {
        if (!item.formContext) { records.push(item); continue; }
        if (item.formContext.entry === 'QUICK_ACTION') throw new RemoteRuntimeError('MCP_FORM_NOT_READY',
          'Native Quick Actions require a single create_record or update_record call; collection DML cannot execute a native action.');
        const { clientReferenceId, ...record } = item;
        const original = Array.isArray(requestedInput.records) ? requestedInput.records[index] : undefined;
        const prepared = await this.single(operation, { objectApiName: parsed.objectApiName, ...record },
          original && typeof original === 'object' ? original as Input : record);
        if (prepared.execute) throw new RemoteRuntimeError('MCP_FORM_NOT_READY',
          'An opted-in collection row already matches its requested values. Omit unchanged rows before submitting the remaining collection. No collection was dispatched.');
        const { objectApiName: _object, ...fields } = prepared.input;
        records.push({ ...fields, ...(clientReferenceId ? { clientReferenceId } : {}) });
      }
      return { input: { ...parsed, records } };
    }
    return this.single(operation, input, requestedInput);
  }

  private async single(operation: DmlOperation, raw: Input, requested: Input): Promise<Prepared> {
    const input = (operation === 'CREATE' ? createRecordInputSchema : updateRecordInputSchema).parse(raw);
    if (!input.formContext) return { input };
    const selection = formContextRequestSchema.parse({ ...input.formContext, phase: 'SUBMIT', recommendationFields: undefined });
    const fields = { ...input.fields };
    const typeKey = Object.keys(fields).find((name) => name.toLowerCase() === 'recordtypeid');
    const recordTypeId = 'recordTypeId' in input ? input.recordTypeId
      : undefined;
    if (operation === 'UPDATE' && typeKey) throw new RemoteRuntimeError('MCP_FORM_NOT_READY',
      'Changing Record Type is outside this selected Edit form contract. Resolve the type change separately before preparing this form.');
    const selectedType = recordTypeId ?? (typeKey && typeof fields[typeKey] === 'string' ? fields[typeKey] : undefined);
    if (typeKey) delete fields[typeKey];
    const observedManagedValues: Record<string, SalesforceFieldValue> = {};
    const requestedFields = requested.fields && typeof requested.fields === 'object' && !Array.isArray(requested.fields)
      ? requested.fields as Record<string, unknown> : {};
    for (const rule of this.precision.managedFields ?? []) {
      if (!rule.enabled || rule.objectApiName.toLowerCase() !== input.objectApiName.toLowerCase()
        || !(operation === 'CREATE' ? rule.applyOnCreate : rule.applyOnUpdate)) continue;
      const name = Object.keys(fields).find((key) => key.toLowerCase() === rule.targetFieldApiName.toLowerCase());
      if (!name || rule.strategy === 'PLATFORM_USER_LOOKUP_FALLBACK'
        && Object.keys(requestedFields).some((key) => key.toLowerCase() === name.toLowerCase())) continue;
      observedManagedValues[rule.targetFieldApiName] = fields[name]!;
      delete fields[name];
    }
    const context: RecordActionContextInput = { objectApiName: input.objectApiName, action: operation,
      ...(selectedType ? { recordTypeId: selectedType } : {}),
      ...('recordId' in input ? { recordId: input.recordId } : {}), draftFields: fields,
      includeRequiredness: true, formContext: selection };
    let resolved;
    try { resolved = await this.executor.executeWithForm(context, observedManagedValues); }
    catch (error) {
      if (error instanceof ContextRuntimeError) throw new RemoteRuntimeError('MCP_FORM_CONTEXT_UNAVAILABLE', error.message);
      throw error;
    }
    const report = resolved.output.formContext;
    if (!report || report.status !== 'READY' || !resolved.prepared) {
      const detail = report ? [...report.missingRequired.map((name) => `missing:${name}`), ...report.criticalUnknown].slice(0, 20).join(', ')
        : resolved.output.recordTypeSelectionRequired ? 'RECORD_TYPE_SELECTION_REQUIRED' : 'FORM_CONTEXT_UNAVAILABLE';
      throw new RemoteRuntimeError('MCP_FORM_NOT_READY', `The selected form is not ready; no mutation was submitted. ${detail}`);
    }
    const { formContext: _form, ...withoutForm } = input;
    const prepared: Input = { ...withoutForm, fields: resolved.prepared.fields,
      uiContextResolutionId: report.resolutionId,
      ...(operation === 'CREATE' && resolved.output.recordType ? { recordTypeId: resolved.output.recordType.id } : {}) };
    if (resolved.prepared.quickAction) {
      const descriptor = resolved.prepared.quickAction;
      return { input: prepared, execute: () => this.invoke(descriptor, resolved.prepared!.fields) };
    }
    if (Object.keys(resolved.prepared.fields).length === 0 && operation === 'UPDATE' && 'recordId' in input) {
      // A verified no-op is successful without manufacturing a Salesforce write.
      return { input: prepared, execute: async () => {
        const output = { success: true, recordId: input.recordId,
          message: 'The selected record already contains the requested values; no Salesforce mutation was necessary.' };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
      } };
    }
    return { input: prepared };
  }

  private async invoke(descriptor: QuickActionDescriptor,
    fields: Record<string, SalesforceFieldValue>): Promise<CallToolResult> {
    const connection = await this.connection();
    const request = prepareQuickActionRequest(descriptor, fields);
    const dispatch = async (): Promise<unknown> => {
      this.observer.onMutationStarted(descriptor.action);
      return connection.request<unknown>({ method: request.method, url: request.url,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body) });
    };
    try {
      const raw = this.observer.runWithSubmittedFields
        ? await this.observer.runWithSubmittedFields(fields, dispatch) : await dispatch();
      const result = parseQuickActionOutcome(raw, descriptor);
      if (result.status === 'SUCCESS' && result.recordId) {
        this.observer.onMutationCompleted?.(descriptor.action, result.recordId);
        return dmlSuccessToolResult(result.recordId);
      }
      if (result.status === 'FAILED') throw new DmlRuntimeError('MCP_SALESFORCE_DML_FAILED',
        'Salesforce rejected the native Quick Action.', extractSafeSalesforceErrors(result.errors.map((error) => ({
          errorCode: error.statusCode, message: error.message, fields: error.fields }))));
      throw new Error('Unverifiable native Quick Action outcome');
    } catch (error) { return dmlExecutionErrorToolResult(error instanceof DmlRuntimeError ? error
      : toSalesforceDmlError(error, descriptor.action), descriptor.action); }
  }
}
