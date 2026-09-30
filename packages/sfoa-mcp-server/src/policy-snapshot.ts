import {
  createMySqlRepositories,
  loadMySqlRequestPolicySnapshot,
  loadMySqlDiscoveryPolicySnapshot,
  type RuntimeDiscoveryPolicySnapshot,
  type ControlPlaneDatabaseClient,
  type RequestPolicySnapshot,
} from '@sfoa/control-plane';
import { parseDmlAllowlistJson, type DmlAllowlistPolicy } from '@sfoa/mcp-provider-sfoa-dml';
import { createSalesforceIdentityRoute, type SalesforceIdentityRoute } from '@sfoa/identity-runtime';
import { parseAttachmentPolicyJson, type AttachmentPolicy } from './attachment-policy.js';
import type { RuntimeManagedDmlFieldRule } from './dml-managed-fields.js';
import { RemoteRuntimeError } from './errors.js';

export interface RuntimePolicySnapshotSource {
  load(platformUserId: string): Promise<RequestPolicySnapshot>;
  /**
   * The Salesforce usernames this deployment has configured as enabled identity routes.
   *
   * Optional, and deliberately not part of `RequestPolicySnapshot`. It is not a per-request policy — it is
   * the deployment's route *table*, the same for every caller — and folding it into the snapshot would put
   * a whole-table read on the request path of every Tool to serve one. It is also not the requesting
   * user's own route, which the snapshot does carry: the difference is the whole point, because
   * `explain_field_access` needs to know which *other* users a caller may ask about, and the answer is
   * this list rather than the caller's own row.
   *
   * Declared here rather than as a new constructor argument threaded through `runtime.ts`,
   * `startRemoteMcpServer` and the request handler: the source is already the object that owns
   * control-plane reads for a request, and a Tool-specific parameter would have to reach four layers
   * before it reached the one that uses it. An environment-configured runtime implements no such method,
   * which is exactly the signal `explain_field_access` needs to refuse a self-subject (see
   * `field-access-target-users.ts`).
   */
  listConfiguredSalesforceUsernames?(): Promise<readonly string[]>;
}

export interface RuntimeDiscoveryPolicySnapshotSource {
  load(): Promise<RuntimeDiscoveryPolicySnapshot>;
}

export class MySqlRuntimeDiscoveryPolicySnapshotSource implements RuntimeDiscoveryPolicySnapshotSource {
  public constructor(private readonly database: ControlPlaneDatabaseClient) {}

  public async load(): Promise<RuntimeDiscoveryPolicySnapshot> {
    return loadMySqlDiscoveryPolicySnapshot(this.database);
  }
}

export class MySqlRuntimePolicySnapshotSource implements RuntimePolicySnapshotSource {
  public constructor(private readonly database: ControlPlaneDatabaseClient) {}

  public async load(platformUserId: string): Promise<RequestPolicySnapshot> {
    return loadMySqlRequestPolicySnapshot(this.database, platformUserId);
  }

  /**
   * Read-only, and the same repository query the snapshot loader already uses for its own
   * diagnostic/USER-username conflict check — so this adds no new query shape to the control plane and no
   * new table access, only a second caller for one that exists.
   */
  public async listConfiguredSalesforceUsernames(): Promise<readonly string[]> {
    return createMySqlRepositories(this.database).identityRoutes.listActiveSalesforceUsernames();
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

export function snapshotDmlAllowlist(snapshot: RuntimeDiscoveryPolicySnapshot): DmlAllowlistPolicy {
  const entries = snapshot.dmlPolicies.map((policy) => ({
    objectApiName: policy.objectApiName,
    operations: [
      ...(policy.allowCreate ? ['CREATE' as const] : []),
      ...(policy.allowUpdate ? ['UPDATE' as const] : []),
    ],
  })).filter((entry) => entry.operations.length > 0);
  return parseDmlAllowlistJson(JSON.stringify(entries));
}

/**
 * The attachment channel is derived from the same policy rows but stays a separate
 * policy: an object that only sets `attachmentEnabled` yields no DML entry above and
 * would otherwise be silently dropped, and an object that only sets `allowCreate`
 * must not gain file upload as a side effect.
 */
export function snapshotAttachmentPolicy(snapshot: RuntimeDiscoveryPolicySnapshot): AttachmentPolicy {
  const entries = snapshot.dmlPolicies
    .filter((policy) => policy.attachmentEnabled)
    .map((policy) => ({ objectApiName: policy.objectApiName }));
  return parseAttachmentPolicyJson(JSON.stringify(entries));
}

export function snapshotManagedDmlFieldRules(snapshot: RuntimeDiscoveryPolicySnapshot): readonly RuntimeManagedDmlFieldRule[] {
  const objectsByPolicyId = new Map(snapshot.dmlPolicies.map((policy) => [policy.id, policy.objectApiName]));
  return Object.freeze(snapshot.managedDmlFieldRules.map((rule) => {
    const objectApiName = objectsByPolicyId.get(rule.dmlPolicyId);
    if (!objectApiName) {
      throw new RemoteRuntimeError(
        'MCP_DML_MANAGED_FIELD_CONFIG_INVALID',
        `Managed DML field rule ${rule.id} is detached from its request policy snapshot.`,
      );
    }
    return Object.freeze({ ...rule, objectApiName });
  }));
}
