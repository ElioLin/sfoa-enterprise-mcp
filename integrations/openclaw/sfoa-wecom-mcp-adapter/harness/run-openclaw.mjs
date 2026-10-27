/** Test-server only: native OpenClaw + isolated loopback MCP + in-memory DML. */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { businessCases, prepareEvaluation, serveFixture } from './business-autonomy.mjs';
import { projectOpenClawConfig } from './inspect-openclaw.mjs';

const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const required = name => { const v = value(name); if (!v) throw new Error(`Required: ${name}`); return resolve(v); };
const actual = JSON.parse(await readFile(required('--config'), 'utf8'));
const output = required('--output');
const before = required('--before-source');
const after = required('--after-source');
const main = actual.agents?.entries?.main ?? actual.agents?.list?.find(a => a.id === 'main');
if (!main) throw new Error('The actual main Agent must be configured.');
await mkdir(output, { recursive: true, mode: 0o700 });
// Refuse accidental overwrite of previous captures/configuration.
try { await access(join(output, 'runtime-facts.json')); throw new Error('Use a fresh output directory.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const facts = projectOpenClawConfig(actual);
await writeFile(join(output, 'runtime-facts.json'), JSON.stringify(facts, null, 2));
const names = ['sfoa-crm-core', 'sfoa-record-change', 'sfoa-data-analysis', 'sfoa-org-diagnostics'];
const workspaces = {};
for (const [variant, source] of [['before', before], ['after', after]]) {
  const workspace = join(output, variant);
  await prepareEvaluation(workspace, source);
  for (const file of ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md']) {
    try { await copyFile(join(main.workspace ?? actual.agents.defaults.workspace, file), join(workspace, file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  workspaces[variant] = workspace;
}
const selected = value('--cases')?.split(',');
const cases = businessCases.filter(c => !selected || selected.includes(c.id));
if (!cases.length || selected?.some(id => !cases.some(c => c.id === id))) throw new Error('Unknown case ID.');
const jobs = ['before', 'after'].flatMap(variant => cases.map(fixture => ({ variant, fixture })));
let cursor = 0;
const captures = { before: [], after: [] };
async function worker() {
  while (cursor < jobs.length) {
    const { variant, fixture } = jobs[cursor++];
    const id = `${variant}-${fixture.id}`;
    const state = join(output, 'states', id);
    await mkdir(state, { recursive: true, mode: 0o700 });
    const mock = await serveFixture({ caseId: fixture.id, sourceRoot: variant === 'before' ? before : after,
      tracePath: join(state, 'tools.jsonl') });
    try {
      const cfg = { models: actual.models, auth: actual.auth,
        agents: { ...actual.agents, defaults: { ...actual.agents.defaults, workspace: workspaces[variant], model: main.model ?? actual.agents.defaults.model, skipBootstrap: true },
          entries: { main: { ...main, workspace: workspaces[variant], skills: names, tools: { allow: ['read', 'sfoa-eval__*'], fs: { workspaceOnly: true } } } } },
        skills: { entries: Object.fromEntries(names.map(name => [name, { enabled: true }])) },
        tools: { profile: 'full', allow: ['read', 'sfoa-eval__*'], fs: { workspaceOnly: true } }, plugins: { enabled: false },
        mcp: { servers: { 'sfoa-eval': { transport: 'streamable-http', url: mock.endpoint, requestTimeoutMs: 30_000 } } },
        diagnostics: { enabled: true, cacheTrace: { enabled: true } } };
      delete cfg.agents.list;
      delete cfg.agents.bindings;
      for (const key of ['agentDir', 'runtime', 'subagents']) delete cfg.agents.entries.main[key];
      const configPath = join(state, 'config.private.json');
      await writeFile(configPath, JSON.stringify(cfg), { mode: 0o600 });
      const { id: _id, request, material, objectApiName, fields, context, currentValues, candidates } = fixture;
      const prompt = `${request}\n${material ? `已解析材料正文：${material}\n` : ''}当前任务上下文（合成测试资料）：${JSON.stringify({ objectApiName, fields, context, currentValues, candidates })}\n`;
      const messageFile = join(workspaces[variant], `${fixture.id}.txt`);
      await writeFile(messageFile, prompt);
      console.log(JSON.stringify({ start: id, requester: 'none' }));
      const child = spawn(value('--openclaw') ?? 'openclaw', ['agent', 'exec', '--config', configPath, '--cwd', workspaces[variant],
        '--state-dir', state, '--message-file', messageFile, '--thinking', main.thinkingDefault ?? actual.agents.defaults.thinkingDefault ?? 'off', '--timeout', '180', '--json'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', b => { stdout += b; });
      child.stderr.on('data', b => { stderr += b; });
      const code = await new Promise((done, fail) => { child.once('exit', done); child.once('error', fail); });
      await writeFile(join(state, 'result.json'), stdout, { mode: 0o600 });
      await writeFile(join(state, 'stderr.log'), stderr, { mode: 0o600 });
      await writeFile(join(state, 'sdk-dispatches.json'), JSON.stringify(mock.dispatches, null, 2));
      let result; try { result = JSON.parse(stdout); } catch { result = { status: 'INVALID_RESULT' }; }
      captures[variant].push({ id: fixture.id, origin: 'OPENCLAW_RUN', runId: result.sessionId ?? '', model: result.model ?? '',
        contextEvidence: join(state, 'logs/cache-trace.jsonl'), toolCalls: mock.calls, sdkDispatches: mock.dispatches,
        reply: result.final ?? '', executionStatus: result.status, exitCode: code,
        transcriptReview: { questionCount: null, criteria: fixture.review.map(criterion => ({ criterion, verdict: 'NOT_REVIEWED', evidence: '' })) } });
      console.log(JSON.stringify({ done: id, code, status: result.status, model: result.model, toolCalls: mock.calls.length, mutations: mock.dispatches.length }));
    } finally { await mock.close(); }
  }
}
const concurrency = Math.max(1, Math.min(3, Number(value('--concurrency') ?? 2)));
await Promise.all(Array.from({ length: concurrency }, () => worker()));
for (const variant of ['before', 'after']) await writeFile(join(output, `${variant}-captures.json`), JSON.stringify({ cases: captures[variant] }, null, 2));
console.log(JSON.stringify({ status: 'CAPTURED_REQUIRES_SEMANTIC_REVIEW', output, cases: cases.length, requester: 'none; not WeCom end-to-end' }));
