import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { DmlRuntimeError, dmlErrorToolResult } from './errors.js';
import type { DmlOutput } from './schemas.js';

export function dmlSuccessToolResult(recordId: string): CallToolResult {
  const output: DmlOutput = { success: true, recordId };
  return {
    content: [{ type: 'text', text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

export function dmlExecutionErrorToolResult(error: unknown): CallToolResult {
  if (error instanceof DmlRuntimeError) return dmlErrorToolResult(error);
  if (error instanceof ZodError) {
    const details = error.issues
      .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
      .join('; ')
      .slice(0, 2_000);
    return dmlErrorToolResult(
      new DmlRuntimeError('MCP_DML_INPUT_INVALID', `Invalid DML Tool input: ${details}`),
    );
  }
  return dmlErrorToolResult(
    new DmlRuntimeError(
      'MCP_SALESFORCE_DML_FAILED',
      'The Salesforce DML operation failed without a safe structured error. Check the correlation log.',
      [],
      { cause: error },
    ),
  );
}
