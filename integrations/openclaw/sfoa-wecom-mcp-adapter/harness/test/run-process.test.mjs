import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { completedAgentResult, isSuccessfulTurn, normalizeTurnResult } from '../run-evidence.mjs';
import { runAgentProcess } from '../run-process.mjs';

const finalResult = () => ({ payloads: [{ text: 'Done; no operation replayed.' }], meta: {
  durationMs: 12, aborted: false, livenessState: 'working', stopReason: 'stop',
  completion: { stopReason: 'stop', finishReason: 'stop' },
  agentMeta: { sessionId: 'actual-session', provider: 'fixture', model: 'fixture-model',
    terminalReceipt: { runId: 'actual-run', sessionId: 'actual-session' } },
} });
const run = (source, timing = {}) => runAgentProcess(process.execPath, ['-e', source], { windowsHide: true },
  { hardTimeoutMs: 2_000, finalGraceMs: 80, killGraceMs: 100, ...timing });
const capture = processResult => ({ ...normalizeTurnResult(JSON.parse(processResult.stdout)), ...processResult });

test('terminal receipt is a real run ID; explicit failure and incomplete output cannot become success', () => {
  const result = finalResult();
  assert.equal(normalizeTurnResult(result).runId, 'actual-run');
  delete result.meta.agentMeta.terminalReceipt;
  assert.equal(normalizeTurnResult(result).runId, 'NOT_AVAILABLE');
  assert.equal(normalizeTurnResult(result).sessionId, 'actual-session');
  for (const bad of [null, [], { status: 'ok' }, { payloads: {} },
    { ...finalResult(), status: 'error' }, { ...finalResult(), partial: true },
    { status: 'ok', result: { ...finalResult(), status: 'error' } },
    { ...finalResult(), meta: { ...finalResult().meta, aborted: true } },
    { ...finalResult(), meta: { ...finalResult().meta, completion: { finishReason: 'length' } } },
    { ...finalResult(), payloads: [{ text: 'failed', isError: true }] }]) {
    assert.equal(completedAgentResult(JSON.stringify(bad)), undefined);
  }
  assert.equal(completedAgentResult(JSON.stringify(finalResult()) + '\n{"partial":'), undefined);
  assert.equal(normalizeTurnResult({ status: 'ok', result: { ...finalResult(), status: 'error' } }).executionStatus, 'error');
});

test('replayInvalid preserves replay safety facts without rejecting a completed tool attempt', () => {
  const result = finalResult();
  result.meta.replayInvalid = true;
  assert.equal(normalizeTurnResult(result).replayInvalid, true);
  assert.equal(normalizeTurnResult(result).executionStatus, 'ok');
  assert.deepEqual(completedAgentResult(JSON.stringify(result)), result);
  for (const bad of [
    { ...result, status: 'error' },
    { ...result, partial: true },
    { ...result, meta: { ...result.meta, aborted: true } },
    { ...result, meta: { ...result.meta, error: { kind: 'incomplete_turn' } } },
    { ...result, meta: { ...result.meta, completion: { finishReason: 'length' } } },
  ]) {
    assert.equal(completedAgentResult(JSON.stringify(bad)), undefined);
    assert.equal(isSuccessfulTurn({ ...normalizeTurnResult(bad), exitCode: 0 }), false);
  }
  assert.equal(isSuccessfulTurn({ ...normalizeTurnResult(result), exitCode: 1 }), false);
});

test('a complete final JSON with a held timer is preserved; only this child is stopped', { timeout: 10_000 }, async () => {
  const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await once(sibling, 'spawn');
  try {
    const result = await run(`process.stdout.write(${JSON.stringify(JSON.stringify(finalResult()))});setInterval(() => {},1000);`);
    assert.deepEqual(JSON.parse(result.stdout), finalResult());
    assert.equal(result.processLifecycleStatus, 'FINAL_RESULT_TERMINATED');
    assert.equal(result.completeFinalResult, true);
    assert.equal(result.exitCode, null);
    assert.ok(['SIGTERM', 'SIGKILL'].includes(result.exitSignal));
    assert.equal(isSuccessfulTurn(capture(result)), true);
    assert.equal(sibling.exitCode, null);
    assert.equal(sibling.signalCode, null);
    assert.doesNotThrow(() => process.kill(sibling.pid, 0));
  } finally { const closed = once(sibling, 'close'); sibling.kill('SIGKILL'); await closed; }
});

test('partial JSON retains HARD_TIMEOUT and is never treated as a completed turn', { timeout: 10_000 }, async () => {
  const result = await run('process.stdout.write(\'{"payloads":[{"text":"unfinished\');setInterval(() => {},1000);', { hardTimeoutMs: 600 });
  assert.match(result.stdout, /unfinished/u);
  assert.equal(result.processLifecycleStatus, 'HARD_TIMEOUT');
  assert.equal(result.completeFinalResult, false);
  assert.equal(isSuccessfulTurn({ ...result, executionStatus: 'ok' }), false);
});

test('a graceful zero exit after requested stop still requires a proven successful final result', () => {
  const turn = { ...normalizeTurnResult(finalResult()), processLifecycleStatus: 'FINAL_RESULT_TERMINATED',
    completeFinalResult: true, exitCode: 0, exitSignal: null };
  assert.equal(isSuccessfulTurn(turn), true);
  assert.equal(isSuccessfulTurn({ ...turn, completeFinalResult: false }), false);
  assert.equal(isSuccessfulTurn({ ...turn, exitCode: 1 }), false);
  assert.equal(isSuccessfulTurn({ ...turn, executionStatus: 'error' }), false);
});

test('a POSIX child can handle the requested SIGTERM and exit with its real zero code',
  { timeout: 10_000, skip: process.platform === 'win32' }, async () => {
    const result = await run(`process.on('SIGTERM',()=>process.exit(0));process.stdout.write(${JSON.stringify(JSON.stringify(finalResult()))});setInterval(()=>{},1000);`);
    assert.equal(result.processLifecycleStatus, 'FINAL_RESULT_TERMINATED');
    assert.equal(result.exitCode, 0);
    assert.equal(result.exitSignal, null);
    assert.equal(isSuccessfulTurn(capture(result)), true);
  });

test('trailing partial output cancels the early final-result grace', { timeout: 10_000 }, async () => {
  const result = await run(`process.stdout.write(${JSON.stringify(JSON.stringify(finalResult()))});setTimeout(()=>process.stdout.write('{'),20);setInterval(()=>{},1000);`, { hardTimeoutMs: 600 });
  assert.equal(result.processLifecycleStatus, 'HARD_TIMEOUT');
  assert.equal(result.completeFinalResult, false);
});

test('normal exit preserves final bytes and real exit code; a nonzero exit remains failed', { timeout: 10_000 }, async () => {
  for (const code of [0, 1]) {
    const result = await run(`process.stdout.write(${JSON.stringify(JSON.stringify(finalResult()))},()=>process.exit(${code}));`,
      { finalGraceMs: 2_000, hardTimeoutMs: 8_000 });
    assert.equal(result.processLifecycleStatus, 'EXITED');
    assert.equal(result.exitCode, code);
    assert.equal(result.exitSignal, null);
    assert.equal(result.completeFinalResult, true);
    assert.equal(isSuccessfulTurn(capture(result)), code === 0);
  }
});

test('an explicit error envelope remains failed even when the process exits zero', { timeout: 10_000 }, async () => {
  const result = await run(`process.stdout.write(${JSON.stringify(JSON.stringify({ ...finalResult(), status: 'error' }))});`);
  assert.equal(result.exitCode, 0);
  assert.equal(result.completeFinalResult, false);
  assert.equal(isSuccessfulTurn(capture(result)), false);
});

test('failure to spawn produces separate lifecycle evidence without inventing success', async () => {
  const result = await runAgentProcess('sfoa-nonexistent-test-executable', [], {}, { hardTimeoutMs: 100 });
  assert.equal(result.processLifecycleStatus, 'SPAWN_ERROR');
  assert.equal(result.completeFinalResult, false);
  assert.equal(result.exitCode, -1);
  assert.equal(isSuccessfulTurn({ ...result, executionStatus: 'ok' }), false);
});
