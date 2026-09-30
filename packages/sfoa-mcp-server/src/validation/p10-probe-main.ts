import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runP10DiagnosticProbe } from './p10-diagnostic-probe.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

try {
  const report = await runP10DiagnosticProbe(projectRoot);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const failed = report.summary.ERROR > 0;
  // An `AVAILABLE`/`DENIED`/`SKIPPED` mix is a successful measurement — the whole point of the probe is
  // to find out which of those each prerequisite turns out to be. Only a harness failure exits non-zero.
  if (failed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
