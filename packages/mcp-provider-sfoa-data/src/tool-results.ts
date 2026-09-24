import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { DataRuntimeError, type DataErrorCode } from './errors.js';
import { readSalesforceFailure } from './salesforce-errors.js';
import { sanitizeText } from './sanitize.js';

export function dataSuccessToolResult(output: Readonly<Record<string, unknown>>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

/**
 * Converts an expected Data Tool failure into an `isError` Tool result.
 *
 * Every failure an Agent can act on stays a Tool result, never a JSON-RPC error. The
 * payload always states the SFoA contract code, a sanitized message, and the safe next
 * action; the raw Salesforce code is reported separately so an Agent can branch on it
 * (for example `INVALID_FIELD` → describe the object and retry).
 */
export function dataFailureToolResult(error: unknown, fallbackCode: DataErrorCode): CallToolResult {
  const runtimeError = error instanceof DataRuntimeError
    ? error
    : error instanceof ZodError
      ? new DataRuntimeError('MCP_DATA_INVALID_INPUT', formatZodError(error))
      : new DataRuntimeError(fallbackCode, 'Salesforce data could not be read safely.', { cause: error });
  // Read the provider code from the original thrown value only. A DataRuntimeError's own
  // `code` is an SFoA contract code, and reporting it as a Salesforce code would invent a
  // provider outcome that never happened.
  const original = error instanceof DataRuntimeError ? error.cause : error;
  const salesforceCode = original === undefined ? null : readSalesforceFailure(original).code;
  const output: Record<string, unknown> = {
    success: false,
    errorCode: runtimeError.code,
    message: sanitizeText(runtimeError.message, 2_000),
    ...(runtimeError.suggestion === undefined
      ? {}
      : { suggestion: sanitizeText(runtimeError.suggestion, 1_000) }),
    ...(salesforceCode === null ? {} : { salesforceErrorCode: salesforceCode }),
  };
  const text = runtimeError.suggestion === undefined
    ? `[${runtimeError.code}] ${output.message as string}`
    : `[${runtimeError.code}] ${output.message as string} Next: ${sanitizeText(runtimeError.suggestion, 1_000)}`;
  return {
    isError: true,
    content: [{ type: 'text', text }],
    structuredContent: output,
  };
}

function formatZodError(error: ZodError): string {
  const details = error.issues
    .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
    .join('; ')
    .slice(0, 1_800);
  return `Invalid Data Tool input: ${details}`;
}
