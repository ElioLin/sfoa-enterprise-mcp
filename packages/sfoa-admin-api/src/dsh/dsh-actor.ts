import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  hashUserBoundToken,
  USER_BOUND_TOKEN_PREFIX,
  type DshScenarioActor,
  type DshScenarioAuthDto,
  type IdentityCredentialRepository,
  type IdentityRouteRepository,
} from '@sfoa/control-plane';
import type { BuntuTokenValidator } from '@sfoa/mcp-server';
import type { AdminSession, AdminSessionManager } from '../auth.js';
import type { AdminAccount } from '../config.js';

/**
 * DSH scenario actor resolution (DSH-01).
 *
 * The plugin cannot rely on one request header: an Electron renderer, a background worker and a
 * browser tab differ in their ability to attach an Authorization header, and some plugin hosts
 * strip it at the shell boundary. The resolver therefore accepts the same identity from four
 * places, in the documented order, and every one of them ends in the *same* decision: a
 * `platformUserId`, then one `sfoa_identity_route` row, then that row's
 * `can_manage_dsh_scenarios` bit.
 *
 *  1. `Authorization: Bearer <token>` / `X-Buntu-Token` header / `buntuToken` query or body field.
 *     A `sfoa_ub1_…` value is a USER_BOUND credential and is resolved by digest; anything else is
 *     forwarded to the configured Buntu validate-token endpoint, exactly as the MCP runtime does.
 *  2. The signed Admin Console session cookie. An Admin session is an operator, so it may manage
 *     scenarios, but it stays bounded by its Console module list.
 *  3. A platform identity header — only when this deployment runs `internal_bearer` and the same
 *     request presents the shared MCP client token. Without that token the header is a spoofable
 *     string and is ignored, which is what keeps priority 3 from becoming a bypass.
 *
 * Failure is never fatal for reads: an unknown, expired or absent credential resolves to
 * `authenticated: false` and the caller still receives the published catalogue.
 */

export type DshIdentitySource = 'USER_BOUND_TOKEN' | 'BUNTU_TOKEN' | 'ADMIN_SESSION' | 'PLATFORM_HEADER' | 'NONE';

export type DshActorResolution = Readonly<{
  auth: DshScenarioAuthDto;
  actor: DshScenarioActor;
  source: DshIdentitySource;
  session: AdminSession | null;
  account: AdminAccount | null;
  /**
   * Safe diagnostic for a credential that was present but not accepted. Never contains the token
   * itself; surfaced only in server logs.
   */
  tokenError: Readonly<{ code: string; message: string }> | null;
}>;

export type DshActorResolverDeps = Readonly<{
  sessions: AdminSessionManager;
  identityRoutes: Pick<IdentityRouteRepository, 'getByPlatformUserId' | 'getById'>;
  credentials: Pick<IdentityCredentialRepository, 'getByTokenHash'>;
  buntuValidator?: BuntuTokenValidator;
  /** Ordered allowlist from `MCP_PLATFORM_USER_HEADER` + aliases. */
  platformIdentityHeaders: readonly string[];
  authMode: 'internal_bearer' | 'disabled';
  clientToken?: string;
}>;

/** The Console module that owns every `/api/dsh/**` operation reached through a session. */
export const DSH_SCENARIO_ADMIN_MODULE = 'standard-scenarios';

export async function resolveDshScenarioActor(
  request: IncomingMessage,
  url: URL,
  deps: DshActorResolverDeps,
  options: Readonly<{ bodyToken?: string; correlationId: string }>,
): Promise<DshActorResolution> {
  const token = extractDshToken(request, url, options.bodyToken);
  let tokenError: DshActorResolution['tokenError'] = null;

  if (token) {
    const credential = await resolveTokenIdentity(token, deps, options.correlationId);
    if (credential.platformUserId) {
      return finalize(credential.platformUserId, credential.source, deps, null, null, null);
    }
    tokenError = credential.error;
  }

  const session = deps.sessions.parse(singleHeader(request.headers.cookie));
  const account = session ? deps.sessions.accountFor(session) : undefined;
  if (session && account) {
    return finalize(null, 'ADMIN_SESSION', deps, session, account, tokenError);
  }

  // Priority 3: only a request that proved possession of the deployment's shared token may name
  // its own platform user. Anything else is an unauthenticated header and is discarded here.
  if (deps.authMode === 'internal_bearer' && deps.clientToken && token && tokenMatches(token, deps.clientToken)) {
    const headerUserId = readPlatformUserHeader(request, deps.platformIdentityHeaders);
    if (headerUserId) {
      return finalize(headerUserId, 'PLATFORM_HEADER', deps, null, null, tokenError);
    }
  }

  return Object.freeze({
    auth: Object.freeze({
      authenticated: false,
      platformUserId: null,
      crmUsername: null,
      canManageStandardScenario: false,
    }),
    actor: Object.freeze({ platformUserId: null, crmUsername: null, adminUsername: null }),
    source: 'NONE' as const,
    session: null,
    account: null,
    tokenError,
  });
}

/**
 * Turns a resolved platform user (or an Admin session) into the permission answer every endpoint
 * uses. A disabled route authenticates nobody for write purposes: the route *is* the grant, and a
 * disabled route grants nothing even while its capability bit is still set.
 */
async function finalize(
  platformUserId: string | null,
  source: DshIdentitySource,
  deps: DshActorResolverDeps,
  session: AdminSession | null,
  account: AdminAccount | null,
  tokenError: DshActorResolution['tokenError'],
): Promise<DshActorResolution> {
  if (source === 'ADMIN_SESSION' && account) {
    const allowed = account.fullAccess || account.modules.includes(DSH_SCENARIO_ADMIN_MODULE);
    return Object.freeze({
      auth: Object.freeze({
        authenticated: true,
        platformUserId: null,
        crmUsername: null,
        canManageStandardScenario: allowed,
      }),
      actor: Object.freeze({ platformUserId: null, crmUsername: null, adminUsername: account.username }),
      source,
      session,
      account,
      tokenError,
    });
  }

  const route = platformUserId === null ? undefined : await deps.identityRoutes.getByPlatformUserId(platformUserId);
  const active = route?.enabled === true;
  return Object.freeze({
    auth: Object.freeze({
      authenticated: active,
      platformUserId: active ? platformUserId : null,
      crmUsername: active ? route?.salesforceUsername ?? null : null,
      canManageStandardScenario: active && route?.canManageDshScenarios === true,
    }),
    actor: Object.freeze({
      platformUserId: active ? platformUserId : null,
      crmUsername: active ? route?.salesforceUsername ?? null : null,
      adminUsername: null,
    }),
    source: active ? source : 'NONE',
    session: null,
    account: null,
    tokenError,
  });
}

type TokenIdentity =
  | Readonly<{ platformUserId: string; source: DshIdentitySource; error: null }>
  | Readonly<{ platformUserId: null; source: 'NONE'; error: Readonly<{ code: string; message: string }> | null }>;

async function resolveTokenIdentity(
  token: string,
  deps: DshActorResolverDeps,
  correlationId: string,
): Promise<TokenIdentity> {
  if (token.startsWith(USER_BOUND_TOKEN_PREFIX)) {
    const credential = await deps.credentials.getByTokenHash(hashUserBoundToken(token));
    if (!credential || credential.status !== 'ACTIVE') {
      return Object.freeze({
        platformUserId: null,
        source: 'NONE' as const,
        error: Object.freeze({
          code: 'DSH_SCENARIO_TOKEN_INVALID',
          message: 'The supplied MCP user credential is not active.',
        }),
      });
    }
    const route = await deps.identityRoutes.getById(credential.identityRouteId);
    if (!route) {
      return Object.freeze({
        platformUserId: null,
        source: 'NONE' as const,
        error: Object.freeze({
          code: 'DSH_SCENARIO_TOKEN_INVALID',
          message: 'The credential is not bound to an existing identity route.',
        }),
      });
    }
    return Object.freeze({ platformUserId: route.platformUserId, source: 'USER_BOUND_TOKEN' as const, error: null });
  }

  if (!deps.buntuValidator) {
    return Object.freeze({
      platformUserId: null,
      source: 'NONE' as const,
      error: Object.freeze({
        code: 'DSH_SCENARIO_IDENTITY_UNAVAILABLE',
        message: 'Buntu token validation is not configured on this deployment.',
      }),
    });
  }
  const result = await deps.buntuValidator.validate(token, correlationId);
  if (!result.valid || !result.userId) {
    return Object.freeze({
      platformUserId: null,
      source: 'NONE' as const,
      error: Object.freeze({
        code: result.errorCode ?? 'DSH_SCENARIO_IDENTITY_UNAVAILABLE',
        message: 'The supplied Buntu token was not accepted by the identity service.',
      }),
    });
  }
  return Object.freeze({ platformUserId: result.userId, source: 'BUNTU_TOKEN' as const, error: null });
}

/** Accepted token carriers, in order. The first non-empty value wins; they are never merged. */
export function extractDshToken(request: IncomingMessage, url: URL, bodyToken?: string): string | undefined {
  const authorization = singleHeader(request.headers.authorization);
  if (authorization) {
    const match = /^Bearer\s+(\S+)$/iu.exec(authorization.trim());
    if (match?.[1]) return match[1];
  }
  const buntuHeader = singleHeader(request.headers['x-buntu-token']);
  if (buntuHeader?.trim()) return buntuHeader.trim();
  const queryToken = url.searchParams.get('buntuToken');
  if (queryToken?.trim()) return queryToken.trim();
  if (bodyToken?.trim()) return bodyToken.trim();
  return undefined;
}

function readPlatformUserHeader(request: IncomingMessage, allowed: readonly string[]): string | undefined {
  for (const name of allowed) {
    const value = singleHeader(request.headers[name.toLocaleLowerCase('en-US')]);
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function tokenMatches(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
