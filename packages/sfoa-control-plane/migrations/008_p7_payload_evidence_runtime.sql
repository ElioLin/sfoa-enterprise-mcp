-- P7-06 may safely know only a bounded payload prefix. Unknown original byte
-- size remains NULL rather than being falsified as the stored prefix size.
ALTER TABLE sfoa_audit_payload_evidence
  MODIFY COLUMN original_size_bytes BIGINT UNSIGNED NULL;
