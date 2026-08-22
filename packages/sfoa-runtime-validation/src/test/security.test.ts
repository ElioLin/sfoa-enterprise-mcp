import assert from 'node:assert/strict';
import test from 'node:test';
import { describeAccessToken, maskToken, redactError } from '../security.js';

test('maskToken never returns the complete token', () => {
  const token = '00D000000000001!AQ0exampleTokenForTestingOnly';
  const masked = maskToken(token);
  assert.notEqual(masked, token);
  assert.match(masked, /<masked>$/);
});

test('describeAccessToken exposes only selected JWT claims', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: 'issuer', aud: ['audience'], sub: 'subject', scope: 'api', exp: 4_102_444_800 }),
  ).toString('base64url');
  const summary = describeAccessToken(`${header}.${payload}.signature`);

  assert.equal(summary.tokenType, 'JWT');
  assert.equal(summary.issuer, 'issuer');
  assert.equal(summary.audience, 'audience');
  assert.equal(summary.subject, 'subject');
  assert.equal(summary.scope, 'api');
  assert.equal(summary.isExpired, false);
});

test('redactError removes bearer and Salesforce opaque access tokens', () => {
  const token = '00D000000000001!AQ0exampleTokenForTestingOnly';
  const redacted = redactError(`Authorization: Bearer ${token}; duplicate ${token}`, [token]);
  assert.doesNotMatch(redacted, /AQ0exampleTokenForTestingOnly/);
  assert.match(redacted, /redacted/iu);
});
