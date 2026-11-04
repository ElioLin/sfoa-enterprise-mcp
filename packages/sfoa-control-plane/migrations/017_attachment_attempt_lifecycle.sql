-- Additive attachment attempt protection. Old FAILED rows remain non-retryable:
-- their historical error classification is not evidence that Salesforce rejected them.
-- Keep outcome metadata after the staged bytes expire; never reset UNKNOWN to STAGED.
ALTER TABLE sfoa_attachment_staging
  MODIFY COLUMN state ENUM('STAGED', 'CONSUMED', 'EXPIRED', 'FAILED', 'UPLOADING', 'OUTCOME_UNKNOWN', 'RETRYABLE') NOT NULL DEFAULT 'STAGED',
  ADD COLUMN bytes_removed_at DATETIME(3) NULL AFTER consumed_at,
  ADD INDEX idx_sfoa_attachment_retained_expiry (bytes_removed_at, expires_at, id);
