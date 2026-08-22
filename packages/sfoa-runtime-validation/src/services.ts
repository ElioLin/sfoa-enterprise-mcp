import type { Connection } from '@salesforce/core';
import type {
  ConfigService,
  OrgConfigInfo,
  OrgService,
  SanitizedOrgAuthorization,
  Services,
  TelemetryEvent,
  TelemetryService,
} from '@salesforce/mcp-provider-api';

class NoopTelemetryService implements TelemetryService {
  public sendEvent(_eventName: string, _event: TelemetryEvent): void {
    // P0-Closure intentionally emits no Salesforce telemetry from the validation harness.
  }
}

export type ValidationServicesOptions = {
  connection: Connection;
  username: string;
  alias: string;
  orgId: string;
  instanceUrl: string;
  dataDir: string;
};

export class ValidationServices implements Services {
  private readonly telemetry = new NoopTelemetryService();

  public constructor(private readonly options: ValidationServicesOptions) {}

  public getTelemetryService(): TelemetryService {
    return this.telemetry;
  }

  public getConfigService(): ConfigService {
    return {
      getDataDir: () => this.options.dataDir,
      getStartupFlags: () => ({
        'allow-non-ga-tools': false,
        debug: false,
      }),
    };
  }

  public getOrgService(): OrgService {
    return {
      getAllowedOrgUsernames: async () => new Set([this.options.username]),
      getAllowedOrgs: async () => [this.toAuthorization()],
      getConnection: async (usernameOrAlias: string) => this.getConnection(usernameOrAlias),
      getDefaultTargetOrg: async () => this.getDefaultTargetOrg(),
      getDefaultTargetDevHub: async () => undefined,
      findOrgByUsernameOrAlias: (orgs, usernameOrAlias) => findOrg(orgs, usernameOrAlias),
    };
  }

  private async getConnection(usernameOrAlias: string): Promise<Connection> {
    const isUsername = usernameOrAlias.localeCompare(this.options.username, undefined, { sensitivity: 'accent' }) === 0;
    if (!isUsername && usernameOrAlias !== this.options.alias) {
      throw new Error('The requested org is outside the P0-Closure validation allowlist.');
    }
    return this.options.connection;
  }

  private async getDefaultTargetOrg(): Promise<OrgConfigInfo> {
    return {
      key: 'target-org',
      value: this.options.username,
      path: this.options.dataDir,
    };
  }

  private toAuthorization(): SanitizedOrgAuthorization {
    return {
      aliases: [this.options.alias],
      configs: [],
      username: this.options.username,
      instanceUrl: this.options.instanceUrl,
      orgId: this.options.orgId,
      oauthMethod: 'jwt',
      isExpired: false,
    };
  }
}

function findOrg(
  orgs: SanitizedOrgAuthorization[],
  usernameOrAlias: string,
): SanitizedOrgAuthorization | undefined {
  return orgs.find(
    (org) =>
      org.username?.localeCompare(usernameOrAlias, undefined, { sensitivity: 'accent' }) === 0 ||
      (org.aliases?.includes(usernameOrAlias) ?? false),
  );
}
