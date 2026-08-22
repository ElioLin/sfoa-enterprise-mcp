import type {
  ConfigService,
  OrgService,
  Services,
  TelemetryEvent,
  TelemetryService,
} from '@salesforce/mcp-provider-api';

class NoopTelemetryService implements TelemetryService {
  public sendEvent(_eventName: string, _event: TelemetryEvent): void {
    // P1 logs request-level operational metadata itself and emits no Salesforce telemetry.
  }
}

export class RequestScopedServices implements Services {
  private readonly telemetry = new NoopTelemetryService();

  public constructor(
    private readonly orgService: OrgService,
    private readonly workspaceRoot: string,
  ) {}

  public getTelemetryService(): TelemetryService {
    return this.telemetry;
  }

  public getOrgService(): OrgService {
    return this.orgService;
  }

  public getConfigService(): ConfigService {
    return {
      getDataDir: () => this.workspaceRoot,
      getStartupFlags: () => ({
        'allow-non-ga-tools': false,
        debug: false,
      }),
    };
  }
}
