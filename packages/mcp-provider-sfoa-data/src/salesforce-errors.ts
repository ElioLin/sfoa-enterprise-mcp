import { DataRuntimeError, type DataErrorCode } from './errors.js';
import { sanitizeText } from './sanitize.js';

export type SalesforceFailure = Readonly<{
  /** Salesforce error code when the provider reported one, already bounded and validated. */
  code: string | null;
  /** Salesforce message, already sanitized and bounded. Never a token or a stack trace. */
  message: string | null;
}>;

export type DataFailureRule = Readonly<{
  /** Salesforce error codes that select this outcome. Matched case-insensitively. */
  codes: readonly string[];
  code: DataErrorCode;
  message: string;
  suggestion?: string;
}>;

export type DataFailureMapping = Readonly<{
  fallbackCode: DataErrorCode;
  fallbackMessage: string;
  fallbackSuggestion?: string;
  rules: readonly DataFailureRule[];
}>;

const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u;
const MAX_MESSAGE_LENGTH = 2_000;

/**
 * Reads the Salesforce error code and message out of an arbitrary thrown value without
 * trusting its shape. The request-scoped Connection is a jsforce client, which reports
 * `errorCode`/`message`; `@salesforce/core` errors report `code`/`name`; multipart and
 * SOAP failures nest the payload under `data` or `body`. Unknown or non-conforming
 * shapes degrade to "no code, no message" rather than echoing raw provider internals.
 */
export function readSalesforceFailure(error: unknown): SalesforceFailure {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (typeof current !== 'object') break;
    const record = current as Record<string, unknown>;
    const code = readErrorCode(record.errorCode) ?? readErrorCode(record.code);
    if (code !== null) {
      return Object.freeze({ code, message: readErrorMessage(record.message ?? record.error_description) });
    }
    current = record.data ?? record.body ?? record.cause;
  }
  return Object.freeze({ code: null, message: readErrorMessage(readField(error, 'message')) });
}

/**
 * Maps a thrown Salesforce/provider error onto a sanitized `DataRuntimeError`. Rules are
 * evaluated in order and the first code match wins, so a caller can rank specific
 * failures (field/type errors an Agent can self-correct) ahead of broad ones.
 *
 * A `DataRuntimeError` is returned unchanged: it is already an SFoA contract error that
 * was classified and sanitized deliberately (an unavailable request identity, a rejected
 * input), and re-labelling it as a Salesforce failure would replace an actionable code
 * with a generic one and hide the real cause from the Agent.
 */
export function mapDataFailure(error: unknown, mapping: DataFailureMapping): DataRuntimeError {
  if (error instanceof DataRuntimeError) return error;
  const failure = readSalesforceFailure(error);
  const normalizedCode = failure.code?.toLocaleUpperCase('en-US');
  const rule = mapping.rules.find((candidate) => normalizedCode !== undefined
    && candidate.codes.some((code) => code.toLocaleUpperCase('en-US') === normalizedCode));
  const baseMessage = rule?.message ?? mapping.fallbackMessage;
  const suggestion = rule?.suggestion ?? mapping.fallbackSuggestion;
  // The provider's own message is repeated only when Salesforce reported an error code:
  // a code proves the failure came from the API contract and that the message is a
  // provider-authored string, whereas a codeless failure (a socket error, a timeout, a
  // malformed response) has an unknown shape and is never echoed to the client.
  const message = failure.code === null || failure.message === null
    ? baseMessage
    : sanitizeText(`${baseMessage} Salesforce reported: ${failure.message}`, MAX_MESSAGE_LENGTH);
  return new DataRuntimeError(rule?.code ?? mapping.fallbackCode, message, {
    cause: error,
    ...(suggestion === undefined ? {} : { suggestion }),
  });
}

function readErrorCode(value: unknown): string | null {
  return typeof value === 'string' && ERROR_CODE_PATTERN.test(value.trim()) ? value.trim() : null;
}

function readErrorMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : sanitizeText(trimmed, MAX_MESSAGE_LENGTH);
}

function readField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}
