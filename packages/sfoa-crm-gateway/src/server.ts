import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type {
  CrmChatRepository,
  CrmChatSessionRecord,
  CrmConversationRecord,
  CrmRunRecord,
} from '@sfoa/control-plane';
import type { ApexTokenVerifier } from './apex-token.js';
import { ChatSessionService, SlidingWindowRateLimiter } from './chat-auth.js';
import type { CrmGatewayConfig } from './config.js';
import { CrmGatewayError, isCrmGatewayError, toCrmGatewayError } from './errors.js';
import type { OpenClawCrmClientLike, OpenClawEvent } from './openclaw-client.js';
import { RunStream } from './run-stream.js';
import { encodeSseEvent } from './sse.js';

/**
 * CRM 聊天接入服务的 HTTP 边界。
 *
 * - 浏览器只持有短期聊天凭证（内存），不持有 Apex 私钥、Gateway 令牌或数据库口令。
 * - 每个对话/运行都按已验证的 Salesforce 主体校验归属；跨用户访问统一表现为 404。
 * - OpenClaw 只通过 CRM 渠道插件的受限 HTTP 入口访问，服务不持有 Gateway operator token。
 */

export type CrmGatewayLogger = Readonly<{
  info(event: Readonly<Record<string, unknown>>): void;
  warn(event: Readonly<Record<string, unknown>>): void;
  error(event: Readonly<Record<string, unknown>>): void;
}>;

export type CrmGatewayDependencies = Readonly<{
  config: CrmGatewayConfig;
  repository: CrmChatRepository;
  apexVerifier: ApexTokenVerifier;
  chatSessions: ChatSessionService;
  openclaw: OpenClawCrmClientLike;
  tls?: Readonly<{ key: string | Buffer; cert: string | Buffer }>;
  now?: () => number;
  logger?: CrmGatewayLogger;
  health?: () => Promise<Readonly<Record<string, string>>>;
}>;

type Principal = Readonly<{
  session: CrmChatSessionRecord;
  orgId: string;
  userId: string;
  platformUserId: string;
  displayName: string;
  salesforceUsername: string | null;
}>;

const RUN_STREAM_RETENTION_MS = 10 * 60_000;

export class CrmGatewayServer {
  public readonly server: Server;
  private readonly runStreams = new Map<string, RunStream>();
  private readonly activePumps = new Map<string, AbortController>();
  private readonly pumpPromises = new Set<Promise<void>>();
  private readonly exchangeByIp: SlidingWindowRateLimiter;
  private readonly exchangeBySubject: SlidingWindowRateLimiter;
  private readonly messagesBySubject: SlidingWindowRateLimiter;
  private readonly messagesByConversation: SlidingWindowRateLimiter;
  private readonly readsBySubject: SlidingWindowRateLimiter;

  public constructor(private readonly deps: CrmGatewayDependencies) {
    const handler = (request: IncomingMessage, response: ServerResponse): void => {
      void this.handle(request, response);
    };
    this.server = deps.tls
      ? createHttpsServer({ key: deps.tls.key, cert: deps.tls.cert }, handler)
      : createServer(handler);
    this.exchangeByIp = new SlidingWindowRateLimiter({ limit: 60, windowMs: 60_000, now: deps.now });
    this.exchangeBySubject = new SlidingWindowRateLimiter({ limit: 10, windowMs: 60_000, now: deps.now });
    this.messagesBySubject = new SlidingWindowRateLimiter({ limit: 60, windowMs: 60_000, now: deps.now });
    this.messagesByConversation = new SlidingWindowRateLimiter({ limit: 20, windowMs: 60_000, now: deps.now });
    this.readsBySubject = new SlidingWindowRateLimiter({ limit: 240, windowMs: 60_000, now: deps.now });
  }

  public listen(): Promise<Readonly<{ url: string; port: number }>> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        const address = this.server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('The CRM gateway did not bind a TCP port.'));
          return;
        }
        const protocol = this.deps.tls ? 'https' : 'http';
        resolve(Object.freeze({
          url: `${protocol}://${this.deps.config.bindHost}:${address.port}${this.deps.config.basePath}`,
          port: address.port,
        }));
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.deps.config.port, this.deps.config.bindHost);
    });
  }

  public async close(): Promise<void> {
    for (const controller of this.activePumps.values()) controller.abort(new Error('CRM gateway shutdown'));
    this.activePumps.clear();
    // Let the pumps persist their terminal UNKNOWN/STOPPED state before the database
    // pool is closed by the caller. Bounded: a stuck plugin must not block shutdown.
    await Promise.race([
      Promise.allSettled([...this.pumpPromises]),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        timer.unref?.();
      }),
    ]);
    for (const stream of this.runStreams.values()) stream.close();
    this.runStreams.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private nowMs(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const correlationId = randomUUID();
    response.setHeader('X-Correlation-Id', correlationId);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');

    const origin = readSingleHeader(request, 'origin');
    if (origin !== undefined) {
      if (!this.deps.config.allowedOrigins.includes(origin)) {
        writeJson(response, 403, {
          errorCode: 'CRM_ORIGIN_DENIED',
          message: '该来源未被允许访问 CRM 聊天服务。',
          correlationId,
        });
        return;
      }
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Request-Id');
      response.setHeader('Access-Control-Expose-Headers', 'X-Correlation-Id');
      response.setHeader('Access-Control-Max-Age', '600');
    }
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }

    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const base = this.deps.config.basePath;

      if (path === `${base}/health` && request.method === 'GET') {
        writeJson(response, 200, {
          status: 'UP',
          service: 'sfoa-crm-gateway',
          version: '0.1.0-crm',
          time: new Date(this.nowMs()).toISOString(),
        });
        return;
      }
      if (path === `${base}/ready` && request.method === 'GET') {
        await this.handleReady(response);
        return;
      }
      if (path === `${base}/auth/exchange` && request.method === 'POST') {
        await this.handleExchange(request, response);
        return;
      }

      const principal = await this.requirePrincipal(request);
      if (path === `${base}/me` && request.method === 'GET') {
        writeJson(response, 200, {
          user: {
            displayName: principal.displayName,
            platformUserId: principal.platformUserId,
            salesforceUsername: principal.salesforceUsername,
            orgId: principal.orgId,
          },
          session: { expiresAt: principal.session.expiresAt.toISOString() },
        });
        return;
      }
      if (path === `${base}/conversations` && request.method === 'GET') {
        this.consumeReads(principal, response);
        const limit = clampInteger(url.searchParams.get('limit'), 1, this.deps.config.conversationListLimit, this.deps.config.conversationListLimit);
        const conversations = await this.deps.repository.listConversations(principal.orgId, principal.userId, limit);
        writeJson(response, 200, { conversations: conversations.map(toConversationDto) });
        return;
      }
      if (path === `${base}/conversations` && request.method === 'POST') {
        const body = await readJsonBody(request, this.deps.config.maxBodyBytes, true);
        const title = readOptionalTitle(body, 'title') ?? '新对话';
        const now = new Date(this.nowMs());
        const conversation = await this.deps.repository.createConversation({
          id: randomUUID(),
          salesforceOrgId: principal.orgId,
          salesforceUserId: principal.userId,
          platformUserId: principal.platformUserId,
          title,
          now,
        });
        writeJson(response, 201, { conversation: toConversationDto(conversation) });
        return;
      }

      const conversationMatch = new RegExp(`^${escapeRegExp(base)}/conversations/([0-9a-f-]{36})(/messages)?$`, 'u').exec(path);
      if (conversationMatch?.[1]) {
        const conversationId = conversationMatch[1];
        const conversation = await this.requireOwnedConversation(conversationId, principal);
        if (conversationMatch[2] === undefined && request.method === 'GET') {
          this.consumeReads(principal, response);
          writeJson(response, 200, { conversation: toConversationDto(conversation) });
          return;
        }
        if (conversationMatch[2] === '/messages' && request.method === 'GET') {
          this.consumeReads(principal, response);
          const limit = clampInteger(url.searchParams.get('limit'), 1, this.deps.config.historyLimitMax, 30);
          await this.handleHistory(response, principal, conversation, limit);
          return;
        }
        if (conversationMatch[2] === '/messages' && request.method === 'POST') {
          this.consumeMessage(principal, conversationId, response);
          const body = await readJsonBody(request, this.deps.config.maxBodyBytes);
          await this.handleSendMessage(response, principal, conversation, body);
          return;
        }
        throw new CrmGatewayError('CRM_METHOD_NOT_ALLOWED', '该端点不支持此请求方法。', 405);
      }

      const runMatch = new RegExp(`^${escapeRegExp(base)}/runs/([0-9a-f-]{36})/(events|stop)$`, 'u').exec(path);
      if (runMatch?.[1] && runMatch[2]) {
        const runId = runMatch[1];
        const run = await this.requireOwnedRun(runId, principal);
        if (runMatch[2] === 'events' && request.method === 'GET') {
          this.consumeReads(principal, response);
          const after = clampInteger(url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER, 0);
          this.handleRunEvents(response, run, after);
          return;
        }
        if (runMatch[2] === 'stop' && request.method === 'POST') {
          await this.handleStopRun(response, run);
          return;
        }
        throw new CrmGatewayError('CRM_METHOD_NOT_ALLOWED', '该端点不支持此请求方法。', 405);
      }

      throw new CrmGatewayError('CRM_NOT_FOUND', '请求的 CRM 聊天端点不存在。', 404);
    } catch (error) {
      this.writeError(response, error, correlationId);
    }
  }

  private async handleReady(response: ServerResponse): Promise<void> {
    const checks = this.deps.health ? await this.deps.health().catch(() => ({ database: 'DOWN', openclaw: 'DOWN' })) : {};
    const down = Object.values(checks).some((value) => value !== 'UP');
    writeJson(response, down ? 503 : 200, {
      status: down ? 'DOWN' : 'UP',
      checks,
    });
  }

  private async handleExchange(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const ip = this.clientIp(request);
    this.consume(this.exchangeByIp, ip, response);
    const body = await readJsonBody(request, this.deps.config.maxBodyBytes);
    const bootstrapToken = readRequiredString(body, 'bootstrapToken', 1, 8192);
    const claims = this.deps.apexVerifier.verify(bootstrapToken);
    this.consume(this.exchangeBySubject, `${claims.orgId}:${claims.userId}`, response);

    // 一次性兑换先落库：重复 token 在数据库主键上被拒绝，进程重启也不会让它复活。
    const now = new Date(this.nowMs());
    const consumed = await this.deps.repository.consumeBootstrapNonce({
      jti: claims.jti,
      salesforceOrgId: claims.orgId,
      salesforceUserId: claims.userId,
      issuedAt: claims.issuedAt,
      expiresAt: new Date(now.getTime() + this.deps.config.bootstrapNonceRetentionMs),
    });
    if (!consumed) {
      throw new CrmGatewayError('CRM_BOOTSTRAP_REPLAYED', '身份引导凭证已被使用，请刷新页面后重试。', 409);
    }

    const binding = await this.deps.repository.findBinding(claims.orgId, claims.userId);
    if (!binding || !binding.enabled) {
      throw new CrmGatewayError(
        'CRM_IDENTITY_NOT_BOUND',
        '当前 Salesforce 用户尚未绑定 CRM 聊天身份，请联系管理员完成绑定。',
        403,
      );
    }
    const route = await this.deps.repository.findIdentityRoute(binding.platformUserId);
    if (!route || !route.enabled) {
      throw new CrmGatewayError(
        'CRM_IDENTITY_ROUTE_UNAVAILABLE',
        'CRM 聊天身份对应的 Salesforce 执行账号未启用，请联系管理员。',
        403,
      );
    }
    if (normalizeUsername(route.salesforceUsername) !== normalizeUsername(claims.username)) {
      throw new CrmGatewayError(
        'CRM_IDENTITY_BINDING_MISMATCH',
        'CRM 聊天身份绑定的 Salesforce 账号与当前登录用户不一致，请联系管理员核对。',
        403,
      );
    }

    const issued = await this.deps.chatSessions.issue({
      salesforceOrgId: claims.orgId,
      salesforceUserId: claims.userId,
      platformUserId: binding.platformUserId,
      displayName: claims.displayName || binding.displayName || claims.username,
      salesforceUsername: route.salesforceUsername,
    });
    this.deps.logger?.info({
      event: 'crm_auth_exchange',
      result: 'PASS',
      orgId: claims.orgId,
      platformUserId: binding.platformUserId,
      sessionId: issued.sessionId,
    });
    writeJson(response, 200, {
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      user: {
        displayName: claims.displayName || binding.displayName || claims.username,
        platformUserId: binding.platformUserId,
        salesforceUsername: route.salesforceUsername,
        orgId: claims.orgId,
      },
    });
  }

  private async requirePrincipal(request: IncomingMessage): Promise<Principal> {
    const authorization = readSingleHeader(request, 'authorization');
    const token = authorization === undefined
      ? undefined
      : /^Bearer\s+([^\s]+)$/iu.exec(authorization.trim())?.[1];
    const session = await this.deps.chatSessions.authenticate(token);
    return Object.freeze({
      session,
      orgId: session.salesforceOrgId,
      userId: session.salesforceUserId,
      platformUserId: session.platformUserId,
      displayName: session.displayName ?? session.salesforceUsername ?? session.platformUserId,
      salesforceUsername: session.salesforceUsername,
    });
  }

  private async requireOwnedConversation(conversationId: string, principal: Principal): Promise<CrmConversationRecord> {
    const conversation = await this.deps.repository.getConversationForOwner(conversationId, principal.orgId, principal.userId);
    if (!conversation) {
      // 不区分“不存在”和“属于别人”，避免成为跨用户存在性探测。
      throw new CrmGatewayError('CRM_CONVERSATION_NOT_FOUND', '对话不存在或不属于当前用户。', 404);
    }
    return conversation;
  }

  private async requireOwnedRun(runId: string, principal: Principal): Promise<CrmRunRecord> {
    const run = await this.deps.repository.getRun(runId);
    if (!run) throw new CrmGatewayError('CRM_RUN_NOT_FOUND', '运行记录不存在。', 404);
    const conversation = await this.deps.repository.getConversationForOwner(run.conversationId, principal.orgId, principal.userId);
    if (!conversation) throw new CrmGatewayError('CRM_RUN_NOT_FOUND', '运行记录不存在。', 404);
    return run;
  }

  private async handleHistory(
    response: ServerResponse,
    _principal: Principal,
    conversation: CrmConversationRecord,
    limit: number,
  ): Promise<void> {
    if (conversation.openclawSessionKey === null) {
      writeJson(response, 200, { messages: [], hasMore: false });
      return;
    }
    const history = await this.deps.openclaw.history({
      sessionKey: conversation.openclawSessionKey,
      limit,
    });
    writeJson(response, 200, history);
  }

  private async handleSendMessage(
    response: ServerResponse,
    principal: Principal,
    conversation: CrmConversationRecord,
    body: unknown,
  ): Promise<void> {
    const clientMessageId = readRequiredString(body, 'clientMessageId', 8, 128);
    if (!/^[A-Za-z0-9._:-]+$/u.test(clientMessageId)) {
      throw new CrmGatewayError('CRM_REQUEST_INVALID', 'clientMessageId 格式无效。', 400);
    }
    const text = normalizeUserText(readRequiredString(body, 'text', 1, this.deps.config.maxMessageChars));
    const recordContext = readRecordContext(body);

    const existing = await this.deps.repository.getRunByClientMessage(conversation.id, clientMessageId);
    if (existing) {
      throw new CrmGatewayError('CRM_DUPLICATE_MESSAGE', '这条消息已经提交过，不会再次执行。请打开原运行查看结果。', 409, {
        cause: Object.assign(new Error('duplicate'), { runId: existing.id, status: existing.status }),
      });
    }
    const active = await this.deps.repository.getActiveRun(conversation.id);
    if (active) {
      throw new CrmGatewayError('CRM_CONVERSATION_BUSY', '该对话正在回答中，请等待或先停止当前回答。', 409, {
        cause: Object.assign(new Error('busy'), { runId: active.id, status: active.status }),
      });
    }

    // 先解析官方会话路由，再创建运行。路由失败时不留一条“已开始”的假运行。
    const session = await this.deps.openclaw.resolveSession(conversation.id);
    const runId = randomUUID();
    const now = new Date(this.nowMs());
    const requestSha256 = hashRequest(text);
    const run = await this.deps.repository.createRun({
      id: runId,
      conversationId: conversation.id,
      clientMessageId,
      requestSha256,
      textLength: text.length,
      now,
    });
    if (!run) {
      throw new CrmGatewayError('CRM_DUPLICATE_MESSAGE', '这条消息已经提交过，不会再次执行。', 409);
    }
    await this.deps.repository.updateConversationSession(conversation.id, session.sessionKey, session.agentId);
    await this.deps.repository.touchConversation(conversation.id, now);
    if (conversation.title === null || conversation.title.trim().length === 0) {
      await this.deps.repository.updateConversationTitle(conversation.id, titleFromText(text));
    }

    const stream = new RunStream();
    this.runStreams.set(runId, stream);
    const cleanup = setTimeout(() => { this.runStreams.delete(runId); }, RUN_STREAM_RETENTION_MS);
    cleanup.unref?.();
    stream.publish('run.accepted', {
      runId,
      conversationId: conversation.id,
      sessionKey: session.sessionKey,
      agentId: session.agentId,
    });

    startSse(response);
    let unsubscribe = (): void => undefined;
    const subscription = stream.subscribe(0, (event) => {
      writeSseEvent(response, event);
      if (event.type === 'stream.end') {
        unsubscribe();
        if (!response.writableEnded) response.end();
      }
    });
    unsubscribe = subscription.unsubscribe;
    for (const event of subscription.replay) writeSseEvent(response, event);
    response.on('close', () => unsubscribe());

    const controller = new AbortController();
    this.activePumps.set(runId, controller);
    const pump = this.pumpRun({
      principal,
      conversation,
      runId,
      text,
      recordContext,
      stream,
      controller,
      cleanup,
    });
    this.pumpPromises.add(pump);
    void pump.finally(() => { this.pumpPromises.delete(pump); });
  }

  private async pumpRun(params: Readonly<{
    principal: Principal;
    conversation: CrmConversationRecord;
    runId: string;
    text: string;
    recordContext: Readonly<{ objectApiName: string; recordId: string }> | undefined;
    stream: RunStream;
    controller: AbortController;
    cleanup: NodeJS.Timeout;
  }>): Promise<void> {
    let terminal = false;
    try {
      await this.deps.openclaw.turn({
        platformUserId: params.principal.platformUserId,
        conversationId: params.conversation.id,
        runId: params.runId,
        message: params.text,
        ...(params.recordContext ? { recordContext: params.recordContext } : {}),
      }, async (event) => {
        const safe = sanitizeEvent(event, params.runId);
        if (!safe) return;
        params.stream.publish(safe.type, safe.data);
        try {
          if (safe.type === 'run.started') {
            const sessionKey = readStringField(safe.data, 'sessionKey');
            const agentId = readStringField(safe.data, 'agentId') ?? null;
            await this.deps.repository.updateRunStatus(params.runId, 'RUNNING', {
              now: new Date(this.nowMs()),
              ...(sessionKey ? { sessionKey } : {}),
              terminal: false,
            });
            if (sessionKey) {
              // The pre-dispatch update can fail without stopping the turn; the
              // official route echoed by the plugin is the authoritative key.
              await this.deps.repository.updateConversationSession(params.conversation.id, sessionKey, agentId);
            }
          } else if (safe.type === 'run.completed') {
            terminal = true;
            await this.deps.repository.updateRunStatus(params.runId, 'COMPLETED', {
              now: new Date(this.nowMs()),
              terminal: true,
            });
            await this.deps.repository.touchConversation(params.conversation.id, new Date(this.nowMs()));
          } else if (safe.type === 'run.stopped') {
            terminal = true;
            await this.deps.repository.updateRunStatus(params.runId, 'STOPPED', {
              now: new Date(this.nowMs()),
              terminal: true,
            });
          } else if (safe.type === 'run.failed') {
            terminal = true;
            const errorCode = readStringField(safe.data, 'errorCode') ?? 'CRM_TURN_FAILED';
            const status = errorCode === 'CRM_TURN_TIMEOUT' ? 'UNKNOWN' : 'FAILED';
            await this.deps.repository.updateRunStatus(params.runId, status, {
              now: new Date(this.nowMs()),
              errorCode: status === 'UNKNOWN' ? 'CRM_RUN_RESULT_UNKNOWN' : errorCode,
              errorMessageSafe: readStringField(safe.data, 'message') ?? '回答生成失败。',
              terminal: true,
            });
          }
        } catch (error) {
          // 审计/状态落库失败不能改变已经产生的回答；记录后继续把流送完。
          this.deps.logger?.warn({
            event: 'crm_run_status_persist_failed',
            runId: params.runId,
            code: isCrmGatewayError(error) ? error.code : 'CRM_STATUS_PERSIST_FAILED',
          });
        }
      }, params.controller.signal);

      if (!terminal) {
        terminal = true;
        params.stream.publish('run.failed', {
          runId: params.runId,
          status: 'UNKNOWN',
          errorCode: 'CRM_RUN_RESULT_UNKNOWN',
          message: '回答在完成前中断，结果未知。请查看历史消息确认；不要直接重复提交。',
        });
        await this.deps.repository.updateRunStatus(params.runId, 'UNKNOWN', {
          now: new Date(this.nowMs()),
          errorCode: 'CRM_RUN_RESULT_UNKNOWN',
          errorMessageSafe: '回答在完成前中断；结果未知，不会自动重试。',
          terminal: true,
        }).catch(() => false);
      }
    } catch (error) {
      const mapped = mapPumpFailure(error, params.controller.signal);
      params.stream.publish('run.failed', {
        runId: params.runId,
        status: mapped.status,
        errorCode: mapped.code,
        message: mapped.message,
      });
      await this.deps.repository.updateRunStatus(params.runId, mapped.status, {
        now: new Date(this.nowMs()),
        errorCode: mapped.code,
        errorMessageSafe: mapped.message,
        terminal: true,
      }).catch(() => false);
    } finally {
      this.activePumps.delete(params.runId);
      params.stream.publish('stream.end', { runId: params.runId });
      params.stream.close();
      clearTimeout(params.cleanup);
      const keep = setTimeout(() => { this.runStreams.delete(params.runId); }, RUN_STREAM_RETENTION_MS);
      keep.unref?.();
    }
  }

  private handleRunEvents(response: ServerResponse, run: CrmRunRecord, afterSeq: number): void {
    const stream = this.runStreams.get(run.id);
    startSse(response);
    if (!stream) {
      if (isTerminal(run.status)) {
        writeSseEvent(response, {
          type: 'run.snapshot',
          data: {
            runId: run.id,
            status: run.status,
            ...(run.errorCode ? { errorCode: run.errorCode } : {}),
            ...(run.errorMessageSafe ? { message: run.errorMessageSafe } : {}),
          },
        });
      } else {
        // 接入服务重启后丢失了原流；不假装还能续上，也不自动重跑。
        writeSseEvent(response, {
          type: 'run.failed',
          data: {
            runId: run.id,
            status: 'UNKNOWN',
            errorCode: 'CRM_RUN_RESULT_UNKNOWN',
            message: '接入服务已重启，原运行状态未知。请查看历史消息确认；不要直接重复提交。',
          },
        });
      }
      writeSseEvent(response, { type: 'stream.end', data: { runId: run.id } });
      response.end();
      return;
    }
    let ended = false;
    let unsubscribe = (): void => undefined;
    const subscription = stream.subscribe(afterSeq, (event) => {
      writeSseEvent(response, event);
      if (event.type === 'stream.end') {
        ended = true;
        unsubscribe();
        if (!response.writableEnded) response.end();
      }
    });
    unsubscribe = subscription.unsubscribe;
    for (const event of subscription.replay) writeSseEvent(response, event);
    if (stream.isClosed && !ended) {
      writeSseEvent(response, { type: 'stream.end', data: { runId: run.id } });
      unsubscribe();
      if (!response.writableEnded) response.end();
      return;
    }
    response.on('close', () => unsubscribe());
  }

  private async handleStopRun(response: ServerResponse, run: CrmRunRecord): Promise<void> {
    if (isTerminal(run.status)) {
      writeJson(response, 200, { stopped: false, status: run.status });
      return;
    }
    const result = await this.deps.openclaw.abort({ conversationId: run.conversationId, runId: run.id });
    if (result.aborted) {
      writeJson(response, 200, { stopped: true, status: 'STOPPED' });
      return;
    }
    const current = await this.deps.repository.getRun(run.id);
    writeJson(response, 200, { stopped: false, status: current?.status ?? run.status });
  }

  private consume(
    limiter: SlidingWindowRateLimiter,
    key: string,
    response: ServerResponse,
  ): void {
    const result = limiter.consume(key);
    if (result.allowed) return;
    response.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
    throw new CrmGatewayError('CRM_RATE_LIMITED', '请求过于频繁，请稍后再试。', 429);
  }

  private consumeReads(principal: Principal, response: ServerResponse): void {
    this.consume(this.readsBySubject, `${principal.orgId}:${principal.userId}`, response);
  }

  private consumeMessage(principal: Principal, conversationId: string, response: ServerResponse): void {
    this.consume(this.messagesBySubject, `${principal.orgId}:${principal.userId}`, response);
    this.consume(this.messagesByConversation, conversationId, response);
  }

  private clientIp(request: IncomingMessage): string {
    if (this.deps.config.trustProxy) {
      const forwarded = readSingleHeader(request, 'x-forwarded-for');
      const first = forwarded?.split(',')[0]?.trim();
      if (first) return first;
    }
    return request.socket.remoteAddress ?? 'unknown';
  }

  private writeError(response: ServerResponse, error: unknown, correlationId: string): void {
    const mapped = toCrmGatewayError(error);
    this.deps.logger?.warn({
      event: 'crm_gateway_error',
      correlationId,
      code: mapped.code,
      status: mapped.status,
    });
    if (response.headersSent) {
      if (!response.writableEnded) {
        writeSseEvent(response, {
          type: 'run.failed',
          data: {
            runId: '',
            status: 'FAILED',
            errorCode: mapped.code,
            message: mapped.safeMessage,
          },
        });
        response.end();
      }
      return;
    }
    const cause = mapped.cause as { runId?: unknown; status?: unknown } | undefined;
    writeJson(response, mapped.status, {
      errorCode: mapped.code,
      message: mapped.safeMessage,
      correlationId,
      ...(typeof cause?.runId === 'string' ? { runId: cause.runId } : {}),
      ...(typeof cause?.status === 'string' ? { status: cause.status } : {}),
    });
  }
}

function toConversationDto(conversation: CrmConversationRecord): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: conversation.id,
    title: conversation.title ?? '新对话',
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    hasSession: conversation.openclawSessionKey !== null,
  });
}

function isTerminal(status: CrmRunRecord['status']): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'STOPPED' || status === 'UNKNOWN';
}

function sanitizeEvent(event: OpenClawEvent, fallbackRunId: string): Readonly<{ type: string; data: Record<string, unknown> }> | undefined {
  const allowed = new Set([
    'run.started',
    'message.delta',
    'message.replace',
    'message.final',
    'run.completed',
    'run.stopped',
    'run.failed',
    'heartbeat',
  ]);
  if (!allowed.has(event.type)) return undefined;
  const source = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
  const data: Record<string, unknown> = { runId: typeof source.runId === 'string' ? source.runId : fallbackRunId };
  for (const key of ['text', 'status', 'errorCode', 'message', 'sessionKey', 'agentId', 'durationMs', 'ts']) {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'number') data[key] = value;
  }
  if (event.type === 'run.failed' || event.type === 'run.stopped') {
    data.status = event.type === 'run.stopped' ? 'STOPPED' : 'FAILED';
  }
  return Object.freeze({ type: event.type, data });
}

function readStringField(data: unknown, field: string): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const value = (data as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function mapPumpFailure(error: unknown, signal: AbortSignal): Readonly<{ status: CrmRunRecord['status']; code: string; message: string }> {
  if (signal.aborted) {
    // 只有服务关闭会主动 abort 本地流（用户“停止”走的是 OpenClaw abort 接口）。
    // 服务关闭时原运行可能仍在 Gateway 侧继续，因此结果是未知而不是“已停止”。
    return {
      status: 'UNKNOWN',
      code: 'CRM_RUN_RESULT_UNKNOWN',
      message: 'CRM 服务在处理回答时中断，结果未知。请查看历史消息确认；不要直接重复提交。',
    };
  }
  if (isCrmGatewayError(error)) {
    if (error.code === 'CRM_OPENCLAW_TIMEOUT' || error.code === 'CRM_OPENCLAW_UNAVAILABLE' || error.code === 'CRM_OPENCLAW_PROTOCOL_ERROR') {
      return {
        status: 'UNKNOWN',
        code: 'CRM_RUN_RESULT_UNKNOWN',
        message: '回答结果未知。请先查看历史消息确认是否已有结果，不要直接重复提交。',
      };
    }
    if (error.code === 'CRM_RUN_CANCELLED') {
      return { status: 'STOPPED', code: 'CRM_TURN_STOPPED', message: '本次回答已停止。' };
    }
    return { status: 'FAILED', code: error.code, message: error.safeMessage };
  }
  return {
    status: 'UNKNOWN',
    code: 'CRM_RUN_RESULT_UNKNOWN',
    message: '回答结果未知。请先查看历史消息确认是否已有结果，不要直接重复提交。',
  };
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function startSse(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-store');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();
}

function writeSseEvent(response: ServerResponse, event: Readonly<{ type: string; data: unknown }>): void {
  if (response.writableEnded) return;
  response.write(encodeSseEvent(event.type, event.data));
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
  allowEmpty = false,
): Promise<Record<string, unknown>> {
  const contentType = readSingleHeader(request, 'content-type');
  if (contentType !== undefined && !/^application\/(?:[A-Za-z0-9.+-]+\+)?json(?:\s*;.*)?$/iu.test(contentType.trim())) {
    throw new CrmGatewayError('CRM_CONTENT_TYPE_INVALID', '请求必须使用 application/json。', 415);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new CrmGatewayError('CRM_REQUEST_TOO_LARGE', '请求体超过允许大小。', 413);
    }
    chunks.push(buffer);
  }
  if (total === 0) {
    if (allowEmpty) return {};
    throw new CrmGatewayError('CRM_REQUEST_INVALID', '请求体不能为空。', 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new CrmGatewayError('CRM_REQUEST_INVALID', '请求体不是有效 JSON。', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CrmGatewayError('CRM_REQUEST_INVALID', '请求体必须是 JSON 对象。', 400);
  }
  return parsed as Record<string, unknown>;
}

function readSingleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 1) return value[0];
  return undefined;
}

function readRequiredString(body: unknown, field: string, min: number, max: number): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CrmGatewayError('CRM_REQUEST_INVALID', '请求体必须是 JSON 对象。', 400);
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string') throw new CrmGatewayError('CRM_REQUEST_INVALID', `${field} 必须是字符串。`, 400);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new CrmGatewayError('CRM_REQUEST_INVALID', `${field} 长度必须在 ${min}-${max} 之间。`, 400);
  }
  return trimmed;
}

function readOptionalTitle(body: unknown, field: string): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>)[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new CrmGatewayError('CRM_REQUEST_INVALID', 'title 必须是字符串。', 400);
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 100 || /[\u0000-\u001F\u007F]/u.test(trimmed)) {
    throw new CrmGatewayError('CRM_REQUEST_INVALID', 'title 最多 100 个字符且不能包含控制字符。', 400);
  }
  return trimmed;
}

function readRecordContext(body: unknown): Readonly<{ objectApiName: string; recordId: string }> | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>).recordContext;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new CrmGatewayError('CRM_RECORD_CONTEXT_INVALID', 'recordContext 必须是对象。', 400);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.objectApiName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(record.objectApiName)) {
    throw new CrmGatewayError('CRM_RECORD_CONTEXT_INVALID', 'recordContext.objectApiName 无效。', 400);
  }
  if (typeof record.recordId !== 'string' || !/^[A-Za-z0-9]{15,18}$/u.test(record.recordId)) {
    throw new CrmGatewayError('CRM_RECORD_CONTEXT_INVALID', 'recordContext.recordId 无效。', 400);
  }
  return Object.freeze({ objectApiName: record.objectApiName, recordId: record.recordId });
}

function normalizeUserText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new CrmGatewayError('CRM_MESSAGE_EMPTY', '消息不能为空。', 400);
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      throw new CrmGatewayError('CRM_MESSAGE_INVALID', '消息不能包含控制字符。', 400);
    }
  }
  return trimmed;
}

function titleFromText(text: string): string {
  const singleLine = text.replace(/\s+/gu, ' ').trim();
  return singleLine.length <= 30 ? singleLine : `${singleLine.slice(0, 30)}…`;
}

function normalizeUsername(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function hashRequest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function clampInteger(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
