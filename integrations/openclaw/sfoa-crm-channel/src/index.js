/**
 * SFoA CRM channel plugin.
 *
 * Boundary:
 *   Salesforce LWC -> SFoA CRM access service -> this plugin HTTP ingress
 *   -> OpenClaw official route/session/reply pipeline -> SFOA MCP -> Salesforce.
 *
 * This plugin is not an MCP gateway and does not call Salesforce. It only turns
 * an already-authenticated service request into a trusted OpenClaw channel turn:
 * the `SenderId` is the platform user id the access service resolved from the
 * Apex-signed Salesforce identity, never a value supplied by the browser.
 *
 * The HTTP routes use `auth: "plugin"`: the plugin itself verifies a separate
 * service Bearer credential. That credential is a service credential, not a
 * human identity and not a Gateway operator token.
 */

import { randomUUID } from "node:crypto";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { sfoaCrmChannelPlugin } from "./channel.js";
import {
  CHANNEL_ID,
  CrmProtocolError,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_MAX_MESSAGE_CHARS,
  DEFAULT_TURN_TIMEOUT_MS,
  MAX_BODY_BYTES,
  constantTimeEqual,
  encodeSseEvent,
  parseAbortRequest,
  parseHistoryRequest,
  parseResolveRequest,
  parseTurnRequest,
} from "./protocol.js";
import { CrmTurnService } from "./turn-service.js";

const PLUGIN_ID = "sfoa-crm-channel";
const ROUTE_PREFIX = `/plugins/${CHANNEL_ID}`;
const TOKEN_CONFIG_PATH = `plugins.entries.${PLUGIN_ID}.config.serviceToken`;
const TOKEN_CACHE_TTL_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * @param {object} api
 * @returns {() => Promise<string | undefined>}
 */
function createServiceTokenResolver(api) {
  /** @type {{ value: string, expiresAt: number } | undefined} */
  let cached;
  return async function resolveServiceToken() {
    const now = Date.now();
    if (cached !== undefined && cached.expiresAt > now) return cached.value;
    const resolved = await resolveConfiguredSecretInputString({
      config: api.config,
      env: process.env,
      value: api.pluginConfig?.serviceToken,
      path: TOKEN_CONFIG_PATH,
    });
    if (resolved?.value === undefined) {
      cached = undefined;
      api.logger.warn(
        `[${CHANNEL_ID}] service credential is unavailable` +
          (resolved?.unresolvedRefReason ? ` (${resolved.unresolvedRefReason})` : "") +
          "; every CRM turn is withheld.",
      );
      return undefined;
    }
    cached = { value: resolved.value, expiresAt: now + TOKEN_CACHE_TTL_MS };
    return resolved.value;
  };
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<unknown>}
 */
async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new CrmProtocolError("CRM_REQUEST_TOO_LARGE", "The request body is too large.", 413);
    }
    chunks.push(chunk);
  }
  if (total === 0) throw new CrmProtocolError("CRM_REQUEST_INVALID", "The request body is empty.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CrmProtocolError("CRM_REQUEST_INVALID", "The request body is not valid JSON.");
  }
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function writeJson(res, status, body) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {CrmProtocolError} error
 * @param {string} correlationId
 */
function writeProtocolError(res, error, correlationId) {
  writeJson(res, error.status, {
    errorCode: error.code,
    message: error.message,
    correlationId,
  });
}

/**
 * @param {string | undefined} authorization
 * @param {string | undefined} expectedToken
 */
function isAuthorized(authorization, expectedToken) {
  if (typeof expectedToken !== "string" || expectedToken.length === 0) return false;
  if (typeof authorization !== "string") return false;
  const match = /^Bearer\s+([^\s]+)$/iu.exec(authorization.trim());
  return match?.[1] !== undefined && constantTimeEqual(match[1], expectedToken);
}

/** @type {import("openclaw/plugin-sdk/core").OpenClawPluginDefinition} */
const plugin = {
  id: PLUGIN_ID,
  name: "SFoA CRM Channel",
  description:
    "Trusted Salesforce CRM chat channel: credentialed HTTP ingress, official OpenClaw routing/session/reply pipeline, streaming and stop.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      serviceToken: {},
      allowRemoteService: { type: "boolean" },
      maxMessageChars: { type: "number" },
      turnTimeoutMs: { type: "number" },
      historyLimit: { type: "number" },
    },
  },

  register(api) {
    const resolveServiceToken = createServiceTokenResolver(api);
    const service = new CrmTurnService({
      runtime: api.runtime,
      getConfig: () => api.config,
      logger: api.logger,
      maxMessageChars: readPositiveNumber(api, "maxMessageChars", DEFAULT_MAX_MESSAGE_CHARS),
      turnTimeoutMs: readPositiveNumber(api, "turnTimeoutMs", DEFAULT_TURN_TIMEOUT_MS),
    });
    const historyLimit = readPositiveNumber(api, "historyLimit", DEFAULT_HISTORY_LIMIT);
    const allowRemoteService = api.pluginConfig?.allowRemoteService === true;

    api.registerChannel({ plugin: sfoaCrmChannelPlugin });

    /**
     * @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, ctx: { correlationId: string }) => Promise<boolean>} handler
     */
    const route = (handler) => async (req, res) => {
      const correlationId = randomUUID();
      res.setHeader("X-Correlation-Id", correlationId);
      try {
        // 默认只接受同机接入服务。Gateway 的监听地址可能包含 LAN，仅靠 Bearer
        // 会让一个被窃取的 service token 从任意主机可用；loopback 限制是额外的一层。
        if (!allowRemoteService && !isLoopbackAddress(req.socket?.remoteAddress)) {
          writeJson(res, 403, {
            errorCode: "CRM_LOOPBACK_REQUIRED",
            message: "The CRM channel ingress accepts only a same-host access service.",
            correlationId,
          });
          return true;
        }
        const token = await resolveServiceToken();
        if (!isAuthorized(req.headers.authorization, token)) {
          writeJson(res, 401, {
            errorCode: "CRM_CHANNEL_AUTH_FAILED",
            message: "The CRM channel service credential is missing or invalid.",
            correlationId,
          });
          return true;
        }
        return await handler(req, res, { correlationId });
      } catch (error) {
        if (error instanceof CrmProtocolError) {
          writeProtocolError(res, error, correlationId);
          return true;
        }
        api.logger.warn(`[${CHANNEL_ID}] ingress failed: ${describeError(error)}`);
        writeJson(res, 500, {
          errorCode: "CRM_CHANNEL_INTERNAL_ERROR",
          message: "The CRM channel could not process this request.",
          correlationId,
        });
        return true;
      }
    };

    /**
     * Gateway-authenticated route wrapper. The Gateway has already verified the
     * operator/device credential and scopes before this handler runs; we still
     * enforce the same loopback default so the history surface is not reachable
     * from another host unless explicitly configured.
     *
     * @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, ctx: { correlationId: string }) => Promise<boolean>} handler
     */
    const gatewayRoute = (handler) => async (req, res) => {
      const correlationId = randomUUID();
      res.setHeader("X-Correlation-Id", correlationId);
      try {
        if (!allowRemoteService && !isLoopbackAddress(req.socket?.remoteAddress)) {
          writeJson(res, 403, {
            errorCode: "CRM_LOOPBACK_REQUIRED",
            message: "The CRM channel history ingress accepts only a same-host access service.",
            correlationId,
          });
          return true;
        }
        return await handler(req, res, { correlationId });
      } catch (error) {
        if (error instanceof CrmProtocolError) {
          writeProtocolError(res, error, correlationId);
          return true;
        }
        api.logger.warn(`[${CHANNEL_ID}] gateway ingress failed: ${describeError(error)}`);
        writeJson(res, 500, {
          errorCode: "CRM_CHANNEL_INTERNAL_ERROR",
          message: "The CRM channel could not process this request.",
          correlationId,
        });
        return true;
      }
    };

    api.registerHttpRoute({
      path: `${ROUTE_PREFIX}/turn`,
      auth: "plugin",
      match: "exact",
      handler: route(async (req, res, { correlationId }) => {
        requireMethod(req, "POST");
        const body = await readJsonBody(req, MAX_BODY_BYTES);
        // Parse once here so a busy conversation can be answered with 409
        // before any SSE headers are sent.
        const parsed = parseTurnRequest(body, { maxMessageChars: service.maxMessageChars });
        if (service.activeBySession.has(service.resolveSession(parsed.conversationId).sessionKey)) {
          writeJson(res, 409, {
            errorCode: "CRM_CONVERSATION_BUSY",
            message: "This conversation is already answering. Wait for it to finish or stop it first.",
            correlationId,
          });
          return true;
        }
        await streamTurn({ api, service, req, res, body, correlationId });
        return true;
      }),
    });

    api.registerHttpRoute({
      path: `${ROUTE_PREFIX}/abort`,
      auth: "plugin",
      match: "exact",
      handler: route(async (req, res) => {
        requireMethod(req, "POST");
        const body = await readJsonBody(req, MAX_BODY_BYTES);
        const parsed = parseAbortRequest(body);
        const result = service.stop(parsed);
        writeJson(res, 200, result);
        return true;
      }),
    });

    api.registerHttpRoute({
      path: `${ROUTE_PREFIX}/history`,
      // History is the one read that needs the Gateway's `operator.read` scope.
      // It is kept on a separate route with Gateway authentication and
      // trusted-operator scope; turn/abort/session-resolve stay on the service
      // credential route above. The access service holds this Gateway token
      // server-side only and never uses it as a user identity.
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: gatewayRoute(async (req, res) => {
        requireMethod(req, "POST");
        const body = await readJsonBody(req, MAX_BODY_BYTES);
        const parsed = parseHistoryRequest(body);
        const history = await service.history({ ...parsed, limit: Math.min(parsed.limit, historyLimit) });
        writeJson(res, 200, history);
        return true;
      }),
    });

    api.registerHttpRoute({
      path: `${ROUTE_PREFIX}/session/resolve`,
      auth: "plugin",
      match: "exact",
      handler: route(async (req, res) => {
        requireMethod(req, "POST");
        const body = await readJsonBody(req, MAX_BODY_BYTES);
        const parsed = parseResolveRequest(body);
        const resolved = service.resolveSession(parsed.conversationId);
        writeJson(res, 200, {
          conversationId: parsed.conversationId,
          sessionKey: resolved.sessionKey,
          agentId: resolved.agentId,
          accountId: resolved.accountId,
        });
        return true;
      }),
    });

    api.registerHttpRoute({
      path: `${ROUTE_PREFIX}/health`,
      auth: "plugin",
      match: "exact",
      handler: route(async (req, res) => {
        requireMethod(req, "GET");
        writeJson(res, 200, {
          ok: true,
          channel: CHANNEL_ID,
          version: 1,
          activeTurns: service.activeBySession.size,
        });
        return true;
      }),
    });

    api.logger.info(
      `[${CHANNEL_ID}] channel registered; ingress ${ROUTE_PREFIX}/* accepts only the configured service credential`,
    );
  },
};

/**
 * @param {object} params
 * @param {object} params.api
 * @param {CrmTurnService} params.service
 * @param {import("node:http").IncomingMessage} params.req
 * @param {import("node:http").ServerResponse} params.res
 * @param {unknown} params.body
 * @param {string} params.correlationId
 */
async function streamTurn({ api, service, req, res, body, correlationId }) {
  let parsed;
  try {
    parsed = parseTurnRequest(body, { maxMessageChars: service.maxMessageChars });
  } catch (error) {
    if (error instanceof CrmProtocolError) {
      writeProtocolError(res, error, correlationId);
      return;
    }
    throw error;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-Correlation-Id", correlationId);
  res.flushHeaders?.();

  let finished = false;
  const sink = {
    event(type, data) {
      if (finished || res.writableEnded) return;
      res.write(encodeSseEvent(type, data));
    },
  };
  const heartbeat = setInterval(() => {
    if (!finished && !res.writableEnded) {
      try {
        res.write(encodeSseEvent("heartbeat", { ts: Date.now() }));
      } catch {
        // The client went away; the close handler aborts the turn.
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  const onClose = () => {
    if (finished) return;
    // The access service disconnected before the turn finished. Do not leave an
    // orphaned run consuming the model or tools.
    try {
      service.stop({ conversationId: parsed.conversationId, runId: parsed.runId });
    } catch {
      // Best effort; the turn's own timeout remains the backstop.
    }
  };
  res.on("close", onClose);

  try {
    const outcome = await service.turn(parsed, sink);
    if (outcome.status === "BUSY") {
      // Lost the race between the pre-check and dispatch.
      sink.event("run.failed", {
        runId: parsed.runId,
        status: "FAILED",
        errorCode: "CRM_CONVERSATION_BUSY",
        message: "This conversation is already answering. Wait for it to finish or stop it first.",
      });
    }
  } catch (error) {
    api.logger.warn(`[${CHANNEL_ID}] turn failed: ${describeError(error)}`);
    sink.event("run.failed", {
      runId: parsed.runId,
      status: "FAILED",
      errorCode: "CRM_CHANNEL_INTERNAL_ERROR",
      message: "The CRM channel could not complete this turn.",
    });
  } finally {
    finished = true;
    clearInterval(heartbeat);
    res.off("close", onClose);
    if (!res.writableEnded) res.end();
  }
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {string} method
 */
function requireMethod(req, method) {
  if (req.method !== method) {
    throw new CrmProtocolError("CRM_METHOD_NOT_ALLOWED", `This endpoint requires ${method}.`, 405);
  }
}

/** @param {unknown} error */
function describeError(error) {
  if (error instanceof Error) {
    const message = typeof error.message === "string" ? error.message.slice(0, 200) : "";
    return message.length > 0 ? `${error.name}: ${message}` : error.name;
  }
  return "unknown error";
}

/** @param {string | undefined} address */
function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1"
    || address.startsWith("127.");
}

/**
 * @param {object} api
 * @param {string} key
 * @param {number} fallback
 */
function readPositiveNumber(api, key, fallback) {
  const value = api.pluginConfig?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export default plugin;
