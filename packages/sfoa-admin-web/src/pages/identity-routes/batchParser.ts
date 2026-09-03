// Pure parsing and validation for the Admin identity-route batch import.
// This module intentionally avoids React/DOM so it can be unit-tested in isolation.

export type DraftRouteRow = Readonly<{
  key: string;
  userName: string;
  platformUserId: string;
  salesforceUsername: string;
  remark: string | null;
  /** Empty when the row is importable; otherwise human-readable (Chinese) reasons. */
  errors: readonly string[];
  /** True when the row's shape could not be aligned to a header/column count. */
  structural?: boolean;
}>;

export type BatchParseOutcome = Readonly<{
  rows: readonly DraftRouteRow[];
  headerUsed: boolean;
  /** How many data columns were recognized (2/3/4), 0 when unknown. */
  columnCount: number;
  /** A global parse error (delimiter/header shape). When present, `rows` is empty. */
  error: string | null;
}>;

export type ColumnRole = 'platformUserId' | 'userName' | 'salesforceUsername' | 'remark';

export const IDENTITY_ROUTE_BATCH_HEADER = '用户名称\t平台用户\tSalesforce Username\t备注';

export const IDENTITY_ROUTE_BATCH_EXAMPLE = [
  IDENTITY_ROUTE_BATCH_HEADER,
  '张三\tzhang.san\tzhang.san@example.com\t运营团队',
  '李四\tli.si\tli.si@example.com\t',
].join('\n');

const ROW_KEY_PREFIX = 'batch-row';

/** Must mirror the server-side ADMIN_IDENTITY_ROUTE_BATCH_MAX bound. */
export const BATCH_ROW_LIMIT = 200;

const HEADER_ALIASES: Readonly<Record<ColumnRole, readonly string[]>> = Object.freeze({
  platformUserId: Object.freeze(['platformuser', 'platformuserid', 'platform', '平台用户', '平台用户id']),
  userName: Object.freeze(['username', 'user name', 'displayname', '名称', '用户名', '用户名称', '姓名']),
  salesforceUsername: Object.freeze(['salesforceusername', 'sfusername', 'salesforce']),
  remark: Object.freeze(['备注', '说明', 'remark', 'note', 'comment', '注释']),
});

const DELIMITER_CANDIDATES: readonly string[] = Object.freeze(['\t', ',', ';']);

const COLUMN_ROLE_ORDER: readonly ColumnRole[] = Object.freeze(['platformUserId', 'userName', 'salesforceUsername', 'remark']);

export function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) return true;
  }
  return false;
}

function normalizeHeaderCell(value: string): string {
  return value.trim().toLocaleLowerCase('en-US').replace(/[\s_]+/gu, '');
}

function classifyHeaderCell(value: string): ColumnRole | null {
  const normalized = normalizeHeaderCell(value);
  if (!normalized) return null;
  for (const role of COLUMN_ROLE_ORDER) {
    if (HEADER_ALIASES[role].includes(normalized)) return role;
  }
  return null;
}

function hasWhitespace(value: string): boolean {
  return /\s/u.test(value);
}

/** Mirrors the control-plane userName/platform/Salesforce checks that guard the DB writes. */
export function validateDraftRowFields(input: Readonly<{
  userName: string;
  platformUserId: string;
  salesforceUsername: string;
  remark: string | null;
}>): readonly string[] {
  const errors: string[] = [];
  if (!input.userName) errors.push('缺少用户名称');
  else if (input.userName.length > 128) errors.push('用户名称超过 128 字符');
  if (input.userName && hasControlCharacter(input.userName)) errors.push('用户名称含非法控制字符');
  if (!input.platformUserId) errors.push('缺少平台用户');
  else if (input.platformUserId.length > 128) errors.push('平台用户超过 128 字符');
  if (input.platformUserId && hasControlCharacter(input.platformUserId)) errors.push('平台用户含非法控制字符');
  if (!input.salesforceUsername) errors.push('缺少 Salesforce Username');
  else if (input.salesforceUsername.length > 320) errors.push('Salesforce Username 超过 320 字符');
  if (input.salesforceUsername && (hasWhitespace(input.salesforceUsername) || hasControlCharacter(input.salesforceUsername))) {
    errors.push('Salesforce Username 不能包含空格或控制字符');
  }
  if (input.remark !== null && input.remark.length > 512) errors.push('备注超过 512 字符');
  return errors;
}

/**
 * Recompute every row's errors after inline edits or after a parse, including
 * in-batch duplicates and conflicts with routes already saved in the database.
 * Duplicate handling mirrors the server: the first occurrence of a platform
 * user stays importable, later ones are marked.
 */
export function reassessDraftRows(rows: readonly DraftRouteRow[], existingPlatformUserIds: ReadonlySet<string>): readonly DraftRouteRow[] {
  const firstKeyByPlatform = new Map<string, string>();
  const result: DraftRouteRow[] = [];
  for (const row of rows) {
    if (row.structural) {
      result.push(row);
      continue;
    }
    const errors = [...validateDraftRowFields(row)];
    const platformUserId = row.platformUserId.trim();
    if (platformUserId) {
      const existingKey = firstKeyByPlatform.get(platformUserId);
      if (existingKey !== undefined) {
        errors.push(`平台用户 ${platformUserId} 在批内重复`);
      } else {
        firstKeyByPlatform.set(platformUserId, row.key);
      }
      if (existingPlatformUserIds.has(platformUserId)) {
        errors.push(`平台用户 ${platformUserId} 已存在身份路由`);
      }
    }
    result.push({ ...row, errors: Object.freeze(errors) });
  }
  return result;
}

/**
 * Parse pasted/Excel text into draft identity routes.
 *
 * The delimiter is auto-detected (tab / comma / semicolon). An optional header
 * row is matched by column-name keyword; if the first line looks like a header
 * but contains a column we cannot recognize, the whole paste is rejected so the
 * operator does not silently shift columns. Without a header, each row is
 * interpreted positionally: 2 columns are 平台用户 + Salesforce Username (user
 * name falls back to the platform user), 3 are 用户名称/平台用户/Salesforce
 * Username, and 4 add an optional trailing 备注.
 */
export function parseIdentityRouteBatchText(text: string): BatchParseOutcome {
  const empty = Object.freeze({ rows: Object.freeze([] as readonly DraftRouteRow[]), headerUsed: false, columnCount: 0, error: null });
  const lines = text
    .split(/\r\n|\r|\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { ...empty, error: '请粘贴至少一行数据。' };

  const delimiter = detectDelimiter(lines);
  if (!delimiter) {
    return { ...empty, error: '未能识别列分隔符，请使用 Tab、逗号或分号分隔列，每行一条。' };
  }

  const cellLines = lines.map((line) => line.split(delimiter).map((cell) => cell.trim()));

  const firstRoles = (cellLines[0] as readonly string[]).map(classifyHeaderCell);
  const recognized = firstRoles.filter((role): role is ColumnRole => role !== null);
  const headerLooksRecognizable = recognized.includes('platformUserId')
    && recognized.includes('salesforceUsername')
    && recognized.length >= 2;
  let headerUsed = false;
  let headerRoles: readonly ColumnRole[] = [];
  if (headerLooksRecognizable) {
    if (recognized.length < firstRoles.length) {
      const unknown = (cellLines[0] as readonly string[])
        .filter((cell) => classifyHeaderCell(cell) === null)
        .map((cell) => `「${cell}」`)
        .join('、');
      return { ...empty, error: `无法识别的表头列：${unknown}。请使用表头：${IDENTITY_ROUTE_BATCH_HEADER}` };
    }
    headerUsed = true;
    headerRoles = firstRoles as readonly ColumnRole[];
  }

  const dataLines = headerUsed ? cellLines.slice(1) : cellLines;
  if (dataLines.length > BATCH_ROW_LIMIT) {
    return { ...empty, headerUsed, columnCount: headerRoles.length, error: `一次最多支持 ${BATCH_ROW_LIMIT} 条，请分批粘贴。` };
  }
  const rows: DraftRouteRow[] = [];
  dataLines.forEach((cells, dataIndex) => {
    const key = `${ROW_KEY_PREFIX}-${dataIndex + 1}`;
    if (headerUsed) {
      const mapped = mapCellsByHeader(cells, headerRoles);
      if (mapped === null) {
        rows.push(Object.freeze({
          key,
          userName: '',
          platformUserId: cells[0] ?? '',
          salesforceUsername: cells[1] ?? '',
          remark: null,
          structural: true,
          errors: Object.freeze([`列数与表头（${headerRoles.length} 列）不符。`]),
        }));
        return;
      }
      rows.push(buildDraftRow(key, mapped));
      return;
    }
    const mapped = mapCellsPositionally(cells);
    if (mapped === null) {
      rows.push(Object.freeze({
        key,
        userName: '',
        platformUserId: cells[0] ?? '',
        salesforceUsername: cells[1] ?? '',
        remark: null,
        structural: true,
        errors: Object.freeze(['该行需要 2–4 列（平台用户+Salesforce 或 用户名称/平台用户/Salesforce[/备注]）。']),
      }));
      return;
    }
    rows.push(buildDraftRow(key, mapped));
  });

  if (rows.length === 0) {
    return { ...empty, headerUsed, columnCount: headerRoles.length, error: headerUsed ? '表头之后没有数据行。' : '没有可识别的数据行。' };
  }
  return Object.freeze({
    rows: Object.freeze(reassessDraftRows(rows, new Set())),
    headerUsed,
    columnCount: headerRoles.length || inferColumnCount(rows),
    error: null,
  });
}

function buildDraftRow(
  key: string,
  fields: Readonly<{ userName: string; platformUserId: string; salesforceUsername: string; remark: string | null }>,
): DraftRouteRow {
  return Object.freeze({
    key,
    userName: fields.userName,
    platformUserId: fields.platformUserId,
    salesforceUsername: fields.salesforceUsername,
    remark: fields.remark,
    errors: Object.freeze(validateDraftRowFields(fields)),
  });
}

function detectDelimiter(lines: readonly string[]): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const candidate of DELIMITER_CANDIDATES) {
    let score = 0;
    for (const line of lines) {
      score += line.split(candidate).length - 1;
    }
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function mapCellsByHeader(
  cells: readonly string[],
  headerRoles: readonly ColumnRole[],
): Readonly<{ userName: string; platformUserId: string; salesforceUsername: string; remark: string | null }> | null {
  // Excel drops trailing empty cells; the only acceptable shortfall is a blank
  // final 备注 column. Anything shorter cannot align to the header positions.
  if (cells.length < headerRoles.length - 1 || cells.length > headerRoles.length) return null;
  const values: Record<ColumnRole, string> = { platformUserId: '', userName: '', salesforceUsername: '', remark: '' };
  headerRoles.forEach((role, index) => {
    if (index < cells.length) values[role] = cells[index] ?? '';
  });
  return {
    userName: values.userName,
    platformUserId: values.platformUserId,
    salesforceUsername: values.salesforceUsername,
    remark: values.remark ? values.remark : null,
  };
}

function mapCellsPositionally(
  cells: readonly string[],
): Readonly<{ userName: string; platformUserId: string; salesforceUsername: string; remark: string | null }> | null {
  if (cells.length === 2) {
    return { userName: cells[0] ?? '', platformUserId: cells[0] ?? '', salesforceUsername: cells[1] ?? '', remark: null };
  }
  if (cells.length === 3) {
    return { userName: cells[0] ?? '', platformUserId: cells[1] ?? '', salesforceUsername: cells[2] ?? '', remark: null };
  }
  if (cells.length === 4) {
    const remark = (cells[3] ?? '').trim();
    return { userName: cells[0] ?? '', platformUserId: cells[1] ?? '', salesforceUsername: cells[2] ?? '', remark: remark ? remark : null };
  }
  return null;
}

function inferColumnCount(rows: readonly DraftRouteRow[]): number {
  const sample = rows.find((row) => row.platformUserId || row.salesforceUsername);
  if (!sample) return 0;
  if (sample.remark !== null) return 4;
  if (sample.userName && sample.userName !== sample.platformUserId) return 3;
  return 2;
}
