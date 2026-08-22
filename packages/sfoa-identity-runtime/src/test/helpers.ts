import type { Connection } from '@salesforce/core';
import type { SalesforceIdentityRoute } from '../contracts.js';
import { createSalesforceIdentityRoute } from '../contracts.js';
import type { SalesforceConnectionFactory } from '../connection-factory.js';
import { IdentityResolver } from '../identity-resolver.js';
import { InMemoryIdentityRepository } from '../identity-repository.js';
import { RequestScopeFactory } from '../request-scope.js';
import { RequestWorkspaceFactory, type MetadataSeed } from '../workspace.js';

export const TEST_ROUTE_A = createSalesforceIdentityRoute({
  platformUserId: 'p1-user-a',
  salesforceUsername: 'user-a@example.test',
  credentialProfile: 'test-jwt',
  connectionRole: 'USER',
  aliases: ['alias-a'],
});

export const TEST_ROUTE_B = createSalesforceIdentityRoute({
  platformUserId: 'p1-user-b',
  salesforceUsername: 'user-b@example.test',
  credentialProfile: 'test-jwt',
  connectionRole: 'USER',
  aliases: [],
});

export type ConnectionCreation = Readonly<{
  sequence: number;
  platformUserId: string;
  salesforceUsername: string;
  connection: Connection;
}>;

export class RecordingConnectionFactory implements SalesforceConnectionFactory {
  public readonly creations: ConnectionCreation[] = [];

  public async create(route: SalesforceIdentityRoute): Promise<Connection> {
    const sequence = this.creations.length + 1;
    const queryResult = {
      records: [{ Id: `${route.platformUserId}-${sequence}` }],
      totalSize: 1,
      done: true,
    };
    const connection = {
      getApiVersion: () => '65.0',
      identity: async () => ({
        username: route.salesforceUsername,
        user_id: `005-${route.platformUserId}`,
        organization_id: '00D-test',
      }),
      query: async (_query: string) => queryResult,
      tooling: { query: async (_query: string) => queryResult },
    } as unknown as Connection;
    this.creations.push({
      sequence,
      platformUserId: route.platformUserId,
      salesforceUsername: route.salesforceUsername,
      connection,
    });
    return connection;
  }

  public countFor(platformUserId: string): number {
    return this.creations.filter((creation) => creation.platformUserId === platformUserId).length;
  }
}

export function createTestScopeFactory(options: {
  baseRoot: string;
  connectionFactory?: SalesforceConnectionFactory;
  metadataSeed?: MetadataSeed;
  routes?: readonly SalesforceIdentityRoute[];
}): {
  scopeFactory: RequestScopeFactory;
  workspaceFactory: RequestWorkspaceFactory;
  connectionFactory: SalesforceConnectionFactory;
} {
  const routes = options.routes ?? [TEST_ROUTE_A, TEST_ROUTE_B];
  const repository = new InMemoryIdentityRepository(routes);
  const resolver = new IdentityResolver(repository);
  const connectionFactory = options.connectionFactory ?? new RecordingConnectionFactory();
  const workspaceFactory = new RequestWorkspaceFactory({
    baseRoot: options.baseRoot,
    metadataSeed: options.metadataSeed,
  });
  return {
    scopeFactory: new RequestScopeFactory({
      resolver,
      connectionFactory,
      workspaceFactory,
      instanceUrl: 'https://example.test',
    }),
    workspaceFactory,
    connectionFactory,
  };
}
