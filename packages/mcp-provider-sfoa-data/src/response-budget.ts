/**
 * Documented response budget for every P9 Data Tool.
 *
 * MCP responses are consumed as model context, so a bounded result is part of the tool
 * contract rather than a performance detail. Tools keep their own smaller `limit`
 * arguments; this budget is the last line of defence for outputs whose per-item size is
 * not known ahead of time (a describe with 1000 fields and wide picklists).
 */
export const DATA_MAX_RESPONSE_BYTES = 262_144;

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
  const sizeOf = (count: number): number =>
    Buffer.byteLength(JSON.stringify(build(items.slice(0, count))), 'utf8');
  if (sizeOf(items.length) <= budgetBytes) return Object.freeze({ kept: items, truncated: false });
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (sizeOf(middle) <= budgetBytes) low = middle;
    else high = middle - 1;
  }
  return Object.freeze({ kept: Object.freeze(items.slice(0, low)), truncated: true });
}
