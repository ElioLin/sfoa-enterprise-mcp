import {
  assertAllMigrationsApplied,
  ControlPlaneAdminService,
  createControlPlaneDatabase,
  DatabaseRuntimeLogger,
  loadIdentityCredentialCipher,
  loadControlPlaneConfig,
  MySqlControlPlaneStore,
  MySqlIdentityRepository,
  type McpPublicEndpointDto,
} from '@sfoa/control-plane';
import {
  createIdentityRuntime,
  JsonLineRuntimeLogger,
  loadIdentityRuntimeConfig,
} from '@sfoa/identity-runtime';
import {
  compareOfficialProviderInventory,
  inspectOfficialDxCoreInventory,
  isLoopbackBindHost,
  loadRemoteRuntimeConfig,
} from '@sfoa/mcp-server';
import { loadAdminApiConfig } from './config.js';
import {
  startAdminApiServer,
  type AdminApiServer,
  type AdminSystemRuntimeInfo,
  type McpHealthProbeResult,
} from './http-server.js';
import { canEnableAdminTool } from './tool-catalog.js';

export type ConfiguredAdminApi = AdminApiServer;

export async function startConfiguredAdminApi(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ConfiguredAdminApi> {
  const [adminConfig, controlPlaneConfig, remoteConfig, identityConfig, credentialCipher] = await Promise.all([
    loadAdminApiConfig(projectRoot, environment),
    loadControlPlaneConfig(projectRoot, environment, { requireDatabase: true }),
    loadRemoteRuntimeConfig(projectRoot, environment),
    loadIdentityRuntimeConfig(projectRoot, environment, { routesFromDatabase: true }),
    loadIdentityCredentialCipher(projectRoot, environment),
  ]);
  const databaseConfig = controlPlaneConfig.database;
  if (!databaseConfig) throw new Error('Admin API requires explicit MySQL configuration.');
  const database = createControlPlaneDatabase(databaseConfig);
  const store = new MySqlControlPlaneStore(database);
  try {
    const [migrations, inventory] = await Promise.all([
      assertAllMigrationsApplied(database),
      inspectOfficialDxCoreInventory(),
    ]);
    const upstream = compareOfficialProviderInventory(inventory);
    const databaseLogger = new DatabaseRuntimeLogger(store.repositories.audits, new JsonLineRuntimeLogger());
    const identityRuntime = createIdentityRuntime(identityConfig, {
      identityRepository: new MySqlIdentityRepository(database),
      logger: databaseLogger,
    });
    const adminService = new ControlPlaneAdminService(
      store,
      (toolName) => canEnableAdminTool(toolName, upstream),
      credentialCipher,
    );
    const healthUrl = localRuntimeUrl(remoteConfig.bindHost, remoteConfig.port, '/health');
    const mcpPublicEndpoint = publicMcpEndpoint(remoteConfig);
    const system: AdminSystemRuntimeInfo = Object.freeze({
      adminVersion: '0.1.0-p5',
      mcpServerVersion: '0.1.0-p5',
      salesforceApiVersion: 'LATEST_PER_FRESH_CONNECTION',
      providerVersions: Object.freeze([
        Object.freeze({ name: inventory.packageName, version: inventory.packageVersion }),
        Object.freeze({ name: `${inventory.providerName} API`, version: inventory.providerApiVersion }),
        Object.freeze({ name: '@salesforce/core', version: '8.29.0' }),
      ]),
      runtimeMode: remoteConfig.controlPlane.mode,
      salesforceInstanceHost: new URL(identityConfig.instanceUrl).hostname,
      connectedAppConfigured: identityConfig.clientId.length > 0,
      jwtPrivateKeyConfigured: identityConfig.privateKeyPath.length > 0,
      mcpClientTokenConfigured: Boolean(remoteConfig.clientToken),
      identityCredentialEncryptionKeyConfigured: true,
      mcpEndpoint: localRuntimeUrl(remoteConfig.bindHost, remoteConfig.port, remoteConfig.mcpPath).href,
      mcpPublicEndpoint,
      readOnlyRuntimeSettings: Object.freeze({
        MCP_BIND_HOST: remoteConfig.bindHost,
        MCP_PORT: remoteConfig.port,
        MCP_PATH: remoteConfig.mcpPath,
        MCP_PUBLIC_URL: remoteConfig.publicUrl ?? null,
        MCP_AUTH_MODE: remoteConfig.authMode,
        MCP_ALLOWED_HOSTS: remoteConfig.allowedHosts,
        MCP_ALLOWED_ORIGINS: remoteConfig.allowedOrigins,
        MCP_REQUEST_TIMEOUT_MS: remoteConfig.requestTimeoutMs,
        MCP_TOOL_TIMEOUT_MS: remoteConfig.toolTimeoutMs,
        SFOA_INSTANCE_URL_HOST: new URL(identityConfig.instanceUrl).hostname,
        CONNECTED_APP_CLIENT_ID_CONFIGURED: identityConfig.clientId.length > 0,
        JWT_PRIVATE_KEY_CONFIGURED: identityConfig.privateKeyPath.length > 0,
      }),
      phases: Object.freeze({
        P0: 'FINAL ACCEPTED',
        P1: 'FINAL ACCEPTED',
        P2: 'FINAL ACCEPTED',
        P3: 'FINAL ACCEPTED',
        P4: 'FINAL ACCEPTED',
        P5: 'FINAL ACCEPTED',
      }),
    });
    const server = await startAdminApiServer({
      config: adminConfig,
      store,
      adminService,
      identityRuntime,
      upstream,
      migrations,
      system,
      auditPersistenceHealth: () => databaseLogger.getHealth(),
      probeMcpHealth: () => probeMcpHealth(healthUrl),
    });
    let closed = false;
    return Object.freeze({
      ...server,
      close: async () => {
        await server.close();
        if (!closed) {
          closed = true;
          await store.close();
        }
      },
    });
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
}

function publicMcpEndpoint(
  config: Readonly<{ bindHost: string; port: number; mcpPath: string; publicUrl?: string }>,
): McpPublicEndpointDto {
  if (config.publicUrl) {
    return Object.freeze({ url: config.publicUrl, source: 'CONFIGURED', warning: null });
  }
  if (isLoopbackBindHost(config.bindHost)) {
    return Object.freeze({
      url: localRuntimeUrl(config.bindHost, config.port, config.mcpPath).href,
      source: 'LOOPBACK_FALLBACK',
      warning: '当前地址仅适用于本机 MCP Client。如需 WorkBuddy / Dify 外部访问，请配置 MCP_PUBLIC_URL。',
    });
  }
  return Object.freeze({
    url: null,
    source: 'UNAVAILABLE',
    warning: '请配置 MCP_PUBLIC_URL 后再复制外部 MCP 配置。',
  });
}

async function probeMcpHealth(url: URL): Promise<McpHealthProbeResult> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return Object.freeze({ status: 'DOWN' });
    const value = await response.json() as unknown;
    if (!isObject(value) || value.status !== 'UP') return Object.freeze({ status: 'DOWN' });
    const auditPersistence = parseAuditHealth(value.auditPersistence);
    return Object.freeze({ status: 'UP', ...(auditPersistence ? { auditPersistence } : {}) });
  } catch {
    return Object.freeze({ status: 'DOWN' });
  }
}

function parseAuditHealth(value: unknown): McpHealthProbeResult['auditPersistence'] {
  if (
    !isObject(value) ||
    (value.status !== 'UP' && value.status !== 'DEGRADED') ||
    typeof value.failureCount !== 'number' ||
    !Number.isInteger(value.failureCount) ||
    value.failureCount < 0
  ) return undefined;
  return Object.freeze({ status: value.status, failureCount: value.failureCount });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function localRuntimeUrl(bindHost: string, port: number, pathname: string): URL {
  const host = bindHost === '0.0.0.0' || bindHost === '::'
    ? '127.0.0.1'
    : bindHost.includes(':') ? `[${bindHost}]` : bindHost;
  return new URL(pathname, `http://${host}:${port}`);
}
