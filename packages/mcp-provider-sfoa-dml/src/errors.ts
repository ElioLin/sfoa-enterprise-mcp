import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DmlOperation } from './allowlist.js';
import type { DmlOutput, SafeSalesforceError } from './schemas.js';

export const DML_ERROR_CODES = [
  'MCP_DML_CONFIGURATION_INVALID',
  'MCP_DML_OBJECT_NOT_ALLOWED',
  'MCP_DML_OPERATION_NOT_ALLOWED',
  'MCP_DML_INPUT_INVALID',
  'MCP_DML_IDENTITY_CONTEXT_INVALID',
  'MCP_SALESFORCE_DML_FAILED',
  'MCP_DML_OUTCOME_UNKNOWN',
] as const;

export type DmlErrorCode = (typeof DML_ERROR_CODES)[number];

export class DmlRuntimeError extends Error {
  public constructor(
    public readonly code: DmlErrorCode,
    message: string,
    public readonly salesforceErrors: readonly SafeSalesforceError[] = [],
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DmlRuntimeError';
  }
}

export function dmlErrorToolResult(error: DmlRuntimeError): CallToolResult {
  const output: DmlOutput = {
    success: false,
    errorCode: error.code,
    message: sanitizeText(error.message, 2_000),
    ...(error.salesforceErrors.length > 0
      ? { salesforceErrors: error.salesforceErrors.slice(0, 25) }
      : {}),
  };
  const detail = output.salesforceErrors
    ?.map((item) => `${item.errorCode}: ${item.message}${item.fields.length > 0 ? ` (${item.fields.join(', ')})` : ''}`)
    .join('; ');
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `[${output.errorCode}] ${output.message}${detail ? ` Salesforce: ${detail}` : ''}`,
      },
    ],
    structuredContent: output,
  };
}

export function toSalesforceDmlError(error: unknown, operation: 'CREATE' | 'UPDATE'): DmlRuntimeError {
  const salesforceErrors = extractSafeSalesforceErrors(error);
  if (!hasStructuredSalesforceRejectionEvidence(error)) {
    return dmlOutcomeUnknownError(operation, error);
  }
  return new DmlRuntimeError(
    'MCP_SALESFORCE_DML_FAILED',
    `Salesforce rejected the ${operation} operation. Check Salesforce permissions, field access, required values, validation rules, and automation.`,
    salesforceErrors,
    { cause: error },
  );
}

export function dmlOutcomeUnknownError(operation: DmlOperation, cause?: unknown): DmlRuntimeError {
  return new DmlRuntimeError(
    'MCP_DML_OUTCOME_UNKNOWN',
    `Outcome is unknown. The runtime cannot determine whether Salesforce committed the ${operation} mutation. Do not automatically retry. Salesforce server-side cancellation is not guaranteed. Use a read-only Tool to verify Salesforce state before attempting another mutation; if verification is not possible, inform the user that the outcome remains unknown.`,
    [],
    { cause },
  );
}

export function extractSafeSalesforceErrors(value: unknown): readonly SafeSalesforceError[] {
  const candidates = collectCandidates(value);
  const safe: SafeSalesforceError[] = [];
  for (const candidate of candidates) {
    const record = toRecord(candidate);
    if (!record) continue;
    const message = typeof record.message === 'string' ? sanitizeText(record.message, 2_000) : undefined;
    if (!message) continue;
    const rawCode = typeof record.errorCode === 'string' && record.errorCode.trim().length > 0
      ? record.errorCode
      : undefined;
    if (!rawCode) continue;
    const errorCode = sanitizeCode(rawCode);
    const fields = Array.isArray(record.fields)
      ? record.fields
          .filter((field): field is string => typeof field === 'string')
          .slice(0, 200)
          .map((field) => sanitizeFieldName(field))
          .filter((field) => field.length > 0)
      : [];
    safe.push({ errorCode, message, fields });
    if (safe.length >= 25) break;
  }
  return Object.freeze(safe);
}

function collectCandidates(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  const record = toRecord(value);
  if (!record) return [value];
  if (Array.isArray(record.errors)) return record.errors;
  if (Array.isArray(record.data)) return record.data;
  const data = toRecord(record.data);
  if (data) return [data];
  return [value];
}

function collectStructuredSalesforceErrorCandidates(value: unknown): readonly unknown[] {
  // Only the structured Salesforce REST error body counts as rejection evidence.
  // JSforce 3.10.13 retains that body in HttpApiError.data (object or array), or a
  // collection/bulk response in an `errors` array. A primitive `data` (e.g. an HTML
  // error page) carries no structured errorCode/message pair, so it is excluded.
  if (Array.isArray(value)) return value;
  const record = toRecord(value);
  if (!record) return [];
  if (Array.isArray(record.errors)) return record.errors;
  if (Array.isArray(record.data)) return record.data;
  const data = toRecord(record.data);
  if (data) return [data];
  return [];
}

function hasStructuredSalesforceRejectionEvidence(value: unknown): boolean {
  // JSforce 3.10.13 retains the Salesforce REST error body in HttpApiError.data.
  // Do not infer rejection from Error.name, HTTP status, or message text: transport
  // exceptions can carry those values after Salesforce has already committed.
  return collectStructuredSalesforceErrorCandidates(value).some((candidate) => {
    const record = toRecord(candidate);
    if (!record) return false;
    const hasCode = typeof record.errorCode === 'string' && record.errorCode.trim().length > 0;
    const hasMessage = typeof record.message === 'string' && record.message.trim().length > 0;
    if (!hasCode || !hasMessage) return false;
    const fields = record.fields;
    // `fields` is optional: Salesforce omits it for INVALID_FIELD / "No such column"
    // rejections. When present, every entry must be a string.
    return fields === undefined
      || (Array.isArray(fields) && fields.every((field) => typeof field === 'string'));
  });
}

function sanitizeText(value: string, maxLength: number): string {
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, '[REDACTED_PRIVATE_KEY]')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[REDACTED_JWT]')
    .replace(/\b(access_token|refresh_token|client_secret)=([^\s&]+)/giu, '$1=[REDACTED]')
    .slice(0, maxLength);
}

function sanitizeCode(value: string): string {
  const normalized = value.toLocaleUpperCase('en-US').replace(/[^A-Z0-9_]/gu, '_').slice(0, 128);
  return normalized || 'UNKNOWN_SALESFORCE_ERROR';
}

function sanitizeFieldName(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_]*$/u.test(value) ? value.slice(0, 128) : '';
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
