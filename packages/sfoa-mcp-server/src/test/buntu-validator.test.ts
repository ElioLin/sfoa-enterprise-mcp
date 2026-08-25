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

test('HttpBuntuTokenValidator accepts a 2xx { user_id } contract and forwards only the expected headers', async () => {
  let forwardedAuthorization: string | undefined;
  let forwardedAccept: string | undefined;
  const { baseUrl, close } = await listen((request, response) => {
    forwardedAuthorization = request.headers.authorization;
    forwardedAccept = request.headers.accept;
    jsonResponse(response, 200, { user_id: 'platform-buntu-user', extra: 'ignored' });
  });
  try {
    const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
    const result = await validator.validate(RAW_TOKEN, 'correlation-1');
    assert.equal(result.valid, true);
    assert.equal(result.userId, 'platform-buntu-user');
    assert.equal(result.httpStatus, 200);
    assert.equal(forwardedAuthorization, `Bearer ${RAW_TOKEN}`);
    assert.equal(forwardedAccept, 'application/json');
    assert.equal(typeof result.durationMs, 'number');
    assert.ok(result.validatedAt.length > 0);
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

  const wrongType = await listen((_request, response) => jsonResponse(response, 200, { user_id: 61979.5 }));
  try {
    const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${wrongType.baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
    const result = await validator.validate(RAW_TOKEN, 'correlation-1');
    assert.equal(result.errorCode, 'MCP_BUNTU_IDENTITY_RESPONSE_INVALID');
  } finally {
    await wrongType.close();
  }

  const badUserId = await listen((_request, response) => jsonResponse(response, 200, { user_id: 'has\u0000control' }));
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

test('HttpBuntuTokenValidator accepts string and safe-integer user_id values and normalizes both to the shared platform user id rules', async () => {
  // P6-ID-02 HOTFIX01: the real Buntu contract documents `user_id` but has not
  // confirmed the JSON primitive type. Only string and safe integers are accepted;
  // floats, booleans, objects, arrays, and null are rejected.
  const accepted: ReadonlyArray<{ body: unknown; expectedUserId: string }> = [
    { body: { user_id: '61979' }, expectedUserId: '61979' },
    { body: { user_id: 61979 }, expectedUserId: '61979' },
    { body: { user_id: 0 }, expectedUserId: '0' },
  ];
  for (const scenario of accepted) {
    const { baseUrl, close } = await listen((_request, response) => jsonResponse(response, 200, scenario.body));
    try {
      const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
      const result = await validator.validate(RAW_TOKEN, 'correlation-1');
      assert.equal(result.valid, true, `body ${JSON.stringify(scenario.body)} must be accepted`);
      assert.equal(result.userId, scenario.expectedUserId);
    } finally {
      await close();
    }
  }

  const rejected: readonly unknown[] = [
    { user_id: 61979.5 },
    { user_id: null },
    { user_id: {} },
    { user_id: [] },
    { user_id: true },
    { user_id: '' },
    { user_id: 'has\u0000control' },
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

test('HttpBuntuTokenValidator treats an HTTP success without user_id as TOKEN_INVALID', async () => {
  const { baseUrl, close } = await listen((_request, response) => jsonResponse(response, 200, { ok: true }));
  try {
    const validator = new HttpBuntuTokenValidator({ validateTokenUrl: `${baseUrl}${VALIDATE_URL}`, timeoutMs: 2_000 });
    const result = await validator.validate(RAW_TOKEN, 'correlation-1');
    assert.equal(result.valid, false);
    assert.equal(result.errorCode, 'MCP_BUNTU_TOKEN_INVALID');
  } finally {
    await close();
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
