import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { runP10LiveValidation } from './p10-live-validation.js';

/**
 * The entry point for the P10 acceptance run.
 *
 * It runs the four milestones and the phase's own gates, prints the report, and — when `P10_VALIDATION_REPORT`
 * names a file — writes the same JSON there so a run over SSH can be read back without scraping stdout.
 *
 * The exit code is non-zero only on `FAIL`. A `PARTIAL` run is one whose legs the deployment did not allow
 * rather than one that was refuted — a production org refusing the trace write, a window holding no log — and it
 * has to stay distinguishable from a run that proved a Tool wrong, exactly as it does in the milestone mains.
 * The report is written in both cases: it is the evidence, and a `PARTIAL` run is the one whose `未执行项`
 * section matters most.
 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const reportPath = process.env.P10_VALIDATION_REPORT?.trim();

try {
  const report = await runP10LiveValidation(projectRoot);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stderr.write(`P10 validation report written to ${reportPath}\n`);
  }
  if (report.overall === 'FAIL') process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
