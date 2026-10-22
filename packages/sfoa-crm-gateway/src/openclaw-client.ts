import { CrmGatewayError } from './errors.js';

/**
 * The only client the CRM access service uses to reach OpenClaw.
 *
 * It speaks the plugin's credentialed HTTP ingress, not the Gateway operator
 * WebSocket. The service therefore never holds the Gateway token and cannot
 * call arbitrary Gateway methods; it can only ask the CRM channel plugin to
 * run/history/abort/resolve within the conversation the service already owns.
 */

export type OpenClawEvent = Readonly<{ type: string; data: unknown }>;

export type OpenClawHistoryResult = Readonly<{
  messages: ReadonlyArray<Readonly<{
    id: string;
    role: string;
    text: string;
    timestamp: number | null;
  }>>;
  hasMore: boolean;
}>;

export type OpenClawResolvedSession = Readonly<{
  conversationId: string;
  sessionKey: string;
  agentId: string;
  accountId: string;
}>;

/** Structural boundary used by the HTTP server; the real class is one implementation. */
export interface OpenClawCrmClientLike {
  turn(body: unknown, onEvent: (event: OpenClawEvent) => void | Promise<void>, signal?: AbortSignal): Promise<void>;
  abort(body: Readonly<{ conversationId: string; runId: string }>): Promise<Readonly<{ aborted: boolean; reason?: string }>>;
  history(body: Readonly<{ sessionKey: string; limit: number }>): Promise<OpenClawHistoryResult>;
  resolveSession(conversationId: string): Promise<OpenClawResolvedSession>;
  health(): Promise<Readonly<{ ok: boolean; channel: string }>>;
}

export class OpenClawCrmClient implements OpenClawCrmClientLike {
  public constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
    private readonly options: Readonly<{ timeoutMs: number; historyToken?: string; fetchImpl?: typeof fetch }> = { timeoutMs: 60_000 },
  ) {}

  public async turn(
    body: unknown,
    onEvent: (event: OpenClawEvent) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('OpenClaw turn timeout')), this.options.timeoutMs);
    timeout.unref?.();
    const abortFromCaller = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    try {
      const response = await this.request('/turn', body, {
        signal: controller.signal,
        accept: 'text/event-stream',
      });
      if (!response.body) {
        throw new CrmGatewayError('CRM_OPENCLAW_PROTOCOL_ERROR', 'OpenClaw 未返回流式回答。', 502);
      }
      await parseSseStream(response.body, onEvent, controller.signal);
    } catch (error) {
      throw this.mapTransportError(error, signal);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  public async abort(body: Readonly<{ conversationId: string; runId: string }>): Promise<Readonly<{ aborted: boolean; reason?: string }>> {
    const response = await this.request('/abort', body);
    const parsed = await response.json() as unknown;
    if (!parsed || typeof parsed !== 'object') {
      throw new CrmGatewayError('CRM_OPENCLAW_PROTOCOL_ERROR', 'OpenClaw 返回了无效的停止结果。', 502);
    }
    const record = parsed as Record<string, unknown>;
    return Object.freeze({
      aborted: record.aborted === true,
      ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
    });
  }

  public async history(body: Readonly<{ sessionKey: string; limit: number }>): Promise<OpenClawHistoryResult> {
    if (typeof this.options.historyToken !== 'string' || this.options.historyToken.length === 0) {
      throw new CrmGatewayError('CRM_HISTORY_UNAVAILABLE', 'CRM 历史读取凭据未配置。', 503);
    }
    const response = await this.request('/history', body, { authorizationToken: this.options.historyToken });
    const parsed = await response.json() as unknown;
    if (!parsed || typeof parsed !== 'object') {
      throw new CrmGatewayError('CRM_OPENCLAW_PROTOCOL_ERROR', 'OpenClaw 返回了无效的历史记录。', 502);
    }
    return parsed as OpenClawHistoryResult;
  }

  public async resolveSession(conversationId: string): Promise<OpenClawResolvedSession> {
    const response = await this.request('/session/resolve', { conversationId });
    const parsed = await response.json() as unknown;
    if (!parsed || typeof parsed !== 'object') {
      throw new CrmGatewayError('CRM_OPENCLAW_PROTOCOL_ERROR', 'OpenClaw 返回了无效的会话路由。', 502);
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.sessionKey !== 'string'
      || typeof record.agentId !== 'string'
      || typeof record.accountId !== 'string'
    ) {
      throw new CrmGatewayError('CRM_OPENCLAW_PROTOCOL_ERROR', 'OpenClaw 返回了不完整的会话路由。', 502);
    }
    return Object.freeze({
      conversationId,
      sessionKey: record.sessionKey,
      agentId: record.agentId,
      accountId: record.accountId,
    });
  }

  public async health(): Promise<Readonly<{ ok: boolean; channel: string }>> {
    const response = await this.request('/health', undefined, { method: 'GET', accept: 'application/json' });
    const parsed = await response.json() as unknown;
    if (!parsed || typeof parsed !== 'object') {
      throw new CrmGatewayError('CRM_OPENCLAW_PROTOCOL_ERROR', 'OpenClaw 返回了无效的健康状态。', 502);
    }
    const record = parsed as Record<string, unknown>;
    return Object.freeze({ ok: record.ok === true, channel: typeof record.channel === 'string' ? record.channel : '' });
  }

  private async request(
    path: string,
    body: unknown,
    options: Readonly<{ method?: 'GET' | 'POST'; signal?: AbortSignal; accept?: string; authorizationToken?: string }> = {},
  ): Promise<Response> {
    const method = options.method ?? 'POST';
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const authorizationToken = options.authorizationToken ?? this.serviceToken;
    let response: Response;
    try {
      response = await fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${authorizationToken}`,
          Accept: options.accept ?? 'application/json',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throw this.mapTransportError(error, options.signal);
    }
    if (!response.ok) {
      const pluginError = await readPluginError(response);
      throw new CrmGatewayError(
        pluginError.code ?? `CRM_OPENCLAW_HTTP_${response.status}`,
        pluginError.message ?? 'OpenClaw 无法处理该请求。',
        response.status === 409 ? 409 : 502,
      );
    }
    return response;
  }

  private mapTransportError(error: unknown, callerSignal?: AbortSignal): CrmGatewayError {
    if (callerSignal?.aborted === true) {
      return new CrmGatewayError('CRM_RUN_CANCELLED', '请求已取消。', 499, { cause: error });
    }
    if (error instanceof CrmGatewayError) return error;
    if (error instanceof Error && error.name === 'AbortError') {
      return new CrmGatewayError('CRM_OPENCLAW_TIMEOUT', 'CRM 渠道响应超时。请先查看历史消息确认是否已有结果，不要直接重复提交。', 504, { cause: error });
    }
    return new CrmGatewayError('CRM_OPENCLAW_UNAVAILABLE', 'CRM 渠道暂时不可用。请稍后重试。', 502, { cause: error });
  }
}

async function readPluginError(response: Response): Promise<{ code?: string; message?: string }> {
  try {
    const body = await response.json() as unknown;
    if (!body || typeof body !== 'object') return {};
    const record = body as Record<string, unknown>;
    return {
      ...(typeof record.errorCode === 'string' && /^CRM_[A-Z0-9_]{1,96}$/u.test(record.errorCode)
        ? { code: record.errorCode }
        : {}),
      ...(typeof record.message === 'string' ? { message: record.message.slice(0, 512) } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * 严格 SSE 解析器。只接受 `event:` / `data:` 帧；单帧上限 1 MiB，整条流上限
 * 4 MiB，避免一个异常渠道把接入服务内存打满。
 *
 * @param stream
 * @param onEvent
 * @param signal
 */
export async function parseSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: OpenClawEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalBytes = 0;
  const MAX_FRAME_BYTES = 1_048_576;
  const MAX_STREAM_BYTES = 4_194_304;
  try {
    while (true) {
      if (signal?.aborted === true) throw new CrmGatewayError('CRM_RUN_CANCELLED', '请求已取消。', 499);
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_STREAM_BYTES) {
        throw new CrmGatewayError('CRM_OPENCLAW_PROTOCOL_ERROR', 'CRM 渠道返回的数据超过允许上限。', 502);
      }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_FRAME_BYTES && !buffer.includes('\n\n')) {
        throw new CrmGatewayError('CRM_OPENCLAW_PROTOCOL_ERROR', 'CRM 渠道返回了过大的单帧。', 502);
      }
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.length > MAX_FRAME_BYTES) {
          throw new CrmGatewayError('CRM_OPENCLAW_PROTOCOL_ERROR', 'CRM 渠道返回了过大的单帧。', 502);
        }
        const event = parseFrame(frame);
        if (event) await onEvent(event);
        boundary = buffer.indexOf('\n\n');
      }
    }
    // Some servers close without a trailing blank line; flush a complete frame.
    const trailing = buffer.trim();
    if (trailing.length > 0) {
      const event = parseFrame(trailing);
      if (event) await onEvent(event);
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame: string): OpenClawEvent | undefined {
  let eventType = 'message';
  const dataLines: string[] = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0 || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(dataLines.join('\n'));
  } catch {
    throw new CrmGatewayError('CRM_OPENCLAW_PROTOCOL_ERROR', 'CRM 渠道返回了无法解析的事件。', 502);
  }
  return Object.freeze({ type: eventType, data });
}
