import { ADMIN_API_PREFIX, type AdminModuleId } from '@sfoa/control-plane';

/**
 * ADR-0034: the Console authorization table.
 *
 * Each module owns an explicit set of Admin API endpoints addressed as HTTP method + path
 * pattern (`:name` matches exactly one non-empty path segment). A request whose endpoint is
 * absent from the caller's modules is refused with `MCP_ADMIN_FORBIDDEN` (403). The table is
 * default-deny: an endpoint added to the router without an entry here stays unreachable for
 * every scoped account, and only the bootstrap Admin (`fullAccess`) reaches it.
 *
 * Two modules deliberately repeat endpoints owned by another module, because the page they
 * render does not work without them. Both are read-only reads of configuration, never a way to
 * write outside the module:
 *  - `identity-routes` also reads `GET /system/settings` for the `adminDefaultPageSize` runtime
 *    setting that drives its pagination.
 *  - `agent-integration` also reads `GET /system/status`, `GET /tools`, `GET /dml-policies` and
 *    `GET /dml-policies/:id/managed-fields`; the instruction generator renders the live Tool
 *    catalog, the DML policies and their managed-field rules. The write counterparts of those
 *    endpoints stay in `tool-governance` and `dml-policies`.
 *
 * `PUT /system/settings/:key` is owned by both `system` and `ui-context` because both pages
 * write runtime settings; the `:key` itself is still validated against
 * `adminRuntimeSettingKeySchema` by the router.
 *
 * Endpoints handled before authorization (`GET /health`, `GET /ready`, `POST /auth/login`,
 * `GET /auth/me`, `POST /auth/logout`) belong to no module and are always reachable.
 */
type ModuleEndpoint = Readonly<{ method: string; path: string }>;

function endpoint(method: ModuleEndpoint['method'], path: string): ModuleEndpoint {
  return Object.freeze({ method, path });
}

const MODULE_ENDPOINTS: Readonly<Record<AdminModuleId, readonly ModuleEndpoint[]>> = Object.freeze({
  dashboard: Object.freeze([
    endpoint('GET', '/dashboard'),
  ]),
  'identity-routes': Object.freeze([
    endpoint('GET', '/routes'),
    endpoint('POST', '/routes'),
    endpoint('POST', '/routes/batch'),
    endpoint('POST', '/routes/batch-verify'),
    endpoint('POST', '/routes/:id/verify'),
    endpoint('POST', '/routes/:id/disable'),
    endpoint('GET', '/routes/:id/credential'),
    endpoint('POST', '/routes/:id/credential/regenerate'),
    endpoint('PUT', '/routes/:id'),
    endpoint('DELETE', '/routes/:id'),
    endpoint('GET', '/system/settings'),
  ]),
  'tool-governance': Object.freeze([
    endpoint('GET', '/tools'),
    endpoint('PUT', '/tools/:toolName'),
  ]),
  'dml-policies': Object.freeze([
    endpoint('GET', '/dml-policies'),
    endpoint('POST', '/dml-policies'),
    endpoint('GET', '/dml-policies/:id/managed-fields'),
    endpoint('POST', '/dml-policies/:id/managed-fields'),
    endpoint('POST', '/dml-policies/:id/managed-fields/:ruleId/disable'),
    endpoint('PUT', '/dml-policies/:id/managed-fields/:ruleId'),
    endpoint('DELETE', '/dml-policies/:id/managed-fields/:ruleId'),
    endpoint('PUT', '/dml-policies/:id'),
    endpoint('DELETE', '/dml-policies/:id'),
  ]),
  diagnostic: Object.freeze([
    endpoint('GET', '/diagnostic'),
    endpoint('PUT', '/diagnostic'),
    endpoint('POST', '/diagnostic/verify'),
  ]),
  'ui-context': Object.freeze([
    endpoint('GET', '/ui-context/snapshots'),
    endpoint('POST', '/ui-context/:objectApiName/refresh'),
    endpoint('GET', '/system/settings'),
    endpoint('PUT', '/system/settings/:key'),
  ]),
  audit: Object.freeze([
    endpoint('GET', '/audits'),
    endpoint('GET', '/audits/:id'),
    endpoint('GET', '/audits/:id/trace'),
    endpoint('GET', '/audit-payloads/:id'),
  ]),
  system: Object.freeze([
    endpoint('GET', '/system/status'),
    endpoint('GET', '/system/settings'),
    endpoint('PUT', '/system/settings/:key'),
  ]),
  'agent-integration': Object.freeze([
    endpoint('GET', '/system/status'),
    endpoint('GET', '/tools'),
    endpoint('GET', '/dml-policies'),
    endpoint('GET', '/dml-policies/:id/managed-fields'),
  ]),
});

/**
 * The modules that grant `method pathname`. An empty result means the endpoint is registered
 * for no scoped module — the caller is refused, and the router's own 404/405 never runs.
 */
export function endpointModules(pathname: string, method: string | undefined): readonly AdminModuleId[] {
  const prefix = `${ADMIN_API_PREFIX}/`;
  if (!method || !pathname.startsWith(prefix)) return Object.freeze([]);
  const path = pathname.slice(ADMIN_API_PREFIX.length);
  const owners: AdminModuleId[] = [];
  for (const [module, endpoints] of Object.entries(MODULE_ENDPOINTS) as readonly [AdminModuleId, readonly ModuleEndpoint[]][]) {
    if (endpoints.some((candidate) => candidate.method === method && matchesPath(candidate.path, path))) owners.push(module);
  }
  return Object.freeze(owners);
}

function matchesPath(template: string, path: string): boolean {
  const expected = template.split('/');
  const actual = path.split('/');
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) => segment.startsWith(':')
    ? (actual[index]?.length ?? 0) > 0
    : segment === actual[index]);
}

/**
 * The module ids the authorization table covers. Exported so a test can assert it stays equal
 * to `ADMIN_MODULE_IDS`: a module added to the contract without a path set would otherwise
 * grant nothing at all — fail-closed, but invisible until a real account hits it.
 */
export const MODULE_TABLE_IDS = Object.freeze(Object.keys(MODULE_ENDPOINTS)) as readonly AdminModuleId[];
