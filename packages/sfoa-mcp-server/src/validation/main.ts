import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSensitiveText } from '@sfoa/identity-runtime';
import { loadRemoteRuntimeConfig } from '../config.js';
import { missingP2LiveVariables, runP2LiveValidation } from './live-validation.js';
import type { LatencySummary, P2ValidationReport, ValidationGate } from './types.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

async function main(): Promise<void> {
  let config;
  try {
    config = await loadRemoteRuntimeConfig(projectRoot);
  } catch (error) {
    printHeader();
    printLine('Configuration', 'FAIL');
    process.stderr.write(`${safeMessage(error)}\n`);
    printOverall('PARTIAL');
    process.exitCode = 2;
    return;
  }

  const missing = missingP2LiveVariables(config);
  if (missing.length > 0) {
    printHeader();
    printLine('Missing Live Inputs', missing.join(', '));
    printOverall('PARTIAL');
    process.exitCode = 2;
    return;
  }

  try {
    const report = await runP2LiveValidation(config);
    printReport(report);
    process.exitCode = report.overall === 'PASS' ? 0 : 1;
  } catch (error) {
    printHeader();
    printLine('Live Validation', 'FAIL');
    process.stderr.write(
      `${redactSensitiveText(safeMessage(error), [config.clientToken ?? '', config.identity.clientId, config.identity.privateKeyPath])}\n`,
    );
    printOverall('FAIL');
    process.exitCode = 1;
  }
}

function printReport(report: P2ValidationReport): void {
  printHeader();
  printLine('No Bearer', report.noBearer.status);
  printLine('Wrong Bearer', report.wrongBearer.status);
  printLine('No Platform User', report.noPlatformUser.status);
  printLine('Unknown Platform User', report.unknownPlatformUser.status);
  printLine('Initialize User A', report.initializeA.status);
  printLine('Initialize User B', report.initializeB.status);
  printLine('tools/list', report.toolsList.status);
  printLine('Disabled Tool Invisible', report.disabledToolInvisible.status);
  printLine('Remote Schema', report.remoteSchema.status);
  printLine('Official get_username A', report.getUsernameA.status);
  printLine('Official get_username B', report.getUsernameB.status);
  printLine('Official SOQL A', report.soqlA.status);
  printLine('Official SOQL B', report.soqlB.status);
  printLine('Forged A -> B', report.forgedAToB.status);
  printLine('Forged B -> A', report.forgedBToA.status);
  printLine('50 Request Load', report.load.status);
  printLine('Requests', String(report.load.requests));
  printLine('Identity Mismatch', String(report.load.identityMismatch));
  printLine('Cross User Leak', String(report.load.crossUserLeak));
  printLine('Workspace Leak', String(report.load.workspaceLeak));
  printLine('Cleanup Failures', String(report.load.cleanupFailures));
  printLine('Connection Reuse', String(report.load.connectionReuse));
  printLine('Error Count', String(report.load.errors));
  printLatency('50-request load', report.load.latency);
  printLatency('Initialize', report.initializeLatency);
  printLatency('tools/list', report.toolsListLatency);
  printLatency('get_username', report.getUsernameLatency);
  printLatency('run_soql_query', report.soqlLatency);
  printLatency('JWT/Connection', report.jwtLatency);
  printLine('Salesforce CLI Used', report.salesforceCliUsed ? 'YES' : 'NO');
  printLine('Database Used', report.databaseUsed ? 'YES' : 'NO');
  printGateErrors(report);
  printOverall(report.overall);
}

function printGateErrors(report: P2ValidationReport): void {
  for (const [name, value] of Object.entries(report)) {
    if (isValidationGate(value) && value.error) process.stderr.write(`${name}: ${value.error}\n`);
  }
}

function isValidationGate(value: unknown): value is ValidationGate {
  return typeof value === 'object' && value !== null && 'status' in value;
}

function printLatency(label: string, summary: LatencySummary): void {
  printLine(`${label} Latency`, `n=${summary.samples} p50=${summary.p50Ms}ms p95=${summary.p95Ms}ms`);
}

function printHeader(): void {
  process.stdout.write('============================================================\n');
  process.stdout.write('P2 Remote Runtime & Tool Governance Validation\n');
  process.stdout.write('============================================================\n\n');
}

function printLine(label: string, value: string): void {
  process.stdout.write(`${label.padEnd(30)}${value}\n`);
}

function printOverall(status: 'PASS' | 'PARTIAL' | 'FAIL'): void {
  process.stdout.write('\n============================================================\n');
  process.stdout.write(`P2 LIVE = ${status}\n`);
  process.stdout.write('============================================================\n');
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main().catch((error: unknown) => {
  process.stderr.write(`P2 validation failed unexpectedly: ${safeMessage(error)}\n`);
  process.exitCode = 1;
});
