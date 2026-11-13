-- DSH Standard Scenarios Control Plane (DSH-01).
--
-- 1. sfoa_identity_route.can_manage_dsh_scenarios is the whole permission model. It hangs off
--    the existing platform-user -> CRM-account route instead of a second grant table, so a
--    platform user's standard-scenario authority is decided by the same row that already decides
--    which Salesforce identity the request runs as. DEFAULT FALSE is deliberate: every existing
--    route keeps exactly today's behaviour, and an operator must grant the capability explicitly.
--    The Admin Console toggle, the plugin permission probe and every write endpoint read this one
--    column; nothing is derived from `enabled`, `remark`, or the CRM account name.
--
-- 2. crm_dsh_standard_scenarios is the published catalogue the DSH client plugin
--    (crm-dsh-plug) synchronises. `revision` is the integer the plugin compares on every start;
--    `version` is the human-facing semantic label. Both are owned by the MCP server: every edit,
--    attachment change, archive or delete increments revision, and edits increment the version
--    patch segment. Clients never send either value.
--
--    `status` uses VARCHAR(20) with a CHECK rather than ENUM so the three lifecycle values stay
--    exactly the published contract (PUBLISHED / ARCHIVED / DELETED) and an unknown value can
--    never be written. DELETED is a soft delete on purpose: the plugin needs the id in
--    `deletedScenarioIds` to remove a scenario it already installed locally.
--
--    Timestamps are DATETIME(3), matching every other SFoA table: no 2038 ceiling and no
--    session-timezone reinterpretation of stored instants.
--
-- 3. crm_dsh_scenario_files holds the bytes of the preset attachments that travel with a
--    scenario. Keeping them in MySQL (rather than a host directory) makes a scenario
--    self-contained: the download endpoint, the plugin's first-run import and the delete-path
--    cleanup all see the same authoritative row. `sha256` is computed by the server from the bytes
--    it actually stored, so a client simply re-verifying the digest is checking what was written.
ALTER TABLE sfoa_identity_route
  ADD COLUMN can_manage_dsh_scenarios BOOLEAN NOT NULL DEFAULT FALSE
    COMMENT '是否有权在DSH插件中设置/编辑/删除标准场景 (0:否, 1:是)' AFTER enabled;

CREATE TABLE IF NOT EXISTS crm_dsh_standard_scenarios (
  scenario_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '场景唯一标识，对应插件端 scenarioId',
  title VARCHAR(128) NOT NULL COMMENT '场景标题',
  category VARCHAR(64) NOT NULL DEFAULT '通用场景' COMMENT '场景分类标签',
  description TEXT NOT NULL COMMENT '场景功能与适用范围介绍',
  version VARCHAR(32) NOT NULL DEFAULT '1.0.0' COMMENT '语义化版本号，每次编辑由服务端自动递增 patch 位',
  revision INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '整型递增修订号，每次编辑或附件变更自动 +1',
  scenario_payload JSON NOT NULL COMMENT '完整场景配置（pinnedSkills / welcomeMessage / inputDraft / prePinnedContext 等）',
  preset_attachments JSON NULL COMMENT '预设附件元数据数组 [{attachmentId,fileName,mimeType,fileSize,sha256,downloadUrl}]',
  status VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PUBLISHED' COMMENT 'PUBLISHED / ARCHIVED / DELETED',
  created_by_platform_uid VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL COMMENT '创建人平台用户编号 platformUserId',
  created_by_crm_user VARCHAR(320) NULL COMMENT '创建人关联的 CRM 账号',
  updated_by_platform_uid VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL COMMENT '最后修改人平台用户编号',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT pk_crm_dsh_standard_scenarios PRIMARY KEY (scenario_id),
  CONSTRAINT chk_crm_dsh_scenario_status CHECK (status IN ('PUBLISHED', 'ARCHIVED', 'DELETED')),
  CONSTRAINT chk_crm_dsh_scenario_revision CHECK (revision >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX idx_status_updated ON crm_dsh_standard_scenarios (status, updated_at);

CREATE TABLE IF NOT EXISTS crm_dsh_scenario_files (
  attachment_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '附件唯一标识',
  scenario_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '关联的标准场景 ID',
  file_name VARCHAR(255) NOT NULL COMMENT '原始文件名',
  mime_type VARCHAR(128) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL COMMENT 'MIME 类型',
  file_size INT UNSIGNED NOT NULL COMMENT '文件字节大小',
  sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '文件内容 SHA-256 哈希值',
  file_content LONGBLOB NOT NULL COMMENT '文件二进制内容',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT pk_crm_dsh_scenario_files PRIMARY KEY (attachment_id),
  CONSTRAINT chk_crm_dsh_scenario_file_size CHECK (file_size > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX idx_scenario_id ON crm_dsh_scenario_files (scenario_id);
