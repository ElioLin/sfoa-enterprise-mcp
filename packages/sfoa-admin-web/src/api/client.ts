import type {
  AdminAuditsResponse,
  AdminDiagnosticConfigUpdateInput,
  AdminDmlPoliciesResponse,
  AdminDmlPolicyCreateInput,
  AdminDmlPolicyUpdateInput,
  AdminIdentityRouteCreateInput,
  AdminIdentityRouteUpdateInput,
  AdminRoutesResponse,
  AdminSessionDto,
  AdminToolControlUpdateInput,
  AdminToolsResponse,
  AuditRecord,
  DashboardDto,
  DiagnosticConfigRecord,
  DiagnosticPageDto,
  DiagnosticVerificationDto,
  DmlPolicyRecord,
  IdentityRouteRecord,
  RouteVerificationDto,
  RuntimeSettingKey,
  RuntimeSettingRecord,
  SystemStatusDto,
  ToolControlRecord,
} from '@sfoa/control-plane';

const API_BASE = '/admin/api';
export const UNAUTHORIZED_EVENT = 'sfoa:admin-unauthorized';
let csrfToken: string | undefined;

export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly correlationId?: string,
    public readonly issues: readonly Readonly<{ path: string; message: string }>[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type AuditFilters = Readonly<{
  occurredFrom?: string;
  occurredTo?: string;
  correlationId?: string;
  platformUserId?: string;
  salesforceUsername?: string;
  toolName?: string;
  result?: 'PASS' | 'ERROR' | 'BLOCKED';
  errorCode?: string;
  limit: number;
  offset: number;
}>;

export const adminApi = Object.freeze({
  login: async (input: Readonly<{ username: string; password: string }>): Promise<AdminSessionDto> => {
    const session = await request<AdminSessionDto>('/auth/login', { method: 'POST', body: input, skipCsrf: true });
    csrfToken = session.csrfToken;
    return session;
  },
  logout: async (): Promise<void> => {
    await request('/auth/logout', { method: 'POST' });
    csrfToken = undefined;
  },
  me: async (): Promise<AdminSessionDto> => {
    const session = await request<AdminSessionDto>('/auth/me');
    csrfToken = session.csrfToken;
    return session;
  },
  dashboard: () => request<DashboardDto>('/dashboard'),
  routes: (limit: number, offset: number) => request<AdminRoutesResponse>(`/routes?limit=${limit}&offset=${offset}`),
  createRoute: (input: AdminIdentityRouteCreateInput) => request<IdentityRouteRecord>('/routes', { method: 'POST', body: input }),
  updateRoute: (id: string, input: AdminIdentityRouteUpdateInput) => request<IdentityRouteRecord>(`/routes/${encodeURIComponent(id)}`, { method: 'PUT', body: input }),
  disableRoute: (id: string, rowVersion: string) => request<IdentityRouteRecord>(`/routes/${encodeURIComponent(id)}`, { method: 'DELETE', body: { rowVersion } }),
  verifyRoute: (id: string) => request<RouteVerificationDto>(`/routes/${encodeURIComponent(id)}/verify`, { method: 'POST' }),
  tools: () => request<AdminToolsResponse>('/tools'),
  updateTool: (toolName: string, input: AdminToolControlUpdateInput) => request<ToolControlRecord>(
    `/tools/${encodeURIComponent(toolName)}`,
    { method: 'PUT', body: input },
  ),
  dmlPolicies: (limit: number, offset: number) => request<AdminDmlPoliciesResponse>(`/dml-policies?limit=${limit}&offset=${offset}`),
  allDmlPolicies: () => loadAllDmlPolicies(),
  createDmlPolicy: (input: AdminDmlPolicyCreateInput) => request<DmlPolicyRecord>('/dml-policies', { method: 'POST', body: input }),
  updateDmlPolicy: (id: string, input: AdminDmlPolicyUpdateInput) => request<DmlPolicyRecord>(
    `/dml-policies/${encodeURIComponent(id)}`,
    { method: 'PUT', body: input },
  ),
  disableDmlPolicy: (id: string, rowVersion: string) => request<DmlPolicyRecord>(
    `/dml-policies/${encodeURIComponent(id)}`,
    { method: 'DELETE', body: { rowVersion } },
  ),
  diagnostic: () => request<DiagnosticPageDto>('/diagnostic'),
  updateDiagnostic: (input: AdminDiagnosticConfigUpdateInput) => request<DiagnosticConfigRecord>(
    '/diagnostic',
    { method: 'PUT', body: input },
  ),
  verifyDiagnostic: () => request<DiagnosticVerificationDto>('/diagnostic/verify', { method: 'POST' }),
  audits: (filters: AuditFilters) => request<AdminAuditsResponse>(`/audits?${auditSearch(filters)}`),
  audit: (id: string) => request<AuditRecord>(`/audits/${encodeURIComponent(id)}`),
  systemStatus: () => request<SystemStatusDto>('/system/status'),
  runtimeSettings: () => request<readonly RuntimeSettingRecord[]>('/system/settings'),
  updateRuntimeSetting: (key: RuntimeSettingKey, value: number, rowVersion?: string) => request<RuntimeSettingRecord>(
    `/system/settings/${encodeURIComponent(key)}`,
    { method: 'PUT', body: { value, rowVersion: rowVersion ?? null } },
  ),
});

type RequestOptions = Readonly<{
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  skipCsrf?: boolean;
}>;

async function request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && !options.skipCsrf && csrfToken) headers['X-SFoA-CSRF-Token'] = csrfToken;
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'include',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    const parsed = parseApiError(payload);
    if (response.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(response.status, parsed.code, parsed.message, parsed.correlationId, parsed.issues);
  }
  return payload as T;
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(response.status || 500, 'MCP_ADMIN_RESPONSE_INVALID', 'The Admin API returned an invalid JSON response.');
  }
}

function parseApiError(value: unknown): Readonly<{
  code: string;
  message: string;
  correlationId?: string;
  issues: readonly Readonly<{ path: string; message: string }>[];
}> {
  if (!isRecord(value) || !isRecord(value.error)) {
    return Object.freeze({
      code: 'MCP_ADMIN_REQUEST_FAILED',
      message: 'The Admin API returned no structured response. Verify /admin/api/ready and restart the P5 services after stopping stale processes.',
      issues: Object.freeze([]),
    });
  }
  const code = typeof value.error.code === 'string' ? value.error.code : 'MCP_ADMIN_REQUEST_FAILED';
  const message = typeof value.error.message === 'string' ? value.error.message : 'The Admin request failed safely.';
  const correlationId = typeof value.correlationId === 'string' ? value.correlationId : undefined;
  const issues = Array.isArray(value.error.issues)
    ? value.error.issues.filter(isIssue).slice(0, 20).map((issue) => Object.freeze({ path: issue.path, message: issue.message }))
    : [];
  return Object.freeze({ code, message, ...(correlationId ? { correlationId } : {}), issues: Object.freeze(issues) });
}

function isIssue(value: unknown): value is Readonly<{ path: string; message: string }> {
  return isRecord(value) && typeof value.path === 'string' && typeof value.message === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function auditSearch(filters: AuditFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return params.toString();
}

async function loadAllDmlPolicies(): Promise<readonly DmlPolicyRecord[]> {
  const items: DmlPolicyRecord[] = [];
  let offset = 0;
  for (let page = 0; page < 100; page += 1) {
    const response = await request<AdminDmlPoliciesResponse>(`/dml-policies?limit=100&offset=${offset}`);
    items.push(...response.items);
    if (!response.hasMore) return Object.freeze(items);
    if (response.nextOffset === null || response.nextOffset <= offset) {
      throw new ApiError(500, 'MCP_ADMIN_RESPONSE_INVALID', 'The Admin API returned an invalid DML policy cursor.');
    }
    offset = response.nextOffset;
  }
  throw new ApiError(500, 'MCP_ADMIN_REQUEST_FAILED', 'The DML policy catalog exceeded the bounded Admin instruction-generator limit.');
}
