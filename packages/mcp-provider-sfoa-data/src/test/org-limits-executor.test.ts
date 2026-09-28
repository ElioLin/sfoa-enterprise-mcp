import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DataRuntimeError } from '../errors.js';
import {
  orderLimitKeys,
  OrgLimitsExecutor,
  readLimitNumber,
  readOrgLimitEntries,
  readOrgLimitHighlights,
} from '../org-limits-executor.js';
import { orgLimitsOutputSchema, ORG_LIMIT_HIGHLIGHT_ALIASES, ORG_LIMIT_HIGHLIGHT_SLOTS } from '../schemas.js';
import { createFixture, limitsPayload, salesforceError, type DataFixtureOptions } from './data-fixtures.js';

type Handler = NonNullable<DataFixtureOptions['handler']>;

function executor(handler: Handler) {
  const fixture = createFixture({ handler });
  const run = (input: Readonly<{ verbose?: boolean }> = {}) =>
    new OrgLimitsExecutor(fixture.orgService).execute(input);
  return { fixture, run };
}

function rejection(promise: Promise<unknown>): Promise<DataRuntimeError> {
  return promise.then(
    () => { throw new Error('expected the call to fail'); },
    (thrown: unknown) => thrown as DataRuntimeError,
  );
}

test('the five highlight slots are always present, in the documented order', async () => {
  const { run } = executor(() => limitsPayload({ SomeOtherLimit: { Max: 1, Remaining: 1 } }));
  const output = await run();

  assert.deepEqual(Object.keys(output.highlights ?? {}), [...ORG_LIMIT_HIGHLIGHT_SLOTS]);
  assert.deepEqual(orgLimitsOutputSchema.parse(output), output);
  // A slot the org does not meter is an answer, not a silence: present=false with everything null.
  for (const slot of ORG_LIMIT_HIGHLIGHT_SLOTS) {
    assert.deepEqual(output.highlights?.[slot], { key: null, present: false, max: null, remaining: null, used: null });
  }
});

test('a slot is filled by whichever documented key the org actually reports', async () => {
  const { run } = executor(() => limitsPayload({
    DailyBulkV2QueryJobs: { Max: 10_000, Remaining: 9_000 },
  }));
  const output = await run();

  // Bulk API 1.0 and 2.0 use different key names, and which one this org answered with is the fact
  // a caller comparing against Setup needs — so the slot reports the key that filled it.
  assert.deepEqual(output.highlights?.dailyBulkApiRequests, {
    key: 'DailyBulkV2QueryJobs', present: true, max: 10_000, remaining: 9_000, used: 1_000,
  });
  assert.equal(ORG_LIMIT_HIGHLIGHT_ALIASES.dailyBulkApiRequests[0], 'DailyBulkApiRequests');
});

test('used is computed only when both ends are known and consistent', async () => {
  const { run } = executor(() => limitsPayload({
    BothKnown: { Max: 100, Remaining: 40 },
    MaxOnly: { Max: 200 },
    RemainingOnly: { Remaining: 5 },
    Inconsistent: { Max: 10, Remaining: 25 },
    ZeroBoth: { Max: 0, Remaining: 0 },
  }));
  const output = await run();
  const limits = output.limits ?? {};

  assert.deepEqual(limits.BothKnown, { max: 100, remaining: 40, used: 60, measured: true });
  // A concurrency limit reports only a maximum. Reporting `used: 0` for it would be an invented
  // fact, and a negative one for `Inconsistent` would be worse.
  assert.deepEqual(limits.MaxOnly, { max: 200, remaining: null, used: null, measured: true });
  assert.deepEqual(limits.RemainingOnly, { max: null, remaining: 5, used: null, measured: true });
  assert.deepEqual(limits.Inconsistent, { max: 10, remaining: 25, used: null, measured: true });
  assert.deepEqual(limits.ZeroBoth, { max: 0, remaining: 0, used: 0, measured: true });
});

test('a value this Tool cannot trust as a number is read as unmeasured, never coerced', async () => {
  const { run } = executor(() => limitsPayload({
    Readable: { Max: 1, Remaining: 1 },
    NumericString: { Max: '100', Remaining: '40' },
    Negative: { Max: -1, Remaining: -5 },
    NotFinite: { Max: Number.POSITIVE_INFINITY, Remaining: Number.NaN },
    NotAnObject: 7,
    NullEntry: null,
    ArrayEntry: [1, 2],
  }));
  const output = await run();
  const limits = output.limits ?? {};

  // A string means the payload is not the shape this Tool was written against. Guessing at it would
  // put an invented quota in front of an Agent that is about to size a bulk job.
  assert.deepEqual(limits.Readable, { max: 1, remaining: 1, used: 0, measured: true });
  assert.deepEqual(limits.NumericString, { max: null, remaining: null, used: null, measured: false });
  assert.deepEqual(limits.Negative, { max: null, remaining: null, used: null, measured: false });
  assert.deepEqual(limits.NotFinite, { max: null, remaining: null, used: null, measured: false });
  assert.deepEqual(limits.NotAnObject, { max: null, remaining: null, used: null, measured: false });
  assert.deepEqual(limits.NullEntry, { max: null, remaining: null, used: null, measured: false });
  assert.deepEqual(limits.ArrayEntry, { max: null, remaining: null, used: null, measured: false });
  assert.equal(output.totalLimits, 7);
  assert.equal(output.returnedLimits, 7);

  // The org did report values for these entries; they are simply not numbers this Tool can use, and
  // saying so is different from dropping the entries or from inventing a zero for them.
  assert.equal(output.unreadableLimits, 6);
  assert.deepEqual(Object.keys(limits).sort(), [
    'ArrayEntry', 'Negative', 'NotAnObject', 'NotFinite', 'NullEntry', 'NumericString', 'Readable',
  ]);
});

test('a payload with nothing readable fails rather than reading as an org without limits', async () => {
  const { run } = executor(() => limitsPayload({ DailyApiRequests: { Max: '100' } }));
  const error = await rejection(run());

  assert.equal(error.code, 'MCP_LIMITS_READ_FAILED');
  assert.match(error.message, /no readable governor-limit entry/u);
  assert.match(error.suggestion ?? '', /never as unlimited/u);
});

test('a payload that is not a plain object at all is a read failure, not an empty success', async () => {
  for (const payload of [null, 'limits', 42, ['DailyApiRequests']]) {
    const { run } = executor(() => payload);
    const error = await rejection(run());
    assert.equal(error.code, 'MCP_LIMITS_READ_FAILED', `${JSON.stringify(payload)} must fail the read`);
  }
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

test('the verbosity switch is reported but never changes which limits are returned', async () => {
  const payload = () => limitsPayload({ DailyApiRequests: { Max: 100, Remaining: 40 } });

  const terse = await executor(payload).run({});
  const verbose = await executor(payload).run({ verbose: true });

  assert.equal(terse.verbose, false);
  assert.equal(verbose.verbose, true);
  assert.deepEqual(verbose.limits, terse.limits);
  assert.deepEqual(verbose.highlights, terse.highlights);
});

test('an oversized payload is trimmed at a reproducible point and the slots survive the cut', async () => {
  // ~6 KB per group of long keys, so the org's own table exceeds the response budget while the five
  // highlight slots stay at the front of the order.
  const entries: Record<string, unknown> = { DailyApiRequests: { Max: 100, Remaining: 40 } };
  for (let index = 0; index < 6_000; index += 1) {
    entries[`LongLimitKey_${index}_${'x'.repeat(32)}`] = { Max: index, Remaining: index };
  }
  const { run } = executor(() => limitsPayload(entries));
  const output = await run();

  assert.equal(output.truncated, true);
  assert.equal(output.totalLimits, 6_001);
  assert.ok((output.returnedLimits ?? 0) < output.totalLimits);
  assert.ok((output.returnedLimits ?? 0) > 0);
  assert.match(output.hint ?? '', /highlight slots are always kept/u);
  assert.match(output.hint ?? '', /262144-byte response budget/u);
  assert.deepEqual(Object.keys(output.highlights ?? {}), [...ORG_LIMIT_HIGHLIGHT_SLOTS]);
  assert.equal(output.highlights?.dailyApiRequests.present, true, 'the slots are never the part that is cut');
  assert.deepEqual(orgLimitsOutputSchema.parse(output), output);
  for (const key of Object.keys(output.limits ?? {})) {
    assert.ok(key === 'DailyApiRequests' || key.startsWith('LongLimitKey_'), key);
  }

  // The trimmed prefix is the same on a second run: the order is total, so the budget cuts at one place.
  const again = await executor(() => limitsPayload(entries)).run();
  assert.deepEqual(Object.keys(again.limits ?? {}), Object.keys(output.limits ?? {}));
});

test('an org that refuses the limits resource is reported as an access denial', async () => {
  const { fixture, run } = executor(() => {
    throw salesforceError('API_DISABLED_FOR_ORG', 'limits resource is not enabled');
  });
  const error = await rejection(run());

  assert.equal(error.code, 'MCP_LIMITS_ACCESS_DENIED');
  assert.match(error.message, /Salesforce reported: limits resource is not enabled/u);
  assert.match(error.suggestion ?? '', /quota visibility only/u);
  assert.deepEqual(fixture.calls, [{ operation: 'limits' }]);
});

test('an insufficient-privilege read is the same denial, because Salesforce reports one code for both causes', async () => {
  for (const code of ['INSUFFICIENT_ACCESS', 'INSUFFICIENT_PRIVILEGES', 'NOT_FOUND', 'INVALID_TYPE']) {
    const { run } = executor(() => { throw salesforceError(code, 'no access'); });
    const error = await rejection(run());
    assert.equal(error.code, 'MCP_LIMITS_ACCESS_DENIED', `${code} must map to the denial`);
  }
});

test('an unexpected provider failure is not reported as a Salesforce error code', async () => {
  const { run } = executor(() => { throw new Error('socket hang up'); });
  const error = await rejection(run());

  assert.equal(error.code, 'MCP_LIMITS_READ_FAILED');
  assert.match(error.message, /could not return the org's governor limits/u);
  assert.doesNotMatch(error.message, /socket hang up/u, 'a codeless failure is never echoed to the client');
});

test('a request that does not resolve to exactly one identity never reaches Salesforce', async () => {
  for (const usernames of [[], ['a@example.test', 'b@example.test']] as const) {
    const fixture = createFixture({ usernames: [...usernames] });
    const error = await rejection(new OrgLimitsExecutor(fixture.orgService).execute({}));

    assert.equal(error.code, 'MCP_DATA_IDENTITY_UNAVAILABLE');
    assert.deepEqual(fixture.calls, []);
  }
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
