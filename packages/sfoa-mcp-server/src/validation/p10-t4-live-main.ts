import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runP10T4LiveMilestone } from './p10-t4-live-milestone.js';

/**
 * The entry point for the P10-T4 live milestone.
 *
 * The report is printed to stdout in full, and written to `P10_T4_MILESTONE_REPORT` when that variable names
 * a path — the evidence file quotes the report, and a few hundred lines of JSON are easier to cite from a
 * file than from a scrollback. Every id, username and platform user in it is masked at the point where it is
 * produced, so the file is safe to keep beside the other `docs/sfoa` evidence.
 *
 * The exit code separates a *finding* from a *harness failure*. `FAIL` on a gate is a real answer about the
 * deployment — a type the allowlist admits that this identity cannot list, say — and exits non-zero so a
 * pipeline notices. `PARTIAL` does not: a run stopped at an unconfigured Diagnostic identity, or a gate that
 * reported `NOT TESTED` because the org holds no recycled component for the default to filter, has measured
 * what it could and said what it could not, which is the outcome ADR-0029 asks for rather than an error to
 * retry.
 */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const reportPath = process.env.P10_T4_MILESTONE_REPORT?.trim();

try {
  const report = await runP10T4LiveMilestone(projectRoot);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stderr.write(`P10-T4 milestone report written to ${reportPath}\n`);
  }
  if (report.overall === 'FAIL') process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
