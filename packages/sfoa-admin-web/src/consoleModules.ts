// The `admin-contracts` subpath, never the package root: the root barrel re-exports
// `admin-service.js`, whose top level imports `node:crypto`, and the Vite browser-external
// shim turns that into a throw at module evaluation — a blank Console, visible only in a
// real browser. `ControlPlaneBrowserBoundary.test.ts` pins this.
import { ADMIN_MODULE_IDS, type AdminModuleId } from '@sfoa/control-plane/admin-contracts';

const MODULE_IDS: ReadonlySet<string> = new Set<string>(ADMIN_MODULE_IDS);

/**
 * ADR-0034: a Console module id is its browser route without the leading slash, so the guard and
 * the navigation derive the module from the path instead of carrying a second mapping table.
 * Returns undefined for a path no module owns — the router's own 404 handles those.
 */
export function moduleForPath(pathname: string): AdminModuleId | undefined {
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== 1) return undefined;
  const [segment] = segments;
  return segment !== undefined && MODULE_IDS.has(segment) ? segment as AdminModuleId : undefined;
}

/**
 * The Console page a signed-in account should land on: the first module it holds, in navigation
 * order. `ADMIN_MODULE_IDS` is ordered exactly like the Console navigation, which a test pins, so
 * "first module" and "first visible menu entry" are the same page.
 */
export function landingPath(modules: readonly AdminModuleId[]): string | undefined {
  const first = ADMIN_MODULE_IDS.find((module) => modules.includes(module));
  return first === undefined ? undefined : `/${first}`;
}

/**
 * Where a login lands. A `from` the account cannot open — a bookmark, or a link a colleague
 * shared — is dropped in favour of its own first module, so a scoped account never signs in
 * straight onto a "no access" page.
 */
export function resolveLanding(
  requested: string | undefined,
  modules: readonly AdminModuleId[],
): string {
  const requestedModule = requested === undefined ? undefined : moduleForPath(requested);
  if (requestedModule !== undefined && modules.includes(requestedModule)) return `/${requestedModule}`;
  // A configured account always holds at least one module (the Admin API rejects an empty list),
  // so this is only reachable with a hand-crafted session.
  return landingPath(modules) ?? '/login';
}
