import assert from 'node:assert/strict';
import test from 'node:test';
import { ReleaseState, Toolset, type OrgService, type Services } from '@salesforce/mcp-provider-api';
import {
  PLATFORM_DIAGNOSTICS_DEFAULT_LIMIT_PER_SECTION,
  PLATFORM_DIAGNOSTICS_DEFAULT_WINDOW_HOURS,
  PLATFORM_DIAGNOSTICS_MAX_LIMIT_PER_SECTION,
  PLATFORM_DIAGNOSTICS_MAX_TEXT_CHARACTERS,
  PLATFORM_DIAGNOSTICS_MAX_WINDOW_HOURS,
  PLATFORM_DIAGNOSTICS_MIN_WINDOW_HOURS,
  SCHEDULED_JOB_STALL_ASSESSMENTS,
  platformDiagnosticsInputSchema,
  platformDiagnosticsOutputSchema,
  type AsyncFailureEntry,
  type PlatformDiagnosticsOutput,
  type ScheduledJobEntry,
  type SetupChangeEntry,
} from '../schemas.js';
import {
  SCHEDULED_JOB_STALL_GRACE_MS,
  assessScheduledJobStall,
} from '../scheduled-job-stall.js';
import {
  platformDiagnosticsHint,
  type PlatformDiagnosticsHintFacts,
  type PlatformDiagnosticsSectionFact,
} from '../platform-diagnostics-hints.js';
import { GetPlatformDiagnosticsMcpTool } from '../tools/get-platform-diagnostics.js';
import { SfoaContextMcpProvider } from '../provider.js';
import { ContextRuntimeError } from '../errors.js';

/**
 * The unit half of `get_platform_diagnostics`: the window and section arithmetic, the stall rule, the
 * hint's gating, and the text budget's fallbacks.
 *
 * What is deliberately *not* here is anything that needs a Salesforce org — the three sources, the
 * degradation matrix and the merged timeline built from real records are covered by the host-side executor
 * test, and by the live milestone. This file is where the decisions that must hold for *every* org are
 * pinned, including the shapes the reference org cannot produce (it holds no `CronTrigger` rows, so no
 * scheduled-job shape here was ever measured live).
 */

// ---------------------------------------------------------------------------------------------
// Input: the window, the sections, the per-section cap
// ---------------------------------------------------------------------------------------------

test('the window is bounded to the documented hours, and the unset case stays distinguishable from the default', () => {
  assert.equal(platformDiagnosticsInputSchema.safeParse({}).success, true);
  // Unset rather than pre-filled: the executor applies the default, and a schema that substituted it would
  // make "the caller asked for 24" indistinguishable from "the caller asked for nothing".
  const unset = platformDiagnosticsInputSchema.parse({});
  assert.equal(unset.windowHours, undefined);
  assert.equal(unset.sections, undefined);
  assert.equal(unset.limitPerSection, undefined);

  assert.equal(platformDiagnosticsInputSchema.safeParse({ windowHours: PLATFORM_DIAGNOSTICS_MIN_WINDOW_HOURS }).success, true);
  assert.equal(platformDiagnosticsInputSchema.safeParse({ windowHours: PLATFORM_DIAGNOSTICS_MAX_WINDOW_HOURS }).success, true);
  for (const refused of [
    { windowHours: 0 },
    { windowHours: PLATFORM_DIAGNOSTICS_MAX_WINDOW_HOURS + 1 },
    { windowHours: 1.5 },
    { windowHours: -1 },
    { windowHours: '24' },
    { windowHours: null },
  ]) {
    assert.equal(platformDiagnosticsInputSchema.safeParse(refused).success, false, `${JSON.stringify(refused)} must be refused`);
  }
  assert.equal(PLATFORM_DIAGNOSTICS_DEFAULT_WINDOW_HOURS, 24);
  assert.equal(PLATFORM_DIAGNOSTICS_MAX_WINDOW_HOURS, 168);
});

test('section selection drops repeats and normalizes the order, so the same set always yields the same shape', () => {
  const parsed = platformDiagnosticsInputSchema.parse({ sections: ['SCHEDULED_JOBS', 'SETUP_CHANGES'] });
  // Canonical order, not the caller's: a payload whose key order depended on the request would make two
  // otherwise identical answers differ, and this Tool's whole value is that it is comparable.
  assert.deepEqual(parsed.sections, ['SETUP_CHANGES', 'SCHEDULED_JOBS']);
  assert.deepEqual(
    platformDiagnosticsInputSchema.parse({ sections: ['ASYNC_FAILURES', 'ASYNC_FAILURES', 'SETUP_CHANGES'] })?.sections,
    ['SETUP_CHANGES', 'ASYNC_FAILURES'],
  );
  assert.deepEqual(
    platformDiagnosticsInputSchema.parse({ sections: ['SETUP_CHANGES', 'ASYNC_FAILURES', 'SCHEDULED_JOBS'] })?.sections,
    ['SETUP_CHANGES', 'ASYNC_FAILURES', 'SCHEDULED_JOBS'],
  );

  // An empty selection is refused rather than read as "all three": the two readings are opposites, and a
  // silent substitution is exactly how a caller asking for nothing would get everything.
  assert.equal(platformDiagnosticsInputSchema.safeParse({ sections: [] }).success, false);
  // Repeats beyond the number of sections are normalized rather than refused: the caller asked for three
  // sections or fewer, and the array's length is not the thing the bound is about.
  assert.deepEqual(
    platformDiagnosticsInputSchema.parse({ sections: ['SETUP_CHANGES', 'SETUP_CHANGES', 'ASYNC_FAILURES', 'SCHEDULED_JOBS'] })?.sections,
    ['SETUP_CHANGES', 'ASYNC_FAILURES', 'SCHEDULED_JOBS'],
  );
  assert.equal(platformDiagnosticsInputSchema.safeParse({ sections: ['UNKNOWN'] }).success, false);
  assert.equal(platformDiagnosticsInputSchema.safeParse({ sections: 'SETUP_CHANGES' }).success, false);
});

test('the per-section cap is bounded, and no input can select an identity or a Salesforce surface', () => {
  assert.equal(platformDiagnosticsInputSchema.safeParse({ limitPerSection: 1 }).success, true);
  assert.equal(platformDiagnosticsInputSchema.safeParse({ limitPerSection: PLATFORM_DIAGNOSTICS_MAX_LIMIT_PER_SECTION }).success, true);
  assert.equal(platformDiagnosticsInputSchema.safeParse({ limitPerSection: PLATFORM_DIAGNOSTICS_MAX_LIMIT_PER_SECTION + 1 }).success, false);
  assert.equal(platformDiagnosticsInputSchema.safeParse({ limitPerSection: 0 }).success, false);
  assert.equal(PLATFORM_DIAGNOSTICS_DEFAULT_LIMIT_PER_SECTION, 25);

  assert.deepEqual(Object.keys(platformDiagnosticsInputSchema.shape), ['windowHours', 'sections', 'limitPerSection']);
  for (const forged of [
    { username: 'forged@example.test' },
    { usernameOrAlias: 'forged@example.test' },
    { connectionRole: 'DIAGNOSTIC' },
    { platformUserId: 'p2-user-a' },
    { targetUserId: '005000000000001AAA' },
    { instanceUrl: 'https://elsewhere.example.test' },
    { accessToken: 'forged' },
    { useToolingApi: true },
    { api: 'TOOLING' },
    { objectApiName: 'Lead' },
    { query: 'SELECT Id FROM Lead' },
  ]) {
    assert.equal(platformDiagnosticsInputSchema.safeParse(forged).success, false, `${JSON.stringify(forged)} must be refused`);
  }
});

// ---------------------------------------------------------------------------------------------
// Output: the section states, and the role literal
// ---------------------------------------------------------------------------------------------

test('the output schema pins the DIAGNOSTIC role and refuses a USER-role success', () => {
  const output = readEverythingOutput();
  assert.equal(platformDiagnosticsOutputSchema.safeParse(output).success, true);
  assert.equal(platformDiagnosticsOutputSchema.safeParse({ ...output, executionRole: 'USER' }).success, false);
  assert.equal(platformDiagnosticsOutputSchema.safeParse({ ...output, api: 'TOOLING' }).success, false);
  assert.equal(platformDiagnosticsOutputSchema.safeParse({ success: true }).success, true);
  assert.equal(platformDiagnosticsOutputSchema.safeParse({
    success: false,
    errorCode: 'MCP_PLATFORM_DIAGNOSTICS_READ_FAILED',
    message: 'refused',
  }).success, true);
});

test('an unavailable section carries its reason and none of the numbers a reader would misread as zero', () => {
  const unavailable = unavailableOutput();
  const parsed = platformDiagnosticsOutputSchema.parse(unavailable);
  assert.equal(parsed.sections?.setupChanges?.status, 'UNAVAILABLE');
  assert.equal(parsed.sections?.setupChanges?.totalCount, null);
  assert.equal(parsed.sections?.setupChanges?.prerequisite, 'SetupAuditTrail readability on the diagnostic identity');
  // The three sections' own nullable fields are required in *every* state, so an UNAVAILABLE section cannot
  // be written without saying `oldestRetainedAt: null` / `observedStatusCounts: null` /
  // `suspectedStallCount: null` — a shape that omitted them would be a consumer reading a missing key.
  for (const key of ['oldestRetainedAt'] as const) {
    const withoutKey: Record<string, unknown> = { ...unavailable.sections!.setupChanges! };
    delete withoutKey[key];
    assert.equal(
      platformDiagnosticsOutputSchema.safeParse({
        ...unavailable,
        sections: { ...unavailable.sections, setupChanges: withoutKey },
      }).success,
      false,
      `${key} must be required on an unavailable section`,
    );
  }
  const withoutCounts: Record<string, unknown> = { ...unavailable.sections!.asyncFailures! };
  delete withoutCounts.observedStatusCounts;
  assert.equal(
    platformDiagnosticsOutputSchema.safeParse({
      ...unavailable,
      sections: { ...unavailable.sections, asyncFailures: withoutCounts },
    }).success,
    false,
  );
});

// ---------------------------------------------------------------------------------------------
// The stall rule
// ---------------------------------------------------------------------------------------------

const NOW = Date.parse('2026-10-09T12:00:00.000Z');

function minutesBefore(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

test('the stall rule flags a waiting job only when its next fire time is past the grace window', () => {
  const late = assessScheduledJobStall({
    state: 'WAITING',
    nextFireTime: minutesBefore(45),
    previousFireTime: minutesBefore(24 * 60),
    nowMs: NOW,
  });
  assert.equal(late.assessment, 'SUSPECTED');
  // The 禁止事项 of this Tool in one assertion: the verdict is a hedge and the reasons say so.
  assert.match(late.reasons.join(' '), /flag to investigate, not a diagnosis/u);
  assert.match(late.reasons.join(' '), /does not know why/u);

  // Inside the grace window: a scheduler is allowed to be late, and a false accusation costs more than a
  // delayed flag.
  assert.equal(assessScheduledJobStall({
    state: 'WAITING', nextFireTime: minutesBefore(10), previousFireTime: null, nowMs: NOW,
  }).assessment, 'NOT_SUSPECTED');
  assert.equal(assessScheduledJobStall({
    state: 'QUEUED', nextFireTime: minutesBefore(1), previousFireTime: null, nowMs: NOW,
  }).assessment, 'NOT_SUSPECTED');
  // Still ahead of now: waiting, but not late.
  const ahead = assessScheduledJobStall({
    state: 'READY', nextFireTime: new Date(NOW + 60_000).toISOString(), previousFireTime: null, nowMs: NOW,
  });
  assert.equal(ahead.assessment, 'NOT_SUSPECTED');
  assert.match(ahead.reasons.join(' '), /still ahead/u);

  // The boundary itself: exactly at the grace window is not yet late; one minute past it is.
  assert.equal(assessScheduledJobStall({
    state: 'WAITING',
    nextFireTime: new Date(NOW - SCHEDULED_JOB_STALL_GRACE_MS).toISOString(),
    previousFireTime: null,
    nowMs: NOW,
  }).assessment, 'NOT_SUSPECTED');
  assert.equal(assessScheduledJobStall({
    state: 'WAITING',
    nextFireTime: new Date(NOW - SCHEDULED_JOB_STALL_GRACE_MS - 60_000).toISOString(),
    previousFireTime: null,
    nowMs: NOW,
  }).assessment, 'SUSPECTED');
});

test('running and deleted jobs are not suspected, and a vocabulary this rule has not measured is indeterminate', () => {
  for (const state of ['ACQUIRED', 'EXECUTING']) {
    const running = assessScheduledJobStall({
      state, nextFireTime: minutesBefore(600), previousFireTime: minutesBefore(601), nowMs: NOW,
    });
    assert.equal(running.assessment, 'NOT_SUSPECTED', state);
    assert.match(running.reasons.join(' '), /running now/u);
  }
  // A deleted schedule is not a schedule that stopped firing.
  assert.equal(assessScheduledJobStall({
    state: 'DELETED', nextFireTime: minutesBefore(600), previousFireTime: minutesBefore(700), nowMs: NOW,
  }).assessment, 'NOT_SUSPECTED');

  // The reference org holds zero CronTrigger rows, so no state vocabulary could be measured on it. An
  // unfamiliar literal must therefore surface as a gap rather than as health — this is the assertion that
  // stops a later widening of the waiting list from silently swallowing a paused schedule.
  const unknown = assessScheduledJobStall({
    state: 'PAUSED', nextFireTime: minutesBefore(600), previousFireTime: minutesBefore(700), nowMs: NOW,
  });
  assert.equal(unknown.assessment, 'INDETERMINATE');
  assert.match(unknown.reasons.join(' '), /gap rather than read as healthy/u);

  for (const shape of [
    { state: null, nextFireTime: minutesBefore(600), previousFireTime: null },
    { state: 'WAITING', nextFireTime: null, previousFireTime: null },
    { state: 'WAITING', nextFireTime: 'not-a-timestamp', previousFireTime: null },
  ]) {
    const verdict = assessScheduledJobStall({ ...shape, nowMs: NOW });
    assert.equal(verdict.assessment, 'INDETERMINATE', JSON.stringify(shape));
    assert.ok(verdict.reasons.length > 0);
  }

  assert.deepEqual([...SCHEDULED_JOB_STALL_ASSESSMENTS], ['SUSPECTED', 'NOT_SUSPECTED', 'INDETERMINATE']);
  assert.deepEqual(Object.keys(assessScheduledJobStall({
    state: 'WAITING', nextFireTime: minutesBefore(45), previousFireTime: null, nowMs: NOW,
  })).sort(), ['assessment', 'reasons']);
});

// ---------------------------------------------------------------------------------------------
// The Tool's own contract
// ---------------------------------------------------------------------------------------------

test('the Tool is GA, reads only, and its description carries the degradation contract the Agent must know', async () => {
  const tool = new GetPlatformDiagnosticsMcpTool(readerFor(readEverythingOutput()));
  assert.equal(tool.getName(), 'get_platform_diagnostics');
  assert.equal(tool.getReleaseState(), ReleaseState.GA);
  assert.deepEqual(tool.getToolsets(), [Toolset.DATA]);

  const config = tool.getConfig();
  assert.deepEqual(config.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.deepEqual(Object.keys(config.inputSchema ?? {}), ['windowHours', 'sections', 'limitPerSection']);
  const description = config.description ?? '';
  // The three readings an Agent must not conflate, each said in the description: a per-section state, the
  // rule that an unreadable section is never an empty one, and the hedge on the stall flag.
  assert.match(description, /UNAVAILABLE/u);
  assert.match(description, /never reported as an empty one/u);
  assert.match(description, /flag to investigate and never a statement about why/u);
  assert.match(description, /server-owned DIAGNOSTIC identity/u);
  assert.match(description, /SETUP_CHANGES/u);
  assert.match(description, /ASYNC_FAILURES/u);
  assert.match(description, /SCHEDULED_JOBS/u);

  const result = await tool.exec({});
  assert.equal(result.isError, undefined);
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(structured.executionRole, 'DIAGNOSTIC');
  assert.equal(structured.api, 'STANDARD');
  const text = String((result.content[0] as { text: string }).text);
  assert.match(text, /window=/u);
  assert.match(text, /read=3 unavailable=0/u);
  assert.match(text, /Timeline \(/u);
  assert.match(text, /Next: /u);
});

test('the Tool hands the parsed input through and lets the executor apply the defaults', async () => {
  let seen: unknown = null;
  const tool = new GetPlatformDiagnosticsMcpTool({
    execute: async (input) => {
      seen = input;
      return readEverythingOutput();
    },
  });
  await tool.exec({});
  assert.deepEqual(seen, {});
  await tool.exec({ windowHours: 6, sections: ['SCHEDULED_JOBS', 'SETUP_CHANGES'], limitPerSection: 3 });
  assert.deepEqual(seen, {
    windowHours: 6,
    sections: ['SETUP_CHANGES', 'SCHEDULED_JOBS'],
    limitPerSection: 3,
  });
  // A refused input never reaches the executor: the schema is the boundary, not a validator the executor
  // has to repeat.
  const refused = await tool.exec({ windowHours: 10_000 });
  assert.equal(refused.isError, true);
  assert.equal((refused.structuredContent as Record<string, unknown>).errorCode, 'MCP_PLATFORM_DIAGNOSTICS_READ_FAILED');
});

test('a refused aggregation is an error result with this Tool\'s own code, never an empty timeline', async () => {
  const failing = new GetPlatformDiagnosticsMcpTool({
    execute: async () => {
      throw new Error('connection refused');
    },
  });
  const result = await failing.exec({});
  assert.equal(result.isError, true);
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(structured.success, false);
  assert.equal(structured.errorCode, 'MCP_PLATFORM_DIAGNOSTICS_READ_FAILED');

  // A structured refusal keeps its own code and its own prerequisite rather than being flattened into the
  // Tool's generic one — the identifier is the thing an operator looks up.
  const prerequisite = new GetPlatformDiagnosticsMcpTool({
    execute: async () => {
      throw new ContextRuntimeError('MCP_DIAGNOSTIC_PREREQUISITE_MISSING', 'no access', {
        prerequisite: 'platform-status readability on the diagnostic identity',
        suggestion: 'grant it',
      });
    },
  });
  const refused = await prerequisite.exec({});
  const refusedStructured = refused.structuredContent as Record<string, unknown>;
  assert.equal(refusedStructured.errorCode, 'MCP_DIAGNOSTIC_PREREQUISITE_MISSING');
  assert.equal(refusedStructured.prerequisite, 'platform-status readability on the diagnostic identity');
});

// ---------------------------------------------------------------------------------------------
// The text budget
// ---------------------------------------------------------------------------------------------

test('the rendered text drops detail before it drops the timeline, and says what it dropped', async () => {
  // The renderer is handed the payload directly here, so the sizes are chosen to land in the *first*
  // fallback: the whole text overflows, and the text without the per-entry detail fits. That is the
  // ordering being asserted — detail is a re-listing of what `structuredContent` still carries in full, so
  // it is the cheapest thing to lose and the timeline is not.
  const tool = new GetPlatformDiagnosticsMcpTool(readerFor(readEverythingOutput({
    setupEntries: 700,
    asyncEntries: 25,
  })));
  const result = await tool.exec({ limitPerSection: 100 });
  const text = String((result.content[0] as { text: string }).text);
  assert.ok(text.length <= PLATFORM_DIAGNOSTICS_MAX_TEXT_CHARACTERS, `text was ${text.length} characters`);
  assert.match(text, /per-entry detail omitted to fit the text budget/u);
  // The header and the timeline survive every fallback: they are the answer, and the detail below them is a
  // re-listing of entries `structuredContent` still carries in full.
  assert.match(text, /read=3 unavailable=0/u);
  assert.ok(text.includes('Timeline ('));
});

test('the fallback takes the earliest timeline entries first, because an incident is read from the newest', async () => {
  // Long free-text fields on purpose: the entry cap the executor applies (100 per section) is the realistic
  // ceiling, so what makes the timeline itself overflow is the *width* of a line rather than the count. This
  // is the shape that reaches the second fallback — the first one (dropping per-entry detail) is not enough.
  const tool = new GetPlatformDiagnosticsMcpTool(readerFor(readEverythingOutput({
    setupEntries: 100,
    asyncEntries: 100,
    longText: true,
  })));
  const result = await tool.exec({ limitPerSection: 100 });
  const text = String((result.content[0] as { text: string }).text);
  assert.ok(text.length <= PLATFORM_DIAGNOSTICS_MAX_TEXT_CHARACTERS, `text was ${text.length} characters`);
  assert.match(text, /earliest timeline entr(?:y|ies) omitted to fit the text budget/u);
  // The header, the note and the hint survive every fallback, so a shortened answer still says what was read
  // and what to do next.
  assert.match(text, /read=3 unavailable=0/u);
  assert.match(text, /Next: /u);
});

// ---------------------------------------------------------------------------------------------
// The hint: gating, branch order and the bound
// ---------------------------------------------------------------------------------------------

test('the hint leads with the unavailable sections, because a bare timeline cannot show one', () => {
  const facts = hintFacts({
    sections: [
      fact('SETUP_CHANGES', 'UNAVAILABLE', { prerequisite: 'SetupAuditTrail readability on the diagnostic identity' }),
      fact('ASYNC_FAILURES', 'READ', { entryCount: 1, totalCount: 1 }),
      fact('SCHEDULED_JOBS', 'READ', { entryCount: 0, totalCount: 0 }),
    ],
  });
  const hint = platformDiagnosticsHint(new Set(), facts);
  assert.match(hint, /1 of 3 section\(s\) could not be read/u);
  assert.match(hint, /the setup audit trail \(missing: SetupAuditTrail readability on the diagnostic identity\)/u);
  assert.match(hint, /missing evidence rather than a quiet org/u);
  // The branch that would otherwise have led ("line up the nearest change") must not be reachable here.
  assert.doesNotMatch(hint, /candidate, not a cause/u);
});

test('an empty window and a truncated one are said out loud, and neither is left to the reader to infer', () => {
  const empty = platformDiagnosticsHint(new Set(), hintFacts({
    sections: [
      fact('SETUP_CHANGES', 'READ', { entryCount: 0, totalCount: 0 }),
      fact('ASYNC_FAILURES', 'READ', { entryCount: 0, totalCount: 0 }),
    ],
    windowHours: 24,
  }));
  assert.match(empty, /every one is empty in this 24-hour window/u);
  assert.match(empty, /widen windowHours/u);

  const truncated = platformDiagnosticsHint(new Set(), hintFacts({
    sections: [fact('SETUP_CHANGES', 'READ', { entryCount: 25, totalCount: 400 })],
    truncated: true,
  }));
  assert.match(truncated, /dropped to fit the server's response budget/u);

  const ordinary = platformDiagnosticsHint(new Set(), hintFacts({
    sections: [
      fact('SETUP_CHANGES', 'READ', { entryCount: 3, totalCount: 3 }),
      fact('SCHEDULED_JOBS', 'READ', { entryCount: 1, totalCount: 1, suspectedStallCount: 2 }),
    ],
  }));
  assert.match(ordinary, /candidate, not a cause/u);
  assert.match(ordinary, /2 scheduled job\(s\) are flagged SUSPECTED stalled/u);
  assert.match(ordinary, /not a diagnosis/u);
});

test('the hint names a Tool only when the session advertises it, and never exceeds the schema bound', () => {
  // The gating assertions run on the smallest fact set that reaches both Tool-naming branches, so what they
  // assert is the gate rather than how much of the hint survived the character bound — that is the next
  // assertion's job, and mixing them would let a truncation pass for a gate.
  const gating = hintFacts({
    sections: [
      fact('SETUP_CHANGES', 'READ', { entryCount: 2, totalCount: 2 }),
      fact('ASYNC_FAILURES', 'READ', { entryCount: 1, totalCount: 1 }),
    ],
  });
  const bare = platformDiagnosticsHint(new Set(), gating);
  assert.doesNotMatch(bare, /get_metadata_component_context/u);
  assert.doesNotMatch(bare, /get_apex_logs/u);

  const advertised = platformDiagnosticsHint(new Set(['get_metadata_component_context', 'get_apex_logs']), gating);
  assert.match(advertised, /get_metadata_component_context/u);
  assert.match(advertised, /get_apex_logs/u);

  const withRetention = platformDiagnosticsHint(new Set(), hintFacts({
    sections: [fact('SETUP_CHANGES', 'READ', { entryCount: 1, totalCount: 1 })],
    oldestRetainedAt: '2026-04-08T07:40:48.000Z',
  }));
  assert.match(withRetention, /reaches back to 2026-04-08T07:40:48.000Z/u);

  // The longest composition there is: every branch at once, everything advertised. The output schema caps
  // `hint` at 1 000 characters and a refusal there would turn a hint-overflow into a failed call.
  const longest = platformDiagnosticsHint(new Set(['get_metadata_component_context', 'get_apex_logs']), hintFacts({
    sections: [
      fact('SETUP_CHANGES', 'UNAVAILABLE', { prerequisite: 'SetupAuditTrail readability on the diagnostic identity' }),
      fact('ASYNC_FAILURES', 'UNAVAILABLE', { prerequisite: 'AsyncApexJob readability on the diagnostic identity' }),
      fact('SCHEDULED_JOBS', 'UNAVAILABLE', { prerequisite: 'CronTrigger readability on the diagnostic identity' }),
    ],
    truncated: true,
    oldestRetainedAt: '2026-04-08T07:40:48.000Z',
  }));
  assert.ok(longest.length <= 1_000, `hint was ${longest.length} characters`);

  // The unavailable branch leads even when everything else is also true, so the sentence an operator must
  // act on is never the one that got cut.
  assert.match(longest.slice(0, 120), /could not be read/u);
});

test('the Provider refuses to build this Tool without a reader rather than advertising a dead one', async () => {
  // Scoped to this one Tool so the refusal under test is this Tool's: without `toolNames` the Provider would
  // also be asked for the metadata pair and would refuse those first, which would make this test pass for
  // the wrong reason.
  const provider = new SfoaContextMcpProvider({ toolNames: ['get_platform_diagnostics'] });
  await assert.rejects(
    async () => provider.provideTools(createServices()),
    /get_platform_diagnostics requires a platform diagnostics reader/u,
  );
});

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function readerFor(output: PlatformDiagnosticsOutput) {
  return { execute: async () => output };
}

function setupEntry(index: number, longText = false): SetupChangeEntry {
  return {
    id: `0Ym000000000${String(index).padStart(3, '0')}AAA`,
    occurredAt: new Date(Date.parse('2026-10-09T00:00:00.000Z') + index * 60_000).toISOString(),
    action: 'changedApexClass',
    section: 'Apex Classes',
    display: `Changed class SFOA_Demo_${index}${longText ? ` ${'x'.repeat(300)}` : ''}`,
    createdBy: 'SFOA Admin',
    delegateUser: null,
  };
}

function asyncEntry(index: number, longText = false): AsyncFailureEntry {
  return {
    id: `707000000000${String(index).padStart(3, '0')}AAA`,
    occurredAt: new Date(Date.parse('2026-10-09T00:00:00.000Z') + index * 60_000 + 30_000).toISOString(),
    status: index % 2 === 0 ? 'Failed' : 'Aborted',
    jobType: 'BatchApex',
    apexClass: `SFOA_Demo_Batch_${index}`,
    numberOfErrors: 1,
    extendedStatus: `System.DmlException: Insert failed. First exception on row 0 (${index})${longText ? ` ${'y'.repeat(300)}` : ''}`,
  };
}

function scheduledEntry(index: number): ScheduledJobEntry {
  return {
    id: `08e000000000${String(index).padStart(3, '0')}AAA`,
    name: `SFOA_Demo_Job_${index}`,
    jobType: '7',
    state: index % 3 === 0 ? 'WAITING' : 'ACQUIRED',
    nextFireTime: new Date(Date.parse('2026-10-09T00:00:00.000Z') + index * 60_000 + 15_000).toISOString(),
    previousFireTime: null,
    timesTriggered: index,
    stallAssessment: index % 3 === 0 ? 'SUSPECTED' : 'NOT_SUSPECTED',
    stallReasons: ['a reason fact'],
  };
}

type OutputSections = NonNullable<PlatformDiagnosticsOutput['sections']>;

function readEverythingOutput(input: Readonly<{
  setupEntries?: number;
  asyncEntries?: number;
  scheduledEntries?: number;
  longText?: boolean;
}> = {}): PlatformDiagnosticsOutput {
  const longText = input.longText === true;
  const setupEntries = Array.from({ length: input.setupEntries ?? 2 }, (_value, index) => setupEntry(index, longText));
  const asyncEntries = Array.from({ length: input.asyncEntries ?? 1 }, (_value, index) => asyncEntry(index, longText));
  const scheduledEntries = Array.from({ length: input.scheduledEntries ?? 1 }, (_value, index) => scheduledEntry(index));
  return {
    success: true,
    executionRole: 'DIAGNOSTIC',
    api: 'STANDARD',
    window: { from: '2026-10-08T12:00:00.000Z', to: '2026-10-09T12:00:00.000Z', hours: 24 },
    sections: {
      setupChanges: {
        section: 'SETUP_CHANGES',
        status: 'READ',
        entries: setupEntries,
        totalCount: setupEntries.length,
        truncated: false,
        oldestRetainedAt: '2026-04-08T07:40:48.000Z',
        caveats: [],
      },
      asyncFailures: {
        section: 'ASYNC_FAILURES',
        status: 'READ',
        entries: asyncEntries,
        totalCount: asyncEntries.length,
        truncated: false,
        observedStatusCounts: { Completed: 152, Failed: 1 },
        caveats: [],
      },
      scheduledJobs: {
        section: 'SCHEDULED_JOBS',
        status: 'READ',
        entries: scheduledEntries,
        totalCount: scheduledEntries.length,
        truncated: false,
        suspectedStallCount: scheduledEntries.filter((entry) => entry.stallAssessment === 'SUSPECTED').length,
        caveats: [],
      },
    },
    alignment: {
      timeline: [
        ...setupEntries.map((entry) => ({ occurredAt: entry.occurredAt, section: 'SETUP_CHANGES' as const, entryId: entry.id, summary: entry.display ?? '' })),
        ...asyncEntries.map((entry) => ({ occurredAt: entry.occurredAt, section: 'ASYNC_FAILURES' as const, entryId: entry.id, summary: entry.extendedStatus ?? '' })),
      ].sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt)),
      note: 'The timeline merges the sections that were read onto one clock.',
    },
    readSectionCount: 3,
    unavailableSectionCount: 0,
    truncated: false,
    hint: 'The timeline is ordered oldest first.',
  };
}

function unavailableOutput(): PlatformDiagnosticsOutput {
  return {
    success: true,
    executionRole: 'DIAGNOSTIC',
    api: 'STANDARD',
    window: { from: '2026-10-08T12:00:00.000Z', to: '2026-10-09T12:00:00.000Z', hours: 24 },
    sections: {
      // Each unavailable section written out in full rather than through a shared helper, because the three
      // differ in exactly the field this shape is about: the section's own nullable number is required in
      // *every* state, so an unreadable section says `null` rather than omitting it. A helper returning the
      // union would type-check while hiding the one thing a consumer must not have to guess at.
      setupChanges: {
        section: 'SETUP_CHANGES',
        status: 'UNAVAILABLE',
        entries: [],
        totalCount: null,
        truncated: false,
        prerequisite: 'SetupAuditTrail readability on the diagnostic identity',
        errorCode: 'MCP_DIAGNOSTIC_PREREQUISITE_MISSING',
        unavailableReason: 'the setup audit trail could not be read at all.',
        caveats: [],
        oldestRetainedAt: null,
      },
      asyncFailures: {
        section: 'ASYNC_FAILURES',
        status: 'UNAVAILABLE',
        entries: [],
        totalCount: null,
        truncated: false,
        prerequisite: 'AsyncApexJob readability on the diagnostic identity',
        errorCode: 'MCP_DIAGNOSTIC_PREREQUISITE_MISSING',
        unavailableReason: 'the failed asynchronous jobs could not be read at all.',
        caveats: [],
        observedStatusCounts: null,
      },
      scheduledJobs: {
        section: 'SCHEDULED_JOBS',
        status: 'UNAVAILABLE',
        entries: [],
        totalCount: null,
        truncated: false,
        prerequisite: 'CronTrigger readability on the diagnostic identity',
        errorCode: 'MCP_DIAGNOSTIC_PREREQUISITE_MISSING',
        unavailableReason: 'the scheduled jobs could not be read at all.',
        caveats: [],
        suspectedStallCount: null,
      },
    },
    alignment: { timeline: [], note: 'No section could be read, so the timeline is empty.' },
    readSectionCount: 0,
    unavailableSectionCount: 3,
    truncated: false,
    hint: '3 of 3 section(s) could not be read.',
  };
}

function fact(
  section: PlatformDiagnosticsSectionFact['section'],
  status: PlatformDiagnosticsSectionFact['status'],
  overrides: Partial<PlatformDiagnosticsSectionFact> = {},
): PlatformDiagnosticsSectionFact {
  return {
    section,
    status,
    entryCount: 0,
    totalCount: 0,
    suspectedStallCount: null,
    prerequisite: null,
    ...overrides,
  };
}

function hintFacts(overrides: Partial<PlatformDiagnosticsHintFacts> = {}): PlatformDiagnosticsHintFacts {
  return {
    windowHours: 24,
    sections: [],
    truncated: false,
    oldestRetainedAt: null,
    ...overrides,
  };
}

function createServices(): Services {
  const orgService = {
    getAllowedOrgUsernames: async () => new Set(['user@example.test']),
    getConnection: async () => {
      throw new Error('not invoked by Tool contract test');
    },
  } as unknown as OrgService;
  return {
    getOrgService: () => orgService,
    getTelemetryService: () => ({ sendEvent: () => undefined }),
    getConfigService: () => ({
      getDataDir: () => process.cwd(),
      getStartupFlags: () => ({ 'allow-non-ga-tools': false, debug: false }),
    }),
  };
}
