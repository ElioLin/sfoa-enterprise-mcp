ALTER TABLE sfoa_salesforce_api_call
  ADD COLUMN has_next_records BOOLEAN NULL AFTER done,
  ADD COLUMN submitted_fields_json JSON NULL AFTER managed_fields_json;
