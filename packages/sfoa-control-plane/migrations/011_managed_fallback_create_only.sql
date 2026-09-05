-- Preserve migration 010 checksums; reject unsafe fallback history without rewriting rows.
ALTER TABLE sfoa_dml_managed_field_rule
  DROP CHECK chk_sfoa_dml_managed_field_strategy,
  ADD CONSTRAINT chk_sfoa_dml_managed_field_strategy CHECK (
    (strategy = 'PLATFORM_USER_LOOKUP'
      AND lookup_object_api_name IS NOT NULL AND lookup_match_field_api_name IS NOT NULL)
    OR
    (strategy = 'PLATFORM_USER_LOOKUP_FALLBACK' AND apply_on_create = 1 AND apply_on_update = 0
      AND lookup_object_api_name IS NOT NULL AND lookup_match_field_api_name IS NOT NULL)
    OR
    (strategy = 'AI_CREATED_MARKER' AND apply_on_create = 1 AND apply_on_update = 0
      AND lookup_object_api_name IS NULL AND lookup_match_field_api_name IS NULL)
  );
