import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMinimalPatch, assertMinimalPatch, evaluateCreateReadiness, evaluateOwnerIntent } from './record-change-gates.mjs';

// This is a test oracle with Agent-prepared facts, not a parser, authorizer or Runtime engine.
test('task patch includes unspoken related fields and faithful synthesis but preserves unrelated reads', () => {
  const result = buildMinimalPatch({ taskFields: ['summary', 'country', 'province', 'city'], readFacts: {
    summary: { present: true, value: '样品仍在测试，数量未定；下周跟进' },
    country: { present: true, value: '中国' }, province: { present: true, value: '福建省' }, city: { present: true, value: '厦门市' },
    unrelated: { present: true, value: 'do not rewrite' },
  } });
  assert.deepEqual(result.patch, { summary: '样品仍在测试，数量未定；下周跟进', country: '中国', province: '福建省', city: '厦门市' });
  assert.deepEqual(result.preserved, ['unrelated']);
  assert.equal(assertMinimalPatch({ patch: result.patch, taskFields: ['summary', 'country', 'province', 'city'] }).minimal, true);
});

test('relocation changes the address group and omits unchanged country', () => {
  const result = buildMinimalPatch({ taskFields: ['country', 'province', 'city'],
    currentValues: { country: '中国', province: '广东省', city: '深圳市' },
    readFacts: { country: { present: true, value: '中国' }, province: { present: true, value: '福建省' }, city: { present: true, value: '厦门市' } },
  });
  assert.deepEqual(result.patch, { province: '福建省', city: '厦门市' });
});

test('a summary-only task or incidental visit location cannot enlarge the company address patch', () => {
  const result = buildMinimalPatch({ taskFields: ['summary'], readFacts: {
    summary: { present: true, value: '在厦门拜访，尚未承诺采购' },
    companyCity: { present: true, value: '厦门市' },
  } });
  assert.deepEqual(result.patch, { summary: '在厦门拜访，尚未承诺采购' });
  assert.equal(assertMinimalPatch({ patch: { companyCity: '厦门市' }, taskFields: ['summary'] }).minimal, false);
});

test('applicable configured CREATE fallback satisfies requiredness without a question or Agent-generated ID', () => {
  const ready = evaluateCreateReadiness({ fields: [{ apiName: 'owner', apiRequired: true }], runtimeSatisfiedFields: ['owner'] });
  assert.equal(ready.changeReady, true);
  assert.equal(evaluateCreateReadiness({ fields: [{ apiName: 'owner', apiRequired: true }] }).changeReady, false);
  for (const count of [0, 2]) assert.equal(evaluateOwnerIntent({ requested: true, matchCount: count }).fallbackAllowed, false);
  assert.equal(evaluateOwnerIntent({ requested: false }).inject, false, 'unrelated UPDATE does not replay CREATE fallback');
});
