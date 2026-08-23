import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  loadRemoteRuntimeConfig,
} from '../config.js';
import { RemoteRuntimeError } from '../errors.js';
import { startRemoteMcpServer } from '../http-server.js';
import {
  createTestIdentityRuntime,
  createTestRemoteConfig,
  TEST_CLIENT_TOKEN,
} from '../test/helpers.js';

test('default request timeout exceeds Tool timeout and matches .env.example', async () => {
  const fixture = await createConfigFixture();
  try {
    const config = await loadRemoteRuntimeConfig(fixture.projectRoot, fixture.environment);
    assert.equal(config.requestTimeoutMs, DEFAULT_MCP_REQUEST_TIMEOUT_MS);
    assert.equal(config.toolTimeoutMs, DEFAULT_MCP_TOOL_TIMEOUT_MS);
    assert.equal(config.requestTimeoutMs > config.toolTimeoutMs, true);

    const environmentExample = await readFile(
      new URL('../../../../.env.example', import.meta.url),
      'utf8',
    );
    assert.match(environmentExample, /^MCP_REQUEST_TIMEOUT_MS=180000$/mu);
    assert.match(environmentExample, /^MCP_TOOL_TIMEOUT_MS=120000$/mu);
  } finally {
    await fixture.close();
  }
});

test('invalid timeout relationships fail configuration loading and direct server startup', async () => {
  const fixture = await createConfigFixture();
  try {
    for (const [requestTimeoutMs, toolTimeoutMs] of [[120_000, 120_000], [119_999, 120_000]]) {
      await assert.rejects(
        loadRemoteRuntimeConfig(fixture.projectRoot, {
          ...fixture.environment,
          MCP_REQUEST_TIMEOUT_MS: String(requestTimeoutMs),
          MCP_TOOL_TIMEOUT_MS: String(toolTimeoutMs),
        }),
        isRuntimeConfigurationError,
      );
    }

    await assert.rejects(
      startRemoteMcpServer({
        config: createTestRemoteConfig({ requestTimeoutMs: 100, toolTimeoutMs: 100 }),
        identityRuntime: createTestIdentityRuntime(fixture.projectRoot),
      }),
      isRuntimeConfigurationError,
    );
  } finally {
    await fixture.close();
  }
});

test('runtime loads the strict human-readable JSON Object x Operation allowlist', async () => {
  const fixture = await createConfigFixture();
  try {
    const config = await loadRemoteRuntimeConfig(fixture.projectRoot, {
      ...fixture.environment,
      MCP_ENABLED_TOOLS: 'create_record,update_record',
      MCP_DML_ALLOWLIST_JSON: JSON.stringify([
        { objectApiName: 'Lead', operations: ['CREATE', 'UPDATE'] },
        { objectApiName: 'Account', operations: ['UPDATE'] },
      ]),
    });
    assert.deepEqual(config.enabledTools, ['create_record', 'update_record']);
    assert.deepEqual(config.dmlAllowlist.getRules(), [
      { objectApiName: 'Lead', operations: ['CREATE', 'UPDATE'] },
      { objectApiName: 'Account', operations: ['UPDATE'] },
    ]);
  } finally {
    await fixture.close();
  }
});

test('runtime treats missing, blank, and empty-array DML configuration as deny-all', async () => {
  const fixture = await createConfigFixture();
  try {
    for (const value of [undefined, '', '[]']) {
      const config = await loadRemoteRuntimeConfig(fixture.projectRoot, {
        ...fixture.environment,
        MCP_DML_ALLOWLIST_JSON: value,
      });
      assert.deepEqual(config.dmlAllowlist.getRules(), []);
    }
  } finally {
    await fixture.close();
  }
});

test('runtime rejects DELETE, unknown operations, and malformed DML configuration', async () => {
  const fixture = await createConfigFixture();
  try {
    for (const value of [
      JSON.stringify([{ objectApiName: 'Lead', operations: ['DELETE'] }]),
      JSON.stringify([{ objectApiName: 'Lead', operations: ['MASS_UPDATE'] }]),
      '{',
    ]) {
      await assert.rejects(
        loadRemoteRuntimeConfig(fixture.projectRoot, {
          ...fixture.environment,
          MCP_DML_ALLOWLIST_JSON: value,
        }),
        (error: unknown) =>
          error instanceof RemoteRuntimeError && error.code === 'MCP_DML_CONFIGURATION_INVALID',
      );
    }
  } finally {
    await fixture.close();
  }
});

async function createConfigFixture(): Promise<Readonly<{
  projectRoot: string;
  environment: NodeJS.ProcessEnv;
  close(): Promise<void>;
}>> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p3-config-'));
  const privateKeyPath = path.join(projectRoot, 'test.pem');
  await writeFile(privateKeyPath, 'test-only-key', 'utf8');
  return {
    projectRoot,
    environment: {
      SFOA_INSTANCE_URL: 'https://example.test',
      SALESFORCE_USERNAME: 'user-a@example.test',
      SECOND_TEST_USER: 'user-b@example.test',
      CONNECTED_APP_CLIENT_ID: 'test-client',
      JWT_PRIVATE_KEY_PATH: privateKeyPath,
      MCP_CLIENT_TOKEN: TEST_CLIENT_TOKEN,
    },
    close: async (): Promise<void> => rm(projectRoot, { recursive: true, force: true }),
  };
}

function isRuntimeConfigurationError(error: unknown): boolean {
  return error instanceof RemoteRuntimeError && error.code === 'MCP_RUNTIME_CONFIGURATION_INVALID';
}
