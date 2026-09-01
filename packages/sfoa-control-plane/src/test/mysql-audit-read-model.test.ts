import assert from 'node:assert/strict';
import test from 'node:test';
import { MySqlAuditRepository } from '../mysql-audit-repository.js';

const CREATED_AT = new Date('2026-09-01T00:00:00.000Z');

test('payload metadata projection never selects safe_payload while detail reads the body on demand', async () => {
  const database = new FakeDatabase([payloadRow()]);
  const repository = new MySqlAuditRepository(
    database as unknown as ConstructorParameters<typeof MySqlAuditRepository>[0],
  );

  const metadata = await repository.listPayloadEvidenceMetadata('1', { limit: 10, offset: 0 });
  const metadataQuery = database.queries[0];
  assert.ok(metadataQuery);
  assert.equal(metadataQuery.selectAllCalled, false);
  assert.equal(metadataQuery.selectedColumns.includes('safe_payload'), false);
  assert.deepEqual(metadataQuery.selectedColumns, [
    'id', 'audit_id', 'salesforce_api_call_id', 'audit_event_id', 'payload_type', 'content_type',
    'original_size_bytes', 'stored_size_bytes', 'truncated', 'content_sha256', 'created_at',
  ]);
  assert.equal('safePayload' in metadata.items[0]!, false);

  const detail = await repository.getPayloadEvidenceById('30');
  assert.equal(database.queries[1]?.selectAllCalled, true);
  assert.equal(detail?.safePayload, '{"ok":true}');
});

test('audit search applies every P7-07 filter to the master table without detail joins', async () => {
  const database = new FakeDatabase([]);
  const repository = new MySqlAuditRepository(
    database as unknown as ConstructorParameters<typeof MySqlAuditRepository>[0],
  );
  await repository.search({
    occurredFrom: new Date('2026-08-31T00:00:00.000Z'),
    occurredTo: new Date('2026-09-01T00:00:00.000Z'),
    auditId: '11111111-1111-4111-8111-111111111111',
    correlationId: 'corr-1',
    platformUserId: 'platform-a',
    salesforceUsername: 'sf-user@example.com',
    toolName: 'create_record',
    result: 'ERROR',
    outcome: 'UNKNOWN',
    errorCode: 'MCP_DML_OUTCOME_UNKNOWN',
    objectApiName: 'Lead',
    recordId: '00Q000000000001AAA',
    auditKind: 'MCP_TOOL_CALL',
    auditIntegrityStatus: 'PARTIAL',
    limit: 25,
    offset: 0,
  });

  const query = database.queries[0];
  assert.ok(query);
  assert.equal(database.tables[0], 'sfoa_audit_log');
  assert.equal(query.selectAllCalled, true);
  assert.deepEqual(query.whereCalls.map((entry) => entry.column), [
    'occurred_at', 'occurred_at', 'public_audit_id', 'correlation_id', 'platform_user_id',
    'salesforce_username', 'tool_name', 'result', 'outcome', 'error_code', 'object_api_name',
    'record_id', 'audit_kind', 'audit_integrity_status',
  ]);
});

type WhereCall = Readonly<{ column: string; operator: string; value: unknown }>;

class FakeQuery {
  public selectedColumns: readonly string[] = Object.freeze([]);
  public selectAllCalled = false;
  public readonly whereCalls: WhereCall[] = [];

  public constructor(private readonly rows: readonly unknown[]) {}

  public select(columns: readonly string[]): this {
    this.selectedColumns = Object.freeze([...columns]);
    return this;
  }

  public selectAll(): this {
    this.selectAllCalled = true;
    return this;
  }

  public where(column: string, operator: string, value: unknown): this {
    this.whereCalls.push(Object.freeze({ column, operator, value }));
    return this;
  }

  public orderBy(): this { return this; }
  public limit(): this { return this; }
  public offset(): this { return this; }
  public async execute(): Promise<readonly unknown[]> { return this.rows; }
  public async executeTakeFirst(): Promise<unknown> { return this.rows[0]; }
}

class FakeDatabase {
  public readonly tables: string[] = [];
  public readonly queries: FakeQuery[] = [];

  public constructor(private readonly rows: readonly unknown[]) {}

  public selectFrom(table: string): FakeQuery {
    this.tables.push(table);
    const query = new FakeQuery(this.rows);
    this.queries.push(query);
    return query;
  }
}

function payloadRow(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: '30',
    audit_id: '1',
    salesforce_api_call_id: null,
    audit_event_id: null,
    payload_type: 'MCP_RESPONSE',
    content_type: 'application/json',
    original_size_bytes: '11',
    stored_size_bytes: 11,
    truncated: 0,
    content_sha256: 'a'.repeat(64),
    safe_payload: '{"ok":true}',
    created_at: CREATED_AT,
  });
}
