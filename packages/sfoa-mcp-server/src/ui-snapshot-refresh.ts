import { randomUUID } from 'node:crypto';
import type { MySqlUiSnapshotRepository, ControlPlaneRepositories } from '@sfoa/control-plane';
import { ControlPlaneError } from '@sfoa/control-plane';
import { createSalesforceIdentityRoute, type IdentityRuntime } from '@sfoa/identity-runtime';
import { collectUiSnapshot, UI_PARSER_VERSION } from '@sfoa/mcp-provider-sfoa-context';

export async function refreshCurrentUiSnapshot(runtime: IdentityRuntime, repositories: ControlPlaneRepositories,
  snapshots: MySqlUiSnapshotRepository, objectApiName: string, actor: string): Promise<void> {
  const [diagnostic, users] = await Promise.all([repositories.diagnostic.get(), repositories.identityRoutes.listActiveSalesforceUsernames()]);
  if (!diagnostic?.enabled || diagnostic.verificationStatus !== 'PASS'
    || users.some((username) => username.toLowerCase() === diagnostic.salesforceUsername.toLowerCase())) {
    throw new ControlPlaneError('MCP_CONTROL_PLANE_CONFIGURATION_INVALID', 'A verified independent DIAGNOSTIC identity is required for UI snapshot refresh.');
  }
  const correlationId = randomUUID();
  const platformUserId = `admin-ui-${actor}`.slice(0, 128);
  const scope = await runtime.scopeFactory.createForRoute({ platformUserId, correlationId }, createSalesforceIdentityRoute({
    platformUserId, salesforceUsername: diagnostic.salesforceUsername, connectionRole: 'DIAGNOSTIC',
    credentialProfile: 'sfoa-shared-jwt', aliases: [],
  }));
  let token: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  const abort = new AbortController();
  try {
    await Promise.race([(async () => {
      const connection = await scope.getConnection();
      const info = await connection.soap.getUserInfo();
      abort.signal.throwIfAborted();
      token = await snapshots.beginRefresh(info.organizationId, objectApiName, UI_PARSER_VERSION);
      abort.signal.throwIfAborted();
      const snapshot = await collectUiSnapshot(connection, objectApiName, abort.signal);
      abort.signal.throwIfAborted();
      await snapshots.finishRefresh(token, snapshot, UI_PARSER_VERSION);
    })(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new Error('SNAPSHOT_REFRESH_TIMEOUT')); }, 120000);
    })]);
    await repositories.audits.append({ occurredAt: new Date(), correlationId, auditKind: 'ADMIN_ACTION', channel: 'ADMIN', actorAdmin: actor, toolName: 'REFRESH_UI_SNAPSHOT', result: 'PASS',
      requestSummary: { objectApiName }, responseSummary: { parserVersion: UI_PARSER_VERSION } }).catch(() => undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const reason = /^[A-Z0-9_]{1,128}$/u.test(message) ? message : 'SNAPSHOT_REFRESH_FAILED';
    if (token) await snapshots.failRefresh(token, reason).catch(() => undefined);
    await repositories.audits.append({ occurredAt: new Date(), correlationId, auditKind: 'ADMIN_ACTION', channel: 'ADMIN',
      actorAdmin: actor, toolName: 'REFRESH_UI_SNAPSHOT', result: 'ERROR', requestSummary: { objectApiName },
      responseSummary: { reason } }).catch(() => undefined);
    if (error instanceof ControlPlaneError) throw error;
    throw new ControlPlaneError('MCP_CONTROL_PLANE_CONFIGURATION_INVALID', 'UI snapshot refresh failed or exceeded its bound; the last valid snapshot was retained.');
  } finally {
    clearTimeout(timer); abort.abort(); await scope.close().catch(() => undefined);
  }
}
