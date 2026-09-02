import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  BUNTU_MAX_RESPONSE_BYTES,
  buntuTokenFingerprint,
  buntuTokenLast4,
  HttpBuntuTokenValidator,
} from '../buntu-validator.js';

const RAW_TOKEN = 'buntu-token-abcdef';
const VALIDATE_URL = '/validate';

function listen(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function jsonResponse(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

test('HttpBuntuTokenValidator accepts the real 2xx { success, data.userId } contract and forwards only the expected headers', async () => {
  let forwardedAuthorization: string | undefined;
  let forwardedAccept: string | undefined;
  const { baseUrl, close } = await listen((request, response) => {
    forwardedAuthorization = request.headers.authorization;
    forwardedAccept = request.headers.accept;
    jsonResponse(response, 200, {
      success: true,
      data: {
        userId: 'platform-buntu-user',
        userName: 'Test User',
        expiresAt: 1787640358,
      },
      extra: 'ignored',
    });
  });
  try {
    const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
    const result = await validator.validate(RAW_TOKEN, 'correlation-1');
    assert.equal(result.valid, true);
    assert.equal(result.userId, 'platform-buntu-user');
    assert.equal(result.upstreamSuccess, true);
    assert.equal(result.userIdType, 'string');
    assert.equal(result.httpStatus, 200);
    assert.equal(result.expiresAtSeconds, 1787640358, 'data.expiresAt must be surfaced for the cache reuse boundary');
    assert.equal(forwardedAuthorization, `Bearer ${RAW_TOKEN}`);
    assert.equal(forwardedAccept, 'application/json');
    assert.equal(typeof result.durationMs, 'number');
    assert.ok(result.validatedAt.length > 0);
  } finally {
    await close();
  }
});

test('HttpBuntuTokenValidator tolerates a response without data.expiresAt (identity still valid, no cache horizon)', async () => {
  const { baseUrl, close } = await listen((_request, response) => jsonResponse(response, 200, {
    success: true,
    data: { userId: 'platform-buntu-user' },
  }));
  try {
    const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
    const result = await validator.validate(RAW_TOKEN, 'correlation-1');
    assert.equal(result.valid, true);
    assert.equal(result.userId, 'platform-buntu-user');
    assert.equal('expiresAtSeconds' in result, false, 'absent data.expiresAt must not fabricate a cache horizon');
  } finally {
    await close();
  }
});

test('HttpBuntuTokenValidator rejects 401/403 as TOKEN_INVALID and other non-2xx as UNAVAILABLE', async () => {
  const scenarios: ReadonlyArray<{ status: number; expected: 'MCP_BUNTU_TOKEN_INVALID' | 'MCP_BUNTU_IDENTITY_UNAVAILABLE' }> = [
    { status: 401, expected: 'MCP_BUNTU_TOKEN_INVALID' },
    { status: 403, expected: 'MCP_BUNTU_TOKEN_INVALID' },
    { status: 302, expected: 'MCP_BUNTU_IDENTITY_UNAVAILABLE' },
    { status: 500, expected: 'MCP_BUNTU_IDENTITY_UNAVAILABLE' },
    { status: 503, expected: 'MCP_BUNTU_IDENTITY_UNAVAILABLE' },
  ];
  for (const scenario of scenarios) {
    const { baseUrl, close } = await listen((_request, response) => {
      response.writeHead(scenario.status, { 'content-type': 'application/json' });
      response.end('{}');
    });
    try {
      const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
      const result = await validator.validate(RAW_TOKEN, 'correlation-1');
      assert.equal(result.valid, false, `status ${scenario.status} must be invalid`);
      assert.equal(result.errorCode, scenario.expected, `status ${scenario.status}`);
      assert.equal(result.httpStatus, scenario.status);
    } finally {
      await close();
    }
  }
});

test('HttpBuntuTokenValidator classifies malformed and oversized responses as RESPONSE_INVALID', async () => {
  const invalidJson = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{not-json');
  });
  try {
    const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${invalidJson.baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
    const result = await validator.validate(RAW_TOKEN, 'correlation-1');
    assert.equal(result.errorCode, 'MCP_BUNTU_IDENTITY_RESPONSE_INVALID');
  } finally {
    await invalidJson.close();
  }

  const wrongType = await listen((_request, response) => jsonResponse(response, 200, {
    success: true,
    data: { userId: 62001.5 },
  }));
  try {
    const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${wrongType.baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
    const result = await validator.validate(RAW_TOKEN, 'correlation-1');
    assert.equal(result.errorCode, 'MCP_BUNTU_IDENTITY_RESPONSE_INVALID');
  } finally {
    await wrongType.close();
  }

  const badUserId = await listen((_request, response) => jsonResponse(response, 200, {
    success: true,
    data: { userId: 'has\u0000control' },
  }));
  try {
    const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${badUserId.baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
    const result = await validator.validate(RAW_TOKEN, 'correlation-1');
    assert.equal(result.errorCode, 'MCP_BUNTU_IDENTITY_RESPONSE_INVALID');
  } finally {
    await badUserId.close();
  }

  const oversized = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(BUNTU_MAX_RESPONSE_BYTES + 1) });
    response.end('{}');
  });
  try {
    const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${oversized.baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
    const result = await validator.validate(RAW_TOKEN, 'correlation-1');
    assert.equal(result.errorCode, 'MCP_BUNTU_IDENTITY_RESPONSE_INVALID');
    assert.equal(result.httpStatus, 200);
  } finally {
    await oversized.close();
  }
});

test('HttpBuntuTokenValidator accepts string and safe-integer data.userId values and normalizes both to the shared platform user id rules', async () => {
  // P6-ID-02 HOTFIX02: the real Buntu contract is `{ success: true, data: { userId } }`.
  // Only string and safe integers are accepted; floats, booleans, objects,
  // arrays, and null are rejected.
  const accepted: ReadonlyArray<{ body: unknown; expectedUserId: string; expectedType: 'string' | 'number' }> = [
    { body: { success: true, data: { userId: '62001' } }, expectedUserId: '62001', expectedType: 'string' },
    { body: { success: true, data: { userId: 62001 } }, expectedUserId: '62001', expectedType: 'number' },
    { body: { success: true, data: { userId: 0 } }, expectedUserId: '0', expectedType: 'number' },
  ];
  for (const scenario of accepted) {
    const { baseUrl, close } = await listen((_request, response) => jsonResponse(response, 200, scenario.body));
    try {
      const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
      const result = await validator.validate(RAW_TOKEN, 'correlation-1');
      assert.equal(result.valid, true, `body ${JSON.stringify(scenario.body)} must be accepted`);
      assert.equal(result.userId, scenario.expectedUserId);
      assert.equal(result.userIdType, scenario.expectedType);
      assert.equal(result.upstreamSuccess, true);
    } finally {
      await close();
    }
  }

  const rejected: readonly unknown[] = [
    { success: true, data: { userId: 62001.5 } },
    { success: true, data: { userId: null } },
    { success: true, data: { userId: {} } },
    { success: true, data: { userId: [] } },
    { success: true, data: { userId: true } },
    { success: true, data: { userId: '' } },
    { success: true, data: { userId: 'has\u0000control' } },
  ];
  for (const body of rejected) {
    const { baseUrl, close } = await listen((_request, response) => jsonResponse(response, 200, body));
    try {
      const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
      const result = await validator.validate(RAW_TOKEN, 'correlation-1');
      assert.equal(result.valid, false, `body ${JSON.stringify(body)} must be rejected`);
      assert.equal(result.errorCode, 'MCP_BUNTU_IDENTITY_RESPONSE_INVALID');
    } finally {
      await close();
    }
  }
});

test('HttpBuntuTokenValidator classifies the confirmed response envelope (CASE 1-7 focused contract tests)', async () => {
  // CASE 1: real string userId -> PASS
  const case1 = await listen((_request, response) => jsonResponse(response, 200, {
    success: true,
    data: { userId: '62001' },
  }));
  try {
    const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${case1.baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
    const result = await validator.validate(RAW_TOKEN, 'correlation-1');
    assert.equal(result.valid, true);
    assert.equal(result.userId, '62001');
    assert.equal(result.userIdType, 'string');
  } finally {
    await case1.close();
  }

  // CASE 2: safe integer number userId -> PASS, normalized to string
  const case2 = await listen((_request, response) => jsonResponse(response, 200, {
    success: true,
    data: { userId: 62001 },
  }));
  try {
    const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${case2.baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
    const result = await validator.validate(RAW_TOKEN, 'correlation-1');
    assert.equal(result.valid, true);
    assert.equal(result.userId, '62001');
    assert.equal(result.userIdType, 'number');
  } finally {
    await case2.close();
  }

  // CASE 3: success=false -> TOKEN_INVALID (normal upstream business decision)
  const case3 = await listen((_request, response) => jsonResponse(response, 200, { success: false }));
  try {
    const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${case3.baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
    const result = await validator.validate(RAW_TOKEN, 'correlation-1');
    assert.equal(result.valid, false);
    assert.equal(result.errorCode, 'MCP_BUNTU_TOKEN_INVALID');
    assert.equal(result.upstreamSuccess, false);
  } finally {
    await case3.close();
  }

  // CASE 4: success=true without data -> RESPONSE_INVALID (contract violation)
  const case4 = await listen((_request, response) => jsonResponse(response, 200, { success: true }));
  try {
    const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${case4.baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
    const result = await validator.validate(RAW_TOKEN, 'correlation-1');
    assert.equal(result.valid, false);
    assert.equal(result.errorCode, 'MCP_BUNTU_IDENTITY_RESPONSE_INVALID');
  } finally {
    await case4.close();
  }

  // CASE 5: success=true with empty data -> RESPONSE_INVALID
  const case5 = await listen((_request, response) => jsonResponse(response, 200, { success: true, data: {} }));
  try {
    const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${case5.baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
    const result = await validator.validate(RAW_TOKEN, 'correlation-1');
    assert.equal(result.valid, false);
    assert.equal(result.errorCode, 'MCP_BUNTU_IDENTITY_RESPONSE_INVALID');
  } finally {
    await case5.close();
  }

  // CASE 6: success=true with an object userId -> RESPONSE_INVALID
  const case6 = await listen((_request, response) => jsonResponse(response, 200, {
    success: true,
    data: { userId: {} },
  }));
  try {
    const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${case6.baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
    const result = await validator.validate(RAW_TOKEN, 'correlation-1');
    assert.equal(result.valid, false);
    assert.equal(result.errorCode, 'MCP_BUNTU_IDENTITY_RESPONSE_INVALID');
  } finally {
    await case6.close();
  }

  // CASE 7: success=true with a float userId -> RESPONSE_INVALID
  const case7 = await listen((_request, response) => jsonResponse(response, 200, {
    success: true,
    data: { userId: 62001.5 },
  }));
  try {
    const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${case7.baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
    const result = await validator.validate(RAW_TOKEN, 'correlation-1');
    assert.equal(result.valid, false);
    assert.equal(result.errorCode, 'MCP_BUNTU_IDENTITY_RESPONSE_INVALID');
  } finally {
    await case7.close();
  }

  // A legacy top-level `user_id` is not the confirmed contract: success is
  // missing, so the envelope is invalid, not accepted and not TOKEN_INVALID.
  const legacy = await listen((_request, response) => jsonResponse(response, 200, { user_id: '62001' }));
  try {
    const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${legacy.baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
    const result = await validator.validate(RAW_TOKEN, 'correlation-1');
    assert.equal(result.valid, false);
    assert.equal(result.errorCode, 'MCP_BUNTU_IDENTITY_RESPONSE_INVALID');
  } finally {
    await legacy.close();
  }
});

test('HttpBuntuTokenValidator times out as UNAVAILABLE without an HTTP status', async () => {
  const { baseUrl, close } = await listen((_request, response) => {
    // Never respond; the client AbortController must fire first.
    response.writeHead(200, { 'content-type': 'application/json' });
  });
  try {
    const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${baseUrl}${VALIDATE_URL}`, timeoutMs: 60 });
    const result = await validator.validate(RAW_TOKEN, 'correlation-1');
    assert.equal(result.valid, false);
    assert.equal(result.errorCode, 'MCP_BUNTU_IDENTITY_UNAVAILABLE');
    assert.equal(result.httpStatus, undefined);
  } finally {
    await close();
  }
});

test('HttpBuntuTokenValidator maps connection failures to UNAVAILABLE', async () => {
  // Bind a server, grab its port, close it, then point the validator at the dead port.
  const probe = await listen((_request, response) => response.end());
  const deadUrl = `${probe.baseUrl}${VALIDATE_URL}`;
  await probe.close();
  const validator = new HttpBuntuTokenValidator({ validateTokenUrl: deadUrl, timeoutMs: 2_000 });
  const result = await validator.validate(RAW_TOKEN, 'correlation-1');
  assert.equal(result.valid, false);
  assert.equal(result.errorCode, 'MCP_BUNTU_IDENTITY_UNAVAILABLE');
  assert.equal(result.httpStatus, undefined);
});

test('buntuTokenFingerprint and buntuTokenLast4 are stable and never echo the raw token', () => {
  const fingerprint = buntuTokenFingerprint(RAW_TOKEN);
  assert.match(fingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(fingerprint.includes(RAW_TOKEN), false);
  assert.equal(buntuTokenLast4(RAW_TOKEN), 'cdef');
  assert.equal(buntuTokenFingerprint(RAW_TOKEN), fingerprint, 'fingerprint must be deterministic');
});
