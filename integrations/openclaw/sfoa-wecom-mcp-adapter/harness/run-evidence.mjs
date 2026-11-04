import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

export function readRunOptions(args, defaultRuntime) {
  const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const suite = value('--suite') ?? 'legacy';
  if (!['legacy', 'material'].includes(suite)) throw new Error('suite must be legacy or material');
  const repeats = Number(value('--repeats') ?? (suite === 'material' ? 3 : 1));
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('repeats must be 1..10');
  const concurrency = Number(value('--concurrency') ?? 2);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('concurrency must be 1..3');
  const before = value('--before-runtime'), after = value('--after-runtime');
  if (Boolean(before) !== Boolean(after)) throw new Error('Supply both --before-runtime and --after-runtime, or neither');
  return { suite, repeats, concurrency, runtimeRoots: { before: resolve(before ?? defaultRuntime), after: resolve(after ?? defaultRuntime) },
    runtimeScope: before && after ? 'EXPLICIT_PROVIDER_RUNTIME_ROOTS_SYNTHETIC_SDK' : 'SHARED_PROVIDER_RUNTIME_GUIDANCE_COMPARISON_ONLY',
    cli: value('--openclaw') ?? 'openclaw', selected: value('--cases')?.split(','), observeInput: args.includes('--observe-provider-input') };
}

export function agentCommand({ suite, configPath, workspace, state, messageFile, sessionId, sessionKey, thinking = 'off' }) {
  const args = suite === 'material'
    ? ['agent', '--local', '--agent', 'main', '--session-id', sessionId, '--session-key', sessionKey]
    : ['agent', 'exec', '--config', configPath, '--cwd', workspace, '--state-dir', state];
  return { args: [...args, '--message-file', messageFile, '--thinking', thinking, '--timeout', '180', '--json'],
    env: { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: state } };
}

export function normalizeTurnResult(parsed) {
  const body = parsed.result ?? parsed;
  const agent = body.meta?.agentMeta;
  return { runId: parsed.runId ?? body.runId ?? body.meta?.runId ?? agent?.runId ?? 'NOT_AVAILABLE',
    sessionId: parsed.sessionId ?? body.sessionId ?? agent?.sessionId ?? 'NOT_AVAILABLE',
    model: parsed.model ?? body.model ?? (agent?.model ? [agent.provider, agent.model].filter(Boolean).join('/') : ''),
    reply: parsed.final ?? body.final ?? body.payloads?.map(item => item.text ?? '').filter(Boolean).join('\n') ?? '',
    executionStatus: parsed.status ?? body.status ?? (body.meta?.aborted ? 'aborted' : agent && Array.isArray(body.payloads) ? 'ok' : 'INVALID_RESULT'),
    usage: agent?.usage ?? body.usage ?? null, durationMs: body.meta?.durationMs ?? body.durationMs ?? null };
}

/** Hash executed JavaScript, not only unchanged index re-exports. Never read configuration. */
export async function runtimeFingerprint(runtimeRoot) {
  const files = [];
  for (const name of ['mcp-provider-sfoa-context', 'mcp-provider-sfoa-dml', 'mcp-provider-sfoa-data', 'sfoa-mcp-server']) await walk(resolve(runtimeRoot, 'packages', name, 'dist'));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { runtimeRoot: resolve(runtimeRoot), evidence: 'EXECUTED_PROVIDER_DIST_FILES', files,
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Runtime fingerprint refuses symlinks');
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'test') await walk(path); }
      else if (entry.name.endsWith('.js')) files.push({ path: relative(runtimeRoot, path).replaceAll('\\', '/'), sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
    }
  }
}
