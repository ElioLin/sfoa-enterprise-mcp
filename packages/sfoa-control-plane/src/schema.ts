import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type BooleanNumber = ColumnType<number, number | boolean, number | boolean>;

export interface IdentityRouteTable {
  id: Generated<string>;
  platform_user_id: string;
  salesforce_username: string;
  enabled: BooleanNumber;
  remark: string | null;
  row_version: Generated<string>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface IdentityCredentialTable {
  id: Generated<string>;
  identity_route_id: string;
  credential_type: string;
  token_hash: string;
  token_ciphertext: string | null;
  token_last4: string;
  status: string;
  generated_at: Timestamp;
  last_used_at: Timestamp | null;
  revoked_at: Timestamp | null;
  active_identity_route_id: Generated<string | null>;
  row_version: Generated<string>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ToolControlTable {
  id: Generated<string>;
  tool_name: string;
  enabled: BooleanNumber;
  remark: string | null;
  row_version: Generated<string>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface DmlPolicyTable {
  id: Generated<string>;
  object_api_name: string;
  allow_create: BooleanNumber;
  allow_update: BooleanNumber;
  enabled: BooleanNumber;
  remark: string | null;
  row_version: Generated<string>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface DmlManagedFieldRuleTable {
  id: Generated<string>;
  dml_policy_id: string;
  target_field_api_name: string;
  strategy: string;
  apply_on_create: BooleanNumber;
  apply_on_update: BooleanNumber;
  lookup_object_api_name: string | null;
  lookup_match_field_api_name: string | null;
  enabled: BooleanNumber;
  remark: string | null;
  row_version: Generated<string>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface DiagnosticConfigTable {
  id: string;
  salesforce_username: string;
  enabled: BooleanNumber;
  verification_status: string;
  last_verified_at: Timestamp | null;
  last_error_code: string | null;
  last_error_message_safe: string | null;
  test_metadata_type: string | null;
  test_metadata_full_name: string | null;
  row_version: Generated<string>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface RuntimeSettingTable {
  setting_key: string;
  setting_value_json: string;
  row_version: Generated<string>;
  updated_at: GeneratedTimestamp;
}

export interface AuditLogTable {
  id: Generated<string>;
  public_audit_id: Generated<string>;
  audit_kind: string;
  occurred_at: Timestamp;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  correlation_id: string;
  channel: string;
  client_id: string | null;
  actor_admin: string | null;
  platform_user_id: string | null;
  salesforce_username: string | null;
  execution_role: string | null;
  identity_source: string | null;
  identity_credential_id: string | null;
  tool_name: string | null;
  operation: string | null;
  object_api_name: string | null;
  record_id: string | null;
  result: string;
  outcome: string | null;
  error_code: string | null;
  error_message_safe: string | null;
  audit_integrity_status: string;
  duration_ms: number | null;
  request_summary_json: string | null;
  response_summary_json: string | null;
  created_at: GeneratedTimestamp;
}

export interface AuditEventTable {
  id: Generated<string>;
  audit_id: string;
  sequence: number;
  parent_event_id: string | null;
  event_category: string;
  event_type: string;
  event_name: string;
  started_at: Timestamp;
  completed_at: Timestamp | null;
  duration_ms: number | null;
  status: string;
  error_code: string | null;
  safe_summary_json: string | null;
  created_at: GeneratedTimestamp;
}

export interface SalesforceApiCallTable {
  id: Generated<string>;
  public_api_call_id: string;
  audit_id: string;
  audit_event_id: string | null;
  sequence: number;
  salesforce_username: string | null;
  transport_kind: string;
  visibility: string;
  api_category: string;
  http_method: string | null;
  endpoint: string | null;
  request_url: string | null;
  host: string | null;
  endpoint_path: string | null;
  operation_name: string | null;
  api_version: string | null;
  purpose: string;
  started_at: Timestamp;
  completed_at: Timestamp | null;
  duration_ms: number | null;
  http_status: number | null;
  result: string;
  salesforce_error_code: string | null;
  salesforce_error_message_safe: string | null;
  request_size_bytes: string | null;
  response_size_bytes: string | null;
  content_type: string | null;
  query_type: string | null;
  soql_statement_safe: string | null;
  total_size: number | null;
  returned_records: number | null;
  done: BooleanNumber | null;
  has_next_records: BooleanNumber | null;
  dml_operation: string | null;
  object_api_name: string | null;
  record_id: string | null;
  requested_fields_json: string | null;
  managed_fields_json: string | null;
  submitted_fields_json: string | null;
  created_at: GeneratedTimestamp;
}

export interface AuditPayloadEvidenceTable {
  id: Generated<string>;
  audit_id: string;
  salesforce_api_call_id: string | null;
  audit_event_id: string | null;
  payload_type: string;
  content_type: string;
  original_size_bytes: string | null;
  stored_size_bytes: number;
  truncated: BooleanNumber;
  content_sha256: string | null;
  safe_payload: string | null;
  created_at: GeneratedTimestamp;
}

export interface SchemaMigrationTable {
  version: string;
  checksum_sha256: string;
  applied_at: GeneratedTimestamp;
}

export interface ControlPlaneDatabase {
  sfoa_identity_route: IdentityRouteTable;
  sfoa_identity_credential: IdentityCredentialTable;
  sfoa_tool_control: ToolControlTable;
  sfoa_dml_policy: DmlPolicyTable;
  sfoa_dml_managed_field_rule: DmlManagedFieldRuleTable;
  sfoa_diagnostic_config: DiagnosticConfigTable;
  sfoa_runtime_setting: RuntimeSettingTable;
  sfoa_audit_log: AuditLogTable;
  sfoa_audit_event: AuditEventTable;
  sfoa_salesforce_api_call: SalesforceApiCallTable;
  sfoa_audit_payload_evidence: AuditPayloadEvidenceTable;
  sfoa_schema_migration: SchemaMigrationTable;
}
