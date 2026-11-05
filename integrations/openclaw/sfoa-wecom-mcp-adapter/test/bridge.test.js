/**
 * End-to-end tests for the inbound attachment bridge, driven through the real
 * plugin entry.
 *
 * The claim under test is the one the Attachment Bridge exists for: a file a
 * WeCom user sends is carried to the SFOA Attachment Ingress by the platform,
 * and all the model ever receives is an opaque reference. The tests therefore
 * register the shipped plugin against a fake host API, hand it a real file on
 * disk, and assert on the real request the plugin builds — including the bytes
 * that travel in the body.
 *
 * They also pin the failure posture. Every precondition that is not satisfied
 * ends in *no ingress call at all*, because staging a file the run could never
 * reference would leave a user's document on the runtime with no owner story.
 *
 * The fetch double is installed before the plugin is registered: the plugin
 * captures `globalThis.fetch` once, which is what keeps a long-lived Gateway
 * from re-resolving the global on every message.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { registerHooks } from "node:module";
import { after, beforeEach, test } from "node:test";

// `src/index.js` imports the OpenClaw secret runtime, which only exists inside a
// running Gateway. Redirect just that specifier; everything else is untouched,
// so the module under test is the shipped one.
const secretRuntimeUrl = new URL(
  "../test-support/openclaw-secret-input-runtime.stub.mjs",
  import.meta.url,
).href;
const SECRET_RUNTIME_SPECIFIER = "openclaw/plugin-sdk/secret-input-runtime";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === SECRET_RUNTIME_SPECIFIER) {
      return { url: secretRuntimeUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { default: plugin } = await import("../src/index.js");
const secretStub = await import(secretRuntimeUrl);
const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));

const SERVER_NAME = "sfoa-enterprise-mcp";
const MCP_URL = "http://127.0.0.1:8080/mcp";
const EXPECTED_INGRESS_URL = "http://127.0.0.1:8080/attachments";
const CHANNEL = "wecom";
const TOKEN = secretStub.state.value;
const requesters = new Map();
beforeEach(() => { delete globalThis[Symbol.for("sfoa.enterprise.mcp.material-task-registry.v1")]; requesters.clear(); });

/** @type {string[]} */
const tempRoots = [];

after(async () => {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true });
});

/** A workspace whose staging root holds the given real files. */
async function createWorkspace(files) {
  const root = await mkdtemp(path.join(tmpdir(), "sfoa-bridge-"));
  tempRoots.push(root);
  const mediaRoot = path.join(root, "media", "inbound");
  const written = [];
  for (const [index, file] of files.entries()) {
    const directory = path.join(mediaRoot, `openclaw-staged-${index}`);
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `input-${file.name}`);
    await writeFile(filePath, file.content);
    written.push({ ...file, path: filePath });
  }
  return { root, mediaRoot, files: written };
}

/** Registers the plugin against a minimal fake of the OpenClaw plugin API. */
function createHarness(options = {}) {
  /** @type {Map<string, Function>} */
  const hooks = new Map();
  const tools = new Map();
  let resolver;
  /** @type {Array<[string, string]>} */
  const lines = [];
  const config = {
    serverName: SERVER_NAME,
    mcpUrl: MCP_URL,
    mcpWecomClientToken: "inline-credential-not-used-by-the-test",
    ...options.pluginConfig,
  };
  if (options.attachmentRoots) {
    config.attachmentBridgeEnabled = true;
    config.attachmentWorkspaceRoot = options.attachmentRoots.root;
    config.attachmentMediaRoot = options.attachmentRoots.mediaRoot;
  }

  const api = {
    config: {},
    pluginConfig: config,
    logger: {
      info: (message) => lines.push(["info", message]),
      warn: (message) => lines.push(["warn", message]),
      debug: (message) => lines.push(["debug", message]),
    },
    registerMcpServerConnectionResolver(value) { resolver = value; },
    registerTool(factory, options) {
      assert.ok(manifest.contracts?.tools?.includes(options.name), "the host requires a declared tool contract");
      tools.set(options.name, factory);
    },
    runtime: options.runtime,
    on(hookName, handler) {
      hooks.set(hookName, handler);
    },
  };

  plugin.register(api);

  return {
    hooks,
    tools,
    resolver,
    lines,
    warnings: () => lines.filter(([level]) => level === "warn").map(([, message]) => message),
    async emitMessageReceived(event, context = { channelId: CHANNEL }) {
      const handler = hooks.get("message_received");
      assert.ok(handler, "message_received must be registered when the bridge is enabled");
      if (event.senderId && event.sessionKey) requesters.set(event.sessionKey, event.senderId);
      await handler(event, context);
    },
    emitBeforePromptBuild(context, event = {}) {
      const handler = hooks.get("before_prompt_build");
      assert.ok(handler, "before_prompt_build must be registered when the bridge is enabled");
      return handler(event, { channel: CHANNEL, senderId: requesters.get(context.sessionKey), ...context });
    },
  };
}

test("host-denied persistent storage retains requester binding and material continuity without leaking the error", async () => {
  const workspace = await createWorkspace([{ name: "facts.csv", content: "客户,事实\n合成客户,尚未通过测试" }]);
  let opens = 0;
  let harness;
  await withFetch(async () => stagedResponse("att_aaaaaaaaaa"), async () => {
    harness = createHarness({ attachmentRoots: workspace, runtime: { state: {
      openKeyedStore() { opens += 1; throw new Error(`host trust denied; private detail ${TOKEN}`); },
    } } });
    const connection = await harness.resolver.resolve({ messageChannel: CHANNEL, requesterSenderId: "user-a" });
    assert.equal(connection.headers["X-WeCom-User-Id"], "user-a");
    assert.equal(connection.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(await harness.resolver.resolve({ messageChannel: CHANNEL }), null);
    await harness.emitMessageReceived({ senderId: "user-a", sessionKey: "session-1",
      media: [mediaFact(workspace.files[0].path, "text/csv")] });
    await harness.emitMessageReceived({ senderId: "user-a", sessionKey: "session-1", content: "继续" });
  });
  const context = (await harness.emitBeforePromptBuild({ sessionKey: "session-1" })).appendContext;
  assert.match(context, /att_aaaaaaaaaa/u);
  assert.match(context, /MEMORY_ONLY_REVALIDATE_AFTER_RESTART/u);
  assert.equal(opens, 1);
  assert.ok(harness.tools.has("sfoa_material_task"));
  assert.match(harness.warnings().join("\n"), /MATERIAL_TASK_STORE_UNAVAILABLE/u);
  assert.equal(harness.lines.some(([, message]) => message.includes(TOKEN)), false);
});

test("real CSV body and failed original staging remain independent across text confirmation", async () => {
  const workspace = await createWorkspace([{ name: "facts.csv", content: "客户,事实\n合成客户,尚未通过测试" }]);
  let harness;
  await withFetch(() => new Response(JSON.stringify({ errorCode: "MCP_ATTACHMENT_TOO_LARGE" }), { status: 413 }), async () => {
    harness = createHarness({ attachmentRoots: workspace,
      pluginConfig: { officePython: process.env.SFOA_MATERIAL_PYTHON ?? (process.platform === "win32" ? "python3.12" : "python3") } });
    await harness.emitMessageReceived({ senderId: "reader", sessionKey: "csv-task", messageId: "csv-1", media: [mediaFact(workspace.files[0].path, "text/csv")] });
  });
  const initial = await harness.emitBeforePromptBuild({ sessionKey: "csv-task" });
  assert.match(initial.appendContext, /尚未通过测试/u);
  assert.match(initial.appendContext, /NO_UPLOAD_REF/u);
  assert.match(initial.appendContext, /MCP_ATTACHMENT_TOO_LARGE/u);
  await harness.emitMessageReceived({ senderId: "reader", sessionKey: "csv-task", messageId: "text-2", content: "按以上创建" });
  const next = await harness.emitBeforePromptBuild({ sessionKey: "csv-task" });
  assert.match(next.appendContext, /facts.csv/u);
  assert.doesNotMatch(next.appendContext, /untrustedExtractedText/u, "old bodies stay in native history, not every prompt");
});

test("eleven originals are all staged and partial failures reach the actual prompt", async () => {
  const workspace = await createWorkspace(Array.from({ length: 11 }, (_, i) => ({ name: `${i}.pdf`, content: `%PDF synthetic ${i}` })));
  let index = 0;
  let harness;
  const calls = await withFetch(() => index++ === 4
    ? new Response(JSON.stringify({ errorCode: "MCP_ATTACHMENT_STAGING_FULL" }), { status: 503 })
    : stagedResponse(`att_batch${index}`, { expiresAt: "2030-01-01T00:00:00.000Z", contentSha256: index.toString(16).padStart(64, "0") }), async () => {
    harness = createHarness({ attachmentRoots: workspace });
    await harness.emitMessageReceived({ senderId: "batch", sessionKey: "batch-task", messageId: "batch-1", media: workspace.files.map((file) => mediaFact(file.path, "application/pdf")) });
  });
  assert.equal(calls.length, 11, "ingress does not inherit the per-upload-call limit of ten");
  const prompt = (await harness.emitBeforePromptBuild({ sessionKey: "batch-task" })).appendContext;
  assert.match(prompt, /"received":11,"staged":10,"processed":11/u);
  assert.match(prompt, /MCP_ATTACHMENT_STAGING_FULL/u);
  assert.match(prompt, /4.pdf/u);
  assert.match(prompt, /2030-01-01T00:00:00.000Z/u);
  assert.match(prompt, /contentSha256/u);
});

test("same-conversation requester switch and missing sender never expose another material", async () => {
  const workspace = await createWorkspace([{ name: "a.pdf", content: "%PDF A" }, { name: "b.pdf", content: "%PDF B" }]);
  let index = 0;
  let harness;
  await withFetch(() => stagedResponse(`att_shared${++index}`), async () => {
    harness = createHarness({ attachmentRoots: workspace });
    for (const [i, senderId] of ["alice", "bob"].entries()) await harness.emitMessageReceived({ senderId, sessionKey: "shared-chat", media: [mediaFact(workspace.files[i].path, "application/pdf")] });
  });
  const alice = await harness.emitBeforePromptBuild({ sessionKey: "shared-chat", senderId: "alice" });
  const bob = await harness.emitBeforePromptBuild({ sessionKey: "shared-chat", senderId: "bob" });
  assert.match(alice.appendContext, /att_shared1/u);
  assert.doesNotMatch(alice.appendContext, /att_shared2/u);
  assert.match(bob.appendContext, /att_shared2/u);
  assert.equal(await harness.emitBeforePromptBuild({ sessionKey: "shared-chat", senderId: undefined }), undefined);
});

test("real tool-result hook binds target; local notes and session reset never mutate CRM", async () => {
  const workspace = await createWorkspace([]);
  const harness = createHarness({ attachmentRoots: workspace });
  const tool = harness.tools.get("sfoa_material_task")({ messageChannel: "wecom", requesterSenderId: "alice", sessionKey: "task-notes" });
  assert.ok(tool);
  assert.equal(harness.tools.get("sfoa_material_task")({ messageChannel: "wecom", requesterSenderId: "alice" }), null);
  await tool.execute("note-1", { operation: "update", objective: "创建合成来访", phase: "COLLECTING", archiveStatus: "DECLINED" });
  await harness.hooks.get("after_tool_call")({ toolName: "sfoa-enterprise-mcp__create_record", params: { objectApiName: "Event__c" },
    result: { details: { structuredContent: { success: true, recordId: "a01000000000001AAA" } } } },
  { sessionKey: "task-notes", requester: { channel: "wecom", senderId: "alice" } });
  const saved = await tool.execute("note-2", { operation: "inspect" });
  assert.equal(saved.details.target.recordId, "a01000000000001AAA");
  assert.equal(saved.details.archive.status, "DECLINED");
  await harness.hooks.get("session_end")({ reason: "reset" }, { sessionKey: "task-notes" });
  const reset = await tool.execute("note-3", { operation: "inspect" });
  assert.equal(reset.details.target, undefined);
  assert.equal(reset.details.archive.status, "NOT_ASKED");
});

/**
 * Installs a fetch double, runs `body`, and returns every captured request with
 * its body already read, so the bytes that would have been uploaded are known.
 *
 * @param {(call: {url: string, init: object, body: Buffer}) => Response | Promise<Response>} responder
 * @param {() => Promise<void> | void} body
 */
async function withFetch(responder, body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const chunks = [];
    for await (const chunk of Readable.fromWeb(init.body)) chunks.push(chunk);
    const call = { url, init, body: Buffer.concat(chunks) };
    calls.push(call);
    return responder(call);
  };
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

/** A staged media fact, shaped exactly like the hook event's `media` entry. */
function mediaFact(filePath, contentType) {
  return contentType === undefined ? { path: filePath } : { path: filePath, contentType };
}

/** A 201 response shaped like the ingress' success body. */
function stagedResponse(attachmentRef, overrides = {}) {
  return new Response(JSON.stringify({ attachmentRef, ...overrides }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

test("the bridge is off until a deployment turns it on", () => {
  const harness = createHarness();
  assert.equal(harness.hooks.size, 0, "no hooks may be registered while the bridge is disabled");
  assert.match(
    harness.lines.map(([, message]) => message).join("\n"),
    /attachment bridge disabled/u,
  );
});

test("a WeCom file is streamed to the ingress and only its reference reaches the model", async () => {
  const content = Buffer.from("%PDF-1.7 sfoa attachment bridge test");
  const workspace = await createWorkspace([{ name: "invoice.pdf", content }]);
  let harness;

  const calls = await withFetch(
    async () =>
      stagedResponse("att_0123456789abcdef", {
        fileName: "invoice.pdf",
        mimeType: "application/pdf",
        byteSize: content.length,
        expiresAt: "2026-09-15T00:30:00.000Z",
      }),
    async () => {
      harness = createHarness({ attachmentRoots: workspace });
      await harness.emitMessageReceived({
        senderId: "zheng-runner-corp-01",
        sessionKey: "session-1",
        runId: "run-1",
        media: [mediaFact(workspace.files[0].path, "application/pdf")],
      });
    },
  );

  assert.equal(calls.length, 1, "exactly one file was staged");
  const [call] = calls;
  assert.equal(call.url, EXPECTED_INGRESS_URL);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["X-WeCom-User-Id"], "zheng-runner-corp-01");
  assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(call.init.headers["Content-Type"], "application/octet-stream");
  assert.equal(call.init.headers["x-sfoa-file-name"], "invoice.pdf");
  assert.equal(call.init.headers["x-sfoa-file-mime"], "application/pdf");
  assert.equal(call.init.headers["x-sfoa-source-channel"], "WECOM");
  assert.equal(call.init.headers["x-external-run-id"], "run-1");
  assert.equal(call.init.headers["Content-Length"], String(content.length));
  // The body is the file itself, byte for byte.
  assert.deepEqual(call.body, content);

  const result = await harness.emitBeforePromptBuild({ sessionKey: "session-1", runId: "run-1" });
  assert.ok(result, "the prompt build must receive attachment context");
  assert.match(result.appendContext, /att_0123456789abcdef/u);
  assert.match(result.appendContext, /invoice\.pdf/u);
  assert.equal(
    result.appendContext.includes(workspace.mediaRoot),
    false,
    "the model must never receive the staged path",
  );
});

test("a reference survives a second prompt build for the same turn", async () => {
  const workspace = await createWorkspace([{ name: "a.pdf", content: Buffer.from("aaaa") }]);
  let harness;

  await withFetch(
    async () => stagedResponse("att_aaaaaaaaaa", { fileName: "a.pdf" }),
    async () => {
      harness = createHarness({ attachmentRoots: workspace });
      await harness.emitMessageReceived({
        senderId: "user-a",
        sessionKey: "session-1",
        media: [mediaFact(workspace.files[0].path, "application/pdf")],
      });
    },
  );

  // OpenClaw may build the prompt more than once for one turn (retry,
  // compaction); the reference must survive that, because the runtime — not
  // this cache — is what consumes a reference exactly once.
  const first = await harness.emitBeforePromptBuild({ sessionKey: "session-1" });
  const second = await harness.emitBeforePromptBuild({ sessionKey: "session-1", runId: "run-1-retry" });
  assert.equal(first.appendContext, second.appendContext);
  assert.match(second.appendContext, /att_aaaaaaaaaa/u);
});

test("two registrations of the plugin share one registry, so one stages what the other injects", async () => {
  // The Gateway calls `register()` twice in a single process — once while
  // loading plugins, once while starting channels — and it does not dispatch
  // both registrations' hooks together: `message_received` is served by one and
  // `before_prompt_build` by the other.
  //
  // A registry built inside `register()` is therefore built twice, and every
  // file one registration stages is invisible to the injection the other
  // serves. That failure is silent from every angle: the ingress call succeeds
  // and is logged, the model receives no reference and truthfully reports that
  // the platform produced none, and no line in the gateway log is wrong.
  const content = Buffer.from("staged by one registration, injected by the other");
  const workspace = await createWorkspace([{ name: "one.xlsx", content }]);
  const sessionKey = "session-two-registrations";
  let staging;

  const calls = await withFetch(
    async () => stagedResponse("att_tworegistrations", { fileName: "one.xlsx" }),
    async () => {
      staging = createHarness({ attachmentRoots: workspace });
      await staging.emitMessageReceived({
        senderId: "user-two-registrations",
        sessionKey,
        media: [
          mediaFact(
            workspace.files[0].path,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ),
        ],
      });
    },
  );
  assert.equal(calls.length, 1, "the first registration staged the file");

  // The host's other half: an independent registration of the same shipped
  // plugin, which is what actually serves the prompt build.
  const injecting = createHarness({ attachmentRoots: workspace });
  const result = await injecting.emitBeforePromptBuild({ sessionKey });

  assert.ok(result, "the second registration must see what the first staged");
  assert.match(result.appendContext, /att_tworegistrations/u);
  assert.match(result.appendContext, /one\.xlsx/u);
});

test("two users in two conversations never see each other's references", async () => {
  const workspace = await createWorkspace([
    { name: "a.pdf", content: Buffer.from("a") },
    { name: "b.pdf", content: Buffer.from("b") },
  ]);
  let harness;
  let staged = 0;

  await withFetch(
    async () => {
      staged += 1;
      return stagedResponse(`att_${String(staged).repeat(10)}`, { fileName: "f.pdf" });
    },
    async () => {
      harness = createHarness({ attachmentRoots: workspace });
      await harness.emitMessageReceived({
        senderId: "user-a",
        sessionKey: "session-a",
        media: [mediaFact(workspace.files[0].path, "application/pdf")],
      });
      await harness.emitMessageReceived({
        senderId: "user-b",
        sessionKey: "session-b",
        media: [mediaFact(workspace.files[1].path, "application/pdf")],
      });
    },
  );

  const forA = await harness.emitBeforePromptBuild({ sessionKey: "session-a" });
  const forB = await harness.emitBeforePromptBuild({ sessionKey: "session-b" });
  assert.match(forA.appendContext, /att_1111111111/u);
  assert.doesNotMatch(forA.appendContext, /att_2222222222/u);
  assert.match(forB.appendContext, /att_2222222222/u);
  assert.doesNotMatch(forB.appendContext, /att_1111111111/u);
});

test("a later text confirmation retains the previous material and reference", async () => {
  const workspace = await createWorkspace([{ name: "a.pdf", content: Buffer.from("a") }]);
  let harness;

  const firstCalls = await withFetch(
    async () => stagedResponse("att_aaaaaaaaaa"),
    async () => {
      harness = createHarness({ attachmentRoots: workspace });
      await harness.emitMessageReceived({
        senderId: "user-a",
        sessionKey: "session-1",
        media: [mediaFact(workspace.files[0].path, "application/pdf")],
      });
    },
  );
  assert.equal(firstCalls.length, 1);
  assert.ok(await harness.emitBeforePromptBuild({ sessionKey: "session-1" }));

  // The user has moved on: the next message carries no file.
  const secondCalls = await withFetch(
    async () => new Response("{}", { status: 201 }),
    async () => {
      await harness.emitMessageReceived({ senderId: "user-a", sessionKey: "session-1", content: "thanks" });
    },
  );
  assert.equal(secondCalls.length, 0, "a message without media must not call the ingress");
  assert.match((await harness.emitBeforePromptBuild({ sessionKey: "session-1" })).appendContext, /att_/u);
});

test("a run outside the WeCom channel is left completely alone", async () => {
  const workspace = await createWorkspace([{ name: "a.pdf", content: Buffer.from("a") }]);
  let harness;

  const calls = await withFetch(
    async () => new Response("{}", { status: 201 }),
    async () => {
      harness = createHarness({ attachmentRoots: workspace });
      for (const channelId of ["discord", "telegram", "slack", ""]) {
        await harness.emitMessageReceived(
          { senderId: "user-a", sessionKey: "session-1", media: [mediaFact(workspace.files[0].path, "application/pdf")] },
          { channelId },
        );
      }
    },
  );
  assert.equal(calls.length, 0);
});

test("a run with no trusted requester id is left completely alone", async () => {
  const workspace = await createWorkspace([{ name: "a.pdf", content: Buffer.from("a") }]);
  let harness;

  const calls = await withFetch(
    async () => new Response("{}", { status: 201 }),
    async () => {
      harness = createHarness({ attachmentRoots: workspace });
      for (const senderId of [undefined, null, "", "   ", "bad user id", "x".repeat(200), 42]) {
        await harness.emitMessageReceived({
          senderId,
          sessionKey: "session-1",
          media: [mediaFact(workspace.files[0].path, "application/pdf")],
        });
      }
    },
  );
  assert.equal(calls.length, 0);
});

test("pending local staging is never guessed at, and never uploaded", async () => {
  const workspace = await createWorkspace([{ name: "a.pdf", content: Buffer.from("a") }]);
  let harness;

  const calls = await withFetch(
    async () => new Response("{}", { status: 201 }),
    async () => {
      harness = createHarness({ attachmentRoots: workspace });
      await harness.emitMessageReceived({
        senderId: "user-a",
        sessionKey: "session-1",
        mediaStagingPending: true,
        originalMedia: [{ url: "https://wecom.example/media/1" }],
      });
    },
  );
  assert.equal(calls.length, 0);
  assert.ok(
    harness.lines.some(([, message]) => message.includes("MEDIA_STAGING_PENDING")),
    "the withheld reason must be visible to an operator",
  );
});

test("a file that is not on this host is never fetched by the runtime", async () => {
  const workspace = await createWorkspace([]);
  let harness;

  const calls = await withFetch(
    async () => new Response("{}", { status: 201 }),
    async () => {
      harness = createHarness({ attachmentRoots: workspace });
      await harness.emitMessageReceived({
        senderId: "user-a",
        sessionKey: "session-1",
        media: [
          { url: "https://wecom.example/media/1", contentType: "image/png" },
          { url: "http://169.254.169.254/latest/meta-data/" },
          { path: "file:///etc/passwd" },
        ],
      });
    },
  );
  assert.equal(calls.length, 0);
});

test("a path outside the staging root is refused before it is opened", async () => {
  const workspace = await createWorkspace([]);
  let harness;

  const calls = await withFetch(
    async () => new Response("{}", { status: 201 }),
    async () => {
      harness = createHarness({ attachmentRoots: workspace });
      await harness.emitMessageReceived({
        senderId: "user-a",
        sessionKey: "session-1",
        media: [
          { path: path.join(workspace.root, "..", "outside.pdf") },
          { path: path.join(workspace.root, "secrets.txt") },
        ],
      });
    },
  );
  assert.equal(calls.length, 0);
});

test("a file the channel staged outside the workspace still reaches the ingress", async () => {
  // The WeCom channel plugin downloads a file itself and reports a path below
  // its own media directory, never below the workspace. The bridge once accepted
  // only the workspace root, so every WeCom file was refused by a check that ran
  // before the first log line — and the model was left to report "no reference
  // arrived". This is that regression, pinned.
  const workspace = await createWorkspace([]);
  const channelRoot = path.join(workspace.root, "state-media", "inbound");
  await mkdir(channelRoot, { recursive: true });
  const channelFile = path.join(
    channelRoot,
    "订单行已抛SAP数量同步接口文档---4163435e-e2ed-4f17-a4da-166b614e07f8.md",
  );
  await writeFile(channelFile, "content");

  let harness;
  const calls = await withFetch(
    async (call) =>
      stagedResponse("att_".padEnd(14, "a"), {
        fileName: decodeURIComponent(call.init.headers["x-sfoa-file-name"]),
        mimeType: call.init.headers["x-sfoa-file-mime"],
      }),
    async () => {
      harness = createHarness({
        pluginConfig: {
          attachmentBridgeEnabled: true,
          attachmentWorkspaceRoot: workspace.root,
          attachmentMediaRoots: [workspace.mediaRoot, channelRoot],
        },
      });
      await harness.emitMessageReceived({
        senderId: "user-a",
        sessionKey: "session-1",
        media: [mediaFact(channelFile, "text/markdown")],
      });
    },
  );

  assert.equal(calls.length, 1, "the channel's own staged file must reach the ingress");
  assert.equal(
    decodeURIComponent(calls[0].init.headers["x-sfoa-file-name"]),
    "订单行已抛SAP数量同步接口文档.md",
    "the staging identity suffix is not part of the user's file name",
  );
  assert.equal(harness.warnings().length, 0, "a staged file is not a warning");

  const context = await harness.emitBeforePromptBuild({ sessionKey: "session-1" });
  assert.ok(context && context.appendContext.includes("att_"), "the reference reaches the model");
});

test("a file below no configured root reports why instead of staying silent", async () => {
  // With nothing acceptable the bridge must fail closed, and the model must be
  // told — silence here is what invites it to guess.
  const workspace = await createWorkspace([{ name: "a.pdf", content: Buffer.from("a") }]);
  const elsewhere = path.join(workspace.root, "not-a-staging-root");
  await mkdir(elsewhere, { recursive: true });
  const strayFile = path.join(elsewhere, "a.pdf");
  await writeFile(strayFile, "a");

  let harness;
  const calls = await withFetch(
    async () => stagedResponse("att_".padEnd(14, "a")),
    async () => {
      harness = createHarness({ attachmentRoots: workspace });
      await harness.emitMessageReceived({
        senderId: "user-a",
        sessionKey: "session-1",
        media: [mediaFact(strayFile, "application/pdf")],
      });
    },
  );

  assert.equal(calls.length, 0, "no ingress call for a path outside every root");
  assert.match(harness.warnings().join("\n"), /MEDIA_PATH_REJECTED/u);

  const context = await harness.emitBeforePromptBuild({ sessionKey: "session-1" });
  assert.ok(context && typeof context.appendContext === "string");
  assert.match(context.appendContext, /MEDIA_PATH_REJECTED/u);
  assert.equal(context.appendContext.includes("a.pdf"), false, "no file name in the prompt");
});

test("an ingress refusal leaves the model with no reference and the log with no file name", async () => {
  const workspace = await createWorkspace([
    { name: "confidential-restructuring.pdf", content: Buffer.from("a") },
  ]);
  let harness;

  await withFetch(
    async () =>
      new Response(
        JSON.stringify({ errorCode: "MCP_ATTACHMENT_TOO_LARGE", message: "The attachment exceeds the ceiling." }),
        { status: 413 },
      ),
    async () => {
      harness = createHarness({ attachmentRoots: workspace });
      await harness.emitMessageReceived({
        senderId: "user-a",
        sessionKey: "session-1",
        media: [mediaFact(workspace.files[0].path, "application/pdf")],
      });
    },
  );

  // The model gets the reason and the prohibition — never a reference it could
  // act on, and never the user's own document title.
  const context = await harness.emitBeforePromptBuild({ sessionKey: "session-1" });
  assert.ok(context && typeof context.appendContext === "string", "the refusal must reach the model");
  assert.match(context.appendContext, /MCP_ATTACHMENT_TOO_LARGE/u);
  assert.match(context.appendContext, /NO_UPLOAD_REF/u);
  assert.equal(
    context.appendContext.includes("confidential-restructuring.pdf"),
    true,
    "the requester sees which material failed; gateway logs remain title-free",
  );
  assert.equal(context.appendContext.includes(workspace.mediaRoot), false, "no staged path in the prompt");

  const warnings = harness.warnings().join("\n");
  assert.match(warnings, /MCP_ATTACHMENT_TOO_LARGE/u);
  assert.equal(warnings.includes("confidential-restructuring.pdf"), false, "no file name in the log");
  assert.equal(warnings.includes(workspace.mediaRoot), false, "no staged path in the log");
});

test("a runtime that is not reachable costs the turn nothing", async () => {
  const workspace = await createWorkspace([{ name: "a.pdf", content: Buffer.from("a") }]);
  let harness;

  const calls = await withFetch(
    async () => {
      throw new TypeError("fetch failed");
    },
    async () => {
      harness = createHarness({ attachmentRoots: workspace });
      await harness.emitMessageReceived({
        senderId: "user-a",
        sessionKey: "session-1",
        media: [mediaFact(workspace.files[0].path, "application/pdf")],
      });
    },
  );

  assert.equal(calls.length, 1);
  assert.match(harness.warnings().join("\n"), /Attachment Ingress call failed/u);

  // The turn still runs. The model is told the file could not be staged rather
  // than being left to guess why a file message carried no reference.
  const context = await harness.emitBeforePromptBuild({ sessionKey: "session-1" });
  assert.ok(context && typeof context.appendContext === "string");
  assert.match(context.appendContext, /INGRESS_UNREACHABLE/u);
});

test("only the usable files of a multi-file message are staged", async () => {
  const workspace = await createWorkspace([
    { name: "ok.pdf", content: Buffer.from("ok") },
    { name: "photo.png", content: Buffer.from("png") },
  ]);
  let harness;
  let staged = 0;

  const calls = await withFetch(
    async (call) => {
      staged += 1;
      // Echo the metadata back the way the ingress does, so the assertion
      // covers the round trip rather than the local value.
      return stagedResponse(`att_${String(staged).repeat(10)}`, {
        fileName: decodeURIComponent(call.init.headers["x-sfoa-file-name"]),
        mimeType: call.init.headers["x-sfoa-file-mime"],
      });
    },
    async () => {
      harness = createHarness({ attachmentRoots: workspace });
      await harness.emitMessageReceived({
        senderId: "user-a",
        sessionKey: "session-1",
        media: [
          mediaFact(workspace.files[0].path, "application/pdf"),
          { url: "https://wecom.example/media/remote" },
          mediaFact(workspace.files[1].path, "image/png"),
        ],
      });
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers["x-sfoa-file-name"], "ok.pdf");
  assert.equal(calls[0].init.headers["x-sfoa-file-mime"], "application/pdf");
  assert.equal(calls[1].init.headers["x-sfoa-file-name"], "photo.png");
  assert.equal(calls[1].init.headers["x-sfoa-file-mime"], "image/png");

  const text = (await harness.emitBeforePromptBuild({ sessionKey: "session-1" })).appendContext;
  assert.match(text, /att_1111111111/u);
  assert.match(text, /att_2222222222/u);
  assert.match(text, /ok\.pdf/u);
  assert.match(text, /photo\.png/u);
});

test("one unusable file does not stop the others", async () => {
  const workspace = await createWorkspace([{ name: "ok.pdf", content: Buffer.from("ok") }]);
  let harness;

  const calls = await withFetch(
    async () => stagedResponse("att_okokokokok", { fileName: "ok.pdf" }),
    async () => {
      harness = createHarness({ attachmentRoots: workspace });
      await harness.emitMessageReceived({
        senderId: "user-a",
        sessionKey: "session-1",
        media: [
          { path: path.join(workspace.mediaRoot, "missing", "input-gone.pdf") },
          mediaFact(workspace.files[0].path, "application/pdf"),
        ],
      });
    },
  );

  assert.equal(calls.length, 1, "only the readable file is sent");
  assert.match((await harness.emitBeforePromptBuild({ sessionKey: "session-1" })).appendContext, /att_okokokokok/u);
});

test("no log line ever carries a staged path, a file byte, or the credential", async () => {
  const workspace = await createWorkspace([{ name: "a.pdf", content: Buffer.from("secret-bytes") }]);
  let harness;

  await withFetch(
    async () => stagedResponse("att_aaaaaaaaaa"),
    async () => {
      harness = createHarness({ attachmentRoots: workspace });
      await harness.emitMessageReceived({
        senderId: "user-a",
        sessionKey: "session-1",
        media: [mediaFact(workspace.files[0].path, "application/pdf")],
      });
    },
  );

  assert.ok(harness.lines.length > 0, "the bridge must log something to make this assertion meaningful");
  const joined = harness.lines.map(([, message]) => message).join("\n");
  assert.equal(joined.includes(workspace.mediaRoot), false);
  assert.equal(joined.includes("secret-bytes"), false);
  assert.equal(joined.includes(TOKEN), false, "the channel credential must never be logged");
});
