import { z } from 'zod';

export type DecodedTokenSummary = {
  tokenType: 'JWT' | 'OPAQUE';
  expiration: string;
  isExpired: boolean | undefined;
  issuer: string;
  audience: string;
  subject: string;
  scope: string;
};

const jsonObjectSchema = z.record(z.unknown());

export function maskToken(token: string): string {
  if (token.length <= 12) return '<masked>';
  return `${token.slice(0, 8)}...${token.slice(-4)}<masked>`;
}

export function describeAccessToken(token: string): DecodedTokenSummary {
  const segments = token.split('.');
  if (segments.length !== 3 || !segments[1]) {
    return {
      tokenType: 'OPAQUE',
      expiration: 'NOT PROVIDED BY SALESFORCE TOKEN RESPONSE',
      isExpired: undefined,
      issuer: 'NOT PROVIDED',
      audience: 'NOT PROVIDED',
      subject: 'NOT PROVIDED',
      scope: 'NOT PROVIDED',
    };
  }

  try {
    const payload = jsonObjectSchema.parse(JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')));
    const expirationSeconds = typeof payload.exp === 'number' ? payload.exp : undefined;
    return {
      tokenType: 'JWT',
      expiration: expirationSeconds === undefined ? 'NOT PROVIDED' : new Date(expirationSeconds * 1000).toISOString(),
      isExpired: expirationSeconds === undefined ? undefined : expirationSeconds * 1000 <= Date.now(),
      issuer: claimToString(payload.iss),
      audience: claimToString(payload.aud),
      subject: claimToString(payload.sub),
      scope: claimToString(payload.scope),
    };
  } catch {
    return {
      tokenType: 'OPAQUE',
      expiration: 'NOT PROVIDED BY SALESFORCE TOKEN RESPONSE',
      isExpired: undefined,
      issuer: 'NOT PROVIDED',
      audience: 'NOT PROVIDED',
      subject: 'NOT PROVIDED',
      scope: 'NOT PROVIDED',
    };
  }
}

export function redactError(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);

  for (const secret of secrets.filter((value) => value.length > 0)) {
    message = message.split(secret).join('<redacted>');
  }

  return message
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer <redacted>')
    .replace(/\b00D[A-Za-z0-9]{9,}![A-Za-z0-9._-]+\b/gu, '<redacted-access-token>')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '<redacted-private-key>');
}

function claimToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value.join(', ');
  return 'NOT PROVIDED';
}
