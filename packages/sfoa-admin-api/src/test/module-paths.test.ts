import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN_API_PREFIX, ADMIN_MODULE_IDS } from '@sfoa/control-plane';
import { endpointModules, MODULE_TABLE_IDS } from '../module-paths.js';

function granted(path: string, method?: string): readonly string[] {
  return endpointModules(`${ADMIN_API_PREFIX}${path}`, method);
}

test('ADR-0034 the path table covers every module id and only those', () => {
  assert.deepEqual([...MODULE_TABLE_IDS].sort(), [...ADMIN_MODULE_IDS].sort());
  assert.equal(new Set(MODULE_TABLE_IDS).size, MODULE_TABLE_IDS.length);
});

test('ADR-0034 every module grants at least one endpoint', () => {
  // A module whose endpoint list is emptied would be selectable in the Console yet unusable: the
  // account would sign in, see the navigation entry, and be refused by every request the page
  // makes. One representative endpoint per module is enough to catch that.
  const representative: Readonly<Record<string, readonly [string, string]>> = {
    dashboard: ['GET', '/dashboard'],
    'identity-routes': ['GET', '/routes'],
    'tool-governance': ['GET', '/tools'],
    'dml-policies': ['GET', '/dml-policies'],
    diagnostic: ['GET', '/diagnostic'],
    'ui-context': ['GET', '/ui-context/snapshots'],
    audit: ['GET', '/audits'],
    system: ['GET', '/system/status'],
    'agent-integration': ['GET', '/system/status'],
  };
  for (const module of ADMIN_MODULE_IDS) {
    const probe = representative[module];
    assert.ok(probe, `${module} has no representative endpoint in this test`);
    assert.equal(
      endpointModules(`${ADMIN_API_PREFIX}${probe[1]}`, probe[0]).includes(module),
      true,
      `${module} grants no endpoint`,
    );
  }
});

test('ADR-0034 authorization is method-sensitive, not just path-sensitive', () => {
  assert.deepEqual(granted('/tools', 'GET'), ['tool-governance', 'agent-integration']);
  assert.deepEqual(granted('/tools', 'PUT'), []);
  assert.deepEqual(granted('/tools/get_username', 'PUT'), ['tool-governance']);
  assert.deepEqual(granted('/dml-policies', 'GET'), ['dml-policies', 'agent-integration']);
  assert.deepEqual(granted('/dml-policies', 'POST'), ['dml-policies']);
  assert.deepEqual(granted('/system/settings', 'GET'), ['identity-routes', 'ui-context', 'system']);
  assert.deepEqual(granted('/system/settings', 'PUT'), []);
  assert.deepEqual(granted('/system/settings/auditRetentionDays', 'PUT'), ['ui-context', 'system']);
});

test('ADR-0034 only the shared read-only closures reach outside their own module', () => {
  assert.deepEqual(granted('/system/status', 'GET'), ['system', 'agent-integration']);
  assert.deepEqual(granted('/dml-policies/1/managed-fields', 'GET'), ['dml-policies', 'agent-integration']);
  assert.deepEqual(granted('/dml-policies/1/managed-fields', 'POST'), ['dml-policies']);
  // The diagnostic page and the identity-route page write nothing outside their own module.
  assert.deepEqual(granted('/diagnostic', 'GET'), ['diagnostic']);
  assert.deepEqual(granted('/diagnostic', 'PUT'), ['diagnostic']);
  assert.deepEqual(granted('/routes', 'POST'), ['identity-routes']);
});

test('ADR-0034 an endpoint owned by no module is denied rather than left to the router', () => {
  // Pre-auth endpoints and anything the router does not serve resolve to no module, so a scoped
  // account is refused without learning whether the path exists.
  assert.deepEqual(granted('/not-a-console-endpoint', 'GET'), []);
  assert.deepEqual(granted('/auth/logout', 'POST'), []);
  assert.deepEqual(granted('/health', 'GET'), []);
  assert.deepEqual(endpointModules('/mcp', 'POST'), []);
  assert.deepEqual(endpointModules(`${ADMIN_API_PREFIX}/tools`, undefined), []);
});

test('ADR-0034 path patterns match whole segments only', () => {
  // A parameter matches exactly one non-empty segment, so a deeper or shallower path is a
  // different endpoint and an empty segment never matches.
  assert.deepEqual(granted('/audits/1', 'GET'), ['audit']);
  assert.deepEqual(granted('/audits/1/trace', 'GET'), ['audit']);
  assert.deepEqual(granted('/audits/1/trace/extra', 'GET'), []);
  assert.deepEqual(granted('/audits//trace', 'GET'), []);
  assert.deepEqual(granted('/audits', 'GET'), ['audit']);
  assert.deepEqual(granted('/audits/', 'GET'), []);
  assert.deepEqual(granted('/audit-payloads/1', 'GET'), ['audit']);
  assert.deepEqual(granted('/routes/1/verify', 'POST'), ['identity-routes']);
  assert.deepEqual(granted('/routes/1/verify/2', 'POST'), []);
  // `routes/batch` is the literal endpoint, so it must not be swallowed by `routes/:id`.
  assert.deepEqual(granted('/routes/batch', 'POST'), ['identity-routes']);
  assert.deepEqual(granted('/routes/batch', 'GET'), []);
});
