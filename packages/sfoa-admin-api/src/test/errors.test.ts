import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlPlaneError } from '@sfoa/control-plane';
import { IdentityRuntimeError } from '@sfoa/identity-runtime';
import { ContextRuntimeError } from '@sfoa/mcp-provider-sfoa-context';
import { safeVerificationError } from '../errors.js';

test('safeVerificationError preserves ContextRuntimeError diagnostic codes', () => {
  const result = safeVerificationError(
    new ContextRuntimeError('MCP_DIAGNOSTIC_QUERY_FAILED', 'The official run_soql_query Tool returned an empty error.'),
    [],
  );
  assert.deepEqual(result, {
    code: 'MCP_DIAGNOSTIC_QUERY_FAILED',
    message: 'The official run_soql_query Tool returned an empty error.',
  });
});

test('safeVerificationError preserves MCP_METADATA_CONTEXT_FAILED', () => {
  const result = safeVerificationError(
    new ContextRuntimeError('MCP_METADATA_CONTEXT_FAILED', 'retrieve_metadata failed.'),
    [],
  );
  assert.deepEqual(result, { code: 'MCP_METADATA_CONTEXT_FAILED', message: 'retrieve_metadata failed.' });
});

test('safeVerificationError collapses unknown errors to the generic code', () => {
  const result = safeVerificationError(new Error('boom'), []);
  assert.deepEqual(result, {
    code: 'MCP_ADMIN_VERIFICATION_FAILED',
    message: 'Salesforce verification failed. Inspect server-side logs using the correlation ID.',
  });
});

test('safeVerificationError preserves existing runtime/control-plane codes and redacts secrets', () => {
  const secret = 'secret-client-id';
  const identityResult = safeVerificationError(
    new IdentityRuntimeError('MCP_SALESFORCE_AUTH_FAILED', `auth failed for ${secret}`),
    [secret],
  );
  assert.equal(identityResult.code, 'MCP_SALESFORCE_AUTH_FAILED');
  assert.equal(identityResult.message.includes(secret), false);

  const controlResult = safeVerificationError(
    new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', 'route not found'),
    [],
  );
  assert.deepEqual(controlResult, { code: 'MCP_CONTROL_PLANE_NOT_FOUND', message: 'route not found' });
});
