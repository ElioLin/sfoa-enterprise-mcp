import { performance } from 'node:perf_hooks';
import type {
  DiagnosticConfigRecord,
  DiagnosticVerificationDto,
  IdentityRouteRecord,
  RouteVerificationDto,
} from '@sfoa/control-plane';
import {
  createSalesforceIdentityRoute,
  type IdentityRuntime,
} from '@sfoa/identity-runtime';
import { verifyDiagnosticThroughP4Scope } from '@sfoa/mcp-server';
import { safeVerificationError } from './errors.js';

export async function verifyIdentityRoute(
  runtime: IdentityRuntime,
  route: IdentityRouteRecord,
  correlationId: string,
): Promise<RouteVerificationDto> {
  const started = performance.now();
  let scope: Awaited<ReturnType<IdentityRuntime['scopeFactory']['createForRoute']>> | undefined;
  try {
    scope = await runtime.scopeFactory.createForRoute(
      { platformUserId: route.platformUserId, correlationId },
      createSalesforceIdentityRoute({
        platformUserId: route.platformUserId,
        salesforceUsername: route.salesforceUsername,
        credentialProfile: 'sfoa-shared-jwt',
        connectionRole: 'USER',
        aliases: [],
      }),
    );
    const identity = await scope.connection.identity();
    const actual = typeof identity.username === 'string' ? identity.username : '';
    const identityMatched = actual === route.salesforceUsername;
    return Object.freeze({
      status: identityMatched ? 'PASS' : 'FAIL',
      identityMatched,
      salesforceUsername: actual || null,
      durationMs: Math.round(performance.now() - started),
      error: identityMatched
        ? null
        : Object.freeze({
            code: 'MCP_IDENTITY_CONTEXT_MISMATCH',
            message: 'Connection.identity() did not match the configured Salesforce username.',
          }),
    });
  } catch (error) {
    return Object.freeze({
      status: 'FAIL',
      identityMatched: false,
      salesforceUsername: null,
      durationMs: Math.round(performance.now() - started),
      error: safeVerificationError(error, runtime.redactionSecrets),
    });
  } finally {
    await scope?.close().catch(() => undefined);
  }
}

export async function verifyDiagnosticConfig(
  runtime: IdentityRuntime,
  config: DiagnosticConfigRecord,
  actorAdmin: string,
  correlationId: string,
): Promise<DiagnosticVerificationDto['verification']> {
  const started = performance.now();
  try {
    const result = await verifyDiagnosticThroughP4Scope(runtime, {
      platformUserId: `admin-diagnostic-${actorAdmin}`.slice(0, 128),
      correlationId,
      salesforceUsername: config.salesforceUsername,
      metadataType: config.testMetadataType,
      metadataFullName: config.testMetadataFullName,
    });
    return Object.freeze({
      status: result.status,
      identityMatched: result.identityMatched,
      salesforceUsername: result.salesforceUsername,
      apiVersion: result.apiVersion,
      durationMs: result.durationMs,
      tooling: result.tooling,
      metadata: result.metadata,
      cleanup: result.cleanup,
      error: null,
    });
  } catch (error) {
    return Object.freeze({
      status: 'FAIL',
      identityMatched: false,
      salesforceUsername: config.salesforceUsername,
      apiVersion: null,
      durationMs: Math.round(performance.now() - started),
      tooling: null,
      metadata: null,
      cleanup: null,
      error: safeVerificationError(error, runtime.redactionSecrets),
    });
  }
}
