import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLightningBaseUrl } from '../config.js';
import { RemoteRuntimeError } from '../errors.js';

test('SFOA_LIGHTNING_BASE_URL accepts only a credential-free HTTPS origin', () => {
  assert.equal(normalizeLightningBaseUrl('https://company.lightning.force.com/'), 'https://company.lightning.force.com');
  for (const invalid of [
    'http://company.lightning.force.com',
    'https://company.lightning.force.com/lightning',
    'https://user:password@company.lightning.force.com',
    'https://company.lightning.force.com?target=evil',
  ]) {
    assert.throws(
      () => normalizeLightningBaseUrl(invalid),
      (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_RUNTIME_CONFIGURATION_INVALID',
    );
  }
});
