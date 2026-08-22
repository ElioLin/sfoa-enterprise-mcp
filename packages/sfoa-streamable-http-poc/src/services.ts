import {
  AuthInfo,
  ConfigAggregator,
  Connection,
  OrgConfigProperties,
  type OrgAuthorization,
} from '@salesforce/core';
import {
  type ConfigService,
  type OrgConfigInfo,
  type OrgService,
  type SanitizedOrgAuthorization,
  type Services,
  type TelemetryEvent,
  type TelemetryService,
} from '@salesforce/mcp-provider-api';

class NoopTelemetryService implements TelemetryService {
  public sendEvent(_eventName: string, _event: TelemetryEvent): void {
    // P0 POC intentionally disables telemetry.
  }
}

export type PocServicesOptions = {
  allowedOrgs?: ReadonlySet<string>;
  dataDir?: string;
};

export class PocServices implements Services {
  private readonly allowedOrgs: ReadonlySet<string>;
  private readonly dataDir: string;
  private readonly telemetry = new NoopTelemetryService();

  public constructor(options: PocServicesOptions = {}) {
    this.allowedOrgs = options.allowedOrgs ?? new Set<string>();
    this.dataDir = options.dataDir ?? process.cwd();
  }

  public getTelemetryService(): TelemetryService {
    return this.telemetry;
  }

  public getConfigService(): ConfigService {
    return {
      getDataDir: () => this.dataDir,
      getStartupFlags: () => ({
        'allow-non-ga-tools': false,
        debug: false,
      }),
    };
  }

  public getOrgService(): OrgService {
    return {
      getAllowedOrgUsernames: async () => new Set(this.allowedOrgs),
      getAllowedOrgs: async () => this.getAllowedOrgs(),
      getConnection: async (usernameOrAlias: string) => this.getConnection(usernameOrAlias),
      getDefaultTargetOrg: async () => this.getDefaultConfig(OrgConfigProperties.TARGET_ORG),
      getDefaultTargetDevHub: async () => this.getDefaultConfig(OrgConfigProperties.TARGET_DEV_HUB),
      findOrgByUsernameOrAlias: (orgs, usernameOrAlias) => findOrgByUsernameOrAlias(orgs, usernameOrAlias),
    };
  }

  private async getAllowedOrgs(): Promise<SanitizedOrgAuthorization[]> {
    const authorizations = await AuthInfo.listAllAuthorizations();
    const sanitized = authorizations.map(sanitizeOrg);

    return sanitized.filter((org) => {
      if (this.allowedOrgs.has('ALLOW_ALL_ORGS')) return true;
      if (!org.username) return false;
      if (this.allowedOrgs.has(org.username)) return true;
      return org.aliases?.some((alias) => this.allowedOrgs.has(alias)) ?? false;
    });
  }

  private async getConnection(usernameOrAlias: string): Promise<Connection> {
    const found = findOrgByUsernameOrAlias(await this.getAllowedOrgs(), usernameOrAlias);
    if (!found?.username) {
      throw new Error('The requested org is not present in the POC allowlist.');
    }

    const authInfo = await AuthInfo.create({ username: found.username });
    return Connection.create({ authInfo });
  }

  private async getDefaultConfig(
    property: OrgConfigProperties.TARGET_ORG | OrgConfigProperties.TARGET_DEV_HUB,
  ): Promise<OrgConfigInfo | undefined> {
    await ConfigAggregator.clearInstance();
    const aggregator = await ConfigAggregator.create();
    const { key, location, path, value } = aggregator.getInfo(property);

    if (!value || typeof value !== 'string' || !path) return undefined;
    return { key, location, path, value };
  }
}

function sanitizeOrg(org: OrgAuthorization): SanitizedOrgAuthorization {
  return {
    aliases: org.aliases,
    configs: org.configs,
    username: org.username,
    instanceUrl: org.instanceUrl,
    isScratchOrg: org.isScratchOrg,
    isDevHub: org.isDevHub,
    isSandbox: org.isSandbox,
    orgId: org.orgId,
    oauthMethod: org.oauthMethod,
    isExpired: org.isExpired,
  };
}

function findOrgByUsernameOrAlias(
  orgs: SanitizedOrgAuthorization[],
  usernameOrAlias: string,
): SanitizedOrgAuthorization | undefined {
  return orgs.find(
    (org) => org.username === usernameOrAlias || (org.aliases?.includes(usernameOrAlias) ?? false),
  );
}

export function allowedOrgsFromEnvironment(): ReadonlySet<string> {
  const values = (process.env.SFOA_POC_ORGS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return new Set(values);
}
