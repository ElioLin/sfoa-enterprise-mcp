import { createHash } from 'node:crypto';

export const AUDIT_REDACTION_MARKER = '[REDACTED]';
export const AUDIT_TRUNCATION_MARKER = '[TRUNCATED]';
export const MAX_AUDIT_SUMMARY_BYTES = 16_384;
export const MAX_AUDIT_PAYLOAD_BYTES = 262_144;

const MAX_SANITIZATION_DEPTH = 10;
const MAX_SANITIZATION_NODES = 10_000;
const MAX_ARRAY_ITEMS = 500;

const SECRET_KEY = /(?:authorization|proxyauthorization|cookie|setcookie|token|jwt|privatekey|secret|password|passphrase|databasepassword|dbpassword|apikey|xapikey|credential)/u;
const SAFE_DERIVED_TOKEN_KEYS = new Set(['tokenfingerprint', 'tokenlast4']);
const FORBIDDEN_VALUE_PATTERNS: readonly RegExp[] = Object.freeze([
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/giu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  /\bsfoa_ub1_[A-Za-z0-9._~-]+\b/giu,
  /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*[^\r\n,]+/giu,
  /\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|database[_-]?password|db[_-]?password|password|passphrase|api[_-]?key|credential[_-]?secret)\s*[:=]\s*[^\s&,;]+/giu,
]);

type SanitizationState = { nodes: number; truncated: boolean; readonly seen: WeakSet<object> };

/**
 * 审计净化必须在持久化边界统一执行。调用方不能通过声称内容“已经安全”绕过此层。
 * 这里只保留可证明的业务证据；认证机密一律替换为固定标记，避免标记本身泄露长度。
 */
export function sanitizeAuditValue(value: unknown): unknown {
  return sanitizeAuditValueWithMetadata(value).value;
}

export function sanitizeAuditText(value: string): string {
  let sanitized = value;
  for (const pattern of FORBIDDEN_VALUE_PATTERNS) sanitized = sanitized.replace(pattern, AUDIT_REDACTION_MARKER);
  return sanitized;
}

export function encodeBoundedAuditJson(
  value: unknown,
  maxBytes = MAX_AUDIT_SUMMARY_BYTES,
): string | null {
  if (value === undefined || value === null) return null;
  const encoded = JSON.stringify(sanitizeAuditValue(value));
  if (encoded === undefined) return null;
  const byteLength = Buffer.byteLength(encoded, 'utf8');
  if (byteLength <= maxBytes) return encoded;
  return JSON.stringify(Object.freeze({
    truncated: true,
    originalSizeBytes: byteLength,
    contentSha256: sha256(encoded),
  }));
}

export type EncodedAuditPayload = Readonly<{
  safePayload: string | null;
  sanitizedSizeBytes: number;
  storedSizeBytes: number;
  truncated: boolean;
  contentSha256: string | null;
}>;

export function encodeBoundedAuditPayload(
  value: unknown,
  maxBytes = MAX_AUDIT_PAYLOAD_BYTES,
): EncodedAuditPayload {
  if (value === undefined || value === null) {
    return Object.freeze({
      safePayload: null,
      sanitizedSizeBytes: 0,
      storedSizeBytes: 0,
      truncated: false,
      contentSha256: null,
    });
  }
  const sanitized = typeof value === 'string'
    ? Object.freeze({ value: sanitizeAuditText(value), truncated: false })
    : sanitizeAuditValueWithMetadata(value);
  const encoded = typeof sanitized.value === 'string'
    ? sanitized.value
    : JSON.stringify(sanitized.value);
  if (encoded === undefined) {
    return Object.freeze({
      safePayload: null,
      sanitizedSizeBytes: 0,
      storedSizeBytes: 0,
      truncated: false,
      contentSha256: null,
    });
  }
  const sanitizedSizeBytes = Buffer.byteLength(encoded, 'utf8');
  const safePayload = sanitizedSizeBytes <= maxBytes ? encoded : truncateUtf8(encoded, maxBytes);
  return Object.freeze({
    safePayload,
    sanitizedSizeBytes,
    storedSizeBytes: Buffer.byteLength(safePayload, 'utf8'),
    truncated: sanitized.truncated || sanitizedSizeBytes > maxBytes,
    // Hash the exact persisted safe prefix. This is not a claim about a
    // truncated or otherwise unavailable original payload.
    contentSha256: sha256(safePayload),
  });
}

export function containsObviousAuditSecret(value: string): boolean {
  return FORBIDDEN_VALUE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function sanitizeValue(value: unknown, depth: number, state: SanitizationState): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_SANITIZATION_NODES || depth > MAX_SANITIZATION_DEPTH) {
    state.truncated = true;
    return AUDIT_TRUNCATION_MARKER;
  }
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return sanitizeAuditText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return Object.freeze({ name: sanitizeAuditText(value.name), message: sanitizeAuditText(value.message) });
  }
  if (typeof value !== 'object') return String(value);
  if (state.seen.has(value)) {
    state.truncated = true;
    return '[CIRCULAR]';
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1, state));
      if (value.length > MAX_ARRAY_ITEMS) {
        state.truncated = true;
        items.push(AUDIT_TRUNCATION_MARKER);
      }
      return items;
    }
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const canonicalKey = key.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/gu, '');
      output[key] = !SAFE_DERIVED_TOKEN_KEYS.has(canonicalKey) && SECRET_KEY.test(canonicalKey)
        ? AUDIT_REDACTION_MARKER
        : sanitizeValue(child, depth + 1, state);
    }
    return output;
  } finally {
    state.seen.delete(value);
  }
}

function sanitizeAuditValueWithMetadata(value: unknown): Readonly<{ value: unknown; truncated: boolean }> {
  const state: SanitizationState = { nodes: 0, truncated: false, seen: new WeakSet<object>() };
  return Object.freeze({ value: sanitizeValue(value, 0, state), truncated: state.truncated });
}

function truncateUtf8(value: string, maxBytes: number): string {
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
