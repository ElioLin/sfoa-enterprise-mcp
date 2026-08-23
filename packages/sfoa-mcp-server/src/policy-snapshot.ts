import {
  loadMySqlRequestPolicySnapshot,
  type ControlPlaneDatabaseClient,
  type RequestPolicySnapshot,
} from '@sfoa/control-plane';
import { parseDmlAllowlistJson, type DmlAllowlistPolicy } from '@sfoa/mcp-provider-sfoa-dml';
import { createSalesforceIdentityRoute, type SalesforceIdentityRoute } from '@sfoa/identity-runtime';

export interface RuntimePolicySnapshotSource {
  load(platformUserId: string): Promise<RequestPolicySnapshot>;
}

export class MySqlRuntimePolicySnapshotSource implements RuntimePolicySnapshotSource {
  public constructor(private readonly database: ControlPlaneDatabaseClient) {}

  public async load(platformUserId: string): Promise<RequestPolicySnapshot> {
    return loadMySqlRequestPolicySnapshot(this.database, platformUserId);
  }
}

export function snapshotUserRoute(snapshot: RequestPolicySnapshot): SalesforceIdentityRoute | undefined {
  const route = snapshot.identityRoute;
  return route
    ? createSalesforceIdentityRoute({
        platformUserId: route.platformUserId,
        salesforceUsername: route.salesforceUsername,
        credentialProfile: 'sfoa-shared-jwt',
        connectionRole: 'USER',
        aliases: [],
      })
    : undefined;
}

export function snapshotDiagnosticRoute(
  snapshot: RequestPolicySnapshot,
  platformUserId: string,
): SalesforceIdentityRoute | undefined {
  const diagnostic = snapshot.diagnostic;
  return diagnostic
    ? createSalesforceIdentityRoute({
        platformUserId,
        salesforceUsername: diagnostic.salesforceUsername,
        credentialProfile: 'sfoa-shared-jwt',
        connectionRole: 'DIAGNOSTIC',
        aliases: [],
      })
    : undefined;
}

export function snapshotDmlAllowlist(snapshot: RequestPolicySnapshot): DmlAllowlistPolicy {
  const entries = snapshot.dmlPolicies.map((policy) => ({
    objectApiName: policy.objectApiName,
    operations: [
      ...(policy.allowCreate ? ['CREATE' as const] : []),
      ...(policy.allowUpdate ? ['UPDATE' as const] : []),
    ],
  })).filter((entry) => entry.operations.length > 0);
  return parseDmlAllowlistJson(JSON.stringify(entries));
}
