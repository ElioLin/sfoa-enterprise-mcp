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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
  const body = parsed.result ?? parsed;
  const agent = body.meta?.agentMeta;
  const status = [parsed.status, body.status].find(value => value !== undefined && value !== 'ok') ?? parsed.status ?? body.status;
  const reasons = [body.meta?.stopReason, body.meta?.completion?.stopReason, body.meta?.completion?.finishReason].filter(value => value !== undefined);
  const failure = body.meta?.aborted ? 'aborted'
    : parsed.error || body.error || body.meta?.error || (Array.isArray(body.payloads) && body.payloads.some(item => item?.isError === true)) ? 'error'
      : parsed.partial || body.partial || body.meta?.partial ? 'partial'
        : body.meta?.replayInvalid ? 'INVALID_RESULT'
          : reasons.some(value => !['stop', 'end_turn', 'stop_sequence'].includes(value)) ? 'INCOMPLETE_RESULT' : undefined;
  return { runId: parsed.runId ?? body.runId ?? body.meta?.runId ?? agent?.runId ?? agent?.terminalReceipt?.runId ?? 'NOT_AVAILABLE',
    sessionId: parsed.sessionId ?? body.sessionId ?? agent?.sessionId ?? 'NOT_AVAILABLE',
    model: parsed.model ?? body.model ?? (agent?.model ? [agent.provider, agent.model].filter(Boolean).join('/') : ''),
    reply: parsed.final ?? body.final ?? (Array.isArray(body.payloads) ? body.payloads.map(item => item?.text ?? '').filter(Boolean).join('\n') : ''),
    executionStatus: failure ?? status ?? (agent && Array.isArray(body.payloads) ? 'ok' : 'INVALID_RESULT'),
    usage: agent?.usage ?? body.usage ?? null, durationMs: body.meta?.durationMs ?? body.durationMs ?? null };
}

/** Only the observed final CLI envelope can justify ending a lingering process. */
export function completedAgentResult(stdout) {
  let parsed; try { parsed = JSON.parse(stdout); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const body = parsed.result ?? parsed;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const meta = body.meta, agent = meta?.agentMeta;
  if (!meta || !agent || !Number.isFinite(meta.durationMs) || meta.durationMs < 0
    || typeof agent.sessionId !== 'string' || !agent.sessionId
    || typeof agent.model !== 'string' || !agent.model
    || !Array.isArray(body.payloads) || !body.payloads.some(item => typeof item?.text === 'string' && item.text.trim())) return undefined;
  // OpenClaw 2026.9.5 can retain livenessState=working in a final envelope. Its
  // completion stop/finish reasons and non-aborted result are the terminal facts.
  const reasons = [meta.stopReason, meta.completion?.stopReason, meta.completion?.finishReason].filter(value => value !== undefined);
  if (!reasons.length || reasons.some(value => !['stop', 'end_turn', 'stop_sequence'].includes(value))) return undefined;
  if ([parsed.status, body.status].some(value => value !== undefined && value !== 'ok')) return undefined;
  return normalizeTurnResult(parsed).executionStatus === 'ok' ? parsed : undefined;
}

/** Preserve real OS exit facts; a proven final result is independent of CLI shutdown. */
export function isSuccessfulTurn(turn) {
  if (turn.executionStatus !== 'ok') return false;
  if (turn.processLifecycleStatus === 'FINAL_RESULT_TERMINATED') return turn.completeFinalResult === true
    && ((turn.exitCode === null && ['SIGTERM', 'SIGKILL'].includes(turn.exitSignal))
      || (turn.exitCode === 0 && turn.exitSignal === null));
  return turn.exitCode === 0 && (turn.processLifecycleStatus === undefined || turn.processLifecycleStatus === 'EXITED');
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
