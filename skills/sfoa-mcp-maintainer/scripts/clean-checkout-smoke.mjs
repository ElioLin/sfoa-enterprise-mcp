import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findProjectRoot, parseCliArguments, SKILL_NAME } from './shared/project.mjs';

const execFileAsync = promisify(execFile);

// Gate commands that must exit 0 in a tracked-only checkout. These prove the Skill
// does not depend on ignored/untracked files that only exist on a developer machine.
const GATE_COMMANDS = Object.freeze([
  { name: 'skill:validate', args: (root) => [manage(root), 'validate', '--project-root', root] },
  { name: 'skill:sync', args: (root) => [manage(root), 'sync', '--project-root', root] },
  { name: 'skill:check', args: (root) => [manage(root), 'check', '--project-root', root] },
  { name: 'skill:test', args: (root) => ['--test', path.join(root, 'skills', SKILL_NAME, 'scripts', 'toolkit.test.mjs')] },
  { name: 'ai:snapshot', args: (root) => [path.join(root, 'skills', SKILL_NAME, 'scripts', 'project-snapshot.mjs'), '--project-root', root] },
]);

export async function runCleanCheckoutSmoke({ projectRoot }) {
  const tracked = await gitTrackedFiles(projectRoot);
  if (tracked.length === 0) throw new Error('git ls-files returned no tracked files; run from a Git checkout.');
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-clean-checkout-'));
  const results = [];
  try {
    for (const relativePath of tracked) {
      const segments = relativePath.split('/');
      const destination = path.join(temporaryRoot, ...segments);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(projectRoot, ...segments), destination);
    }
    for (const command of GATE_COMMANDS) {
      results.push(await runNode(command.args(temporaryRoot), temporaryRoot, command.name));
    }
    const doctor = await runNode([path.join(temporaryRoot, 'skills', SKILL_NAME, 'scripts', 'doctor.mjs'), '--project-root', temporaryRoot, '--skip-db', '--skip-services'], temporaryRoot, 'ai:doctor (missing-env)');
    results.push(doctor);
    const gateOk = GATE_COMMANDS.every((_, index) => results[index]?.ok === true);
    const doctorState = readDoctorMissingEnv(doctor);
    return Object.freeze({
      ok: gateOk && doctorState.ok,
      trackedFileCount: tracked.length,
      temporaryRoot,
      gates: Object.freeze(results),
      doctorMissingEnv: doctorState,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function readDoctorMissingEnv(doctor) {
  try {
    const report = JSON.parse(doctor.stdout);
    if (typeof report.localEnvironment?.exists !== 'boolean') {
      return { ok: false, note: 'doctor did not report localEnvironment.exists' };
    }
    return { ok: true, exists: report.localEnvironment.exists };
  } catch {
    return { ok: false, note: 'doctor did not emit parseable JSON' };
  }
}

async function gitTrackedFiles(projectRoot) {
  const result = await runExec('git', ['ls-files', '-z'], projectRoot);
  if (!result.ok) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split('\0').filter(Boolean);
}

async function runNode(arguments_, cwd, name) {
  const result = await runExec(process.execPath, arguments_, cwd);
  return Object.freeze({
    name,
    ok: result.ok,
    exitCode: result.exitCode,
    stdout: result.stdout.slice(0, 40_000),
    stderr: result.stderr.slice(0, 8_000),
  });
}

async function runExec(command, arguments_, cwd) {
  try {
    const result = await execFileAsync(command, arguments_, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
    return { ok: true, exitCode: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    return {
      ok: false,
      exitCode: typeof error?.code === 'number' ? error.code : typeof error?.status === 'number' ? error.status : 1,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : '',
    };
  }
}

function manage(root) {
  return path.join(root, 'skills', SKILL_NAME, 'scripts', 'manage.mjs');
}

async function main() {
  const arguments_ = parseCliArguments(process.argv.slice(2));
  const projectRoot = arguments_['project-root'] ? path.resolve(String(arguments_['project-root'])) : await findProjectRoot();
  const report = await runCleanCheckoutSmoke({ projectRoot });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const isCli = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isCli) main().catch((error) => {
  process.stderr.write(`[clean-checkout-smoke] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
