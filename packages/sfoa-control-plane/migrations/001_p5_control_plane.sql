CREATE TABLE IF NOT EXISTS sfoa_schema_migration (
  version VARCHAR(128) NOT NULL PRIMARY KEY,
  checksum_sha256 CHAR(64) NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

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
