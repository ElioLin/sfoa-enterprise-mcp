/** Observations of OpenClaw 2026.9.5 events, never a new reader or write gate. */
import path from "node:path";
import { MATERIAL_TASK_TTL_MS, materialScope, mergeMaterialReading } from "./material-tasks.js";
import { normalizeRequesterId } from "./resolver.js";

const MAX_BINDINGS = 128;
const MAX_NATIVE_TEXT = 24000;
const nonempty = (value) => typeof value === "string" && value.length > 0;
const runKey = (ctx) => nonempty(ctx?.runId) && nonempty(ctx?.sessionKey)
  ? JSON.stringify([ctx.sessionKey, ctx.sessionId ?? "", ctx.runId]) : undefined;
const localPath = (value) => nonempty(value) && value.length <= 4096 && path.isAbsolute(value) ? path.normalize(value) : undefined;

function sourceMatches(task, paths, messageId) {
  const wanted = new Set(paths.map(localPath).filter(Boolean));
  return task.materials.filter((material) => (material.sourcePaths ?? []).some((source) =>
    wanted.has(localPath(source.path)) && (!messageId || source.messageId === messageId)));
}

function nativeReading(text, source, coverage, evidence) {
  return { status: "PARTIAL", source, evidence, coverage: { ...coverage,
    ...(typeof text === "string" ? { textCharactersExtracted: text.length, textCharactersProvided: Math.min(text.length, MAX_NATIVE_TEXT) } : {}) },
    ...(typeof text === "string" ? { text: text.slice(0, MAX_NATIVE_TEXT) } : {}),
    reasons: ["NATIVE_SOURCE_COVERAGE_UNAVAILABLE", ...(text?.length > MAX_NATIVE_TEXT ? ["NATIVE_TEXT_LIMIT"] : [])] };
}

export function inboundNativeReading(event, sourcePath, resolvePath) {
  const facts = (Array.isArray(event?.media) ? event.media : []).filter((fact) =>
    resolvePath(fact?.path) === sourcePath && fact?.transcribed === true &&
    (fact.kind === "audio" || fact.contentType?.startsWith("audio/")));
  if (facts.length !== 1) return;
  return nativeReading(undefined, "OPENCLAW_TRANSCRIPTION_FLAG", { unit: "host-transcription-flag", extent: "UNKNOWN" },
    { hook: "message_received", operation: "TRANSCRIPTION_REPORTED", transcript: "NOT_EXPOSED_BY_THIS_EVENT" });
}

/** Only host-produced resolved references count; input paths and model prose do not. */
export function observeNativeToolResult(task, event, current) {
  if (!["pdf", "view_image"].includes(event?.toolName) || event.error) return;
  const result = event.result;
  const details = result?.details;
  if (!details || result.isError || details.error) return;
  const key = event.toolName === "pdf" ? "pdf" : "image";
  const references = nonempty(details[key]) ? [details]
    : Array.isArray(details[`${key}s`]) ? details[`${key}s`].slice(0, 20) : [];
  const hasText = nonempty(details.model) && nonempty(details.text) &&
    result.content?.some((block) => block?.type === "text" && block.text === details.text);
  const nativeImages = event.toolName === "view_image" && details.transport === "native" &&
    result.content?.filter((block) => block?.type === "image" && nonempty(block.data)).length === references.length;
  if (!references.length || (!hasText && !nativeImages)) return;
  // Multi-source analysis does not attribute its combined prose to each original.
  const text = references.length === 1 && hasText ? details.text : undefined;
  for (const reference of references) {
    const matches = sourceMatches(task, [reference?.[key], reference?.rewrittenFrom]);
    if (matches.length !== 1) continue;
    const material = matches[0];
    const evidence = { hook: "after_tool_call", toolName: event.toolName,
      ...(nonempty(event.toolCallId) ? { toolCallId: event.toolCallId.slice(0, 256) } : {}),
      observedAt: current };
    if (nativeImages) {
      // A successful native view_image loads model input; it is not a semantic result.
      material.nativeInput = { status: "PROVIDED_TO_MODEL", ...evidence,
        semanticAnalysis: "UNKNOWN", coverage: "UNKNOWN" };
      continue;
    }
    mergeMaterialReading(task, material, nativeReading(text, "OPENCLAW_NATIVE_TOOL", {
      unit: "host-analysis-result", sourceCount: references.length, extent: "UNKNOWN",
      ...(key === "pdf" ? { pages: "UNKNOWN" } : {}),
    }, { ...evidence, operation: "ANALYSIS_COMPLETED", contentKind: "HOST_ANALYSIS" }), current);
  }
}

/** Shared with the existing process-wide registry, including double plugin registration. */
export function nativeEvidenceObserver(registry, options = {}) {
  const symbol = Symbol.for("sfoa.enterprise.mcp.native-evidence.v1");
  if (registry[symbol]) return registry[symbol];
  const now = options.now ?? Date.now;
  const runs = new Map(), calls = new Map(), receipts = new Map(), changedScopes = new Map();
  const trim = (map) => {
    for (const [key, entry] of map) if (entry.expiresAt <= now()) map.delete(key);
    while (map.size > MAX_BINDINGS) map.delete(map.keys().next().value);
  };
  const active = (map, key) => { trim(map); return key ? map.get(key) : undefined; };
  const receiptKey = (scope, messageId) => JSON.stringify([scope.key, messageId]);
  const callKey = (event, ctx) => {
    if (event?.toolCallId && ctx?.toolCallId && event.toolCallId !== ctx.toolCallId) return undefined;
    const id = event?.toolCallId ?? ctx?.toolCallId, run = runKey(ctx);
    return nonempty(id) && run ? JSON.stringify([run, id]) : undefined;
  };
  async function applyTranscript(entry) {
    if (!entry.pending) return;
    await registry.change(entry.scope, (task, current) => {
      if (task.taskId !== entry.taskId) return;
      const matches = sourceMatches(task, [entry.pending.path], entry.messageId);
      if (matches.length !== 1) return;
      mergeMaterialReading(task, matches[0], entry.pending.reading, current, entry.messageId);
      delete entry.pending;
    });
  }
  const observer = {
    async bindPrompt(ctx) {
      const scope = materialScope(ctx), key = runKey(ctx);
      if (!scope || !key) return;
      const task = await registry.read(scope);
      const previous = active(runs, key);
      runs.set(key, { scope, taskId: task.taskId, sessionKey: scope.sessionKey,
        // Conflicting senders cannot repair a contaminated same-run binding.
        conflicted: previous?.conflicted || Boolean(previous && previous.scope.key !== scope.key),
        changed: false, expiresAt: task.expiresAt });
      trim(runs);
    },
    async beforeTool(event, ctx) {
      const scope = registry.takeToolScope(event, ctx), key = callKey(event, ctx);
      if (!scope || !key) return;
      const task = await registry.read(scope);
      calls.set(key, { scope, taskId: task.taskId, toolName: event.toolName,
        sessionKey: scope.sessionKey, expiresAt: task.expiresAt });
      trim(calls);
    },
    async takeBinding(event, ctx) {
      const scope = registry.takeToolScope(event, ctx);
      if (!scope || event?.runId && ctx?.runId && event.runId !== ctx.runId) return;
      if (event?.toolCallId && ctx?.toolCallId && event.toolCallId !== ctx.toolCallId) return;
      const key = callKey(event, ctx), call = active(calls, key);
      if (key) calls.delete(key);
      if (call) return call.scope.key === scope.key && call.toolName === event.toolName ? call : undefined;
      const run = active(runs, runKey(ctx));
      if (run) return !run.changed && !run.conflicted && run.scope.key === scope.key ? run : undefined;
      // Legacy direct tool contexts remain usable when the host supplies identity
      // and no run binding exists. Never infer the sender from params/session text.
      if (!runKey(ctx) && materialScope(ctx, "tool") && !active(changedScopes, scope.key)) {
        const task = await registry.read(scope);
        return { scope, taskId: task.taskId };
      }
    },
    taskChanged(scope, taskId) {
      changedScopes.set(scope.key, { sessionKey: scope.sessionKey, expiresAt: now() + MATERIAL_TASK_TTL_MS });
      trim(changedScopes);
      for (const run of runs.values()) if (run.scope.key === scope.key && run.taskId !== taskId) {
        run.taskId = taskId;
        // Completion alone cannot distinguish earlier no-before native MCP calls.
        run.changed = true;
      }
    },
    bindReceipt(scope, task, messageId, files) {
      if (!nonempty(messageId)) return;
      const key = receiptKey(scope, messageId);
      receipts.set(key, { scope, taskId: task.taskId, messageId,
        paths: files.map((file) => localPath(file.filePath)).filter(Boolean).slice(0, 64),
        sessionKey: scope.sessionKey, expiresAt: task.expiresAt });
      trim(receipts);
    },
    async receiptReady(scope, messageId) {
      const entry = active(receipts, receiptKey(scope, messageId));
      if (entry) await applyTranscript(entry);
    },
    async transcribed(event) {
      const context = event?.context;
      if (event?.type !== "message" || event.action !== "transcribed" || context?.channelId !== "wecom" ||
          context.mediaStagingPending || !nonempty(context.messageId) || !nonempty(context.transcript)) return;
      const requester = normalizeRequesterId(context.senderId);
      if (!requester || !nonempty(event.sessionKey)) return;
      const media = Array.isArray(context.media) ? context.media.slice(0, 64) : [];
      const audio = media.filter((fact) => fact?.kind === "audio" || fact?.contentType?.startsWith("audio/"));
      const transcribed = audio.filter((fact) => fact.transcribed === true);
      const candidates = transcribed.length ? transcribed : audio;
      // The SDK's transcript is message-level; multiple audio sources are ambiguous.
      if (candidates.length !== 1) return;
      if (candidates[0].messageId && candidates[0].messageId !== context.messageId) return;
      const sourcePath = localPath(candidates[0].path);
      if (!sourcePath) return;
      trim(receipts);
      const bindings = [...receipts.values()].filter((entry) => entry.scope.requester === requester &&
        entry.sessionKey === event.sessionKey && entry.messageId === context.messageId && entry.paths.includes(sourcePath));
      // Internal transcription lacks accountId; a unique prior inbound binding is mandatory.
      if (bindings.length !== 1) return;
      const entry = bindings[0];
      entry.pending = { path: sourcePath, reading: nativeReading(context.transcript, "OPENCLAW_TRANSCRIPT", {
        unit: "host-transcript", extent: "UNKNOWN", timecodes: "UNKNOWN", speakers: "UNKNOWN", confidence: "UNKNOWN",
      }, { hook: "message:transcribed", operation: "TRANSCRIPTION_COMPLETED", contentKind: "HOST_TRANSCRIPT" }) };
      await applyTranscript(entry);
    },
    clearRun(ctx) {
      const key = runKey(ctx);
      if (key) runs.delete(key);
      for (const [id] of calls) if (key && JSON.parse(id)[0] === key) calls.delete(id);
    },
    clearSession(sessionKey) {
      for (const map of [runs, calls, receipts, changedScopes]) for (const [key, entry] of map) if (entry.sessionKey === sessionKey) map.delete(key);
    },
  };
  registry[symbol] = observer;
  return observer;
}
