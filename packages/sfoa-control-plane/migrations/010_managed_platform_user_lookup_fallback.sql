-- Append the strategy without changing existing ENUM ordinals or configured rules.
ALTER TABLE sfoa_dml_managed_field_rule
  DROP CHECK chk_sfoa_dml_managed_field_strategy,
  MODIFY COLUMN strategy ENUM('PLATFORM_USER_LOOKUP', 'AI_CREATED_MARKER', 'PLATFORM_USER_LOOKUP_FALLBACK') NOT NULL,
  ADD CONSTRAINT chk_sfoa_dml_managed_field_strategy CHECK (
    (strategy IN ('PLATFORM_USER_LOOKUP', 'PLATFORM_USER_LOOKUP_FALLBACK')
      AND lookup_object_api_name IS NOT NULL AND lookup_match_field_api_name IS NOT NULL)
    OR
    (strategy = 'AI_CREATED_MARKER' AND apply_on_create = 1 AND apply_on_update = 0
      AND lookup_object_api_name IS NULL AND lookup_match_field_api_name IS NULL)
  );
