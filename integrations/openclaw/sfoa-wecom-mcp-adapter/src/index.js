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
 *     path comes from OpenClaw's own media fact and must sit below the
 *     configured staging root.
 *
 * Deployment note: `before_prompt_build` receives the turn's conversation, so
 * an installed (non-bundled) plugin only runs it when the host grants
 * `plugins.entries.sfoa-wecom-mcp-adapter.hooks.allowConversationAccess: true`.
 * Without that grant the reference never reaches the model, and the failure is
 * silent — see docs/sfoa/OPENCLAW_WECOM_SFOA_INTEGRATION.md.
 */

import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import {
  ATTACHMENT_INGRESS_PATH,
  ATTACHMENT_REF_TTL_MS,
  DEFAULT_STAGED_MEDIA_ROOT,
  DEFAULT_WORKSPACE_ROOT,
  buildIngressRequest,
  createStagedAttachmentRegistry,
  renderAttachmentContext,
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
 * @param {string} params.mediaRoot
 * @param {typeof fetch} [params.fetchImpl]
 */
function createInboundAttachmentStager(params) {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;

  return async function stageInbound(event, ctx) {
    // Only the WeCom channel can produce a WeCom requester identity, and only
    // that identity may own the staged file.
    if (ctx?.channelId !== WECOM_CHANNEL_ID) return undefined;

    const requesterId = event?.senderId;
    if (typeof requesterId !== "string" || requesterId.trim().length === 0) return undefined;

    const sessionKey = resolveSessionKey(ctx, event);
    if (sessionKey === undefined) return undefined;

    const { files, withheld } = selectInboundMedia(event, {
      workspaceRoot: params.workspaceRoot,
      mediaRoot: params.mediaRoot,
    });
    if (withheld !== undefined) {
      params.api.logger.debug?.(
        `[${params.serverName}] attachment bridge withheld media (${withheld})`,
      );
    }
    if (files.length === 0) {
      // A message with no usable file clears any earlier batch, so a reference
      // can never outlive the message it came from.
      params.registry.remember(sessionKey, []);
      return undefined;
    }

    if (typeof params.ingressUrl !== "string") {
      params.api.logger.warn(
        `[${params.serverName}] attachment bridge is enabled but the ingress URL could not be derived ` +
          "from the MCP endpoint; the files sent with this message were not staged.",
      );
      params.registry.remember(sessionKey, []);
      return undefined;
    }

    const token = await params.resolveToken();
    /** @type {object[]} */
    const staged = [];
    for (const file of files) {
      const stagedFile = await stageOne({
        api: params.api,
        fetchImpl,
        ingressUrl: params.ingressUrl,
        token,
        requesterId,
        runId: resolveRunId(ctx, event),
        file,
        serverName: params.serverName,
      });
      if (stagedFile !== undefined) staged.push(stagedFile);
    }

    params.registry.remember(sessionKey, staged);
    if (staged.length > 0) {
      // Counts only: a file name or a reference in a default-verbosity log
      // would put a user's document title in the gateway log.
      params.api.logger.debug?.(
        `[${params.serverName}] staged ${staged.length} of ${files.length} inbound attachment(s)`,
      );
    }
    return undefined;
  };
}

/**
 * Streams one file into the ingress and returns the metadata it echoed back.
 *
 * The body is the read stream itself: it is never buffered, decoded, or
 * inspected, so memory use does not scale with file size.
 *
 * @returns {Promise<{ attachmentRef: string, fileName?: string, mimeType?: string, byteSize?: number } | undefined>}
 */
async function stageOne(params) {
  const opened = await openStagedFile(params.file.filePath);
  if (opened === null) return undefined;

  const request = buildIngressRequest({
    url: params.ingressUrl,
    token: params.token,
    requesterId: params.requesterId,
    runId: params.runId,
    file: params.file,
    byteSize: opened.byteSize,
  });
  if (request === null) {
    opened.stream.destroy();
    return undefined;
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
      // The ingress answers with a small JSON error object. Only the stable
      // error code is logged; the message can carry a file name.
      const errorCode = await readIngressErrorCode(response);
      params.api.logger.warn(
        `[${params.serverName}] SFOA Attachment Ingress refused a file (status=${response.status}` +
          (errorCode === undefined ? "" : ` code=${errorCode}`) +
          "); it was not staged and the model will not receive a reference for it.",
      );
      return undefined;
    }

    const body = await response.json();
    if (!body || typeof body.attachmentRef !== "string" || body.attachmentRef.length === 0) return undefined;
    return {
      attachmentRef: body.attachmentRef,
      fileName: typeof body.fileName === "string" ? body.fileName : params.file.fileName,
      ...(typeof body.mimeType === "string" ? { mimeType: body.mimeType } : {}),
      ...(Number.isInteger(body.byteSize) ? { byteSize: body.byteSize } : {}),
    };
  } catch (error) {
    // A timeout, a refused connection, or a runtime that is not ready. The file
    // stays stagged locally and nothing is remembered, so the model simply has
    // no reference to offer — which is the safe outcome.
    params.api.logger.warn(
      `[${params.serverName}] SFOA Attachment Ingress call failed: ${describeError(error)}`,
    );
    return undefined;
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
 * @param {object} params
 * @param {ReturnType<typeof createStagedAttachmentRegistry>} params.registry
 * @param {string} params.serverName
 */
function createAttachmentContextInjector(params) {
  return function injectAttachmentContext(event, context) {
    const sessionKey = resolveSessionKey(context, { sessionKey: event?.sessionKey });
    if (sessionKey === undefined) return undefined;

    const text = renderAttachmentContext(params.registry.read(sessionKey));
    if (text.length === 0) return undefined;
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
      const registry = createStagedAttachmentRegistry({
        ttlMs: readConfigNumber(api, "attachmentRefTtlMs", ATTACHMENT_REF_TTL_MS),
      });
      const stageInbound = createInboundAttachmentStager({
        api,
        ingressUrl,
        resolveToken,
        registry,
        serverName,
        workspaceRoot: readConfigString(api, "attachmentWorkspaceRoot", DEFAULT_WORKSPACE_ROOT),
        mediaRoot: readConfigString(api, "attachmentMediaRoot", DEFAULT_STAGED_MEDIA_ROOT),
      });
      const injectAttachmentContext = createAttachmentContextInjector({ registry, serverName });

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
        `[${serverName}] attachment bridge registered (ingress=${String(ingressUrl)})`,
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
