/**
 * Ingress tests: register the shipped plugin against a fake OpenClaw host API,
 * then drive its real HTTP route handlers with mock request/response objects.
 *
 * These tests cover the part that must not depend on a running Gateway:
 * service-credential authentication, SSE framing, busy refusal and history.
 * Real OpenClaw routing is covered by turn-service.test.js and by the
 * isolated Gateway gate documented in the implementation report.
 */

import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { registerHooks } from "node:module";
import test from "node:test";

const secretRuntimeUrl = new URL(
  "../test-support/openclaw-secret-input-runtime.stub.mjs",
  import.meta.url,
).href;
const SECRET_RUNTIME_SPECIFIER = "openclaw/plugin-sdk/secret-input-runtime";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === SECRET_RUNTIME_SPECIFIER) return { url: secretRuntimeUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const { default: plugin } = await import("../src/index.js");
const { reset: resetSecret } = await import("../test-support/openclaw-secret-input-runtime.stub.mjs");

const SERVICE_TOKEN = "test-crm-service-credential";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID_2 = "33333333-3333-4333-8333-333333333333";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

class MockResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.headersFlushed = false;
  }
  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  getHeader(name) { return this.headers[name.toLowerCase()]; }
  flushHeaders() { this.headersFlushed = true; }
  end(chunk, encoding, callback) {
    if (chunk !== undefined && chunk !== null && typeof chunk !== "function") this.chunks.push(Buffer.from(chunk));
    const actualCallback = typeof chunk === "function" ? chunk : callback;
    const result = super.end(actualCallback);
    this.emit("close");
    return result;
  }
  get text() { return Buffer.concat(this.chunks).toString("utf8"); }
}

function createMockRequest({ method = "POST", body, authorization = `Bearer ${SERVICE_TOKEN}`, remoteAddress = "127.0.0.1" } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = "/";
  req.headers = authorization === undefined ? {} : { authorization };
  req.socket = { remoteAddress };
  return req;
}

function createHost(dispatch) {
  const routes = new Map();
  const options = new Map();
  const runtime = {
    channel: {
      routing: {
        resolveAgentRoute: ({ peer }) => ({
          sessionKey: `agent:main:sfoa-crm:${peer.id}`,
          agentId: "main",
          accountId: "default",
        }),
      },
      session: {
        resolveStorePath: () => "/tmp/openclaw-test-store",
        recordInboundSession: async () => {},
      },
      reply: {
        finalizeInboundContext: (ctx) => ctx,
        dispatchReplyWithBufferedBlockDispatcher: async (params) => dispatch(params),
      },
    },
    gateway: {
      request: async () => ({ messages: [] }),
    },
    subagent: {
      getSessionMessages: async () => ({
        messages: [
          { id: "m1", role: "user", text: "查商机" },
          { id: "m2", role: "assistant", text: "有 3 条" },
        ],
      }),
    },
  };
  const api = {
    config: {},
    pluginConfig: { serviceToken: SERVICE_TOKEN },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    runtime,
    registerChannel: () => {},
    registerHttpRoute: ({ path, handler, ...routeOptions }) => {
      routes.set(path, handler);
      options.set(path, routeOptions);
    },
  };
  plugin.register(api);
  routes.options = options;
  return routes;
}

test("ingress rejects a missing or wrong service credential before reading the body", async () => {
  resetSecret();
  const routes = createHost(async () => {});
  const handler = routes.get("/plugins/sfoa-crm/turn");

  for (const authorization of [null, "Bearer wrong-token", "Basic abc"]) {
    const res = new MockResponse();
    const handled = await handler(createMockRequest({ authorization, body: {} }), res);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.text);
    assert.equal(body.errorCode, "CRM_CHANNEL_AUTH_FAILED");
    assert.ok(body.correlationId);
  }
});

test("ingress refuses a non-loopback caller by default, before accepting the service credential", async () => {
  resetSecret();
  const routes = createHost(async () => {});
  const handler = routes.get("/plugins/sfoa-crm/turn");
  const res = new MockResponse();
  await handler(createMockRequest({
    remoteAddress: "10.20.30.40",
    body: { platformUserId: "61979", conversationId: CONVERSATION_ID, runId: RUN_ID, message: "hi" },
  }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.text).errorCode, "CRM_LOOPBACK_REQUIRED");
});

test("a credentialed turn streams deltas, a final answer and a terminal event", async () => {
  resetSecret();
  const routes = createHost(async ({ replyOptions, dispatcherOptions }) => {
    replyOptions.onPartialReply({ text: "你" });
    replyOptions.onPartialReply({ text: "你好" });
    await dispatcherOptions.deliver({ text: "你好，我是助手" });
  });
  const handler = routes.get("/plugins/sfoa-crm/turn");
  const res = new MockResponse();
  const handled = await handler(createMockRequest({
    body: {
      platformUserId: "61979",
      conversationId: CONVERSATION_ID,
      runId: RUN_ID,
      message: "你好",
    },
  }), res);

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.getHeader("content-type"), /text\/event-stream/u);
  assert.match(res.text, /event: run\.started/u);
  assert.match(res.text, /event: message\.delta/u);
  assert.match(res.text, /event: message\.final/u);
  assert.match(res.text, /event: run\.completed/u);
  assert.doesNotMatch(res.text, /SERVICE_TOKEN|Bearer/u);
});

test("a duplicate turn on a busy conversation gets 409 before SSE headers", async () => {
  resetSecret();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const routes = createHost(async ({ replyOptions }) => {
    await Promise.race([
      gate,
      new Promise((_, reject) => replyOptions.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    ]);
  });
  const turnHandler = routes.get("/plugins/sfoa-crm/turn");
  const firstRes = new MockResponse();
  const first = turnHandler(createMockRequest({
    body: { platformUserId: "61979", conversationId: CONVERSATION_ID, runId: RUN_ID, message: "第一轮" },
  }), firstRes);
  await new Promise((resolve) => setTimeout(resolve, 5));

  const secondRes = new MockResponse();
  await turnHandler(createMockRequest({
    body: { platformUserId: "61979", conversationId: CONVERSATION_ID, runId: RUN_ID_2, message: "第二轮" },
  }), secondRes);
  assert.equal(secondRes.statusCode, 409);
  assert.equal(JSON.parse(secondRes.text).errorCode, "CRM_CONVERSATION_BUSY");
  assert.equal(secondRes.getHeader("content-type"), "application/json; charset=utf-8");

  const abortHandler = routes.get("/plugins/sfoa-crm/abort");
  const abortRes = new MockResponse();
  await abortHandler(createMockRequest({
    body: { conversationId: CONVERSATION_ID, runId: RUN_ID },
  }), abortRes);
  assert.equal(abortRes.statusCode, 200);
  assert.equal(JSON.parse(abortRes.text).aborted, true);
  release();
  await first;
});

test("history is exposed on a gateway-authenticated trusted-operator route", () => {
  resetSecret();
  const routes = createHost(async () => {});
  const options = routes.options.get("/plugins/sfoa-crm/history");
  assert.equal(options.auth, "gateway");
  assert.equal(options.gatewayRuntimeScopeSurface, "trusted-operator");
  assert.equal(options.match, "exact");
  assert.equal(routes.options.get("/plugins/sfoa-crm/turn").auth, "plugin");
});

test("history is served through the gateway-authenticated route and is projected", async () => {
  resetSecret();
  const routes = createHost(async () => {});
  const handler = routes.get("/plugins/sfoa-crm/history");
  const res = new MockResponse();
  await handler(createMockRequest({
    body: { sessionKey: "agent:main:sfoa-crm:test", limit: 10 },
  }), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.text);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1].text, "有 3 条");
});

test("health reports only safe channel facts", async () => {
  resetSecret();
  const routes = createHost(async () => {});
  const handler = routes.get("/plugins/sfoa-crm/health");
  const res = new MockResponse();
  await handler(createMockRequest({ method: "GET", authorization: `Bearer ${SERVICE_TOKEN}` }), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.text);
  assert.deepEqual(Object.keys(body).sort(), ["activeTurns", "channel", "ok", "version"]);
  assert.equal(body.channel, "sfoa-crm");
});

test("an unresolved service credential withholds every turn", async () => {
  resetSecret({ value: undefined, unresolvedRefReason: "missing" });
  const routes = createHost(async () => {});
  const handler = routes.get("/plugins/sfoa-crm/turn");
  const res = new MockResponse();
  await handler(createMockRequest({
    authorization: "Bearer test-crm-service-credential",
    body: { platformUserId: "61979", conversationId: CONVERSATION_ID, runId: RUN_ID, message: "hi" },
  }), res);
  assert.equal(res.statusCode, 401);
});
