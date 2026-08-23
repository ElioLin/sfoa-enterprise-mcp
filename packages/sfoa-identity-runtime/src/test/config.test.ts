import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildIdentityRoutes, loadIdentityRuntimeConfig, type IdentityRuntimeConfig } from '../config.js';
import { missingLiveVariables } from '../validation/live-validation.js';

test('P1 config consumes SECOND_TEST_USER and builds two non-secret identity routes', async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p1-config-test-'));
  try {
    await writeFile(path.join(testRoot, 'test-key.pem'), 'test key fixture', 'utf8');
    await writeFile(
      path.join(testRoot, '.env.local'),
      [
        'SFOA_INSTANCE_URL=https://example.test',
        'SALESFORCE_USERNAME=user-a@example.test',
        'SFOA_DIAGNOSTIC_USERNAME=diagnostic@example.test',
        'SECOND_TEST_USER=user-b@example.test',
        'CONNECTED_APP_CLIENT_ID=test-client-id',
        'JWT_PRIVATE_KEY_PATH=test-key.pem',
        'SALESFORCE_ALIAS=alias-a',
        'TEST_OBJECT=Lead',
        'TEST_METADATA_TYPE=CustomObject',
        'TEST_METADATA_FULL_NAME=Lead',
        '',
      ].join('\n'),
      'utf8',
    );

    const config = await loadIdentityRuntimeConfig(testRoot, {});
    assert.equal(config.secondaryUsername, 'user-b@example.test');
    assert.equal(config.diagnosticUsername, 'diagnostic@example.test');
    const routes = buildIdentityRoutes(config);
    assert.equal(routes.length, 2);
    assert.equal(routes[1]?.salesforceUsername, config.secondaryUsername);
    assert.equal(JSON.stringify(routes).includes('test-key.pem'), false);
    assert.deepEqual(missingLiveVariables(config), []);

    const withoutSecond: IdentityRuntimeConfig = { ...config, secondaryUsername: undefined };
    assert.deepEqual(missingLiveVariables(withoutSecond), ['SECOND_TEST_USER']);

    await assert.rejects(
      loadIdentityRuntimeConfig(testRoot, { SFOA_DIAGNOSTIC_USERNAME: 'USER-A@EXAMPLE.TEST' }),
      /SFOA_DIAGNOSTIC_USERNAME must be distinct/iu,
    );

    const sensitiveMissingPath = path.join(testRoot, 'sensitive-private-key-name.pem');
    await assert.rejects(
      loadIdentityRuntimeConfig(testRoot, { JWT_PRIVATE_KEY_PATH: sensitiveMissingPath }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'JWT_PRIVATE_KEY_PATH is not a readable file.');
        assert.equal(error.message.includes(sensitiveMissingPath), false);
        return true;
      },
    );
  } finally {
    const resolved = path.resolve(testRoot);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.match(path.basename(resolved), /^sfoa-p1-config-test-/u);
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('mysql identity mode ignores environment-owned USER and DIAGNOSTIC routes without fallback', async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p5-db-identity-config-'));
  try {
    await writeFile(path.join(testRoot, 'test-key.pem'), 'test key fixture', 'utf8');
    const config = await loadIdentityRuntimeConfig(testRoot, {
      SFOA_INSTANCE_URL: 'https://example.test',
      CONNECTED_APP_CLIENT_ID: 'test-client-id',
      JWT_PRIVATE_KEY_PATH: path.join(testRoot, 'test-key.pem'),
      SALESFORCE_USERNAME: 'not a valid stale username',
      SECOND_TEST_USER: 'same@example.test',
      SFOA_DIAGNOSTIC_USERNAME: 'SAME@example.test',
      P1_PLATFORM_USER_A: 'not valid!',
      TEST_METADATA_TYPE: '../stale',
      TEST_METADATA_FULL_NAME: '../stale',
    }, { routesFromDatabase: true });
    assert.equal(config.primaryUsername, '');
    assert.equal(config.secondaryUsername, undefined);
    assert.equal(config.diagnosticUsername, undefined);
    assert.equal(config.testMetadataType, undefined);
    assert.equal(config.testMetadataFullName, undefined);
    assert.deepEqual(buildIdentityRoutes(config), []);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
