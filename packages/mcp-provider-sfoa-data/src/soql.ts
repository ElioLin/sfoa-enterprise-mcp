/**
 * Deterministic SOQL inspection for `query_records`.
 *
 * The rules here exist so an Agent gets a structural answer *before* a Salesforce round
 * trip: a statement this Tool cannot execute safely is refused with a reason it can act on,
 * rather than forwarded and reported back as a provider error.
 *
 * Every check runs against the query with its **string literals blanked out**, so the rules
 * describe the SOQL statement rather than the data inside it. A row filter such as
 * `WHERE Name = 'a;b'` is a legitimate query whose literal happens to contain a semicolon;
 * reading the raw text would reject it for the wrong reason.
 */

export type SoqlInspection =
  | Readonly<{ usable: false; message: string }>
  | Readonly<{ usable: true; aggregate: boolean }>;

/**
 * Blank out single-quoted literals, preserving length so indices and word boundaries in the
 * result still describe the original statement. `''` inside a literal is SOQL's escaped
 * quote, not a terminator.
 */
export function stripSoqlStringLiterals(query: string): Readonly<{ code: string; unterminated: boolean }> {
  let code = '';
  let inString = false;
  let index = 0;
  while (index < query.length) {
    const current = query[index] as string;
    if (inString) {
      if (current === "'") {
        if (query[index + 1] === "'") {
          code += '  ';
          index += 2;
          continue;
        }
        inString = false;
      }
      code += ' ';
      index += 1;
      continue;
    }
    if (current === "'") {
      inString = true;
      code += ' ';
      index += 1;
      continue;
    }
    code += current;
    index += 1;
  }
  return Object.freeze({ code, unterminated: inString });
}

/**
 * Decides whether `query_records` may execute a statement, and whether it is an aggregate.
 *
 * An aggregate query is worth distinguishing because its result is bounded by the
 * grouping, not by the row count: `truncated` on an aggregate can only mean `maxRows` was
 * set below the number of groups, which is a different fix from the one a detail query needs.
 */
export function inspectSoqlQuery(query: string): SoqlInspection {
  const { code, unterminated } = stripSoqlStringLiterals(query);
  if (unterminated) {
    return Object.freeze({
      usable: false,
      message: 'The query has an unterminated string literal: every opening \' needs a closing \' before the end of the statement.',
    });
  }
  if (code.includes(';')) {
    return Object.freeze({
      usable: false,
      message: 'The query must be a single SOQL statement. A semicolon outside a string literal is not accepted.',
    });
  }
  if (!/^\s*select\b/iu.test(code)) {
    return Object.freeze({
      usable: false,
      message: 'The query must begin with SELECT. This Tool reads records and cannot execute DML, SOSL or a statement that starts with anything else.',
    });
  }
  if (/\bfor\s+update\b/iu.test(code)) {
    return Object.freeze({
      usable: false,
      message: 'FOR UPDATE is not accepted: it locks the matched rows, which a read Tool must not do.',
    });
  }
  return Object.freeze({ usable: true, aggregate: isAggregateSoql(code) });
}

/**
 * Detects the aggregate shapes whose result is bounded by the grouping rather than by the
 * number of matching rows. The list is the documented one (GROUP BY, HAVING, COUNT) plus the
 * other aggregate functions, all matched against literal-blanked code.
 */
function isAggregateSoql(code: string): boolean {
  return /\bgroup\s+by\b/iu.test(code)
    || /\bhaving\b/iu.test(code)
    || /\b(?:count|sum|avg|min|max)\s*\(/iu.test(code);
}
