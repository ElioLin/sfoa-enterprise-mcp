import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { CrmChatRepository, CrmChatSessionRecord } from '@sfoa/control-plane';
import { CrmGatewayError } from './errors.js';

/**
 * Browser 短期聊天凭证。
 *
 * 浏览器只在内存里持有原值；数据库只存 SHA-256。凭证与 Apex 引导凭证是两类
 * 不同的东西：引导凭证证明“这次是哪个 Salesforce 用户”，聊天凭证证明“这个
 * 浏览器会话已通过兑换”，并且有独立的短期有效期。
 *
 * Salesforce 退出登录不会即时撤销它；最大有效窗口就是 expiresAt（默认 15 分钟）。
 * 刷新页面必须重新走 Apex 签发 + 兑换。
 */

export type IssuedChatSession = Readonly<{
  token: string;
  sessionId: string;
  expiresAt: Date;
}>;

export class ChatSessionService {
  public constructor(
    private readonly repository: CrmChatRepository,
    private readonly options: Readonly<{ ttlMs: number; now?: () => number }>,
  ) {}

  public async issue(params: Readonly<{
    salesforceOrgId: string;
    salesforceUserId: string;
    platformUserId: string;
    displayName: string;
    salesforceUsername: string;
  }>): Promise<IssuedChatSession> {
    const token = randomBytes(32).toString('base64url');
    const now = new Date(this.nowMs());
    const expiresAt = new Date(now.getTime() + this.options.ttlMs);
    const sessionId = randomUUID();
    await this.repository.createChatSession({
      tokenHash: hashChatToken(token),
      id: sessionId,
      salesforceOrgId: params.salesforceOrgId,
      salesforceUserId: params.salesforceUserId,
      platformUserId: params.platformUserId,
      displayName: params.displayName,
      salesforceUsername: params.salesforceUsername,
      createdAt: now,
      expiresAt,
    });
    return Object.freeze({ token, sessionId, expiresAt });
  }

  public async authenticate(token: string | undefined): Promise<CrmChatSessionRecord> {
    if (typeof token !== 'string' || token.length < 32 || token.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(token)) {
      throw new CrmGatewayError('CRM_CHAT_TOKEN_REQUIRED', '请重新打开聊天入口以取得新的会话凭证。', 401);
    }
    const session = await this.repository.getChatSessionByHash(hashChatToken(token));
    if (!session) {
      throw new CrmGatewayError('CRM_CHAT_SESSION_INVALID', '聊天会话凭证无效，请刷新页面后重试。', 401);
    }
    if (session.revokedAt !== null) {
      throw new CrmGatewayError('CRM_CHAT_SESSION_REVOKED', '聊天会话已失效，请刷新页面后重试。', 401);
    }
    if (session.expiresAt.getTime() <= this.nowMs()) {
      throw new CrmGatewayError('CRM_CHAT_SESSION_EXPIRED', '聊天会话已过期，请刷新页面后重试。', 401);
    }
    // last_seen_at 是运维观测，不是授权条件；写失败不改变本次认证结论。
    void this.repository.touchChatSession(session.tokenHash, new Date(this.nowMs())).catch(() => undefined);
    return session;
  }

  private nowMs(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function hashChatToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * 有界滑动窗口限流。key 由调用方决定（IP 或已验证主体），不做全局共享身份。
 * 内存态、按进程；重启后重置是刻意接受的（它只是速率保护，不是授权）。
 */
export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly maxKeys: number;

  public constructor(
    private readonly options: Readonly<{ limit: number; windowMs: number; maxKeys?: number; now?: () => number }>,
  ) {
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  public consume(key: string): Readonly<{ allowed: boolean; retryAfterMs: number }> {
    const now = this.options.now?.() ?? Date.now();
    const cutoff = now - this.options.windowMs;
    let timestamps = this.buckets.get(key);
    if (timestamps === undefined) {
      if (this.buckets.size >= this.maxKeys) this.evictOldest(now);
      timestamps = [];
      this.buckets.set(key, timestamps);
    }
    while (timestamps.length > 0 && (timestamps[0] ?? 0) <= cutoff) timestamps.shift();
    if (timestamps.length >= this.options.limit) {
      const earliest = timestamps[0] ?? now;
      return Object.freeze({ allowed: false, retryAfterMs: Math.max(0, earliest + this.options.windowMs - now) });
    }
    timestamps.push(now);
    return Object.freeze({ allowed: true, retryAfterMs: 0 });
  }

  private evictOldest(now: number): void {
    const cutoff = now - this.options.windowMs;
    for (const [key, timestamps] of this.buckets) {
      if (timestamps.length === 0 || (timestamps.at(-1) ?? 0) <= cutoff) this.buckets.delete(key);
      if (this.buckets.size < this.maxKeys) return;
    }
    // 仍然超限时退化为删除最早插入的键；限流器不接受无界增长。
    const first = this.buckets.keys().next().value;
    if (first !== undefined) this.buckets.delete(first);
  }
}
