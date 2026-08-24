import { bootstrapFromEnvironment } from '../bootstrap.js';
import { loadControlPlaneConfig } from '../config.js';
import { createControlPlaneDatabase } from '../database.js';
import { resolveSfoaProjectRoot } from '../project-root.js';
import { MySqlControlPlaneStore } from '../store.js';

const projectRoot = resolveSfoaProjectRoot(import.meta.url);

async function main(): Promise<void> {
  const loaded = await loadControlPlaneConfig(projectRoot, process.env, { requireDatabase: true });
  if (!loaded.database) throw new Error('Database configuration was not loaded.');
  const store = new MySqlControlPlaneStore(createControlPlaneDatabase(loaded.database));
  try {
    const force = process.argv.includes('--force');
    if (force) {
      process.stderr.write('WARNING: --force overwrites existing P5 governance rows and is restricted to development/test.\n');
    }
    const result = await bootstrapFromEnvironment(store, projectRoot, process.env, force);
    process.stdout.write(`${JSON.stringify({ status: 'PASS', database: loaded.database.database, ...result }, null, 2)}\n`);
  } finally {
    await store.close();
  }
}

await main();
