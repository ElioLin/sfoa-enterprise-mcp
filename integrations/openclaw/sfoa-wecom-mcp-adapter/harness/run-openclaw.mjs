/** Test-server only: native OpenClaw + isolated loopback MCP + in-memory DML. */
import { readFile, writeFile, mkdir, copyFile, access, cp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { businessCases, prepareEvaluation, serveFixture } from './business-autonomy.mjs';
import { projectOpenClawConfig } from './inspect-openclaw.mjs';
import { observeProviderInput } from './provider-input-observer.mjs';
import { materialCases, prepareMaterialTurn, serveMaterialFixture } from './material-workflows.mjs';
import { agentCommand, isSuccessfulTurn, normalizeTurnResult, readRunOptions, runtimeFingerprint } from './run-evidence.mjs';
import { runAgentProcess } from './run-process.mjs';

const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const required = name => { const v = value(name); if (!v) throw new Error(`Required: ${name}`); return resolve(v); };
const actual = JSON.parse(await readFile(required('--config'), 'utf8'));
const output = required('--output');
const before = required('--before-source');
const after = required('--after-source');
const options = readRunOptions(args, fileURLToPath(new URL('../../../../', import.meta.url)));
const main = actual.agents?.entries?.main ?? actual.agents?.list?.find(a => a.id === 'main');
if (!main) throw new Error('The actual main Agent must be configured.');
await mkdir(output, { recursive: true, mode: 0o700 });
// Refuse accidental overwrite of previous captures/configuration.
try { await access(join(output, 'runtime-facts.json')); throw new Error('Use a fresh output directory.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const facts = { ...projectOpenClawConfig(actual), suite: options.suite, repeats: options.repeats, runtimeScope: options.runtimeScope,
  modelInput: options.suite === 'material' ? 'NATURAL_TASK_AND_RAW_TEXT_CSV_FILES' : 'LEGACY_PREPARSED_CONTEXT_FIXTURES',
  realSalesforce: 'NOT_TESTED', wecom: 'NOT_TESTED', attachmentBackend: 'SIMULATED' };
await writeFile(join(output, 'runtime-facts.json'), JSON.stringify(facts, null, 2));
const names = ['crm-core', 'crm-record-change', 'crm-data-analysis', 'crm-org-diagnostics'];
const workspaces = {};
for (const [variant, source] of [['before', before], ['after', after]]) {
  const workspace = join(output, variant);
  await prepareEvaluation(workspace, source);
  for (const file of ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md']) {
    try { await copyFile(join(main.workspace ?? actual.agents.defaults.workspace, file), join(workspace, file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  workspaces[variant] = workspace;
  await writeFile(join(output, `${variant}-runtime-sha256.json`), JSON.stringify(await runtimeFingerprint(options.runtimeRoots[variant]), null, 2));
}
const selected = options.selected;
const cases = (options.suite === 'material' ? materialCases : businessCases).filter(c => !selected || selected.includes(c.id));
if (!cases.length || selected?.some(id => !cases.some(c => c.id === id))) throw new Error('Unknown case ID.');
const jobs = ['before', 'after'].flatMap(variant => Array.from({ length: options.repeats }, (_, index) => index + 1)
  .flatMap(iteration => cases.map(fixture => ({ variant, fixture, iteration }))));
let cursor = 0;
const captures = { before: [], after: [] };
async function worker() {
  while (cursor < jobs.length) {
    const { variant, fixture, iteration } = jobs[cursor++];
    const id = `${variant}-${fixture.id}-${iteration}`;
    const state = join(output, 'states', id);
    const workspace = join(state, 'workspace');
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    // Keep each case/repetition isolated and exclude legacy inputs.json, which
    // contains preloaded metadata that must never leak into a natural task.
    await cp(join(workspaces[variant], 'skills'), join(workspace, 'skills'), { recursive: true });
    for (const file of ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'playbook.md']) {
      try { await copyFile(join(workspaces[variant], file), join(workspace, file)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const mock = await (options.suite === 'material' ? serveMaterialFixture : serveFixture)({ caseId: fixture.id, sourceRoot: variant === 'before' ? before : after,
      runtimeRoot: options.runtimeRoots[variant],
      tracePath: join(state, 'tools.jsonl') });
    const primary = (typeof main.model === 'string' ? main.model : main.model?.primary)
      ?? (typeof actual.agents.defaults.model === 'string' ? actual.agents.defaults.model : actual.agents.defaults.model.primary);
    const observer = args.includes('--observe-provider-input')
      ? await observeProviderInput(actual.models, primary, join(state, 'provider-input.jsonl')) : undefined;
    try {
      const cfg = { models: observer?.models ?? actual.models, auth: actual.auth,
        agents: { ...actual.agents, defaults: { ...actual.agents.defaults, workspace, model: main.model ?? actual.agents.defaults.model, skipBootstrap: true },
          entries: { main: { ...main, workspace, skills: names, tools: { allow: ['read', 'sfoa-eval__*'], fs: { workspaceOnly: true } } } } },
        skills: { entries: Object.fromEntries(names.map(name => [name, { enabled: true }])) },
        tools: { profile: 'full', allow: ['read', 'sfoa-eval__*'], fs: { workspaceOnly: true } }, plugins: { enabled: false },
        mcp: { servers: { 'sfoa-eval': { transport: 'streamable-http', url: mock.endpoint, requestTimeoutMs: 30_000 } } },
        diagnostics: { enabled: true, cacheTrace: { enabled: true } } };
      delete cfg.agents.list;
      delete cfg.agents.bindings;
      for (const key of ['agentDir', 'runtime', 'subagents']) delete cfg.agents.entries.main[key];
      const configPath = join(state, 'config.private.json');
      await writeFile(configPath, JSON.stringify(cfg), { mode: 0o600 });
      const sessionId = randomUUID(), sessionKey = `agent:main:material-${id}`;
      const turns = [], materials = [];
      const turnCount = options.suite === 'material' ? fixture.turns.length : 1;
      for (let turn = 0; turn < turnCount; turn++) {
        mock.beginTurn?.(turn);
        let prompt;
        if (options.suite === 'material') {
          const prepared = await prepareMaterialTurn(fixture, turn, workspace);
          prompt = prepared.prompt; materials.push(...prepared.materialEvidence);
        } else {
          const { request, material, objectApiName, fields, context, currentValues, candidates } = fixture;
          prompt = `${request}\n${material ? `已解析材料正文：${material}\n` : ''}当前任务上下文（合成测试资料）：${JSON.stringify({ objectApiName, fields, context, currentValues, candidates })}\n`;
        }
        const messageFile = join(workspace, `turn-${turn + 1}.txt`);
        await writeFile(messageFile, prompt, { mode: 0o600 });
        const command = agentCommand({ suite: options.suite, configPath, workspace, state, messageFile, sessionId, sessionKey,
          thinking: main.thinkingDefault ?? actual.agents.defaults.thinkingDefault ?? 'off' });
        console.log(JSON.stringify({ start: id, turn, requester: 'none', suite: options.suite }));
        const { stdout, stderr, ...processResult } = await runAgentProcess(options.cli, command.args,
          { cwd: workspace, env: { ...process.env, ...command.env } });
        await writeFile(join(state, `turn-${turn + 1}-result.json`), stdout, { mode: 0o600 });
        await writeFile(join(state, `turn-${turn + 1}-stderr.log`), stderr, { mode: 0o600 });
        let parsed; try { parsed = JSON.parse(stdout); } catch { parsed = { status: 'INVALID_RESULT' }; }
        const result = normalizeTurnResult(parsed);
        const capturedTurn = { turn, ...result, ...processResult,
          ...(processResult.processLifecycleStatus === 'HARD_TIMEOUT' ? { executionStatus: 'HARD_TIMEOUT' } : {}) };
        turns.push(capturedTurn);
        console.log(JSON.stringify({ done: id, turn, code: capturedTurn.exitCode, status: capturedTurn.executionStatus,
          processLifecycleStatus: capturedTurn.processLifecycleStatus, model: result.model, toolCalls: mock.calls.length, mutations: mock.dispatches.length }));
        if (!isSuccessfulTurn(capturedTurn)) break;
      }
      await writeFile(join(state, 'sdk-dispatches.json'), JSON.stringify(mock.dispatches, null, 2));
      const final = turns.at(-1) ?? {};
      const capture = { id: fixture.id, iteration, origin: 'OPENCLAW_RUN', runId: final.runId ?? 'NOT_AVAILABLE',
        sessionId: final.sessionId ?? 'NOT_AVAILABLE', model: final.model ?? '',
        runtimeScope: options.runtimeScope, turns, materialReview: materials, uploads: mock.uploads ?? [], finalRecords: mock.records ?? null,
        contextEvidence: join(state, observer ? 'provider-input.jsonl' : 'logs/cache-trace.jsonl'), toolCalls: mock.calls, sdkDispatches: mock.dispatches,
        reply: turns.map(item => item.reply).join('\n\n'), executionStatus: final.executionStatus, exitCode: final.exitCode,
        exitSignal: final.exitSignal, processLifecycleStatus: final.processLifecycleStatus, completeFinalResult: final.completeFinalResult,
        transcriptReview: { blockingQuestionCount: null, optionalArchiveInvitations: null,
          criteria: fixture.review.map(criterion => ({ criterion, verdict: 'NOT_REVIEWED', evidence: '' })) } };
      captures[variant].push(capture);
      await writeFile(join(state, 'capture.json'), JSON.stringify(capture, null, 2), { mode: 0o600 });
    } finally { await observer?.close(); await mock.close(); }
  }
}
const concurrency = options.concurrency;
await Promise.all(Array.from({ length: concurrency }, () => worker()));
for (const variant of ['before', 'after']) await writeFile(join(output, `${variant}-captures.json`), JSON.stringify({ suite: options.suite, runtimeScope: options.runtimeScope,
  cases: captures[variant].sort((a, b) => a.id.localeCompare(b.id) || a.iteration - b.iteration) }, null, 2));
console.log(JSON.stringify({ status: 'CAPTURED_REQUIRES_SEMANTIC_REVIEW', output, cases: cases.length, repeats: options.repeats,
  runtimeScope: options.runtimeScope, requester: 'none; not WeCom end-to-end', realSalesforce: 'NOT_TESTED' }));
