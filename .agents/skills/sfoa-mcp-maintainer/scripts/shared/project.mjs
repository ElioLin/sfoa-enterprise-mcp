import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SKILL_NAME = 'sfoa-mcp-maintainer';

const SECRET_ENV_NAME = /(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY|CLIENT_ID|CREDENTIAL|JWT)/iu;
const SECRET_FIELD_NAME = /(?:authorization|cookie|password|secret|token|private.?key|ciphertext|jwt)/iu;
const IDENTIFIER_FIELD_NAME = /^(?:platformUserId|salesforceUsername|userId)$/u;

export async function findProjectRoot(start = process.cwd()) {
  let candidate = path.resolve(start);
  for (;;) {
    if (await exists(path.join(candidate, 'package.json')) && await exists(path.join(candidate, 'docs', 'sfoa'))) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error('Could not locate the sfoa-enterprise-mcp project root.');
    candidate = parent;
  }
}

export async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function parseEnvText(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    values[match[1]] = unquote(match[2].trim());
  }
  return values;
}

export async function loadProjectEnvironment(projectRoot, processEnvironment = process.env) {
  const envPath = path.join(projectRoot, '.env.local');
  let fileValues = {};
  let fileExists = false;
  try {
    fileValues = parseEnvText(await readFile(envPath, 'utf8'));
    fileExists = true;
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
  return Object.freeze({
    fileExists,
    envPath,
    values: Object.freeze({ ...fileValues, ...definedEnvironment(processEnvironment) }),
  });
}

export function configurationStatus(environment, names) {
  return Object.freeze(Object.fromEntries(names.map((name) => [name, isConfigured(environment.values[name]) ? 'configured' : 'missing'])));
}

export function secretValues(environment) {
  return Object.freeze(Object.entries(environment.values)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && isConfigured(value))
    .map(([, value]) => value)
    .filter((value) => value.length >= 4)
    .sort((left, right) => right.length - left.length));
}

export function sanitizeForOutput(value, environment) {
  return sanitize(value, secretValues(environment), new WeakSet());
}

export function maskIdentifier(value) {
  if (typeof value !== 'string' || value.length === 0) return value ?? null;
  const at = value.indexOf('@');
  if (at > 0) return `${value.slice(0, 1)}***${value.slice(at)}`;
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

export function parseCliArguments(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    if (equals > 2) {
      result[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      result[name] = next;
      index += 1;
    } else {
      result[name] = true;
    }
  }
  return result;
}

export async function readWorkspacePackages(projectRoot) {
  const packagesRoot = path.join(projectRoot, 'packages');
  const directories = await readdir(packagesRoot, { withFileTypes: true });
  const packages = [];
  for (const directory of directories.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, 'en-US'))) {
    const manifestPath = path.join(packagesRoot, directory.name, 'package.json');
    if (!await exists(manifestPath)) continue;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    packages.push(Object.freeze({
      directory: `packages/${directory.name}`,
      name: manifest.name ?? null,
      version: manifest.version ?? null,
      private: manifest.private === true,
      scripts: Object.freeze(Object.keys(manifest.scripts ?? {}).sort()),
    }));
  }
  return Object.freeze(packages);
}

export async function runCommand(command, arguments_, options = {}) {
  try {
    const result = await execFileAsync(command, arguments_, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 10_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      env: options.env ?? process.env,
    });
    return Object.freeze({ ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
  } catch (error) {
    return Object.freeze({
      ok: false,
      stdout: typeof error?.stdout === 'string' ? error.stdout.trim() : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr.trim() : '',
      code: typeof error?.code === 'string' || typeof error?.code === 'number' ? String(error.code) : 'UNKNOWN',
    });
  }
}

export function durationToDate(value, now = new Date()) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const trimmed = value.trim();
  const duration = /^(\d+)(m|h|d)$/iu.exec(trimmed);
  if (duration) {
    const amount = Number(duration[1]);
    const multiplier = duration[2].toLowerCase() === 'm' ? 60_000 : duration[2].toLowerCase() === 'h' ? 3_600_000 : 86_400_000;
    return new Date(now.getTime() - amount * multiplier);
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) throw new Error('--since must be an ISO timestamp or a duration such as 30m, 12h, or 7d.');
  return parsed;
}

function sanitize(value, secrets, seen) {
  if (typeof value === 'string') return redactString(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => sanitize(item, secrets, seen));
    seen.delete(value);
    return output;
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const safeStatus = item === 'configured' || item === 'missing' || item === 'invalid';
    if (SECRET_FIELD_NAME.test(key) && !safeStatus) {
      output[key] = '[REDACTED]';
    } else if (IDENTIFIER_FIELD_NAME.test(key) && typeof item === 'string') {
      output[key] = maskIdentifier(item);
    } else {
      output[key] = sanitize(item, secrets, seen);
    }
  }
  seen.delete(value);
  return output;
}

function redactString(value, secrets) {
  let output = value
    .replace(/Bearer\s+[^\s,;"']+/giu, 'Bearer [REDACTED]')
    .replace(/sfoa_ub1_[A-Za-z0-9_-]+/gu, '[REDACTED_USER_BOUND_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[REDACTED_JWT]')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu, '[REDACTED_PRIVATE_KEY]');
  for (const secret of secrets) output = output.split(secret).join('[REDACTED]');
  return output;
}

function definedEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined));
}

function isConfigured(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function unquote(value) {
  if (value.length < 2) return value;
  const first = value.at(0);
  const last = value.at(-1);
  return (first === '"' && last === '"') || (first === "'" && last === "'") ? value.slice(1, -1) : value;
}

function isNodeError(error, code) {
  return error instanceof Error && 'code' in error && error.code === code;
}
