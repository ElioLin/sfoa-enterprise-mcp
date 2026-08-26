import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadMySqlSfdxSeedUsernames } from '../runtime-sfdx-seed-usernames.js';

test('MCP MySQL startup supplies active routes and the diagnostic username to the SFDX auth-store seeder', async () => {
  const usernames = await loadMySqlSfdxSeedUsernames({
    identityRoutes: {
      listActiveSalesforceUsernames: async () => ['user-a@example.test', 'user-b@example.test'],
    },
    diagnostic: {
      get: async () => ({ salesforceUsername: 'diagnostic@example.test' }),
    },
  });

  assert.deepEqual(usernames, [
    'user-a@example.test',
    'user-b@example.test',
    'diagnostic@example.test',
  ]);
});

test('MCP MySQL startup seeds active route usernames when no diagnostic config exists', async () => {
  const usernames = await loadMySqlSfdxSeedUsernames({
    identityRoutes: {
      listActiveSalesforceUsernames: async () => ['user-a@example.test', 'user-b@example.test'],
    },
    diagnostic: { get: async () => undefined },
  });

  assert.deepEqual(usernames, ['user-a@example.test', 'user-b@example.test']);
});

test('MCP MySQL startup seeds a diagnostic-only deployment', async () => {
  const usernames = await loadMySqlSfdxSeedUsernames({
    identityRoutes: { listActiveSalesforceUsernames: async () => [] },
    diagnostic: { get: async () => ({ salesforceUsername: 'diagnostic@example.test' }) },
  });

  assert.deepEqual(usernames, ['diagnostic@example.test']);
});

test('MCP MySQL startup leaves duplicate usernames to the shared SFDX auth-store seeder', async () => {
  const usernames = await loadMySqlSfdxSeedUsernames({
    identityRoutes: { listActiveSalesforceUsernames: async () => ['shared@example.test'] },
    diagnostic: { get: async () => ({ salesforceUsername: 'shared@example.test' }) },
  });

  assert.deepEqual(usernames, ['shared@example.test', 'shared@example.test']);
});

test('MCP runtime SFDX bootstrap has no Admin API or local Admin health dependency', async () => {
  const runtimeSource = await readFile(path.join(process.cwd(), 'src', 'runtime.ts'), 'utf8');

  assert.match(runtimeSource, /loadMySqlSfdxSeedUsernames\(store\.repositories\)/u);
  assert.doesNotMatch(runtimeSource, /@sfoa\/admin-api|127\.0\.0\.1:8081|admin health/iu);
});
