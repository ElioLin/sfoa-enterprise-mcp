import { createHash, timingSafeEqual } from 'node:crypto';
import {
  hashUserBoundToken,
  platformUserIdSchema,
  USER_BOUND_TOKEN_PREFIX,
  type IdentityCredentialRepository,
  type IdentityRouteRepository,
  type IdentitySource,
} from '@sfoa/control-plane';
import type { RequestHeaders, RuntimeLogEvent } from '@sfoa/identity-runtime';
import { IdentityRuntimeError, type RuntimeLogger } from '@sfoa/identity-runtime';
import {
  buntuTokenFingerprint,
  buntuTokenLast4,
  type BuntuTokenValidator,
  type BuntuValidationErrorCode,
  type BuntuValidationResult,
} from './buntu-validator.js';
import {
  DEFAULT_BUNTU_VALIDATION_CACHE_MAX_ENTRIES,
  InMemoryBuntuValidationCache,
  type BuntuTokenValidationCache,
  type BuntuValidationCacheEntry,
} from './buntu-validation-cache.js';
import { RemoteRuntimeError } from './errors.js';

export type AuthenticatedClient = Readonly<{
  clientId: string;
}>;

export interface ClientAuthenticator {
  authenticate(headers: RequestHeaders): AuthenticatedClient;
}

export type CredentialAuthentication = Readonly<{
  clientId: string;
  identitySource: IdentitySource;
  boundPlatformUserId?: string;
  credentialId?: string;
  afterAuthenticated?: () => Promise<void>;
}>;

/** Extension point for USER_BOUND today and BUNTU or another credential family later. */
export interface CredentialAuthenticator {
  supports(token: string | undefined): boolean;
  authenticate(token: string | undefined, correlationId: string): Promise<CredentialAuthentication>;
}

export type AuthenticatedPrincipal = Readonly<{
  clientId: string;
  identitySource: IdentitySource;
  platformUserId: string;
  credentialId?: string;
  correlationId: string;
}>;

export interface IdentityProvider {
  authenticate(
    headers: RequestHeaders,
    platformUserHeaderName: string,
    correlationId: string,
  ): Promise<AuthenticatedPrincipal>;
}

export class InternalBearerAuthenticator implements ClientAuthenticator {
  private readonly expectedDigest: Buffer;

  public constructor(token: string) {
    if (token.length === 0) {
      throw new RemoteRuntimeError(
        'MCP_RUNTIME_CONFIGURATION_INVALID',
        'MCP_CLIENT_TOKEN must be configured when internal Bearer authentication is enabled.',
      );
    }
    this.expectedDigest = digest(token);
  }

  public authenticate(headers: RequestHeaders): AuthenticatedClient {
    const authorization = getSingleHeader(headers, 'authorization');
    if (authorization === undefined || authorization.trim().length === 0) {
      throw new RemoteRuntimeError(
        'MCP_CLIENT_AUTH_REQUIRED',
        'Authorization: Bearer credentials are required for this MCP endpoint.',
      );
    }

    const match = /^Bearer\s+([^\s]+)$/iu.exec(authorization.trim());
    if (!match?.[1] || !this.matches(match[1])) {
      throw new RemoteRuntimeError(
        'MCP_CLIENT_AUTH_INVALID',
        'The MCP client Bearer credential is invalid.',
      );
    }

    return Object.freeze({ clientId: 'internal-bearer' });
  }

  /** Timing-safe exact-token comparison used by deterministic provider routing. */
  public matches(token: string): boolean {
    return timingSafeEqual(this.expectedDigest, digest(token));
  }
}

export class DisabledLoopbackAuthenticator implements ClientAuthenticator {
  public authenticate(_headers: RequestHeaders): AuthenticatedClient {
    return Object.freeze({ clientId: 'development-loopback' });
  }
}

export class InternalServiceCredentialAuthenticator implements CredentialAuthenticator {
  private readonly authenticator: InternalBearerAuthenticator;

  public constructor(token: string) {
    this.authenticator = new InternalBearerAuthenticator(token);
  }

  /**
   * Deterministic exclusivity: only an exact timing-safe match of MCP_CLIENT_TOKEN
   * claims this provider. USER_BOUND tokens and arbitrary third-party tokens are
   * deliberately never claimed here.
   */
  public supports(token: string | undefined): boolean {
    return token !== undefined
      && !token.startsWith(USER_BOUND_TOKEN_PREFIX)
      && this.authenticator.matches(token);
  }

  public async authenticate(token: string | undefined, _correlationId: string): Promise<CredentialAuthentication> {
    const client = this.authenticator.authenticate(token === undefined ? {} : { authorization: `Bearer ${token}` });
    return Object.freeze({
      clientId: client.clientId,
      identitySource: 'INTERNAL_SERVICE_HEADER' as const,
    });
  }
}

export class DisabledLoopbackCredentialAuthenticator implements CredentialAuthenticator {
  public supports(token: string | undefined): boolean {
    return token === undefined || !token.startsWith(USER_BOUND_TOKEN_PREFIX);
  }

  public async authenticate(_token: string | undefined, _correlationId: string): Promise<CredentialAuthentication> {
    return Object.freeze({
      clientId: 'development-loopback',
      identitySource: 'INTERNAL_SERVICE_HEADER' as const,
    });
  }
}

export class UserBoundCredentialAuthenticator implements CredentialAuthenticator {
  public constructor(
    private readonly credentials: IdentityCredentialRepository,
    private readonly routes: IdentityRouteRepository,
    private readonly logger: RuntimeLogger,
  ) {}

  public supports(token: string | undefined): boolean {
    return token?.startsWith(USER_BOUND_TOKEN_PREFIX) ?? false;
  }

  public async authenticate(token: string | undefined, correlationId: string): Promise<CredentialAuthentication> {
    if (!token || !this.supports(token)) throw invalidUserBoundCredential(correlationId);
    const credential = await this.credentials.getByTokenHash(hashUserBoundToken(token));
    if (!credential || credential.credentialType !== 'USER_BOUND') throw invalidUserBoundCredential(correlationId);
    if (credential.status !== 'ACTIVE') {
      throw new RemoteRuntimeError(
        'MCP_IDENTITY_CREDENTIAL_REVOKED',
        'The USER_BOUND credential has been revoked. Generate a replacement credential in the Admin console.',
        { correlationId },
      );
    }
    const route = await this.routes.getById(credential.identityRouteId);
    if (!route) throw invalidUserBoundCredential(correlationId);
    if (!route.enabled) {
      throw new RemoteRuntimeError(
        'MCP_IDENTITY_ROUTE_DISABLED',
        'The identity route bound to this credential is disabled.',
        { correlationId },
      );
    }
    return Object.freeze({
      clientId: 'user-bound-token',
      identitySource: 'USER_BOUND_TOKEN' as const,
      boundPlatformUserId: route.platformUserId,
      credentialId: credential.id,
      afterAuthenticated: async () => {
        try {
          await this.credentials.markLastUsed(credential.id, new Date());
        } catch {
          await Promise.resolve(this.logger.log({
            correlationId,
            clientId: 'user-bound-token',
            platformUserId: route.platformUserId,
            identitySource: 'USER_BOUND_TOKEN',
            identityCredentialId: credential.id,
            result: 'ERROR',
            errorCode: 'MCP_IDENTITY_CREDENTIAL_USAGE_PERSIST_FAILED',
          })).catch(() => undefined);
        }
      },
    });
  }
}

export const BUNTU_CLIENT_ID = 'xiaoben-buntu-token';

export type BuntuTokenCredentialAuthenticatorOptions = Readonly<{
  validator: BuntuTokenValidator;
  routes: IdentityRouteRepository;
  logger: RuntimeLogger;
  /** MCP_CLIENT_TOKEN used for deterministic exclusivity; compared with timing-safe digest. */
  clientToken: string;
  validateTokenUrl: string;
  rawTokenAuditEnabled?: boolean;
  /**
   * In-process validation cache. Defaults to a bounded LRU
   * (`InMemoryBuntuValidationCache`, max 1000 entries). Pass a no-op cache to
   * disable reuse. The cache is per-authenticator-instance (per MCP server
   * process) and is never shared across requests/roles.
   */
  validationCache?: BuntuTokenValidationCache;
  /** Epoch-ms clock used to decide cache expiry; injectable for deterministic tests. */
  nowMs?: () => number;
}>;

type BuntuSensitiveAuditLogger = RuntimeLogger & Readonly<{
  logBuntuTokenValidation?: (event: RuntimeLogEvent, rawToken: string) => void | Promise<void>;
}>;

export class BuntuTokenCredentialAuthenticator implements CredentialAuthenticator {
  private readonly expectedClientDigest: Buffer;
  private readonly validationCache: BuntuTokenValidationCache;
  private readonly now: () => number;
  /**
   * Single-flight guard: coalesces concurrent validations of the same token so
   * only the leading request talks to the upstream and writes the audit.
   * Bounded in practice by concurrent distinct-token validations; each entry is
   * removed as soon as its validation settles.
   */
  private readonly inFlight = new Map<string, Promise<BuntuValidationResult>>();

  public constructor(private readonly options: BuntuTokenCredentialAuthenticatorOptions) {
    this.expectedClientDigest = digest(options.clientToken);
    this.validationCache = options.validationCache
      ?? new InMemoryBuntuValidationCache({
        maxEntries: DEFAULT_BUNTU_VALIDATION_CACHE_MAX_ENTRIES,
      });
    this.now = options.nowMs ?? (() => Date.now());
  }

  /**
   * Deterministic exclusivity: claims any defined token that is neither a
   * USER_BOUND credential nor an exact match of MCP_CLIENT_TOKEN. The Buntu
   * provider is only wired when MCP_BUNTU_IDENTITY_ENABLED=true, so no other
   * provider overlaps with this predicate.
   */
  public supports(token: string | undefined): boolean {
    return token !== undefined
      && !token.startsWith(USER_BOUND_TOKEN_PREFIX)
      && !timingSafeEqual(this.expectedClientDigest, digest(token));
  }

  /**
   * Validates a Buntu bearer token and resolves the bound platform user id.
   *
   * A previously validated token whose upstream `expiresAt` has not passed is
   * reused from the in-process cache without another upstream call. A cache hit
   * performs NO live validation and writes NO `IDENTITY_VALIDATION` audit, so a
   * single MCP interaction (several stateless HTTP POSTs sharing one token) no
   * longer emits a validation audit per POST. The resolved identity route is
   * still read from the Control Plane on every request, so route enable/disable
   * takes effect immediately. Token-level revocation is bounded by the token's
   * own `expiresAt` (validate-token remains the identity authority; the cache is
   * only a reuse boundary, never a second expiry-enforcement rule).
   */
  public async authenticate(token: string | undefined, correlationId: string): Promise<CredentialAuthentication> {
    if (token === undefined || !this.supports(token)) {
      throw new RemoteRuntimeError(
        'MCP_CLIENT_AUTH_INVALID',
        'The MCP client Bearer credential is invalid.',
        { correlationId },
      );
    }

    const fingerprint = buntuTokenFingerprint(token);
    const nowMs = this.now();
    const cached = this.readCachedUserId(fingerprint, nowMs);
    let platformUserId: string;
    if (cached !== undefined) {
      // Cache hit: reuse the already-validated identity. No upstream call, no audit.
      platformUserId = cached;
    } else {
      const { result, leader } = await this.resolveLiveValidation(token, fingerprint, correlationId);
      if (!result.valid) {
        if (leader) await this.logValidateAudit(token, result, correlationId);
        throw buntuValidationError(result.errorCode ?? 'MCP_BUNTU_IDENTITY_UNAVAILABLE', correlationId);
      }
      const parsedUserId = platformUserIdSchema.parse(result.userId);
      if (leader) {
        // Store before awaiting the audit so concurrent followers and the next
        // POST observe the cache immediately.
        this.cacheValidated(fingerprint, parsedUserId, result, nowMs);
        await this.logValidateAudit(token, result, correlationId);
      }
      platformUserId = parsedUserId;
    }

    const route = await this.options.routes.getByPlatformUserId(platformUserId);
    if (!route) {
      throw new IdentityRuntimeError(
        'MCP_IDENTITY_ROUTE_NOT_FOUND',
        'No Salesforce identity route exists for the authenticated platform user. Ask an administrator to configure the route.',
        { correlationId },
      );
    }
    if (!route.enabled) {
      throw new RemoteRuntimeError(
        'MCP_IDENTITY_ROUTE_DISABLED',
        'The identity route for the authenticated platform user is disabled.',
        { correlationId },
      );
    }

    return Object.freeze({
      clientId: BUNTU_CLIENT_ID,
      identitySource: 'BUNTU_TOKEN' as const,
      boundPlatformUserId: platformUserId,
    });
  }

  /** Returns the cached bound platform user id for a live (non-expired) entry, else undefined. */
  private readCachedUserId(fingerprint: string, nowMs: number): string | undefined {
    return this.validationCache.get(fingerprint, nowMs)?.userId;
  }

  /**
   * Stores a validated identity only when the upstream supplied a usable
   * `expiresAt` that lies in the future. Absent/non-finite/past expiries are
   * deliberately not cached: without a trustworthy reuse boundary the safest
   * choice is to keep validating.
   */
  private cacheValidated(
    fingerprint: string,
    userId: string,
    result: BuntuValidationResult,
    nowMs: number,
  ): void {
    const expiresAtSeconds = result.expiresAtSeconds;
    if (expiresAtSeconds === undefined || !Number.isSafeInteger(expiresAtSeconds)) return;
    const expiresAtMs = expiresAtSeconds * 1000;
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) return;
    const entry: BuntuValidationCacheEntry = { userId, expiresAtMs, cachedAtMs: nowMs };
    this.validationCache.set(fingerprint, Object.freeze(entry));
  }

  /**
   * Single-flight live validation: concurrent requests presenting the same token
   * share one upstream validation. The request that created the in-flight entry
   * is the leader (it owns the audit write and cache store); followers reuse the
   * same result without producing additional audits.
   */
  private async resolveLiveValidation(
    token: string,
    fingerprint: string,
    correlationId: string,
  ): Promise<Readonly<{ result: BuntuValidationResult; leader: boolean }>> {
    const existing = this.inFlight.get(fingerprint);
    if (existing) {
      return { result: await existing, leader: false };
    }
    const task = this.options.validator.validate(token, correlationId);
    this.inFlight.set(fingerprint, task);
    try {
      return { result: await task, leader: true };
    } finally {
      this.inFlight.delete(fingerprint);
    }
  }

  private async logValidateAudit(
    rawToken: string,
    result: BuntuValidationResult,
    correlationId: string,
  ): Promise<void> {
    const invalidResponse = result.errorCode === 'MCP_BUNTU_IDENTITY_RESPONSE_INVALID'
      || result.errorCode === 'MCP_BUNTU_IDENTITY_UNAVAILABLE';
    const requestSummary = {
      provider: 'BUNTU',
      tokenFingerprint: buntuTokenFingerprint(rawToken),
      tokenLast4: buntuTokenLast4(rawToken),
      validationUrl: this.options.validateTokenUrl,
    };
    const responseSummary = {
      valid: result.valid,
      ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
      ...(result.upstreamSuccess !== undefined ? { upstreamSuccess: result.upstreamSuccess } : {}),
      ...(result.userId ? { userId: result.userId } : {}),
      ...(result.userIdType ? { userIdType: result.userIdType } : {}),
      ...(result.expiresAtSeconds !== undefined ? { expiresAtSeconds: result.expiresAtSeconds } : {}),
    };
    try {
      const event: RuntimeLogEvent = {
        correlationId,
        clientId: BUNTU_CLIENT_ID,
        ...(result.userId ? { platformUserId: result.userId } : {}),
        identitySource: 'BUNTU_TOKEN',
        operation: 'BUNTU_TOKEN_VALIDATE',
        result: result.valid ? 'PASS' : invalidResponse ? 'ERROR' : 'BLOCKED',
        outcome: result.valid ? 'SUCCESS' : invalidResponse ? 'FAILED' : 'DENIED',
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        durationMs: result.durationMs,
        requestSummary,
        responseSummary,
        auditEvent: {
          eventCategory: 'IDENTITY',
          eventType: 'IDENTITY_VALIDATION',
          eventName: 'Buntu token validation',
        },
      };
      const logger = this.options.logger as BuntuSensitiveAuditLogger;
      if (this.options.rawTokenAuditEnabled && logger.logBuntuTokenValidation) {
        // 原始 Token 只交给具备专用 durable 方法的审计 Logger。通用 RuntimeLogger
        // 永远只看到安全摘要，避免 stdout/stderr 或测试替代 Logger 意外输出机密。
        await logger.logBuntuTokenValidation(event, rawToken);
      } else {
        await logger.log(event);
      }
    } catch {
      // Audit persistence is observational. A validation outcome must not be
      // altered by an audit sink failure; the request-level audit path covers this.
    }
  }
}

export class UnifiedIdentityProvider implements IdentityProvider {
  public constructor(private readonly authenticators: readonly CredentialAuthenticator[]) {
    if (authenticators.length === 0) {
      throw new RemoteRuntimeError(
        'MCP_RUNTIME_CONFIGURATION_INVALID',
        'At least one credential authenticator must be configured.',
      );
    }
  }

  public async authenticate(
    headers: RequestHeaders,
    platformUserHeaderName: string,
    correlationId: string,
  ): Promise<AuthenticatedPrincipal> {
    const token = parseBearerToken(headers, correlationId);
    const authenticator = this.authenticators.find((candidate) => candidate.supports(token));
    if (!authenticator) {
      throw new RemoteRuntimeError('MCP_CLIENT_AUTH_INVALID', 'The MCP client Bearer credential is invalid.', { correlationId });
    }
    const credential = await authenticator.authenticate(token, correlationId);
    const headerValue = getSingleHeader(headers, platformUserHeaderName.toLocaleLowerCase('en-US'));
    const platformUserId = credential.boundPlatformUserId
      ? validateOptionalBoundHeader(headerValue, platformUserHeaderName, credential.boundPlatformUserId, correlationId)
      : validateRequiredPlatformHeader(headerValue, platformUserHeaderName, correlationId);
    await credential.afterAuthenticated?.();
    return Object.freeze({
      clientId: credential.clientId,
      identitySource: credential.identitySource,
      platformUserId,
      ...(credential.credentialId ? { credentialId: credential.credentialId } : {}),
      correlationId,
    });
  }
}

export class LegacyHeaderIdentityProvider extends UnifiedIdentityProvider {
  public constructor(authenticator: ClientAuthenticator) {
    super([new LegacyClientCredentialAuthenticator(authenticator)]);
  }
}

class LegacyClientCredentialAuthenticator implements CredentialAuthenticator {
  public constructor(private readonly authenticator: ClientAuthenticator) {}

  public supports(_token: string | undefined): boolean { return true; }

  public async authenticate(token: string | undefined, _correlationId: string): Promise<CredentialAuthentication> {
    const client = this.authenticator.authenticate(token === undefined ? {} : { authorization: `Bearer ${token}` });
    return Object.freeze({ clientId: client.clientId, identitySource: 'INTERNAL_SERVICE_HEADER' as const });
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function parseBearerToken(headers: RequestHeaders, correlationId: string): string | undefined {
  const authorization = getSingleHeader(headers, 'authorization');
  if (authorization === undefined || authorization.trim().length === 0) return undefined;
  const token = /^Bearer\s+([^\s]+)$/iu.exec(authorization.trim())?.[1];
  if (!token) {
    throw new RemoteRuntimeError('MCP_CLIENT_AUTH_INVALID', 'The MCP client Bearer credential is invalid.', { correlationId });
  }
  return token;
}

function validateRequiredPlatformHeader(
  value: string | undefined,
  headerName: string,
  correlationId: string,
): string {
  if (value === undefined || value.trim().length === 0) {
    throw new IdentityRuntimeError(
      'MCP_PLATFORM_USER_REQUIRED',
      `${headerName} is required after MCP client authentication.`,
      { correlationId },
    );
  }
  return parsePlatformUserId(value, headerName, correlationId);
}

function validateOptionalBoundHeader(
  value: string | undefined,
  headerName: string,
  boundPlatformUserId: string,
  correlationId: string,
): string {
  if (value === undefined || value.trim().length === 0) return boundPlatformUserId;
  const requestedPlatformUserId = parsePlatformUserId(value, headerName, correlationId);
  if (requestedPlatformUserId !== boundPlatformUserId) {
    throw new IdentityRuntimeError(
      'MCP_IDENTITY_CONTEXT_MISMATCH',
      `${headerName} does not match the platform identity bound to the supplied credential.`,
      { correlationId },
    );
  }
  return boundPlatformUserId;
}

function parsePlatformUserId(value: string, headerName: string, correlationId: string): string {
  const parsed = platformUserIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new IdentityRuntimeError(
      'MCP_REQUEST_SCOPE_FAILED',
      `${headerName} must contain 1-128 printable characters.`,
      { correlationId },
    );
  }
  return parsed.data;
}

function invalidUserBoundCredential(correlationId: string): RemoteRuntimeError {
  return new RemoteRuntimeError(
    'MCP_IDENTITY_CREDENTIAL_INVALID',
    'The USER_BOUND credential is invalid.',
    { correlationId },
  );
}

function buntuValidationError(code: BuntuValidationErrorCode, correlationId: string): RemoteRuntimeError {
  return new RemoteRuntimeError(code, buntuValidationMessage(code), { correlationId });
}

function buntuValidationMessage(code: BuntuValidationErrorCode): string {
  switch (code) {
    case 'MCP_BUNTU_TOKEN_INVALID':
      return 'The Buntu token was rejected by the identity provider.';
    case 'MCP_BUNTU_IDENTITY_UNAVAILABLE':
      return 'The Buntu identity provider is currently unavailable. Retry the request later.';
    case 'MCP_BUNTU_IDENTITY_RESPONSE_INVALID':
      return 'The Buntu identity provider returned an invalid identity response.';
  }
}

function getSingleHeader(headers: RequestHeaders, targetName: string): string | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLocaleLowerCase('en-US') === targetName);
  const value = entry?.[1];
  if (typeof value === 'string' || value === undefined) return value;
  return value.length === 1 ? value[0] : undefined;
}
