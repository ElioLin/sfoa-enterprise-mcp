import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { runP10T5LiveMilestone } from './p10-t5-live-milestone.js';

/**
 * The entry point for the P10-T5 live milestone.
 *
 * It runs the milestone, prints the report, and — when `P10_T5_MILESTONE_REPORT` names a file — writes the same
 * JSON there so a run over SSH can be read back without scraping stdout. The exit code is non-zero only on
 * `FAIL`: a `PARTIAL` run is one whose legs were not measured rather than one that was refuted, and it has to
 * stay distinguishable from a run that proved the Tool wrong.
 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const reportPath = process.env.P10_T5_MILESTONE_REPORT?.trim();

try {
  const report = await runP10T5LiveMilestone(projectRoot);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stderr.write(`P10-T5 milestone report written to ${reportPath}\n`);
  }
  if (report.overall === 'FAIL') process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
