import assert from 'node:assert/strict';
import test from 'node:test';
import {
  P10_PROBE_AREAS,
  P10_PROBE_OUTCOMES,
  P10_PROBE_SOURCES,
  ProbeRecorder,
  maskIdentifier,
  maskSalesforceId,
  writeProbesAllowed,
  type P10ProbeStep,
} from '../validation/p10-diagnostic-probe.js';

/**
 * Unit coverage for the P10-T1 probe's output structure and, above all, its desensitization.
 *
 * The probe is the one place in this repository where raw Salesforce values are written into a
 * committed document, and its failure mode is the quiet one: an unmasked identifier or an unredacted
 * secret does not throw, it is simply committed. So the masking rules are tested directly against the
 * class that performs them, without a Salesforce Connection — a test that needed an org could not run
 * in `yarn test`, which is where this has to run.
 *
 * The ids below are deliberately well-formed 15- or 18-character ones. Every real Salesforce id is one
 * of those two widths, so a 16-character stand-in would test nothing: it would pass the shape rules by
 * accident and would never appear in production evidence. The regression cases, by contrast, are not
 * hypothetical — the first version of the masker corrupted `PermissionsRead`, `SetupAuditTrail` and
 * `NamedCredential`, because a shape-only rule cannot tell a Salesforce id from an ordinary
 * 15-character identifier.
 */

const SECRET = 'super-secret-jwt-value';
/** A custom-object id: 15 characters that do *not* begin with a digit, so only the key rule catches it. */
const CUSTOM_OBJECT_ID = 'a1B000000000123';

async function recordOne(
  facts: Record<string, unknown>,
  statement: string | null = null,
): Promise<P10ProbeStep> {
  const recorder = new ProbeRecorder([SECRET]);
  await recorder.record(
    'UNIT_STEP',
    'ORG',
    'A unit-test question',
    'STANDARD',
    statement,
    async () => ({ outcome: 'AVAILABLE', facts }),
  );
  const [step] = recorder.collected();
  assert.ok(step, 'the recorder must collect the step it just ran');
  return step;
}

test('the outcome vocabulary is exactly what the report summary is keyed by', () => {
  for (const vocabulary of [P10_PROBE_AREAS, P10_PROBE_SOURCES, P10_PROBE_OUTCOMES]) {
    assert.ok(vocabulary.length > 0);
    assert.equal(new Set(vocabulary).size, vocabulary.length, 'a vocabulary must not repeat a member');
  }
  // Pinned literally: a silently dropped member would make the report's `summary` carry a missing key
  // rather than a wrong number, and a reader would have to notice an absence.
  assert.deepEqual([...P10_PROBE_OUTCOMES], ['AVAILABLE', 'DENIED', 'ERROR', 'SKIPPED', 'NOT_PROBED']);
  assert.deepEqual([...P10_PROBE_SOURCES], ['STANDARD', 'TOOLING', 'METADATA', 'REST']);
});

test('a recorded step carries the shape a reader consumes', async () => {
  const step = await recordOne({ isSandbox: true });
  assert.equal(step.id, 'UNIT_STEP');
  assert.equal(step.area, 'ORG');
  assert.equal(step.source, 'STANDARD');
  assert.equal(step.outcome, 'AVAILABLE');
  assert.equal(step.salesforceErrorCode, null);
  assert.equal(step.errorMessageSafe, null);
  assert.deepEqual(step.facts, { isSandbox: true });
  assert.ok(Object.isFrozen(step), 'a step is frozen so no later caller can mutate the report');
});

test('a 15-character id inside free text is masked, keeping only its object prefix', async () => {
  const step = await recordOne({ latest: 'row 005000000000123 created' });
  assert.equal(step.facts.latest, 'row 005*********123 created');
});

test('an 18-character id is masked as well as a 15-character one', async () => {
  const step = await recordOne({ latest: '00D000000000123ABC' });
  assert.equal(step.facts.latest, '00D************ABC');
});

test('an email address is masked to its first character and its domain', async () => {
  const step = await recordOne({ owner: 'ordertooa@runner.force.com.uat' });
  assert.equal(step.facts.owner, 'o***@runner.force.com.uat');
});

test('a 15-character standard id under an id-named key is masked', async () => {
  const step = await recordOne({ AssigneeId: '005000000000123', ParentId: '0PS000000000123' });
  assert.equal(step.facts.AssigneeId, '005*********123');
  assert.equal(step.facts.ParentId, '0PS*********123');
});

test('a custom-object id under an id-named key is masked, which only the key rule can do', async () => {
  // This is the case the free-text rule structurally cannot reach: `a1B…` does not lead with a digit,
  // so without the key rule a custom-object id would be committed verbatim.
  const step = await recordOne({ MyCustomObjectId: CUSTOM_OBJECT_ID, note: `see ${CUSTOM_OBJECT_ID}` });
  assert.equal(step.facts.MyCustomObjectId, 'a1B*********123');
  assert.equal(step.facts.note, `see ${CUSTOM_OBJECT_ID}`);
});

test('ordinary identifiers are NOT masked, which is the shape-only rule’s regression', async () => {
  // All three of the first are exactly 15 characters and were corrupted by the first masker.
  const step = await recordOne({
    object: 'PermissionsRead',
    sobject: 'SetupAuditTrail',
    metadataType: 'NamedCredential',
    profile: 'SolutionManager',
  });
  assert.deepEqual(step.facts, {
    object: 'PermissionsRead',
    sobject: 'SetupAuditTrail',
    metadataType: 'NamedCredential',
    profile: 'SolutionManager',
  });
});

test('a short non-id value under an id-named key survives', async () => {
  // `{ CreatedById: 'YES' }` is a filterability answer, not an identifier. Masking on the key alone
  // turned it into `***` before the value's shape was also required.
  const step = await recordOne({ filterable: { CreatedById: 'YES', Section: 'NO' } });
  assert.deepEqual(step.facts.filterable, { CreatedById: 'YES', Section: 'NO' });
});

test('scalars are preserved so a report can be read as data, not only as text', async () => {
  const step = await recordOne({ total: 73, done: true, missing: null });
  assert.equal(step.facts.total, 73);
  assert.equal(step.facts.done, true);
  assert.equal(step.facts.missing, null);
});

test('a configured secret is redacted wherever it appears, the statement included', async () => {
  const step = await recordOne({ note: `token=${SECRET}` }, `SELECT Id FROM ApexLog WHERE X = '${SECRET}'`);
  assert.equal(step.facts.note, 'token=<redacted>');
  assert.ok(step.statement !== null);
  assert.equal(step.statement, "SELECT Id FROM ApexLog WHERE X = '<redacted>'");
});

test('a refusal is classified DENIED with its code, and keeps the context the step supplied', async () => {
  const recorder = new ProbeRecorder([]);
  await recorder.record(
    'UNIT_REFUSAL',
    'BOUNDARY',
    'Does the API refuse a business object?',
    'TOOLING',
    'SELECT Id FROM Lead LIMIT 1',
    async () => {
      throw Object.assign(new Error("sObject type 'Lead' is not supported."), { errorCode: 'INVALID_TYPE' });
    },
    () => ({ object: 'Lead', kind: 'STANDARD_BUSINESS' }),
  );
  const [step] = recorder.collected();
  assert.ok(step);
  assert.equal(step.outcome, 'DENIED');
  assert.equal(step.salesforceErrorCode, 'INVALID_TYPE');
  // Without the context provider this would be the only kind of row in the report carrying nothing,
  // which is how a refusal — the answer several steps are looking for — became unattributable.
  assert.deepEqual(step.facts, { object: 'Lead', kind: 'STANDARD_BUSINESS' });
});

test('a failure with no Salesforce code stays ERROR, so that signal keeps meaning something', async () => {
  const recorder = new ProbeRecorder([]);
  await recorder.record('UNIT_FAULT', 'ORG', 'A harness fault', 'STANDARD', null, async () => {
    throw new Error('the probe itself is wrong');
  });
  const [step] = recorder.collected();
  assert.ok(step);
  assert.equal(step.outcome, 'ERROR');
  assert.equal(step.salesforceErrorCode, null);
});

test('a throwing context provider cannot take the probe down with it', async () => {
  const recorder = new ProbeRecorder([]);
  await recorder.record('UNIT_CONTEXT_FAULT', 'ORG', 'A step whose own context fails', 'STANDARD', null, async () => {
    throw Object.assign(new Error('refused'), { errorCode: 'INVALID_TYPE' });
  }, () => {
    throw new Error('context gathering is broken');
  });
  const [step] = recorder.collected();
  assert.ok(step);
  assert.equal(step.outcome, 'DENIED');
  assert.deepEqual(step.facts, { contextUnavailable: 'The step could not describe what it was attempting.' });
});

test('nesting is bounded rather than unbounded', async () => {
  const step = await recordOne({ a: { b: { c: { d: { e: { f: 'too deep' } } } } } });
  assert.equal(JSON.stringify(step.facts), '{"a":{"b":{"c":{"d":{"e":"[TRUNCATED_DEPTH]"}}}}}');
});

test('long strings are truncated to the recorded maximum', async () => {
  const step = await recordOne({ long: 'x'.repeat(1_000) });
  assert.equal(String(step.facts.long).length, 300);
});

test('write probes cannot be turned on where the org is not a sandbox', () => {
  // The production guarantee, and the reason the variable is not a boolean: an operator can force
  // writes OFF, and cannot talk the probe into configuring production.
  assert.equal(writeProbesAllowed({ P10_PROBE_WRITE_PROBES: 'on' }, false), false);
  assert.equal(writeProbesAllowed({}, false), false);
  assert.equal(writeProbesAllowed({ P10_PROBE_WRITE_PROBES: '' }, false), false);
});

test('write probes run in a sandbox by default and can be forced off', () => {
  assert.equal(writeProbesAllowed({}, true), true);
  assert.equal(writeProbesAllowed({ P10_PROBE_WRITE_PROBES: 'on' }, true), true);
  assert.equal(writeProbesAllowed({ P10_PROBE_WRITE_PROBES: 'off' }, true), false);
  assert.equal(writeProbesAllowed({ P10_PROBE_WRITE_PROBES: 'OFF' }, true), false);
  assert.equal(writeProbesAllowed({ P10_PROBE_WRITE_PROBES: ' off ' }, true), false);
});

test('maskIdentifier keeps a username readable enough to attribute and no more', () => {
  assert.equal(maskIdentifier('ordertooa@runner.force.com.uat'), 'o***@runner.force.com.uat');
  assert.equal(maskIdentifier('abcd'), '****');
  assert.equal(maskIdentifier('abcdef'), 'ab***ef');
  assert.equal(maskIdentifier(''), '');
});

test('maskSalesforceId keeps the object prefix and the last three characters only', () => {
  assert.equal(maskSalesforceId('005000000000123'), '005*********123');
  assert.equal(maskSalesforceId('005000000000123AAA'), '005************AAA');
  // Anything narrower than an id falls back to the identifier rule rather than being cut to nonsense.
  assert.equal(maskSalesforceId('short'), 'sh***rt');
});
