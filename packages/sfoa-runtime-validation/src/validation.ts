import { performance } from 'node:perf_hooks';
import { AuthInfo, Connection } from '@salesforce/core';
import type { RuntimeValidationOutcome, RuntimeValidationReport } from './types.js';
import type { ValidationConfig } from './config.js';
import { describeAccessToken, redactError } from './security.js';
import { createOfficialToolSession, type OfficialToolSession } from './official-tools.js';
import { ValidationServices } from './services.js';
import { createMetadataWorkspace, type MetadataWorkspace } from './workspace.js';

export async function runRuntimeValidation(config: ValidationConfig): Promise<RuntimeValidationOutcome> {
  const report = createInitialReport(config);
  let accessToken: string | undefined;
  let connection: Connection | undefined;

  const jwtStarted = performance.now();
  try {
    const authInfo = await AuthInfo.create({
      oauth2Options: {
        username: config.username,
        clientId: config.clientId,
        privateKeyFile: config.privateKeyPath,
        loginUrl: config.instanceUrl,
      },
    });
    report.freshJwt = { status: 'PASS', durationMs: elapsed(jwtStarted) };
    accessToken = authInfo.getConnectionOptions().accessToken;

    if (!accessToken) {
      report.token = {
        ...report.token,
        status: 'FAIL',
        error: 'JWT authentication completed without returning an access token.',
      };
      report.overall = 'FAIL';
      return { report };
    }

    const tokenDescription = describeAccessToken(accessToken);
    report.token = {
      status: tokenDescription.isExpired === true ? 'FAIL' : 'PASS',
      available: true,
      usable: false,
      tokenType: tokenDescription.tokenType,
      expiration: tokenDescription.expiration,
      issuer: tokenDescription.issuer,
      audience: tokenDescription.audience,
      subject: tokenDescription.subject,
      scope: tokenDescription.scope,
      ...(tokenDescription.isExpired === true ? { error: 'The returned JWT access token is expired.' } : {}),
    };

    connection = await Connection.create({ authInfo });
  } catch (error) {
    report.freshJwt = {
      status: 'FAIL',
      durationMs: elapsed(jwtStarted),
      error: safeError(error, config, accessToken),
    };
    report.overall = 'FAIL';
    return { report };
  }

  const identityStarted = performance.now();
  try {
    const identity = await connection.identity();
    const instanceUrl = connection.getConnectionOptions().instanceUrl ?? connection.instanceUrl;
    const matchesUsername = sameUsername(identity.username, config.username);
    report.directConnection = { status: 'PASS', durationMs: elapsed(identityStarted) };
    report.identity = {
      status: matchesUsername ? 'PASS' : 'FAIL',
      durationMs: elapsed(identityStarted),
      matchesConfiguredUsername: matchesUsername,
      userId: identity.user_id,
      username: identity.username,
      orgId: identity.organization_id,
      instanceUrl,
      ...(!matchesUsername
        ? { error: 'Salesforce identity username does not match SALESFORCE_USERNAME.' }
        : {}),
    };
    report.token.usable = true;
  } catch (error) {
    const message = safeError(error, config, accessToken);
    report.directConnection = { status: 'FAIL', durationMs: elapsed(identityStarted), error: message };
    report.identity = {
      ...report.identity,
      status: 'FAIL',
      durationMs: elapsed(identityStarted),
      error: message,
    };
    report.token.usable = false;
    report.token.error = report.token.error ?? 'The acquired token failed the Salesforce identity usability check.';
    report.overall = 'FAIL';
    return { report, accessToken };
  }

  const soql = `SELECT Id FROM ${config.testObject} LIMIT 5`;
  const directStarted = performance.now();
  try {
    const result = await connection.query(soql);
    report.directSoql = {
      status: 'PASS',
      durationMs: elapsed(directStarted),
      objectApiName: config.testObject,
      rows: result.records.length,
    };
  } catch (error) {
    report.directSoql = {
      status: 'FAIL',
      durationMs: elapsed(directStarted),
      objectApiName: config.testObject,
      error: safeError(error, config, accessToken),
    };
  }

  const services = new ValidationServices({
    connection,
    username: config.username,
    alias: config.alias,
    orgId: report.identity.orgId ?? '',
    instanceUrl: report.identity.instanceUrl ?? config.instanceUrl,
    dataDir: config.projectRoot,
  });
  let session: OfficialToolSession | undefined;
  let workspace: MetadataWorkspace | undefined;

  try {
    session = await createOfficialToolSession(services);
    const requiredTools = ['run_soql_query', 'retrieve_metadata'];
    const hasRequiredTools = requiredTools.every((name) => session?.toolNames.includes(name));
    report.providerCompatibility = hasRequiredTools
      ? { status: 'PASS' }
      : { status: 'FAIL', error: `DxCoreMcpProvider did not provide: ${requiredTools.join(', ')}.` };

    const officialSoqlStarted = performance.now();
    const beforeSoqlCwd = process.cwd();
    try {
      const result = await session.callSoql({
        query: soql,
        username: config.username,
        directory: config.projectRoot,
      });
      report.officialSoql = result.error
        ? {
            status: 'FAIL',
            durationMs: elapsed(officialSoqlStarted),
            objectApiName: config.testObject,
            toolName: 'run_soql_query',
            provider: session.providerName,
            error: safeError(result.error, config, accessToken),
          }
        : {
            status: 'PASS',
            durationMs: elapsed(officialSoqlStarted),
            objectApiName: config.testObject,
            rows: result.rows,
            toolName: 'run_soql_query',
            provider: session.providerName,
          };
    } catch (error) {
      report.officialSoql = {
        status: 'FAIL',
        durationMs: elapsed(officialSoqlStarted),
        objectApiName: config.testObject,
        toolName: 'run_soql_query',
        provider: session.providerName,
        error: safeError(error, config, accessToken),
      };
    } finally {
      restoreCwd(beforeSoqlCwd);
    }

    const workspaceStarted = performance.now();
    try {
      workspace = await createMetadataWorkspace(
        connection.getApiVersion(),
        config.metadataType,
        config.metadataFullName,
      );
      report.metadataWorkspace = { status: 'PASS', durationMs: elapsed(workspaceStarted) };
    } catch (error) {
      report.metadataWorkspace = {
        status: 'FAIL',
        durationMs: elapsed(workspaceStarted),
        error: safeError(error, config, accessToken),
      };
    }

    if (workspace) {
      const beforeMetadataCwd = process.cwd();
      let cwdAfterOfficialTool = beforeMetadataCwd;
      const metadataStarted = performance.now();
      try {
        const result = await session.callMetadata({
          username: config.username,
          directory: workspace.root,
          manifestPath: workspace.manifestPath,
        });
        cwdAfterOfficialTool = process.cwd();
        const retrievedFiles = result.success ? await workspace.countRetrievedFiles() : 0;
        report.officialMetadata = result.success && retrievedFiles > 0
          ? {
              status: 'PASS',
              durationMs: elapsed(metadataStarted),
              metadataType: config.metadataType,
              fullName: config.metadataFullName,
              retrievedFiles,
            }
          : {
              status: 'FAIL',
              durationMs: elapsed(metadataStarted),
              metadataType: config.metadataType,
              fullName: config.metadataFullName,
              retrievedFiles,
              error: safeError(
                result.error ?? 'Official retrieve_metadata reported success but produced no metadata files.',
                config,
                accessToken,
              ),
            };
      } catch (error) {
        cwdAfterOfficialTool = process.cwd();
        report.officialMetadata = {
          status: 'FAIL',
          durationMs: elapsed(metadataStarted),
          metadataType: config.metadataType,
          fullName: config.metadataFullName,
          error: safeError(error, config, accessToken),
        };
      } finally {
        restoreCwd(beforeMetadataCwd);
        const harnessRestored = samePath(process.cwd(), beforeMetadataCwd);
        report.cwd = {
          status: harnessRestored ? 'PASS' : 'FAIL',
          officialToolRestored: samePath(cwdAfterOfficialTool, beforeMetadataCwd),
          harnessRestored,
          ...(!harnessRestored ? { error: 'The validation harness could not restore process.cwd().' } : {}),
        };
      }
    }
  } catch (error) {
    report.providerCompatibility = {
      status: 'FAIL',
      error: safeError(error, config, accessToken),
    };
  } finally {
    if (workspace) {
      try {
        await workspace.cleanup();
      } catch (error) {
        report.metadataWorkspace = {
          status: report.metadataWorkspace.status === 'PASS' ? 'PARTIAL' : report.metadataWorkspace.status,
          durationMs: report.metadataWorkspace.durationMs,
          error: `Temporary workspace cleanup failed: ${safeError(error, config, accessToken)}`,
        };
      }
    }
    if (session) {
      try {
        await session.close();
      } catch (error) {
        report.providerCompatibility = {
          status: 'PARTIAL',
          error: `Official Tool session cleanup failed: ${safeError(error, config, accessToken)}`,
        };
      }
    }
  }

  report.directVsOfficialDiagnosis = diagnoseQueries(report);
  report.overall = calculateOverall(report);
  return { report, accessToken };
}

function createInitialReport(config: ValidationConfig): RuntimeValidationReport {
  const notTested = { status: 'NOT TESTED' as const };
  return {
    generatedAt: new Date().toISOString(),
    environment: {
      instanceUrl: config.instanceUrl,
      alias: config.alias,
      username: config.username,
      objectApiName: config.testObject,
      metadataType: config.metadataType,
      metadataFullName: config.metadataFullName,
    },
    freshJwt: notTested,
    token: {
      ...notTested,
      available: false,
      usable: false,
      tokenType: 'UNKNOWN',
      expiration: 'NOT TESTED',
      issuer: 'NOT TESTED',
      audience: 'NOT TESTED',
      subject: 'NOT TESTED',
      scope: 'NOT TESTED',
    },
    directConnection: notTested,
    identity: { ...notTested, matchesConfiguredUsername: false },
    directSoql: { ...notTested, objectApiName: config.testObject },
    officialSoql: {
      ...notTested,
      objectApiName: config.testObject,
      toolName: 'run_soql_query',
      provider: 'DxCoreMcpProvider',
    },
    metadataWorkspace: notTested,
    officialMetadata: {
      ...notTested,
      metadataType: config.metadataType,
      fullName: config.metadataFullName,
    },
    cwd: { ...notTested, officialToolRestored: false, harnessRestored: false },
    providerCompatibility: notTested,
    directVsOfficialDiagnosis: 'NOT TESTED',
    overall: 'NOT TESTED',
  };
}

function calculateOverall(report: RuntimeValidationReport): RuntimeValidationReport['overall'] {
  const requiredStatuses = [
    report.freshJwt.status,
    report.token.status,
    report.directConnection.status,
    report.identity.status,
    report.directSoql.status,
    report.officialSoql.status,
    report.metadataWorkspace.status,
    report.officialMetadata.status,
    report.cwd.status,
    report.providerCompatibility.status,
  ];
  if (requiredStatuses.includes('FAIL')) return 'FAIL';
  if (
    requiredStatuses.every((status) => status === 'PASS') &&
    report.token.available &&
    report.token.usable &&
    report.environment.metadataType.toLowerCase() === 'customobject'
  ) {
    return 'PASS';
  }
  return 'PARTIAL';
}

function diagnoseQueries(report: RuntimeValidationReport): string {
  if (report.directSoql.status === 'PASS' && report.officialSoql.status === 'FAIL') {
    return 'MCP Provider / Host Integration Problem';
  }
  if (report.directSoql.status === 'FAIL' && report.officialSoql.status === 'FAIL') {
    return 'Auth / Salesforce Connectivity / Permission Problem';
  }
  if (report.directSoql.status === 'PASS' && report.officialSoql.status === 'PASS') return 'Direct and official paths agree';
  return 'Inconclusive';
}

function safeError(error: unknown, config: ValidationConfig, accessToken?: string): string {
  return redactError(error, [accessToken ?? '', config.privateKeyPath, config.clientId]);
}

function restoreCwd(original: string): void {
  if (!samePath(process.cwd(), original)) process.chdir(original);
}

function samePath(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: process.platform === 'win32' ? 'accent' : 'variant' }) === 0;
}

function sameUsername(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
