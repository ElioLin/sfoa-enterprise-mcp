import type { SystemStatusDto } from '@sfoa/control-plane';

export type McpConnectivityConfig = Readonly<{
  bindHost: string;
  port: number;
  path: string;
  authMode: string;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  tokenConfigured: boolean;
  runtimeEndpoint: string;
}>;

export type ExternalUrlValidation =
  | Readonly<{ valid: true; url: string }>
  | Readonly<{ valid: false; message: string }>;

const MAX_EXTERNAL_URL_LENGTH = 2_048;

export function deriveMcpConnectivity(status: SystemStatusDto): McpConnectivityConfig {
  const settings = status.readOnlyRuntimeSettings;
  const endpoint = safeUrl(status.mcpEndpoint);
  const port = asPort(settings.MCP_PORT) ?? endpoint?.portAsNumber ?? 8080;
  const path = asPath(settings.MCP_PATH) ?? endpoint?.pathname ?? '/mcp';
  return Object.freeze({
    bindHost: asString(settings.MCP_BIND_HOST) ?? '127.0.0.1',
    port,
    path,
    authMode: asString(settings.MCP_AUTH_MODE) ?? 'internal_bearer',
    allowedHosts: asStringArray(settings.MCP_ALLOWED_HOSTS),
    allowedOrigins: asStringArray(settings.MCP_ALLOWED_ORIGINS),
    tokenConfigured: status.configured.mcpClientToken,
    runtimeEndpoint: status.mcpEndpoint,
  });
}

export function loopbackMcpUrl(config: McpConnectivityConfig): string {
  return `http://127.0.0.1:${config.port}${config.path}`;
}

export function lanMcpUrl(config: McpConnectivityConfig): string {
  return `http://<YOUR_LAN_IP>:${config.port}${config.path}`;
}

export function validateExternalMcpUrl(value: string): ExternalUrlValidation {
  const trimmed = value.trim();
  if (!trimmed) return Object.freeze({ valid: false, message: '请输入外部 MCP 地址。' });
  if (trimmed.length > MAX_EXTERNAL_URL_LENGTH) return Object.freeze({ valid: false, message: '外部 MCP 地址过长。' });
  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol)) return Object.freeze({ valid: false, message: '仅支持 HTTP 或 HTTPS 地址。' });
    if (url.username || url.password) return Object.freeze({ valid: false, message: '地址中不得包含凭据。' });
    if (url.search || url.hash) return Object.freeze({ valid: false, message: '请使用不含查询参数或片段的 MCP Endpoint。' });
    return Object.freeze({ valid: true, url: url.href.endsWith('/') && url.pathname !== '/' ? url.href.slice(0, -1) : url.href });
  } catch {
    return Object.freeze({ valid: false, message: '请输入完整的 MCP URL，例如 http://192.168.156.100:8080/mcp。' });
  }
}

export function buildDifyConnectionExample(externalUrl: string): string {
  return [
    'URL:',
    externalUrl,
    '',
    'Authorization:',
    'Bearer <YOUR_MCP_CLIENT_TOKEN>',
    '',
    'X-Platform-User-Id:',
    '<PLATFORM_USER_ID>',
  ].join('\n');
}

export function buildWorkBuddyConnectionExample(externalUrl: string): string {
  return [
    `MCP Server URL = ${externalUrl}`,
    'Authorization Header = Bearer <YOUR_MCP_CLIENT_TOKEN>',
    'X-Platform-User-Id = <PLATFORM_USER_ID>',
    'Transport = Streamable HTTP',
  ].join('\n');
}

export function bindHostGuidance(config: McpConnectivityConfig): string {
  if (['127.0.0.1', 'localhost', '::1'].includes(config.bindHost.toLocaleLowerCase('en-US'))) {
    return '127.0.0.1 表示仅本机监听，外部 Dify / WorkBuddy Runtime 无法通过它们自己的 127.0.0.1 访问本机。';
  }
  if (config.bindHost === '0.0.0.0') {
    return '0.0.0.0 表示监听所有本机网络接口；必须同时检查 MCP_ALLOWED_HOSTS、route 与 firewall，它不会自动让互联网可访问。';
  }
  return `当前 Runtime 监听 ${config.bindHost}；客户端是否可达仍取决于 route、firewall、security group、reverse proxy 与 DNS。`;
}

function asString(value: string | number | boolean | readonly string[] | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: string | number | boolean | readonly string[] | null | undefined): readonly string[] {
  if (Array.isArray(value)) return Object.freeze(value.filter((item): item is string => typeof item === 'string'));
  if (typeof value === 'string' && value.trim()) return Object.freeze(value.split(',').map((item) => item.trim()).filter(Boolean));
  return Object.freeze([]);
}

function asPort(value: string | number | boolean | readonly string[] | null | undefined): number | undefined {
  const candidate = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(candidate) && candidate >= 1 && candidate <= 65_535 ? candidate : undefined;
}

function asPath(value: string | number | boolean | readonly string[] | null | undefined): string | undefined {
  return typeof value === 'string' && value.startsWith('/') ? value : undefined;
}

function safeUrl(value: string): Readonly<{ pathname: string; portAsNumber?: number }> | undefined {
  try {
    const url = new URL(value);
    const numericPort = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    return Object.freeze({ pathname: url.pathname || '/mcp', ...(Number.isInteger(numericPort) ? { portAsNumber: numericPort } : {}) });
  } catch {
    return undefined;
  }
}
