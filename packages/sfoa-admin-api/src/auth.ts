import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import type { AdminApiConfig } from './config.js';

const sessionSchema = z.object({
  username: z.string().min(1).max(128),
  expiresAt: z.number().int().positive(),
  csrfToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u),
}).strict();

export type AdminSession = Readonly<z.infer<typeof sessionSchema>>;

/**
 * P6-ID-01: the Admin password is configured as plaintext via SFOA_ADMIN_PASSWORD.
 * The incoming login password is compared against the configured value directly with
 * a constant-time comparison; no scrypt hash is derived and no hash is stored in config.
 */
export function verifyAdminPassword(password: string, expected: string): boolean {
  if (password.length === 0 || password.length > 1024 || expected.length === 0) return false;
  const actual = Buffer.from(password, 'utf8');
  const configured = Buffer.from(expected, 'utf8');
  return actual.length === configured.length && timingSafeEqual(actual, configured);
}

export class AdminSessionManager {
  private readonly revoked = new Map<string, number>();

  public constructor(private readonly config: AdminApiConfig) {}

  public issue(): Readonly<{ session: AdminSession; cookie: string }> {
    this.prune();
    const session = Object.freeze({
      username: this.config.username,
      expiresAt: Date.now() + this.config.sessionTtlSeconds * 1000,
      csrfToken: randomBytes(32).toString('base64url'),
      nonce: randomBytes(18).toString('base64url'),
    });
    return Object.freeze({ session, cookie: this.serialize(session) });
  }

  public parse(cookieHeader: string | undefined): AdminSession | undefined {
    this.prune();
    const token = parseCookie(cookieHeader, this.config.cookieName);
    if (!token) return undefined;
    const separator = token.lastIndexOf('.');
    if (separator < 1) return undefined;
    const payload = token.slice(0, separator);
    const suppliedSignature = token.slice(separator + 1);
    const expectedSignature = this.sign(payload);
    if (!safeEqual(suppliedSignature, expectedSignature)) return undefined;
    try {
      const session = sessionSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown);
      if (
        session.username !== this.config.username ||
        session.expiresAt <= Date.now() ||
        this.revoked.has(session.nonce)
      ) return undefined;
      return Object.freeze(session);
    } catch {
      return undefined;
    }
  }

  public revoke(session: AdminSession): void {
    this.revoked.set(session.nonce, session.expiresAt);
    this.prune();
  }

  public clearCookie(): string {
    return `${this.config.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.config.cookieSecure ? '; Secure' : ''}`;
  }

  private serialize(session: AdminSession): string {
    const payload = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
    const token = `${payload}.${this.sign(payload)}`;
    return `${this.config.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${this.config.sessionTtlSeconds}${this.config.cookieSecure ? '; Secure' : ''}`;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.config.sessionSecret).update(payload).digest('base64url');
  }

  private prune(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.revoked) if (expiresAt <= now) this.revoked.delete(nonce);
    while (this.revoked.size > 10_000) this.revoked.delete(this.revoked.keys().next().value as string);
  }
}

export class LoginRateLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  public constructor(private readonly maxAttempts: number, private readonly windowMs: number) {}

  public consume(key: string): boolean {
    this.prune();
    const now = Date.now();
    const current = this.attempts.get(key);
    if (!current || current.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= this.maxAttempts;
  }

  public clear(key: string): void {
    this.attempts.delete(key);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, value] of this.attempts) if (value.resetAt <= now) this.attempts.delete(key);
    while (this.attempts.size > 1000) this.attempts.delete(this.attempts.keys().next().value as string);
  }
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header || header.length > 8192) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
