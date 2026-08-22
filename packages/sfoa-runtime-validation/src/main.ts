import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigurationError, loadValidationConfig } from './config.js';
import { maskToken, redactError } from './security.js';
import type { GateResult, RuntimeValidationOutcome } from './types.js';
import { runRuntimeValidation } from './validation.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function main(): Promise<void> {
  printHeader('SFoA Runtime Validation');

  try {
    const config = await loadValidationConfig(projectRoot);
    const outcome = await runRuntimeValidation(config);
    printOutcome(outcome, config.debugExposeToken);
    process.exitCode = outcome.report.overall === 'PASS' ? 0 : 1;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      printSection('Configuration');
      printField('Status', 'FAIL');
      printField('Reason', error.message);
      if (error.missingVariables.length > 0) printField('Missing', error.missingVariables.join(', '));
      printField('Next Action', 'Copy .env.example to .env.local, fill every required P0-Closure value, and retry.');
      printFooter('P0 Closure Runtime Result: NOT TESTED');
      process.exitCode = 2;
      return;
    }

    printSection('Unexpected Harness Failure');
    printField('Status', 'FAIL');
    printField('Reason', redactError(error));
    printFooter('P0 Closure Runtime Result: FAIL');
    process.exitCode = 1;
  }
}

function printOutcome(outcome: RuntimeValidationOutcome, exposeToken: boolean): void {
  const { report } = outcome;

  printSection('Environment');
  printField('Instance URL', report.environment.instanceUrl);
  printField('Alias', report.environment.alias);
  printField('Username', report.environment.username);

  printSection('JWT Authentication');
  printGate(report.freshJwt);
  printField('Authentication Method', 'JWT Bearer Flow (@salesforce/core)');
  printField('SFOA_FRESH_JWT_AUTH', report.freshJwt.status);

  printSection('Salesforce Identity');
  printGate(report.identity);
  printField('User Id', report.identity.userId ?? 'NOT AVAILABLE');
  printField('Username', report.identity.username ?? 'NOT AVAILABLE');
  printField('Org Id', report.identity.orgId ?? 'NOT AVAILABLE');
  printField('Instance URL', report.identity.instanceUrl ?? 'NOT AVAILABLE');
  printField('IDENTITY_MATCH', report.identity.status);

  printSection('Access Token');
  printGate(report.token);
  printField('Available', report.token.available ? 'YES' : 'NO');
  printField('Usable', report.token.usable ? 'YES' : 'NO');
  printField('Token Type', report.token.tokenType);
  printField('Expires At', report.token.expiration);
  printField('Issuer', report.token.issuer);
  printField('Audience', report.token.audience);
  printField('Subject', report.token.subject);
  printField('Scope', report.token.scope);
  printField('TOKEN_ACQUISITION', report.token.status);
  if (outcome.accessToken) {
    printField('Token', exposeToken ? outcome.accessToken : maskToken(outcome.accessToken));
    if (exposeToken) printField('Warning', 'Full token exposed to this console only; do not copy it into logs or reports.');
  }

  printSection('Direct Connection');
  printGate(report.directConnection);
  printField('DIRECT_SALESFORCE_CONNECTION', report.directConnection.status);

  printSection('Direct SOQL');
  printGate(report.directSoql);
  printField('Object', report.directSoql.objectApiName);
  printField('Rows', report.directSoql.rows ?? 'NOT AVAILABLE');
  printField('DIRECT_SOQL', report.directSoql.status);

  printSection('Official MCP Tool');
  printGate(report.officialSoql);
  printField('Tool', report.officialSoql.toolName ?? 'run_soql_query');
  printField('Provider', report.officialSoql.provider ?? 'DxCoreMcpProvider');
  printField('Rows', report.officialSoql.rows ?? 'NOT AVAILABLE');
  printField('OFFICIAL_RUN_SOQL_QUERY', report.officialSoql.status);
  printField('Direct vs Official', report.directVsOfficialDiagnosis);

  printSection('Metadata');
  printField('Workspace', report.metadataWorkspace.status);
  printField('TEMPORARY_METADATA_WORKSPACE', report.metadataWorkspace.status);
  printGate(report.officialMetadata);
  printField('Type', report.officialMetadata.metadataType);
  printField('Full Name', report.officialMetadata.fullName);
  printField('Retrieved Files', report.officialMetadata.retrievedFiles ?? 'NOT AVAILABLE');
  printField('OFFICIAL_RETRIEVE_METADATA', report.officialMetadata.status);

  printSection('CWD Restore');
  printGate(report.cwd);
  printField('Official Tool Restored', report.cwd.officialToolRestored ? 'YES' : 'NO — known upstream side effect');
  printField('Harness Final Restore', report.cwd.harnessRestored ? 'PASS' : 'FAIL');
  printField('CWD_RESTORE', report.cwd.status);

  printSection('Provider Compatibility');
  printGate(report.providerCompatibility);
  printField('PROVIDER_COMPATIBILITY', report.providerCompatibility.status);

  printFooter(`P0 Closure Runtime Result: ${report.overall}`);
}

function printGate(result: GateResult): void {
  printField('Status', result.status);
  if (result.durationMs !== undefined) printField('Duration', `${result.durationMs} ms`);
  if (result.error) printField('Error', result.error);
}

function printHeader(title: string): void {
  console.log('='.repeat(60));
  console.log(title);
  console.log('='.repeat(60));
}

function printSection(title: string): void {
  console.log('');
  console.log(title);
  console.log('-'.repeat(60));
}

function printField(label: string, value: string | number): void {
  console.log(`${label.padEnd(28)}${String(value)}`);
}

function printFooter(text: string): void {
  console.log('');
  console.log('='.repeat(60));
  console.log(text);
  console.log('='.repeat(60));
}

await main();
