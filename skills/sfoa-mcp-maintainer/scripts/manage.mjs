import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exists, findProjectRoot, parseCliArguments, SKILL_NAME } from './lib/project.mjs';

export const PLATFORM_SKILL_PATHS = Object.freeze([
  '.agents/skills/sfoa-mcp-maintainer',
  '.claude/skills/sfoa-mcp-maintainer',
  '.codebuddy/skills/sfoa-mcp-maintainer',
]);

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
  'scripts/lib/project.mjs',
  'scripts/lib/db.mjs',
]);

export async function validateSkill({ canonicalDir }) {
  const errors = [];
  for (const relativePath of REQUIRED_FILES) {
    if (!await exists(path.join(canonicalDir, relativePath))) errors.push(`missing ${relativePath}`);
  }
  if (errors.length === 0) {
    const skillText = await readFile(path.join(canonicalDir, 'SKILL.md'), 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(skillText)?.[1] ?? '';
    if (!/^name:\s*sfoa-mcp-maintainer\s*$/mu.test(frontmatter)) errors.push('SKILL.md frontmatter name is invalid');
    const description = /^description:\s*(.+)$/mu.exec(frontmatter)?.[1] ?? '';
    for (const keyword of ['develop', 'debug', 'troubleshoot', 'operate', 'review', 'test', 'audit', 'Salesforce', 'MCP', 'identity', 'DML', 'database']) {
      if (!description.toLocaleLowerCase('en-US').includes(keyword.toLocaleLowerCase('en-US'))) {
        errors.push(`SKILL.md description does not cover ${keyword}`);
      }
    }
    if (!skillText.includes('advisory project context, not a reasoning boundary')) {
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
  for (const relativePath of PLATFORM_SKILL_PATHS) {
    const destination = safeDestination(projectRoot, relativePath);
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(canonicalDir, destination, { recursive: true, force: true, errorOnExist: false });
  }
  return Object.freeze({ ...validation, destinations: PLATFORM_SKILL_PATHS });
}

export async function checkSkill({ projectRoot, canonicalDir = path.join(projectRoot, 'skills', SKILL_NAME) }) {
  const validation = await validateSkill({ canonicalDir });
  const drift = [];
  const canonical = await fileDigestMap(canonicalDir);
  for (const relativePath of PLATFORM_SKILL_PATHS) {
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
  const target = outputPath
    ? path.resolve(projectRoot, outputPath)
    : path.join(projectRoot, '.temp', 'skill-packages', `${SKILL_NAME}.zip`);
  const files = await listFiles(canonicalDir);
  const entries = [];
  for (const file of files) {
    if (file.isSymbolicLink) throw new Error(`Cannot package symbolic link ${file.relativePath}.`);
    entries.push(Object.freeze({
      name: `${SKILL_NAME}/${file.relativePath.replaceAll(path.sep, '/')}`,
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

async function main() {
  const arguments_ = parseCliArguments(process.argv.slice(2));
  const action = arguments_._[0] ?? 'validate';
  const projectRoot = arguments_['project-root'] ? path.resolve(String(arguments_['project-root'])) : await findProjectRoot();
  const canonicalDir = arguments_.canonical ? path.resolve(String(arguments_.canonical)) : path.join(projectRoot, 'skills', SKILL_NAME);
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
  if (action === 'package') {
    const result = await packageSkill({
      projectRoot,
      canonicalDir,
      ...(arguments_.output ? { outputPath: String(arguments_.output) } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown Skill action: ${action}. Use validate, sync, check, or package.`);
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
  if (!isWithin(projectRoot, destination) || path.basename(destination) !== SKILL_NAME) {
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
