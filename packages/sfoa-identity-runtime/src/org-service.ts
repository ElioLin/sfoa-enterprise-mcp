import type { Connection } from '@salesforce/core';
import type {
  OrgConfigInfo,
  OrgService,
  SanitizedOrgAuthorization,
} from '@salesforce/mcp-provider-api';
import type { SalesforceIdentityRoute } from './contracts.js';
import { routeAllowsUsernameOrAlias } from './contracts.js';
import { IdentityRuntimeError } from './errors.js';
import type { RequestContext } from './request-context.js';
import type { SalesforceConnectionProvider } from './salesforce-connection-resource.js';

export class RequestScopedOrgService implements OrgService {
  public constructor(
    private readonly context: RequestContext,
    private readonly route: SalesforceIdentityRoute,
    private readonly connectionProvider: SalesforceConnectionProvider,
    private readonly instanceUrl: string,
  ) {}

  public async getAllowedOrgUsernames(): Promise<Set<string>> {
    return new Set([this.route.salesforceUsername]);
  }

  public async getAllowedOrgs(): Promise<SanitizedOrgAuthorization[]> {
    return [this.toAuthorization()];
  }

  public async getConnection(usernameOrAlias: string): Promise<Connection> {
    if (!routeAllowsUsernameOrAlias(this.route, usernameOrAlias)) {
      throw new IdentityRuntimeError(
        'MCP_IDENTITY_CONTEXT_MISMATCH',
        'The Tool usernameOrAlias does not match the Salesforce identity resolved from X-Platform-User-Id.',
        { correlationId: this.context.correlationId },
      );
    }
    return this.connectionProvider.getConnection();
  }

  public async getDefaultTargetOrg(): Promise<OrgConfigInfo> {
    return {
      key: 'target-org',
      value: this.route.salesforceUsername,
      path: this.context.workspaceRoot,
    };
  }

  public async getDefaultTargetDevHub(): Promise<OrgConfigInfo | undefined> {
    return undefined;
  }

  public findOrgByUsernameOrAlias(
    allOrgs: SanitizedOrgAuthorization[],
    usernameOrAlias: string,
  ): SanitizedOrgAuthorization | undefined {
    if (!routeAllowsUsernameOrAlias(this.route, usernameOrAlias)) return undefined;
    return allOrgs.find((org) => org.username === this.route.salesforceUsername);
  }

  private toAuthorization(): SanitizedOrgAuthorization {
    return {
      aliases: [...this.route.aliases],
      configs: [],
      username: this.route.salesforceUsername,
      instanceUrl: this.instanceUrl,
      oauthMethod: 'jwt',
      isExpired: false,
    };
  }
}
