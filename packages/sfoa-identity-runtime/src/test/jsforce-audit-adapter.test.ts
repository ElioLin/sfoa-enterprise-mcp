import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { Connection, VERSION } from '@jsforce/jsforce-node';
import { Transport } from '@jsforce/jsforce-node/lib/transport.js';
import {
  installJsforceAuditAdapter,
  isJsforceAuditAdapterInstalled,
} from '../jsforce-audit-adapter.js';
import {
  RequestAuditContextController,
  runWithRequestAuditContext,
  runWithSalesforceApiPurpose,
} from '../request-audit-context.js';

installJsforceAuditAdapter();

test('JSforce contract drift gate pins the single transport interception contract', () => {
  assert.equal(isJsforceAuditAdapterInstalled(), true);
  assert.equal(typeof Transport.prototype.httpRequest, 'function');
  assert.equal(VERSION, '3.10.13');
});

test('one JSforce high-level operation produces one API evidence row without changing results', async (t) => {
  const server = await mockSalesforceServer();
  t.after(() => closeServer(server.server));
  const controller = auditController('sf-user@example.invalid');
  const connection = new Connection({
    instanceUrl: server.url,
    accessToken: 'access-token-must-not-be-audited',
    version: '65.0',
    httpProxy: '',
  });

  await runWithRequestAuditContext(controller, async () => {
    const query = await runWithSalesforceApiPurpose('USER_QUERY', async () =>
      await connection.query('SELECT Id FROM Account'));
    assert.equal(query.totalSize, 0);
    await runWithSalesforceApiPurpose('RECORD_ACTION_CONTEXT', () =>
      connection.request(`${server.url}/services/data/v65.0/ui-api/object-info/Lead`));
    await runWithSalesforceApiPurpose('DML_CREATE', () =>
      connection.sobject('Account').create({ Name: 'A' }));
    await runWithSalesforceApiPurpose('DML_UPDATE', () =>
      connection.sobject('Account').update({ Id: '001000000000001AAA', Name: 'B' }));
    await runWithSalesforceApiPurpose('DIAGNOSTIC_TOOLING', async () =>
      await connection.tooling.query('SELECT Id FROM ApexClass'));
    await runWithSalesforceApiPurpose('METADATA_RETRIEVE', async () =>
      await connection.metadata.describe('65.0'));
  });

  finishAudit(controller);
  const calls = apiCalls(controller);
  assert.equal(calls.length, 6);
  assert.equal(server.requestCount(), 6);
  assert.deepEqual(calls.map((call) => call.apiCategory), [
    'REST_API', 'UI_API', 'REST_API', 'REST_API', 'TOOLING_API', 'METADATA_API',
  ]);
  assert.deepEqual(calls.map((call) => call.purpose), [
    'USER_QUERY', 'RECORD_ACTION_CONTEXT', 'DML_CREATE', 'DML_UPDATE', 'DIAGNOSTIC_TOOLING', 'METADATA_RETRIEVE',
  ]);
  assert.equal(new Set(calls.map((call) => call.publicApiCallId)).size, calls.length);
  assert.equal(calls.every((call) => call.auditId === controller.snapshot().auditId), true);
  assert.doesNotMatch(JSON.stringify(calls), /access-token-must-not-be-audited/u);
});

test('HTTP and transport failures keep real status semantics and never replace the original error', async (t) => {
  const server = await mockSalesforceServer();
  t.after(() => closeServer(server.server));
  const controller = auditController('failure-user@example.invalid');
  const statuses = [400, 401, 403, 404, 429, 500, 503];

  await runWithRequestAuditContext(controller, async () => {
    for (const status of statuses) {
      const response = await new Transport().httpRequest({
        method: 'POST',
        url: `${server.url}/services/data/v65.0/failure/${status}`,
        body: 'request=true',
      }, { httpProxy: '' });
      assert.equal(response.statusCode, status);
    }
    const originalError = await new Transport().httpRequest({
      method: 'POST',
      url: `${server.url}/services/data/v65.0/reset`,
      body: 'request=true',
    }, { httpProxy: '' }).then(() => undefined, (error: unknown) => error);
    assert.ok(originalError instanceof Error);

    const timeoutError = await new Transport().httpRequest({
      method: 'POST',
      url: `${server.url}/services/data/v65.0/timeout`,
      body: 'request=true',
    }, { timeout: 20, httpProxy: '' }).then(() => undefined, (error: unknown) => error);
    assert.ok(timeoutError instanceof Error);
    assert.equal(timeoutError.name, 'AbortError');

    const abortError = Object.assign(new Error('Caller aborted the Salesforce request.'), { name: 'AbortError' });
    const aborted = new Transport().httpRequest({
      method: 'POST',
      url: `${server.url}/services/data/v65.0/abort`,
      body: 'request=true',
    }, { httpProxy: '' });
    aborted.stream().destroy(abortError);
    assert.equal(await aborted.then(() => undefined, (error: unknown) => error), abortError);
  });

  finishAudit(controller);
  const calls = apiCalls(controller);
  assert.deepEqual(calls.slice(0, statuses.length).map((call) => call.httpStatus), statuses);
  assert.deepEqual(calls.slice(-3).map((call) => call.httpStatus), [null, null, null]);
  assert.equal(calls.slice(-3).every((call) => call.result === 'FAILED'), true);
  assert.deepEqual(calls.slice(-2).map((call) => call.salesforceErrorCode), ['AbortError', 'AbortError']);
});

test('OAuth evidence records the real endpoint but never its assertion, token, client secret, or headers', async (t) => {
  const server = await mockSalesforceServer();
  t.after(() => closeServer(server.server));
  const controller = auditController('oauth-user@example.invalid');
  await runWithRequestAuditContext(controller, () => new Transport().httpRequest({
    method: 'POST',
    url: `${server.url}/services/oauth2/token`,
    headers: { authorization: 'Bearer access-token-secret' },
    body: 'grant_type=urn&assertion=jwt-secret&client_secret=client-secret',
  }, { httpProxy: '' }));
  finishAudit(controller);
  const calls = apiCalls(controller);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.apiCategory, 'OAUTH');
  assert.equal(calls[0]?.purpose, 'IDENTITY_TOKEN_EXCHANGE');
  assert.equal(calls[0]?.httpStatus, 200);
  assert.doesNotMatch(JSON.stringify(calls), /access-token-secret|jwt-secret|client-secret/u);
});

test('size evidence uses Content-Length and leaves unknown or large request sizes null', async (t) => {
  const payload = JSON.stringify({ records: 'X'.repeat(32_768) });
  const server = createServer((request, response) => {
    const headers = request.url?.endsWith('/with-content-length')
      ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
      : { 'content-type': 'application/json' };
    response.writeHead(200, headers);
    response.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const controller = auditController('size-user@example.invalid');
  await runWithRequestAuditContext(controller, async () => {
    await new Transport().httpRequest({
      method: 'GET',
      url: `http://127.0.0.1:${address.port}/services/data/v65.0/with-content-length`,
    }, { httpProxy: '' });
    await new Transport().httpRequest({
      method: 'POST',
      url: `http://127.0.0.1:${address.port}/services/data/v65.0/without-content-length`,
      body: 'R'.repeat(32_768),
    }, { httpProxy: '' });
  });
  finishAudit(controller);

  const calls = apiCalls(controller);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.responseSizeBytes, Buffer.byteLength(payload));
  assert.equal(calls[1]?.responseSizeBytes, null);
  assert.equal(calls[1]?.requestSizeBytes, null);
});

test('a 1500-character Salesforce error preserves the original JSforce error semantics', async (t) => {
  const server = await mockSalesforceServer();
  t.after(() => closeServer(server.server));
  const controller = auditController('long-error-user@example.invalid');
  const connection = new Connection({
    instanceUrl: server.url,
    accessToken: 'long-error-test-token',
    version: '65.0',
    httpProxy: '',
  });

  const originalError = await runWithRequestAuditContext(controller, () =>
    connection.request(`${server.url}/services/data/v65.0/long-error`)
      .then(() => undefined, (error: unknown) => error));
  assert.ok(originalError instanceof Error);
  assert.equal(originalError.message, 'E'.repeat(1_500));
  assert.equal((originalError as Error & { errorCode?: string }).errorCode, 'LONG_VALIDATION_ERROR');
  finishAudit(controller);

  const calls = apiCalls(controller);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.httpStatus, 400);
  assert.equal(calls[0]?.salesforceErrorCode, 'LONG_VALIDATION_ERROR');
  assert.equal(calls[0]?.salesforceErrorMessage, 'E'.repeat(1_500));
});

test('each JSforce retry attempt is captured exactly once with its real HTTP status', async (t) => {
  const server = await mockSalesforceServer();
  t.after(() => closeServer(server.server));
  const controller = auditController('retry-user@example.invalid');
  const before = server.requestCount();
  const response = await runWithRequestAuditContext(controller, () => new Transport().httpRequest({
    method: 'GET',
    url: `${server.url}/services/data/v65.0/failure/503`,
  }, { httpProxy: '', retry: { maxRetries: 2, minTimeout: 1, timeoutFactor: 1 } }));
  assert.equal(response.statusCode, 503);
  finishAudit(controller);
  const calls = apiCalls(controller);
  assert.equal(server.requestCount() - before, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.httpStatus), [503, 503, 503]);
  assert.equal(new Set(calls.map((call) => call.publicApiCallId)).size, 3);
});

test('50/100/200 paired concurrency gate has zero added API calls, duplicates, or cross-request leaks', { timeout: 60_000 }, async (t) => {
  const server = await mockSalesforceServer();
  t.after(() => closeServer(server.server));
  const results: unknown[] = [];
  for (const concurrency of [50, 100, 200]) {
    const rounds: Array<Readonly<{ off: Benchmark; on: Benchmark }>> = [];
    for (let round = 0; round < 3; round += 1) {
      const beforeOff = server.requestCount();
      const off = await benchmark(concurrency, async (index) => {
        await new Transport().httpRequest({
          method: 'POST',
          url: `${server.url}/services/data/v65.0/benchmark/off-${concurrency}-${round}-${index}`,
          body: 'request=true',
        }, { httpProxy: '' });
      });
      assert.equal(server.requestCount() - beforeOff, concurrency);

      const beforeOn = server.requestCount();
      const on = await benchmark(concurrency, async (index) => {
        const marker = `ON_${concurrency}_${round}_${index}_ONLY`;
        const controller = auditController(`sf_${marker}@example.invalid`, `tool_${index % 11}`);
        await runWithRequestAuditContext(controller, () => new Transport().httpRequest({
          method: 'POST',
          url: `${server.url}/services/data/v65.0/benchmark/${marker}`,
          body: 'request=true',
        }, { httpProxy: '' }));
        finishAudit(controller);
        const calls = apiCalls(controller);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.salesforceUsername, `sf_${marker}@example.invalid`);
        assert.equal(calls[0]?.requestUrl?.includes(marker), true);
        assert.equal(calls[0]?.auditId, controller.snapshot().auditId);
      });
      assert.equal(server.requestCount() - beforeOn, concurrency);
      rounds.push(Object.freeze({ off, on }));
    }
    results.push(Object.freeze({ concurrency, rounds }));
  }
  process.stdout.write(`P7_04_PAIRED_BENCHMARK ${JSON.stringify(results)}\n`);
});

function apiCalls(controller: RequestAuditContextController) {
  return controller.collector().snapshot()?.salesforceApiCalls ?? [];
}

function auditController(username: string, toolName = 'test_tool'): RequestAuditContextController {
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  const controller = RequestAuditContextController.create({
    channel: 'MCP_HTTP',
    toolName,
  }, () => ids.shift() ?? '33333333-3333-4333-8333-333333333333');
  controller.withSalesforceRoute({ salesforceUsername: username, executionRole: 'USER' });
  return controller;
}

type Benchmark = Readonly<{
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  throughputPerSecond: number;
  heapDeltaBytes: number;
}>;

async function benchmark(concurrency: number, operation: (index: number) => Promise<void>): Promise<Benchmark> {
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const latencies = await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
    const itemStartedAt = performance.now();
    await operation(index);
    return performance.now() - itemStartedAt;
  }));
  const elapsedMs = performance.now() - startedAt;
  const sorted = [...latencies].sort((left, right) => left - right);
  return Object.freeze({
    p50Ms: percentile(sorted, 0.50),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    throughputPerSecond: concurrency / Math.max(elapsedMs / 1_000, 0.001),
    heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
  });
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return Number((sorted[index] ?? 0).toFixed(3));
}

function finishAudit(controller: RequestAuditContextController): void {
  controller.collector().record({
    eventCategory: 'TOOL',
    eventType: 'TOOL_TERMINAL',
    eventName: 'test_tool',
    status: 'SUCCESS',
    terminal: { source: 'TOOL', result: 'PASS', outcome: 'SUCCESS' },
  });
  assert.ok(controller.finalizeAudit());
}

async function mockSalesforceServer(): Promise<Readonly<{
  server: Server;
  url: string;
  requestCount(): number;
}>> {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    const path = request.url ?? '/';
    if (path.endsWith('/reset')) {
      request.socket.destroy();
      return;
    }
    if (path.endsWith('/timeout') || path.endsWith('/abort')) return;
    if (path.endsWith('/long-error')) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{ errorCode: 'LONG_VALIDATION_ERROR', message: 'E'.repeat(1_500) }]));
      return;
    }
    const statusMatch = /\/failure\/(\d{3})$/u.exec(path);
    if (statusMatch?.[1]) {
      const status = Number(statusMatch[1]);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{ errorCode: `STATUS_${status}`, message: `Failure ${status}` }]));
      return;
    }
    if (path === '/services/oauth2/token') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'response-token-must-not-be-audited' }));
      return;
    }
    if (/^\/services\/Soap\/m\/65\.0/u.test(path)) {
      response.writeHead(200, { 'content-type': 'text/xml; charset=UTF-8' });
      response.end('<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><describeMetadataResponse xmlns="http://soap.sforce.com/2006/04/metadata"><result><organizationNamespace></organizationNamespace><partialSaveAllowed>true</partialSaveAllowed><testRequired>false</testRequired></result></describeMetadataResponse></env:Body></env:Envelope>');
      return;
    }
    if (request.method === 'POST' && /\/sobjects\/Account\/?$/u.test(path)) {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: '001000000000001AAA', success: true, errors: [] }));
      return;
    }
    if (request.method === 'PATCH') {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ totalSize: 0, done: true, records: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock Salesforce server did not expose a port.');
  return Object.freeze({
    server,
    url: `http://127.0.0.1:${address.port}`,
    requestCount: () => requestCount,
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
