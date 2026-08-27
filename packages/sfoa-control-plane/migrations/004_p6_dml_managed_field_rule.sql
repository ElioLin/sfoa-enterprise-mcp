CREATE TABLE IF NOT EXISTS sfoa_dml_managed_field_rule (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  dml_policy_id BIGINT UNSIGNED NOT NULL,
  target_field_api_name VARCHAR(128) NOT NULL,
  strategy ENUM('PLATFORM_USER_LOOKUP', 'AI_CREATED_MARKER') NOT NULL,
  apply_on_create TINYINT(1) NOT NULL DEFAULT 0,
  apply_on_update TINYINT(1) NOT NULL DEFAULT 0,
  lookup_object_api_name VARCHAR(128) NULL,
  lookup_match_field_api_name VARCHAR(128) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  remark VARCHAR(512) NULL,
  row_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_sfoa_dml_managed_field_policy FOREIGN KEY (dml_policy_id)
    REFERENCES sfoa_dml_policy (id) ON DELETE RESTRICT,
  CONSTRAINT uq_sfoa_dml_managed_field_policy_target UNIQUE (dml_policy_id, target_field_api_name),
  CONSTRAINT chk_sfoa_dml_managed_field_version CHECK (row_version >= 1),
  CONSTRAINT chk_sfoa_dml_managed_field_operation CHECK (apply_on_create = 1 OR apply_on_update = 1),
  CONSTRAINT chk_sfoa_dml_managed_field_strategy CHECK (
    (strategy = 'PLATFORM_USER_LOOKUP' AND lookup_object_api_name IS NOT NULL AND lookup_match_field_api_name IS NOT NULL)
    OR
    (strategy = 'AI_CREATED_MARKER' AND apply_on_create = 1 AND apply_on_update = 0
      AND lookup_object_api_name IS NULL AND lookup_match_field_api_name IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX idx_sfoa_dml_managed_field_policy_enabled
  ON sfoa_dml_managed_field_rule (dml_policy_id, enabled, id);
