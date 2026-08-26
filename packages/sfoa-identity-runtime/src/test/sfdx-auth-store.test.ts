import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthInfo } from '@salesforce/core';
import type { IdentityRuntimeConfig } from '../config.js';
import {
  configuredSfdxUsernames,
  ensureGenericUnixKeychain,
  seedSfdxLocalAuthStore,
  type SfdxAuthStoreDependencies,
} from '../sfdx-auth-store.js';

const GENERIC_UNIX_KEYCHAIN_VAR = 'SF_USE_GENERIC_UNIX_KEYCHAIN';

function makeConfig(overrides: Partial<IdentityRuntimeConfig> = {}): IdentityRuntimeConfig {
  return Object.freeze({
    projectRoot: 'C:\\repo',
    instanceUrl: 'https://example.test',
    primaryUsername: 'primary@example.test',
    secondaryUsername: 'secondary@example.test',
    diagnosticUsername: 'diagnostic@example.test',
    clientId: 'client-id-secret',
    privateKeyPath: 'C:\\secrets\\server.key',
    platformUserA: 'p1-user-a',
    platformUserB: 'p1-user-b',
    concurrentRequests: 20,
    port: 3000,
    ...overrides,
  });
}

test('ensureGenericUnixKeychain sets the generic-unix keychain on Linux when unset and never overrides', () => {
  const originalPlatform = process.platform;
  const originalValue = process.env[GENERIC_UNIX_KEYCHAIN_VAR];
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    delete process.env[GENERIC_UNIX_KEYCHAIN_VAR];
    ensureGenericUnixKeychain();
    assert.equal(process.env[GENERIC_UNIX_KEYCHAIN_VAR], 'true');

    process.env[GENERIC_UNIX_KEYCHAIN_VAR] = 'false';
    ensureGenericUnixKeychain();
    assert.equal(process.env[GENERIC_UNIX_KEYCHAIN_VAR], 'false');
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalValue === undefined) delete process.env[GENERIC_UNIX_KEYCHAIN_VAR];
    else process.env[GENERIC_UNIX_KEYCHAIN_VAR] = originalValue;
  }
});

test('ensureGenericUnixKeychain leaves non-Linux platforms untouched', () => {
  const originalPlatform = process.platform;
  const originalValue = process.env[GENERIC_UNIX_KEYCHAIN_VAR];
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    delete process.env[GENERIC_UNIX_KEYCHAIN_VAR];
    ensureGenericUnixKeychain();
    assert.equal(process.env[GENERIC_UNIX_KEYCHAIN_VAR], undefined);
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalValue === undefined) delete process.env[GENERIC_UNIX_KEYCHAIN_VAR];
    else process.env[GENERIC_UNIX_KEYCHAIN_VAR] = originalValue;
  }
});

test('configuredSfdxUsernames deduplicates and drops empty entries', () => {
  assert.deepEqual(
    configuredSfdxUsernames(makeConfig()),
    ['primary@example.test', 'secondary@example.test', 'diagnostic@example.test'],
  );
  assert.deepEqual(
    configuredSfdxUsernames(makeConfig({ secondaryUsername: undefined, diagnosticUsername: 'primary@example.test' })),
    ['primary@example.test'],
  );
  assert.deepEqual(
    configuredSfdxUsernames(makeConfig({ primaryUsername: '', secondaryUsername: '', diagnosticUsername: '  ' })),
    [],
  );
});

test('seedSfdxLocalAuthStore seeds configured + extra users and aggregates failures without throwing', async () => {
  const created: unknown[] = [];
  const saved: string[] = [];
  const deps: SfdxAuthStoreDependencies = {
    createAuthInfo: async (options) => {
      created.push(options);
      const fake = {
        save: async () => {
          if (options.username === 'failing@example.test') {
            const error = new Error('keychain unavailable');
            error.name = 'KeychainError';
            throw error;
          }
          saved.push(options.username);
          return fake;
        },
      } as unknown as AuthInfo;
      return fake;
    },
  };

  const result = await seedSfdxLocalAuthStore(
    makeConfig({ diagnosticUsername: 'diagnostic@example.test' }),
    ['db-user@example.test', 'failing@example.test', 'primary@example.test'],
    deps,
  );

  assert.deepEqual(created, [
    { username: 'primary@example.test', clientId: 'client-id-secret', privateKeyFile: 'C:\\secrets\\server.key', loginUrl: 'https://example.test' },
    { username: 'secondary@example.test', clientId: 'client-id-secret', privateKeyFile: 'C:\\secrets\\server.key', loginUrl: 'https://example.test' },
    { username: 'diagnostic@example.test', clientId: 'client-id-secret', privateKeyFile: 'C:\\secrets\\server.key', loginUrl: 'https://example.test' },
    { username: 'db-user@example.test', clientId: 'client-id-secret', privateKeyFile: 'C:\\secrets\\server.key', loginUrl: 'https://example.test' },
    { username: 'failing@example.test', clientId: 'client-id-secret', privateKeyFile: 'C:\\secrets\\server.key', loginUrl: 'https://example.test' },
  ]);
  assert.deepEqual(saved, ['primary@example.test', 'secondary@example.test', 'diagnostic@example.test', 'db-user@example.test']);
  assert.deepEqual(result.seeded, ['primary@example.test', 'secondary@example.test', 'diagnostic@example.test', 'db-user@example.test']);
  assert.deepEqual(result.failed, [{ username: 'failing@example.test', code: 'KeychainError' }]);
});

test('seedSfdxLocalAuthStore no-ops when the JWT credential is not configured', async () => {
  const deps: SfdxAuthStoreDependencies = {
    createAuthInfo: async () => { throw new Error('must not be called'); },
  };
  const result = await seedSfdxLocalAuthStore(makeConfig({ clientId: '', privateKeyPath: '' }), ['a@example.test'], deps);
  assert.deepEqual(result, { seeded: [], failed: [] });
});
