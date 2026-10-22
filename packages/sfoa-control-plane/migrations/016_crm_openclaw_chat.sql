-- CRM OpenClaw embedded chat (一期).
--
-- 这张迁移只做两件事：
--   1. 给审计身份来源增加 CRM_HEADER —— Salesforce 内嵌聊天渠道的可信身份头。
--      MySQL strict mode 下，未知 ENUM 值会让整批审计写入失败，所以必须先扩枚举。
--   2. 追加 CRM 聊天所需的归属/映射/防重放/运行记录表。既有表不改语义。
--
-- 不存储 Salesforce Session ID、聊天明文、Apex 签名私钥或任何访问令牌明文；
-- 聊天正文仍由 OpenClaw 的会话存储持有，这里只保存对话归属、运行状态和摘要关联。

ALTER TABLE sfoa_audit_log
  MODIFY COLUMN identity_source ENUM('INTERNAL_SERVICE_HEADER', 'USER_BOUND_TOKEN', 'BUNTU_TOKEN', 'WECOM_HEADER', 'CRM_HEADER') NULL;

-- Salesforce 组织用户 -> 现有 platformUserId / Identity Route 的显式绑定。
-- 默认拒绝：没有这一行，CRM 聊天不解析任何 Salesforce 执行身份。
-- 唯一键是 (组织, 用户)，绝不按姓名、昵称或模糊用户名匹配。
CREATE TABLE IF NOT EXISTS sfoa_crm_identity_binding (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  salesforce_org_id VARCHAR(18) NOT NULL,
  salesforce_user_id VARCHAR(18) NOT NULL,
  platform_user_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  display_name VARCHAR(255) NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_sfoa_crm_identity_binding_user UNIQUE (salesforce_org_id, salesforce_user_id),
  CONSTRAINT chk_sfoa_crm_identity_binding_version CHECK (row_version >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 一条 CRM 对话 = 一个归属主体 + 一个独立的 OpenClaw 会话键。
-- openclaw_session_key 由 OpenClaw 官方路由解析后写回，不在代码里拼 sessionKey 语法。
CREATE TABLE IF NOT EXISTS sfoa_crm_conversation (
  id CHAR(36) NOT NULL PRIMARY KEY,
  salesforce_org_id VARCHAR(18) NOT NULL,
  salesforce_user_id VARCHAR(18) NOT NULL,
  platform_user_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  title VARCHAR(200) NULL,
  openclaw_session_key VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NULL,
  openclaw_agent_id VARCHAR(128) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  last_message_at DATETIME(3) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 一次发送 = 一次运行。client_message_id 由浏览器生成，服务端按
-- (conversation_id, client_message_id) 唯一约束去重；重复提交只能重放/查询原运行，
-- 不允许再次提交 Agent 或业务写操作。
CREATE TABLE IF NOT EXISTS sfoa_crm_run (
  id CHAR(36) NOT NULL PRIMARY KEY,
  conversation_id CHAR(36) NOT NULL,
  client_message_id VARCHAR(128) NOT NULL,
  status ENUM('STARTED', 'RUNNING', 'COMPLETED', 'FAILED', 'STOPPED', 'UNKNOWN') NOT NULL DEFAULT 'STARTED',
  openclaw_session_key VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NULL,
  request_sha256 CHAR(64) NOT NULL,
  text_length INT UNSIGNED NOT NULL,
  error_code VARCHAR(128) NULL,
  error_message_safe VARCHAR(1024) NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_sfoa_crm_run_client_message UNIQUE (conversation_id, client_message_id),
  CONSTRAINT fk_sfoa_crm_run_conversation FOREIGN KEY (conversation_id)
    REFERENCES sfoa_crm_conversation (id) ON DELETE CASCADE,
  CONSTRAINT chk_sfoa_crm_run_text_length CHECK (text_length > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 一次性 Apex 引导凭证的 jti 消费记录。主键即 jti，重复兑换被数据库拒绝；
-- 记录落库后，接入服务重启也不会让已消费凭证重新可用。
CREATE TABLE IF NOT EXISTS sfoa_crm_bootstrap_nonce (
  jti CHAR(36) NOT NULL PRIMARY KEY,
  salesforce_org_id VARCHAR(18) NOT NULL,
  salesforce_user_id VARCHAR(18) NOT NULL,
  issued_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- 浏览器短期聊天凭证：只存 SHA-256，不存原值。退出 Salesforce 不会即时撤销，
-- 最大有效窗口由 expires_at 决定（默认 15 分钟），刷新页面必须重新走 Apex 签发。
CREATE TABLE IF NOT EXISTS sfoa_crm_chat_session (
  token_hash CHAR(64) NOT NULL PRIMARY KEY,
  id CHAR(36) NOT NULL,
  salesforce_org_id VARCHAR(18) NOT NULL,
  salesforce_user_id VARCHAR(18) NOT NULL,
  platform_user_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  display_name VARCHAR(255) NULL,
  salesforce_username VARCHAR(320) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  CONSTRAINT uq_sfoa_crm_chat_session_id UNIQUE (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX idx_sfoa_crm_binding_platform_user
  ON sfoa_crm_identity_binding (platform_user_id, enabled);
CREATE INDEX idx_sfoa_crm_conversation_owner
  ON sfoa_crm_conversation (salesforce_org_id, salesforce_user_id, updated_at, id);
CREATE INDEX idx_sfoa_crm_conversation_session
  ON sfoa_crm_conversation (openclaw_session_key);
CREATE INDEX idx_sfoa_crm_run_conversation
  ON sfoa_crm_run (conversation_id, started_at, id);
CREATE INDEX idx_sfoa_crm_run_status
  ON sfoa_crm_run (status, started_at);
CREATE INDEX idx_sfoa_crm_bootstrap_expiry
  ON sfoa_crm_bootstrap_nonce (expires_at);
CREATE INDEX idx_sfoa_crm_chat_session_expiry
  ON sfoa_crm_chat_session (expires_at);
