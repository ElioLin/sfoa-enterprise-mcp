import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runP10T2LiveMilestone } from './p10-t2-live-milestone.js';

/**
 * The entry point for the P10-T2 live milestone.
 *
 * The report is printed to stdout in full, and written to `P10_T2_MILESTONE_REPORT` when that variable
 * names a path — the evidence file quotes the report, and a few hundred lines of JSON are easier to cite
 * from a file than from a scrollback. Every id, username and platform user in it is masked at the point
 * where it is produced, so the file is safe to keep beside the other `docs/sfoa` evidence.
 *
 * The exit code separates a *finding* from a *harness failure*. `FAIL` on a gate is a real answer about the
 * deployment and exits non-zero so a pipeline notices. `PARTIAL` does not: a run that reported
 * `NOT TESTED` — a non-sandbox org, a Diagnostic identity that is not configured, a platform that refuses
 * anonymous Apex — has measured what it could and said what it could not, which is the outcome ADR-0029
 * asks for, not an error to retry.
 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const reportPath = process.env.P10_T2_MILESTONE_REPORT?.trim();

try {
  const report = await runP10T2LiveMilestone(projectRoot);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stderr.write(`P10-T2 milestone report written to ${reportPath}\n`);
  }
  if (report.overall === 'FAIL') process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
