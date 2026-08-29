import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIT_REDACTION_MARKER,
  MAX_AUDIT_PAYLOAD_BYTES,
  containsObviousAuditSecret,
  encodeBoundedAuditJson,
  encodeBoundedAuditPayload,
} from '../index.js';

test('audit sanitization recursively removes obvious authentication secrets while preserving safe derived evidence', () => {
  const fakeBearer = 'Bearer fake-p7-bearer-token-value';
  const fakeJwt = 'eyJfakeHeader123.eyJfakePayload456.fakeSignature789';
  const fakePrivateKey = '-----BEGIN PRIVATE KEY-----\nfake-only-test-key\n-----END PRIVATE KEY-----';
  const encoded = encodeBoundedAuditJson({
    authorization: fakeBearer,
    rawToken: 'fake-p7-raw-token',
    nested: {
      clientSecret: 'fake-client-secret',
      error: `upstream echoed ${fakeBearer} and ${fakeJwt}`,
      key: fakePrivateKey,
      freeText: 'clientSecret=fake-free-text-secret',
    },
    tokenFingerprint: `sha256:${'a'.repeat(64)}`,
    tokenLast4: '1234',
    safeFact: 'kept',
  });

  assert.ok(encoded);
  assert.equal(containsObviousAuditSecret(encoded), false);
  assert.equal(encoded.includes('fake-p7-raw-token'), false);
  assert.equal(encoded.includes('fake-client-secret'), false);
  assert.equal(encoded.includes('fake-only-test-key'), false);
  assert.equal(encoded.includes('fake-free-text-secret'), false);
  assert.equal(encoded.includes(AUDIT_REDACTION_MARKER), true);
  assert.equal(encoded.includes(`sha256:${'a'.repeat(64)}`), true);
  assert.equal(encoded.includes('1234'), true);
  assert.equal(encoded.includes('kept'), true);
  assert.equal(containsObviousAuditSecret('SFOA_UB1_fake-secret-token'), true);
});

test('bounded payload capture never exceeds 256 KiB and hashes the complete sanitized evidence', () => {
  const payload = `Bearer fake-secret ${'测'.repeat(100_000)}`;
  const encoded = encodeBoundedAuditPayload(payload);

  assert.equal(encoded.truncated, true);
  assert.equal(encoded.storedSizeBytes <= MAX_AUDIT_PAYLOAD_BYTES, true);
  assert.equal(Buffer.byteLength(encoded.safePayload ?? '', 'utf8'), encoded.storedSizeBytes);
  assert.match(encoded.contentSha256 ?? '', /^[0-9a-f]{64}$/u);
  assert.equal((encoded.safePayload ?? '').includes('fake-secret'), false);
  assert.equal(containsObviousAuditSecret(encoded.safePayload ?? ''), false);
});

test('oversized summaries become bounded metadata instead of copying the original value', () => {
  const encoded = encodeBoundedAuditJson({ records: ['x'.repeat(50_000)] });
  assert.ok(encoded);
  assert.equal(Buffer.byteLength(encoded, 'utf8') <= 16_384, true);
  assert.deepEqual(Object.keys(JSON.parse(encoded) as Record<string, unknown>).sort(), [
    'contentSha256', 'originalSizeBytes', 'truncated',
  ]);
});
