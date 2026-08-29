import type { Kysely, Transaction } from 'kysely';
import { databaseHealth, type ControlPlaneDatabaseClient } from './database.js';
import { ControlPlaneError } from './errors.js';
import { createMySqlRepositories } from './mysql-repositories.js';
import type { ControlPlaneRepositories, ControlPlaneRepositoriesWithAuditTrace } from './repositories.js';
import type { ControlPlaneDatabase } from './schema.js';

export class MySqlControlPlaneStore {
  public readonly repositories: ControlPlaneRepositoriesWithAuditTrace;

  public constructor(public readonly database: ControlPlaneDatabaseClient) {
    this.repositories = createMySqlRepositories(database);
  }

  public async transaction<T>(work: (repositories: ControlPlaneRepositories) => Promise<T>): Promise<T> {
    return this.database.transaction().execute(async (transaction) => {
      const sentinel = await transaction
        .selectFrom('sfoa_schema_migration')
        .select('version')
        .where('version', '=', '001_p5_control_plane')
        .forUpdate()
        .executeTakeFirst();
      if (!sentinel) {
        throw new ControlPlaneError(
          'MCP_CONTROL_PLANE_CONFIGURATION_INVALID',
          'The P5 configuration transaction sentinel is missing. Run the reviewed migrations before writing configuration.',
        );
      }
      return work(createMySqlRepositories(transaction));
    });
  }

  public async health(): Promise<Readonly<{ version: string }>> {
    return databaseHealth(this.database);
  }

  public async close(): Promise<void> {
    await this.database.destroy();
  }
}

export interface TransactionalControlPlaneStore {
  transaction<T>(work: (repositories: ControlPlaneRepositories) => Promise<T>): Promise<T>;
}

export type ControlPlaneExecutor = Kysely<ControlPlaneDatabase> | Transaction<ControlPlaneDatabase>;
