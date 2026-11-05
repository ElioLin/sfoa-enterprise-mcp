/**
 * Requester-scoped WeCom transport plus bounded material/task context.
 * Native vision/PDF/ASR remain with OpenClaw; Office basics use a local reader.
 * Opaque original refs still come only from the SFoA ingress. Local notes never
 * authorize or gate Salesforce operations. No Core/WeCom plugin patch is used.
 * before_prompt_build requires hooks.allowConversationAccess on the host.
 */
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import {
  ATTACHMENT_INGRESS_PATH,
  DEFAULT_WORKSPACE_ROOT,
  buildIngressRequest,
  normalizeStagedMediaRoots,
  resolveIngressUrl,
  resolveStagedMediaPath,
  selectInboundMedia,
} from "./attachments.js";
import { readMaterial } from "./material-reader.js";
import { nativeEvidenceObserver, inboundNativeReading, observeNativeToolResult } from "./native-reading.js";
import { MATERIAL_TASK_TTL_MS, MAX_TASK_MATERIALS, createMaterialTaskRegistry, materialScope, addMaterials, renderMaterialTask, observeToolResult, taskNoteTool } from "./material-tasks.js";
import { WECOM_CHANNEL_ID, buildRequesterConnection, SFOA_MCP_SERVER_NAME } from "./resolver.js";

/** Loopback MCP endpoint; OpenClaw and the SFOA runtime share this host. */
const DEFAULT_MCP_URL = "http://127.0.0.1:8080/mcp";

/** Plugin config path used in secret-resolution diagnostics. */
const TOKEN_CONFIG_PATH = "plugins.entries.sfoa-wecom-mcp-adapter.config.mcpWecomClientToken";

/**
 * How long a resolved channel credential is reused before the SecretRef is
 * re-read. This caches the *shared client credential* only — never a user
 * identity, which is derived fresh from each run's trusted context.
 */
const TOKEN_CACHE_TTL_MS = 60_000;

/** Upper bound on one ingress call, so a stalled runtime cannot hold a turn. */
const INGRESS_TIMEOUT_MS = 120_000;

/**
 * @param {object} api OpenClaw plugin API.
 * @param {{ serverName: string, mcpUrl: string }} settings
 */
function createTokenResolver(api, settings) {
  /** @type {{ value: string, expiresAt: number } | undefined} */
  let cached;

  return async function resolveToken() {
    const now = Date.now();
    if (cached !== undefined && cached.expiresAt > now) return cached.value;

    const resolved = await resolveConfiguredSecretInputString({
      config: api.config,
      env: process.env,
      value: api.pluginConfig?.mcpWecomClientToken,
      path: TOKEN_CONFIG_PATH,
    });

    if (resolved?.value === undefined) {
      // Unresolved or unconfigured: drop any cached value and withhold the server.
      cached = undefined;
      api.logger.warn(
        `[${settings.serverName}] SFOA WeCom credential is unavailable` +
          (resolved?.unresolvedRefReason ? ` (${resolved.unresolvedRefReason})` : "") +
          "; SFOA MCP is withheld for every requester.",
      );
      return undefined;
    }

    cached = { value: resolved.value, expiresAt: now + TOKEN_CACHE_TTL_MS };
    return resolved.value;
  };
}

/**
 * Reads one plugin config value, falling back when it is absent or blank.
 *
 * @param {object} api
 * @param {string} key
 * @param {string} fallback
 */
function readConfigString(api, key, fallback) {
  const value = api.pluginConfig?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * Absence uses the documented defaults. An explicit empty/malformed list stays
 * empty so configuration cannot accidentally widen the trusted staging roots.
 *
 * @param {object} api
 * @param {string} key
 * @returns {string[] | undefined}
 */
function readConfigStringArray(api, key) {
  const value = api.pluginConfig?.[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  const entries = value
    .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
  return entries;
}

/**
 * Opens a staged file for streaming, or `null` when it is not a readable
 * regular file.
 *
 * `O_NOFOLLOW` refuses a staged path that is itself a symbolic link, and the
 * size check confirms the descriptor is a regular file rather than a device or
 * a FIFO. Together with the containment check in `attachments.js` this means a
 * path that reaches the ingress is one OpenClaw staged and nothing else.
 *
 * The size is returned so the ingress can enforce its own ceiling from
 * `Content-Length` instead of this adapter inventing a second, narrower one.
 *
 * @param {string} filePath
 * @returns {Promise<{ stream: import("node:stream").Readable, byteSize: number } | null>}
 */
async function openStagedFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size === 0) {
      await handle.close();
      return null;
    }
    // `autoClose` hands the descriptor's lifetime to the stream, so the caller
    // only ever has to destroy the stream.
    return { stream: handle.createReadStream({ autoClose: true }), byteSize: stats.size };
  } catch {
    await handle.close().catch(() => undefined);
    return null;
  }
}

/**
 * Builds the `message_received` half of the bridge: stage what can be staged,
 * remember what came back.
 *
 * Fail-closed everywhere. A run that is not the WeCom channel, that has no
 * trusted requester id, or that has no conversation to deliver to is left
 * completely alone — no ingress call is made, so nothing is written to the
 * SFOA staging area on behalf of a run that could never use it.
 *
 * @param {object} params
 * @param {object} params.api
 * @param {string | undefined} params.ingressUrl
 * @param {() => Promise<string | undefined>} params.resolveToken
 * @param {ReturnType<typeof createMaterialTaskRegistry>} params.registry
 * @param {string} params.serverName
 * @param {string} params.workspaceRoot
 * @param {readonly string[]} params.mediaRoots
 * @param {typeof fetch} [params.fetchImpl]
 */
function createInboundAttachmentStager(params) {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  return async function stageInbound(event, ctx) {
    const scope = materialScope({ ...ctx, senderId: event?.senderId,
      sessionKey: resolveSessionKey(ctx, event) }, "message");
    if (!scope) return;
    const messageId = event.messageId ?? ctx.messageId ?? event.runId ?? ctx.runId ?? randomUUID();
    // Ordinary text is a continuation, never a command to discard pending files.
    const selection = selectInboundMedia(event, { workspaceRoot: params.workspaceRoot,
      mediaRoots: params.mediaRoots, maxFiles: MAX_TASK_MATERIALS });
    if (!selection.receivedCount && !selection.withheld) {
      await params.registry.change(scope, (task) => { task.lastMessageId = messageId; });
      return;
    }
    const before = await params.registry.read(scope);
    if (messageId && before.materials.some((entry) => entry.sourceMessages.includes(messageId))) return;
    params.nativeEvidence.bindReceipt(scope, before, messageId, selection.files);
    const materials = [];
    const token = typeof params.ingressUrl === "string" ? await params.resolveToken() : undefined;
    for (const file of selection.files) {
      // Reject symlinks in any path component before either stream or reader use.
      let local = false;
      try { local = path.resolve(await realpath(file.filePath)) === path.resolve(file.filePath); } catch { /* missing file */ }
      let reading = local ? await readMaterial(file, { python: params.officePython })
        : { status: "FAILED", reason: "STAGED_FILE_UNREADABLE", coverage: "UNKNOWN" };
      if (local && reading.status === "UNKNOWN") reading = inboundNativeReading(event, file.filePath,
        (source) => resolveStagedMediaPath(source, { workspaceRoot: params.workspaceRoot, mediaRoots: params.mediaRoots })) ?? reading;
      const result = !local ? { failure: "STAGED_FILE_UNREADABLE" }
        : typeof params.ingressUrl !== "string" ? { failure: "INGRESS_URL_UNAVAILABLE" }
        : await stageOne({ api: params.api, fetchImpl, ingressUrl: params.ingressUrl, token,
          requesterId: scope.requester, runId: resolveRunId(ctx, event), file, serverName: params.serverName });
      if (reading.contentSha256 && result.staged?.contentSha256 && reading.contentSha256 !== result.staged.contentSha256) {
        reading.status = "FAILED";
        reading.reason = "MATERIAL_CHANGED_DURING_READ";
        delete reading.text;
      }
      materials.push({ fileName: file.fileName, ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        ...(local ? { sourcePaths: [{ path: file.filePath, messageId }] } : {}),
        ownerRequester: scope.requester,
        ...result.staged, staging: result.staged ? "STAGED" : "FAILED",
        ...(result.failure ? { stagingFailure: result.failure } : {}),
        ...(result.staged?.contentSha256 || reading.contentSha256 ? { contentSha256: result.staged?.contentSha256 ?? reading.contentSha256 } : {}), reading });
    }
    await params.registry.change(scope, (task, current) => {
      // A delayed ingress result belongs to the task that received the message.
      if (task.taskId !== before.taskId) return;
      addMaterials(task, materials, current, messageId);
      task.lastMessageId = messageId;
      task.lastBatch = { received: selection.receivedCount ?? 0, staged: materials.filter((entry) => entry.attachmentRef).length,
        processed: materials.length, notProcessed: selection.rejected ?? [] };
      if (selection.withheld) task.lastBatch.failure = selection.withheld;
    });
    await params.nativeEvidence.receiptReady(scope, messageId);
    params.api.logger.info(
      "[" + params.serverName + "] staged " + materials.filter((entry) => entry.attachmentRef).length +
      " of " + (selection.receivedCount ?? 0) + " inbound attachment(s); material coverage retained",
    );
    if (selection.withheld || materials.some((entry) => entry.stagingFailure)) params.api.logger.warn(
      "[" + params.serverName + "] attachment bridge partial/failed (code=" +
      (selection.withheld ?? materials.find((entry) => entry.stagingFailure)?.stagingFailure) + ")",
    );
  };
}

/**
 * Streams one file into the ingress and returns either the metadata it echoed
 * back or the stable code that explains why it did not.
 *
 * The body is the read stream itself: it is never buffered, decoded, or
 * inspected, so memory use does not scale with file size.
 *
 * @returns {Promise<{ staged: { attachmentRef: string, fileName?: string, mimeType?: string, byteSize?: number } } | { failure: string }>}
 */
async function stageOne(params) {
  const opened = await openStagedFile(params.file.filePath);
  if (opened === null) {
    // The fact pointed below a staging root but the file was not readable as a
    // regular, non-empty file: it was removed between the fact and this call, or
    // it is a device, a FIFO, or a symlink. The path itself is infrastructure.
    params.api.logger.warn(
      `[${params.serverName}] attachment bridge could not open a staged file ` +
        `(code=STAGED_FILE_UNREADABLE, source=${path.dirname(params.file.filePath)}); it was not staged.`,
    );
    return { failure: "STAGED_FILE_UNREADABLE" };
  }

  const request = buildIngressRequest({
    url: params.ingressUrl,
    token: params.token,
    requesterId: params.requesterId,
    runId: params.runId,
    file: params.file,
    byteSize: opened.byteSize,
  });
  if (request === null) {
    // Preconditions only: none of the values is logged, because the token is a
    // credential and the rest are already covered by the caller's own warnings.
    opened.stream.destroy();
    params.api.logger.warn(
      `[${params.serverName}] attachment bridge withheld a staged file before the ingress call ` +
        `(code=INGRESS_REQUEST_INCOMPLETE, url=${typeof params.ingressUrl === "string"}, ` +
        `token=${typeof params.token === "string" && params.token.length > 0}, ` +
        `requester=${typeof params.requesterId === "string" && params.requesterId.trim().length > 0}).`,
    );
    return { failure: "INGRESS_REQUEST_INCOMPLETE" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INGRESS_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await params.fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: Readable.toWeb(opened.stream),
      duplex: "half",
      signal: controller.signal,
    });

    if (!response.ok) {
      // The ingress answers with a small JSON error object. Its own stable code
      // is preferred over a local one, because it is what the operator and the
      // user can act on; only the code is kept, never the message, which can
      // carry a file name.
      const errorCode = await readIngressErrorCode(response);
      const code = errorCode ?? `INGRESS_HTTP_${response.status}`;
      params.api.logger.warn(
        `[${params.serverName}] SFOA Attachment Ingress refused a file (status=${response.status}` +
          (errorCode === undefined ? "" : ` code=${errorCode}`) +
          "); it was not staged and the model will not receive a reference for it.",
      );
      return { failure: code };
    }

    const body = await response.json();
    if (!body || typeof body.attachmentRef !== "string" || body.attachmentRef.length === 0) {
      // A 2xx whose body carries no reference would otherwise be the quietest
      // failure in the bridge: the bytes reached the runtime and nothing came
      // back that the model could use.
      params.api.logger.warn(
        `[${params.serverName}] SFOA Attachment Ingress accepted a file but returned no attachment reference ` +
          "(code=INGRESS_REF_MISSING); it was not staged and the model will not receive a reference for it.",
      );
      return { failure: "INGRESS_REF_MISSING" };
    }
    return {
      staged: {
        attachmentRef: body.attachmentRef,
        fileName: typeof body.fileName === "string" ? body.fileName : params.file.fileName,
        ...(typeof body.mimeType === "string" ? { mimeType: body.mimeType } : {}),
        ...(Number.isInteger(body.byteSize) ? { byteSize: body.byteSize } : {}),
        ...(typeof body.expiresAt === "string" ? { expiresAt: body.expiresAt } : {}),
        ...(typeof body.contentSha256 === "string" && /^[a-f0-9]{64}$/iu.test(body.contentSha256) ? { contentSha256: body.contentSha256.toLowerCase() } : {}),
      },
    };
  } catch (error) {
    // A timeout, a refused connection, or a runtime that is not ready. The file
    // stays staged locally and nothing is remembered, so the model simply has
    // no reference to offer — which is the safe outcome.
    params.api.logger.warn(
      `[${params.serverName}] SFOA Attachment Ingress call failed: ${describeError(error)}`,
    );
    return { failure: "INGRESS_UNREACHABLE" };
  } finally {
    clearTimeout(timeout);
    opened.stream.destroy();
  }
}

/**
 * @param {Response} response
 * @returns {Promise<string | undefined>}
 */
async function readIngressErrorCode(response) {
  try {
    const body = await response.json();
    return typeof body?.errorCode === "string" ? body.errorCode.slice(0, 64) : undefined;
  } catch {
    return undefined;
  }
}

/** @param {unknown} error */
function describeError(error) {
  if (error instanceof Error) return error.name === "AbortError" ? "timed out" : error.name;
  return "unknown error";
}

/**
 * Builds the `before_prompt_build` half of the bridge: hand the staged
 * references to the model for the turn that received them.
 *
 * Returning `appendContext` puts the references in the turn's prompt. Nothing
 * is consumed here — the runtime consumes a reference exactly once, so a
 * re-offered reference is refused by the runtime rather than uploaded twice.
 *
 * When the message carried a file that the bridge could not stage, the model
 * gets the reason instead of silence. Without it the only honest answer left is
 * "no reference arrived", which is indistinguishable from a message that never
 * had a file — and that ambiguity is what made the original failure take a
 * source-level investigation to locate.
 *
 * @param {object} params
 * @param {ReturnType<typeof createMaterialTaskRegistry>} params.registry
 * @param {string} params.serverName
 * @param {{ logger: { info: Function, warn: Function } }} params.api
 */
function createAttachmentContextInjector(params) {
  return async function injectAttachmentContext(event, context) {
    const scope = materialScope(context);
    if (!scope) return;
    const task = await params.registry.read(scope);
    if (!task.materials.length && !task.lastBatch && !task.objective && !task.results.length) return;
    const text = renderMaterialTask(task, Date.now(), { persistence: params.registry.persistence,
      messageId: task.lastMessageId });
    params.api.logger.info("[" + params.serverName + "] material injector: " + task.materials.length + " source(s)");
    return { appendContext: text };
  };
}

/**
 * The canonical conversation key, using the same precedence the host documents:
 * the session key identifies the conversation across turns, and the run id is
 * only a fallback for a path that has no session.
 *
 * @param {{ sessionKey?: unknown, runId?: unknown } | undefined} context
 * @param {{ sessionKey?: unknown, runId?: unknown } | undefined} event
 * @returns {string | undefined}
 */
function resolveSessionKey(context, event) {
  for (const candidate of [context?.sessionKey, event?.sessionKey, context?.runId, event?.runId]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return undefined;
}

/**
 * Renders a conversation key for the log without putting the requester's
 * channel identifier in it. Digits are masked, so the shape survives — which is
 * what makes a mismatch between the two hooks visible — while the identifier
 * itself does not.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describeSessionKey(value) {
  if (typeof value !== "string" || value.trim().length === 0) return "(none)";
  return value.trim().replace(/\d+/gu, "#");
}

/**
 * The staged-reference registry, shared by every registration of this plugin in
 * the process.
 *
 * The gateway calls `register()` twice on one process — once while loading
 * plugins, once while starting channels — and it does not dispatch both
 * registrations' hooks together: `message_received` is served by one and
 * `before_prompt_build` by the other. A registry built inside `register()` is
 * therefore built twice, and the staging hook writes references into one while
 * the injection hook reads an empty other. Staging reports success, the model
 * receives nothing, and no single line in the log looks wrong.
 *
 * Keyed by a process-global symbol for the same reason the host uses one for its
 * own hook-runner state: it survives the plugin module being evaluated twice, so
 * there is exactly one registry however the host chooses to load it.
 *
 * @param {() => ReturnType<typeof createMaterialTaskRegistry>} create
 * @returns {{ registry: ReturnType<typeof createMaterialTaskRegistry>, shared: boolean }}
 */
function resolveSharedAttachmentRegistry(create) {
  const key = Symbol.for("sfoa.enterprise.mcp.material-task-registry.v1");
  const scope = /** @type {Record<symbol, unknown>} */ (globalThis);
  const existing = scope[key];
  if (existing !== undefined) {
    return {
      registry: /** @type {ReturnType<typeof createMaterialTaskRegistry>} */ (existing),
      shared: true,
    };
  }
  const created = create();
  scope[key] = created;
  return { registry: created, shared: false };
}

/**
 * @param {{ runId?: unknown } | undefined} context
 * @param {{ runId?: unknown } | undefined} event
 * @returns {string | undefined}
 */
function resolveRunId(context, event) {
  for (const candidate of [context?.runId, event?.runId]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return undefined;
}

/** @type {import("openclaw/plugin-sdk/core").OpenClawPluginDefinition} */
const plugin = {
  id: "sfoa-wecom-mcp-adapter",
  name: "SFoA WeCom MCP Adapter",
  description:
    "Binds SFOA MCP to the trusted WeCom requester and retains bounded material/task context with original refs and basic Office reading.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      serverName: { type: "string" },
      mcpUrl: { type: "string" },
      mcpWecomClientToken: {},
      attachmentBridgeEnabled: { type: "boolean" },
      attachmentIngressPath: { type: "string" },
      attachmentWorkspaceRoot: { type: "string" },
      attachmentMediaRoot: { type: "string" },
      attachmentMediaRoots: { type: "array", items: { type: "string" } },
      attachmentRefTtlMs: { type: "number" },
      officePython: { type: "string" },
    },
  },

  register(api) {
    const serverName =
      typeof api.pluginConfig?.serverName === "string" && api.pluginConfig.serverName.trim().length > 0
        ? api.pluginConfig.serverName.trim()
        : SFOA_MCP_SERVER_NAME;
    const mcpUrl =
      typeof api.pluginConfig?.mcpUrl === "string" && api.pluginConfig.mcpUrl.trim().length > 0
        ? api.pluginConfig.mcpUrl.trim()
        : DEFAULT_MCP_URL;

    if (serverName !== SFOA_MCP_SERVER_NAME) {
      // The resolver matches `mcp.servers` by exact name; a mismatch would
      // silently leave the server static and unauthenticated. Refuse instead.
      throw new Error(
        `sfoa-wecom-mcp-adapter: configured serverName "${serverName}" does not match the ` +
          `supported server "${SFOA_MCP_SERVER_NAME}"`,
      );
    }

    const resolveToken = createTokenResolver(api, { serverName, mcpUrl });

    api.registerMcpServerConnectionResolver({
      serverName,

      /**
       * Runs once per requester-scoped MCP runtime (OpenClaw re-resolves at
       * least every 5 minutes). Returning `null` withholds the server for this
       * run; there is no shared-connection fallback.
       *
       * @param {{ requesterSenderId: string, agentAccountId?: string, messageChannel?: string }} ctx
       */
      async resolve(ctx) {
        const connection = buildRequesterConnection({
          context: ctx,
          token: await resolveToken(),
          url: mcpUrl,
        });

        if (connection === null) {
          // No trusted WeCom requester (or no credential) => no SFOA MCP.
          // Debug level so identity values never reach default-verbosity logs.
          api.logger.debug?.(
            `[${serverName}] withheld: channel=${String(ctx?.messageChannel)} ` +
              `requesterSenderId=${String(ctx?.requesterSenderId)}`,
          );
          return null;
        }

        api.logger.debug?.(
          `[${serverName}] bound channel=${WECOM_CHANNEL_ID} ` +
            `requesterSenderId=${String(ctx?.requesterSenderId)}`,
        );
        return connection;
      },
    });

    // The bridge is opt-in, exactly like `MCP_ATTACHMENT_INGRESS_ENABLED` on the
    // runtime side: a deployment turns both on together, and until then a WeCom
    // file is never copied anywhere.
    if (api.pluginConfig?.attachmentBridgeEnabled === true) {
      const ingressUrl = resolveIngressUrl(
        mcpUrl,
        readConfigString(api, "attachmentIngressPath", ATTACHMENT_INGRESS_PATH),
      );
      const { registry, shared: registryShared } = resolveSharedAttachmentRegistry(() => {
        let store;
        try {
          // The API may exist while the host denies persistent state to local-path
          // plugins. Optional task persistence must not roll back identity binding.
          store = api.runtime?.state?.openKeyedStore?.({ namespace: "material-tasks-v1",
            maxEntries: 128, overflowPolicy: "evict-oldest", defaultTtlMs: MATERIAL_TASK_TTL_MS });
        } catch {
          api.logger.warn(`[${serverName}] persistent material task store unavailable ` +
            "(code=MATERIAL_TASK_STORE_UNAVAILABLE); using bounded process memory, revalidate after restart.");
        }
        return createMaterialTaskRegistry({ store });
      });
      const nativeEvidence = nativeEvidenceObserver(registry);
      // Two roots, because two layers stage the same file: OpenClaw's sandbox
      // copies it under the workspace (`staged-inputs-*`) while the WeCom
      // channel plugin writes its own copy under the state directory and is
      // what the hook context actually reports. Accepting only one root silently
      // refused every WeCom file. `attachmentMediaRoots` (plural) replaces the
      // defaults outright; the singular `attachmentMediaRoot` still narrows to
      // one root and now also replaces them.
      const mediaRoots = normalizeStagedMediaRoots({
        mediaRoot: readConfigString(api, "attachmentMediaRoot", undefined),
        mediaRoots: readConfigStringArray(api, "attachmentMediaRoots"),
      });
      if (mediaRoots.length === 0) {
        // Fail closed and loudly: with no acceptable root the bridge can never
        // stage anything, so every file message would look like an empty one.
        api.logger.warn(
          `[${serverName}] attachment bridge has no usable staging root ` +
            "(code=MEDIA_ROOTS_EMPTY); every inbound file will be refused. " +
            "Check plugins.entries.sfoa-wecom-mcp-adapter.config.attachmentMediaRoots.",
        );
      }
      const stageInbound = createInboundAttachmentStager({
        api,
        ingressUrl,
        resolveToken,
        registry,
        nativeEvidence,
        serverName,
        workspaceRoot: readConfigString(api, "attachmentWorkspaceRoot", DEFAULT_WORKSPACE_ROOT),
        mediaRoots,
        officePython: readConfigString(api, "officePython", "python3"),
      });
      const injectAttachmentContext = createAttachmentContextInjector({ api, registry, serverName });

      // A hook that throws would disturb the turn it is attached to, so both
      // handlers absorb their own failures and log them instead.
      api.on("message_received", (event, ctx) =>
        Promise.resolve(stageInbound(event, ctx)).catch((error) => {
          api.logger.warn(`[${serverName}] inbound attachment staging failed: ${describeError(error)}`);
        }));

      api.on("before_prompt_build", async (event, ctx) => {
        try {
          registry.bindRunScope(ctx);
          await nativeEvidence.bindPrompt(ctx);
          return await injectAttachmentContext(event, ctx);
        } catch (error) {
          api.logger.warn(`[${serverName}] attachment context injection failed: ${describeError(error)}`);
          return undefined;
        }
      });

      api.on("after_tool_call", async (event, ctx) => {
        try {
          const binding = await nativeEvidence.takeBinding(event, ctx);
          if (!binding) return;
          await registry.change(binding.scope, (task, current) => {
            if (task.taskId !== binding.taskId) return;
            observeToolResult(task, event);
            observeNativeToolResult(task, event, current);
          });
        }
        catch { api.logger.warn("[" + serverName + "] task result observation unavailable; use actual tool response"); }
      });
      api.on("before_tool_call", async (event, ctx) => {
        try { await nativeEvidence.beforeTool(event, ctx); }
        catch { api.logger.warn("[" + serverName + "] task call binding unavailable; use actual tool response"); }
      });
      // This existing SDK hook supplies actual ASR output, unlike model prose or
      // message_received metadata. Denial leaves the reader UNKNOWN/PARTIAL.
      try {
        // The legacy hook registrar does not apply the typed conversation-access
        // policy itself. Honor that same explicit opt-in before observing text.
        const conversationAccess = api.config?.plugins?.entries?.[plugin.id]?.hooks?.allowConversationAccess === true;
        if (conversationAccess && api.config?.hooks?.internal?.enabled !== false && typeof api.registerHook === "function") api.registerHook("message:transcribed", async (event) => {
          try { await nativeEvidence.transcribed(event); }
          catch { api.logger.warn("[" + serverName + "] native transcript observation unavailable"); }
        }, { name: "sfoa-material-transcript", description: "Observe source-bound native material transcription" });
      } catch {
        api.logger.warn("[" + serverName + "] native transcript hook unavailable (code=NATIVE_TRANSCRIPT_HOOK_UNAVAILABLE)");
      }
      api.on("agent_end", (_event, ctx) => { registry.clearRunScope(ctx); nativeEvidence.clearRun(ctx); });
      api.on("session_end", async (event, ctx) => {
        if (!["new", "reset", "deleted"].includes(event.reason)) return;
        try {
          const sessionKey = ctx.sessionKey ?? event.sessionKey;
          nativeEvidence.clearSession(sessionKey);
          await registry.clearSession(sessionKey);
        }
        catch { api.logger.warn("[" + serverName + "] task session cleanup unavailable"); }
      });
      api.registerTool?.((ctx) => {
        const scope = materialScope(ctx);
        if (!scope) return null;
        const tool = taskNoteTool(registry, scope);
        return { ...tool, async execute(id, note) {
          const result = await tool.execute(id, note);
          if (!result.isError && note.operation === "new_task" && result.details?.taskId)
            nativeEvidence.taskChanged(scope, result.details.taskId);
          return result;
        } };
      }, { name: "sfoa_material_task" });

      api.logger.info(
        `[${serverName}] attachment bridge registered ` +
          `(ingress=${String(ingressUrl)}, registry=${registryShared ? "shared" : "new"})`,
      );
    } else {
      api.logger.info(
        `[${serverName}] attachment bridge disabled; inbound WeCom files are not staged ` +
          "(set plugins.entries.sfoa-wecom-mcp-adapter.config.attachmentBridgeEnabled=true to enable)",
      );
    }

    api.logger.info(
      `[${serverName}] requester-scoped MCP connection resolver registered (url=${mcpUrl})`,
    );
  },
};

export default plugin;
