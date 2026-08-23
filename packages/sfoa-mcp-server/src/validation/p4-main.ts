import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIdentityRuntimeConfig } from '@sfoa/identity-runtime';
import { runP4LiveValidation } from './p4-live-validation.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

try {
  const config = await loadIdentityRuntimeConfig(projectRoot);
  const report = await runP4LiveValidation(config);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.overall === 'FAIL') process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
