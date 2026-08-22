import type { SalesforceIdentityRoute } from './contracts.js';
import { IdentityRuntimeError } from './errors.js';
import type { IdentityRepository } from './identity-repository.js';

export class IdentityResolver {
  public constructor(private readonly repository: IdentityRepository) {}

  public async resolve(platformUserId: string, correlationId?: string): Promise<SalesforceIdentityRoute> {
    const route = await this.repository.findByPlatformUserId(platformUserId);
    if (!route) {
      throw new IdentityRuntimeError(
        'MCP_IDENTITY_ROUTE_NOT_FOUND',
        'No Salesforce identity route exists for the authenticated platform user. Ask an administrator to configure the route.',
        { correlationId },
      );
    }
    return route;
  }
}
