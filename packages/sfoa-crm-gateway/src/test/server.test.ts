import assert from 'node:assert/strict';
import test from 'node:test';
import { ApexTokenVerifier } from '../apex-token.js';
import { ChatSessionService } from '../chat-auth.js';
import { CrmGatewayServer } from '../server.js';
import {
  FakeCrmRepository,
  FakeOpenClaw,
  TEST_ORG,
  TEST_ORIGIN,
  TEST_PLATFORM_A,
  TEST_PLATFORM_B,
  TEST_USERNAME_A,
  TEST_USERNAME_B,
  TEST_USER_A,
  TEST_USER_B,
  createSigningMaterial,
  testConfig,
} from './helpers.js';

const NOW_MS = 1_760_000_000_000;

function startGateway(openclaw: FakeOpenClaw) {
  const repository = new FakeCrmRepository();
  repository.seedBinding(TEST_ORG, TEST_USER_A, TEST_PLATFORM_A, TEST_USERNAME_A);
  repository.seedBinding(TEST_ORG, TEST_USER_B, TEST_PLATFORM_B, TEST_USERNAME_B);
  const material = createSigningMaterial(NOW_MS);
  const server = new CrmGatewayServer({
    config: testConfig(),
    repository,
    apexVerifier: new ApexTokenVerifier({
      publicKey: material.publicKey,
      issuer: 'sfoa-crm-apex',
      audience: 'sfoa-crm-gateway',
      allowedOrgIds: [TEST_ORG],
      maxAgeMs: 120_000,
      maxTtlMs: 120_000,
      clockSkewMs: 30_000,
      nowMs: () => NOW_MS,
    }),
    chatSessions: new ChatSessionService(repository, { ttlMs: 900_000 }),
    openclaw,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { server, repository, material };
}

async function api(
  baseUrl: string,
  path: string,
  options: Readonly<{
    method?: string;
    token?: string;
    body?: unknown;
    origin?: string | null;
  }> = {},
): Promise<Readonly<{ status: number; text: string; json: any; headers: Headers }>> {
  const headers: Record<string, string> = {};
  if (options.origin !== null) headers.Origin = options.origin ?? TEST_ORIGIN;
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let json: any = undefined;
  try { json = JSON.parse(text); } catch { /* SSE or empty */ }
  return { status: response.status, text, json, headers: response.headers };
}

test('exchange, conversation ownership, SSE turn, history, duplicate and cross-user denial', async (t) => {
  const openclaw = new FakeOpenClaw({
    history: { messages: [{ id: 'm1', role: 'user', text: '查商机', timestamp: null }], hasMore: false },
  });
  const { server, repository, material } = startGateway(openclaw);
  const address = await server.listen();
  t.after(async () => { await server.close(); });

  const bootstrap = material.signToken();
  const exchange = await api(address.url, '/auth/exchange', { body: { bootstrapToken: bootstrap } });
  assert.equal(exchange.status, 200);
  const chatToken = exchange.json.token as string;
  assert.equal(exchange.json.user.platformUserId, TEST_PLATFORM_A);
  assert.equal(exchange.json.user.salesforceUsername, TEST_USERNAME_A);
  assert.ok(chatToken.length >= 32);

  const replay = await api(address.url, '/auth/exchange', { body: { bootstrapToken: bootstrap } });
  assert.equal(replay.status, 409);
  assert.equal(replay.json.errorCode, 'CRM_BOOTSTRAP_REPLAYED');

  const me = await api(address.url, '/me', { token: chatToken });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.platformUserId, TEST_PLATFORM_A);

  const created = await api(address.url, '/conversations', { token: chatToken, body: {} });
  assert.equal(created.status, 201);
  const conversationId = created.json.conversation.id as string;

  const list = await api(address.url, '/conversations', { token: chatToken });
  assert.equal(list.status, 200);
  assert.equal(list.json.conversations.length, 1);

  const sent = await api(address.url, `/conversations/${conversationId}/messages`, {
    token: chatToken,
    body: { clientMessageId: 'msg-00000001', text: '查一下我的商机' },
  });
  assert.equal(sent.status, 200);
  assert.match(sent.headers.get('content-type') ?? '', /text\/event-stream/u);
  assert.match(sent.text, /event: run\.accepted/u);
  assert.match(sent.text, /event: run\.started/u);
  assert.match(sent.text, /event: message\.final/u);
  assert.match(sent.text, /event: run\.completed/u);
  assert.match(sent.text, /event: stream\.end/u);

  const run = [...repository.runs.values()][0];
  assert.equal(run?.status, 'COMPLETED');
  assert.equal(openclaw.turns.length, 1);
  assert.equal((openclaw.turns[0] as any).platformUserId, TEST_PLATFORM_A);

  const history = await api(address.url, `/conversations/${conversationId}/messages`, { token: chatToken });
  assert.equal(history.status, 200);
  assert.equal(history.json.messages[0].text, '查商机');

  const duplicate = await api(address.url, `/conversations/${conversationId}/messages`, {
    token: chatToken,
    body: { clientMessageId: 'msg-00000001', text: '查一下我的商机' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.errorCode, 'CRM_DUPLICATE_MESSAGE');
  assert.equal(openclaw.turns.length, 1, 'a duplicate must not re-dispatch the agent');

  // Same Salesforce org, different user: the conversation is invisible, not "forbidden with details".
  const exchangeB = await api(address.url, '/auth/exchange', {
    body: { bootstrapToken: material.signToken({ userId: TEST_USER_B, username: TEST_USERNAME_B }) },
  });
  assert.equal(exchangeB.status, 200);
  const tokenB = exchangeB.json.token as string;
  const foreign = await api(address.url, `/conversations/${conversationId}`, { token: tokenB });
  assert.equal(foreign.status, 404);
  const foreignMessages = await api(address.url, `/conversations/${conversationId}/messages`, { token: tokenB });
  assert.equal(foreignMessages.status, 404);
});

test('a conversation is busy while a turn runs, and stop only stops that run', async (t) => {
  const openclaw = new FakeOpenClaw();
  let releaseTurn: (() => void) | undefined;
  openclaw.turnImpl = async (body, onEvent) => {
    await onEvent({
      type: 'run.started',
      data: { runId: body.runId, sessionKey: `agent:main:sfoa-crm:${body.conversationId}`, agentId: 'main' },
    });
    await new Promise<void>((resolve) => { releaseTurn = resolve; });
    await onEvent({ type: 'run.stopped', data: { runId: body.runId, status: 'STOPPED' } });
  };
  openclaw.abort = async (body) => {
    openclaw.aborts.push(body);
    releaseTurn?.();
    return { aborted: true, reason: 'ABORTED' };
  };
  const { server, repository, material } = startGateway(openclaw);
  const address = await server.listen();
  t.after(async () => { await server.close(); });

  const exchange = await api(address.url, '/auth/exchange', { body: { bootstrapToken: material.signToken() } });
  const chatToken = exchange.json.token as string;
  const created = await api(address.url, '/conversations', { token: chatToken, body: {} });
  const conversationId = created.json.conversation.id as string;

  const first = api(address.url, `/conversations/${conversationId}/messages`, {
    token: chatToken,
    body: { clientMessageId: 'msg-00000002', text: '慢慢回答' },
  });
  // Wait until the run row exists and is active.
  let runId = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const active = await repository.getActiveRun(conversationId);
    if (active) { runId = active.id; break; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(runId);

  const busy = await api(address.url, `/conversations/${conversationId}/messages`, {
    token: chatToken,
    body: { clientMessageId: 'msg-00000003', text: '并发提问' },
  });
  assert.equal(busy.status, 409);
  assert.equal(busy.json.errorCode, 'CRM_CONVERSATION_BUSY');
  assert.equal(busy.json.runId, runId);

  const stopped = await api(address.url, `/runs/${runId}/stop`, { token: chatToken, body: {} });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.stopped, true);
  assert.deepEqual(openclaw.aborts, [{ conversationId, runId }]);

  const firstResponse = await first;
  assert.match(firstResponse.text, /event: run\.stopped/u);
  assert.match(firstResponse.text, /event: stream\.end/u);

  const run = await repository.getRun(runId);
  assert.equal(run?.status, 'STOPPED');
  assert.equal(run?.completedAt !== null, true);
});

test('a run stopped through another conversation is not stopped', async (t) => {
  const openclaw = new FakeOpenClaw({ abortResult: { aborted: false, reason: 'NOT_RUNNING' } });
  openclaw.turnImpl = async (body, onEvent) => {
    await onEvent({ type: 'run.started', data: { runId: body.runId, sessionKey: `agent:main:sfoa-crm:${body.conversationId}`, agentId: 'main' } });
    await onEvent({ type: 'run.completed', data: { runId: body.runId, status: 'COMPLETED' } });
  };
  const { server, repository, material } = startGateway(openclaw);
  const address = await server.listen();
  t.after(async () => { await server.close(); });

  const exchange = await api(address.url, '/auth/exchange', { body: { bootstrapToken: material.signToken() } });
  const chatToken = exchange.json.token as string;
  const created = await api(address.url, '/conversations', { token: chatToken, body: {} });
  const conversationId = created.json.conversation.id as string;
  await api(address.url, `/conversations/${conversationId}/messages`, {
    token: chatToken,
    body: { clientMessageId: 'msg-00000004', text: '查询' },
  });
  const run = [...repository.runs.values()][0];
  assert.equal(run?.status, 'COMPLETED');
  const stop = await api(address.url, `/runs/${run?.id}/stop`, { token: chatToken, body: {} });
  assert.equal(stop.status, 200);
  assert.equal(stop.json.stopped, false);
  assert.equal(openclaw.aborts.length, 0, 'a terminal run must not call the plugin abort endpoint');
});
