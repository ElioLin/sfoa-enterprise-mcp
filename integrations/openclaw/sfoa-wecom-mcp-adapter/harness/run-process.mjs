import { spawn } from 'node:child_process';
import { completedAgentResult } from './run-evidence.mjs';

/** Owns one child PID only. Never retries the command or signals unrelated tasks. */
export function runAgentProcess(command, args, options, { hardTimeoutMs = 240_000, finalGraceMs = 2_000, killGraceMs = 5_000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', stopping, finalTimer, killTimer, settled = false;
    const finish = (exitCode, exitSignal, spawnError = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer); clearTimeout(finalTimer); clearTimeout(killTimer);
      resolve({ stdout, stderr, exitCode, exitSignal,
        completeFinalResult: Boolean(completedAgentResult(stdout)),
        processLifecycleStatus: spawnError ? 'SPAWN_ERROR' : stopping ?? 'EXITED' });
    };
    const stop = reason => {
      if (stopping || settled) return;
      // The process may exit normally between the final timer and this callback.
      if (child.exitCode !== null || child.signalCode !== null) return;
      stopping = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, killGraceMs);
    };
    const hardTimer = setTimeout(() => stop(completedAgentResult(stdout) ? 'FINAL_RESULT_TERMINATED' : 'HARD_TIMEOUT'), hardTimeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => {
      stdout += data;
      clearTimeout(finalTimer);
      if (!stopping && completedAgentResult(stdout)) finalTimer = setTimeout(() => {
        if (completedAgentResult(stdout)) stop('FINAL_RESULT_TERMINATED');
      }, finalGraceMs);
    });
    child.stderr.on('data', data => { stderr += data; });
    // close, unlike exit, includes the final bytes drained from stdout/stderr.
    child.once('close', (code, signal) => finish(code, signal));
    child.once('error', error => {
      stderr += `OpenClaw process could not start: ${error.code ?? 'SPAWN_ERROR'}\n`;
      finish(-1, null, true);
    });
  });
}
