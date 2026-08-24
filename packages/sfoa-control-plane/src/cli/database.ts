import { loadControlPlaneConfig } from '../config.js';
import { createControlPlaneDatabase, createDatabaseIfMissing, databaseHealth } from '../database.js';
import { migrateDatabase, migrationStatus } from '../migrations.js';
import { resolveSfoaProjectRoot } from '../project-root.js';

const projectRoot = resolveSfoaProjectRoot(import.meta.url);
const command = process.argv[2];

async function main(): Promise<void> {
  const loaded = await loadControlPlaneConfig(projectRoot, process.env, { requireDatabase: true });
  const config = loaded.database;
  if (!config) throw new Error('Database configuration was not loaded.');
  if (command === 'create') {
    await createDatabaseIfMissing(config);
    process.stdout.write(`${JSON.stringify({ status: 'PASS', database: config.database, action: 'CREATE_IF_MISSING' }, null, 2)}\n`);
    return;
  }
  const database = createControlPlaneDatabase(config);
  try {
    if (command === 'migrate') {
      const [health, migrations] = await Promise.all([databaseHealth(database), migrateDatabase(database)]);
      process.stdout.write(`${JSON.stringify({ status: 'PASS', database: config.database, mysqlVersion: health.version, migrations }, null, 2)}\n`);
      return;
    }
    if (command === 'status') {
      const [health, migrations] = await Promise.all([databaseHealth(database), migrationStatus(database)]);
      process.stdout.write(`${JSON.stringify({ status: 'PASS', database: config.database, mysqlVersion: health.version, migrations }, null, 2)}\n`);
      return;
    }
    throw new Error('Usage: database.js create|migrate|status');
  } finally {
    await database.destroy();
  }
}

await main();
