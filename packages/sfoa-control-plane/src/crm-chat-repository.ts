import { sql } from 'kysely';
import type { Selectable } from 'kysely';
import type { ControlPlaneDatabaseClient } from './database.js';
import type {
  CrmBootstrapNonceTable,
  CrmChatSessionTable,
  CrmConversationTable,
  CrmIdentityBindingTable,
  CrmRunTable,
} from './schema.js';

/**
 * CRM 内嵌聊天的持久化边界。
 *
 * 只保存归属、映射、运行状态和一次性兑换记录；聊天正文仍由 OpenClaw 的会话
 * 存储持有，这里刻意不复制第二套完整聊天数据库。
 */

export type CrmIdentityBindingRecord = Readonly<{
  id: number;
  salesforceOrgId: string;
  salesforceUserId: string;
  platformUserId: string;
  displayName: string | null;
  enabled: boolean;
}>;

export type CrmConversationRecord = Readonly<{
  id: string;
  salesforceOrgId: string;
  salesforceUserId: string;
  platformUserId: string;
  title: string | null;
  openclawSessionKey: string | null;
  openclawAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date | null;
}>;

export type CrmRunStatus = 'STARTED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'STOPPED' | 'UNKNOWN';

export type CrmRunRecord = Readonly<{
  id: string;
  conversationId: string;
  clientMessageId: string;
  status: CrmRunStatus;
  openclawSessionKey: string | null;
  requestSha256: string;
  textLength: number;
  errorCode: string | null;
  errorMessageSafe: string | null;
  startedAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
}>;

export type CrmChatSessionRecord = Readonly<{
  tokenHash: string;
  id: string;
  salesforceOrgId: string;
  salesforceUserId: string;
  platformUserId: string;
  displayName: string | null;
  salesforceUsername: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}>;

export type CreateCrmConversationInput = Readonly<{
  id: string;
  salesforceOrgId: string;
  salesforceUserId: string;
  platformUserId: string;
  title: string | null;
  now: Date;
}>;

export type CreateCrmRunInput = Readonly<{
  id: string;
  conversationId: string;
  clientMessageId: string;
  requestSha256: string;
  textLength: number;
  now: Date;
}>;

export type CreateCrmChatSessionInput = Readonly<{
  tokenHash: string;
  id: string;
  salesforceOrgId: string;
  salesforceUserId: string;
  platformUserId: string;
  displayName: string | null;
  salesforceUsername: string | null;
  createdAt: Date;
  expiresAt: Date;
}>;

export type ConsumeBootstrapNonceInput = Readonly<{
  jti: string;
  salesforceOrgId: string;
  salesforceUserId: string;
  issuedAt: Date;
  expiresAt: Date;
}>;

export type UpsertCrmIdentityBindingInput = Readonly<{
  salesforceOrgId: string;
  salesforceUserId: string;
  platformUserId: string;
  displayName: string | null;
  enabled: boolean;
}>;

export interface CrmChatRepository {
  findBinding(salesforceOrgId: string, salesforceUserId: string): Promise<CrmIdentityBindingRecord | undefined>;
  listBindings(limit: number): Promise<readonly CrmIdentityBindingRecord[]>;
  upsertBinding(input: UpsertCrmIdentityBindingInput): Promise<CrmIdentityBindingRecord>;
  findIdentityRoute(platformUserId: string): Promise<
    Readonly<{ platformUserId: string; salesforceUsername: string; enabled: boolean }> | undefined
  >;
  consumeBootstrapNonce(input: ConsumeBootstrapNonceInput): Promise<boolean>;
  createChatSession(input: CreateCrmChatSessionInput): Promise<void>;
  getChatSessionByHash(tokenHash: string): Promise<CrmChatSessionRecord | undefined>;
  touchChatSession(tokenHash: string, at: Date): Promise<void>;
  revokeChatSession(tokenHash: string, at: Date): Promise<void>;
  createConversation(input: CreateCrmConversationInput): Promise<CrmConversationRecord>;
  getConversation(id: string): Promise<CrmConversationRecord | undefined>;
  getConversationForOwner(id: string, salesforceOrgId: string, salesforceUserId: string): Promise<CrmConversationRecord | undefined>;
  listConversations(
    salesforceOrgId: string,
    salesforceUserId: string,
    limit: number,
  ): Promise<readonly CrmConversationRecord[]>;
  updateConversationSession(id: string, sessionKey: string, agentId: string | null): Promise<void>;
  touchConversation(id: string, at: Date): Promise<void>;
  updateConversationTitle(id: string, title: string): Promise<void>;
  createRun(input: CreateCrmRunInput): Promise<CrmRunRecord | undefined>;
  getRun(id: string): Promise<CrmRunRecord | undefined>;
  getRunByClientMessage(conversationId: string, clientMessageId: string): Promise<CrmRunRecord | undefined>;
  getActiveRun(conversationId: string): Promise<CrmRunRecord | undefined>;
  updateRunStatus(
    id: string,
    status: CrmRunStatus,
    fields: Readonly<{
      now: Date;
      sessionKey?: string;
      errorCode?: string;
      errorMessageSafe?: string;
      terminal: boolean;
    }>,
  ): Promise<boolean>;
  markStaleRunsUnknown(olderThan: Date, now: Date): Promise<number>;
  deleteExpiredArtifacts(now: Date): Promise<Readonly<{ nonces: number; sessions: number }>>;
}

export class MySqlCrmChatRepository implements CrmChatRepository {
  public constructor(private readonly database: ControlPlaneDatabaseClient) {}

  public async findBinding(
    salesforceOrgId: string,
    salesforceUserId: string,
  ): Promise<CrmIdentityBindingRecord | undefined> {
    const row = await this.database
      .selectFrom('sfoa_crm_identity_binding')
      .selectAll()
      .where('salesforce_org_id', '=', salesforceOrgId)
      .where('salesforce_user_id', '=', salesforceUserId)
      .executeTakeFirst();
    return row ? mapBinding(row) : undefined;
  }

  public async listBindings(limit: number): Promise<readonly CrmIdentityBindingRecord[]> {
    const rows = await this.database
      .selectFrom('sfoa_crm_identity_binding')
      .selectAll()
      .orderBy('salesforce_org_id')
      .orderBy('salesforce_user_id')
      .limit(Math.min(Math.max(limit, 1), 500))
      .execute();
    return Object.freeze(rows.map(mapBinding));
  }

  /**
   * 管理员显式绑定。唯一键是 (org, user)；重复执行只更新同一条记录，
   * 不按姓名/昵称匹配，也不会创建第二条。
   */
  public async upsertBinding(input: UpsertCrmIdentityBindingInput): Promise<CrmIdentityBindingRecord> {
    await this.database
      .insertInto('sfoa_crm_identity_binding')
      .values({
        salesforce_org_id: input.salesforceOrgId,
        salesforce_user_id: input.salesforceUserId,
        platform_user_id: input.platformUserId,
        display_name: input.displayName,
        enabled: input.enabled,
        row_version: 1,
      })
      .onDuplicateKeyUpdate({
        platform_user_id: input.platformUserId,
        display_name: input.displayName,
        enabled: input.enabled,
        row_version: sql<number>`row_version + 1`,
      })
      .execute();
    const binding = await this.findBinding(input.salesforceOrgId, input.salesforceUserId);
    if (!binding) throw new Error('The CRM identity binding insert did not round-trip.');
    return binding;
  }

  public async findIdentityRoute(platformUserId: string): Promise<
    Readonly<{ platformUserId: string; salesforceUsername: string; enabled: boolean }> | undefined
  > {
    const row = await this.database
      .selectFrom('sfoa_identity_route')
      .select(['platform_user_id', 'salesforce_username', 'enabled'])
      .where('platform_user_id', '=', platformUserId)
      .executeTakeFirst();
    return row
      ? Object.freeze({
        platformUserId: row.platform_user_id,
        salesforceUsername: row.salesforce_username,
        enabled: Boolean(row.enabled),
      })
      : undefined;
  }

  public async consumeBootstrapNonce(input: ConsumeBootstrapNonceInput): Promise<boolean> {
    // 主键 jti + INSERT IGNORE：重复兑换在数据库层被拒绝，不需要先读后写，
    // 也不会因为进程重启而丢失已消费记录。
    const result = await this.database
      .insertInto('sfoa_crm_bootstrap_nonce')
      .ignore()
      .values({
        jti: input.jti,
        salesforce_org_id: input.salesforceOrgId,
        salesforce_user_id: input.salesforceUserId,
        issued_at: input.issuedAt,
        expires_at: input.expiresAt,
      })
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0) === 1;
  }

  public async createChatSession(input: CreateCrmChatSessionInput): Promise<void> {
    await this.database
      .insertInto('sfoa_crm_chat_session')
      .values({
        token_hash: input.tokenHash,
        id: input.id,
        salesforce_org_id: input.salesforceOrgId,
        salesforce_user_id: input.salesforceUserId,
        platform_user_id: input.platformUserId,
        display_name: input.displayName,
        salesforce_username: input.salesforceUsername,
        created_at: input.createdAt,
        last_seen_at: input.createdAt,
        expires_at: input.expiresAt,
      })
      .execute();
  }

  public async getChatSessionByHash(tokenHash: string): Promise<CrmChatSessionRecord | undefined> {
    const row = await this.database
      .selectFrom('sfoa_crm_chat_session')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();
    return row ? mapChatSession(row) : undefined;
  }

  public async touchChatSession(tokenHash: string, at: Date): Promise<void> {
    await this.database
      .updateTable('sfoa_crm_chat_session')
      .set({ last_seen_at: at })
      .where('token_hash', '=', tokenHash)
      .execute();
  }

  public async revokeChatSession(tokenHash: string, at: Date): Promise<void> {
    await this.database
      .updateTable('sfoa_crm_chat_session')
      .set({ revoked_at: at })
      .where('token_hash', '=', tokenHash)
      .execute();
  }

  public async createConversation(input: CreateCrmConversationInput): Promise<CrmConversationRecord> {
    await this.database
      .insertInto('sfoa_crm_conversation')
      .values({
        id: input.id,
        salesforce_org_id: input.salesforceOrgId,
        salesforce_user_id: input.salesforceUserId,
        platform_user_id: input.platformUserId,
        title: input.title,
        created_at: input.now,
        updated_at: input.now,
      })
      .execute();
    const created = await this.getConversation(input.id);
    if (!created) throw new Error('The CRM conversation insert did not round-trip.');
    return created;
  }

  public async getConversation(id: string): Promise<CrmConversationRecord | undefined> {
    const row = await this.database
      .selectFrom('sfoa_crm_conversation')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? mapConversation(row) : undefined;
  }

  public async getConversationForOwner(
    id: string,
    salesforceOrgId: string,
    salesforceUserId: string,
  ): Promise<CrmConversationRecord | undefined> {
    const row = await this.database
      .selectFrom('sfoa_crm_conversation')
      .selectAll()
      .where('id', '=', id)
      .where('salesforce_org_id', '=', salesforceOrgId)
      .where('salesforce_user_id', '=', salesforceUserId)
      .executeTakeFirst();
    return row ? mapConversation(row) : undefined;
  }

  public async listConversations(
    salesforceOrgId: string,
    salesforceUserId: string,
    limit: number,
  ): Promise<readonly CrmConversationRecord[]> {
    const rows = await this.database
      .selectFrom('sfoa_crm_conversation')
      .selectAll()
      .where('salesforce_org_id', '=', salesforceOrgId)
      .where('salesforce_user_id', '=', salesforceUserId)
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return Object.freeze(rows.map(mapConversation));
  }

  public async updateConversationSession(id: string, sessionKey: string, agentId: string | null): Promise<void> {
    await this.database
      .updateTable('sfoa_crm_conversation')
      .set({ openclaw_session_key: sessionKey, openclaw_agent_id: agentId })
      .where('id', '=', id)
      .execute();
  }

  public async touchConversation(id: string, at: Date): Promise<void> {
    await this.database
      .updateTable('sfoa_crm_conversation')
      .set({ last_message_at: at, updated_at: at })
      .where('id', '=', id)
      .execute();
  }

  public async updateConversationTitle(id: string, title: string): Promise<void> {
    await this.database
      .updateTable('sfoa_crm_conversation')
      .set({ title })
      .where('id', '=', id)
      .execute();
  }

  public async createRun(input: CreateCrmRunInput): Promise<CrmRunRecord | undefined> {
    const result = await this.database
      .insertInto('sfoa_crm_run')
      .ignore()
      .values({
        id: input.id,
        conversation_id: input.conversationId,
        client_message_id: input.clientMessageId,
        status: 'STARTED',
        request_sha256: input.requestSha256,
        text_length: input.textLength,
        started_at: input.now,
        updated_at: input.now,
      })
      .executeTakeFirst();
    if (Number(result.numInsertedOrUpdatedRows ?? 0) !== 1) return undefined;
    return this.getRun(input.id);
  }

  public async getRun(id: string): Promise<CrmRunRecord | undefined> {
    const row = await this.database
      .selectFrom('sfoa_crm_run')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? mapRun(row) : undefined;
  }

  public async getRunByClientMessage(
    conversationId: string,
    clientMessageId: string,
  ): Promise<CrmRunRecord | undefined> {
    const row = await this.database
      .selectFrom('sfoa_crm_run')
      .selectAll()
      .where('conversation_id', '=', conversationId)
      .where('client_message_id', '=', clientMessageId)
      .executeTakeFirst();
    return row ? mapRun(row) : undefined;
  }

  public async getActiveRun(conversationId: string): Promise<CrmRunRecord | undefined> {
    const row = await this.database
      .selectFrom('sfoa_crm_run')
      .selectAll()
      .where('conversation_id', '=', conversationId)
      .where('status', 'in', ['STARTED', 'RUNNING'])
      .orderBy('started_at', 'desc')
      .executeTakeFirst();
    return row ? mapRun(row) : undefined;
  }

  public async updateRunStatus(
    id: string,
    status: CrmRunStatus,
    fields: Readonly<{
      now: Date;
      sessionKey?: string;
      errorCode?: string;
      errorMessageSafe?: string;
      terminal: boolean;
    }>,
  ): Promise<boolean> {
    const result = await this.database
      .updateTable('sfoa_crm_run')
      .set({
        status,
        updated_at: fields.now,
        ...(fields.sessionKey ? { openclaw_session_key: fields.sessionKey } : {}),
        ...(fields.errorCode ? { error_code: fields.errorCode } : {}),
        ...(fields.errorMessageSafe ? { error_message_safe: fields.errorMessageSafe } : {}),
        ...(fields.terminal ? { completed_at: fields.now } : {}),
      })
      // 终态只写一次：迟到的重复事件不能把 COMPLETED/STOPPED 改回 RUNNING。
      .where('id', '=', id)
      .where('status', 'in', ['STARTED', 'RUNNING'])
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) > 0;
  }

  public async markStaleRunsUnknown(olderThan: Date, now: Date): Promise<number> {
    const result = await this.database
      .updateTable('sfoa_crm_run')
      .set({
        status: 'UNKNOWN',
        error_code: 'CRM_RUN_RESULT_UNKNOWN',
        error_message_safe: '服务在回答完成前中断；结果未知，不会自动重试。',
        completed_at: now,
        updated_at: now,
      })
      .where('status', 'in', ['STARTED', 'RUNNING'])
      .where('updated_at', '<', olderThan)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0);
  }

  public async deleteExpiredArtifacts(now: Date): Promise<Readonly<{ nonces: number; sessions: number }>> {
    const nonces = await this.database
      .deleteFrom('sfoa_crm_bootstrap_nonce')
      .where('expires_at', '<', now)
      .executeTakeFirst();
    const sessions = await this.database
      .deleteFrom('sfoa_crm_chat_session')
      .where('expires_at', '<', now)
      .executeTakeFirst();
    return Object.freeze({
      nonces: Number(nonces.numDeletedRows ?? 0),
      sessions: Number(sessions.numDeletedRows ?? 0),
    });
  }
}

function mapBinding(row: Selectable<CrmIdentityBindingTable>): CrmIdentityBindingRecord {
  return Object.freeze({
    id: Number(row.id),
    salesforceOrgId: row.salesforce_org_id,
    salesforceUserId: row.salesforce_user_id,
    platformUserId: row.platform_user_id,
    displayName: row.display_name,
    enabled: Boolean(row.enabled),
  });
}

function mapConversation(row: Selectable<CrmConversationTable>): CrmConversationRecord {
  return Object.freeze({
    id: row.id,
    salesforceOrgId: row.salesforce_org_id,
    salesforceUserId: row.salesforce_user_id,
    platformUserId: row.platform_user_id,
    title: row.title,
    openclawSessionKey: row.openclaw_session_key,
    openclawAgentId: row.openclaw_agent_id,
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
    lastMessageAt: row.last_message_at === null ? null : asDate(row.last_message_at),
  });
}

function mapRun(row: Selectable<CrmRunTable>): CrmRunRecord {
  return Object.freeze({
    id: row.id,
    conversationId: row.conversation_id,
    clientMessageId: row.client_message_id,
    status: row.status,
    openclawSessionKey: row.openclaw_session_key,
    requestSha256: row.request_sha256,
    textLength: Number(row.text_length),
    errorCode: row.error_code,
    errorMessageSafe: row.error_message_safe,
    startedAt: asDate(row.started_at),
    completedAt: row.completed_at === null ? null : asDate(row.completed_at),
    updatedAt: asDate(row.updated_at),
  });
}

function mapChatSession(row: Selectable<CrmChatSessionTable>): CrmChatSessionRecord {
  return Object.freeze({
    tokenHash: row.token_hash,
    id: row.id,
    salesforceOrgId: row.salesforce_org_id,
    salesforceUserId: row.salesforce_user_id,
    platformUserId: row.platform_user_id,
    displayName: row.display_name,
    salesforceUsername: row.salesforce_username,
    createdAt: asDate(row.created_at),
    lastSeenAt: asDate(row.last_seen_at),
    expiresAt: asDate(row.expires_at),
    revokedAt: row.revoked_at === null ? null : asDate(row.revoked_at),
  });
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Kept for callers that need a bounded "now" expression in ad-hoc queries. */
export function crmNowExpression() {
  return sql<Date>`CURRENT_TIMESTAMP(3)`;
}
