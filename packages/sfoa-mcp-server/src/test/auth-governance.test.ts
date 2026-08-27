import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { InternalBearerAuthenticator } from '../authenticator.js';
import { loadRemoteRuntimeConfig } from '../config.js';
import { RemoteRuntimeError } from '../errors.js';
import { OFFICIAL_TOOL_CATALOG } from '../official-tool-catalog.js';
import { ToolGovernancePolicy } from '../tool-governance.js';
import { TEST_CLIENT_TOKEN } from './helpers.js';

test('InternalBearerAuthenticator returns stable missing/invalid errors and accepts the exact token', () => {
  const authenticator = new InternalBearerAuthenticator(TEST_CLIENT_TOKEN);
  assert.throws(
    () => authenticator.authenticate({}),
    (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_CLIENT_AUTH_REQUIRED',
  );
  assert.throws(
    () => authenticator.authenticate({ authorization: 'Bearer wrong-token' }),
    (error: unknown) =>
      error instanceof RemoteRuntimeError &&
      error.code === 'MCP_CLIENT_AUTH_INVALID' &&
      !error.message.includes(TEST_CLIENT_TOKEN),
  );
  assert.deepEqual(
    authenticator.authenticate({ authorization: `Bearer ${TEST_CLIENT_TOKEN}` }),
    { clientId: 'internal-bearer' },
  );
});

test('ToolGovernancePolicy registers only explicit compatible reads and fails closed', () => {
  const providerNames = [
    'get_username',
    'run_soql_query',
    'retrieve_metadata',
    'deploy_metadata',
  ];
  assert.deepEqual(
    new ToolGovernancePolicy(['get_username', 'run_soql_query'], providerNames).enabledTools,
    ['get_username', 'run_soql_query'],
  );
  assert.deepEqual(
    new ToolGovernancePolicy(['retrieve_metadata'], providerNames).enabledTools,
    ['retrieve_metadata'],
  );
  assert.throws(
    () => new ToolGovernancePolicy(['unknown_tool'], providerNames),
    (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_TOOL_NOT_AVAILABLE',
  );
  assert.throws(
    () => new ToolGovernancePolicy(['deploy_metadata'], providerNames),
    (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_TOOL_DISABLED',
  );
  assert.throws(
    () => new ToolGovernancePolicy(['get_username'], []),
    (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_TOOL_NOT_AVAILABLE',
  );
});

test('official Tool classification inventory is explicit and has no duplicate names', () => {
  const names = OFFICIAL_TOOL_CATALOG.map((record) => record.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(OFFICIAL_TOOL_CATALOG.find((record) => record.name === 'get_username')?.classification, 'READ');
  assert.equal(
    OFFICIAL_TOOL_CATALOG.find((record) => record.name === 'retrieve_metadata')?.classification,
    'METADATA_READ',
  );
  assert.equal(OFFICIAL_TOOL_CATALOG.find((record) => record.name === 'deploy_metadata')?.classification, 'MUTATION');
  assert.equal(OFFICIAL_TOOL_CATALOG.find((record) => record.name === 'assign_permission_set')?.classification, 'ADMIN');
  assert.equal(OFFICIAL_TOOL_CATALOG.find((record) => record.name === 'run_code_analyzer')?.classification, 'LOCAL_DEV');
  assert.equal(OFFICIAL_TOOL_CATALOG.find((record) => record.name === 'create_custom_rule')?.provider, 'CodeAnalyzerMcpProvider');
  assert.equal(OFFICIAL_TOOL_CATALOG.find((record) => record.name === 'get_ast_nodes_to_generate_xpath')?.provider, 'CodeAnalyzerMcpProvider');
  assert.equal(OFFICIAL_TOOL_CATALOG.find((record) => record.name === 'lwc-doc-error'), undefined);
});

test('P2 config uses safe defaults and refuses disabled auth away from loopback', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p2-config-'));
  try {
    const keyPath = path.join(projectRoot, 'test.pem');
    await writeFile(keyPath, 'test-only-key', 'utf8');
    const baseEnvironment: NodeJS.ProcessEnv = {
      SFOA_INSTANCE_URL: 'https://example.test',
      SALESFORCE_USERNAME: 'user-a@example.test',
      SECOND_TEST_USER: 'user-b@example.test',
      CONNECTED_APP_CLIENT_ID: 'test-client',
      JWT_PRIVATE_KEY_PATH: keyPath,
      MCP_CLIENT_TOKEN: TEST_CLIENT_TOKEN,
      SFOA_LIGHTNING_BASE_URL: '',
    };
    const config = await loadRemoteRuntimeConfig(projectRoot, baseEnvironment);
    assert.equal(config.bindHost, '127.0.0.1');
    assert.equal(config.port, 8080);
    assert.equal(config.mcpPath, '/mcp');
    assert.equal(config.publicUrl, undefined);
    assert.equal(config.lightningBaseUrl, undefined);
    assert.equal(config.authMode, 'internal_bearer');
    assert.deepEqual(config.enabledTools, [
      'get_username',
      'run_soql_query',
      'get_agent_playbook',
      'get_record_links',
    ]);
    assert.equal(config.useLoopbackHostDefaults, true);

    await assert.rejects(
      loadRemoteRuntimeConfig(projectRoot, {
        ...baseEnvironment,
        MCP_BIND_HOST: '0.0.0.0',
        MCP_AUTH_MODE: 'disabled',
        MCP_CLIENT_TOKEN: undefined,
        MCP_ALLOWED_HOSTS: 'example.test:8080',
      }),
      (error: unknown) =>
        error instanceof RemoteRuntimeError && error.code === 'MCP_RUNTIME_CONFIGURATION_INVALID',
    );

    const publicUrlConfig = await loadRemoteRuntimeConfig(projectRoot, {
      ...baseEnvironment,
      MCP_PUBLIC_URL: 'https://mcp.example.test/enterprise/mcp',
    });
    assert.equal(publicUrlConfig.publicUrl, 'https://mcp.example.test/enterprise/mcp');
    assert.equal(publicUrlConfig.bindHost, '127.0.0.1');
    assert.equal(publicUrlConfig.port, 8080);
    assert.equal(publicUrlConfig.mcpPath, '/mcp');

    const lightningConfig = await loadRemoteRuntimeConfig(projectRoot, {
      ...baseEnvironment,
      SFOA_LIGHTNING_BASE_URL: 'https://lightning.example.test',
    });
    assert.equal(lightningConfig.lightningBaseUrl, 'https://lightning.example.test');

    await assert.rejects(
      loadRemoteRuntimeConfig(projectRoot, {
        ...baseEnvironment,
        MCP_PUBLIC_URL: 'https://embedded-secret@mcp.example.test/mcp',
      }),
      (error: unknown) =>
        error instanceof RemoteRuntimeError && error.code === 'MCP_RUNTIME_CONFIGURATION_INVALID',
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
