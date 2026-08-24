import { createHash, timingSafeEqual } from 'node:crypto';
import {
  hashUserBoundToken,
  platformUserIdSchema,
  USER_BOUND_TOKEN_PREFIX,
  type IdentityCredentialRepository,
  type IdentityRouteRepository,
  type IdentitySource,
} from '@sfoa/control-plane';
import type { RequestHeaders } from '@sfoa/identity-runtime';
import { IdentityRuntimeError, type RuntimeLogger } from '@sfoa/identity-runtime';
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
    if (!match?.[1] || !timingSafeEqual(this.expectedDigest, digest(match[1]))) {
      throw new RemoteRuntimeError(
        'MCP_CLIENT_AUTH_INVALID',
        'The MCP client Bearer credential is invalid.',
      );
    }

    return Object.freeze({ clientId: 'internal-bearer' });
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

  public supports(token: string | undefined): boolean {
    return token === undefined || !token.startsWith(USER_BOUND_TOKEN_PREFIX);
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

function getSingleHeader(headers: RequestHeaders, targetName: string): string | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLocaleLowerCase('en-US') === targetName);
  const value = entry?.[1];
  if (typeof value === 'string' || value === undefined) return value;
  return value.length === 1 ? value[0] : undefined;
}
