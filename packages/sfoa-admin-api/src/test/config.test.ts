import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ADMIN_MODULE_IDS } from '@sfoa/control-plane';
import { loadAdminApiConfig, type AdminApiConfig } from '../config.js';

// The loader swallows a missing .env.local, so an absent project root is enough for a
// configuration that is supplied entirely through the environment.
const ABSENT_ROOT = path.join(tmpdir(), 'sfoa-admin-config-absent');

const BASE = Object.freeze({
  SFOA_ADMIN_USERNAME: 'bootstrap-admin',
  SFOA_ADMIN_PASSWORD: 'correct horse battery staple',
  SFOA_ADMIN_SESSION_SECRET: 's'.repeat(64),
});

function load(environment: NodeJS.ProcessEnv): Promise<AdminApiConfig> {
  return loadAdminApiConfig(ABSENT_ROOT, { ...BASE, ...environment });
}

function accountsJson(value: unknown): NodeJS.ProcessEnv {
  return { SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON: JSON.stringify(value) };
}

test('ADR-0034 the bootstrap Admin keeps full access and all nine modules with no extra configuration', async () => {
  const config = await load({});
  assert.equal(config.username, 'bootstrap-admin');
  assert.equal(config.password, BASE.SFOA_ADMIN_PASSWORD);
  assert.equal(config.accounts.length, 1);
  const [admin] = config.accounts;
  assert.equal(admin?.username, 'bootstrap-admin');
  assert.equal(admin?.fullAccess, true);
  assert.deepEqual(admin?.modules, [...ADMIN_MODULE_IDS]);
});

test('ADR-0034 SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON registers scoped accounts in file order', async () => {
  const config = await load(accountsJson([
    { username: 'btit', password: 'btit horse battery staple', modules: ['dashboard', 'identity-routes', 'audit', 'system', 'agent-integration'] },
    { username: 'auditor', password: 'auditor horse battery staple', modules: ['audit'] },
  ]));
  assert.deepEqual(config.accounts.map((account) => account.username), ['bootstrap-admin', 'btit', 'auditor']);
  assert.deepEqual(config.accounts[1]?.modules, ['dashboard', 'identity-routes', 'audit', 'system', 'agent-integration']);
  assert.equal(config.accounts[1]?.fullAccess, false);
  assert.equal(config.accounts[1]?.password, 'btit horse battery staple');
  assert.deepEqual(config.accounts[2]?.modules, ['audit']);
});

test('ADR-0034 an absent or empty additional-account list configures no scoped account', async () => {
  assert.equal((await load({ SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON: '' })).accounts.length, 1);
  assert.equal((await load(accountsJson([]))).accounts.length, 1);
});

test('ADR-0034 malformed SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON fails startup instead of granting access', async () => {
  await assert.rejects(load({ SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON: '{not json' }), /must be a JSON array/u);
  await assert.rejects(load({ SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON: '{"username":"btit"}' }), /must be a JSON array/u);
  await assert.rejects(load({ SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON: 'null' }), /must be a JSON array/u);
  await assert.rejects(load(accountsJson(['btit'])), /\[0\] is invalid/u);
  await assert.rejects(load(accountsJson([{ username: 'btit', password: 'x', modules: ['audit'], remark: 'extra' }])), /\[0\] is invalid/u);
});

test('ADR-0034 modules is mandatory and never defaults to full access', async () => {
  await assert.rejects(load(accountsJson([{ username: 'btit', password: 'x' }])), /modules/u);
  await assert.rejects(load(accountsJson([{ username: 'btit', password: 'x', modules: [] }])), /modules/u);
  await assert.rejects(load(accountsJson([{ username: 'btit', password: 'x', modules: ['console'] }])), /modules/u);
  await assert.rejects(load(accountsJson([{ username: 'btit', password: 'x', modules: ['audit', 'audit'] }])), /must not repeat a module id/u);
});

test('ADR-0034 usernames are unique case-insensitively and never shadow the bootstrap Admin', async () => {
  await assert.rejects(
    load(accountsJson([{ username: 'bootstrap-admin', password: 'x', modules: ['audit'] }])),
    /duplicates SFOA_ADMIN_USERNAME/u,
  );
  await assert.rejects(
    load(accountsJson([{ username: 'BOOTSTRAP-ADMIN', password: 'x', modules: ['audit'] }])),
    /duplicates SFOA_ADMIN_USERNAME/u,
  );
  await assert.rejects(
    load(accountsJson([
      { username: 'btit', password: 'x', modules: ['audit'] },
      { username: 'BTIT', password: 'y', modules: ['system'] },
    ])),
    /duplicates SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON\[0\]\.username/u,
  );
});

test('ADR-0034 the account table stays bounded', async () => {
  const seventeen = Array.from({ length: 17 }, (_, index) => ({ username: `account-${index}`, password: 'x', modules: ['audit'] }));
  await assert.rejects(load(accountsJson(seventeen)), /must not configure more than 16 accounts/u);
  const sixteen = seventeen.slice(0, 16);
  assert.equal((await load(accountsJson(sixteen))).accounts.length, 17);
});
