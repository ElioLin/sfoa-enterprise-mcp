import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { pdfResult, imageResult, transcriptEvent } from "../test-support/openclaw-native-contracts.mjs";

registerHooks({ resolve(specifier, context, next) {
  return specifier === "openclaw/plugin-sdk/secret-input-runtime"
    ? { url: new URL("../test-support/openclaw-secret-input-runtime.stub.mjs", import.meta.url).href, shortCircuit: true }
    : next(specifier, context);
} });
const { default: plugin } = await import("../src/index.js");
beforeEach(() => { delete globalThis[Symbol.for("sfoa.enterprise.mcp.material-task-registry.v1")]; });

async function harness(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "sfoa-native-")), media = path.join(root, "media");
  await mkdir(media);
  t.after(() => rm(root, { recursive: true, force: true }));
  const hooks = new Map(), internal = new Map();
  let factory;
  const originalFetch = globalThis.fetch;
  let number = 0, ingressGate;
  globalThis.fetch = async (_url, request) => {
    const bytes = await new Response(request.body).arrayBuffer();
    if (ingressGate) { ingressGate.enter(); await ingressGate.wait; }
    return new Response(JSON.stringify({ attachmentRef: `att_native_${++number}`, expiresAt: "2030-01-01T00:00:00.000Z",
      contentSha256: createHash("sha256").update(Buffer.from(bytes)).digest("hex") }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  plugin.register({ config: { plugins: { entries: { "sfoa-wecom-mcp-adapter": {
    hooks: { allowConversationAccess: options.conversationAccess ?? true },
  } } }, hooks: { internal: { enabled: options.internalHooks ?? true } } }, pluginConfig: { attachmentBridgeEnabled: true, attachmentWorkspaceRoot: root,
    attachmentMediaRoots: [media], mcpWecomClientToken: "fixture", mcpUrl: "http://127.0.0.1:8080/mcp" },
    logger: { info() {}, warn() {}, debug() {} }, registerMcpServerConnectionResolver() {},
    registerTool(value) { factory = value; }, on(name, fn) { hooks.set(name, fn); },
    registerHook(name, fn, options) { assert.equal(name, "message:transcribed"); assert.ok(options.name); internal.set(name, fn); },
  });
  const ctx = { channel: "wecom", senderId: "alice", sessionKey: "native", sessionId: "session", runId: "run" };
  const completion = { sessionKey: ctx.sessionKey, sessionId: ctx.sessionId, runId: ctx.runId };
  const tool = factory(ctx);
  const inspect = async () => (await tool.execute("inspect", { operation: "inspect" })).details;
  return { hooks, internal, ctx, completion, tool, inspect, media,
    pauseIngress() {
      let release, enter;
      const wait = new Promise((resolve) => { release = resolve; });
      const started = new Promise((resolve) => { enter = resolve; });
      ingressGate = { wait, enter };
      t.after(release);
      return { started, release };
    },
    async receive(name, type, messageId, extra = {}) {
      const file = path.join(media, name);
      await writeFile(file, extra.bytes ?? `${name}: actual fixture bytes`);
      await hooks.get("message_received")({ senderId: "alice", sessionKey: ctx.sessionKey, messageId,
        media: [{ path: file, contentType: type, ...extra.fact }] }, { channelId: "wecom" });
      return file;
    },
    prompt: () => hooks.get("before_prompt_build")({ prompt: "Review materials", messages: [] }, ctx),
    async complete(toolName, result, extra = {}) {
      await hooks.get("after_tool_call")({ toolName, params: {}, runId: "run", toolCallId: "read-1", result, ...extra }, completion);
    },
  };
}

test("real registered hooks bind a PDF result to one original and retain honest partial coverage", async (t) => {
  const h = await harness(t);
  const pdf = await h.receive("brief.pdf", "application/pdf", "pdf-msg");
  await h.prompt();
  await h.complete("pdf", pdfResult(pdf, "客户尚未承诺采购，数量未定。"));
  const task = await h.inspect(), reading = task.materials[0].reading;
  assert.equal(reading.status, "PARTIAL");
  assert.equal(reading.coverage.pages, "UNKNOWN");
  assert.equal(reading.evidence.operation, "ANALYSIS_COMPLETED");
  assert.equal(task.materials[0].upload.status, "NOT_ATTEMPTED");
  assert.equal(task.archive.status, "NOT_ASKED");
  const detail = await h.tool.execute("body", { operation: "inspect", materialIds: [task.materials[0].materialId] });
  assert.match(detail.details.materials[0].reading.text, /尚未承诺采购/u);
});

test("native image delivery is model input, never inferred semantic completion", async (t) => {
  const h = await harness(t), png = await h.receive("photo.png", "image/png", "image-msg");
  await h.prompt();
  await h.complete("view_image", imageResult(png));
  const material = (await h.inspect()).materials[0];
  assert.equal(material.nativeInput.status, "PROVIDED_TO_MODEL");
  assert.equal(material.nativeInput.semanticAnalysis, "UNKNOWN");
  assert.equal(material.reading.status, "UNKNOWN");
  await h.hooks.get("agent_end")({ success: true }, h.ctx);
  assert.equal((await h.inspect()).phase, "ACTIVE");
});

test("PDF observations reject wrong requester, session, task, ambiguous source and model claims", async (t) => {
  const h = await harness(t), pdf = await h.receive("same.pdf", "application/pdf", "first");
  await h.prompt();
  const event = { toolName: "pdf", params: {}, runId: "run", toolCallId: "read", result: pdfResult(pdf) };
  for (const ctx of [
    { ...h.completion, sessionKey: "other" },
    { ...h.completion, requester: { channel: "wecom", senderId: "bob" } },
    { ...h.completion, sessionId: "different" },
  ]) await h.hooks.get("after_tool_call")(event, ctx);
  await h.complete("pdf", { content: [{ type: "text", text: "I read it all" }] });
  assert.equal((await h.inspect()).materials[0].reading.status, "UNKNOWN");
  // A path reused for different bytes has two material versions and is not unique.
  await h.receive("same.pdf", "application/pdf", "second", { bytes: "different source version" });
  await h.complete("pdf", pdfResult(pdf));
  assert.deepEqual((await h.inspect()).materials.map((entry) => entry.reading.status), ["UNKNOWN", "UNKNOWN"]);
  const old = await h.inspect();
  await h.tool.execute("new", { operation: "new_task", materialIds: [old.materials[0].materialId] });
  await h.complete("pdf", pdfResult(pdf));
  assert.equal((await h.inspect()).materials[0].reading.status, "UNKNOWN");
});

test("before-tool snapshots isolate delayed results while allowing newly started work after new_task", async (t) => {
  const h = await harness(t), pdf = await h.receive("brief.pdf", "application/pdf", "pdf-msg");
  await h.prompt();
  const oldCall = { toolName: "pdf", params: {}, runId: "run", toolCallId: "old" };
  await h.hooks.get("before_tool_call")(oldCall, h.completion);
  const materialId = (await h.inspect()).materials[0].materialId;
  await h.tool.execute("new", { operation: "new_task", materialIds: [materialId] });
  await h.hooks.get("after_tool_call")({ ...oldCall, result: pdfResult(pdf) }, h.completion);
  assert.equal((await h.inspect()).materials[0].reading.status, "UNKNOWN");
  const newCall = { ...oldCall, toolCallId: "new" };
  await h.hooks.get("before_tool_call")(newCall, h.completion);
  await h.hooks.get("after_tool_call")({ ...newCall, result: pdfResult(pdf) }, h.completion);
  assert.equal((await h.inspect()).materials[0].reading.status, "PARTIAL");
});

test("actual transcription hook retains text only for the unique received user/session/message/path", async (t) => {
  const h = await harness(t), wav = await h.receive("voice.wav", "audio/wav", "audio-msg");
  const emit = h.internal.get("message:transcribed");
  for (const event of [transcriptEvent("other", "alice", "audio-msg", wav), transcriptEvent("native", "bob", "audio-msg", wav),
    transcriptEvent("native", "alice", "other-msg", wav), transcriptEvent("native", "alice", "audio-msg", path.join(h.media, "missing.wav"))]) await emit(event);
  assert.equal((await h.inspect()).materials[0].reading.status, "UNKNOWN");
  await emit(transcriptEvent("native", "alice", "audio-msg", wav));
  const task = await h.inspect(), material = task.materials[0];
  assert.equal(material.reading.status, "PARTIAL");
  assert.equal(material.reading.coverage.timecodes, "UNKNOWN");
  assert.equal(material.reading.coverage.speakers, "UNKNOWN");
  assert.equal(material.reading.coverage.confidence, "UNKNOWN");
  const body = (await h.tool.execute("inspect", { operation: "inspect", materialIds: [material.materialId] })).details.materials[0].reading.text;
  assert.match(body, /尚未承诺采购/u);
  assert.equal(material.upload.status, "NOT_ATTEMPTED");
});

test("message-level multi-audio transcript and late old-task transcript are not attributed", async (t) => {
  const h = await harness(t), first = await h.receive("first.wav", "audio/wav", "audio-msg"), emit = h.internal.get("message:transcribed");
  const event = transcriptEvent("native", "alice", "audio-msg", first);
  event.context.media.push({ path: path.join(h.media, "second.wav"), kind: "audio", transcribed: true });
  await emit(event);
  assert.equal((await h.inspect()).materials[0].reading.status, "UNKNOWN");
  await h.tool.execute("new", { operation: "new_task", materialIds: [(await h.inspect()).materials[0].materialId] });
  await emit(transcriptEvent("native", "alice", "audio-msg", first));
  assert.equal((await h.inspect()).materials[0].reading.status, "UNKNOWN");
});

test("same content resent from a new real path keeps one material and receives newer native evidence", async (t) => {
  const h = await harness(t);
  await h.receive("first.wav", "audio/wav", "first", { bytes: "same original bytes" });
  const second = await h.receive("second.wav", "audio/wav", "second", { bytes: "same original bytes" });
  await h.internal.get("message:transcribed")(transcriptEvent("native", "alice", "second", second));
  const task = await h.inspect();
  assert.equal(task.materials.length, 1);
  assert.equal(task.materials[0].reading.status, "PARTIAL");
  assert.equal(task.materials[0].reading.sourceMessageId, "second");
  assert.equal(task.materials[0].sourcePaths.length, 2);
});

test("host transcription flag is evidence of transcription with no invented transcript body", async (t) => {
  const h = await harness(t);
  await h.receive("voice.wav", "audio/wav", "flag", { fact: { kind: "audio", transcribed: true } });
  const reading = (await h.inspect()).materials[0].reading;
  assert.equal(reading.status, "PARTIAL");
  assert.equal(reading.source, "OPENCLAW_TRANSCRIPTION_FLAG");
  assert.equal(reading.text, undefined);
});

test("a delayed ingress receipt cannot attach files or reading evidence to a new task", async (t) => {
  const h = await harness(t), gate = h.pauseIngress();
  const receiving = h.receive("late.pdf", "application/pdf", "old-message");
  await gate.started;
  const old = await h.inspect();
  await h.tool.execute("new", { operation: "new_task", objective: "Independent request" });
  gate.release();
  await receiving;
  const task = await h.inspect();
  assert.notEqual(task.taskId, old.taskId);
  assert.equal(task.materials.length, 0);
});

test("transcription arriving while staging is pending is applied only after the matching original is registered", async (t) => {
  const h = await harness(t), gate = h.pauseIngress();
  const receiving = h.receive("early.wav", "audio/wav", "early-message");
  await gate.started;
  await h.internal.get("message:transcribed")(transcriptEvent("native", "alice", "early-message", path.join(h.media, "early.wav")));
  assert.equal((await h.inspect()).materials.length, 0);
  gate.release();
  await receiving;
  assert.equal((await h.inspect()).materials[0].reading.status, "PARTIAL");
});

test("legacy transcription observation honors the host conversation-access and internal-hook switches", async (t) => {
  for (const options of [{ conversationAccess: false }, { internalHooks: false }]) {
    delete globalThis[Symbol.for("sfoa.enterprise.mcp.material-task-registry.v1")];
    const h = await harness(t, options);
    assert.equal(h.internal.size, 0);
    await h.receive("private.wav", "audio/wav", "private");
    assert.equal((await h.inspect()).materials[0].reading.status, "UNKNOWN");
  }
});
