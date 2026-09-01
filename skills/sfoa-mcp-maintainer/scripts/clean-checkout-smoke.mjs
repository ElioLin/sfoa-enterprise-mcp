import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findProjectRoot, parseCliArguments, SKILL_NAME } from './shared/project.mjs';

const execFileAsync = promisify(execFile);

// Gate commands that must exit 0 in a clean checkout rebuilt from committed HEAD bytes.
// These prove the committed repository — not a developer's dirty working tree — carries
// every file the Skill needs to validate, sync, check, test, and snapshot itself.
const GATE_COMMANDS = Object.freeze([
  { name: 'skill:validate', args: (root) => [manage(root), 'validate', '--project-root', root] },
  { name: 'skill:sync', args: (root) => [manage(root), 'sync', '--project-root', root] },
  { name: 'skill:check', args: (root) => [manage(root), 'check', '--project-root', root] },
  { name: 'skill:test', args: (root) => ['--test', path.join(root, 'skills', SKILL_NAME, 'scripts', 'toolkit.test.mjs')] },
  { name: 'ai:snapshot', args: (root) => [path.join(root, 'skills', SKILL_NAME, 'scripts', 'project-snapshot.mjs'), '--project-root', root] },
]);

export async function runCleanCheckoutSmoke({ projectRoot }) {
  const head = await runExec('git', ['rev-parse', 'HEAD'], projectRoot);
  if (!head.ok) throw new Error(`git rev-parse HEAD failed (${head.stderr.trim()}); run from a Git checkout with at least one commit.`);
  const committed = head.stdout.trim();
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-clean-checkout-'));
  const results = [];
  try {
    // Materialize the committed HEAD bytes, never the working tree: a dirty working tree
    // must not be able to masquerade as a reproducible clean checkout.
    const archivePath = path.join(temporaryRoot, 'head.tar');
    const archive = await runExec('git', ['archive', '--format=tar', 'HEAD', '-o', archivePath], projectRoot);
    if (!archive.ok) throw new Error(`git archive HEAD failed: ${archive.stderr.trim()}`);
    const committedFileCount = await extractTar(archivePath, temporaryRoot);

    for (const command of GATE_COMMANDS) {
      results.push(await runNode(command.args(temporaryRoot), temporaryRoot, command.name));
    }
    const doctor = await runNode([path.join(temporaryRoot, 'skills', SKILL_NAME, 'scripts', 'doctor.mjs'), '--project-root', temporaryRoot, '--skip-db', '--skip-services'], temporaryRoot, 'ai:doctor (missing-env)');
    results.push(doctor);
    const gateOk = GATE_COMMANDS.every((_, index) => results[index]?.ok === true);
    const doctorState = readDoctorMissingEnv(doctor);
    return Object.freeze({
      ok: gateOk && doctorState.ok,
      committed,
      committedFileCount,
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

async function extractTar(tarPath, destinationRoot) {
  const buffer = await readFile(tarPath);
  let offset = 0;
  let fileCount = 0;
  let pendingPath = null;
  while (offset + 512 <= buffer.length) {
    const headerBlock = buffer.subarray(offset, offset + 512);
    if (isZeroBlock(headerBlock)) break;
    const header = parseTarHeader(headerBlock);
    offset += 512;
    const data = buffer.subarray(offset, offset + header.size);
    offset += Math.ceil(header.size / 512) * 512;

    if (header.typeflag === 'g' || header.typeflag === 'x') {
      const pathField = /(?:^|\n)path=([^\n]*)/u.exec(data.toString('utf8'))?.[1];
      if (pathField !== undefined) pendingPath = pathField;
      continue;
    }
    if (header.typeflag === 'L') {
      pendingPath = data.toString('utf8').replace(/\0+$/u, '');
      continue;
    }
    const name = pendingPath ?? (header.prefix ? `${header.prefix}/${header.name}` : header.name);
    pendingPath = null;
    const destination = safeJoin(destinationRoot, name);
    if (header.typeflag === '5') {
      await mkdir(destination, { recursive: true });
    } else if (header.typeflag === '0' || header.typeflag === '\0') {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, data);
      fileCount += 1;
    }
    // Symlinks and hard links are skipped: the canonical Skill rejects symlinks and
    // the gates only need regular files and directories.
  }
  return fileCount;
}

function parseTarHeader(block) {
  const name = readCString(block, 0, 100);
  const size = readOctal(block, 124, 12);
  const typeflag = String.fromCharCode(block[156] ?? 0);
  const prefix = readCString(block, 345, 155);
  return { name, size, typeflag: typeflag === '\0' ? '0' : typeflag, prefix };
}

function readCString(block, start, length) {
  let end = start;
  while (end < start + length && block[end] !== 0) end += 1;
  return block.subarray(start, end).toString('utf8');
}

function readOctal(block, start, length) {
  const text = block.subarray(start, start + length).toString('utf8');
  const cleaned = text.replace(/[\0 ]/gu, '');
  if (cleaned === '') return 0;
  const value = Number.parseInt(cleaned, 8);
  return Number.isFinite(value) ? value : 0;
}

function isZeroBlock(block) {
  for (let index = 0; index < block.length; index += 1) if (block[index] !== 0) return false;
  return true;
}

function safeJoin(root, name) {
  const normalized = name.replace(/\\/gu, '/').replace(/^\/+/u, '');
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
  return path.join(root, ...segments);
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
