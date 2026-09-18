/**
 * SFoA WeCom MCP adapter — an OpenClaw plugin with two jobs, both about the
 * same thing: making the trusted WeCom requester of the current message the
 * subject of every SFOA call.
 *
 *   1. Bind the statically declared `sfoa-enterprise-mcp` MCP server to that
 *      requester's transport (URL + headers), resolved per run.
 *   2. Bridge the files that message carried: stage each locally usable
 *      attachment into the SFOA Attachment Ingress, and hand the opaque
 *      `att_…` references it returns to the model on the next prompt build, so
 *      a file can be attached to a Salesforce record without the model ever
 *      reading a byte of it.
 *
 * It still does not implement a channel, a tool, an identity provider, or a
 * Salesforce client. Server name, tool surface, and tool governance stay
 * static and continue to come from `mcp.servers` and the SFOA runtime; only the
 * transport (URL + headers) is resolved per requester.
 *
 * Design rules enforced here:
 *   - No OpenClaw core, WeCom plugin, or node_modules modification.
 *   - No static `X-WeCom-User-Id` in configuration; it exists only in the
 *     per-requester connection and the per-file ingress request built below.
 *   - No process-wide "current user". The credential is the only cached value.
 *   - No file byte, base64 blob, or filesystem path from the model: the staged
 *     path comes from OpenClaw's own media fact and must sit below one of the
 *     configured staging roots.
 *
 * Deployment note: `before_prompt_build` receives the turn's conversation, so
 * an installed (non-bundled) plugin only runs it when the host grants
 * `plugins.entries.sfoa-wecom-mcp-adapter.hooks.allowConversationAccess: true`.
 * Without that grant the reference never reaches the model, and the failure is
 * silent — see docs/sfoa/OPENCLAW_WECOM_SFOA_INTEGRATION.md.
 */

import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import {
  ATTACHMENT_INGRESS_PATH,
  ATTACHMENT_REF_TTL_MS,
  DEFAULT_WORKSPACE_ROOT,
  buildIngressRequest,
  createStagedAttachmentRegistry,
  normalizeStagedMediaRoots,
  renderAttachmentContext,
  renderAttachmentFailureContext,
  resolveIngressUrl,
  selectInboundMedia,
} from "./attachments.js";
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
 * Reads one plugin config value as a list of non-blank strings, or `undefined`
 * when it is absent, not an array, or holds nothing usable.
 *
 * An empty list is deliberately reported as `undefined` rather than `[]`: the
 * caller treats "not configured" and "configured with no usable entries"
 * differently from "configured to accept nothing".
 *
 * @param {object} api
 * @param {string} key
 * @returns {string[] | undefined}
 */
function readConfigStringArray(api, key) {
  const value = api.pluginConfig?.[key];
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
  return entries.length > 0 ? entries : undefined;
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
 * @param {ReturnType<typeof createStagedAttachmentRegistry>} params.registry
 * @param {string} params.serverName
 * @param {string} params.workspaceRoot
 * @param {readonly string[]} params.mediaRoots
 * @param {typeof fetch} [params.fetchImpl]
 */
function createInboundAttachmentStager(params) {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;

  return async function stageInbound(event, ctx) {
    // Only the WeCom channel can produce a WeCom requester identity, and only
    // that identity may own the staged file.
    //
    // Every bail-out below is logged. The bridge fails closed, so a quiet
    // refusal and a message that never carried a file look identical from the
    // outside — which is precisely the state that made "the platform sent no
    // reference" impossible to diagnose from a gateway log at default
    // verbosity. Nothing here names a file or a reference; the identity is the
    // one the host already logs at this level elsewhere.
    if (ctx?.channelId !== WECOM_CHANNEL_ID) {
      params.api.logger.debug?.(
        `[${params.serverName}] attachment bridge skipped: channel=${String(ctx?.channelId)} is not ${WECOM_CHANNEL_ID}`,
      );
      return undefined;
    }

    const requesterId = event?.senderId;
    if (typeof requesterId !== "string" || requesterId.trim().length === 0) {
      params.api.logger.debug?.(
        `[${params.serverName}] attachment bridge skipped: the event carries no senderId, so no file could be attributed`,
      );
      return undefined;
    }

    const sessionKey = resolveSessionKey(ctx, event);
    if (sessionKey === undefined) {
      params.api.logger.debug?.(
        `[${params.serverName}] attachment bridge skipped: the event carries no session key, so there is no prompt to deliver a reference to`,
      );
      return undefined;
    }

    const { files, withheld, withheldDirectory } = selectInboundMedia(event, {
      workspaceRoot: params.workspaceRoot,
      mediaRoots: params.mediaRoots,
    });
    if (withheld !== undefined) {
      // A file arrived and was refused. At default verbosity this is the line
      // that separates "the user sent nothing" from "the bridge dropped it".
      // The directory is host infrastructure; the file name never appears.
      params.api.logger.warn(
        `[${params.serverName}] attachment bridge refused the media sent with this message ` +
          `(code=${withheld}${withheldDirectory === undefined ? "" : `, source=${withheldDirectory}`}); ` +
          "it was not staged and the model will not receive a reference for it.",
      );
      if (files.length === 0) {
        params.registry.rememberFailure(sessionKey, withheld);
        return undefined;
      }
    }
    if (files.length === 0) {
      // A message with no usable file clears any earlier batch, so a reference
      // can never outlive the message it came from. Clearing is the one decision
      // this bridge makes that destroys a reference another message produced, so
      // it is the one silent exit that must not stay silent: if the host emits a
      // second `message_received` for the same conversation in the same turn —
      // a file message followed by its own envelope — this line is the only
      // trace that the reference was taken away before the prompt was built.
      const cleared = params.registry.read(sessionKey).length;
      params.registry.remember(sessionKey, []);
      if (cleared > 0) {
        params.api.logger.warn(
          `[${params.serverName}] attachment bridge cleared ${cleared} staged reference(s) for ` +
            `session=${describeSessionKey(sessionKey)}: this message carried no usable file.`,
        );
      }
      return undefined;
    }

    if (typeof params.ingressUrl !== "string") {
      params.api.logger.warn(
        `[${params.serverName}] attachment bridge is enabled but the ingress URL could not be derived ` +
          "from the MCP endpoint; the files sent with this message were not staged.",
      );
      params.registry.rememberFailure(sessionKey, "INGRESS_URL_UNAVAILABLE");
      return undefined;
    }

    const token = await params.resolveToken();
    /** @type {object[]} */
    const staged = [];
    /** @type {string | undefined} */
    let failureCode;
    for (const file of files) {
      const result = await stageOne({
        api: params.api,
        fetchImpl,
        ingressUrl: params.ingressUrl,
        token,
        requesterId,
        runId: resolveRunId(ctx, event),
        file,
        serverName: params.serverName,
      });
      if (result.staged !== undefined) staged.push(result.staged);
      else failureCode = failureCode ?? result.failure;
    }

    params.registry.remember(sessionKey, staged);
    if (staged.length === 0) {
      // Every file was refused after the bridge had accepted it. The specific
      // code travels with it: the ingress' own error code is far more useful to
      // quote back than a generic staging failure.
      const code = failureCode ?? "STAGING_FAILED";
      params.api.logger.warn(
        `[${params.serverName}] attachment bridge staged 0 of ${files.length} inbound attachment(s) ` +
          `(code=${code}); the model will not receive a reference for them.`,
      );
      params.registry.rememberFailure(sessionKey, code);
      return undefined;
    }
    if (staged.length < files.length) {
      // Some files are usable, so the model gets those references and this
      // conversation's failure record stays cleared rather than competing with
      // them. The refused file is named by code here, for the operator.
      params.api.logger.warn(
        `[${params.serverName}] attachment bridge staged only ${staged.length} of ${files.length} inbound ` +
          `attachment(s) (code=${failureCode ?? withheld ?? "STAGING_FAILED"}); the model receives references ` +
          "for the staged ones only.",
      );
    }
    // Counts only: a file name or a reference in a default-verbosity log
    // would put a user's document title in the gateway log. The conversation
    // key is masked to its shape — enough to correlate this line with the
    // injection that should carry the references into the prompt.
    params.api.logger.info(
      `[${params.serverName}] staged ${staged.length} of ${files.length} inbound attachment(s) ` +
        `for session=${describeSessionKey(sessionKey)}`,
    );
    return undefined;
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
 * @param {ReturnType<typeof createStagedAttachmentRegistry>} params.registry
 * @param {string} params.serverName
 * @param {{ logger: { info: Function, warn: Function } }} params.api
 */
function createAttachmentContextInjector(params) {
  return function injectAttachmentContext(event, context) {
    const sessionKey = resolveSessionKey(context, { sessionKey: event?.sessionKey });
    if (sessionKey === undefined) {
      params.api.logger.warn(
        `[${params.serverName}] attachment injector ran without a conversation key (result=none)`,
      );
      return undefined;
    }

    const refs = params.registry.read(sessionKey);
    const text = renderAttachmentContext(refs);
    const failure = params.registry.readFailure(sessionKey);
    if (text.length > 0) {
      // The references exist for this conversation and go into the prompt. Say
      // so: the exchange is the one place in this bridge where a reference stops
      // being an internal record and becomes something the model can act on, and
      // when it does not happen the model reports a platform that never produced
      // one. The count is enough — a reference or a file name in a
      // default-verbosity log would put a user's document title in it.
      params.api.logger.info(
        `[${params.serverName}] attachment injector: injected ${refs.length} reference(s) into the ` +
          `prompt for session=${describeSessionKey(sessionKey)}`,
      );
      return { appendContext: text };
    }

    // No reference for this turn. If the bridge refused a file, say so and say
    // why, so the model reports a platform-side reason rather than guessing.
    if (failure === undefined) return undefined;
    return { appendContext: renderAttachmentFailureContext(failure) };
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
 * @param {() => ReturnType<typeof createStagedAttachmentRegistry>} create
 * @returns {{ registry: ReturnType<typeof createStagedAttachmentRegistry>, shared: boolean }}
 */
function resolveSharedAttachmentRegistry(create) {
  const key = Symbol.for("sfoa.enterprise.mcp.staged-attachment-registry");
  const scope = /** @type {Record<symbol, unknown>} */ (globalThis);
  const existing = scope[key];
  if (existing !== undefined) {
    return {
      registry: /** @type {ReturnType<typeof createStagedAttachmentRegistry>} */ (existing),
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
    "Binds the sfoa-enterprise-mcp MCP server transport to the trusted WeCom message requester, and bridges the files that message carried into the SFOA Attachment Ingress.",
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
      const { registry, shared: registryShared } = resolveSharedAttachmentRegistry(() =>
        createStagedAttachmentRegistry({
          ttlMs: readConfigNumber(api, "attachmentRefTtlMs", ATTACHMENT_REF_TTL_MS),
        }),
      );
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
        serverName,
        workspaceRoot: readConfigString(api, "attachmentWorkspaceRoot", DEFAULT_WORKSPACE_ROOT),
        mediaRoots,
      });
      const injectAttachmentContext = createAttachmentContextInjector({ api, registry, serverName });

      // A hook that throws would disturb the turn it is attached to, so both
      // handlers absorb their own failures and log them instead.
      api.on("message_received", (event, ctx) =>
        Promise.resolve(stageInbound(event, ctx)).catch((error) => {
          api.logger.warn(`[${serverName}] inbound attachment staging failed: ${describeError(error)}`);
        }));

      api.on("before_prompt_build", (event, ctx) => {
        try {
          return injectAttachmentContext(event, ctx);
        } catch (error) {
          api.logger.warn(`[${serverName}] attachment context injection failed: ${describeError(error)}`);
          return undefined;
        }
      });

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

/**
 * @param {object} api
 * @param {string} key
 * @param {number} fallback
 */
function readConfigNumber(api, key, fallback) {
  const value = api.pluginConfig?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export default plugin;
