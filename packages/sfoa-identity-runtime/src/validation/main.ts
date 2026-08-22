import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIdentityRuntimeConfig, RuntimeConfigurationError } from '../config.js';
import { redactSensitiveText } from '../errors.js';
import { missingLiveVariables, runP1LiveValidation } from './live-validation.js';
import type { P1ValidationReport, ValidationGate } from './types.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

async function main(): Promise<void> {
  let config;
  try {
    config = await loadIdentityRuntimeConfig(projectRoot);
  } catch (error) {
    if (error instanceof RuntimeConfigurationError) {
      printHeader();
      printLine('Configuration', 'FAIL');
      process.stderr.write(`${error.message}\n`);
      printOverall('PARTIAL');
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  const missing = missingLiveVariables(config);
  if (missing.length > 0) {
    printHeader();
    printLine('Local Unit Tests', 'AVAILABLE');
    printLine('Missing Live Inputs', missing.join(', '));
    printOverall('PARTIAL');
    process.exitCode = 2;
    return;
  }

  try {
    const report = await runP1LiveValidation(config);
    printReport(report);
    process.exitCode = report.overall === 'PASS' ? 0 : 1;
  } catch (error) {
    printHeader();
    printLine('Live Validation', 'FAIL');
    process.stderr.write(
      `${redactSensitiveText(error instanceof Error ? error.message : String(error), [config.clientId, config.privateKeyPath])}\n`,
    );
    printOverall('FAIL');
    process.exitCode = 1;
  }
}

function printReport(report: P1ValidationReport): void {
  printHeader();
  printLine('Route A', report.routeA.status);
  printLine('JWT A', report.jwtA.status);
  printLine('Identity A', report.identityA.status);
  printLine('Route B', report.routeB.status);
  printLine('JWT B', report.jwtB.status);
  printLine('Identity B', report.identityB.status);
  printLine('HTTP Initialize', report.initialize.status);
  printLine('HTTP Tools List', report.toolsList.status);
  printLine('Official get_username A', report.getUsernameA.status);
  printLine('Official get_username B', report.getUsernameB.status);
  printLine('Official SOQL A', report.soqlA.status);
  printLine('Official SOQL B', report.soqlB.status);
  printLine('Forged A -> B', report.forgedAToB.status);
  printLine('Forged B -> A', report.forgedBToA.status);
  printLine('Unknown User', report.unknownUser.status);
  printLine('Missing Platform User', report.missingUser.status);
  printLine('Invalid Identity', report.invalidIdentity.status);
  printLine('Concurrent Requests', report.concurrency.status);
  printLine('Requests', String(report.concurrency.requests));
  printLine('Identity Mismatch', String(report.concurrency.identityMismatch));
  printLine('Cross User Leak', String(report.concurrency.crossUserLeak));
  printLine('Connection Reuse', String(report.concurrency.unknownConnectionReuse));
  printLine('Metadata CWD Guard', report.metadataCwd.status);
  printLine('Workspace Isolation', report.workspaceIsolation.status);
  printLine('Request Cleanup', report.requestCleanup.status);
  printLine('Salesforce CLI Used', report.salesforceCliUsed ? 'YES' : 'NO');
  printLine('Database Used', report.databaseUsed ? 'YES' : 'NO');
  printGateErrors(report);
  printOverall(report.overall);
}

function printGateErrors(report: P1ValidationReport): void {
  for (const [name, gate] of Object.entries(report)) {
    if (isValidationGate(gate) && gate.error) process.stderr.write(`${name}: ${gate.error}\n`);
  }
}

function isValidationGate(value: unknown): value is ValidationGate {
  return typeof value === 'object' && value !== null && 'status' in value;
}

function printHeader(): void {
  process.stdout.write('============================================================\n');
  process.stdout.write('P1 Request-Scoped Identity Validation\n');
  process.stdout.write('============================================================\n\n');
}

function printLine(label: string, value: string): void {
  process.stdout.write(`${label.padEnd(28)}${value}\n`);
}

function printOverall(status: 'PASS' | 'PARTIAL' | 'FAIL'): void {
  process.stdout.write('\n============================================================\n');
  process.stdout.write(`P1 = ${status}\n`);
  process.stdout.write('============================================================\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`P1 validation failed unexpectedly: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
