import assert from 'node:assert/strict';
import test from 'node:test';
import { runTraceActivation } from '../validation/p10-t2-live-milestone.js';

/**
 * Unit coverage for the T2 milestone's activation gate.
 *
 * The gate exists because of a measured defect: the milestone used to execute its reproduction one second
 * after `set_trace_flag` returned, and on 2026-10-09 this deployment logged nothing for those executions at
 * all — the first Apex executed after a flag was created was captured only ninety seconds later, while a
 * reproduction under a flag that was already minutes old was captured within one poll. The listing then
 * came back empty and the run reported `FAIL`, which reads as a refuted claim about the Tools.
 *
 * What is asserted here is the distinction that defect turned on: a platform that never captured the
 * executions is a deployment fact and has to land on `NOT TESTED`, never on `FAIL`. `FAIL` is reserved for
 * a Tool that answered and was wrong, and the whole point of the branch is that no Tool was asked anything.
 *
 * The function is pure — the probe loop that feeds it needs a Connection and an org — so the arithmetic of
 * the counters and the three outcomes is testable in `yarn test`, which is where it has to hold.
 */

test('an activated trace is PASS and carries what the wait cost', () => {
  const gate = runTraceActivation({
    rounds: 2,
    pollAttempts: 21,
    waitedMs: 92_400,
    activated: true,
    refused: false,
  });

  assert.equal(gate.status, 'PASS');
  assert.equal(gate.detail.activation, 'CAPTURED');
  assert.equal(gate.detail.rounds, 2);
  assert.equal(gate.detail.pollAttempts, 21);
  assert.equal(gate.detail.waitedMs, 92_400);
});

test('a trace that never captured is NOT TESTED, not FAIL', () => {
  const gate = runTraceActivation({
    rounds: 2,
    pollAttempts: 36,
    waitedMs: 180_000,
    activated: false,
    refused: false,
  });

  assert.equal(gate.status, 'NOT TESTED');
  assert.equal(gate.detail.activation, 'NEVER_CAPTURED');
  // The reason has to carry the measurement, because this branch is the one a reader will meet without a
  // Salesforce error code to look up: "nothing was logged" is only actionable alongside how long it waited.
  assert.match(String(gate.detail.reason), /never became effective/);
  assert.match(String(gate.detail.reason), /2 warm-up execution\(s\)/);
  assert.match(String(gate.detail.reason), /36 listing\(s\)/);
  assert.match(String(gate.detail.reason), /180s/);
});

test('a refused warm-up execution is NOT TESTED and says which execution refused', () => {
  const gate = runTraceActivation({
    rounds: 1,
    pollAttempts: 0,
    waitedMs: 700,
    activated: false,
    refused: true,
  });

  assert.equal(gate.status, 'NOT TESTED');
  assert.equal(gate.detail.activation, 'EXECUTION_REFUSED');
  assert.equal(gate.detail.pollAttempts, 0);
});

test('the gate reports the shape a milestone report is read with', () => {
  const gate = runTraceActivation({
    rounds: 1,
    pollAttempts: 1,
    waitedMs: 2_500,
    activated: true,
    refused: false,
  });

  // Frozen, like every other gate detail in these reports: a milestone report is evidence, and evidence
  // that a later step can edit is not evidence.
  assert.equal(Object.isFrozen(gate), true);
  assert.equal(Object.isFrozen(gate.detail), true);
});
