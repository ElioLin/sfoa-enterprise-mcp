-- =====================================================================
-- SFoA Enterprise MCP — 数据库表结构（一键创建）
-- =====================================================================
-- 本文件由当前仓库的 P5/P6 迁移合并而成：
--   packages/sfoa-control-plane/migrations/001_p5_control_plane.sql
--   packages/sfoa-control-plane/migrations/002_p5_indexes.sql
--   packages/sfoa-control-plane/migrations/003_p6_identity_credential.sql
--
-- 用途：在共享 MySQL 服务器上直接执行本文件，即可一次性创建 MCP 服务所需的
-- 数据库、全部表与索引，并把迁移记录写入 sfoa_schema_migration，
-- 与应用运行时 `assertAllMigrationsApplied` 的校验保持一致。
--
-- 执行前提：
--   * MySQL 8.x（用到了 utf8mb4_0900_ai_ci / utf8mb4_0900_as_cs 排序规则、
--     CHECK 约束、STORED 生成列、DESC 索引等 8.x 特性）。
--   * 需要一个具备 CREATE DATABASE 及目标库 DDL 权限的账号（通常是 DBA）。
--
-- 用法：
--   mysql -h <共享MySQL主机> -P 3306 -u <有权限账号> -p < SFOA_ENTERPRISE_MCP_SCHEMA.sql
--   或在数据库客户端工具中直接执行本文件全部内容。
--
-- 注意：
--   1. 文件末尾写入 sfoa_schema_migration 的 checksum_sha256 与本仓库迁移文件
--      【逐字节一致】，应用启动会校验，请勿手工修改。
--   2. 本文件只在【全新建库】时使用。后续代码升级若新增迁移
--      （如 004_xxx.sql），不要在库上手工执行 SQL，应在服务器上运行
--      `yarn db:migrate` 增量应用（迁移运行器会自动跳过已 APPLIED 的版本）。
--   3. 若数据库已由 DBA 创建，跳过下方 CREATE DATABASE / USE 两行即可
--      （IF NOT EXISTS 本身幂等）。
-- =====================================================================

CREATE DATABASE IF NOT EXISTS sfoa_enterprise_mcp
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

USE sfoa_enterprise_mcp;

-- ---------------------------------------------------------------------
-- 迁移历史表（sfoa_schema_migration）
-- 与应用 ensureMigrationTable 定义一致；001 迁移中也包含该表，幂等。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfoa_schema_migration (
  version VARCHAR(128) NOT NULL PRIMARY KEY,
  checksum_sha256 CHAR(64) NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================================
-- 迁移 001_p5_control_plane
-- =====================================================================

CREATE TABLE IF NOT EXISTS sfoa_identity_route (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  platform_user_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  salesforce_username VARCHAR(320) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  remark VARCHAR(512) NULL,
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_sfoa_identity_route_platform_user UNIQUE (platform_user_id),
  CONSTRAINT chk_sfoa_identity_route_version CHECK (row_version >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sfoa_tool_control (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tool_name VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  remark VARCHAR(512) NULL,
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_sfoa_tool_control_name UNIQUE (tool_name),
  CONSTRAINT chk_sfoa_tool_control_version CHECK (row_version >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sfoa_dml_policy (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  object_api_name VARCHAR(128) NOT NULL,
  allow_create BOOLEAN NOT NULL DEFAULT FALSE,
  allow_update BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  remark VARCHAR(512) NULL,
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_sfoa_dml_policy_object UNIQUE (object_api_name),
  CONSTRAINT chk_sfoa_dml_policy_version CHECK (row_version >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sfoa_diagnostic_config (
  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  salesforce_username VARCHAR(320) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  verification_status ENUM('NOT_VERIFIED', 'PASS', 'FAIL', 'NOT_TESTED') NOT NULL DEFAULT 'NOT_VERIFIED',
  last_verified_at DATETIME(3) NULL,
  last_error_code VARCHAR(128) NULL,
  last_error_message_safe VARCHAR(1024) NULL,
  test_metadata_type VARCHAR(128) NULL,
  test_metadata_full_name VARCHAR(512) NULL,
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_sfoa_diagnostic_singleton CHECK (id = 1),
  CONSTRAINT chk_sfoa_diagnostic_version CHECK (row_version >= 1),
  CONSTRAINT chk_sfoa_diagnostic_metadata_pair CHECK (
    (test_metadata_type IS NULL AND test_metadata_full_name IS NULL)
    OR (test_metadata_type IS NOT NULL AND test_metadata_full_name IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sfoa_runtime_setting (
  setting_key VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL PRIMARY KEY,
  setting_value_json JSON NOT NULL,
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_sfoa_runtime_setting_version CHECK (row_version >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sfoa_audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  occurred_at DATETIME(3) NOT NULL,
  correlation_id VARCHAR(128) NOT NULL,
  channel ENUM('MCP', 'ADMIN') NOT NULL,
  client_id VARCHAR(128) NULL,
  actor_admin VARCHAR(128) NULL,
  platform_user_id VARCHAR(128) NULL,
  salesforce_username VARCHAR(320) NULL,
  execution_role ENUM('USER', 'DIAGNOSTIC') NULL,
  tool_name VARCHAR(128) NULL,
  operation VARCHAR(64) NULL,
  object_api_name VARCHAR(128) NULL,
  record_id VARCHAR(128) NULL,
  result ENUM('PASS', 'ERROR', 'BLOCKED') NOT NULL,
  outcome ENUM('SUCCESS', 'FAILED', 'DENIED', 'UNKNOWN') NULL,
  error_code VARCHAR(128) NULL,
  duration_ms INT UNSIGNED NULL,
  request_summary_json JSON NULL,
  response_summary_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_sfoa_audit_duration CHECK (duration_ms IS NULL OR duration_ms <= 4294967295)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =====================================================================
-- 迁移 002_p5_indexes
-- =====================================================================

CREATE INDEX idx_sfoa_audit_occurred_at ON sfoa_audit_log (occurred_at DESC, id DESC);
CREATE INDEX idx_sfoa_audit_correlation ON sfoa_audit_log (correlation_id);
CREATE INDEX idx_sfoa_audit_platform_user ON sfoa_audit_log (platform_user_id, occurred_at DESC);
CREATE INDEX idx_sfoa_audit_salesforce_user ON sfoa_audit_log (salesforce_username, occurred_at DESC);
CREATE INDEX idx_sfoa_audit_tool ON sfoa_audit_log (tool_name, occurred_at DESC);
CREATE INDEX idx_sfoa_audit_result ON sfoa_audit_log (result, occurred_at DESC);
CREATE INDEX idx_sfoa_audit_error ON sfoa_audit_log (error_code, occurred_at DESC);
CREATE INDEX idx_sfoa_identity_enabled_username ON sfoa_identity_route (enabled, salesforce_username);
CREATE INDEX idx_sfoa_tool_enabled ON sfoa_tool_control (enabled, tool_name);
CREATE INDEX idx_sfoa_dml_enabled ON sfoa_dml_policy (enabled, object_api_name);

-- =====================================================================
-- 迁移 003_p6_identity_credential
-- =====================================================================

CREATE TABLE IF NOT EXISTS sfoa_identity_credential (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  identity_route_id BIGINT UNSIGNED NOT NULL,
  credential_type ENUM('USER_BOUND') NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_ciphertext VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NULL,
  token_last4 CHAR(4) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('ACTIVE', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
  generated_at DATETIME(3) NOT NULL,
  last_used_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  active_identity_route_id BIGINT UNSIGNED GENERATED ALWAYS AS (
    CASE WHEN status = 'ACTIVE' THEN identity_route_id ELSE NULL END
  ) STORED,
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_sfoa_identity_credential_route FOREIGN KEY (identity_route_id)
    REFERENCES sfoa_identity_route (id) ON DELETE RESTRICT,
  CONSTRAINT uq_sfoa_identity_credential_hash UNIQUE (token_hash),
  CONSTRAINT uq_sfoa_identity_credential_active_route UNIQUE (active_identity_route_id),
  CONSTRAINT chk_sfoa_identity_credential_version CHECK (row_version >= 1),
  CONSTRAINT chk_sfoa_identity_credential_lifecycle CHECK (
    (status = 'ACTIVE' AND token_ciphertext IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'REVOKED' AND token_ciphertext IS NULL AND revoked_at IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX idx_sfoa_identity_credential_route_status
  ON sfoa_identity_credential (identity_route_id, status, id DESC);

ALTER TABLE sfoa_audit_log
  ADD COLUMN identity_source ENUM('INTERNAL_SERVICE_HEADER', 'USER_BOUND_TOKEN', 'BUNTU_TOKEN') NULL AFTER execution_role,
  ADD COLUMN identity_credential_id BIGINT UNSIGNED NULL AFTER identity_source;

CREATE INDEX idx_sfoa_audit_identity_credential
  ON sfoa_audit_log (identity_credential_id, occurred_at DESC);

-- =====================================================================
-- 迁移记录（checksum_sha256 与本仓库迁移文件逐字节一致，供应用启动校验）
-- =====================================================================

INSERT INTO sfoa_schema_migration (version, checksum_sha256) VALUES
  ('001_p5_control_plane', 'd2fce65818ad3374153063f44be10cedc5b55c67970bde5ca51d72749165faeb'),
  ('002_p5_indexes',       '3bafd5109af59869dde4d14db91d5e580dc4c41719a7bb1cd807975a404f4c0d'),
  ('003_p6_identity_credential', '5d28d42b870639b4f1e06632aa5e7d4dcab708af603cbdd9cddc281cb88ae152');
