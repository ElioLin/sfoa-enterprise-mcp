import { describe, expect, it } from 'vitest';
import { ADMIN_MODULE_IDS } from '@sfoa/control-plane';
import { ADMIN_NAVIGATION } from '../components/AdminShell.js';
import { landingPath, moduleForPath, resolveLanding } from '../consoleModules.js';

describe('ADR-0034 Console module paths', () => {
  it('keeps the navigation in the same order as the module contract', () => {
    // The landing page is "the first module of `ADMIN_MODULE_IDS` the account holds", so the two
    // orders have to agree or a scoped account would land somewhere other than its first menu
    // entry. `Localization.test.ts` pins the labels of this array.
    expect(ADMIN_NAVIGATION.map((entry) => entry.key)).toEqual(ADMIN_MODULE_IDS.map((module) => `/${module}`));
  });

  it('reads the module from a single-segment route and nothing else', () => {
    expect(moduleForPath('/audit')).toBe('audit');
    expect(moduleForPath('/identity-routes')).toBe('identity-routes');
    expect(moduleForPath('/')).toBeUndefined();
    expect(moduleForPath('')).toBeUndefined();
    expect(moduleForPath('/audit/1')).toBeUndefined();
    expect(moduleForPath('/not-a-console-endpoint')).toBeUndefined();
    expect(moduleForPath('/login')).toBeUndefined();
  });

  it('lands on the first module of the navigation the account holds', () => {
    expect(landingPath(['audit'])).toBe('/audit');
    expect(landingPath(['system', 'audit'])).toBe('/audit');
    expect(landingPath(['agent-integration', 'ui-context'])).toBe('/ui-context');
    expect(landingPath([...ADMIN_MODULE_IDS])).toBe('/dashboard');
    expect(landingPath([])).toBeUndefined();
  });

  it('drops a requested page the account cannot open', () => {
    expect(resolveLanding(undefined, ['audit'])).toBe('/audit');
    expect(resolveLanding('/audit', ['audit'])).toBe('/audit');
    // A bookmark or a shared link to a forbidden module falls back to the account's own page.
    expect(resolveLanding('/diagnostic', ['audit'])).toBe('/audit');
    expect(resolveLanding('/login', ['audit'])).toBe('/audit');
    expect(resolveLanding('/not-a-console-endpoint', ['audit'])).toBe('/audit');
    expect(resolveLanding('/system', ['audit', 'system'])).toBe('/system');
    // Unreachable with a configured account: the Admin API rejects an empty module list.
    expect(resolveLanding(undefined, [])).toBe('/login');
  });
});
