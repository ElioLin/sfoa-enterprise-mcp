ALTER TABLE sfoa_salesforce_api_call
  ADD COLUMN public_api_call_id CHAR(36) NULL AFTER id,
  ADD COLUMN transport_kind ENUM('HTTP', 'JSFORCE', 'SALESFORCE_CLI', 'OFFICIAL_PROVIDER', 'OTHER') NULL AFTER salesforce_username,
  ADD COLUMN visibility ENUM('EXACT_HTTP', 'OPERATION_ONLY') NULL AFTER transport_kind,
  ADD COLUMN request_url TEXT NULL AFTER endpoint,
  ADD COLUMN host VARCHAR(512) NULL AFTER request_url,
  ADD COLUMN endpoint_path TEXT NULL AFTER host,
  ADD COLUMN operation_name VARCHAR(256) NULL AFTER endpoint_path,
  ADD COLUMN request_size_bytes BIGINT UNSIGNED NULL AFTER salesforce_error_message_safe,
  ADD COLUMN response_size_bytes BIGINT UNSIGNED NULL AFTER request_size_bytes,
  ADD COLUMN content_type VARCHAR(256) NULL AFTER response_size_bytes;

ALTER TABLE sfoa_salesforce_api_call
  MODIFY COLUMN http_method ENUM('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS') NULL;

UPDATE sfoa_salesforce_api_call
SET public_api_call_id = UUID(),
    transport_kind = 'OTHER',
    visibility = 'OPERATION_ONLY',
    http_method = NULL,
    operation_name = 'LEGACY_API_EVIDENCE';

ALTER TABLE sfoa_salesforce_api_call
  MODIFY COLUMN api_category ENUM(
    'REST', 'DATA', 'UI', 'TOOLING', 'METADATA', 'CLI', 'WORKSPACE',
    'OAUTH', 'REST_API', 'UI_API', 'TOOLING_API', 'COMPOSITE_API', 'BULK_API',
    'APEX_REST_API', 'METADATA_API', 'SOAP_API', 'SALESFORCE_CLI', 'UNKNOWN'
  ) NOT NULL;

UPDATE sfoa_salesforce_api_call
SET api_category = CASE api_category
  WHEN 'REST' THEN 'REST_API'
  WHEN 'DATA' THEN 'REST_API'
  WHEN 'UI' THEN 'UI_API'
  WHEN 'TOOLING' THEN 'TOOLING_API'
  WHEN 'METADATA' THEN 'METADATA_API'
  WHEN 'CLI' THEN 'SALESFORCE_CLI'
  WHEN 'WORKSPACE' THEN 'METADATA_API'
  ELSE api_category
END;

ALTER TABLE sfoa_salesforce_api_call
  MODIFY COLUMN public_api_call_id CHAR(36) NOT NULL,
  MODIFY COLUMN salesforce_username VARCHAR(320) NULL,
  MODIFY COLUMN transport_kind ENUM('HTTP', 'JSFORCE', 'SALESFORCE_CLI', 'OFFICIAL_PROVIDER', 'OTHER') NOT NULL,
  MODIFY COLUMN visibility ENUM('EXACT_HTTP', 'OPERATION_ONLY') NOT NULL,
  MODIFY COLUMN api_category ENUM(
    'OAUTH', 'REST_API', 'UI_API', 'TOOLING_API', 'COMPOSITE_API', 'BULK_API',
    'APEX_REST_API', 'METADATA_API', 'SOAP_API', 'SALESFORCE_CLI', 'UNKNOWN'
  ) NOT NULL,
  MODIFY COLUMN http_method ENUM('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS') NULL,
  MODIFY COLUMN endpoint VARCHAR(1024) NULL;

ALTER TABLE sfoa_salesforce_api_call
  ADD CONSTRAINT uq_sfoa_sf_api_public_id UNIQUE (public_api_call_id),
  ADD CONSTRAINT chk_sfoa_sf_api_public_id CHECK (
    public_api_call_id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  ADD CONSTRAINT chk_sfoa_sf_api_visibility CHECK (
    (
      visibility = 'EXACT_HTTP'
      AND http_method IS NOT NULL
      AND request_url IS NOT NULL
      AND host IS NOT NULL
      AND endpoint_path IS NOT NULL
      AND operation_name IS NULL
    )
    OR
    (
      visibility = 'OPERATION_ONLY'
      AND http_method IS NULL
      AND request_url IS NULL
      AND host IS NULL
      AND endpoint_path IS NULL
      AND operation_name IS NOT NULL
    )
  );
