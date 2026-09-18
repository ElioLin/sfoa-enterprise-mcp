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
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { registerHooks } from "node:module";
import { after, test } from "node:test";

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

const SERVER_NAME = "sfoa-enterprise-mcp";
const MCP_URL = "http://127.0.0.1:8080/mcp";
const EXPECTED_INGRESS_URL = "http://127.0.0.1:8080/attachments";
const CHANNEL = "wecom";
const TOKEN = secretStub.state.value;

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
    registerMcpServerConnectionResolver() {},
    on(hookName, handler) {
      hooks.set(hookName, handler);
    },
  };

  plugin.register(api);

  return {
    hooks,
    lines,
    warnings: () => lines.filter(([level]) => level === "warn").map(([, message]) => message),
    async emitMessageReceived(event, context = { channelId: CHANNEL }) {
      const handler = hooks.get("message_received");
      assert.ok(handler, "message_received must be registered when the bridge is enabled");
      await handler(event, context);
    },
    emitBeforePromptBuild(context, event = {}) {
      const handler = hooks.get("before_prompt_build");
      assert.ok(handler, "before_prompt_build must be registered when the bridge is enabled");
      return handler(event, context);
    },
  };
}

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

  const result = harness.emitBeforePromptBuild({ sessionKey: "session-1", runId: "run-1" });
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
  const first = harness.emitBeforePromptBuild({ sessionKey: "session-1" });
  const second = harness.emitBeforePromptBuild({ sessionKey: "session-1", runId: "run-1-retry" });
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
  const result = injecting.emitBeforePromptBuild({ sessionKey });

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

  const forA = harness.emitBeforePromptBuild({ sessionKey: "session-a" });
  const forB = harness.emitBeforePromptBuild({ sessionKey: "session-b" });
  assert.match(forA.appendContext, /att_1111111111/u);
  assert.doesNotMatch(forA.appendContext, /att_2222222222/u);
  assert.match(forB.appendContext, /att_2222222222/u);
  assert.doesNotMatch(forB.appendContext, /att_1111111111/u);
});

test("a later message with no usable file clears the previous reference", async () => {
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
  assert.ok(harness.emitBeforePromptBuild({ sessionKey: "session-1" }));

  // The user has moved on: the next message carries no file.
  const secondCalls = await withFetch(
    async () => new Response("{}", { status: 201 }),
    async () => {
      await harness.emitMessageReceived({ senderId: "user-a", sessionKey: "session-1", content: "thanks" });
    },
  );
  assert.equal(secondCalls.length, 0, "a message without media must not call the ingress");
  assert.equal(harness.emitBeforePromptBuild({ sessionKey: "session-1" }), undefined);
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

  const context = harness.emitBeforePromptBuild({ sessionKey: "session-1" });
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

  const context = harness.emitBeforePromptBuild({ sessionKey: "session-1" });
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
  const context = harness.emitBeforePromptBuild({ sessionKey: "session-1" });
  assert.ok(context && typeof context.appendContext === "string", "the refusal must reach the model");
  assert.match(context.appendContext, /MCP_ATTACHMENT_TOO_LARGE/u);
  assert.match(context.appendContext, /Do not call `upload_files_to_record`/u);
  assert.equal(
    context.appendContext.includes("confidential-restructuring.pdf"),
    false,
    "no file name in the prompt",
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
  const context = harness.emitBeforePromptBuild({ sessionKey: "session-1" });
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

  const text = harness.emitBeforePromptBuild({ sessionKey: "session-1" }).appendContext;
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
  assert.match(harness.emitBeforePromptBuild({ sessionKey: "session-1" }).appendContext, /att_okokokokok/u);
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
