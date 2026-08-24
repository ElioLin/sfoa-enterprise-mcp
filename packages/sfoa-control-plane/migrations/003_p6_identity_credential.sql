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
