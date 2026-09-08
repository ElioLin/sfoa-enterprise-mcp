-- P8-05: WeCom enterprise MCP identity channel.
-- sfoa_audit_log.identity_source was introduced by 003_p6_identity_credential.sql as an
-- ENUM restricted to the three legacy channels. The fourth channel (WECOM_HEADER) is an
-- additive value; MySQL strict mode otherwise truncates and drops the whole audit batch
-- for a WeCom request. Same pattern as 012 extending payload_type.
ALTER TABLE sfoa_audit_log
  MODIFY COLUMN identity_source ENUM('INTERNAL_SERVICE_HEADER', 'USER_BOUND_TOKEN', 'BUNTU_TOKEN', 'WECOM_HEADER') NULL;
