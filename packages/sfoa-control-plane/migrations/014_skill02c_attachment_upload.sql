-- Skill-02C: attachment upload capability.
--
-- 1. sfoa_dml_policy.attachment_enabled is a capability independent of allow_create /
--    allow_update. DEFAULT FALSE is deliberate: every object that already exists keeps
--    exactly today's behaviour, and an operator must opt an object into attachments.
--    It is NOT derived from allow_create && allow_update — an object may accept a new
--    attachment on an existing record without permitting any field update.
--
-- 2. sfoa_attachment_staging records the inbound attachment that an OpenClaw turn
--    handed to the SFOA Attachment Ingress. It stores the file's identity and the
--    path of the controlled copy on the SFOA host; it never stores file bytes.
--    attachment_ref is requester-scoped: a ref is only usable by the platform user
--    it was minted for, and expires_at bounds its lifetime. Expiry is an
--    infrastructure property of the staging copy, not a Salesforce file policy.
ALTER TABLE sfoa_dml_policy
  ADD COLUMN attachment_enabled BOOLEAN NOT NULL DEFAULT FALSE AFTER allow_update;

CREATE TABLE IF NOT EXISTS sfoa_attachment_staging (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  attachment_ref VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  platform_user_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NOT NULL,
  source_channel VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs NULL,
  file_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(128) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
  byte_size BIGINT UNSIGNED NOT NULL,
  content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  staged_path VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  state ENUM('STAGED', 'CONSUMED', 'EXPIRED', 'FAILED') NOT NULL DEFAULT 'STAGED',
  failure_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  CONSTRAINT uq_sfoa_attachment_staging_ref UNIQUE (attachment_ref),
  CONSTRAINT chk_sfoa_attachment_staging_size CHECK (byte_size > 0),
  CONSTRAINT chk_sfoa_attachment_staging_lifetime CHECK (expires_at > created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX idx_sfoa_attachment_staging_owner
  ON sfoa_attachment_staging (platform_user_id, state, id);

CREATE INDEX idx_sfoa_attachment_staging_expiry
  ON sfoa_attachment_staging (state, expires_at);
