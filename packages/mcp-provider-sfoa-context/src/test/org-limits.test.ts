import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  countMeasuredLimits,
  orderLimitKeys,
  readLimitNumber,
  readOrgLimitEntries,
  readOrgLimitHighlights,
} from '../org-limits.js';
import { orgLimitsOutputSchema, ORG_LIMIT_HIGHLIGHT_ALIASES, ORG_LIMIT_HIGHLIGHT_SLOTS } from '../schemas.js';

/**
 * The derivation behind `get_org_limits` is pure, so it is tested here without a Connection, a
 * request role or a byte budget. The host-side executor that owns those is tested in
 * `packages/sfoa-mcp-server/src/test/org-limits-context-executor.test.ts`.
 *
 * A limits payload: the org's own keys, each a `{ Max, Remaining }` pair.
 */
function limitsPayload(entries: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...entries };
}

test('the five highlight slots are always present, in the documented order', () => {
  const entries = readOrgLimitEntries(limitsPayload({ SomeOtherLimit: { Max: 1, Remaining: 1 } }));
  const highlights = readOrgLimitHighlights(entries);

  assert.deepEqual(Object.keys(highlights), [...ORG_LIMIT_HIGHLIGHT_SLOTS]);
  // A slot the org does not meter is an answer, not a silence: present=false with everything null.
  for (const slot of ORG_LIMIT_HIGHLIGHT_SLOTS) {
    assert.deepEqual(highlights[slot], { key: null, present: false, max: null, remaining: null, used: null });
  }
});

test('a slot is filled by whichever documented key the org actually reports', () => {
  const entries = readOrgLimitEntries(limitsPayload({
    DailyBulkV2QueryJobs: { Max: 10_000, Remaining: 9_000 },
  }));
  const highlights = readOrgLimitHighlights(entries);

  // Bulk API 1.0 and 2.0 use different key names, and which one this org answered with is the fact
  // a caller comparing against Setup needs — so the slot reports the key that filled it.
  assert.deepEqual(highlights.dailyBulkApiRequests, {
    key: 'DailyBulkV2QueryJobs', present: true, max: 10_000, remaining: 9_000, used: 1_000,
  });
  assert.equal(ORG_LIMIT_HIGHLIGHT_ALIASES.dailyBulkApiRequests[0], 'DailyBulkApiRequests');
});

test('used is computed only when both ends are known and consistent', () => {
  const limits = readOrgLimitEntries(limitsPayload({
    BothKnown: { Max: 100, Remaining: 40 },
    MaxOnly: { Max: 200 },
    RemainingOnly: { Remaining: 5 },
    Inconsistent: { Max: 10, Remaining: 25 },
    ZeroBoth: { Max: 0, Remaining: 0 },
  }));

  assert.deepEqual(limits.get('BothKnown'), { max: 100, remaining: 40, used: 60, measured: true });
  // A concurrency limit reports only a maximum. Reporting `used: 0` for it would be an invented
  // fact, and a negative one for `Inconsistent` would be worse.
  assert.deepEqual(limits.get('MaxOnly'), { max: 200, remaining: null, used: null, measured: true });
  assert.deepEqual(limits.get('RemainingOnly'), { max: null, remaining: 5, used: null, measured: true });
  assert.deepEqual(limits.get('Inconsistent'), { max: 10, remaining: 25, used: null, measured: true });
  assert.deepEqual(limits.get('ZeroBoth'), { max: 0, remaining: 0, used: 0, measured: true });
});

test('a value this Tool cannot trust as a number is read as unmeasured, never coerced', () => {
  const limits = readOrgLimitEntries(limitsPayload({
    Readable: { Max: 1, Remaining: 1 },
    NumericString: { Max: '100', Remaining: '40' },
    Negative: { Max: -1, Remaining: -5 },
    NotFinite: { Max: Number.POSITIVE_INFINITY, Remaining: Number.NaN },
    NotAnObject: 7,
    NullEntry: null,
    ArrayEntry: [1, 2],
  }));

  // A string means the payload is not the shape this Tool was written against. Guessing at it would
  // put an invented quota in front of an Agent that is about to size a bulk job.
  assert.deepEqual(limits.get('Readable'), { max: 1, remaining: 1, used: 0, measured: true });
  for (const key of ['NumericString', 'Negative', 'NotFinite', 'NotAnObject', 'NullEntry', 'ArrayEntry']) {
    assert.deepEqual(limits.get(key), { max: null, remaining: null, used: null, measured: false }, key);
  }
  assert.equal(limits.size, 7);
  // The org did report values for these entries; they are simply not numbers this Tool can use, and
  // saying so is different from dropping the entries or from inventing a zero for them.
  assert.equal(countMeasuredLimits(limits), 1);
});

test('countMeasuredLimits is zero exactly when nothing readable came back', () => {
  assert.equal(countMeasuredLimits(readOrgLimitEntries(limitsPayload({}))), 0);
  assert.equal(countMeasuredLimits(readOrgLimitEntries(limitsPayload({ DailyApiRequests: { Max: '100' } }))), 0);
  // A maximum alone is measured: the org did report a usable number for that resource.
  assert.equal(countMeasuredLimits(readOrgLimitEntries(limitsPayload({ Limits: { Max: 10 } }))), 1);
});

test('the order is the slots first, then the rest alphabetically, so a trimmed read is reproducible', () => {
  const entries = readOrgLimitEntries(limitsPayload({
    ZooLimit: { Max: 1 },
    FileStorageMB: { Max: 2 },
    AlphaLimit: { Max: 3 },
    DailyApiRequests: { Max: 4 },
  }));

  assert.deepEqual(orderLimitKeys(entries), ['DailyApiRequests', 'FileStorageMB', 'AlphaLimit', 'ZooLimit']);
});

test('one org key fills at most one slot, even when two slots would match it', () => {
  // The alias table is a lookup, not a set of independent lists: a key claimed by an earlier slot is
  // not looked up again, or the same entry would appear twice under two different titles.
  const entries = readOrgLimitEntries(limitsPayload({ DailyBulkApiRequests: { Max: 1, Remaining: 1 } }));
  const ordered = orderLimitKeys(entries);

  assert.deepEqual(ordered, ['DailyBulkApiRequests']);
  const highlights = readOrgLimitHighlights(entries);
  assert.equal(highlights.dailyBulkApiRequests.present, true);
  assert.deepEqual(Object.keys(highlights), [...ORG_LIMIT_HIGHLIGHT_SLOTS]);
});

test('readLimitNumber accepts only a finite, non-negative number', () => {
  assert.equal(readLimitNumber(0), 0);
  assert.equal(readLimitNumber(1_000), 1_000);
  assert.equal(readLimitNumber(0.5), 0.5);
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1', null, undefined, {}, [], true]) {
    assert.equal(readLimitNumber(value), null, `${JSON.stringify(value) ?? String(value)} must not read as a number`);
  }
});

test('a key of zero length is skipped rather than returned as an unnamed limit', () => {
  const entries = readOrgLimitEntries({ '': { Max: 1 }, Named: { Max: 2 } });

  assert.deepEqual([...entries.keys()], ['Named']);
});

test('a payload that is not a plain object derives nothing at all', () => {
  for (const payload of [null, 'limits', 42, ['DailyApiRequests'], undefined]) {
    const entries = readOrgLimitEntries(payload);
    assert.equal(entries.size, 0, `${JSON.stringify(payload) ?? String(payload)} must derive no entries`);
    assert.equal(countMeasuredLimits(entries), 0);
    assert.deepEqual(orderLimitKeys(entries), []);
  }
});

test('every entry a derived result can carry satisfies the published output schema', () => {
  const entries = readOrgLimitEntries(limitsPayload({
    DailyApiRequests: { Max: 100, Remaining: 40 },
    Unreadable: { Max: 'many' },
  }));
  const limits = Object.fromEntries(entries);
  const output = {
    success: true,
    executionRole: 'DIAGNOSTIC',
    api: 'REST',
    verbose: false,
    limits,
    highlights: readOrgLimitHighlights(entries),
    totalLimits: entries.size,
    returnedLimits: orderLimitKeys(entries).length,
    unreadableLimits: entries.size - countMeasuredLimits(entries),
    truncated: false,
  };

  assert.deepEqual(orgLimitsOutputSchema.parse(output), output);
  assert.deepEqual(Object.keys(output.highlights), [...ORG_LIMIT_HIGHLIGHT_SLOTS]);
});
