import { AuthInfo, Connection } from '@salesforce/core';
import { z } from 'zod';
import type { SalesforceIdentityRoute } from './contracts.js';
import { IdentityRuntimeError } from './errors.js';

const jwtCredentialConfigSchema = z
  .object({
    instanceUrl: z.string().url().startsWith('https://'),
    clientId: z.string().trim().min(1).max(512),
    privateKeyPath: z.string().trim().min(1).max(2048),
  })
  .strict();

export type JwtCredentialConfig = Readonly<z.infer<typeof jwtCredentialConfigSchema>>;

export interface SalesforceConnectionFactory {
  create(route: SalesforceIdentityRoute): Promise<Connection>;
}

export type JwtOAuthOptions = Readonly<{
  username: string;
  clientId: string;
  privateKeyFile: string;
  loginUrl: string;
}>;

export type JwtConnectionFactoryDependencies = Readonly<{
  createAuthInfo(options: JwtOAuthOptions): Promise<AuthInfo>;
  createConnection(authInfo: AuthInfo): Promise<Connection>;
}>;

const defaultDependencies: JwtConnectionFactoryDependencies = {
  createAuthInfo: async (options) => AuthInfo.create({ oauth2Options: options }),
  createConnection: async (authInfo) => Connection.create({ authInfo }),
};

export class JwtConnectionFactory implements SalesforceConnectionFactory {
  private readonly config: JwtCredentialConfig;

  public constructor(
    config: JwtCredentialConfig,
    private readonly dependencies: JwtConnectionFactoryDependencies = defaultDependencies,
  ) {
    this.config = Object.freeze(jwtCredentialConfigSchema.parse(config));
  }

  public async create(route: SalesforceIdentityRoute): Promise<Connection> {
    let authInfo: AuthInfo;
    try {
      authInfo = await this.dependencies.createAuthInfo({
        username: route.salesforceUsername,
        clientId: this.config.clientId,
        privateKeyFile: this.config.privateKeyPath,
        loginUrl: this.config.instanceUrl,
      });
    } catch (error) {
      throw new IdentityRuntimeError(
        'MCP_SALESFORCE_AUTH_FAILED',
        'Salesforce JWT authentication failed for the resolved request identity. Verify the connected-app assignment, username, instance URL, and JWT key configuration.',
        { cause: error },
      );
    }

    try {
      return await this.dependencies.createConnection(authInfo);
    } catch (error) {
      throw new IdentityRuntimeError(
        'MCP_SALESFORCE_CONNECTION_FAILED',
        'Salesforce Connection creation failed for the resolved request identity. Retry the request and verify SFoA availability.',
        { cause: error },
      );
    }
  }
}
