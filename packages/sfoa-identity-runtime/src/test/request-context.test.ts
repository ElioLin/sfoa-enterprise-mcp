import assert from 'node:assert/strict';
import test from 'node:test';
import { IdentityRuntimeError } from '../errors.js';
import { createRequestContext, parseTrustedRequestHeaders } from '../request-context.js';

test('RequestContext trims platform identity, accepts a safe correlation id, and is immutable', () => {
  const identity = parseTrustedRequestHeaders({
    'X-Platform-User-Id': '  p1-user-a  ',
    'X-Correlation-Id': 'corr_123-abc',
  });
  const context = createRequestContext(identity, process.cwd());
  assert.deepEqual(identity, { platformUserId: 'p1-user-a', correlationId: 'corr_123-abc' });
  assert.equal(context.workspaceRoot, process.cwd());
  assert.equal(Object.isFrozen(context), true);
});

test('RequestContext generates a correlation id when the supplied value is unsafe', () => {
  const identity = parseTrustedRequestHeaders(
    { 'x-platform-user-id': 'p1-user-a', 'x-correlation-id': '../escape' },
    () => 'generated-correlation',
  );
  assert.equal(identity.correlationId, 'generated-correlation');
});

for (const value of [undefined, '', '   ']) {
  test(`RequestContext denies missing or blank platform identity: ${String(value)}`, () => {
    assert.throws(
      () => parseTrustedRequestHeaders({ 'x-platform-user-id': value }, () => 'corr-required'),
      (error: unknown) =>
        error instanceof IdentityRuntimeError &&
        error.code === 'MCP_PLATFORM_USER_REQUIRED' &&
        error.correlationId === 'corr-required',
    );
  });
}

test('RequestContext rejects control characters and excessive identity length', () => {
  for (const value of ['p1-user\u0000a', 'x'.repeat(129)]) {
    assert.throws(
      () => parseTrustedRequestHeaders({ 'x-platform-user-id': value }, () => 'corr-invalid'),
      (error: unknown) => error instanceof IdentityRuntimeError && error.code === 'MCP_REQUEST_SCOPE_FAILED',
    );
  }
});
