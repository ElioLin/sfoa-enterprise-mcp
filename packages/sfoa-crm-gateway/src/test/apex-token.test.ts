import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { ApexTokenVerifier, loadApexPublicKey } from '../apex-token.js';
import { CrmGatewayError } from '../errors.js';
import {
  TEST_ORG,
  TEST_USER_A,
  TEST_USERNAME_A,
  createSigningMaterial,
} from './helpers.js';

const NOW_MS = 1_760_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

function verifierFor(material = createSigningMaterial(NOW_MS), overrides = {}) {
  return new ApexTokenVerifier({
    publicKey: material.publicKey,
    issuer: 'sfoa-crm-apex',
    audience: 'sfoa-crm-gateway',
    allowedOrgIds: [TEST_ORG],
    maxAgeMs: 120_000,
    maxTtlMs: 120_000,
    clockSkewMs: 30_000,
    nowMs: () => NOW_MS,
    ...overrides,
  });
}

test('a correctly signed Apex token yields the exact Salesforce subject', () => {
  const material = createSigningMaterial(NOW_MS);
  const claims = verifierFor(material).verify(material.signToken());
  assert.equal(claims.issuer, 'sfoa-crm-apex');
  assert.equal(claims.audience, 'sfoa-crm-gateway');
  assert.equal(claims.orgId, TEST_ORG);
  assert.equal(claims.userId, TEST_USER_A);
  assert.equal(claims.username, TEST_USERNAME_A);
  assert.equal(claims.displayName, 'Candy Zheng');
  assert.equal(claims.issuedAt.getTime(), NOW_SECONDS * 1000);
  assert.equal(claims.expiresAt.getTime(), (NOW_SECONDS + 90) * 1000);
});

test('a tampered payload or signature is rejected', () => {
  const material = createSigningMaterial(NOW_MS);
  const token = material.signToken();
  const [version, payload, signature] = token.split('.');
  const decoded = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  decoded.userId = '005000000000009AAA';
  const tamperedPayload = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
  assert.throws(
    () => verifierFor(material).verify(`${version}.${tamperedPayload}.${signature}`),
    (error) => error instanceof CrmGatewayError && error.code === 'CRM_APEX_SIGNATURE_INVALID',
  );

  const tamperedSignature = `${signature?.slice(0, -2)}AA`;
  assert.throws(
    () => verifierFor(material).verify(`${version}.${payload}.${tamperedSignature}`),
    (error) => error instanceof CrmGatewayError && error.code === 'CRM_APEX_SIGNATURE_INVALID',
  );
});

test('a token signed by a different key is rejected', () => {
  const trusted = createSigningMaterial(NOW_MS);
  const attacker = createSigningMaterial(NOW_MS);
  assert.throws(
    () => verifierFor(trusted).verify(attacker.signToken()),
    (error) => error instanceof CrmGatewayError && error.code === 'CRM_APEX_SIGNATURE_INVALID',
  );
});

test('expired and over-age tokens are rejected', () => {
  const material = createSigningMaterial(NOW_MS);
  assert.throws(
    () => verifierFor(material).verify(material.signToken({ iat: NOW_SECONDS - 300, exp: NOW_SECONDS - 200 })),
    (error) => error instanceof CrmGatewayError && error.code === 'CRM_APEX_TOKEN_EXPIRED',
  );

  const longLived = verifierFor(material, { maxTtlMs: 600_000, maxAgeMs: 120_000 });
  assert.throws(
    () => longLived.verify(material.signToken({ iat: NOW_SECONDS - 200, exp: NOW_SECONDS + 90 })),
    (error) => error instanceof CrmGatewayError && error.code === 'CRM_APEX_TOKEN_EXPIRED',
  );
});

test('a token issued too far in the future is rejected', () => {
  const material = createSigningMaterial(NOW_MS);
  assert.throws(
    () => verifierFor(material).verify(material.signToken({ iat: NOW_SECONDS + 120, exp: NOW_SECONDS + 180 })),
    (error) => error instanceof CrmGatewayError && error.code === 'CRM_APEX_TOKEN_INVALID',
  );
});

test('a token whose lifetime exceeds the configured bound is rejected', () => {
  const material = createSigningMaterial(NOW_MS);
  assert.throws(
    () => verifierFor(material).verify(material.signToken({ iat: NOW_SECONDS, exp: NOW_SECONDS + 300 })),
    (error) => error instanceof CrmGatewayError && error.code === 'CRM_APEX_TOKEN_TTL_INVALID',
  );
});

test('issuer, audience and organization are pinned', () => {
  const material = createSigningMaterial(NOW_MS);
  const verifier = verifierFor(material);
  assert.throws(() => verifier.verify(material.signToken({ iss: 'someone-else' })), CrmGatewayError);
  assert.throws(() => verifier.verify(material.signToken({ aud: 'another-service' })), CrmGatewayError);
  assert.throws(
    () => verifier.verify(material.signToken({ orgId: '00D000000000009AAA' })),
    (error) => error instanceof CrmGatewayError && error.code === 'CRM_APEX_ORG_NOT_ALLOWED',
  );
});

test('malformed claims and unknown fields are rejected', () => {
  const material = createSigningMaterial(NOW_MS);
  const verifier = verifierFor(material);
  assert.throws(() => verifier.verify('not-a-token'), CrmGatewayError);
  assert.throws(() => verifier.verify(material.signToken({ jti: 'not-a-uuid' })), CrmGatewayError);
  assert.throws(() => verifier.verify(material.signToken({ username: '   ' })), CrmGatewayError);
  assert.throws(() => verifier.verify(material.signToken({ userId: 'bad' })), CrmGatewayError);

  // Sign an otherwise valid payload with an extra field; strict parsing must refuse it.
  const payload = {
    iss: 'sfoa-crm-apex',
    aud: 'sfoa-crm-gateway',
    orgId: TEST_ORG,
    userId: TEST_USER_A,
    username: TEST_USERNAME_A,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 90,
    jti: '11111111-1111-4111-8111-111111111111',
    role: 'admin',
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`v1.${encoded}`), material.privateKey).toString('base64url');
  assert.throws(() => verifier.verify(`v1.${encoded}.${signature}`), CrmGatewayError);
});

test('the public key can be pinned as a bare PEM key; a certificate pin requires a certificate', () => {
  const material = createSigningMaterial(NOW_MS);
  const pem = material.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const loaded = loadApexPublicKey(pem);
  assert.equal(loaded.asymmetricKeyType, 'rsa');
  assert.equal(createPublicKey(pem).export({ type: 'spki', format: 'pem' }).toString(), pem);

  assert.throws(
    () => loadApexPublicKey(pem, 'a'.repeat(64)),
    /requires an X\.509 certificate/u,
  );
});

test('an unrelated key pair cannot verify the Apex token', () => {
  const material = createSigningMaterial(NOW_MS);
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const verifier = new ApexTokenVerifier({
    publicKey,
    issuer: 'sfoa-crm-apex',
    audience: 'sfoa-crm-gateway',
    allowedOrgIds: [TEST_ORG],
    maxAgeMs: 120_000,
    maxTtlMs: 120_000,
    clockSkewMs: 30_000,
    nowMs: () => NOW_MS,
  });
  assert.throws(
    () => verifier.verify(material.signToken()),
    (error) => error instanceof CrmGatewayError && error.code === 'CRM_APEX_SIGNATURE_INVALID',
  );
});
