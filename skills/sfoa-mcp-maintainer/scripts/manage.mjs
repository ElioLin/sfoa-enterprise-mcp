import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exists, findProjectRoot, parseCliArguments, SKILL_NAME } from './shared/project.mjs';

const execFileAsync = promisify(execFile);

export const PLATFORM_SKILL_PATHS = Object.freeze([
  '.agents/skills/sfoa-mcp-maintainer',
  '.claude/skills/sfoa-mcp-maintainer',
  '.codebuddy/skills/sfoa-mcp-maintainer',
]);

export function platformSkillPaths(skillName) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skillName) || skillName.length > 64) {
    throw new Error(`Invalid Skill directory name: ${skillName}`);
  }
  return PLATFORM_SKILL_PATHS.map((destination) => path.posix.join(path.posix.dirname(destination), skillName));
}

export async function discoverSkills(projectRoot) {
  const root = path.join(projectRoot, 'skills');
  const entries = await readdir(root, { withFileTypes: true });
  const directories = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en-US'))) {
    if (entry.isSymbolicLink()) throw new Error(`Canonical Skill must not be a symbolic link: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    platformSkillPaths(entry.name);
    directories.push(path.join(root, entry.name));
  }
  if (directories.length === 0) throw new Error('No canonical Skills found.');
  return directories;
}

const REQUIRED_FILES = Object.freeze([
  'SKILL.md',
  'agents/openai.yaml',
  'references/architecture.md',
  'references/repository-map.md',
  'references/runtime-flow.md',
  'references/database-audit.md',
  'references/troubleshooting.md',
  'references/development.md',
  'references/operations.md',
  'references/testing.md',
  'references/skill-maintenance.md',
  'references/acceptance-scenario.md',
  'scripts/manage.mjs',
  'scripts/doctor.mjs',
  'scripts/db-inspect.mjs',
  'scripts/audit-trace.mjs',
  'scripts/project-snapshot.mjs',
  'scripts/toolkit.test.mjs',
  'scripts/clean-checkout-smoke.mjs',
  'scripts/shared/project.mjs',
  'scripts/shared/db.mjs',
]);

export async function validateSkill({ canonicalDir }) {
  const errors = [];
  const skillName = path.basename(canonicalDir);
  try { platformSkillPaths(skillName); } catch (error) { errors.push(error.message); }
  const maintainer = skillName === SKILL_NAME;
  for (const relativePath of maintainer ? REQUIRED_FILES : ['SKILL.md']) {
    if (!await exists(path.join(canonicalDir, relativePath))) errors.push(`missing ${relativePath}`);
  }
  if (errors.length === 0) {
    const skillText = await readFile(path.join(canonicalDir, 'SKILL.md'), 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(skillText)?.[1] ?? '';
    if (/^name:\s*(.+?)\s*$/mu.exec(frontmatter)?.[1] !== skillName) errors.push('SKILL.md frontmatter name must match its directory');
    const description = /^description:\s*(.+)$/mu.exec(frontmatter)?.[1] ?? '';
    if (!description.trim()) errors.push('SKILL.md description is required');
    for (const keyword of maintainer ? ['develop', 'debug', 'troubleshoot', 'operate', 'review', 'test', 'audit', 'Salesforce', 'MCP', 'identity', 'DML', 'database'] : []) {
      if (!description.toLocaleLowerCase('en-US').includes(keyword.toLocaleLowerCase('en-US'))) {
        errors.push(`SKILL.md description does not cover ${keyword}`);
      }
    }
    if (maintainer && !skillText.includes('advisory project context, not a reasoning boundary')) {
      errors.push('SKILL.md does not declare its advisory reasoning boundary');
    }
    if (/\b(?:TODO|TBD|PLACEHOLDER)\b/u.test(skillText)) errors.push('SKILL.md contains an unfinished placeholder');
    await validateLinks(canonicalDir, errors);
  }
  const files = await listFiles(canonicalDir).catch(() => []);
  for (const file of files) {
    if (file.isSymbolicLink) errors.push(`symbolic links are not portable: ${file.relativePath}`);
  }
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors), fileCount: files.length });
}

export async function syncSkill({ projectRoot, canonicalDir = path.join(projectRoot, 'skills', SKILL_NAME) }) {
  const validation = await validateSkill({ canonicalDir });
  if (!validation.ok) throw new Error(`Canonical Skill validation failed: ${validation.errors.join('; ')}`);
  const destinations = platformSkillPaths(path.basename(canonicalDir));
  for (const relativePath of destinations) {
    const destination = safeDestination(projectRoot, relativePath);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(canonicalDir, destination, { recursive: true, force: true, errorOnExist: false });
  }
  return Object.freeze({ ...validation, destinations });
}

export async function checkSkill({ projectRoot, canonicalDir = path.join(projectRoot, 'skills', SKILL_NAME) }) {
  const validation = await validateSkill({ canonicalDir });
  const drift = [];
  const canonical = await fileDigestMap(canonicalDir);
  for (const relativePath of platformSkillPaths(path.basename(canonicalDir))) {
    const destination = safeDestination(projectRoot, relativePath);
    if (!await exists(destination)) {
      drift.push(`${relativePath}: missing`);
      continue;
    }
    const copy = await fileDigestMap(destination);
    const names = [...new Set([...canonical.keys(), ...copy.keys()])].sort();
    for (const name of names) {
      if (canonical.get(name) !== copy.get(name)) drift.push(`${relativePath}/${name}: differs`);
    }
  }
  return Object.freeze({ ok: validation.ok && drift.length === 0, validation, drift: Object.freeze(drift) });
}

export async function packageSkill({ projectRoot, canonicalDir = path.join(projectRoot, 'skills', SKILL_NAME), outputPath }) {
  const validation = await validateSkill({ canonicalDir });
  if (!validation.ok) throw new Error(`Canonical Skill validation failed: ${validation.errors.join('; ')}`);
  const skillName = path.basename(canonicalDir);
  const target = outputPath
    ? path.resolve(projectRoot, outputPath)
    : path.join(projectRoot, '.temp', 'skill-packages', `${skillName}.zip`);
  const files = await listFiles(canonicalDir);
  const entries = [];
  for (const file of files) {
    if (file.isSymbolicLink) throw new Error(`Cannot package symbolic link ${file.relativePath}.`);
    entries.push(Object.freeze({
      name: `${skillName}/${file.relativePath.replaceAll(path.sep, '/')}`,
      data: await readFile(file.absolutePath),
    }));
  }
  const archive = createStoredZip(entries);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, archive);
  return Object.freeze({
    outputPath: target,
    fileCount: entries.length,
    sizeBytes: archive.length,
    sha256: createHash('sha256').update(archive).digest('hex'),
  });
}

export async function deliveryCheck({ projectRoot, canonicalDir = path.join(projectRoot, 'skills', SKILL_NAME) }) {
  const validation = await validateSkill({ canonicalDir });
  const insideWorkTree = await git(['rev-parse', '--is-inside-work-tree'], projectRoot);
  if (!insideWorkTree.ok || insideWorkTree.stdout.trim() !== 'true') {
    return Object.freeze({
      ok: validation.ok,
      gitRepository: false,
      note: 'Not inside a Git work tree; file trackability can only be verified in a Git checkout.',
      validation,
      ignored: Object.freeze([]),
      untracked: Object.freeze([]),
      packageCompleteness: false,
      problems: Object.freeze(validation.errors.map((error) => `validation: ${error}`)),
    });
  }
  const skillDirs = [path.relative(projectRoot, canonicalDir), ...platformSkillPaths(path.basename(canonicalDir))];
  const candidates = [];
  for (const dir of skillDirs) {
    for (const file of await listFiles(path.join(projectRoot, dir))) {
      if (file.isSymbolicLink) continue;
      candidates.push(toPosix(path.join(dir, file.relativePath)));
    }
  }
  const tracked = await git(['ls-files', '-z'], projectRoot);
  const trackedSet = new Set((tracked.ok ? tracked.stdout : '').split('\0').filter(Boolean));
  const untracked = candidates.filter((candidate) => !trackedSet.has(candidate));
  const ignoredOutput = await git(['check-ignore', '-z', '--', ...candidates], projectRoot);
  const ignored = (ignoredOutput.stdout || '').split('\0').filter(Boolean);
  const packageResult = await verifyPackageCompleteness({ projectRoot, canonicalDir });
  const problems = [
    ...validation.errors.map((error) => `validation: ${error}`),
    ...untracked.map((candidate) => `untracked by git: ${candidate}`),
    ...ignored.map((candidate) => `ignored by .gitignore: ${candidate}`),
    ...(packageResult.complete ? [] : [packageResult.reason]),
  ];
  return Object.freeze({
    ok: problems.length === 0,
    gitRepository: true,
    validation,
    trackedFileCount: trackedSet.size,
    ignored: Object.freeze(ignored),
    untracked: Object.freeze(untracked),
    packageCompleteness: packageResult.complete,
    problems: Object.freeze(problems),
  });
}

async function verifyPackageCompleteness({ projectRoot, canonicalDir }) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-delivery-'));
  try {
    const packaged = await packageSkill({ projectRoot, canonicalDir, outputPath: path.join(temporaryRoot, 'maintainer.zip') });
    const canonicalCount = (await listFiles(canonicalDir)).filter((file) => !file.isSymbolicLink).length;
    const complete = packaged.fileCount === canonicalCount;
    return { complete, reason: complete ? '' : `package fileCount ${packaged.fileCount} does not match canonical ${canonicalCount}` };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * 普通业务 Agent 可见的 Skill 白名单。
 *
 * 这是 Runtime Copy 的唯一授权来源：只有显式列在这里的 Skill 才允许发布到
 * OpenClaw workspace。`sfoa-mcp-maintainer` 是开发/运维 Skill，永远不得进入
 * 这个列表，也不得因为「方便同步」而把整个 `skills/*` 复制到 Runtime。
 */
export const BUSINESS_SKILL_ALLOWLIST = Object.freeze(['sfoa-crm-core', 'sfoa-record-change']);

/** Runtime Copy 中禁止出现的文件特征：凭据、版本库元数据与可执行脚本。 */
const RUNTIME_FORBIDDEN_SEGMENTS = Object.freeze(['.git', '.ssh', 'secrets', 'node_modules', '__pycache__']);
const RUNTIME_FORBIDDEN_EXTENSIONS = Object.freeze(['.mjs', '.js', '.cjs', '.sh', '.ps1', '.bat', '.exe', '.pem', '.key', '.crt', '.p12', '.pfx']);
const RUNTIME_FORBIDDEN_NAMES = Object.freeze(['.env', '.env.local', 'id_rsa', 'id_rsa.pub', 'openclaw.json', 'credentials']);

export function assertBusinessSkillAllowed(skillName) {
  if (!BUSINESS_SKILL_ALLOWLIST.includes(skillName)) {
    throw new Error(`Skill ${skillName} is not in the business runtime allowlist (${BUSINESS_SKILL_ALLOWLIST.join(', ')}). Refusing to deploy it to a business Agent.`);
  }
}

/**
 * 业务 Skill 的 Runtime Copy 发布。
 *
 * 方向永远是 canonical → runtime，绝不反向维护。只复制白名单内的单个 Skill 目录，
 * 并在复制前拒绝符号链接、版本库元数据、凭据与可执行脚本，避免把 maintainer
 * 工具链或 Secret 带进普通业务 Agent 的 workspace。
 */
export async function syncRuntimeSkill({ canonicalDir, runtimeRoot }) {
  const skillName = path.basename(canonicalDir);
  assertBusinessSkillAllowed(skillName);
  const validation = await validateSkill({ canonicalDir });
  if (!validation.ok) throw new Error(`Canonical Skill validation failed: ${validation.errors.join('; ')}`);
  const files = await listFiles(canonicalDir);
  for (const file of files) {
    if (file.isSymbolicLink) throw new Error(`Runtime Copy refuses symbolic links: ${file.relativePath}`);
    assertRuntimePortable(file.relativePath);
  }
  const resolvedRoot = path.resolve(runtimeRoot);
  const destination = path.join(resolvedRoot, skillName);
  if (path.dirname(destination) !== resolvedRoot) throw new Error(`Unsafe Runtime Copy destination: ${destination}`);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(canonicalDir, destination, { recursive: true, force: true, errorOnExist: false });
  const digests = await fileDigestMap(canonicalDir);
  return Object.freeze({
    skillName,
    destination: toPosix(destination),
    fileCount: files.length,
    files: Object.freeze([...digests.entries()].map(([name, digest]) => Object.freeze({ name, sha256: digest })).sort((left, right) => left.name.localeCompare(right.name, 'en-US'))),
  });
}

/** 比对 canonical 与 Runtime Copy 的递归 SHA-256 映射，报告缺失、多出与内容漂移。 */
export async function checkRuntimeSkill({ canonicalDir, runtimeRoot }) {
  const skillName = path.basename(canonicalDir);
  assertBusinessSkillAllowed(skillName);
  const validation = await validateSkill({ canonicalDir });
  const destination = path.join(path.resolve(runtimeRoot), skillName);
  if (!await exists(destination)) {
    return Object.freeze({ ok: false, skillName, destination: toPosix(destination), validation, drift: Object.freeze(['missing Runtime Copy']) });
  }
  const canonical = await fileDigestMap(canonicalDir);
  const copy = await fileDigestMap(destination);
  const drift = [];
  for (const name of [...new Set([...canonical.keys(), ...copy.keys()])].sort()) {
    if (canonical.get(name) !== copy.get(name)) drift.push(`${name}: ${canonical.has(name) ? (copy.has(name) ? 'differs' : 'missing') : 'unexpected'}`);
  }
  return Object.freeze({ ok: validation.ok && drift.length === 0, skillName, destination: toPosix(destination), validation, drift: Object.freeze(drift) });
}

function assertRuntimePortable(relativePath) {
  const posix = toPosix(relativePath);
  const segments = posix.split('/');
  const name = segments.at(-1) ?? '';
  if (segments.some((segment) => RUNTIME_FORBIDDEN_SEGMENTS.includes(segment))) {
    throw new Error(`Runtime Copy refuses version-control, secret or dependency content: ${posix}`);
  }
  if (RUNTIME_FORBIDDEN_NAMES.includes(name.toLowerCase())
    || RUNTIME_FORBIDDEN_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension))) {
    throw new Error(`Runtime Copy refuses credential or executable content: ${posix}`);
  }
}

async function git(arguments_, cwd) {
  try {
    const result = await execFileAsync('git', arguments_, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
    return { ok: true, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : '',
    };
  }
}

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

async function main() {
  const arguments_ = parseCliArguments(process.argv.slice(2));
  const action = arguments_._[0] ?? 'validate';
  const projectRoot = arguments_['project-root'] ? path.resolve(String(arguments_['project-root'])) : await findProjectRoot();
  const runtimeAction = action === 'runtime-sync' || action === 'runtime-check';
  const canonicalDirs = arguments_.canonical
    ? [path.resolve(String(arguments_.canonical))]
    : await discoverSkills(projectRoot);
  if (arguments_.output && canonicalDirs.length !== 1) throw new Error('--output requires --canonical when packaging multiple Skills.');
  // Runtime actions never iterate every canonical Skill: only the explicit business allowlist
  // may reach an OpenClaw business workspace.
  const selected = runtimeAction
    ? canonicalDirs.filter((dir) => BUSINESS_SKILL_ALLOWLIST.includes(path.basename(dir)))
    : canonicalDirs;
  if (runtimeAction && selected.length === 0) {
    throw new Error(`No canonical Skill matches the business runtime allowlist (${BUSINESS_SKILL_ALLOWLIST.join(', ')}).`);
  }
  for (const canonicalDir of selected) {
    await runAction({ action, projectRoot, canonicalDir, arguments_ });
  }
}

async function runAction({ action, projectRoot, canonicalDir, arguments_ }) {
  if (action === 'validate') {
    const result = await validateSkill({ canonicalDir });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === 'sync') {
    process.stdout.write(`${JSON.stringify(await syncSkill({ projectRoot, canonicalDir }), null, 2)}\n`);
    return;
  }
  if (action === 'check') {
    const result = await checkSkill({ projectRoot, canonicalDir });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === 'delivery') {
    const result = await deliveryCheck({ projectRoot, canonicalDir });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action === 'package') {
    const result = await packageSkill({
      projectRoot,
      canonicalDir,
      ...(arguments_.output ? { outputPath: String(arguments_.output) } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (action === 'runtime-sync' || action === 'runtime-check') {
    if (!arguments_['runtime-root']) throw new Error(`${action} requires --runtime-root so the OpenClaw workspace is never guessed.`);
    const runtimeRoot = String(arguments_['runtime-root']);
    const result = action === 'runtime-sync'
      ? await syncRuntimeSkill({ canonicalDir, runtimeRoot })
      : await checkRuntimeSkill({ canonicalDir, runtimeRoot });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok && action === 'runtime-check') process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown Skill action: ${action}. Use validate, sync, check, delivery, package, runtime-sync, or runtime-check.`);
}

async function validateLinks(canonicalDir, errors) {
  const markdownFiles = (await listFiles(canonicalDir)).filter((file) => file.relativePath.endsWith('.md'));
  for (const file of markdownFiles) {
    const text = await readFile(file.absolutePath, 'utf8');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
      const target = match[1].split('#')[0];
      if (!target || /^(?:https?:|mailto:)/iu.test(target)) continue;
      const resolved = path.resolve(path.dirname(file.absolutePath), target);
      if (!isWithin(canonicalDir, resolved) || !await exists(resolved)) {
        errors.push(`${file.relativePath}: broken local link ${target}`);
      }
    }
  }
}

async function fileDigestMap(root) {
  const entries = await listFiles(root);
  const result = new Map();
  for (const entry of entries) {
    const digest = createHash('sha256').update(await readFile(entry.absolutePath)).digest('hex');
    result.set(entry.relativePath.replaceAll(path.sep, '/'), digest);
  }
  return result;
}

async function listFiles(root, current = root) {
  const output = [];
  for (const item of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en-US'))) {
    const absolutePath = path.join(current, item.name);
    const relativePath = path.relative(root, absolutePath);
    if (item.isSymbolicLink()) {
      output.push({ absolutePath, relativePath, isSymbolicLink: true });
    } else if (item.isDirectory()) {
      output.push(...await listFiles(root, absolutePath));
    } else if (item.isFile()) {
      output.push({ absolutePath, relativePath, isSymbolicLink: false });
    }
  }
  return output;
}

function safeDestination(projectRoot, relativePath) {
  const destination = path.resolve(projectRoot, relativePath);
  if (!isWithin(projectRoot, destination) || !platformSkillPaths(path.basename(destination)).includes(relativePath)) {
    throw new Error(`Unsafe Skill destination: ${relativePath}.`);
  }
  return destination;
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en-US'))) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const isCli = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isCli) main().catch((error) => {
  process.stderr.write(`[skill] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
