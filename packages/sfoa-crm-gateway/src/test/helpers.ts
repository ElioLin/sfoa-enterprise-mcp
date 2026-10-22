import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import type {
  ConsumeBootstrapNonceInput,
  CreateCrmChatSessionInput,
  CreateCrmConversationInput,
  CreateCrmRunInput,
  CrmChatRepository,
  CrmChatSessionRecord,
  CrmConversationRecord,
  CrmIdentityBindingRecord,
  CrmRunRecord,
  CrmRunStatus,
} from '@sfoa/control-plane';
import type { CrmGatewayConfig } from '../config.js';
import type { OpenClawCrmClientLike, OpenClawEvent, OpenClawHistoryResult, OpenClawResolvedSession } from '../openclaw-client.js';

export const TEST_ORG = '00D000000000001AAA';
export const TEST_USER_A = '005000000000001AAA';
export const TEST_USER_B = '005000000000002AAA';
export const TEST_USERNAME_A = 'candy.zheng@runner-corp.com.cn.uat';
export const TEST_USERNAME_B = 'cynthia.chen@ningborunner.com.uat';
export const TEST_PLATFORM_A = '61979';
export const TEST_PLATFORM_B = '33575';
export const TEST_ORIGIN = 'https://lightning.example.test';

export function testConfig(overrides: Partial<CrmGatewayConfig> = {}): CrmGatewayConfig {
  return Object.freeze({
    bindHost: '127.0.0.1',
    port: 0,
    basePath: '/crm',
    allowedOrigins: Object.freeze([TEST_ORIGIN]),
    trustProxy: false,
    database: Object.freeze({
      host: '127.0.0.1',
      port: 3306,
      database: 'sfoa_test',
      user: 'test',
      password: 'test',
      sslMode: 'disabled' as const,
      connectionLimit: 1,
      queueLimit: 1,
      connectTimeoutMs: 1_000,
    }),
    openclawBaseUrl: 'http://127.0.0.1:9/plugins/sfoa-crm',
    openclawServiceToken: 's'.repeat(32),
    gatewayHistoryToken: 'h'.repeat(32),
    apex: Object.freeze({
      publicKeyPath: 'unused',
      issuer: 'sfoa-crm-apex',
      audience: 'sfoa-crm-gateway',
      allowedOrgIds: Object.freeze([TEST_ORG]),
      maxAgeMs: 120_000,
      maxTtlMs: 120_000,
      clockSkewMs: 30_000,
    }),
    chatTokenTtlMs: 900_000,
    bootstrapNonceRetentionMs: 600_000,
    maxBodyBytes: 65_536,
    requestTimeoutMs: 660_000,
    maxMessageChars: 16_000,
    historyLimitMax: 100,
    conversationListLimit: 50,
    runStaleAfterMs: 900_000,
    cleanupIntervalMs: 300_000,
    ...overrides,
  });
}

export type SigningMaterial = Readonly<{
  privateKey: KeyObject;
  publicKey: KeyObject;
  signToken(overrides?: Partial<{
    orgId: string;
    userId: string;
    username: string;
    displayName: string;
    iat: number;
    exp: number;
    jti: string;
    iss: string;
    aud: string;
  }>): string;
}>;

export function createSigningMaterial(nowMs = Date.now()): SigningMaterial {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return Object.freeze({
    privateKey,
    publicKey,
    signToken(overrides = {}) {
      const iat = overrides.iat ?? Math.floor(nowMs / 1000);
      const exp = overrides.exp ?? iat + 90;
      const payload = {
        iss: overrides.iss ?? 'sfoa-crm-apex',
        aud: overrides.aud ?? 'sfoa-crm-gateway',
        orgId: overrides.orgId ?? TEST_ORG,
        userId: overrides.userId ?? TEST_USER_A,
        username: overrides.username ?? TEST_USERNAME_A,
        displayName: overrides.displayName ?? 'Candy Zheng',
        iat,
        exp,
        jti: overrides.jti ?? randomUUID(),
      };
      const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      const signature = sign('RSA-SHA256', Buffer.from(`v1.${encoded}`, 'utf8'), privateKey).toString('base64url');
      return `v1.${encoded}.${signature}`;
    },
  });
}

export class FakeCrmRepository implements CrmChatRepository {
  public readonly bindings = new Map<string, CrmIdentityBindingRecord>();
  public readonly routes = new Map<string, Readonly<{ platformUserId: string; salesforceUsername: string; enabled: boolean }>>();
  public readonly nonces = new Set<string>();
  public readonly chatSessions = new Map<string, CrmChatSessionRecord>();
  public readonly conversations = new Map<string, CrmConversationRecord>();
  public readonly runs = new Map<string, CrmRunRecord>();

  public seedBinding(orgId: string, userId: string, platformUserId: string, username: string): void {
    this.bindings.set(`${orgId}:${userId}`, Object.freeze({
      id: this.bindings.size + 1,
      salesforceOrgId: orgId,
      salesforceUserId: userId,
      platformUserId,
      displayName: null,
      enabled: true,
    }));
    this.routes.set(platformUserId, Object.freeze({
      platformUserId,
      salesforceUsername: username,
      enabled: true,
    }));
  }

  public async findBinding(orgId: string, userId: string): Promise<CrmIdentityBindingRecord | undefined> {
    return this.bindings.get(`${orgId}:${userId}`);
  }

  public async listBindings(limit: number): Promise<readonly CrmIdentityBindingRecord[]> {
    return Object.freeze([...this.bindings.values()].slice(0, limit));
  }

  public async upsertBinding(input: Readonly<{
    salesforceOrgId: string;
    salesforceUserId: string;
    platformUserId: string;
    displayName: string | null;
    enabled: boolean;
  }>): Promise<CrmIdentityBindingRecord> {
    const key = `${input.salesforceOrgId}:${input.salesforceUserId}`;
    const existing = this.bindings.get(key);
    const binding: CrmIdentityBindingRecord = Object.freeze({
      id: existing?.id ?? this.bindings.size + 1,
      salesforceOrgId: input.salesforceOrgId,
      salesforceUserId: input.salesforceUserId,
      platformUserId: input.platformUserId,
      displayName: input.displayName,
      enabled: input.enabled,
    });
    this.bindings.set(key, binding);
    return binding;
  }

  public async findIdentityRoute(platformUserId: string) {
    return this.routes.get(platformUserId);
  }

  public async consumeBootstrapNonce(input: ConsumeBootstrapNonceInput): Promise<boolean> {
    if (this.nonces.has(input.jti)) return false;
    this.nonces.add(input.jti);
    return true;
  }

  public async createChatSession(input: CreateCrmChatSessionInput): Promise<void> {
    this.chatSessions.set(input.tokenHash, Object.freeze({
      tokenHash: input.tokenHash,
      id: input.id,
      salesforceOrgId: input.salesforceOrgId,
      salesforceUserId: input.salesforceUserId,
      platformUserId: input.platformUserId,
      displayName: input.displayName,
      salesforceUsername: input.salesforceUsername,
      createdAt: input.createdAt,
      lastSeenAt: input.createdAt,
      expiresAt: input.expiresAt,
      revokedAt: null,
    }));
  }

  public async getChatSessionByHash(tokenHash: string): Promise<CrmChatSessionRecord | undefined> {
    return this.chatSessions.get(tokenHash);
  }

  public async touchChatSession(tokenHash: string, at: Date): Promise<void> {
    const current = this.chatSessions.get(tokenHash);
    if (current) this.chatSessions.set(tokenHash, Object.freeze({ ...current, lastSeenAt: at }));
  }

  public async revokeChatSession(tokenHash: string, at: Date): Promise<void> {
    const current = this.chatSessions.get(tokenHash);
    if (current) this.chatSessions.set(tokenHash, Object.freeze({ ...current, revokedAt: at }));
  }

  public async createConversation(input: CreateCrmConversationInput): Promise<CrmConversationRecord> {
    const conversation: CrmConversationRecord = Object.freeze({
      id: input.id,
      salesforceOrgId: input.salesforceOrgId,
      salesforceUserId: input.salesforceUserId,
      platformUserId: input.platformUserId,
      title: input.title,
      openclawSessionKey: null,
      openclawAgentId: null,
      createdAt: input.now,
      updatedAt: input.now,
      lastMessageAt: null,
    });
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  public async getConversation(id: string): Promise<CrmConversationRecord | undefined> {
    return this.conversations.get(id);
  }

  public async getConversationForOwner(id: string, orgId: string, userId: string): Promise<CrmConversationRecord | undefined> {
    const conversation = this.conversations.get(id);
    return conversation?.salesforceOrgId === orgId && conversation.salesforceUserId === userId ? conversation : undefined;
  }

  public async listConversations(orgId: string, userId: string, limit: number): Promise<readonly CrmConversationRecord[]> {
    return Object.freeze([...this.conversations.values()]
      .filter((conversation) => conversation.salesforceOrgId === orgId && conversation.salesforceUserId === userId)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
      .slice(0, limit));
  }

  public async updateConversationSession(id: string, sessionKey: string, agentId: string | null): Promise<void> {
    const current = this.conversations.get(id);
    if (current) this.conversations.set(id, Object.freeze({ ...current, openclawSessionKey: sessionKey, openclawAgentId: agentId }));
  }

  public async touchConversation(id: string, at: Date): Promise<void> {
    const current = this.conversations.get(id);
    if (current) this.conversations.set(id, Object.freeze({ ...current, lastMessageAt: at, updatedAt: at }));
  }

  public async updateConversationTitle(id: string, title: string): Promise<void> {
    const current = this.conversations.get(id);
    if (current) this.conversations.set(id, Object.freeze({ ...current, title }));
  }

  public async createRun(input: CreateCrmRunInput): Promise<CrmRunRecord | undefined> {
    for (const run of this.runs.values()) {
      if (run.conversationId === input.conversationId && run.clientMessageId === input.clientMessageId) return undefined;
    }
    const run: CrmRunRecord = Object.freeze({
      id: input.id,
      conversationId: input.conversationId,
      clientMessageId: input.clientMessageId,
      status: 'STARTED' as CrmRunStatus,
      openclawSessionKey: null,
      requestSha256: input.requestSha256,
      textLength: input.textLength,
      errorCode: null,
      errorMessageSafe: null,
      startedAt: input.now,
      completedAt: null,
      updatedAt: input.now,
    });
    this.runs.set(run.id, run);
    return run;
  }

  public async getRun(id: string): Promise<CrmRunRecord | undefined> {
    return this.runs.get(id);
  }

  public async getRunByClientMessage(conversationId: string, clientMessageId: string): Promise<CrmRunRecord | undefined> {
    return [...this.runs.values()].find(
      (run) => run.conversationId === conversationId && run.clientMessageId === clientMessageId,
    );
  }

  public async getActiveRun(conversationId: string): Promise<CrmRunRecord | undefined> {
    return [...this.runs.values()].find(
      (run) => run.conversationId === conversationId && (run.status === 'STARTED' || run.status === 'RUNNING'),
    );
  }

  public async updateRunStatus(
    id: string,
    status: CrmRunStatus,
    fields: Readonly<{ now: Date; sessionKey?: string; errorCode?: string; errorMessageSafe?: string; terminal: boolean }>,
  ): Promise<boolean> {
    const current = this.runs.get(id);
    if (!current || (current.status !== 'STARTED' && current.status !== 'RUNNING')) return false;
    this.runs.set(id, Object.freeze({
      ...current,
      status,
      ...(fields.sessionKey ? { openclawSessionKey: fields.sessionKey } : {}),
      ...(fields.errorCode ? { errorCode: fields.errorCode } : {}),
      ...(fields.errorMessageSafe ? { errorMessageSafe: fields.errorMessageSafe } : {}),
      ...(fields.terminal ? { completedAt: fields.now } : {}),
      updatedAt: fields.now,
    }));
    return true;
  }

  public async markStaleRunsUnknown(olderThan: Date, now: Date): Promise<number> {
    let count = 0;
    for (const [id, run] of this.runs) {
      if ((run.status === 'STARTED' || run.status === 'RUNNING') && run.updatedAt < olderThan) {
        this.runs.set(id, Object.freeze({
          ...run,
          status: 'UNKNOWN',
          errorCode: 'CRM_RUN_RESULT_UNKNOWN',
          completedAt: now,
          updatedAt: now,
        }));
        count += 1;
      }
    }
    return count;
  }

  public async deleteExpiredArtifacts(now: Date): Promise<Readonly<{ nonces: number; sessions: number }>> {
    return Object.freeze({ nonces: 0, sessions: [...this.chatSessions.values()].filter((s) => s.expiresAt < now).length });
  }
}

export class FakeOpenClaw implements OpenClawCrmClientLike {
  public readonly turns: unknown[] = [];
  public readonly aborts: Array<Readonly<{ conversationId: string; runId: string }>> = [];
  public turnImpl: (body: any, onEvent: (event: OpenClawEvent) => void | Promise<void>, signal?: AbortSignal) => Promise<void>;

  public constructor(options: Readonly<{ history?: OpenClawHistoryResult; abortResult?: Readonly<{ aborted: boolean; reason?: string }> }> = {}) {
    this.historyResult = options.history ?? { messages: [], hasMore: false };
    this.abortResult = options.abortResult ?? { aborted: true, reason: 'ABORTED' };
    this.turnImpl = async (body, onEvent) => {
      const sessionKey = `agent:main:sfoa-crm:${body.conversationId}`;
      await onEvent({ type: 'run.started', data: { runId: body.runId, sessionKey, agentId: 'main' } });
      await onEvent({ type: 'message.delta', data: { text: '你' } });
      await onEvent({ type: 'message.delta', data: { text: '好' } });
      await onEvent({ type: 'message.final', data: { text: '你好' } });
      await onEvent({ type: 'run.completed', data: { runId: body.runId, status: 'COMPLETED' } });
    };
  }

  private readonly historyResult: OpenClawHistoryResult;
  private readonly abortResult: Readonly<{ aborted: boolean; reason?: string }>;

  public async turn(body: unknown, onEvent: (event: OpenClawEvent) => void | Promise<void>, signal?: AbortSignal): Promise<void> {
    this.turns.push(body);
    await this.turnImpl(body, onEvent, signal);
  }

  public async abort(body: Readonly<{ conversationId: string; runId: string }>) {
    this.aborts.push(body);
    return this.abortResult;
  }

  public async history(): Promise<OpenClawHistoryResult> {
    return this.historyResult;
  }

  public async resolveSession(conversationId: string): Promise<OpenClawResolvedSession> {
    return Object.freeze({
      conversationId,
      sessionKey: `agent:main:sfoa-crm:${conversationId}`,
      agentId: 'main',
      accountId: 'default',
    });
  }

  public async health(): Promise<Readonly<{ ok: boolean; channel: string }>> {
    return Object.freeze({ ok: true, channel: 'sfoa-crm' });
  }
}
