import { createHash, randomUUID } from 'node:crypto';
import { sql, type Selectable } from 'kysely';
import type { ControlPlaneDatabaseClient } from './database.js';
import type { UiSnapshotTable } from './schema.js';
import { ControlPlaneError } from './errors.js';

export type StoredUiSnapshot = Readonly<{
  id: string; organizationId: string; objectApiName: string; snapshot: unknown;
  hash: string | null; lastModified: string | null; refreshedAt: string | null;
  status: 'READY' | 'REFRESHING' | 'FAILED'; lastError: string | null; parserVersion: string;
}>;
export type UiSnapshotSummary = Omit<StoredUiSnapshot, 'snapshot'> & Readonly<{
  pages: readonly string[]; formSources: readonly string[]; apps: readonly string[];
  profileCount: number; recordTypeCount: number;
}>;
export class MySqlUiSnapshotRepository {
  public constructor(private readonly database: ControlPlaneDatabaseClient) {}
  public async get(organizationId: string, objectApiName: string): Promise<StoredUiSnapshot | undefined> {
    const row = await this.database.selectFrom('sfoa_ui_snapshot').selectAll()
      .where('organization_id', '=', organizationId).where('object_api_name', '=', objectApiName).executeTakeFirst();
    return row ? map(row) : undefined;
  }
  public async list(): Promise<readonly UiSnapshotSummary[]> {
    const rows = await this.database.selectFrom('sfoa_ui_snapshot')
      .select(['id', 'organization_id', 'object_api_name', 'content_hash', 'metadata_last_modified', 'refreshed_at', 'refresh_status', 'last_error', 'parser_version'])
      .select([
        sql<unknown>`JSON_EXTRACT(snapshot_json, '$.pages[*].fullName')`.as('pageNames'),
        sql<unknown>`JSON_EXTRACT(snapshot_json, '$.pages[*].formSource')`.as('formSources'),
        sql<unknown>`JSON_EXTRACT(snapshot_json, '$.apps[*].fullName')`.as('apps'),
        sql<number>`JSON_LENGTH(snapshot_json, '$.profiles')`.as('profileCount'),
        sql<number>`JSON_LENGTH(snapshot_json, '$.recordTypes')`.as('recordTypeCount'),
      ])
      .orderBy('object_api_name').limit(100).execute();
    return rows.map((row) => {
      const { snapshot: _snapshot, ...summary } = map({ ...row, snapshot_json: null, refresh_token: null, refresh_started_at: null });
      return { ...summary, pages: strings(row.pageNames), formSources: strings(row.formSources), apps: strings(row.apps),
        profileCount: row.profileCount ?? 0, recordTypeCount: row.recordTypeCount ?? 0 };
    });
  }
  /** Small database lease prevents duplicate refreshes across Admin processes. */
  public async beginRefresh(organizationId: string, objectApiName: string, parserVersion: string): Promise<string> {
    const token = randomUUID();
    await this.database.insertInto('sfoa_ui_snapshot').values({
      organization_id: organizationId, object_api_name: objectApiName, parser_version: parserVersion,
      snapshot_json: null, content_hash: null, metadata_last_modified: null, refreshed_at: null,
      refresh_status: 'FAILED', last_error: null, refresh_started_at: null, refresh_token: null,
    }).ignore().execute();
    const result = await this.database.updateTable('sfoa_ui_snapshot').set({
      refresh_status: 'REFRESHING', refresh_started_at: new Date(), refresh_token: token, last_error: null,
    }).where('organization_id', '=', organizationId).where('object_api_name', '=', objectApiName)
      .where((eb) => eb.or([eb('refresh_status', '!=', 'REFRESHING'), eb('refresh_started_at', '<', new Date(Date.now() - 180_000))]))
      .executeTakeFirst();
    if (!result.numUpdatedRows) throw new ControlPlaneError('MCP_CONTROL_PLANE_CONFLICT', 'UI snapshot refresh is already running.');
    return token;
  }
  public async finishRefresh(token: string, snapshot: unknown, parserVersion: string): Promise<void> {
    const encoded = JSON.stringify(snapshot);
    if (!encoded || Buffer.byteLength(encoded) > 2_097_152) throw new Error('SNAPSHOT_SIZE_BOUND');
    const result = await this.database.updateTable('sfoa_ui_snapshot').set({
      snapshot_json: encoded, content_hash: createHash('sha256').update(encoded).digest('hex'),
      refreshed_at: new Date(), refresh_status: 'READY', last_error: null, parser_version: parserVersion,
      refresh_token: null,
    }).where('refresh_token', '=', token).executeTakeFirstOrThrow();
    if (!result.numUpdatedRows) throw new ControlPlaneError('MCP_CONTROL_PLANE_CONFLICT', 'UI snapshot refresh lease expired.');
  }
  public async failRefresh(token: string, reason: string): Promise<void> {
    await this.database.updateTable('sfoa_ui_snapshot').set({ refresh_status: 'FAILED',
      last_error: /^[A-Z0-9_]{1,128}$/u.test(reason) ? reason : 'SNAPSHOT_REFRESH_FAILED', refresh_token: null,
    }).where('refresh_token', '=', token).execute();
  }
  public async sizeBytes(): Promise<number> {
    const result = await sql<{ bytes: string }>`SELECT COALESCE(SUM(JSON_STORAGE_SIZE(snapshot_json)), 0) AS bytes FROM sfoa_ui_snapshot`.execute(this.database);
    return Number(result.rows[0]?.bytes ?? 0);
  }
}
function strings(value: unknown): string[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
}
function map(row: Selectable<UiSnapshotTable>): StoredUiSnapshot {
  return { id: String(row.id), organizationId: row.organization_id, objectApiName: row.object_api_name,
    snapshot: typeof row.snapshot_json === 'string' ? JSON.parse(row.snapshot_json) as unknown : row.snapshot_json,
    hash: row.content_hash, lastModified: row.metadata_last_modified?.toISOString() ?? null,
    refreshedAt: row.refreshed_at?.toISOString() ?? null, status: row.refresh_status,
    lastError: row.last_error, parserVersion: row.parser_version };
}
