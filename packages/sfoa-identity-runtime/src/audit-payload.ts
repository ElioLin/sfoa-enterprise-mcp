export type RequestAuditPayloadType =
  | 'MCP_REQUEST'
  | 'MCP_RESPONSE'
  | 'SALESFORCE_REQUEST'
  | 'SALESFORCE_RESPONSE'
  | 'ERROR_RESPONSE';

export type RequestAuditPayloadPriority = 'GENERAL' | 'CORE' | 'ERROR';

export type RequestAuditPayloadEvidenceInput = Readonly<{
  payloadType: RequestAuditPayloadType;
  contentType: string;
  payload: string | Buffer | Uint8Array;
  originalSizeBytes?: number | null;
  truncated?: boolean;
  salesforceApiCallPublicId?: string;
  auditEventSequence?: number;
  priority?: RequestAuditPayloadPriority;
}>;

export type PreparedRequestAuditPayloadEvidence = Readonly<{
  payloadType: RequestAuditPayloadType;
  contentType: string;
  safePayload: string;
  originalSizeBytes: number | null;
  storedSizeBytes: number;
  truncated: boolean;
  contentSha256: null;
  salesforceApiCallPublicId: string | null;
  auditEventSequence: number | null;
  priority: RequestAuditPayloadPriority;
}>;

export const MAX_AUDIT_PAYLOAD_BYTES = 262_144;

const JSON_SECRET_KEY = /("(?:authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|jwt|assertion|private[_-]?key|client[_-]?secret|password|passphrase|database[_-]?password|db[_-]?password|api[_-]?key|x[_-]?api[_-]?key|credential[_-]?secret|user[_-]?bound[_-]?token)"\s*:\s*)("(?:\\.|[^"\\])*(?:"|$)|[^,}\]\s]*)/giu;
const FORBIDDEN_VALUE_PATTERNS: readonly RegExp[] = Object.freeze([
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY-----|$)/giu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  /\bsfoa_ub1_[A-Za-z0-9._~-]+\b/giu,
  /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*[^\r\n,]+/giu,
]);
const REDACTION_MARKER = '[REDACTED]';

/**
 * Produces one bounded, secret-safe payload prefix without hashing or persistence.
 * Large strings are sliced before sanitization, so Audit never scans/copies an
 * unbounded Tool or Salesforce response merely to collect evidence.
 */
export function prepareRequestAuditPayload(
  input: RequestAuditPayloadEvidenceInput,
  maxBytes = MAX_AUDIT_PAYLOAD_BYTES,
): PreparedRequestAuditPayloadEvidence {
  const boundedMaximum = Math.max(0, Math.min(MAX_AUDIT_PAYLOAD_BYTES, maxBytes));
  const source = boundedSourcePrefix(input.payload, boundedMaximum);
  const sanitized = sanitizeAuditPayloadText(source.text);
  const sanitizedSizeBytes = Buffer.byteLength(sanitized, 'utf8');
  const safePayload = truncateUtf8(sanitized, boundedMaximum);
  const storedSizeBytes = Buffer.byteLength(safePayload, 'utf8');
  const inferredOriginalSize = inferOriginalSize(input.payload, boundedMaximum);
  const originalSizeBytes = validSize(input.originalSizeBytes) ? input.originalSizeBytes : inferredOriginalSize;
  return Object.freeze({
    payloadType: input.payloadType,
    contentType: safeContentType(input.contentType),
    safePayload,
    originalSizeBytes: originalSizeBytes ?? null,
    storedSizeBytes,
    truncated: input.truncated === true || source.truncated || sanitizedSizeBytes > boundedMaximum,
    contentSha256: null,
    salesforceApiCallPublicId: input.salesforceApiCallPublicId ?? null,
    auditEventSequence: validSequence(input.auditEventSequence) ? input.auditEventSequence : null,
    priority: input.priority ?? defaultPriority(input.payloadType),
  });
}

export function sanitizeAuditPayloadText(value: string): string {
  let sanitized = value.replace(JSON_SECRET_KEY, `$1"${REDACTION_MARKER}"`);
  for (const pattern of FORBIDDEN_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, REDACTION_MARKER);
  }
  return sanitized;
}

function boundedSourcePrefix(
  payload: string | Buffer | Uint8Array,
  maxBytes: number,
): Readonly<{ text: string; truncated: boolean }> {
  if (typeof payload === 'string') {
    // At most maxBytes UTF-16 code units are inspected. The resulting UTF-8 text
    // is bounded again below, so multibyte content cannot exceed the byte cap.
    return Object.freeze({ text: payload.slice(0, maxBytes), truncated: payload.length > maxBytes });
  }
  const buffer = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  return Object.freeze({
    text: buffer.subarray(0, Math.min(buffer.byteLength, maxBytes)).toString('utf8'),
    truncated: buffer.byteLength > maxBytes,
  });
}

function inferOriginalSize(payload: string | Buffer | Uint8Array, maxBytes: number): number | null {
  if (typeof payload !== 'string') return payload.byteLength;
  return payload.length <= maxBytes ? Buffer.byteLength(payload, 'utf8') : null;
}

function validSize(value: number | null | undefined): value is number | null {
  return value === null || (value !== undefined && Number.isSafeInteger(value) && value >= 0);
}

function validSequence(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 1 && value <= 4_294_967_295;
}

function safeContentType(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001F\u007F]/gu, '').trim().slice(0, 128);
  return sanitized || 'application/octet-stream';
}

function defaultPriority(payloadType: RequestAuditPayloadType): RequestAuditPayloadPriority {
  if (payloadType === 'ERROR_RESPONSE') return 'ERROR';
  if (payloadType === 'MCP_REQUEST' || payloadType === 'MCP_RESPONSE') return 'CORE';
  return 'GENERAL';
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(value.charAt(low - 1))) low -= 1;
  return value.slice(0, low);
}
