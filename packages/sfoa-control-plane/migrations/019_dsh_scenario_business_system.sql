-- DSH scenario business system as a first-class, queryable field (DSH-01.1).
--
-- The DSH plugin has required a business system on every scenario card since 1.7.0 (CRM / TAPD /
-- other / custom, at most 32 characters, used as the workspace directory name), and since 1.8.0 it
-- has been round-tripping the value inside `scenarioPayload.businessSystem` through the payload
-- passthrough. The server therefore already stores the value but cannot filter, count or column it.
--
-- 1. `business_system` is a real column. VARCHAR(32) matches the plugin's own limit exactly, and
--    the table collation (utf8mb4_0900_ai_ci) makes `WHERE business_system = 'crm'` match 'CRM', so
--    the exact-match filter is case-insensitive without a LOWER() wrapper that would defeat the
--    index. DEFAULT 'CRM' is not cosmetic: a 1.7.0-era row has no hint at all, and CRM is the
--    workspace those scenarios have always opened into.
--
-- 2. Backfill. Existing rows take their value from the payload they already carry, and only when
--    that value could itself have passed the API contract (1-32 characters, no path or wildcard
--    characters). Anything else keeps the DEFAULT rather than being truncated into something the
--    plugin never saw. `revision` and `version` are deliberately untouched: a schema backfill is
--    not a new edition of the scenario, and bumping either would make every installed client
--    re-download an unchanged scenario.
--
-- 3. The payload copy is then made to agree with the column. Both are the same value from now on —
--    the column is what the Console filters on, the payload copy is what the plugin's pick() reads
--    first — and a row that disagrees is repaired here so the two can never tell different stories.
--
-- The index mirrors the read path: filter by business system, order by most recently updated.
--
-- Every UPDATE below assigns `updated_at` to itself on purpose: MySQL only auto-updates a
-- `ON UPDATE CURRENT_TIMESTAMP` column when the value actually changes, so this keeps `updated_at`
-- meaning "last time an operator edited this scenario" instead of "last time the schema moved".
ALTER TABLE crm_dsh_standard_scenarios
  ADD COLUMN business_system VARCHAR(32) NOT NULL DEFAULT 'CRM'
    COMMENT '所属业务系统 CRM/TAPD/其他/自定义，≤32 字符，用作插件工作区目录名' AFTER category;

UPDATE crm_dsh_standard_scenarios
SET business_system = TRIM(JSON_UNQUOTE(JSON_EXTRACT(scenario_payload, '$.businessSystem'))),
    updated_at = updated_at
WHERE JSON_TYPE(JSON_EXTRACT(scenario_payload, '$.businessSystem')) = 'STRING'
  AND CHAR_LENGTH(TRIM(JSON_UNQUOTE(JSON_EXTRACT(scenario_payload, '$.businessSystem')))) BETWEEN 1 AND 32;

UPDATE crm_dsh_standard_scenarios
SET business_system = 'CRM',
    updated_at = updated_at
WHERE business_system LIKE '%/%'
   OR business_system LIKE '%:%'
   OR business_system LIKE '%*%'
   OR business_system LIKE '%?%'
   OR business_system LIKE '%"%'
   OR business_system LIKE '%<%'
   OR business_system LIKE '%>%'
   OR business_system LIKE '%|%'
   OR LOCATE(CHAR(92), business_system) > 0;

UPDATE crm_dsh_standard_scenarios
SET scenario_payload = JSON_SET(scenario_payload, '$.businessSystem', business_system),
    updated_at = updated_at
WHERE NOT (JSON_UNQUOTE(JSON_EXTRACT(scenario_payload, '$.businessSystem')) <=> business_system);

CREATE INDEX idx_crm_dsh_scenario_business_system
  ON crm_dsh_standard_scenarios (business_system, updated_at);
