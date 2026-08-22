import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { redactSensitiveText } from '@sfoa/identity-runtime';
import { loadRemoteRuntimeConfig } from '../config.js';
import {
  loadP3LiveInputs,
  missingP3LiveVariables,
  runP3LiveValidation,
  type P3LiveGate,
  type P3LiveValidationReport,
} from './p3-live-validation.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

async function main(): Promise<void> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    MCP_CLIENT_TOKEN: process.env.MCP_CLIENT_TOKEN ?? `p3-validator-${randomUUID()}`,
  };
  let config;
  try {
    config = await loadRemoteRuntimeConfig(projectRoot, environment);
  } catch (error) {
    printHeader();
    printLine('Configuration', 'FAIL');
    process.stderr.write(`${safeMessage(error)}\n`);
    printOverall('FAIL');
    process.exitCode = 1;
    return;
  }
  const missing = missingP3LiveVariables(config);
  if (missing.length > 0 || !config.identity.testObject) {
    printHeader();
    printLine('Missing Live Inputs', missing.join(', '));
    printOverall('FAIL');
    process.exitCode = 1;
    return;
  }

  try {
    const inputs = await loadP3LiveInputs(projectRoot, config.identity.testObject, environment);
    const report = await runP3LiveValidation(config, inputs);
    printReport(report);
    process.exitCode = report.overall === 'PASS' ? 0 : 1;
  } catch (error) {
    printHeader();
    printLine('Live Validation', 'FAIL');
    process.stderr.write(`${redactSensitiveText(
      safeMessage(error),
      [config.clientToken ?? '', config.identity.clientId, config.identity.privateKeyPath],
    )}\n`);
    printOverall('FAIL');
    process.exitCode = 1;
  }
}

function printReport(report: P3LiveValidationReport): void {
  printHeader();
  printLine('Test Object', report.objectApiName);
  printLine('tools/list Names', report.listedTools.join(', '));
  printGate('tools/list', report.toolsList);
  printGate('Forbidden Tools Absent', report.forbiddenToolsAbsent);
  printGate('Remote Schema', report.remoteSchema);
  printGate('CREATE User A', report.createA);
  printGate('CREATE User B', report.createB);
  printGate('UPDATE User A', report.updateA);
  printGate('UPDATE User B', report.updateB);
  printGate('Forged platformUserId', report.forgedPlatformUser);
  printGate('Forged username', report.forgedUsername);
  printGate('Connection Reuse = 0', report.connectionReuse);
  printGate('Salesforce Validation', report.salesforceValidationFailure);
  printGate('Salesforce Authz Denial', report.salesforcePermissionDenial);
  printGate('Validator Cleanup', report.cleanup);
  printLine('Cleanup Attempted', String(report.cleanup.attempted));
  printLine('Cleanup Deleted', String(report.cleanup.deleted));
  printLine('Cleanup Failures', String(report.cleanup.failures));
  printLine('Salesforce CLI Used', report.salesforceCliUsed ? 'YES' : 'NO');
  printLine('Runtime DELETE Tool', report.runtimeDeleteToolExposed ? 'PRESENT' : 'ABSENT');
  printOverall(report.overall);
}

function printGate(label: string, gate: P3LiveGate): void {
  printLine(label, gate.status);
  if (gate.detail) process.stderr.write(`${label}: ${gate.detail}\n`);
}

function printHeader(): void {
  process.stdout.write('============================================================\n');
  process.stdout.write('P3 Minimal Generic DML & Object Allowlist Validation\n');
  process.stdout.write('============================================================\n\n');
}

function printLine(label: string, value: string): void {
  process.stdout.write(`${label.padEnd(30)}${value}\n`);
}

function printOverall(status: 'PASS' | 'FAIL'): void {
  process.stdout.write('\n============================================================\n');
  process.stdout.write(`P3 LIVE = ${status}\n`);
  process.stdout.write('============================================================\n');
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main().catch((error: unknown) => {
  process.stderr.write(`P3 validation failed unexpectedly: ${safeMessage(error)}\n`);
  process.exitCode = 1;
});
