CREATE TABLE IF NOT EXISTS sfoa_ui_snapshot (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  organization_id VARCHAR(18) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_api_name VARCHAR(128) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  snapshot_json JSON NULL,
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  metadata_last_modified DATETIME(3) NULL,
  refreshed_at DATETIME(3) NULL,
  refresh_status ENUM('READY', 'REFRESHING', 'FAILED') NOT NULL DEFAULT 'FAILED',
  last_error VARCHAR(128) NULL,
  parser_version VARCHAR(32) NOT NULL,
  refresh_started_at DATETIME(3) NULL,
  refresh_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  UNIQUE KEY uq_sfoa_ui_snapshot_scope (organization_id, object_api_name),
  CONSTRAINT chk_sfoa_ui_snapshot_bytes CHECK (snapshot_json IS NULL OR JSON_STORAGE_SIZE(snapshot_json) <= 2097152)
) ENGINE=InnoDB;

ALTER TABLE sfoa_audit_payload_evidence MODIFY COLUMN payload_type
  ENUM('MCP_REQUEST', 'MCP_RESPONSE', 'SALESFORCE_REQUEST', 'SALESFORCE_RESPONSE', 'ERROR_RESPONSE', 'UI_CONTEXT') NOT NULL;
