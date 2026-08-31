import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest, type Server } from 'node:http';
import test from 'node:test';
import { RequestAuditContextController } from '@sfoa/identity-runtime';
import { observeBoundedMcpResponse } from '../mcp-response-recorder.js';

test('2 MiB MCP response reaches the client while Audit stores only a bounded transport prefix', async (t) => {
  const marker = 'MCP_LARGE_RESPONSE_ONLY';
  const wireBody = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { marker, data: 'R'.repeat(2 * 1024 * 1024) } });
  let controller: RequestAuditContextController | undefined;
  const server = createServer((_request, response) => {
    controller = RequestAuditContextController.create({
      correlationId: 'mcp-large-response', channel: 'MCP_HTTP', toolName: 'large_tool',
    });
    controller.collector().record({
      eventCategory: 'TOOL', eventType: 'TOOL_TERMINAL', eventName: 'large_tool', status: 'SUCCESS',
      terminal: { source: 'TOOL', result: 'PASS', outcome: 'SUCCESS', responseSummary: { success: true } },
    });
    observeBoundedMcpResponse(response, controller);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(wireBody);
  });
  await listen(server);
  t.after(() => close(server));
  const body = await get(server);
  assert.equal(body, wireBody);
  assert.ok(controller);
  const snapshot = controller.finalizeAudit();
  assert.ok(snapshot);
  const payload = snapshot.payloadEvidence[0];
  assert.equal(payload?.payloadType, 'MCP_RESPONSE');
  assert.equal(payload?.truncated, true);
  assert.equal(payload?.originalSizeBytes, null);
  assert.ok((payload?.storedSizeBytes ?? 0) <= 262_144);
  assert.match(payload?.safePayload ?? '', new RegExp(marker, 'u'));
  const transport = snapshot.auditEvents.find((event) => event.eventType === 'MCP_TRANSPORT_TERMINAL');
  assert.equal((transport?.safeSummary as Record<string, unknown>).transportStatus, 'RESPONSE_FINISHED');
  assert.equal((transport?.safeSummary as Record<string, unknown>).clientReceiptConfirmed, false);
  assert.equal(snapshot.auditCall.outcome, 'SUCCESS');
});

test('close before finish records CLIENT_DISCONNECTED and never claims complete delivery', async (t) => {
  let controller: RequestAuditContextController | undefined;
  let auditReadyResolve: (() => void) | undefined;
  const auditReady = new Promise<void>((resolve) => { auditReadyResolve = resolve; });
  const server = createServer((_request, response) => {
    controller = RequestAuditContextController.create({
      correlationId: 'mcp-client-disconnect', channel: 'MCP_HTTP', toolName: 'disconnect_tool',
    });
    controller.collector().record({
      eventCategory: 'TOOL', eventType: 'TOOL_TERMINAL', eventName: 'disconnect_tool', status: 'SUCCESS',
      terminal: { source: 'TOOL', result: 'PASS', outcome: 'SUCCESS', responseSummary: { success: true } },
    });
    observeBoundedMcpResponse(response, controller);
    response.once('close', () => auditReadyResolve?.());
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(JSON.stringify({ marker: 'DISCONNECT_PREFIX_ONLY', data: 'D'.repeat(64 * 1024) }));
    setTimeout(() => {
      if (!response.destroyed) response.end(JSON.stringify({ marker: 'SHOULD_NOT_BE_DELIVERED' }));
    }, 100);
  });
  await listen(server);
  t.after(() => close(server));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => {
    const request = httpRequest({ host: '127.0.0.1', port: address.port, path: '/', method: 'GET' }, (response) => {
      response.once('data', () => {
        response.destroy();
        resolve();
      });
    });
    request.once('error', () => resolve());
    request.end();
  });
  await auditReady;
  assert.ok(controller);
  const snapshot = controller.finalizeAudit();
  assert.ok(snapshot);
  const transport = snapshot.auditEvents.find((event) => event.eventType === 'MCP_TRANSPORT_TERMINAL');
  assert.equal((transport?.safeSummary as Record<string, unknown>).transportStatus, 'CLIENT_DISCONNECTED');
  assert.equal((transport?.safeSummary as Record<string, unknown>).responseFinished, false);
  assert.equal((transport?.safeSummary as Record<string, unknown>).clientReceiptConfirmed, false);
  assert.equal(snapshot.auditCall.outcome, 'UNKNOWN');
  assert.equal(snapshot.auditCall.errorCode, 'MCP_CLIENT_DISCONNECTED');
  assert.deepEqual(snapshot.auditCall.responseSummary, { success: true });
  assert.equal(snapshot.payloadEvidence[0]?.truncated, true);
  assert.match(snapshot.payloadEvidence[0]?.safePayload ?? '', /DISCONNECT_PREFIX_ONLY/u);
  assert.doesNotMatch(snapshot.payloadEvidence[0]?.safePayload ?? '', /SHOULD_NOT_BE_DELIVERED/u);
});

async function listen(server: Server): Promise<void> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = once(server, 'close').then(() => undefined);
  server.closeAllConnections();
  server.close();
  await closed;
}

async function get(server: Server): Promise<string> {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const request = httpRequest({ host: '127.0.0.1', port: address.port, path: '/', method: 'GET' }, (response) => {
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end();
  });
}
