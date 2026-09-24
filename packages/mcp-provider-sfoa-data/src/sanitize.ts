const PRIVATE_KEY_PATTERN = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=!-]+/giu;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const SECRET_ASSIGNMENT_PATTERN = /\b(access_token|refresh_token|client_secret|session_id|sid|password)=([^\s&]+)/giu;
const SALESFORCE_SESSION_ID_PATTERN = /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._-]{8,}/gu;

/**
 * Last-resort scrubber for anything that leaves a Data Tool. Salesforce error text is
 * echoed back to the Agent, so every message passes through here before it is returned:
 * private keys, bearer headers, JWTs, `key=value` credential pairs, and OAuth session
 * IDs are replaced rather than truncated, so the surrounding diagnostic meaning survives.
 */
export function sanitizeText(value: string, maxLength: number): string {
  return value
    .replace(PRIVATE_KEY_PATTERN, '[REDACTED_PRIVATE_KEY]')
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(JWT_PATTERN, '[REDACTED_JWT]')
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1=[REDACTED]')
    .replace(SALESFORCE_SESSION_ID_PATTERN, '[REDACTED_SESSION_ID]')
    .slice(0, maxLength);
}
