import { randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  ADMIN_API_PREFIX,
  ADMIN_CSRF_HEADER,
  adminAuditQuerySchema,
  adminDiagnosticConfigUpdateSchema,
  adminDmlPolicyCreateSchema,
  adminDmlPolicyUpdateSchema,
  adminManagedDmlFieldRuleCreateSchema,
  adminManagedDmlFieldRuleUpdateSchema,
  adminIdPathSchema,
  adminIdentityCredentialRegenerateSchema,
  adminIdentityRouteBatchCreateSchema,
  adminIdentityRouteBatchVerifySchema,
  adminIdentityRouteCreateSchema,
  adminIdentityRouteListQuerySchema,
  adminIdentityRouteUpdateSchema,
  adminLoginInputSchema,
  adminPaginationQuerySchema,
  adminRuntimeSettingKeySchema,
  adminRuntimeSettingUpdateSchemas,
  adminSoftDisableSchema,
  adminToolControlUpdateSchema,
  adminToolNamePathSchema,
  ControlPlaneAdminService,
  ControlPlaneError,
  type AdminIdentityCredentialResponse,
  type AdminIdentityRouteBatchVerifyResponse,
  type AdminIdentityRouteBatchVerifyRow,
  type AdminIdentityRouteDto,
  type AuditPersistenceHealth,
  type ControlPlaneRepositoriesWithAuditTrace,
  type DashboardDto,
  type DiagnosticPageDto,
  type DiagnosticVerificationDto,
  type IdentityCredentialRecord,
  type IdentityRouteRecord,
  type MigrationStatus,
  type McpPublicEndpointDto,
  type ProviderVersionDto,
  type SystemStatusDto,
} from '@sfoa/control-plane';
import type { IdentityRuntime } from '@sfoa/identity-runtime';
import type { UpstreamInventoryComparison } from '@sfoa/mcp-server';
import { ZodError, type ZodType } from 'zod';
import { AdminSessionManager, LoginRateLimiter, verifyAdminPassword, type AdminSession } from './auth.js';
import type { AdminApiConfig } from './config.js';
import { AdminHttpError, invalidAdminInput, mapAdminError } from './errors.js';
import { buildAdminToolCatalog } from './tool-catalog.js';
import { buildAdminAuditTrace } from './audit-trace.js';
import { verifyDiagnosticConfig, verifyIdentityRoute } from './verification.js';

const MAX_JSON_BODY_BYTES = 262_144;
const TOOL_CONTROL_PAGE_LIMIT = 100;
const BATCH_VERIFY_CONCURRENCY = 6;

export type McpHealthProbeResult = Readonly<{
  status: 'UP' | 'DOWN' | 'UNKNOWN';
  auditPersistence?: Readonly<{ status: 'UP' | 'DEGRADED'; failureCount: number }>;
}>;

export type AdminSystemRuntimeInfo = Readonly<{
  adminVersion: string;
  mcpServerVersion: string;
  salesforceApiVersion: string;
  providerVersions: readonly ProviderVersionDto[];
  runtimeMode: 'env' | 'mysql';
  salesforceInstanceHost: string;
  connectedAppConfigured: boolean;
  jwtPrivateKeyConfigured: boolean;
  mcpClientTokenConfigured: boolean;
  identityCredentialEncryptionKeyConfigured: boolean;
  mcpEndpoint: string;
  mcpPublicEndpoint: McpPublicEndpointDto;
  readOnlyRuntimeSettings: Readonly<Record<string, string | number | boolean | readonly string[] | null>>;
  phases: SystemStatusDto['phases'];
  /** P6-ID-01 HOTFIX01: build phase marker for mixed-version diagnosis. */
  buildPhase: string;
  /** P6-ID-01 HOTFIX01: capability markers advertised by this Admin API build. */
  capabilities: readonly string[];
}>;

export type StartAdminApiServerOptions = Readonly<{
  config: AdminApiConfig;
  store: Readonly<{
    repositories: ControlPlaneRepositoriesWithAuditTrace;
    health(): Promise<Readonly<{ version: string }>>;
  }>;
  adminService: Pick<
    ControlPlaneAdminService,
    | 'createIdentityRoute'
    | 'batchCreateIdentityRoutes'
    | 'updateIdentityRoute'
    | 'disableIdentityRoute'
    | 'readIdentityCredential'
    | 'regenerateIdentityCredential'
    | 'deleteIdentityRoute'
    | 'updateTool'
    | 'createDmlPolicy'
    | 'updateDmlPolicy'
    | 'disableDmlPolicy'
    | 'createManagedDmlFieldRule'
    | 'updateManagedDmlFieldRule'
    | 'disableManagedDmlFieldRule'
    | 'deleteManagedDmlFieldRule'
    | 'updateDiagnostic'
    | 'recordDiagnosticVerification'
    | 'updateRuntimeSetting'
  >;
  identityRuntime: IdentityRuntime;
  upstream: UpstreamInventoryComparison;
  migrations: readonly MigrationStatus[];
  system: AdminSystemRuntimeInfo;
  auditPersistenceHealth(): AuditPersistenceHealth;
  probeMcpHealth(): Promise<McpHealthProbeResult>;
}>;

export type AdminApiServer = Readonly<{
  baseUrl: URL;
  close(): Promise<void>;
}>;

type RequestContext = Readonly<{
  request: IncomingMessage;
  response: ServerResponse;
  correlationId: string;
  url: URL;
  session?: AdminSession;
}>;

export async function startAdminApiServer(options: StartAdminApiServerOptions): Promise<AdminApiServer> {
  const sessions = new AdminSessionManager(options.config);
  const loginLimiter = new LoginRateLimiter(options.config.loginMaxAttempts, options.config.loginWindowMs);
  const active = new Set<Promise<void>>();
  let closing = false;

  const server = createServer((request, response) => {
    const task = handleRequest(options, sessions, loginLimiter, request, response, () => closing)
      .catch(() => undefined)
      .finally(() => active.delete(task));
    active.add(task);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.listen(options.config.port, options.config.bindHost);
  try {
    await Promise.race([
      once(server, 'listening'),
      once(server, 'error').then(([error]) => Promise.reject(error)),
    ]);
  } catch (error) {
    await closeServerImmediately(server);
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServerImmediately(server);
    throw new Error('Admin API did not expose a TCP address.');
  }
  const baseUrl = new URL(`http://${urlHost(options.config.bindHost)}:${address.port}${ADMIN_API_PREFIX}/`);

  return Object.freeze({
    baseUrl,
    close: async () => {
      if (closing) return;
      closing = true;
      if (server.listening) {
        const closed = once(server, 'close').then(() => undefined);
        server.close();
        server.closeIdleConnections();
        await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
        if (server.listening) server.closeAllConnections();
      }
      await Promise.allSettled([...active]);
    },
  });
}

async function handleRequest(
  options: StartAdminApiServerOptions,
  sessions: AdminSessionManager,
  loginLimiter: LoginRateLimiter,
  request: IncomingMessage,
  response: ServerResponse,
  isClosing: () => boolean,
): Promise<void> {
  const correlationId = randomUUID();
  setSecurityHeaders(response, correlationId);
  try {
    if (isClosing()) throw new AdminHttpError('MCP_ADMIN_NOT_READY', 'The Admin API is shutting down.', 503);
    if (!request.url || request.url.length > 4_096) {
      throw new AdminHttpError('MCP_ADMIN_REQUEST_INVALID', 'The request URL is invalid.', 400);
    }
    const url = new URL(request.url, 'http://sfoa-admin.invalid');
    if (!url.pathname.startsWith(ADMIN_API_PREFIX)) {
      throw new AdminHttpError('MCP_ADMIN_NOT_FOUND', 'Admin endpoint was not found.', 404);
    }
    const context: RequestContext = Object.freeze({ request, response, correlationId, url });

    if (url.pathname === `${ADMIN_API_PREFIX}/health`) {
      assertMethod(request, 'GET');
      assertNoQuery(url);
      writeJson(response, 200, { status: 'UP' });
      return;
    }
    if (url.pathname === `${ADMIN_API_PREFIX}/ready`) {
      assertMethod(request, 'GET');
      assertNoQuery(url);
      try {
        const health = await options.store.health();
        writeJson(response, 200, { status: 'UP', databaseVersion: health.version });
      } catch {
        throw new AdminHttpError('MCP_ADMIN_NOT_READY', 'The Admin database or schema is not ready.', 503);
      }
      return;
    }
    if (url.pathname === `${ADMIN_API_PREFIX}/auth/login`) {
      await handleLogin(options, sessions, loginLimiter, context);
      return;
    }

    assertOptionalOrigin(request, options.config.allowedOrigin);
    const session = sessions.parse(singleHeader(request.headers.cookie));
    if (!session) throw new AdminHttpError('MCP_ADMIN_AUTH_REQUIRED', 'A valid Admin session is required.', 401);
    const authenticated = Object.freeze({ ...context, session });

    if (url.pathname === `${ADMIN_API_PREFIX}/auth/me`) {
      assertMethod(request, 'GET');
      assertNoQuery(url);
      writeJson(response, 200, sessionDto(session));
      return;
    }
    if (url.pathname === `${ADMIN_API_PREFIX}/auth/logout`) {
      assertMethod(request, 'POST');
      assertMutationGuards(request, options.config.allowedOrigin, session);
      assertNoQuery(url);
      sessions.revoke(session);
      response.setHeader('Set-Cookie', sessions.clearCookie());
      writeJson(response, 200, { status: 'LOGGED_OUT' });
      return;
    }

    if (isMutation(request.method)) assertMutationGuards(request, options.config.allowedOrigin, session);
    await dispatchAuthenticated(options, authenticated as RequestContext & Readonly<{ session: AdminSession }>);
  } catch (error) {
    const mapped = mapAdminError(error, options.identityRuntime.redactionSecrets);
    if (!response.headersSent) {
      if (mapped.status === 401) response.setHeader('WWW-Authenticate', 'SFOA-Admin-Session');
      writeJson(response, mapped.status, {
        error: {
          code: mapped.code,
          message: mapped.message,
          ...(mapped.issues ? { issues: mapped.issues } : {}),
        },
        correlationId,
      });
    } else {
      response.destroy();
    }
    process.stderr.write(`${JSON.stringify({ level: 'error', channel: 'ADMIN', code: mapped.code, correlationId })}\n`);
  }
}

async function handleLogin(
  options: StartAdminApiServerOptions,
  sessions: AdminSessionManager,
  limiter: LoginRateLimiter,
  context: RequestContext,
): Promise<void> {
  assertMethod(context.request, 'POST');
  assertExactOrigin(context.request, options.config.allowedOrigin);
  assertNoQuery(context.url);
  const rateKey = context.request.socket.remoteAddress ?? 'unknown';
  if (!limiter.consume(rateKey)) {
    throw new AdminHttpError('MCP_ADMIN_LOGIN_RATE_LIMITED', 'Too many login attempts. Retry after the configured window.', 429);
  }
  const input = parseWithSchema(adminLoginInputSchema, await readJsonBody(context.request));
  const usernameValid = safeTextEqual(input.username, options.config.username);
  const passwordValid = verifyAdminPassword(input.password, options.config.password);
  if (!usernameValid || !passwordValid) {
    throw new AdminHttpError('MCP_ADMIN_AUTH_INVALID', 'The Admin username or password is invalid.', 401);
  }
  limiter.clear(rateKey);
  const issued = sessions.issue();
  await appendAdminEvent(options, {
    correlationId: context.correlationId,
    actorAdmin: issued.session.username,
    operation: 'ADMIN_LOGIN',
    result: 'PASS',
    outcome: 'SUCCESS',
  });
  context.response.setHeader('Set-Cookie', issued.cookie);
  writeJson(context.response, 200, sessionDto(issued.session));
}

async function dispatchAuthenticated(
  options: StartAdminApiServerOptions,
  context: RequestContext & Readonly<{ session: AdminSession }>,
): Promise<void> {
  const { request, response, url, session, correlationId } = context;
  const path = url.pathname;

  if (path === `${ADMIN_API_PREFIX}/dashboard`) {
    assertMethod(request, 'GET');
    assertNoQuery(url);
    const since = new Date(Date.now() - 86_400_000);
    const [database, mcp, routeCount, toolControls, dmlPolicyObjectCount, diagnostic, calls24h, latestErrors] = await Promise.all([
      options.store.health(),
      options.probeMcpHealth(),
      options.store.repositories.identityRoutes.countActive(),
      options.store.repositories.tools.list({ limit: TOOL_CONTROL_PAGE_LIMIT, offset: 0 }),
      options.store.repositories.dmlPolicies.countEnabled(),
      options.store.repositories.diagnostic.get(),
      options.store.repositories.audits.countSince(since),
      options.store.repositories.audits.search({ result: 'ERROR', limit: 10, offset: 0 }),
    ]);
    const enabledToolCount = buildAdminToolCatalog(toolControls.items, options.upstream)
      .filter((tool) => tool.enabled && tool.status === 'AVAILABLE').length;
    const body: DashboardDto = Object.freeze({
      runtimeHealth: mcp.status,
      databaseHealth: database.version ? 'UP' : 'DOWN',
      upstreamDrift: options.upstream.status,
      routeCount,
      enabledToolCount,
      dmlPolicyObjectCount,
      diagnostic: diagnostic ?? null,
      calls24h,
      latestErrors: latestErrors.items,
      providerVersions: options.system.providerVersions,
    });
    writeJson(response, 200, body);
    return;
  }

  if (path === `${ADMIN_API_PREFIX}/routes`) {
    if (request.method === 'GET') {
      const query = parseWithSchema(adminIdentityRouteListQuerySchema, queryObject(url));
      const page = await options.store.repositories.identityRoutes.list({
        ...(query.keyword ? { keyword: query.keyword } : {}),
        limit: query.limit ?? 25,
        offset: query.offset ?? 0,
      });
      const credentials = await options.store.repositories.identityCredentials.listActiveByRouteIds(
        page.items.map((route) => route.id),
      );
      const credentialsByRoute = new Map(credentials.map((credential) => [credential.identityRouteId, credential]));
      writeJson(response, 200, Object.freeze({
        ...page,
        items: Object.freeze(page.items.map((route) => toAdminIdentityRoute(route, credentialsByRoute.get(route.id)))),
      }));
      return;
    }
    assertMethod(request, 'POST');
    assertNoQuery(url);
    const input = parseWithSchema(adminIdentityRouteCreateSchema, await readJsonBody(request));
    const created = await options.adminService.createIdentityRoute({
      ...input,
      remark: input.remark ?? null,
    }, session.username);
    writeJson(response, 201, toCredentialResponse(created, options.system.mcpPublicEndpoint));
    return;
  }

  if (path === `${ADMIN_API_PREFIX}/routes/batch`) {
    assertMethod(request, 'POST');
    assertNoQuery(url);
    const input = parseWithSchema(adminIdentityRouteBatchCreateSchema, await readJsonBody(request));
    const result = await options.adminService.batchCreateIdentityRoutes(
      input.routes.map((route) => ({ ...route, remark: route.remark ?? null })),
      session.username,
    );
    writeJson(response, 200, result);
    return;
  }

  if (path === `${ADMIN_API_PREFIX}/routes/batch-verify`) {
    assertMethod(request, 'POST');
    assertNoQuery(url);
    const input = parseWithSchema(adminIdentityRouteBatchVerifySchema, await readJsonBody(request));
    const rows = await verifyIdentityRouteBatch(options, input.ids, session.username, correlationId);
    const body: AdminIdentityRouteBatchVerifyResponse = Object.freeze({ rows });
    writeJson(response, 200, body);
    return;
  }

  const credentialMatch = matchRouteCredentialPath(path);
  if (credentialMatch) {
    const id = parseWithSchema(adminIdPathSchema, credentialMatch.identifier);
    assertNoQuery(url);
    if (credentialMatch.action === 'read') {
      assertMethod(request, 'GET');
      const credential = await options.adminService.readIdentityCredential(id);
      writeJson(response, 200, toCredentialResponse(credential, options.system.mcpPublicEndpoint));
      return;
    }
    assertMethod(request, 'POST');
    const input = parseWithSchema(adminIdentityCredentialRegenerateSchema, await readJsonBody(request));
    const regenerated = await options.adminService.regenerateIdentityCredential(id, input, session.username);
    writeJson(response, 200, toCredentialResponse(regenerated, options.system.mcpPublicEndpoint));
    return;
  }

  const routeMatch = matchResourcePath(path, 'routes');
  if (routeMatch) {
    const id = parseWithSchema(adminIdPathSchema, routeMatch.identifier);
    assertNoQuery(url);
    if (routeMatch.action === 'verify') {
      assertMethod(request, 'POST');
      const route = await options.store.repositories.identityRoutes.getById(id);
      if (!route) throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', 'Identity route was not found.');
      const verification = await verifyIdentityRoute(options.identityRuntime, route, correlationId);
      await appendAdminEvent(options, {
        correlationId,
        actorAdmin: session.username,
        platformUserId: route.platformUserId,
        salesforceUsername: route.salesforceUsername,
        executionRole: 'USER',
        operation: 'VERIFY_IDENTITY_ROUTE',
        recordId: route.id,
        result: verification.status === 'PASS' ? 'PASS' : 'ERROR',
        outcome: verification.status === 'PASS' ? 'SUCCESS' : 'FAILED',
        errorCode: verification.error?.code,
        durationMs: verification.durationMs,
        responseSummary: {
          status: verification.status,
          identityMatched: verification.identityMatched,
          salesforceUsername: verification.salesforceUsername,
        },
      });
      writeJson(response, 200, verification);
      return;
    }
    if (routeMatch.action === 'disable') {
      assertMethod(request, 'POST');
      const input = parseWithSchema(adminSoftDisableSchema, await readJsonBody(request));
      const disabled = await options.adminService.disableIdentityRoute(id, input.rowVersion, session.username);
      const credential = await options.store.repositories.identityCredentials.getActiveByRouteId(id);
      writeJson(response, 200, toAdminIdentityRoute(disabled, credential));
      return;
    }
    if (routeMatch.action !== null) throw notFound();
    if (request.method === 'PUT') {
      const input = parseWithSchema(adminIdentityRouteUpdateSchema, await readJsonBody(request));
      const updated = await options.adminService.updateIdentityRoute(id, {
        ...input,
        remark: input.remark ?? null,
      }, session.username);
      const credential = await options.store.repositories.identityCredentials.getActiveByRouteId(id);
      writeJson(response, 200, toAdminIdentityRoute(updated, credential));
      return;
    }
    assertMethod(request, 'DELETE');
    const input = parseWithSchema(adminSoftDisableSchema, await readJsonBody(request));
    await options.adminService.deleteIdentityRoute(id, input.rowVersion, session.username);
    writeJson(response, 200, { status: 'DELETED', routeId: id });
    return;
  }

  if (path === `${ADMIN_API_PREFIX}/tools`) {
    assertMethod(request, 'GET');
    assertNoQuery(url);
    const controls = await options.store.repositories.tools.list({ limit: TOOL_CONTROL_PAGE_LIMIT, offset: 0 });
    writeJson(response, 200, {
      items: buildAdminToolCatalog(controls.items, options.upstream),
      controlsTruncated: controls.hasMore,
    });
    return;
  }

  const toolMatch = matchResourcePath(path, 'tools');
  if (toolMatch) {
    if (toolMatch.action !== null) throw notFound();
    assertMethod(request, 'PUT');
    assertNoQuery(url);
    const toolName = parseWithSchema(adminToolNamePathSchema, toolMatch.identifier);
    const input = parseWithSchema(adminToolControlUpdateSchema, await readJsonBody(request));
    writeJson(response, 200, await options.adminService.updateTool(toolName, {
      enabled: input.enabled,
      remark: input.remark ?? null,
      ...(input.rowVersion ? { rowVersion: input.rowVersion } : {}),
    }, session.username));
    return;
  }

  if (path === `${ADMIN_API_PREFIX}/dml-policies`) {
    if (request.method === 'GET') {
      const paging = parseWithSchema(adminPaginationQuerySchema, queryObject(url));
      writeJson(response, 200, await options.store.repositories.dmlPolicies.list({
        limit: paging.limit ?? 25,
        offset: paging.offset ?? 0,
      }));
      return;
    }
    assertMethod(request, 'POST');
    assertNoQuery(url);
    const input = parseWithSchema(adminDmlPolicyCreateSchema, await readJsonBody(request));
    writeJson(response, 201, await options.adminService.createDmlPolicy({
      ...input,
      remark: input.remark ?? null,
    }, session.username));
    return;
  }

  const managedDmlFieldMatch = matchManagedDmlFieldPath(path);
  if (managedDmlFieldMatch) {
    const dmlPolicyId = parseWithSchema(adminIdPathSchema, managedDmlFieldMatch.dmlPolicyId);
    if (managedDmlFieldMatch.ruleId === null) {
      if (request.method === 'GET') {
        const paging = parseWithSchema(adminPaginationQuerySchema, queryObject(url));
        writeJson(response, 200, await options.store.repositories.managedDmlFieldRules.listByDmlPolicyId(
          dmlPolicyId,
          { limit: paging.limit ?? 25, offset: paging.offset ?? 0 },
        ));
        return;
      }
      assertMethod(request, 'POST');
      assertNoQuery(url);
      const input = parseWithSchema(adminManagedDmlFieldRuleCreateSchema, await readJsonBody(request));
      writeJson(response, 201, await options.adminService.createManagedDmlFieldRule(dmlPolicyId, {
        ...input,
        lookupObjectApiName: input.lookupObjectApiName ?? null,
        lookupMatchFieldApiName: input.lookupMatchFieldApiName ?? null,
        remark: input.remark ?? null,
      }, session.username));
      return;
    }

    const ruleId = parseWithSchema(adminIdPathSchema, managedDmlFieldMatch.ruleId);
    assertNoQuery(url);
    if (managedDmlFieldMatch.action === 'disable') {
      assertMethod(request, 'POST');
      const input = parseWithSchema(adminSoftDisableSchema, await readJsonBody(request));
      writeJson(response, 200, await options.adminService.disableManagedDmlFieldRule(
        dmlPolicyId, ruleId, input.rowVersion, session.username,
      ));
      return;
    }
    if (request.method === 'PUT') {
      const input = parseWithSchema(adminManagedDmlFieldRuleUpdateSchema, await readJsonBody(request));
      writeJson(response, 200, await options.adminService.updateManagedDmlFieldRule(dmlPolicyId, ruleId, {
        ...input,
        lookupObjectApiName: input.lookupObjectApiName ?? null,
        lookupMatchFieldApiName: input.lookupMatchFieldApiName ?? null,
        remark: input.remark ?? null,
      }, session.username));
      return;
    }
    assertMethod(request, 'DELETE');
    const input = parseWithSchema(adminSoftDisableSchema, await readJsonBody(request));
    await options.adminService.deleteManagedDmlFieldRule(dmlPolicyId, ruleId, input.rowVersion, session.username);
    writeJson(response, 200, Object.freeze({ deleted: true }));
    return;
  }

  const dmlMatch = matchResourcePath(path, 'dml-policies');
  if (dmlMatch) {
    if (dmlMatch.action !== null) throw notFound();
    const id = parseWithSchema(adminIdPathSchema, dmlMatch.identifier);
    assertNoQuery(url);
    if (request.method === 'PUT') {
      const input = parseWithSchema(adminDmlPolicyUpdateSchema, await readJsonBody(request));
      writeJson(response, 200, await options.adminService.updateDmlPolicy(id, {
        ...input,
        remark: input.remark ?? null,
      }, session.username));
      return;
    }
    assertMethod(request, 'DELETE');
    const input = parseWithSchema(adminSoftDisableSchema, await readJsonBody(request));
    writeJson(response, 200, await options.adminService.disableDmlPolicy(id, input.rowVersion, session.username));
    return;
  }

  if (path === `${ADMIN_API_PREFIX}/diagnostic`) {
    if (request.method === 'GET') {
      assertNoQuery(url);
      const body: DiagnosticPageDto = Object.freeze({
        config: (await options.store.repositories.diagnostic.get()) ?? null,
        configured: Object.freeze({
          connectedApp: options.system.connectedAppConfigured,
          jwtPrivateKey: options.system.jwtPrivateKeyConfigured,
        }),
      });
      writeJson(response, 200, body);
      return;
    }
    assertMethod(request, 'PUT');
    assertNoQuery(url);
    const input = parseWithSchema(adminDiagnosticConfigUpdateSchema, await readJsonBody(request));
    writeJson(response, 200, await options.adminService.updateDiagnostic({
      salesforceUsername: input.salesforceUsername,
      enabled: input.enabled,
      testMetadataType: input.testMetadataType,
      testMetadataFullName: input.testMetadataFullName,
      ...(input.rowVersion ? { rowVersion: input.rowVersion } : {}),
    }, session.username));
    return;
  }

  if (path === `${ADMIN_API_PREFIX}/diagnostic/verify`) {
    assertMethod(request, 'POST');
    assertNoQuery(url);
    const config = await options.store.repositories.diagnostic.get();
    if (!config?.enabled) {
      throw new AdminHttpError(
        'MCP_DIAGNOSTIC_CONFIGURATION_INVALID',
        'An enabled Diagnostic configuration is required before verification.',
        409,
      );
    }
    const verification = await verifyDiagnosticConfig(options.identityRuntime, config, session.username, correlationId);
    const updated = await options.adminService.recordDiagnosticVerification({
      rowVersion: config.rowVersion,
      status: verification.status,
      errorCode: verification.error?.code ?? null,
      errorMessageSafe: verification.error?.message ?? null,
      evidenceSummary: {
        identityMatched: verification.identityMatched,
        apiVersion: verification.apiVersion,
        tooling: verification.tooling,
        metadata: verification.metadata,
        cleanup: verification.cleanup,
        durationMs: verification.durationMs,
      },
    }, session.username);
    const body: DiagnosticVerificationDto = Object.freeze({ config: updated, verification });
    writeJson(response, 200, body);
    return;
  }

  if (path === `${ADMIN_API_PREFIX}/audits`) {
    assertMethod(request, 'GET');
    const query = parseWithSchema(adminAuditQuerySchema, queryObject(url));
    writeJson(response, 200, await options.store.repositories.audits.search({
      ...(query.occurredFrom ? { occurredFrom: new Date(query.occurredFrom) } : {}),
      ...(query.occurredTo ? { occurredTo: new Date(query.occurredTo) } : {}),
      ...(query.auditId ? { auditId: query.auditId } : {}),
      ...(query.correlationId ? { correlationId: query.correlationId } : {}),
      ...(query.platformUserId ? { platformUserId: query.platformUserId } : {}),
      ...(query.salesforceUsername ? { salesforceUsername: query.salesforceUsername } : {}),
      ...(query.toolName ? { toolName: query.toolName } : {}),
      ...(query.result ? { result: query.result } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.errorCode ? { errorCode: query.errorCode } : {}),
      ...(query.objectApiName ? { objectApiName: query.objectApiName } : {}),
      ...(query.recordId ? { recordId: query.recordId } : {}),
      ...(query.auditKind ? { auditKind: query.auditKind } : {}),
      ...(query.auditIntegrityStatus ? { auditIntegrityStatus: query.auditIntegrityStatus } : {}),
      limit: query.limit ?? 25,
      offset: query.offset ?? 0,
    }));
    return;
  }

  const auditMatch = matchResourcePath(path, 'audits');
  if (auditMatch) {
    assertMethod(request, 'GET');
    assertNoQuery(url);
    const id = parseWithSchema(adminIdPathSchema, auditMatch.identifier);
    const audit = await options.store.repositories.audits.getById(id);
    if (!audit) throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', 'Audit record was not found.');
    if (auditMatch.action === 'trace') {
      writeJson(response, 200, await buildAdminAuditTrace(options.store.repositories, audit));
      return;
    }
    if (auditMatch.action !== null) throw notFound();
    writeJson(response, 200, audit);
    return;
  }

  const payloadMatch = matchResourcePath(path, 'audit-payloads');
  if (payloadMatch) {
    if (payloadMatch.action !== null) throw notFound();
    assertMethod(request, 'GET');
    assertNoQuery(url);
    const id = parseWithSchema(adminIdPathSchema, payloadMatch.identifier);
    const payload = await options.store.repositories.auditTraces.getPayloadEvidenceById(id);
    if (!payload) throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', 'Audit payload evidence was not found.');
    writeJson(response, 200, payload);
    return;
  }

  if (path === `${ADMIN_API_PREFIX}/system/status`) {
    assertMethod(request, 'GET');
    assertNoQuery(url);
    writeJson(response, 200, await buildSystemStatus(options));
    return;
  }

  if (path === `${ADMIN_API_PREFIX}/system/settings`) {
    assertMethod(request, 'GET');
    assertNoQuery(url);
    writeJson(response, 200, await options.store.repositories.runtimeSettings.list());
    return;
  }

  const settingMatch = matchResourcePath(path, 'system/settings');
  if (settingMatch) {
    if (settingMatch.action !== null) throw notFound();
    assertMethod(request, 'PUT');
    assertNoQuery(url);
    const key = parseWithSchema(adminRuntimeSettingKeySchema, settingMatch.identifier);
    const input = parseWithSchema(adminRuntimeSettingUpdateSchemas[key], await readJsonBody(request));
    writeJson(response, 200, await options.adminService.updateRuntimeSetting(
      key,
      input.value,
      input.rowVersion ?? undefined,
      session.username,
    ));
    return;
  }

  throw notFound();
}

async function buildSystemStatus(options: StartAdminApiServerOptions): Promise<SystemStatusDto> {
  const [databaseResult, diagnosticResult, mcpResult] = await Promise.allSettled([
    options.store.health(),
    options.store.repositories.diagnostic.get(),
    options.probeMcpHealth(),
  ]);
  const localAudit = options.auditPersistenceHealth();
  const mcp: McpHealthProbeResult = mcpResult.status === 'fulfilled'
    ? mcpResult.value
    : Object.freeze({ status: 'DOWN' });
  const mcpAudit = mcp.auditPersistence;
  const auditFailureCount = localAudit.failureCount + (mcpAudit?.failureCount ?? 0);
  return Object.freeze({
    adminVersion: options.system.adminVersion,
    mcpServerVersion: options.system.mcpServerVersion,
    salesforceApiVersion: options.system.salesforceApiVersion,
    providerVersions: options.system.providerVersions,
    upstreamDrift: Object.freeze({ status: options.upstream.status, count: options.upstream.drift.length }),
    database: Object.freeze({
      status: databaseResult.status === 'fulfilled' ? 'UP' : 'DOWN',
      version: databaseResult.status === 'fulfilled' ? databaseResult.value.version : null,
      schemaVersions: Object.freeze(options.migrations.filter((entry) => entry.state === 'APPLIED').map((entry) => entry.version)),
    }),
    runtimeMode: options.system.runtimeMode,
    salesforceInstanceHost: options.system.salesforceInstanceHost,
    configured: Object.freeze({
      connectedApp: options.system.connectedAppConfigured,
      jwtPrivateKey: options.system.jwtPrivateKeyConfigured,
      mcpClientToken: options.system.mcpClientTokenConfigured,
      identityCredentialEncryptionKey: options.system.identityCredentialEncryptionKeyConfigured,
    }),
    diagnostic: diagnosticResult.status === 'fulfilled' ? diagnosticResult.value ?? null : null,
    mcpHealth: mcp.status,
    auditPersistence: Object.freeze({
      status: localAudit.status === 'DEGRADED' || mcpAudit?.status === 'DEGRADED' ? 'DEGRADED' : 'UP',
      failureCount: auditFailureCount,
    }),
    mcpEndpoint: options.system.mcpEndpoint,
    phases: options.system.phases,
    readOnlyRuntimeSettings: options.system.readOnlyRuntimeSettings,
    buildPhase: options.system.buildPhase,
    capabilities: options.system.capabilities,
  });
}

async function appendAdminEvent(
  options: StartAdminApiServerOptions,
  event: Readonly<{
    correlationId: string;
    actorAdmin: string;
    platformUserId?: string;
    salesforceUsername?: string;
    executionRole?: 'USER' | 'DIAGNOSTIC';
    operation: string;
    recordId?: string;
    result: 'PASS' | 'ERROR' | 'BLOCKED';
    outcome: 'SUCCESS' | 'FAILED' | 'DENIED' | 'UNKNOWN';
    errorCode?: string;
    durationMs?: number;
    responseSummary?: unknown;
  }>,
): Promise<void> {
  try {
    await options.store.repositories.audits.append({
      occurredAt: new Date(),
      correlationId: event.correlationId,
      channel: 'ADMIN',
      actorAdmin: event.actorAdmin,
      ...(event.platformUserId ? { platformUserId: event.platformUserId } : {}),
      ...(event.salesforceUsername ? { salesforceUsername: event.salesforceUsername } : {}),
      ...(event.executionRole ? { executionRole: event.executionRole } : {}),
      operation: event.operation,
      ...(event.recordId ? { recordId: event.recordId } : {}),
      result: event.result,
      outcome: event.outcome,
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.responseSummary !== undefined ? { responseSummary: event.responseSummary } : {}),
    });
  } catch (error) {
    throw new ControlPlaneError(
      'MCP_ADMIN_AUDIT_FAILED',
      'The Admin action could not be completed because its audit record was not persisted.',
      { cause: error },
    );
  }
}

async function verifyIdentityRouteBatch(
  options: StartAdminApiServerOptions,
  ids: readonly string[],
  actorAdmin: string,
  correlationId: string,
): Promise<readonly AdminIdentityRouteBatchVerifyRow[]> {
  const rows = new Array<AdminIdentityRouteBatchVerifyRow>(ids.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= ids.length) return;
      const id = ids[index] as string;
      const route = await options.store.repositories.identityRoutes.getById(id);
      if (!route) {
        rows[index] = Object.freeze({
          index,
          id,
          ok: false,
          error: Object.freeze({ code: 'MCP_CONTROL_PLANE_NOT_FOUND', message: 'Identity route was not found.' }),
        });
        continue;
      }
      try {
        const verification = await verifyIdentityRoute(options.identityRuntime, route, correlationId);
        await appendAdminEvent(options, {
          correlationId,
          actorAdmin,
          platformUserId: route.platformUserId,
          salesforceUsername: route.salesforceUsername,
          executionRole: 'USER',
          operation: 'VERIFY_IDENTITY_ROUTE',
          recordId: route.id,
          result: verification.status === 'PASS' ? 'PASS' : 'ERROR',
          outcome: verification.status === 'PASS' ? 'SUCCESS' : 'FAILED',
          errorCode: verification.error?.code,
          durationMs: verification.durationMs,
          responseSummary: {
            status: verification.status,
            identityMatched: verification.identityMatched,
            salesforceUsername: verification.salesforceUsername,
            batch: true,
          },
        });
        rows[index] = Object.freeze({ index, id, ok: true, verification });
      } catch (error) {
        const mapped = mapAdminError(error, options.identityRuntime.redactionSecrets);
        rows[index] = Object.freeze({
          index,
          id,
          ok: false,
          error: Object.freeze({ code: mapped.code, message: mapped.message }),
        });
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(BATCH_VERIFY_CONCURRENCY, ids.length) }, () => worker()),
  );
  return Object.freeze(rows);
}

function toAdminIdentityRoute(
  route: IdentityRouteRecord,
  credential: IdentityCredentialRecord | undefined,
): AdminIdentityRouteDto {
  return Object.freeze({
    ...route,
    credential: credential
      ? Object.freeze({
          id: credential.id,
          status: credential.status,
          tokenLast4: credential.tokenLast4,
          generatedAt: credential.generatedAt,
          lastUsedAt: credential.lastUsedAt,
          rowVersion: credential.rowVersion,
        })
      : null,
  });
}

function toCredentialResponse(
  access: Awaited<ReturnType<ControlPlaneAdminService['readIdentityCredential']>>,
  endpoint: McpPublicEndpointDto,
): AdminIdentityCredentialResponse {
  const credential = access.credential && access.token
    ? Object.freeze({
        id: access.credential.id,
        status: 'ACTIVE' as const,
        token: access.token,
        authorization: `Bearer ${access.token}`,
        tokenLast4: access.credential.tokenLast4,
        generatedAt: access.credential.generatedAt,
        lastUsedAt: access.credential.lastUsedAt,
        rowVersion: access.credential.rowVersion,
        workBuddyJson: endpoint.url ? workBuddyJson(endpoint.url, access.token) : null,
      })
    : null;
  return Object.freeze({ route: access.route, credential, mcpEndpoint: endpoint });
}

function workBuddyJson(url: string, token: string): string {
  return JSON.stringify({
    mcpServers: {
      'enterprise-salesforce': {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${token}` },
        disabled: false,
      },
    },
  }, null, 2);
}

function parseWithSchema<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalidAdminInput(result.error);
  return result.data;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = singleHeader(request.headers['content-type']);
  if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw new AdminHttpError('MCP_ADMIN_CONTENT_TYPE_INVALID', 'Content-Type must be application/json.', 415);
  }
  const declared = Number(singleHeader(request.headers['content-length']));
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
    request.resume();
    throw new AdminHttpError('MCP_ADMIN_REQUEST_TOO_LARGE', 'Admin JSON body exceeds 262144 bytes.', 413);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > MAX_JSON_BODY_BYTES) {
      request.resume();
      throw new AdminHttpError('MCP_ADMIN_REQUEST_TOO_LARGE', 'Admin JSON body exceeds 262144 bytes.', 413);
    }
    chunks.push(buffer);
  }
  if (bytes === 0) throw new AdminHttpError('MCP_ADMIN_INPUT_INVALID', 'A JSON request body is required.', 400);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new AdminHttpError('MCP_ADMIN_INPUT_INVALID', 'The request body is not valid JSON.', 400);
  }
}

function queryObject(url: URL): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(result, key)) {
      throw new AdminHttpError('MCP_ADMIN_INPUT_INVALID', `Query parameter ${key} must not be repeated.`, 400);
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

function matchResourcePath(
  path: string,
  resource: string,
): Readonly<{ identifier: string; action: string | null }> | undefined {
  const prefix = `${ADMIN_API_PREFIX}/${resource}/`;
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  const parts = rest.split('/');
  if (!parts[0] || parts.length > 2 || (parts.length === 2 && !parts[1])) throw notFound();
  try {
    return Object.freeze({
      identifier: decodeURIComponent(parts[0]),
      action: parts[1] ? decodeURIComponent(parts[1]) : null,
    });
  } catch {
    throw new AdminHttpError('MCP_ADMIN_REQUEST_INVALID', 'Path identifier encoding is invalid.', 400);
  }
}

function matchManagedDmlFieldPath(path: string): Readonly<{
  dmlPolicyId: string;
  ruleId: string | null;
  action: 'disable' | null;
}> | undefined {
  const prefix = `${ADMIN_API_PREFIX}/dml-policies/`;
  if (!path.startsWith(prefix)) return undefined;
  const parts = path.slice(prefix.length).split('/');
  if (parts[1] !== 'managed-fields') return undefined;
  const valid = parts.length === 2
    || (parts.length === 3 && Boolean(parts[2]))
    || (parts.length === 4 && Boolean(parts[2]) && parts[3] === 'disable');
  if (!parts[0] || !valid) throw notFound();
  try {
    return Object.freeze({
      dmlPolicyId: decodeURIComponent(parts[0]),
      ruleId: parts[2] ? decodeURIComponent(parts[2]) : null,
      action: parts[3] === 'disable' ? 'disable' : null,
    });
  } catch {
    throw new AdminHttpError('MCP_ADMIN_REQUEST_INVALID', 'Path identifier encoding is invalid.', 400);
  }
}

function matchRouteCredentialPath(
  path: string,
): Readonly<{ identifier: string; action: 'read' | 'regenerate' }> | undefined {
  const prefix = `${ADMIN_API_PREFIX}/routes/`;
  if (!path.startsWith(prefix)) return undefined;
  const parts = path.slice(prefix.length).split('/');
  if (parts[1] !== 'credential' || (parts.length !== 2 && !(parts.length === 3 && parts[2] === 'regenerate'))) {
    return undefined;
  }
  if (!parts[0]) throw notFound();
  try {
    return Object.freeze({
      identifier: decodeURIComponent(parts[0]),
      action: parts.length === 3 ? 'regenerate' : 'read',
    });
  } catch {
    throw new AdminHttpError('MCP_ADMIN_REQUEST_INVALID', 'Path identifier encoding is invalid.', 400);
  }
}

function assertMethod(request: IncomingMessage, expected: string): void {
  if (request.method !== expected) {
    throw new AdminHttpError('MCP_ADMIN_METHOD_NOT_ALLOWED', `This endpoint requires ${expected}.`, 405);
  }
}

function assertNoQuery(url: URL): void {
  if (url.search) throw new AdminHttpError('MCP_ADMIN_INPUT_INVALID', 'This endpoint does not accept query parameters.', 400);
}

function assertMutationGuards(request: IncomingMessage, allowedOrigin: string, session: AdminSession): void {
  assertExactOrigin(request, allowedOrigin);
  const csrf = singleHeader(request.headers[ADMIN_CSRF_HEADER]);
  if (!csrf || !safeTextEqual(csrf, session.csrfToken)) {
    throw new AdminHttpError('MCP_ADMIN_CSRF_INVALID', 'A valid Admin CSRF token is required.', 403);
  }
}

function assertExactOrigin(request: IncomingMessage, allowedOrigin: string): void {
  const origin = singleHeader(request.headers.origin);
  if (!origin || origin !== allowedOrigin) {
    throw new AdminHttpError('MCP_ADMIN_ORIGIN_NOT_ALLOWED', 'The request Origin is not allowed.', 403);
  }
}

function assertOptionalOrigin(request: IncomingMessage, allowedOrigin: string): void {
  const origin = singleHeader(request.headers.origin);
  if (origin && origin !== allowedOrigin) {
    throw new AdminHttpError('MCP_ADMIN_ORIGIN_NOT_ALLOWED', 'The request Origin is not allowed.', 403);
  }
}

function isMutation(method: string | undefined): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function safeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function sessionDto(session: AdminSession): Readonly<{ username: string; csrfToken: string; expiresAt: number }> {
  return Object.freeze({ username: session.username, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
}

function setSecurityHeaders(response: ServerResponse, correlationId: string): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  response.setHeader('X-Correlation-Id', correlationId);
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', payload.length);
  response.end(payload);
}

function notFound(): AdminHttpError {
  return new AdminHttpError('MCP_ADMIN_NOT_FOUND', 'Admin endpoint was not found.', 404);
}

function urlHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

async function closeServerImmediately(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = once(server, 'close').then(() => undefined);
  server.closeAllConnections();
  server.close();
  await closed;
}
