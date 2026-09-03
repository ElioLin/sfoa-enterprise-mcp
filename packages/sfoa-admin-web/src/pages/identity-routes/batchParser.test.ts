import { describe, expect, it } from 'vitest';
import {
  BATCH_ROW_LIMIT,
  IDENTITY_ROUTE_BATCH_HEADER,
  hasControlCharacter,
  parseIdentityRouteBatchText,
  reassessDraftRows,
} from './batchParser.js';

const T = '\t';

describe('identityRouteBatch parser', () => {
  it('parses a tab-delimited paste with the official header and tolerates Excel dropping the empty trailing 备注 cell', () => {
    const text = [
      IDENTITY_ROUTE_BATCH_HEADER,
      ['张三', 'zhangsan', 'zhang.san@example.com', '运营团队'].join(T),
      ['李四', 'lisi', 'li.si@example.com'].join(T), // empty remark dropped by Excel copy
    ].join('\n');
    const outcome = parseIdentityRouteBatchText(text);
    expect(outcome.error).toBeNull();
    expect(outcome.headerUsed).toBe(true);
    expect(outcome.columnCount).toBe(4);
    expect(outcome.rows).toHaveLength(2);
    expect(outcome.rows[0]).toMatchObject({
      userName: '张三',
      platformUserId: 'zhangsan',
      salesforceUsername: 'zhang.san@example.com',
      remark: '运营团队',
      errors: [],
    });
    expect(outcome.rows[1]?.remark).toBeNull();
    expect(outcome.rows[1]?.errors).toEqual([]);
  });

  it('falls back to the platform user as the user name for header-less 2-column rows', () => {
    const outcome = parseIdentityRouteBatchText('zhangsan\tzhang.san@example.com\nlisi\tli.si@example.com');
    expect(outcome.error).toBeNull();
    expect(outcome.headerUsed).toBe(false);
    expect(outcome.rows).toHaveLength(2);
    expect(outcome.rows[0]).toMatchObject({
      userName: 'zhangsan',
      platformUserId: 'zhangsan',
      salesforceUsername: 'zhang.san@example.com',
    });
  });

  it('parses header-less 3-column rows as 用户名称/平台用户/Salesforce Username', () => {
    const outcome = parseIdentityRouteBatchText('张三\tzhangsan\tzhang.san@example.com');
    expect(outcome.error).toBeNull();
    expect(outcome.rows[0]).toMatchObject({
      userName: '张三',
      platformUserId: 'zhangsan',
      salesforceUsername: 'zhang.san@example.com',
      remark: null,
    });
  });

  it('auto-detects comma and semicolon delimiters and ignores blank lines', () => {
    const comma = parseIdentityRouteBatchText('张三,zhangsan,zhang.san@example.com,运营\n\n李四,lisi,li.si@example.com,');
    expect(comma.error).toBeNull();
    expect(comma.rows).toHaveLength(2);
    expect(comma.rows[0]).toMatchObject({ userName: '张三', platformUserId: 'zhangsan', remark: '运营' });
    expect(comma.rows[1]).toMatchObject({ userName: '李四', platformUserId: 'lisi', remark: null });

    const semicolon = parseIdentityRouteBatchText('张三;zhangsan;zhang.san@example.com\n李四;lisi;li.si@example.com');
    expect(semicolon.error).toBeNull();
    expect(semicolon.rows).toHaveLength(2);
    expect(semicolon.rows[1]).toMatchObject({ userName: '李四', platformUserId: 'lisi' });
  });

  it('marks only later rows that duplicate a platform user inside the batch', () => {
    const outcome = parseIdentityRouteBatchText('A\tdup\tdup@example.com\nB\tdup\tother@example.com\nC\tc\tdiff@example.com');
    expect(outcome.rows).toHaveLength(3);
    expect(outcome.rows[0]?.errors).toEqual([]);
    expect(outcome.rows[1]?.errors).toContain('平台用户 dup 在批内重复');
    expect(outcome.rows[2]?.errors).toEqual([]);
  });

  it('flags duplicates against routes already saved in the Admin list', () => {
    const parsed = parseIdentityRouteBatchText('张三\tzhangsan\tzhang.san@example.com');
    const reassessed = reassessDraftRows(parsed.rows, new Set(['zhangsan']));
    expect(reassessed[0]?.errors).toEqual(['平台用户 zhangsan 已存在身份路由']);
  });

  it('rejects a header that contains a column it cannot recognize', () => {
    const outcome = parseIdentityRouteBatchText('平台用户\tSalesforce Username\t神秘列\nzhangsan\tzhang.san@example.com\tx');
    expect(outcome.error).toContain('无法识别的表头列');
    expect(outcome.rows).toHaveLength(0);
  });

  it('reports per-row structural errors when a data row cannot align to the header', () => {
    const outcome = parseIdentityRouteBatchText(`${IDENTITY_ROUTE_BATCH_HEADER}\nzhangsan\tzhang.san@example.com`);
    expect(outcome.error).toBeNull();
    expect(outcome.rows).toHaveLength(1);
    expect(outcome.rows[0]?.errors[0]).toContain('列数与表头');
  });

  it('reports field-level errors (empty / whitespace in Salesforce Username)', () => {
    const outcome = parseIdentityRouteBatchText('张三\t\tzhang.san@example.com\n李四\tplatform\tbad user@example.com');
    expect(outcome.rows[0]?.errors).toContain('缺少平台用户');
    expect(outcome.rows[1]?.errors.some((error) => error.includes('不能包含空格'))).toBe(true);
  });

  it('caps a single paste at the batch row limit', () => {
    const lines = Array.from({ length: BATCH_ROW_LIMIT + 1 }, (_value, index) => `张三\tplatform-${index}\tuser${index}@example.com`);
    const outcome = parseIdentityRouteBatchText(lines.join('\n'));
    expect(outcome.error).toContain('一次最多支持');
    expect(outcome.rows).toHaveLength(0);
  });

  it('detects control characters without encoding surprises', () => {
    expect(hasControlCharacter('a'.concat(String.fromCharCode(1), 'b'))).toBe(true);
    expect(hasControlCharacter('张三 normal')).toBe(false);
  });
});
