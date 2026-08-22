import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DmlRuntimeError,
  parseDmlAllowlistJson,
} from '../index.js';

test('missing and empty DML configuration deny every object', () => {
  for (const value of [undefined, '', '   ', '[]']) {
    const policy = parseDmlAllowlistJson(value);
    assert.deepEqual(policy.getRules(), []);
    assert.throws(
      () => policy.assertAllowed('Lead', 'CREATE'),
      isDmlError('MCP_DML_OBJECT_NOT_ALLOWED'),
    );
  }
});

test('Object x Operation policy allows only the configured pairs', () => {
  const policy = parseDmlAllowlistJson(JSON.stringify([
    { objectApiName: 'Lead', operations: ['CREATE'] },
    { objectApiName: 'Account', operations: ['UPDATE'] },
  ]));

  assert.doesNotThrow(() => policy.assertAllowed('Lead', 'CREATE'));
  assert.doesNotThrow(() => policy.assertAllowed('account', 'UPDATE'));
  assert.throws(
    () => policy.assertAllowed('Lead', 'UPDATE'),
    isDmlError('MCP_DML_OPERATION_NOT_ALLOWED'),
  );
  assert.throws(
    () => policy.assertAllowed('Account', 'CREATE'),
    isDmlError('MCP_DML_OPERATION_NOT_ALLOWED'),
  );
  assert.throws(
    () => policy.assertAllowed('Contact', 'CREATE'),
    isDmlError('MCP_DML_OBJECT_NOT_ALLOWED'),
  );
  assert.equal(policy.allowsAny('CREATE'), true);
  assert.equal(policy.allowsAny('UPDATE'), true);
});

test('invalid JSON, DELETE, unknown operations, duplicates, and unknown keys fail closed', () => {
  const invalidValues = [
    '{',
    JSON.stringify([{ objectApiName: 'Lead', operations: ['DELETE'] }]),
    JSON.stringify([{ objectApiName: 'Lead', operations: ['UPSERT'] }]),
    JSON.stringify([{ objectApiName: 'Lead', operations: ['CREATE', 'CREATE'] }]),
    JSON.stringify([
      { objectApiName: 'Lead', operations: ['CREATE'] },
      { objectApiName: 'lead', operations: ['UPDATE'] },
    ]),
    JSON.stringify([{ objectApiName: 'Lead', operations: [] }]),
    JSON.stringify([{ objectApiName: 'Lead', operations: ['CREATE'], delete: true }]),
  ];

  for (const value of invalidValues) {
    assert.throws(() => parseDmlAllowlistJson(value), isDmlError('MCP_DML_CONFIGURATION_INVALID'));
  }
});

function isDmlError(code: DmlRuntimeError['code']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof DmlRuntimeError && error.code === code;
}
