/**
 * Pure protocol helpers for the SFoA CRM channel.
 *
 * Nothing here imports OpenClaw. That is deliberate: request validation,
 * identity normalization and history projection are the parts most worth
 * testing on their own, and none of them needs a running Gateway.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const CHANNEL_ID = "sfoa-crm";
export const DEFAULT_MAX_MESSAGE_CHARS = 16_000;
export const DEFAULT_TURN_TIMEOUT_MS = 600_000;
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_HISTORY_MESSAGE_CHARS = 20_000;

/** 稳定的协议错误；HTTP 层只输出 code/status，不输出堆栈。 */
export class CrmProtocolError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} status
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = "CrmProtocolError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Platform user id 是 MCP `X-SFOA-CRM-User-Id` 的值，必须与 MCP 的
 * platformUserId 规则兼容：1-128 个可打印字符，且不能带空白/控制字符，
 * 否则会破坏 header 的单一值语义。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizePlatformUserId(value) {
  if (typeof value !== "string") {
    throw new CrmProtocolError("CRM_PLATFORM_USER_INVALID", "platformUserId must be a string.");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw new CrmProtocolError("CRM_PLATFORM_USER_INVALID", "platformUserId must contain 1-128 characters.");
  }
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      throw new CrmProtocolError("CRM_PLATFORM_USER_INVALID", "platformUserId must not contain whitespace or control characters.");
    }
  }
  return trimmed;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function normalizeUuid(value, field) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new CrmProtocolError("CRM_REQUEST_INVALID", `${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

/**
 * @param {unknown} value
 * @param {{ maxMessageChars?: number }} [options]
 * @returns {string}
 */
export function normalizeMessage(value, options = {}) {
  const max = options.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
  if (typeof value !== "string") {
    throw new CrmProtocolError("CRM_MESSAGE_INVALID", "message must be a string.");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CrmProtocolError("CRM_MESSAGE_EMPTY", "message must not be empty.");
  }
  if (trimmed.length > max) {
    throw new CrmProtocolError("CRM_MESSAGE_TOO_LONG", `message must be at most ${max} characters.`);
  }
  // 允许换行与制表符，拒绝其它控制字符；这些字符会被原样送进模型上下文，
  // 不应成为隐藏 prompt 分隔符或日志注入面。
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      throw new CrmProtocolError("CRM_MESSAGE_INVALID", "message must not contain control characters.");
    }
  }
  return trimmed;
}

/**
 * 当前记录上下文只是业务提示，不是授权依据。
 * 这里限制字符集，避免把任意文本拼进模型输入。
 *
 * @param {unknown} value
 * @returns {{ objectApiName: string, recordId: string } | undefined}
 */
export function normalizeRecordContext(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new CrmProtocolError("CRM_RECORD_CONTEXT_INVALID", "recordContext must be an object.");
  }
  const objectApiName = value.objectApiName;
  const recordId = value.recordId;
  if (typeof objectApiName !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(objectApiName)) {
    throw new CrmProtocolError("CRM_RECORD_CONTEXT_INVALID", "recordContext.objectApiName is invalid.");
  }
  if (typeof recordId !== "string" || !/^[A-Za-z0-9]{15,18}$/u.test(recordId)) {
    throw new CrmProtocolError("CRM_RECORD_CONTEXT_INVALID", "recordContext.recordId is invalid.");
  }
  return Object.freeze({ objectApiName, recordId });
}

/**
 * @param {unknown} body
 * @param {{ maxMessageChars?: number }} [options]
 */
export function parseTurnRequest(body, options = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CrmProtocolError("CRM_REQUEST_INVALID", "The request body must be a JSON object.");
  }
  const platformUserId = normalizePlatformUserId(body.platformUserId);
  const conversationId = normalizeUuid(body.conversationId, "conversationId");
  const runId = normalizeUuid(body.runId, "runId");
  const message = normalizeMessage(body.message, options);
  const recordContext = normalizeRecordContext(body.recordContext);
  return Object.freeze({ platformUserId, conversationId, runId, message, recordContext });
}

/** @param {unknown} body */
export function parseAbortRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CrmProtocolError("CRM_REQUEST_INVALID", "The request body must be a JSON object.");
  }
  return Object.freeze({
    conversationId: normalizeUuid(body.conversationId, "conversationId"),
    runId: normalizeUuid(body.runId, "runId"),
  });
}

/** @param {unknown} body */
export function parseResolveRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CrmProtocolError("CRM_REQUEST_INVALID", "The request body must be a JSON object.");
  }
  return Object.freeze({
    conversationId: normalizeUuid(body.conversationId, "conversationId"),
  });
}

/** @param {unknown} body */
export function parseHistoryRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CrmProtocolError("CRM_REQUEST_INVALID", "The request body must be a JSON object.");
  }
  const sessionKey = body.sessionKey;
  if (typeof sessionKey !== "string" || sessionKey.trim().length === 0 || sessionKey.length > 512) {
    throw new CrmProtocolError("CRM_SESSION_KEY_INVALID", "sessionKey is invalid.");
  }
  const limit = body.limit === undefined ? DEFAULT_HISTORY_LIMIT : Number(body.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new CrmProtocolError("CRM_HISTORY_LIMIT_INVALID", "limit must be an integer between 1 and 200.");
  }
  return Object.freeze({ sessionKey: sessionKey.trim(), limit });
}

/**
 * 把记录上下文作为一条显式业务前缀附加到用户消息。它不是系统指令、不改变身份，
 * 也不会被当作 Tool 参数的可信来源。
 *
 * @param {{ objectApiName: string, recordId: string } | undefined} recordContext
 * @param {string} message
 */
export function withRecordContext(recordContext, message) {
  if (recordContext === undefined) return message;
  return `[当前记录上下文] 对象: ${recordContext.objectApiName}, 记录 Id: ${recordContext.recordId}\n\n${message}`;
}

/**
 * SSE 帧。data 必须是 JSON，且不能包含裸换行（JSON.stringify 已保证）。
 *
 * @param {string} type
 * @param {unknown} data
 */
export function encodeSseEvent(type, data) {
  if (!/^[a-z][a-z0-9.-]{0,63}$/u.test(type)) throw new Error("Invalid SSE event type.");
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * 从 onPartialReply 的 payload 提取可安全转发给 UI 的增量。
 * `replace` 表示这是一份替换快照，而不是追加。
 *
 * @param {{ text?: unknown, delta?: unknown, replace?: unknown }} payload
 * @returns {{ text: string, replace: boolean } | undefined}
 */
export function readPartialPayload(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  const replace = payload.replace === true;
  const delta = typeof payload.delta === "string" ? payload.delta : undefined;
  const text = typeof payload.text === "string" ? payload.text : undefined;
  if (replace && text !== undefined) return { text, replace: true };
  if (delta !== undefined && delta.length > 0) return { text: delta, replace: false };
  if (text !== undefined && text.length > 0) return { text, replace: false };
  return undefined;
}

/**
 * chat.history 的返回结构在 OpenClaw 版本之间可能有展示层包装。
 * 这里只做防御式投影：不猜测业务语义，不返回工具/系统消息，不把未知字段透传。
 *
 * @param {unknown} result
 * @param {number} limit
 * @returns {{ messages: Array<{ id: string, role: string, text: string, timestamp: number | null }>, hasMore: boolean }}
 */
export function projectHistory(result, limit) {
  const rawMessages = result && typeof result === "object" && Array.isArray(result.messages)
    ? result.messages
    : [];
  /** @type {Array<{ id: string, role: string, text: string, timestamp: number | null }>} */
  const messages = [];
  for (let index = 0; index < rawMessages.length; index += 1) {
    const entry = rawMessages[index];
    if (!entry || typeof entry !== "object") continue;
    const message = entry.message && typeof entry.message === "object" ? entry.message : entry;
    const role = typeof message.role === "string"
      ? message.role
      : typeof entry.role === "string"
        ? entry.role
        : undefined;
    if (role !== "user" && role !== "assistant") continue;
    const text = readMessageText(message.content ?? entry.content ?? message.text ?? entry.text);
    if (text.length === 0) continue;
    const id = typeof entry.id === "string" && entry.id.length > 0
      ? entry.id
      : typeof message.id === "string" && message.id.length > 0
        ? message.id
        : `history-${index}`;
    const timestamp = readTimestamp(entry.timestamp ?? message.timestamp ?? entry.createdAt ?? message.createdAt);
    messages.push({
      id,
      role,
      text: text.length > MAX_HISTORY_MESSAGE_CHARS ? `${text.slice(0, MAX_HISTORY_MESSAGE_CHARS)}…` : text,
      timestamp,
    });
  }
  const bounded = messages.slice(-limit);
  return Object.freeze({
    messages: Object.freeze(bounded),
    hasMore: messages.length > bounded.length,
  });
}

/** @param {unknown} value */
function readMessageText(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

/** @param {unknown} value */
function readTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 对任意长度字符串做恒定时间比较。先做 SHA-256 归一到固定长度，
 * 避免 timingSafeEqual 对长度不等直接抛错而泄漏长度信息。
 *
 * @param {string} left
 * @param {string} right
 */
export function constantTimeEqual(left, right) {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/**
 * 把内部异常映射为稳定的、可展示但无堆栈的错误码。
 * 不把模型/工具返回的任意文本当作错误码。
 *
 * @param {unknown} error
 * @param {AbortSignal} [signal]
 */
export function classifyTurnFailure(error, signal) {
  if (signal?.aborted === true) {
    return Object.freeze({ code: "CRM_TURN_STOPPED", message: "本次回答已停止。", stopped: true });
  }
  if (error instanceof CrmProtocolError) {
    return Object.freeze({ code: error.code, message: error.message, stopped: false });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return Object.freeze({ code: "CRM_TURN_STOPPED", message: "本次回答已停止。", stopped: true });
  }
  return Object.freeze({
    code: "CRM_TURN_FAILED",
    message: "回答生成失败。请稍后重试；已完成的 Salesforce 写入不会因本次失败自动回滚。",
    stopped: false,
  });
}
