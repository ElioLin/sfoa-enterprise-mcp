import type { Connection } from '@salesforce/core';
import type { SalesforceIdentityRoute } from './contracts.js';
import type { SalesforceConnectionFactory } from './connection-factory.js';
import { IdentityRuntimeError, toIdentityRuntimeError, withCorrelation } from './errors.js';
import type { IdentityResolver } from './identity-resolver.js';
import { RequestScopedOrgService } from './org-service.js';
import {
  createRequestContext,
  parseTrustedRequestHeaders,
  type RequestContext,
  type RequestHeaders,
  type TrustedRequestIdentity,
} from './request-context.js';
import { RequestScopedServices } from './services.js';
import type { RequestWorkspace, RequestWorkspaceFactory } from './workspace.js';

export class RequestScope {
  private closed = false;

  public constructor(
    public readonly context: RequestContext,
    public readonly route: SalesforceIdentityRoute,
    public readonly connection: Connection,
    public readonly workspace: RequestWorkspace,
    public readonly services: RequestScopedServices,
  ) {}

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.workspace.cleanup();
  }
}

export type RequestScopeFactoryOptions = Readonly<{
  resolver: IdentityResolver;
  connectionFactory: SalesforceConnectionFactory;
  workspaceFactory: RequestWorkspaceFactory;
  instanceUrl: string;
}>;

export class RequestScopeFactory {
  public constructor(private readonly options: RequestScopeFactoryOptions) {}

  public async createFromHeaders(headers: RequestHeaders): Promise<RequestScope> {
    return this.create(parseTrustedRequestHeaders(headers));
  }

  public async create(identity: TrustedRequestIdentity): Promise<RequestScope> {
    let workspace: RequestWorkspace | undefined;
    try {
      const route = await this.options.resolver.resolve(identity.platformUserId, identity.correlationId);
      if (route.connectionRole !== 'USER') {
        throw new IdentityRuntimeError(
          'MCP_CONNECTION_ROLE_NOT_AVAILABLE',
          'Only the USER Salesforce connection role is available in P1.',
          { correlationId: identity.correlationId },
        );
      }

      const connection = await this.options.connectionFactory.create(route);
      workspace = await this.options.workspaceFactory.create(identity.correlationId, connection.getApiVersion());
      const context = createRequestContext(identity, workspace.root);
      const orgService = new RequestScopedOrgService(context, route, connection, this.options.instanceUrl);
      const services = new RequestScopedServices(orgService, workspace.root);
      return new RequestScope(context, route, connection, workspace, services);
    } catch (error) {
      if (workspace) await workspace.cleanup().catch(() => undefined);
      throw withCorrelation(
        toIdentityRuntimeError(
          error,
          'MCP_REQUEST_SCOPE_FAILED',
          'The server could not create the isolated Salesforce request scope.',
        ),
        identity.correlationId,
      );
    }
  }
}
