import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadCrmGatewayConfig } from '../config.js';

const BASE = Object.freeze({
  SFOA_CONTROL_PLANE_MODE: 'mysql',
  SFOA_DB_HOST: '127.0.0.1',
  SFOA_DB_PORT: '3306',
  SFOA_DB_NAME: 'sfoa_test',
  SFOA_DB_USER: 'test',
  SFOA_DB_PASSWORD: 'test',
  CRM_ALLOWED_ORIGINS: 'https://lightning.example.test',
  CRM_OPENCLAW_URL: 'http://127.0.0.1:18789/plugins/sfoa-crm',
  CRM_OPENCLAW_SERVICE_TOKEN: 's'.repeat(32),
  CRM_GATEWAY_HISTORY_TOKEN: 'h'.repeat(32),
  CRM_APEX_PUBLIC_KEY_PATH: 'config/apex-cert.pem',
  CRM_APEX_ISSUER: 'sfoa-crm-apex',
  CRM_APEX_AUDIENCE: 'sfoa-crm-gateway',
  CRM_APEX_ALLOWED_ORG_IDS: '00D000000000001AAA',
} satisfies NodeJS.ProcessEnv);

test('CRM gateway configuration keeps origins, orgs and history credentials strict', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'crm-gateway-config-'));
  try {
    const config = await loadCrmGatewayConfig(root, { ...BASE });
    assert.equal(config.gatewayHistoryToken, 'h'.repeat(32));
    assert.deepEqual(config.allowedOrigins, ['https://lightning.example.test']);
    assert.deepEqual(config.apex.allowedOrgIds, ['00D000000000001AAA']);
    assert.equal(config.openclawBaseUrl, 'http://127.0.0.1:18789/plugins/sfoa-crm');

    await assert.rejects(loadCrmGatewayConfig(root, { ...BASE, CRM_GATEWAY_HISTORY_TOKEN: '' }), /CRM_GATEWAY_HISTORY_TOKEN/u);
    await assert.rejects(loadCrmGatewayConfig(root, { ...BASE, CRM_ALLOWED_ORIGINS: '*' }), /CRM_ALLOWED_ORIGINS/u);
    await assert.rejects(loadCrmGatewayConfig(root, { ...BASE, CRM_ALLOWED_ORIGINS: 'http://lightning.example.test' }), /https/u);
    await assert.rejects(loadCrmGatewayConfig(root, { ...BASE, CRM_ALLOWED_ORIGINS: 'https://lightning.example.test/path' }), /CRM_ALLOWED_ORIGINS/u);
    await assert.rejects(loadCrmGatewayConfig(root, {
      ...BASE,
      CRM_OPENCLAW_URL: 'http://user:pass@127.0.0.1:18789/plugins/sfoa-crm',
    }), /CRM_OPENCLAW_URL/u);
    await assert.rejects(loadCrmGatewayConfig(root, { ...BASE, CRM_APEX_ALLOWED_ORG_IDS: 'bad' }), /CRM_APEX_ALLOWED_ORG_IDS/u);
    await assert.rejects(loadCrmGatewayConfig(root, { ...BASE, CRM_TLS_KEY_PATH: 'key.pem' }), /CRM_TLS_KEY_PATH/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
