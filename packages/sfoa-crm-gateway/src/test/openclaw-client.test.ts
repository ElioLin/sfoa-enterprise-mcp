import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import test from 'node:test';
import { CrmGatewayError } from '../errors.js';
import { OpenClawCrmClient, parseSseStream, type OpenClawEvent } from '../openclaw-client.js';

const TOKEN = 's'.repeat(32);
const HISTORY_TOKEN = 'h'.repeat(32);

function streamFrom(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test('SSE parsing handles frames split across chunks and ignores comments', async () => {
  const events: OpenClawEvent[] = [];
  await parseSseStream(streamFrom([
    ': keepalive\n\n',
    'event: run.started\ndata: {"runId":"r1","sess',
    'ionKey":"s1"}\n\nevent: message.delta\ndata: {"text":"你"}\n\n',
    'data: {"text":"好"}\n\n',
  ]), (event) => { events.push(event); });

  assert.deepEqual(events.map((event) => event.type), ['run.started', 'message.delta', 'message']);
  assert.deepEqual(events[0]?.data, { runId: 'r1', sessionKey: 's1' });
  assert.deepEqual(events[1]?.data, { text: '你' });
});

test('SSE parsing rejects a frame that is not JSON', async () => {
  await assert.rejects(
    parseSseStream(streamFrom(['event: message.delta\ndata: not-json\n\n']), () => undefined),
    (error) => error instanceof CrmGatewayError && error.code === 'CRM_OPENCLAW_PROTOCOL_ERROR',
  );
});

function startFakePlugin(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      resolve({ server, url: `http://127.0.0.1:${address.port}/plugins/sfoa-crm` });
    });
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

test('the client sends only the service credential and the expected body, and forwards SSE events', async () => {
  let seenAuthorization: string | undefined;
  let seenBody = '';
  const { server, url } = await startFakePlugin(async (req, res) => {
    seenAuthorization = req.headers.authorization;
    seenBody = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: run.started\ndata: {"runId":"r1","sessionKey":"s1"}\n\n');
    res.write('event: message.final\ndata: {"text":"ok"}\n\n');
    res.end();
  });
  try {
    const client = new OpenClawCrmClient(url, TOKEN, { timeoutMs: 5_000, historyToken: HISTORY_TOKEN });
    const events: OpenClawEvent[] = [];
    await client.turn({ conversationId: 'c1', runId: 'r1', platformUserId: 'u1', message: 'hi' }, (event) => { events.push(event); });
    assert.equal(seenAuthorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(seenBody), { conversationId: 'c1', runId: 'r1', platformUserId: 'u1', message: 'hi' });
    assert.deepEqual(events.map((event) => event.type), ['run.started', 'message.final']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('plugin error bodies map to a stable CrmGatewayError without leaking internals', async () => {
  const { server, url } = await startFakePlugin((_req, res) => {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ errorCode: 'CRM_CONVERSATION_BUSY', message: 'busy' }));
  });
  try {
    const client = new OpenClawCrmClient(url, TOKEN, { timeoutMs: 5_000, historyToken: HISTORY_TOKEN });
    await assert.rejects(
      client.abort({ conversationId: 'c1', runId: 'r1' }),
      (error) => error instanceof CrmGatewayError && error.code === 'CRM_CONVERSATION_BUSY' && error.status === 409,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('history, session resolution, abort and health use their fixed endpoints', async () => {
  const seen: string[] = [];
  const authByUrl: Record<string, string | undefined> = {};
  const { server, url } = await startFakePlugin(async (req, res) => {
    seen.push(req.url ?? '');
    authByUrl[req.url ?? ''] = req.headers.authorization;
    if (req.url === '/plugins/sfoa-crm/history') {
      await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: [{ id: 'm1', role: 'user', text: 'q', timestamp: null }], hasMore: false }));
      return;
    }
    if (req.url === '/plugins/sfoa-crm/session/resolve') {
      await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ conversationId: 'c1', sessionKey: 's1', agentId: 'main', accountId: 'default' }));
      return;
    }
    if (req.url === '/plugins/sfoa-crm/abort') {
      await readBody(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ aborted: true, reason: 'ABORTED' }));
      return;
    }
    if (req.url === '/plugins/sfoa-crm/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, channel: 'sfoa-crm' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const client = new OpenClawCrmClient(url, TOKEN, { timeoutMs: 5_000, historyToken: HISTORY_TOKEN });
    const history = await client.history({ sessionKey: 's1', limit: 10 });
    assert.equal(history.messages[0]?.text, 'q');
    const resolved = await client.resolveSession('c1');
    assert.equal(resolved.sessionKey, 's1');
    assert.deepEqual(await client.abort({ conversationId: 'c1', runId: 'r1' }), { aborted: true, reason: 'ABORTED' });
    assert.deepEqual(await client.health(), { ok: true, channel: 'sfoa-crm' });
    assert.deepEqual(seen.sort(), [
      '/plugins/sfoa-crm/abort',
      '/plugins/sfoa-crm/health',
      '/plugins/sfoa-crm/history',
      '/plugins/sfoa-crm/session/resolve',
    ]);
    assert.equal(authByUrl['/plugins/sfoa-crm/history'], `Bearer ${HISTORY_TOKEN}`);
    assert.equal(authByUrl['/plugins/sfoa-crm/abort'], `Bearer ${TOKEN}`);
    assert.equal(authByUrl['/plugins/sfoa-crm/session/resolve'], `Bearer ${TOKEN}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
