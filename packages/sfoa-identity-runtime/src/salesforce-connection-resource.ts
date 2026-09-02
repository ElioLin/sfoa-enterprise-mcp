import type { Connection } from '@salesforce/core';
import type { SalesforceConnectionFactory } from './connection-factory.js';
import type { SalesforceIdentityRoute } from './contracts.js';
import { IdentityRuntimeError, toIdentityRuntimeError, withCorrelation } from './errors.js';
import type { RequestWorkspace } from './workspace.js';

export interface SalesforceConnectionProvider {
  getConnection(): Promise<Connection>;
}

export class RequestScopedSalesforceConnection implements SalesforceConnectionProvider {
  private connectionPromise: Promise<Connection> | undefined;
  private closed = false;

  public constructor(
    private readonly route: SalesforceIdentityRoute,
    private readonly connectionFactory: SalesforceConnectionFactory,
    private readonly workspace: RequestWorkspace,
    private readonly correlationId: string,
  ) {}

  public getConnection(): Promise<Connection> {
    if (this.closed) return Promise.reject(this.closedError());
    // Store the complete initialization Promise before awaiting. Concurrent callers in this
    // request therefore share JWT, Connection.create, and workspace API-version synchronization.
    this.connectionPromise ??= this.initialize();
    return this.connectionPromise;
  }

  public close(): void {
    this.closed = true;
  }

  private async initialize(): Promise<Connection> {
    try {
      const connection = await this.connectionFactory.create(this.route);
      if (this.closed) throw this.closedError();
      await this.workspace.setApiVersion(connection.getApiVersion());
      if (this.closed) throw this.closedError();
      return connection;
    } catch (error) {
      throw withCorrelation(
        toIdentityRuntimeError(
          error,
          this.route.connectionRole === 'DIAGNOSTIC'
            ? 'MCP_SALESFORCE_AUTH_FAILED'
            : 'MCP_REQUEST_SCOPE_FAILED',
          this.route.connectionRole === 'DIAGNOSTIC'
            ? 'The server could not initialize the isolated DIAGNOSTIC Salesforce Connection.'
            : 'The server could not initialize the isolated Salesforce request Connection.',
        ),
        this.correlationId,
      );
    }
  }

  private closedError(): IdentityRuntimeError {
    return new IdentityRuntimeError(
      'MCP_REQUEST_SCOPE_FAILED',
      'The request-scoped Salesforce Connection is unavailable because the request has already closed.',
      { correlationId: this.correlationId },
    );
  }
}
