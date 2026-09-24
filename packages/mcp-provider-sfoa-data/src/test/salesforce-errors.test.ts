import assert from 'node:assert/strict';
import test from 'node:test';
import { DataRuntimeError } from '../errors.js';
import { mapDataFailure, readSalesforceFailure } from '../salesforce-errors.js';

const MAPPING = {
  fallbackCode: 'MCP_SOBJECT_LIST_FAILED',
  fallbackMessage: 'Salesforce could not return the org object inventory for this request.',
  fallbackSuggestion: 'Retry once.',
  rules: [
    {
      codes: ['INSUFFICIENT_ACCESS'],
      code: 'MCP_SOBJECT_ACCESS_DENIED',
      message: 'The Salesforce user for this request may not read the org object inventory.',
      suggestion: 'Report the missing Salesforce permission instead of retrying.',
    },
  ],
} as const;

test('readSalesforceFailure reads a jsforce-shaped errorCode and message', () => {
  const failure = readSalesforceFailure(Object.assign(new Error('bad field'), { errorCode: 'INVALID_FIELD' }));
  assert.equal(failure.code, 'INVALID_FIELD');
  assert.equal(failure.message, 'bad field');
});

test('readSalesforceFailure walks nested payloads and prefers an outer code', () => {
  const nested = Object.assign(new Error('outer'), {
    errorCode: 'MALFORMED_QUERY',
    data: { errorCode: 'INVALID_TYPE', message: 'nested message' },
  });
  assert.deepEqual(readSalesforceFailure(nested), { code: 'MALFORMED_QUERY', message: 'outer' });

  // A payload with no outer code still yields the nested provider code and message.
  const bodyOnly = { body: { errorCode: 'INVALID_SESSION_ID', message: 'Session expired' } };
  assert.deepEqual(readSalesforceFailure(bodyOnly), { code: 'INVALID_SESSION_ID', message: 'Session expired' });

  const causeOnly = { cause: { code: 'REQUEST_LIMIT_EXCEEDED', message: 'Too many requests' } };
  assert.deepEqual(readSalesforceFailure(causeOnly), { code: 'REQUEST_LIMIT_EXCEEDED', message: 'Too many requests' });
});

test('readSalesforceFailure ignores a non-identifier code and non-string messages', () => {
  for (const errorCode of ['', '  ', 'has space', 'a'.repeat(200), 42, null, {}]) {
    const failure = readSalesforceFailure({ errorCode, message: 'kept?' });
    assert.equal(failure.code, null, `${JSON.stringify(errorCode)} is not a usable code`);
  }
  assert.equal(readSalesforceFailure({ errorCode: 'INVALID_TYPE', message: '   ' }).message, null);
  assert.equal(readSalesforceFailure({ errorCode: 'INVALID_TYPE', message: 7 }).message, null);
});

test('readSalesforceFailure terminates on a self-referential error', () => {
  const cyclic: Record<string, unknown> = { message: 'loop' };
  cyclic.cause = cyclic;
  assert.deepEqual(readSalesforceFailure(cyclic), { code: null, message: 'loop' });
});

test('readSalesforceFailure sanitizes a session id inside the provider message', () => {
  const failure = readSalesforceFailure({
    errorCode: 'INVALID_SESSION_ID',
    message: 'Session expired for 00D000000000001!AQ4AQJmFakeSessionIdValue1234',
  });
  assert.equal(failure.code, 'INVALID_SESSION_ID');
  assert.equal(failure.message, 'Session expired for [REDACTED_SESSION_ID]');
});

test('an already classified DataRuntimeError is returned unchanged', () => {
  const original = new DataRuntimeError('MCP_DATA_IDENTITY_UNAVAILABLE', 'exactly one identity', { suggestion: 'Retry.' });
  assert.equal(mapDataFailure(original, MAPPING), original);
});

test('a matched rule replaces the code, the message and the suggestion', () => {
  const mapped = mapDataFailure(
    Object.assign(new Error('insufficient access'), { errorCode: 'insufficient_access' }),
    MAPPING,
  );
  assert.equal(mapped.code, 'MCP_SOBJECT_ACCESS_DENIED');
  assert.equal(
    mapped.message,
    'The Salesforce user for this request may not read the org object inventory. Salesforce reported: insufficient access',
  );
  assert.equal(mapped.suggestion, 'Report the missing Salesforce permission instead of retrying.');
});

test('an unmapped but structured provider failure keeps the fallback code and still reports the provider message', () => {
  const mapped = mapDataFailure(
    Object.assign(new Error('TotalRequests Limit exceeded.'), { errorCode: 'REQUEST_LIMIT_EXCEEDED' }),
    MAPPING,
  );
  assert.equal(mapped.code, 'MCP_SOBJECT_LIST_FAILED');
  assert.equal(
    mapped.message,
    'Salesforce could not return the org object inventory for this request. Salesforce reported: TotalRequests Limit exceeded.',
  );
  assert.equal(mapped.suggestion, 'Retry once.');
});

test('a codeless failure never repeats the thrown message', () => {
  const mapped = mapDataFailure(new Error('connect ETIMEDOUT 10.0.0.5:443'), MAPPING);
  assert.equal(mapped.code, 'MCP_SOBJECT_LIST_FAILED');
  assert.equal(mapped.message, 'Salesforce could not return the org object inventory for this request.');
  assert.doesNotMatch(mapped.message, /ETIMEDOUT|10\.0\.0\.5/u);
  // The original value stays attached for the server-side record, out of the Agent's view.
  assert.ok(mapped.cause instanceof Error);
});
