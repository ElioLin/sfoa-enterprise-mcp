ALTER TABLE sfoa_audit_log
  ADD COLUMN public_audit_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER id,
  ADD COLUMN audit_kind ENUM('MCP_TOOL_CALL', 'ADMIN_ACTION', 'IDENTITY_VALIDATION', 'RUNTIME_EVENT') NULL AFTER public_audit_id,
  ADD COLUMN started_at DATETIME(3) NULL AFTER occurred_at,
  ADD COLUMN completed_at DATETIME(3) NULL AFTER started_at,
  ADD COLUMN error_message_safe VARCHAR(1024) NULL AFTER error_code,
  ADD COLUMN audit_integrity_status ENUM('COMPLETE', 'PARTIAL', 'DEGRADED') NOT NULL DEFAULT 'PARTIAL' AFTER error_message_safe;

UPDATE sfoa_audit_log
SET public_audit_id = UUID()
WHERE public_audit_id IS NULL;

UPDATE sfoa_audit_log
SET audit_kind = CASE
  WHEN channel = 'ADMIN' THEN 'ADMIN_ACTION'
  WHEN operation = 'BUNTU_TOKEN_VALIDATE' THEN 'IDENTITY_VALIDATION'
  ELSE 'RUNTIME_EVENT'
END
WHERE audit_kind IS NULL;

UPDATE sfoa_audit_log
SET request_summary_json = JSON_REMOVE(request_summary_json, '$.rawToken')
WHERE request_summary_json IS NOT NULL
  AND JSON_CONTAINS_PATH(request_summary_json, 'one', '$.rawToken') = 1;

ALTER TABLE sfoa_audit_log
  MODIFY COLUMN public_audit_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT (UUID()),
  MODIFY COLUMN audit_kind ENUM('MCP_TOOL_CALL', 'ADMIN_ACTION', 'IDENTITY_VALIDATION', 'RUNTIME_EVENT') NOT NULL DEFAULT 'RUNTIME_EVENT',
  ADD CONSTRAINT chk_sfoa_audit_public_id CHECK (
    public_audit_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  ADD CONSTRAINT chk_sfoa_audit_time_range CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at);

CREATE UNIQUE INDEX uq_sfoa_audit_public_id
  ON sfoa_audit_log (public_audit_id);

CREATE INDEX idx_sfoa_audit_channel
  ON sfoa_audit_log (channel, occurred_at, id);

CREATE INDEX idx_sfoa_audit_kind
  ON sfoa_audit_log (audit_kind, occurred_at, id);

CREATE TABLE IF NOT EXISTS sfoa_audit_event (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  audit_id BIGINT UNSIGNED NOT NULL,
  sequence INT UNSIGNED NOT NULL,
  parent_event_id BIGINT UNSIGNED NULL,
  event_category ENUM('MCP', 'IDENTITY', 'ROUTING', 'GOVERNANCE', 'TOOL', 'SALESFORCE', 'INTERNAL', 'AUDIT') NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  event_name VARCHAR(128) NOT NULL,
  started_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  duration_ms INT UNSIGNED NULL,
  status ENUM('STARTED', 'SUCCESS', 'FAILED', 'BLOCKED', 'SKIPPED', 'UNKNOWN') NOT NULL,
  error_code VARCHAR(128) NULL,
  safe_summary_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_sfoa_audit_event_sequence UNIQUE (audit_id, sequence),
  CONSTRAINT uq_sfoa_audit_event_id_audit UNIQUE (id, audit_id),
  CONSTRAINT fk_sfoa_audit_event_audit FOREIGN KEY (audit_id)
    REFERENCES sfoa_audit_log (id) ON DELETE CASCADE,
  CONSTRAINT fk_sfoa_audit_event_parent FOREIGN KEY (parent_event_id, audit_id)
    REFERENCES sfoa_audit_event (id, audit_id) ON DELETE CASCADE,
  CONSTRAINT chk_sfoa_audit_event_sequence CHECK (sequence >= 1),
  CONSTRAINT chk_sfoa_audit_event_time CHECK (completed_at IS NULL OR completed_at >= started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX idx_sfoa_audit_event_error
  ON sfoa_audit_event (error_code, started_at);

CREATE TABLE IF NOT EXISTS sfoa_salesforce_api_call (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  audit_id BIGINT UNSIGNED NOT NULL,
  audit_event_id BIGINT UNSIGNED NULL,
  sequence INT UNSIGNED NOT NULL,
  salesforce_username VARCHAR(320) NOT NULL,
  api_category ENUM('REST', 'DATA', 'UI', 'TOOLING', 'METADATA', 'CLI', 'WORKSPACE') NOT NULL,
  http_method ENUM('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS') NOT NULL,
  endpoint VARCHAR(1024) NOT NULL,
  api_version VARCHAR(32) NULL,
  purpose VARCHAR(256) NOT NULL,
  started_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  duration_ms INT UNSIGNED NULL,
  http_status SMALLINT UNSIGNED NULL,
  result ENUM('SUCCESS', 'FAILED', 'UNKNOWN') NOT NULL,
  salesforce_error_code VARCHAR(128) NULL,
  salesforce_error_message_safe VARCHAR(1024) NULL,
  query_type VARCHAR(64) NULL,
  soql_statement_safe TEXT NULL,
  total_size INT UNSIGNED NULL,
  returned_records INT UNSIGNED NULL,
  done TINYINT(1) NULL,
  dml_operation ENUM('CREATE', 'UPDATE') NULL,
  object_api_name VARCHAR(128) NULL,
  record_id VARCHAR(128) NULL,
  requested_fields_json JSON NULL,
  managed_fields_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_sfoa_sf_api_sequence UNIQUE (audit_id, sequence),
  CONSTRAINT uq_sfoa_sf_api_id_audit UNIQUE (id, audit_id),
  CONSTRAINT fk_sfoa_sf_api_audit FOREIGN KEY (audit_id)
    REFERENCES sfoa_audit_log (id) ON DELETE CASCADE,
  CONSTRAINT fk_sfoa_sf_api_event FOREIGN KEY (audit_event_id, audit_id)
    REFERENCES sfoa_audit_event (id, audit_id) ON DELETE CASCADE,
  CONSTRAINT chk_sfoa_sf_api_sequence CHECK (sequence >= 1),
  CONSTRAINT chk_sfoa_sf_api_time CHECK (completed_at IS NULL OR completed_at >= started_at),
  CONSTRAINT chk_sfoa_sf_api_http_status CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  CONSTRAINT chk_sfoa_sf_api_query_counts CHECK (
    returned_records IS NULL OR total_size IS NULL OR returned_records <= total_size
  ),
  CONSTRAINT chk_sfoa_sf_api_dml_shape CHECK (
    dml_operation IS NULL OR object_api_name IS NOT NULL
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX idx_sfoa_sf_api_event
  ON sfoa_salesforce_api_call (audit_event_id, audit_id);

CREATE INDEX idx_sfoa_sf_api_category
  ON sfoa_salesforce_api_call (api_category, started_at);

CREATE INDEX idx_sfoa_sf_api_http_status
  ON sfoa_salesforce_api_call (http_status, started_at);

CREATE INDEX idx_sfoa_sf_api_error
  ON sfoa_salesforce_api_call (salesforce_error_code, started_at);

CREATE TABLE IF NOT EXISTS sfoa_audit_payload_evidence (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  audit_id BIGINT UNSIGNED NOT NULL,
  salesforce_api_call_id BIGINT UNSIGNED NULL,
  audit_event_id BIGINT UNSIGNED NULL,
  payload_type ENUM('MCP_REQUEST', 'MCP_RESPONSE', 'SALESFORCE_REQUEST', 'SALESFORCE_RESPONSE', 'ERROR_RESPONSE') NOT NULL,
  content_type VARCHAR(128) NOT NULL,
  original_size_bytes BIGINT UNSIGNED NOT NULL,
  stored_size_bytes INT UNSIGNED NOT NULL,
  truncated TINYINT(1) NOT NULL DEFAULT 0,
  content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  safe_payload MEDIUMTEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_sfoa_payload_audit FOREIGN KEY (audit_id)
    REFERENCES sfoa_audit_log (id) ON DELETE CASCADE,
  CONSTRAINT fk_sfoa_payload_api FOREIGN KEY (salesforce_api_call_id, audit_id)
    REFERENCES sfoa_salesforce_api_call (id, audit_id) ON DELETE CASCADE,
  CONSTRAINT fk_sfoa_payload_event FOREIGN KEY (audit_event_id, audit_id)
    REFERENCES sfoa_audit_event (id, audit_id) ON DELETE CASCADE,
  CONSTRAINT chk_sfoa_payload_stored_size CHECK (stored_size_bytes <= 262144),
  CONSTRAINT chk_sfoa_payload_actual_size CHECK (
    stored_size_bytes = COALESCE(OCTET_LENGTH(safe_payload), 0)
  ),
  CONSTRAINT chk_sfoa_payload_sha CHECK (
    content_sha256 IS NULL OR content_sha256 REGEXP '^[0-9a-f]{64}$'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX idx_sfoa_payload_event
  ON sfoa_audit_payload_evidence (audit_event_id, audit_id);

CREATE INDEX idx_sfoa_payload_api
  ON sfoa_audit_payload_evidence (salesforce_api_call_id, audit_id);

CREATE INDEX idx_sfoa_payload_type
  ON sfoa_audit_payload_evidence (payload_type, created_at);

CREATE INDEX idx_sfoa_payload_audit
  ON sfoa_audit_payload_evidence (audit_id, id);
