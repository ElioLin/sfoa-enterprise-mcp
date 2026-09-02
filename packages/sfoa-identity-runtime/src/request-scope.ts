import type { Connection } from '@salesforce/core';
import type { SalesforceIdentityRoute } from './contracts.js';
import { createSalesforceIdentityRoute } from './contracts.js';
import type { SalesforceConnectionFactory } from './connection-factory.js';
import { IdentityRuntimeError, toIdentityRuntimeError, withCorrelation } from './errors.js';
import type { IdentityResolver } from './identity-resolver.js';
import { RequestScopedOrgService } from './org-service.js';
import { currentRequestAuditContext } from './request-audit-context.js';
import {
  createRequestContext,
  parseTrustedRequestHeaders,
  type RequestContext,
  type RequestHeaders,
  type TrustedRequestIdentity,
} from './request-context.js';
import { RequestScopedServices } from './services.js';
import { RequestScopedSalesforceConnection } from './salesforce-connection-resource.js';
import type { RequestWorkspace, RequestWorkspaceFactory } from './workspace.js';

export class RequestScope {
  private closed = false;

  public constructor(
    public readonly context: RequestContext,
    public readonly route: SalesforceIdentityRoute,
    public readonly salesforce: RequestScopedSalesforceConnection,
    public readonly workspace: RequestWorkspace,
    public readonly services: RequestScopedServices,
  ) {}

  public getConnection(): Promise<Connection> {
    return this.salesforce.getConnection();
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.salesforce.close();
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
    const route = await this.options.resolver.resolve(identity.platformUserId, identity.correlationId);
    return this.createForRoute(identity, route);
  }

  public async createForRoute(
    identity: TrustedRequestIdentity,
    route: SalesforceIdentityRoute,
  ): Promise<RequestScope> {
    let workspace: RequestWorkspace | undefined;
    try {
      if (route.platformUserId !== identity.platformUserId) {
        throw new IdentityRuntimeError(
          'MCP_IDENTITY_CONTEXT_MISMATCH',
          'The resolved Salesforce route does not belong to the authenticated platform user.',
          { correlationId: identity.correlationId },
        );
      }

      currentRequestAuditContext()?.withSalesforceRoute({
        salesforceUsername: route.salesforceUsername,
        executionRole: route.connectionRole,
      });
      workspace = await this.options.workspaceFactory.create(identity.correlationId);
      const context = createRequestContext(identity, workspace.root);
      const salesforce = new RequestScopedSalesforceConnection(
        route,
        this.options.connectionFactory,
        workspace,
        identity.correlationId,
      );
      const orgService = new RequestScopedOrgService(context, route, salesforce, this.options.instanceUrl);
      const services = new RequestScopedServices(orgService, workspace.root);
      return new RequestScope(context, route, salesforce, workspace, services);
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

export type DiagnosticRequestScopeFactoryOptions = Readonly<{
  diagnosticUsername: string;
  connectionFactory: SalesforceConnectionFactory;
  workspaceFactory: RequestWorkspaceFactory;
  instanceUrl: string;
}>;

export class DiagnosticRequestScopeFactory {
  public constructor(private readonly options: DiagnosticRequestScopeFactoryOptions) {}

  public async create(identity: TrustedRequestIdentity): Promise<RequestScope> {
    let workspace: RequestWorkspace | undefined;
    try {
      const route = createSalesforceIdentityRoute({
        platformUserId: identity.platformUserId,
        salesforceUsername: this.options.diagnosticUsername,
        credentialProfile: 'sfoa-shared-jwt-diagnostic',
        connectionRole: 'DIAGNOSTIC',
        aliases: [],
      });
      currentRequestAuditContext()?.withSalesforceRoute({
        salesforceUsername: route.salesforceUsername,
        executionRole: route.connectionRole,
      });
      workspace = await this.options.workspaceFactory.create(identity.correlationId);
      const context = createRequestContext(identity, workspace.root);
      const salesforce = new RequestScopedSalesforceConnection(
        route,
        this.options.connectionFactory,
        workspace,
        identity.correlationId,
      );
      const orgService = new RequestScopedOrgService(context, route, salesforce, this.options.instanceUrl);
      const services = new RequestScopedServices(orgService, workspace.root);
      return new RequestScope(context, route, salesforce, workspace, services);
    } catch (error) {
      if (workspace) await workspace.cleanup().catch(() => undefined);
      throw withCorrelation(
        toIdentityRuntimeError(
          error,
          'MCP_SALESFORCE_AUTH_FAILED',
          'The server could not create the isolated DIAGNOSTIC Salesforce request scope.',
        ),
        identity.correlationId,
      );
    }
  }
}
