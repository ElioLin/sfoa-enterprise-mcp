/**
 * Documented response budget for every P9 Data Tool.
 *
 * MCP responses are consumed as model context, so a bounded result is part of the tool
 * contract rather than a performance detail. Tools keep their own smaller `limit`
 * arguments; this budget is the last line of defence for outputs whose per-item size is
 * not known ahead of time (a describe with 1000 fields and wide picklists).
 */
export const DATA_MAX_RESPONSE_BYTES = 262_144;

/**
 * Character budget for the human-readable text of `query_records`.
 *
 * A query result is business data whose rows are not known ahead of time, so the text the
 * Agent reads is bounded separately from the byte budget that bounds the structured payload:
 * the two are measured in the unit each one is actually consumed in.
 */
export const DATA_MAX_QUERY_TEXT_CHARACTERS = 60_000;

export type ByteBudgetResult<T> = Readonly<{ kept: readonly T[]; truncated: boolean }>;

/**
 * Keeps the longest prefix of `items` whose full serialized output fits `budgetBytes`.
 *
 * `build` renders the complete output for a candidate prefix, so the measurement includes
 * every field the caller would actually return — a budget that only measured the item
 * array would be wrong. It is only measured, never inspected, hence the `unknown` return.
 * Binary search keeps this to ~log2(n) serializations.
 */
export function trimToByteBudget<T>(
  items: readonly T[],
  budgetBytes: number,
  build: (kept: readonly T[]) => unknown,
): ByteBudgetResult<T> {
  return trimToBudget(items, budgetBytes, (text) => Buffer.byteLength(text, 'utf8'), build);
}

/**
 * The same prefix search measured in **characters**: the unit the rendered text is bounded
 * in. A caller that must satisfy both bounds applies this to the result of
 * `trimToByteBudget`, which is correct because both measurements grow with the prefix.
 */
export function trimToCharacterBudget<T>(
  items: readonly T[],
  budgetCharacters: number,
  build: (kept: readonly T[]) => unknown,
): ByteBudgetResult<T> {
  return trimToBudget(items, budgetCharacters, (text) => text.length, build);
}

function trimToBudget<T>(
  items: readonly T[],
  budget: number,
  measure: (text: string) => number,
  build: (kept: readonly T[]) => unknown,
): ByteBudgetResult<T> {
  const sizeOf = (count: number): number => measure(JSON.stringify(build(items.slice(0, count))));
  if (sizeOf(items.length) <= budget) return Object.freeze({ kept: items, truncated: false });
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (sizeOf(middle) <= budget) low = middle;
    else high = middle - 1;
  }
  return Object.freeze({ kept: Object.freeze(items.slice(0, low)), truncated: true });
}
