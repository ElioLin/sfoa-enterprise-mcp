import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { ContextRuntimeError } from './errors.js';

export function contextSuccessToolResult(output: Readonly<Record<string, unknown>>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

export function contextExecutionErrorToolResult(error: unknown, inputErrorCode: ContextRuntimeError['code']): CallToolResult {
  const runtimeError = error instanceof ContextRuntimeError
    ? error
    : error instanceof ZodError
      ? new ContextRuntimeError(inputErrorCode, formatZodError(error))
      : new ContextRuntimeError(inputErrorCode, 'Salesforce context could not be returned safely.', { cause: error });
  const output = {
    success: false,
    errorCode: runtimeError.code,
    message: sanitizeText(runtimeError.message, 2_000),
  };
  return {
    isError: true,
    content: [{ type: 'text', text: `[${output.errorCode}] ${output.message}` }],
    structuredContent: output,
  };
}

function formatZodError(error: ZodError): string {
  const details = error.issues
    .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
    .join('; ')
    .slice(0, 1_800);
  return `Invalid context Tool input: ${details}`;
}

function sanitizeText(value: string, maxLength: number): string {
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, '[REDACTED_PRIVATE_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=!-]+/giu, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[REDACTED_JWT]')
    .replace(/\b(access_token|refresh_token|client_secret)=([^\s&]+)/giu, '$1=[REDACTED]')
    .slice(0, maxLength);
}
