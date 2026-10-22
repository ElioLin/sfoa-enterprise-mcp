/**
 * Trusted CRM turn service.
 *
 * This is the only place where a CRM request becomes an OpenClaw agent turn with
 * a `SenderId`. The identity comes from the HTTP ingress, which has already
 * authenticated the SFoA CRM access service and validated the Apex-bound
 * platform user; nothing here reads identity from the message body's wording,
 * the model, a tool argument, or process-global state.
 *
 * It uses the same official plugin-runtime surfaces the WeCom channel uses:
 *   resolveAgentRoute -> finalizeInboundContext -> recordInboundSession
 *   -> dispatchReplyWithBufferedBlockDispatcher
 * so session keys are produced by OpenClaw, not invented here.
 */

import {
  CHANNEL_ID,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_MAX_MESSAGE_CHARS,
  DEFAULT_TURN_TIMEOUT_MS,
  classifyTurnFailure,
  parseAbortRequest,
  parseHistoryRequest,
  parseResolveRequest,
  parseTurnRequest,
  projectHistory,
  readPartialPayload,
} from "./protocol.js";

/**
 * @typedef {{
 *   event: (type: string, data: unknown) => void,
 * }} TurnSink
 */

/**
 * @typedef {{
 *   runtime: any,
 *   getConfig: () => any,
 *   logger?: { info?: Function, warn?: Function, debug?: Function, error?: Function },
 *   maxMessageChars?: number,
 *   turnTimeoutMs?: number,
 *   now?: () => number,
 * }} TurnServiceOptions
 */

export class CrmTurnService {
  /** @param {TurnServiceOptions} options */
  constructor(options) {
    this.runtime = options.runtime;
    this.getConfig = options.getConfig;
    this.logger = options.logger ?? {};
    this.maxMessageChars = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    /** @type {Map<string, { runId: string, controller: AbortController, stopRequested: boolean, startedAt: number }>} */
    this.activeBySession = new Map();
    /** @type {Map<string, { sessionKey: string, controller: AbortController, stopRequested: boolean }>} */
    this.activeByRun = new Map();
  }

  /**
   * 解析官方 Agent 路由。同一 conversationId 永远得到同一个 sessionKey；
   * 不同 conversationId 得到不同 sessionKey。
   *
   * @param {string} conversationId
   */
  resolveSession(conversationId) {
    const cfg = this.getConfig();
    const route = this.runtime.channel.routing.resolveAgentRoute({
      cfg,
      channel: CHANNEL_ID,
      accountId: "default",
      peer: { kind: "direct", id: conversationId },
    });
    if (!route || typeof route.sessionKey !== "string" || route.sessionKey.length === 0) {
      throw new Error("OpenClaw returned no usable session route for this conversation.");
    }
    return Object.freeze({
      sessionKey: route.sessionKey,
      agentId: typeof route.agentId === "string" ? route.agentId : "main",
      accountId: typeof route.accountId === "string" ? route.accountId : "default",
    });
  }

  /**
   * @param {unknown} body
   */
  resolveSessionFromBody(body) {
    const { conversationId } = parseResolveRequest(body);
    return Object.freeze({ conversationId, ...this.resolveSession(conversationId) });
  }

  /**
   * 读取官方会话历史并投影为 UI 安全结构。
   *
   * 这里使用插件运行时的 `subagent.getSessionMessages`（内核内部走官方
   * `sessions.get`），而不是 `gateway.request("chat.history")`：插件 HTTP route
   * 是 `auth:"plugin"`，不允许以 operator 身份派发任意 Gateway 方法。该 API
   * 仍由 OpenClaw 持有存储与读取语义，接入服务不接触 Gateway token 或会话库。
   *
   * @param {unknown} body
   */
  async history(body) {
    const { sessionKey, limit } = parseHistoryRequest(body);
    const result = await this.runtime.subagent.getSessionMessages({
      sessionKey,
      limit: Math.min(Math.max(limit, 1), 200),
    });
    return projectHistory(result, limit);
  }

  /**
   * 停止本对话的目标运行。只允许停止该 conversationId 当前绑定的 runId，
   * 不能停止另一个对话/用户的运行。
   *
   * @param {unknown} body
   */
  stop(body) {
    const { conversationId, runId } = parseAbortRequest(body);
    const session = this.resolveSession(conversationId);
    const active = this.activeBySession.get(session.sessionKey);
    if (!active || active.runId !== runId) {
      return Object.freeze({ aborted: false, reason: "NOT_RUNNING" });
    }
    active.stopRequested = true;
    active.controller.abort(new Error("CRM user requested stop"));
    return Object.freeze({ aborted: true, reason: "ABORTED" });
  }

  /**
   * 执行一轮对话，事件通过 sink 以 SSE 语义输出。
   * 返回终态，供 HTTP 层记录；不影响已确定的 Salesforce 业务结果。
   *
   * @param {unknown} body
   * @param {TurnSink} sink
   */
  async turn(body, sink) {
    const request = parseTurnRequest(body, { maxMessageChars: this.maxMessageChars });
    const session = this.resolveSession(request.conversationId);
    if (this.activeBySession.has(session.sessionKey)) {
      const active = this.activeBySession.get(session.sessionKey);
      return Object.freeze({
        status: "BUSY",
        runId: active?.runId ?? null,
        sessionKey: session.sessionKey,
      });
    }

    const controller = new AbortController();
    const active = { runId: request.runId, controller, stopRequested: false, startedAt: this.now() };
    this.activeBySession.set(session.sessionKey, active);
    this.activeByRun.set(request.runId, { sessionKey: session.sessionKey, controller, stopRequested: false });

    /** @type {string[]} */
    const deliveredBlocks = [];
    let partialText = "";
    let completed = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("CRM turn timeout"));
    }, this.turnTimeoutMs);
    timeout.unref?.();

    sink.event("run.started", {
      runId: request.runId,
      conversationId: request.conversationId,
      sessionKey: session.sessionKey,
      agentId: session.agentId,
    });

    try {
      const ctx = this.runtime.channel.reply.finalizeInboundContext(buildInboundContext(request, session));
      await this.runtime.channel.session.recordInboundSession({
        storePath: this.runtime.channel.session.resolveStorePath(this.getConfig().session?.store, {
          agentId: session.agentId,
        }),
        sessionKey: session.sessionKey,
        ctx,
        onRecordError: (error) => {
          this.logger.warn?.(`[${CHANNEL_ID}] session record failed: ${describeError(error)}`);
        },
      });

      const result = await this.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg: this.getConfig(),
        replyOptions: {
          abortSignal: controller.signal,
          onPartialReply: (payload) => {
            const partial = readPartialPayload(payload);
            if (!partial) return;
            if (partial.replace) {
              partialText = partial.text;
              sink.event("message.replace", { text: partial.text });
              return;
            }
            // 有些版本同时给出 text（累计）和 delta（增量）。优先 delta；
            // 没有 delta 时用累计文本与上一份累计文本的差集，避免重复显示。
            if (partialText.length > 0 && partial.text.startsWith(partialText)) {
              const suffix = partial.text.slice(partialText.length);
              partialText = partial.text;
              if (suffix.length > 0) sink.event("message.delta", { text: suffix });
              return;
            }
            partialText += partial.text;
            sink.event("message.delta", { text: partial.text });
          },
        },
        dispatcherOptions: {
          deliver: async (payload) => {
            if (!payload || typeof payload !== "object") return;
            const text = typeof payload.text === "string" ? payload.text : "";
            if (text.trim().length === 0) return;
            deliveredBlocks.push(text);
            // 没有流式分片时，至少把最终块交给 UI；有分片时不重复追加，
            // 由 message.final 统一校准。
            if (partialText.length === 0) sink.event("message.delta", { text });
          },
          onError: (error) => {
            this.logger.warn?.(`[${CHANNEL_ID}] dispatch error: ${describeError(error)}`);
          },
        },
      });

      const finalText = deliveredBlocks.length > 0 ? deliveredBlocks.join("\n\n") : partialText;
      if (finalText.length > 0) sink.event("message.final", { text: finalText });
      completed = true;
      sink.event("run.completed", {
        runId: request.runId,
        status: "COMPLETED",
        durationMs: Math.max(0, this.now() - active.startedAt),
        resultStatus: typeof result === "object" && result !== null && "status" in result
          ? String(result.status)
          : undefined,
      });
      return Object.freeze({ status: "COMPLETED", runId: request.runId, sessionKey: session.sessionKey, finalText });
    } catch (error) {
      const failure = timedOut
        ? Object.freeze({ code: "CRM_TURN_TIMEOUT", message: "本次回答超时。请先查看历史消息确认是否已有结果，不要直接重复提交。", stopped: false })
        : classifyTurnFailure(error, controller.signal);
      sink.event(failure.stopped ? "run.stopped" : "run.failed", {
        runId: request.runId,
        status: failure.stopped ? "STOPPED" : "FAILED",
        errorCode: failure.code,
        message: failure.message,
      });
      return Object.freeze({
        status: failure.stopped ? "STOPPED" : "FAILED",
        runId: request.runId,
        sessionKey: session.sessionKey,
        errorCode: failure.code,
      });
    } finally {
      clearTimeout(timeout);
      this.activeBySession.delete(session.sessionKey);
      this.activeByRun.delete(request.runId);
      // 没有完成、也没有显式失败/停止（例如客户端断开导致 dispatch 提前返回）
      // 时标记为未知，绝不自动重试。
      if (!completed) {
        this.logger.info?.(
          `[${CHANNEL_ID}] turn ended without a terminal event: run=${request.runId} session=${describeSessionKey(session.sessionKey)}`,
        );
      }
    }
  }
}

/**
 * @param {ReturnType<typeof parseTurnRequest>} request
 * @param {{ sessionKey: string, agentId: string, accountId: string }} session
 */
function buildInboundContext(request, session) {
  // 身份只来自 request.platformUserId（由 HTTP 层在验证 Apex 签名后注入）。
  // Body/From/OriginatingTo 都使用 conversationId，确保不同对话的会话键与投递目标独立。
  const body = request.recordContext === undefined
    ? request.message
    : `[当前记录上下文] 对象: ${request.recordContext.objectApiName}, 记录 Id: ${request.recordContext.recordId}\n\n${request.message}`;
  const from = `${CHANNEL_ID}:${request.conversationId}`;
  return {
    Body: body,
    RawBody: request.message,
    CommandBody: request.message,
    MessageSid: request.runId,
    From: from,
    To: from,
    SenderId: request.platformUserId,
    SessionKey: session.sessionKey,
    AccountId: session.accountId,
    ChatType: "direct",
    ConversationLabel: `CRM ${request.conversationId}`,
    Timestamp: Date.now(),
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: from,
    // CRM UI 不暴露斜杠命令；把它设为 false 让命令门禁保持关闭。
    CommandAuthorized: false,
  };
}

/** @param {unknown} error */
function describeError(error) {
  if (error instanceof Error) return error.name;
  return "unknown error";
}

/** @param {unknown} value */
function describeSessionKey(value) {
  if (typeof value !== "string" || value.trim().length === 0) return "(none)";
  return value.trim().replace(/\d+/gu, "#");
}
