import { createSalesforceIdentityRoute, normalizeSalesforceIdentity, type SalesforceIdentityRoute } from './contracts.js';

export interface IdentityRepository {
  findByPlatformUserId(platformUserId: string): Promise<SalesforceIdentityRoute | undefined>;
}

export class InMemoryIdentityRepository implements IdentityRepository {
  private readonly routes: ReadonlyMap<string, SalesforceIdentityRoute>;

  public constructor(inputs: readonly unknown[]) {
    const routes = inputs.map((input) => createSalesforceIdentityRoute(input));
    const byPlatformUserId = new Map<string, SalesforceIdentityRoute>();
    const claimedSalesforceIdentities = new Map<string, string>();

    for (const route of routes) {
      if (byPlatformUserId.has(route.platformUserId)) {
        throw new Error(`Duplicate platformUserId route: ${route.platformUserId}`);
      }

      for (const value of [route.salesforceUsername, ...route.aliases]) {
        const normalized = normalizeSalesforceIdentity(value);
        const owner = claimedSalesforceIdentities.get(normalized);
        if (owner && owner !== route.platformUserId) {
          throw new Error('A Salesforce username or alias cannot be assigned to multiple platform users.');
        }
        claimedSalesforceIdentities.set(normalized, route.platformUserId);
      }
      byPlatformUserId.set(route.platformUserId, route);
    }

    this.routes = byPlatformUserId;
  }

  public async findByPlatformUserId(platformUserId: string): Promise<SalesforceIdentityRoute | undefined> {
    return this.routes.get(platformUserId);
  }
}
