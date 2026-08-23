import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthInfo, Connection } from '@salesforce/core';
import { JwtConnectionFactory } from '../connection-factory.js';
import { createSalesforceIdentityRoute } from '../contracts.js';
import { formatRuntimeError, IdentityRuntimeError } from '../errors.js';
import { TEST_ROUTE_A } from './helpers.js';

const credentialConfig = {
  instanceUrl: 'https://example.test',
  clientId: 'client-id-secret',
  privateKeyPath: 'C:\\secrets\\server.key',
};

test('JwtConnectionFactory uses the resolved route and creates one fresh Connection', async () => {
  const authInfo = {} as unknown as AuthInfo;
  const connection = {} as unknown as Connection;
  const oauthCalls: unknown[] = [];
  const connectionCalls: AuthInfo[] = [];
  const factory = new JwtConnectionFactory(credentialConfig, {
    createAuthInfo: async (options) => {
      oauthCalls.push(options);
      return authInfo;
    },
    createConnection: async (value) => {
      connectionCalls.push(value);
      return connection;
    },
  });

  assert.equal(await factory.create(TEST_ROUTE_A), connection);
  assert.deepEqual(oauthCalls, [
    {
      username: TEST_ROUTE_A.salesforceUsername,
      clientId: credentialConfig.clientId,
      privateKeyFile: credentialConfig.privateKeyPath,
      loginUrl: credentialConfig.instanceUrl,
    },
  ]);
  assert.deepEqual(connectionCalls, [authInfo]);
});

test('JwtConnectionFactory maps authentication and Connection failures to stable redacted errors', async () => {
  const authFailure = new JwtConnectionFactory(credentialConfig, {
    createAuthInfo: async () => {
      throw new Error(`Bearer token-value ${credentialConfig.privateKeyPath}`);
    },
    createConnection: async () => ({}) as Connection,
  });
  await assert.rejects(authFailure.create(TEST_ROUTE_A), (error: unknown) => {
    if (!(error instanceof IdentityRuntimeError)) return false;
    assert.equal(error.code, 'MCP_SALESFORCE_AUTH_FAILED');
    const formatted = formatRuntimeError(error, [credentialConfig.privateKeyPath, credentialConfig.clientId]);
    assert.equal(formatted.includes('token-value'), false);
    assert.equal(formatted.includes(credentialConfig.privateKeyPath), false);
    return true;
  });

  const connectionFailure = new JwtConnectionFactory(credentialConfig, {
    createAuthInfo: async () => ({}) as AuthInfo,
    createConnection: async () => {
      throw new Error('connection internals');
    },
  });
  await assert.rejects(
    connectionFailure.create(TEST_ROUTE_A),
    (error: unknown) => error instanceof IdentityRuntimeError && error.code === 'MCP_SALESFORCE_CONNECTION_FAILED',
  );
});

test('JwtConnectionFactory authenticates a server-created DIAGNOSTIC route with the shared JWT configuration', async () => {
  let authCalls = 0;
  const factory = new JwtConnectionFactory(credentialConfig, {
    createAuthInfo: async () => {
      authCalls += 1;
      return {} as AuthInfo;
    },
    createConnection: async () => ({}) as Connection,
  });
  const diagnosticRoute = createSalesforceIdentityRoute({
    platformUserId: 'diagnostic',
    salesforceUsername: 'diagnostic@example.test',
    credentialProfile: 'future-p4',
    connectionRole: 'DIAGNOSTIC',
    aliases: [],
  });
  await factory.create(diagnosticRoute);
  assert.equal(authCalls, 1);
});
