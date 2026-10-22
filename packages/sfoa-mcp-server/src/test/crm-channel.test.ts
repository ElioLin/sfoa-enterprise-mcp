import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { IdentityRuntimeError } from '@sfoa/identity-runtime';
import {
  CrmChannelCredentialAuthenticator,
  InternalServiceCredentialAuthenticator,
  UnifiedIdentityProvider,
  WeComChannelCredentialAuthenticator,
} from '../authenticator.js';
import { loadRemoteRuntimeConfig } from '../config.js';
import { RemoteRuntimeError } from '../errors.js';
import { TEST_CLIENT_TOKEN } from './helpers.js';

/**
 * CRM 渠道的身份边界测试。
 *
 * 这些用例只证明“凭据 + 身份头”两段式认证本身；它们不证明 Salesforce
 * 双用户端到端链路，后者必须由 README 中的 live Gate 单独取证。
 */

const CRM_TOKEN = 'crm-channel-token-0123456789abcdef';
const WECOM_TOKEN = 'wecom-channel-token-0123456789abcdef';
const HEADERS = Object.freeze(['X-Platform-User-Id', 'X-WeCom-User-Id', 'X-SFOA-CRM-User-Id']);

function crmProvider(options: Readonly<{ wecom?: boolean }> = {}): UnifiedIdentityProvider {
  return new UnifiedIdentityProvider([
    new InternalServiceCredentialAuthenticator(TEST_CLIENT_TOKEN),
    ...(options.wecom ? [new WeComChannelCredentialAuthenticator(WECOM_TOKEN)] : []),
    new CrmChannelCredentialAuthenticator(CRM_TOKEN),
  ], options.wecom === true, true);
}

test('CRM channel: the channel credential plus X-SFOA-CRM-User-Id resolves CRM_HEADER', async () => {
  const principal = await crmProvider().authenticate({
    authorization: `Bearer ${CRM_TOKEN}`,
    'x-sfoa-crm-user-id': 'employee-61979',
  }, HEADERS, 'crm-a');

  assert.deepEqual(principal, {
    clientId: 'sfoa-crm-channel',
    identitySource: 'CRM_HEADER',
    platformUserId: 'employee-61979',
    correlationId: 'crm-a',
  });
});

test('CRM channel: header names are case-insensitive and extra non-identity fields are ignored', async () => {
  const principal = await crmProvider().authenticate({
    authorization: `Bearer ${CRM_TOKEN}`,
    'X-SFOA-CRM-USER-ID': 'employee-a',
    // 这些字段即使出现在请求里也不参与身份决策。
    senderId: 'someone-else',
    userId: 'admin',
    'x-platform-user-id': undefined,
  }, HEADERS, 'crm-case');

  assert.equal(principal.identitySource, 'CRM_HEADER');
  assert.equal(principal.platformUserId, 'employee-a');
});

test('CRM channel: the CRM credential cannot borrow a WeCom identity header', async () => {
  await assert.rejects(
    crmProvider({ wecom: true }).authenticate({
      authorization: `Bearer ${CRM_TOKEN}`,
      'x-wecom-user-id': 'employee-a',
    }, HEADERS, 'crm-borrows-wecom'),
    hasRemoteCode('MCP_IDENTITY_CHANNEL_MISMATCH'),
  );
});

test('CRM channel: the CRM credential cannot fall back to the internal platform header', async () => {
  await assert.rejects(
    crmProvider().authenticate({
      authorization: `Bearer ${CRM_TOKEN}`,
      'x-platform-user-id': 'employee-a',
    }, HEADERS, 'crm-borrows-internal'),
    hasRemoteCode('MCP_IDENTITY_CHANNEL_MISMATCH'),
  );
});

test('CRM channel: the WeCom credential cannot use the CRM identity header', async () => {
  await assert.rejects(
    crmProvider({ wecom: true }).authenticate({
      authorization: `Bearer ${WECOM_TOKEN}`,
      'x-sfoa-crm-user-id': 'employee-a',
    }, HEADERS, 'wecom-borrows-crm'),
    hasRemoteCode('MCP_IDENTITY_CHANNEL_MISMATCH'),
  );
});

test('CRM channel: the internal credential cannot use the CRM identity header', async () => {
  await assert.rejects(
    crmProvider().authenticate({
      authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
      'x-sfoa-crm-user-id': 'employee-a',
    }, HEADERS, 'internal-borrows-crm'),
    hasRemoteCode('MCP_IDENTITY_CHANNEL_MISMATCH'),
  );
});

test('CRM channel: a CRM credential without an identity header is denied', async () => {
  await assert.rejects(
    crmProvider().authenticate({ authorization: `Bearer ${CRM_TOKEN}` }, HEADERS, 'crm-missing-header'),
    hasRemoteCode('MCP_PLATFORM_USER_REQUIRED'),
  );
});

test('CRM channel: two identity headers are a conflict even when their values match', async () => {
  await assert.rejects(
    crmProvider({ wecom: true }).authenticate({
      authorization: `Bearer ${CRM_TOKEN}`,
      'x-sfoa-crm-user-id': 'employee-a',
      'x-wecom-user-id': 'employee-a',
    }, HEADERS, 'crm-conflict'),
    hasRemoteCode('MCP_PLATFORM_IDENTITY_CONFLICT'),
  );
});

test('CRM channel: duplicated CRM headers are ambiguous and denied', async () => {
  await assert.rejects(
    crmProvider().authenticate({
      authorization: `Bearer ${CRM_TOKEN}`,
      'x-sfoa-crm-user-id': ['employee-a', 'employee-a'],
    }, HEADERS, 'crm-ambiguous'),
    hasRemoteCode('MCP_PLATFORM_IDENTITY_CONFLICT'),
  );
});

test('CRM channel: an invalid Bearer is denied even with a valid CRM header', async () => {
  await assert.rejects(
    crmProvider().authenticate({
      authorization: 'Bearer not-the-crm-token',
      'x-sfoa-crm-user-id': 'employee-a',
    }, HEADERS, 'crm-bad-token'),
    hasRemoteCode('MCP_CLIENT_AUTH_INVALID'),
  );
});

test('CRM channel: control characters and overlong platform user ids are rejected', async () => {
  await assert.rejects(
    crmProvider().authenticate({
      authorization: `Bearer ${CRM_TOKEN}`,
      'x-sfoa-crm-user-id': 'employee\u0000a',
    }, HEADERS, 'crm-control-char'),
    hasRemoteCode('MCP_REQUEST_SCOPE_FAILED'),
  );
  await assert.rejects(
    crmProvider().authenticate({
      authorization: `Bearer ${CRM_TOKEN}`,
      'x-sfoa-crm-user-id': 'a'.repeat(129),
    }, HEADERS, 'crm-too-long'),
    hasRemoteCode('MCP_REQUEST_SCOPE_FAILED'),
  );
});

test('CRM channel configuration fails fast without an independent credential and bound header alias', async () => {  const root = await mkdtemp(path.join(tmpdir(), 'crm-channel-config-'));
  try {
    const keyPath = path.join(root, 'test.pem');
    await writeFile(keyPath, 'test-only-key');
    const base = {
      SFOA_INSTANCE_URL: 'https://example.test',
      SALESFORCE_USERNAME: 'a@example.test',
      SECOND_TEST_USER: 'b@example.test',
      CONNECTED_APP_CLIENT_ID: 'test',
      JWT_PRIVATE_KEY_PATH: keyPath,
      MCP_CLIENT_TOKEN: TEST_CLIENT_TOKEN,
      MCP_WECOM_CLIENT_TOKEN: WECOM_TOKEN,
      MCP_CRM_CHANNEL_ENABLED: 'true',
      MCP_PLATFORM_USER_HEADER_ALIASES: 'X-SFOA-CRM-User-Id',
    };
    const CRM_TOKEN = `crm-channel-${'x'.repeat(32)}`;
    for (const token of ['', 'short', ' '.repeat(40), `sfoa_ub1_${'x'.repeat(43)}`, TEST_CLIENT_TOKEN, WECOM_TOKEN]) {
      await assert.rejects(
        loadRemoteRuntimeConfig(root, { ...base, MCP_CRM_CLIENT_TOKEN: token }),
        /MCP_CRM/u,
      );
    }
    await assert.rejects(
      loadRemoteRuntimeConfig(root, { ...base, MCP_CRM_CLIENT_TOKEN: CRM_TOKEN, MCP_PLATFORM_USER_HEADER_ALIASES: 'X-WeCom-User-Id' }),
      /MCP_PLATFORM_USER_HEADER_ALIASES.*X-SFOA-CRM-User-Id/u,
    );
    await assert.rejects(
      loadRemoteRuntimeConfig(root, { ...base, MCP_CRM_CLIENT_TOKEN: CRM_TOKEN, MCP_PLATFORM_USER_HEADER: 'X-SFOA-CRM-User-Id' }),
      /reserved partner identity header/u,
    );

    const config = await loadRemoteRuntimeConfig(root, { ...base, MCP_CRM_CLIENT_TOKEN: CRM_TOKEN });
    assert.equal(config.crmChannelEnabled, true);
    assert.equal(config.crmClientToken, CRM_TOKEN);
    assert.ok(config.platformIdentityHeaders.includes('X-SFOA-CRM-User-Id'));

    const disabled = await loadRemoteRuntimeConfig(root, {
      ...base,
      MCP_CRM_CHANNEL_ENABLED: 'false',
      MCP_CRM_CLIENT_TOKEN: CRM_TOKEN,
      MCP_PLATFORM_USER_HEADER_ALIASES: '',
    });
    assert.equal(disabled.crmChannelEnabled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function hasRemoteCode(code: string) {
  return (error: unknown): boolean => (
    (error instanceof RemoteRuntimeError || error instanceof IdentityRuntimeError) && error.code === code
  );
}
