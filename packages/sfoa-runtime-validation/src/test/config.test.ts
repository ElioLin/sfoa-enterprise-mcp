import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConfigurationError, loadValidationConfig, parseEnvFile } from '../config.js';

test('parseEnvFile accepts comments, export, and quoted values', () => {
  const parsed = parseEnvFile([
    '# comment',
    'SFOA_INSTANCE_URL="https://example.my.salesforce.com"',
    "export TEST_OBJECT='Account'",
    'EMPTY=',
  ].join('\n'));

  assert.equal(parsed.SFOA_INSTANCE_URL, 'https://example.my.salesforce.com');
  assert.equal(parsed.TEST_OBJECT, 'Account');
  assert.equal(parsed.EMPTY, '');
});

test('loadValidationConfig validates and resolves a relative private-key path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-config-test-'));
  try {
    await writeFile(path.join(root, 'test.key'), 'test-only', 'utf8');
    await writeFile(
      path.join(root, '.env.local'),
      [
        'SFOA_INSTANCE_URL=https://example.my.salesforce.com/',
        'SALESFORCE_USERNAME=test@example.com',
        'CONNECTED_APP_CLIENT_ID=test-client-id',
        'JWT_PRIVATE_KEY_PATH=test.key',
        'SALESFORCE_ALIAS=test-alias',
        'TEST_OBJECT=Account',
        'TEST_METADATA_TYPE=CustomObject',
        'TEST_METADATA_FULL_NAME=Lead',
        'SFOA_DEBUG_EXPOSE_TOKEN=true',
      ].join('\n'),
      'utf8',
    );

    const config = await loadValidationConfig(root, {});
    assert.equal(config.instanceUrl, 'https://example.my.salesforce.com');
    assert.equal(config.privateKeyPath, path.join(root, 'test.key'));
    assert.equal(config.debugExposeToken, true);

    const safelyOverridden = await loadValidationConfig(root, { SFOA_DEBUG_EXPOSE_TOKEN: 'false' });
    assert.equal(safelyOverridden.debugExposeToken, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadValidationConfig reports every missing required variable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-config-test-'));
  try {
    await assert.rejects(
      loadValidationConfig(root, {}),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        error.missingVariables.includes('SFOA_INSTANCE_URL') &&
        error.missingVariables.includes('TEST_METADATA_FULL_NAME'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
