import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ReleaseState,
  Toolset,
  type OrgService,
  type Services,
} from '@salesforce/mcp-provider-api';
import {
  CONTEXT_ERROR_CODES,
  ContextRuntimeError,
} from '../errors.js';
import {
  APEX_LOG_CATEGORY_FIELDS,
  MAX_STACK_FRAMES,
  VALIDATED_APEX_LOG_MAJOR_VERSIONS,
  parseApexLogHeader,
  parseStackFrame,
  splitExceptionText,
} from '../debug-log-parser.js';
import {
  DEBUG_LEVEL_FIELDS,
  DEBUG_LEVEL_TIER_NAMES,
  DEBUG_LEVEL_TIERS,
  DEBUG_LEVEL_TIER_PREFIX,
  DEBUG_LEVEL_VALUES,
  debugLevelCreatePayload,
  readDebugLevelLevels,
} from '../debug-levels.js';
import {
  apexLogsHint,
  debugLogBodyHint,
  traceFlagHint,
} from '../debug-log-hints.js';
import {
  DIAGNOSTIC_TOOLING_TYPES,
  assertDiagnosticQueryTargets,
  checkDiagnosticQueryTargets,
  extractDiagnosticQueryTargets,
  isAllowedDiagnosticQueryTarget,
} from '../diagnostic-tooling-types.js';
import {
  APEX_LOG_MAX_LIMIT,
  APEX_LOG_MAX_TIME_WINDOW_MINUTES,
  DEBUG_LOG_BODY_MAX_CHARACTERS,
  TRACE_FLAG_MAX_DURATION_MINUTES,
  apexLogsInputSchema,
  apexLogsOutputSchema,
  debugLogBodyInputSchema,
  debugLogBodyOutputSchema,
  traceFlagInputSchema,
  traceFlagOutputSchema,
  type MetadataContextInput,
  type TraceFlagOutput,
} from '../schemas.js';
import { contextExecutionErrorToolResult } from '../tool-results.js';
import {
  SFOA_CONTEXT_TOOL_NAMES,
  SFOA_CONTEXT_TOOL_ROLES,
  SfoaContextMcpProvider,
  type SfoaContextToolName,
} from '../provider.js';
import { GetApexLogsMcpTool } from '../tools/get-apex-logs.js';
import { GetDebugLogBodyMcpTool } from '../tools/get-debug-log-body.js';
import { SetTraceFlagMcpTool } from '../tools/set-trace-flag.js';
import type { ApexLogReader, DebugLogBodyReader, TraceFlagWriter } from '../contracts.js';

/**
 * T2's debug-log toolset, provider side.
 *
 * Everything the provider owns is pure — the schemas, the `DebugLevel` catalog, the log parser, the
 * hint builders and the `FROM`-target check — so none of it needs a Connection and all of it is
 * covered here. The identity guard, the byte budget and the Salesforce call shapes belong to the host
 * executors and are covered in `packages/sfoa-mcp-server/src/test/debug-log-context-executor.test.ts`.
 *
 * The tests are written against the *measured* facts the T2 revision note records, because each of
 * those is a trap a plausible implementation falls into: a create-only trace flag, a reused
 * `SFDC_DevConsole` level that samples profiling, a parser keyed on the org's API version, and a
 * `Status` filter that silently drops localized rows.
 */

// ---------------------------------------------------------------------------------------------
// Schemas: bounds, forged authority, and the strictness that keeps a failure shape exactly three keys
// ---------------------------------------------------------------------------------------------

test('the trace flag input bounds the window on both ends and refuses a duration outside it', () => {
  const valid = { tracedEntityKind: 'USER', tracedEntityId: '005000000000001AAA' } as const;
  assert.equal(traceFlagInputSchema.safeParse(valid).success, true);
  assert.equal(traceFlagInputSchema.safeParse({ ...valid, durationMinutes: 1 }).success, true);
  assert.equal(
    traceFlagInputSchema.safeParse({ ...valid, durationMinutes: TRACE_FLAG_MAX_DURATION_MINUTES }).success,
    true,
  );

  // A trace flag is a write with an operational cost on a live org, so the cap is enforced at the
  // schema rather than trusted to the caller. Over the cap and below the floor are both refusals.
  assert.equal(
    traceFlagInputSchema.safeParse({ ...valid, durationMinutes: TRACE_FLAG_MAX_DURATION_MINUTES + 1 }).success,
    false,
  );
  assert.equal(traceFlagInputSchema.safeParse({ ...valid, durationMinutes: 0 }).success, false);
  assert.equal(traceFlagInputSchema.safeParse({ ...valid, durationMinutes: -5 }).success, false);
  assert.equal(traceFlagInputSchema.safeParse({ ...valid, durationMinutes: 30.5 }).success, false);
});

test('the trace flag input refuses an entity kind outside the two measured LogTypes and a non-Id target', () => {
  // Only DEVELOPER_LOG and CLASS_TRACING were measured as creatable (probe §2), so only those two
  // entity kinds exist. An unmeasured LogType is not offered to a caller to discover at runtime.
  assert.equal(
    traceFlagInputSchema.safeParse({ tracedEntityKind: 'APEX_TRIGGER', tracedEntityId: '005000000000001AAA' }).success,
    false,
  );
  assert.equal(traceFlagInputSchema.safeParse({ tracedEntityKind: 'user', tracedEntityId: '005000000000001AAA' }).success, false);
  // A username or a class name is not an Id, and accepting one would put free text into the entity
  // field. What is *not* checked here is the Id's key prefix: the schema constrains the shape, and
  // whether an `01p` Id is a valid target for a `USER` flag is the platform's judgement, not this
  // layer's — a prefix table would also have to know that a trigger (`01q`) traces under
  // `CLASS_TRACING` alongside `ApexClass`.
  assert.equal(
    traceFlagInputSchema.safeParse({ tracedEntityKind: 'USER', tracedEntityId: 'user@example.test' }).success,
    false,
  );
  assert.equal(traceFlagInputSchema.safeParse({ tracedEntityKind: 'APEX_CLASS', tracedEntityId: 'MyClass' }).success, false);
  assert.equal(
    traceFlagInputSchema.safeParse({ tracedEntityKind: 'APEX_CLASS', tracedEntityId: '01p000000000001' }).success,
    true,
  );
});

test('the trace flag input accepts only the three tier names, and no identity of the caller\'s choosing', () => {
  const base = { tracedEntityKind: 'USER', tracedEntityId: '005000000000001AAA' } as const;
  for (const tier of DEBUG_LEVEL_TIER_NAMES) {
    assert.equal(traceFlagInputSchema.safeParse({ ...base, logLevel: tier }).success, true, tier);
  }
  // A raw eight-value level such as FINEST is not a tier: the ten fields move together, so a caller
  // picks a named column rather than one category at a time.
  assert.equal(traceFlagInputSchema.safeParse({ ...base, logLevel: 'FINEST' }).success, false);
  assert.equal(traceFlagInputSchema.safeParse({ ...base, logLevel: 'minimal' }).success, false);

  for (const forged of [
    { username: 'forged@example.test' },
    { usernameOrAlias: 'forged@example.test' },
    { diagnosticUsername: 'forged@example.test' },
    { connectionRole: 'DIAGNOSTIC' },
    { platformUserId: 'p2-user-a' },
    { targetUsername: 'forged@example.test' },
  ]) {
    assert.equal(traceFlagInputSchema.safeParse({ ...base, ...forged }).success, false, JSON.stringify(forged));
  }
});

test('the log listing input bounds the window and the limit, and keeps status an open string', () => {
  assert.equal(apexLogsInputSchema.safeParse({}).success, true);
  assert.equal(apexLogsInputSchema.safeParse({ timeWindowMinutes: 1 }).success, true);
  assert.equal(apexLogsInputSchema.safeParse({ timeWindowMinutes: APEX_LOG_MAX_TIME_WINDOW_MINUTES }).success, true);
  assert.equal(apexLogsInputSchema.safeParse({ timeWindowMinutes: 0 }).success, false);
  assert.equal(apexLogsInputSchema.safeParse({ timeWindowMinutes: APEX_LOG_MAX_TIME_WINDOW_MINUTES + 1 }).success, false);

  assert.equal(apexLogsInputSchema.safeParse({ limit: 1 }).success, true);
  assert.equal(apexLogsInputSchema.safeParse({ limit: APEX_LOG_MAX_LIMIT }).success, true);
  assert.equal(apexLogsInputSchema.safeParse({ limit: 0 }).success, false);
  assert.equal(apexLogsInputSchema.safeParse({ limit: APEX_LOG_MAX_LIMIT + 1 }).success, false);

  // The localized literal is exactly what has to be passable: `'Success'` is not what this org stores
  // for eight of nine rows (probe §1), so a closed English enum would be a filter that drops its own
  // matches. Any bounded non-empty string is accepted and the answer reports what it saw.
  assert.equal(apexLogsInputSchema.safeParse({ status: '成功' }).success, true);
  assert.equal(apexLogsInputSchema.safeParse({ status: 'Success' }).success, true);
  assert.equal(apexLogsInputSchema.safeParse({ status: '' }).success, false);
  assert.equal(apexLogsInputSchema.safeParse({ status: 'x'.repeat(65) }).success, false);

  assert.equal(apexLogsInputSchema.safeParse({ userId: '005000000000001AAA' }).success, true);
  assert.equal(apexLogsInputSchema.safeParse({ userId: 'user@example.test' }).success, false);
  assert.equal(apexLogsInputSchema.safeParse({ userId: '005000000000001AAA', useToolingApi: false }).success, false);
});

test('the log body input bounds maxCharacters on both ends and requires a log Id', () => {
  assert.equal(debugLogBodyInputSchema.safeParse({ logId: '07L000000000001AAA' }).success, true);
  assert.equal(debugLogBodyInputSchema.safeParse({ logId: '07L000000000001AAA', maxCharacters: 1_000 }).success, true);
  assert.equal(
    debugLogBodyInputSchema.safeParse({ logId: '07L000000000001AAA', maxCharacters: DEBUG_LOG_BODY_MAX_CHARACTERS }).success,
    true,
  );
  assert.equal(debugLogBodyInputSchema.safeParse({ logId: '07L000000000001AAA', maxCharacters: 999 }).success, false);
  assert.equal(
    debugLogBodyInputSchema.safeParse({ logId: '07L000000000001AAA', maxCharacters: DEBUG_LOG_BODY_MAX_CHARACTERS + 1 }).success,
    false,
  );
  assert.equal(debugLogBodyInputSchema.safeParse({}).success, false);
  assert.equal(debugLogBodyInputSchema.safeParse({ logId: 'not-an-id' }).success, false);
  assert.equal(debugLogBodyInputSchema.safeParse({ logId: '07L000000000001AAA', body: 'x' }).success, false);
});

test('all three output schemas are strict, so a failure answer is exactly the three shared keys when it has no extras', () => {
  assert.equal(traceFlagOutputSchema.safeParse({ success: false, errorCode: 'MCP_TRACE_FLAG_INVALID', message: 'no' }).success, true);
  assert.equal(apexLogsOutputSchema.safeParse({ success: false, errorCode: 'MCP_APEX_LOG_READ_FAILED', message: 'no' }).success, true);
  assert.equal(debugLogBodyOutputSchema.safeParse({ success: false, errorCode: 'MCP_DEBUG_LOG_BODY_READ_FAILED', message: 'no' }).success, true);

  // `.strict()` is what makes the shared failure shape a guarantee rather than a convention: a Tool
  // that leaked an extra key would fail its own output schema instead of shipping it.
  for (const schema of [traceFlagOutputSchema, apexLogsOutputSchema, debugLogBodyOutputSchema]) {
    assert.equal(schema.safeParse({ success: false, errorCode: 'X', message: 'm', notAField: 1 }).success, false);
  }

  // The extra keys ADR-0029 §3 needs are declared on the debug-log schemas only, and the output
  // schema accepts them when a raiser set them.
  assert.equal(debugLogBodyOutputSchema.safeParse({
    success: false,
    errorCode: 'MCP_DIAGNOSTIC_PREREQUISITE_MISSING',
    message: 'no',
    prerequisite: 'A-2',
    suggestion: 're-trace',
    salesforceErrorCode: 'NOT_FOUND',
  }).success, true);
  assert.equal(apexLogsOutputSchema.safeParse({
    success: false, errorCode: 'MCP_DIAGNOSTIC_PREREQUISITE_MISSING', message: 'no', prerequisite: 'A-1',
  }).success, true);
});

test('the tool error surface turns a prerequisite error into the four keys the caller needs, and nothing else', () => {
  const result = contextExecutionErrorToolResult(
    new ContextRuntimeError('MCP_DIAGNOSTIC_PREREQUISITE_MISSING', 'refused', {
      prerequisite: 'A-1',
      salesforceErrorCode: 'INSUFFICIENT_ACCESS',
      suggestion: 'grant log visibility',
    }),
    'MCP_APEX_LOG_READ_FAILED',
  );

  assert.equal(result.isError, true);
  assert.deepEqual(
    Object.keys(result.structuredContent as object).sort(),
    ['errorCode', 'message', 'prerequisite', 'salesforceErrorCode', 'suggestion', 'success'].sort(),
  );
  assert.equal((result.structuredContent as Record<string, unknown>).prerequisite, 'A-1');

  // A normal context error still renders as exactly the three shared keys, which is what keeps the
  // older Tools' answers byte-identical.
  const plain = contextExecutionErrorToolResult(new ContextRuntimeError('MCP_TRACE_FLAG_INVALID', 'bad'), 'MCP_TRACE_FLAG_WRITE_FAILED');
  assert.deepEqual(Object.keys(plain.structuredContent as object).sort(), ['errorCode', 'message', 'success']);
});

test('the new error codes are part of the declared vocabulary', () => {
  for (const code of [
    'MCP_DIAGNOSTIC_PREREQUISITE_MISSING',
    'MCP_DIAGNOSTIC_QUERY_OBJECT_NOT_ALLOWED',
    'MCP_TRACE_FLAG_INVALID',
    'MCP_TRACE_FLAG_WRITE_FAILED',
    'MCP_APEX_LOG_INVALID',
    'MCP_APEX_LOG_READ_FAILED',
    'MCP_DEBUG_LOG_BODY_INVALID',
    'MCP_DEBUG_LOG_BODY_READ_FAILED',
    'MCP_DEBUG_LOG_BODY_NOT_FOUND',
  ]) {
    assert.ok(CONTEXT_ERROR_CODES.includes(code as (typeof CONTEXT_ERROR_CODES)[number]), code);
  }
});

// ---------------------------------------------------------------------------------------------
// The DebugLevel catalog: ten fields, three tiers, and the measured reason for resolve-or-create
// ---------------------------------------------------------------------------------------------

test('every tier states all ten DebugLevel fields, under the prefix this Tool alone owns', () => {
  assert.equal(DEBUG_LEVEL_FIELDS.length, 10);
  for (const name of DEBUG_LEVEL_TIER_NAMES) {
    const tier = DEBUG_LEVEL_TIERS[name];
    assert.deepEqual(Object.keys(tier.levels), [...DEBUG_LEVEL_FIELDS], name);
    assert.ok(tier.developerName.startsWith(DEBUG_LEVEL_TIER_PREFIX), name);
    assert.ok(tier.masterLabel.length > 0);
    assert.ok(tier.purpose.length > 0);
    for (const field of DEBUG_LEVEL_FIELDS) {
      assert.ok(DEBUG_LEVEL_VALUES.includes(tier.levels[field]), `${name}.${field}`);
    }
  }
  // Distinct developer names, or two tiers would converge on one row and the second call would
  // silently retarget the first tier's level.
  const names = DEBUG_LEVEL_TIER_NAMES.map((name) => DEBUG_LEVEL_TIERS[name].developerName);
  assert.equal(new Set(names).size, names.length);
});

test('PROFILING captures profiling in full, which the org\'s only stored level does not', () => {
  // The measured reason the tier exists (probe §2/§3): `SFDC_DevConsole` stores `ApexProfiling: INFO`,
  // the sampling level. A tier that also said INFO would make "full profiling" unreachable.
  assert.equal(DEBUG_LEVEL_TIERS.PROFILING.levels.ApexProfiling, 'FINEST');
  assert.equal(DEBUG_LEVEL_TIERS.DEBUG.levels.ApexProfiling, 'NONE');
  assert.equal(DEBUG_LEVEL_TIERS.MINIMAL.levels.ApexProfiling, 'NONE');
  // MINIMAL is the tier the truncation hint recommends, so it has to be strictly cheaper than DEBUG.
  assert.equal(DEBUG_LEVEL_TIERS.MINIMAL.levels.ApexCode, 'INFO');
  assert.equal(DEBUG_LEVEL_TIERS.DEBUG.levels.ApexCode, 'DEBUG');
});

test('the create payload sends only fields the probe proved creatable, and sends each tier\'s own levels', () => {
  // Seven fields, measured (probe §2). An unset DebugLevel field defaults to NONE, so omitting the
  // NONE fields is equivalent — and it is what keeps every payload a *subset* of the exercised
  // surface. The tiers do not all set the same number of fields (MINIMAL 3, DEBUG 6, PROFILING 7),
  // so the invariant worth asserting is the subset, not a shared size.
  const measured = ['ApexCode', 'ApexProfiling', 'Callout', 'Database', 'System', 'Validation', 'Workflow'];
  for (const name of DEBUG_LEVEL_TIER_NAMES) {
    const tier = DEBUG_LEVEL_TIERS[name];
    const payload = debugLevelCreatePayload(tier);
    const setFields = DEBUG_LEVEL_FIELDS.filter((field) => tier.levels[field] !== 'NONE');
    assert.deepEqual(Object.keys(payload).sort(), ['DeveloperName', 'MasterLabel', ...setFields].sort(), name);
    assert.equal(payload.DeveloperName, tier.developerName);
    for (const field of setFields) assert.equal(payload[field], tier.levels[field]);
    for (const field of DEBUG_LEVEL_FIELDS) {
      if (tier.levels[field] === 'NONE') assert.equal(field in payload, false, `${name}.${field} must be omitted`);
    }
    // The three fields the probe never exercised are NONE in every tier, which is what makes the
    // subset claim hold for all three rather than only for the tier that was measured.
    assert.deepEqual(Object.keys(payload).filter((field) => !measured.includes(field)).sort(),
      ['DeveloperName', 'MasterLabel'].sort(), name);
  }
  // MINIMAL is the tier the truncation hint recommends, so it has to actually be the smallest one.
  assert.equal(nonNoneFieldCount('MINIMAL'), 3);
  assert.ok(nonNoneFieldCount('MINIMAL') < nonNoneFieldCount('DEBUG'));
  assert.ok(nonNoneFieldCount('DEBUG') <= nonNoneFieldCount('PROFILING'));
});

function nonNoneFieldCount(name: (typeof DEBUG_LEVEL_TIER_NAMES)[number]): number {
  return DEBUG_LEVEL_FIELDS.filter((field) => DEBUG_LEVEL_TIERS[name].levels[field] !== 'NONE').length;
}

test('a stored level is reported as stored: a field the org did not report reads NONE, never as the tier', () => {
  const levels = readDebugLevelLevels({ ApexCode: 'FINEST', ApexProfiling: 'INFO', System: 'NOT_A_LEVEL' });
  assert.equal(levels.ApexCode, 'FINEST');
  assert.equal(levels.ApexProfiling, 'INFO');
  // An unreadable value is reported as NONE rather than passed through: the reader has to be able to
  // trust that a value shown here is one the sObject actually stores.
  assert.equal(levels.System, 'NONE');
  assert.equal(levels.Wave, 'NONE');
  assert.deepEqual(Object.keys(levels), [...DEBUG_LEVEL_FIELDS]);
  // A missing record reads as all-NONE rather than throwing.
  assert.deepEqual(readDebugLevelLevels(undefined), readDebugLevelLevels({}));
});

test('the ten level fields are written out in the trace flag output schema, so dropping one is a contract failure', () => {
  const base = traceFlagSuccessOutput({ debugLevelLevels: undefined });
  for (const field of DEBUG_LEVEL_FIELDS) {
    const levels = Object.fromEntries(DEBUG_LEVEL_FIELDS.map((name) => [name, 'NONE']));
    assert.equal(traceFlagOutputSchema.safeParse({ ...base, debugLevelLevels: levels }).success, true, field);
    // Dropping the field, and adding one the sObject does not have, are both refusals.
    delete levels[field];
    assert.equal(traceFlagOutputSchema.safeParse({ ...base, debugLevelLevels: levels }).success, false, `${field} dropped`);
  }
  const full = Object.fromEntries(DEBUG_LEVEL_FIELDS.map((name) => [name, 'NONE']));
  assert.equal(
    traceFlagOutputSchema.safeParse({ ...base, debugLevelLevels: { ...full, NotAField: 'NONE' } }).success,
    false,
  );
});

// ---------------------------------------------------------------------------------------------
// The log parser: dispatched on the log's own header version, and honest about what it cannot say
// ---------------------------------------------------------------------------------------------

test('a log header is read for its own version, and the DB token is mapped to the sObject field name', () => {
  const summary = parseApexLogHeader(FAILING_LOG);

  assert.equal(summary.parseStatus, 'PARSED');
  // The version comes from the log, never from the org: the probe's v68.0 org wrote 56.0 and 54.0 logs.
  assert.equal(summary.logApiVersion, '56.0');
  assert.equal(summary.logApiVersionMajor, 56);
  assert.equal(summary.validated, true);

  assert.deepEqual(summary.categories.find((entry) => entry.token === 'DB'), {
    token: 'DB', level: 'INFO', field: 'Database',
  });
  assert.deepEqual(summary.categories.find((entry) => entry.token === 'APEX_CODE'), {
    token: 'APEX_CODE', level: 'FINEST', field: 'ApexCode',
  });

  assert.equal(summary.exceptionType, 'System.NullPointerException');
  assert.equal(summary.exceptionMessage, 'Attempt to de-reference a null object');
  // The located failure — the whole reason this Tool exists.
  assert.equal(summary.apexClass, 'MyClass');
  assert.equal(summary.lineNumber, 12);
  assert.equal(summary.columnNumber, 1);
  assert.equal(summary.stackSummary.length, 2);
  assert.equal(summary.stackSummary[1]?.apexClass, 'MyTrigger');
  assert.equal(summary.stackSummary[1]?.method, null);
  assert.equal(summary.userDebugLineCount, 1);
  assert.equal(summary.executionFinished, true);
});

test('a log version outside the measured set is parsed but flagged, never silently trusted', () => {
  assert.deepEqual([...VALIDATED_APEX_LOG_MAJOR_VERSIONS], [54, 56]);

  const unmeasured = parseApexLogHeader(FAILING_LOG.replace('56.0 ', '99.0 '));
  assert.equal(unmeasured.parseStatus, 'PARSED');
  assert.equal(unmeasured.logApiVersionMajor, 99);
  assert.equal(unmeasured.validated, false);
  // Still parsed, because the event grammar has been stable and discarding readable evidence would be
  // the worse failure — the flag is what stops the summary from claiming more than it knows.
  assert.equal(unmeasured.apexClass, 'MyClass');

  assert.equal(parseApexLogHeader(FAILING_LOG.replace('56.0 ', '54.0 ')).validated, true);
});

test('a body that is not a debug log says so instead of being summarised', () => {
  for (const notALog of [
    '{"errorCode":"NOT_FOUND","message":"no such log"}',
    '<html><body>Login</body></html>',
    '',
    // A version with no category list is not the shape a debug log has, so it is not treated as one.
    '56.0 ',
    '56.0',
  ]) {
    const summary = parseApexLogHeader(notALog);
    assert.equal(summary.parseStatus, 'NOT_A_LOG', JSON.stringify(notALog));
    assert.equal(summary.logApiVersion, null);
    assert.equal(summary.apexClass, null);
    assert.deepEqual(summary.categories, []);
    assert.deepEqual(summary.stackSummary, []);
  }
});

test('an unknown category token is kept with a null field, because it marks a version worth looking at', () => {
  const summary = parseApexLogHeader('56.0 APEX_CODE,DEBUG;SOMETHING_NEW,INFO');
  assert.equal(summary.parseStatus, 'PARSED');
  assert.deepEqual(summary.categories[1], { token: 'SOMETHING_NEW', level: 'INFO', field: null });
});

test('the fatal error names the exception; a handled throw does not become the failure', () => {
  const handledOnly = parseApexLogHeader([
    '56.0 APEX_CODE,DEBUG',
    '00:00:00.0 (1)|EXECUTION_STARTED',
    '00:00:00.1 (2)|EXCEPTION_THROWN|[10]|System.DmlException: Insert failed. First exception on row 0',
    '00:00:00.2 (3)|EXECUTION_FINISHED',
  ].join('\n'));
  assert.equal(handledOnly.fatalError, null);
  assert.equal(handledOnly.exceptionType, 'System.DmlException');
  assert.equal(handledOnly.thrownExceptions.length, 1);
  // A log that only threw handled exceptions completed; reporting one as the failure would point a
  // reader at a caught error.
  assert.equal(handledOnly.executionFinished, true);

  const both = parseApexLogHeader([
    '56.0 APEX_CODE,DEBUG',
    '00:00:00.0 (1)|EXCEPTION_THROWN|[10]|System.DmlException: handled',
    '00:00:00.1 (2)|FATAL_ERROR|System.NullPointerException: the real one',
  ].join('\n'));
  assert.equal(both.exceptionType, 'System.NullPointerException');
  assert.equal(both.thrownExceptions.length, 1);
});

test('the exception type and message split on the first colon, so a DmlException message survives whole', () => {
  assert.deepEqual(splitExceptionText('System.NullPointerException: Attempt to de-reference a null object'), {
    type: 'System.NullPointerException', message: 'Attempt to de-reference a null object',
  });
  const dml = splitExceptionText('System.DmlException: Insert failed. First exception on row 0; first error: REQUIRED_FIELD_MISSING, Required fields are missing: [Name]');
  assert.equal(dml.type, 'System.DmlException');
  assert.equal(dml.message, 'Insert failed. First exception on row 0; first error: REQUIRED_FIELD_MISSING, Required fields are missing: [Name]');
  assert.deepEqual(splitExceptionText('   '), { type: null, message: null });
  assert.deepEqual(splitExceptionText('no colon here'), { type: null, message: 'no colon here' });
});

test('the stack summary is bounded without the count being rewritten', () => {
  const frames = Array.from({ length: MAX_STACK_FRAMES + 5 }, (_, index) => `Class.MyClass.frame${index}: line ${index + 1}, column 1`);
  const summary = parseApexLogHeader([
    '56.0 APEX_CODE,DEBUG',
    '00:00:00.1 (2)|FATAL_ERROR|System.NullPointerException: boom',
    ...frames,
  ].join('\n'));

  assert.equal(summary.stackSummary.length, MAX_STACK_FRAMES);
  assert.equal(summary.apexClass, 'MyClass');
  assert.equal(summary.lineNumber, 1);
});

test('the three stack-frame shapes Salesforce writes are one shape once the qualifier is dropped', () => {
  assert.deepEqual(parseStackFrame('Class.MyClass.myMethod: line 4, column 9'), {
    apexClass: 'MyClass', method: 'myMethod', lineNumber: 4, columnNumber: 9,
    raw: 'Class.MyClass.myMethod: line 4, column 9',
  });
  assert.deepEqual(parseStackFrame('MyClass.myMethod: line 4, column 9'), {
    apexClass: 'MyClass', method: 'myMethod', lineNumber: 4, columnNumber: 9,
    raw: 'MyClass.myMethod: line 4, column 9',
  });
  assert.deepEqual(parseStackFrame('Trigger.MyTrigger: line 7, column 2'), {
    apexClass: 'MyTrigger', method: null, lineNumber: 7, columnNumber: 2,
    raw: 'Trigger.MyTrigger: line 7, column 2',
  });
  assert.equal(parseStackFrame('00:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|x'), null);
  assert.equal(parseStackFrame('   '), null);
});

test('the parser\'s category tokens map onto real DebugLevel fields, one per field', () => {
  // The bijection is what makes a parsed log's categories comparable with the level that was
  // requested; a token mapped to a field that does not exist would silently never match.
  const mapped = Object.values(APEX_LOG_CATEGORY_FIELDS);
  assert.equal(new Set(mapped).size, mapped.length);
  assert.deepEqual([...mapped].sort(), [...DEBUG_LEVEL_FIELDS].sort());
  for (const field of mapped) assert.ok(DEBUG_LEVEL_FIELDS.includes(field));
});

// ---------------------------------------------------------------------------------------------
// Hints: the chain GAP-M1 rests on, and the rule that none may name an unadvertised Tool
// ---------------------------------------------------------------------------------------------

/** Every Tool name any hint in this module can mention. */
const HINTABLE_TOOLS = ['get_apex_logs', 'get_debug_log_body', 'set_trace_flag', 'run_diagnostic_tooling_query'] as const;

function subsets<T>(values: readonly T[]): readonly (readonly T[])[] {
  return values.reduce<readonly (readonly T[])[]>(
    (accumulated, value) => [...accumulated, ...accumulated.map((set) => [...set, value])],
    [[]],
  );
}

/** Every hint this module can produce, for one advertised set. */
function allHints(advertised: ReadonlySet<string>): readonly string[] {
  const hints: string[] = [traceFlagHint(advertised)];
  for (const budgetDropped of [false, true]) {
    for (const returnedCount of [0, 3]) {
      for (const statusFilterApplied of [false, true]) {
        for (const observedStatuses of [[], ['成功']] as const) {
          for (const totalCount of returnedCount === 0 ? [0, null] : [12, null]) {
            hints.push(apexLogsHint(advertised, {
              returnedCount,
              totalCount,
              statusFilterApplied,
              observedStatuses,
              budgetDropped,
            }));
          }
        }
      }
    }
  }
  for (const truncated of [false, true]) {
    for (const facts of [
      { parseStatus: 'PARSED' as const, apexClass: 'MyClass', lineNumber: 12 },
      { parseStatus: 'PARSED' as const, apexClass: 'MyClass', lineNumber: null },
      { parseStatus: 'NOT_A_LOG' as const, apexClass: null, lineNumber: null },
      { parseStatus: 'PARSED' as const, apexClass: null, lineNumber: null },
    ]) {
      hints.push(debugLogBodyHint(advertised, { truncated, maxCharacters: 60_000, ...facts }));
    }
  }
  return hints;
}

test('no hint ever names a Tool the session does not advertise — over every advertised combination', () => {
  let checked = 0;
  for (const advertised of subsets(HINTABLE_TOOLS)) {
    const set = new Set<string>(advertised);
    for (const hint of allHints(set)) {
      checked += 1;
      assert.ok(hint.length > 0);
      for (const name of HINTABLE_TOOLS) {
        if (!hint.includes(name)) continue;
        assert.ok(set.has(name), `hint named ${name} while advertising [${advertised.join(', ')}]: ${hint}`);
      }
    }
  }
  // A guard on the guard. The sweep only means something if it actually walked the combinations
  // (`checked`) and if the shapes it walked were not near-duplicates of one another — the second
  // number is why the facts above vary `totalCount`, the observed vocabulary and the stack frame
  // rather than only the booleans, since a sweep of 39 identical strings would pass just as quietly.
  const perSetHints = allHints(new Set());
  const perSet = perSetHints.length;
  assert.ok(perSet >= 35, `only ${perSet} hint shapes per advertised set`);
  assert.ok(new Set(perSetHints).size >= 12, `only ${new Set(perSetHints).size} distinct hint texts per advertised set`);
  assert.equal(checked, (2 ** HINTABLE_TOOLS.length) * perSet);
});

test('a hint names the next step when it is available and degrades to an actionable sentence when it is not', () => {
  assert.match(traceFlagHint(new Set(['get_apex_logs'])), /call get_apex_logs with a timeWindowMinutes/u);
  const noListing = traceFlagHint(new Set());
  assert.doesNotMatch(noListing, /get_apex_logs/u);
  // The fallback still says what to do, so a deployment with the listing disabled is not a dead end.
  assert.match(noListing, /Reproduce the problem now/u);
  assert.match(noListing, /retention/u);

  assert.match(
    apexLogsHint(new Set(['get_debug_log_body']), {
      returnedCount: 2, totalCount: 9, statusFilterApplied: false, observedStatuses: ['成功'], budgetDropped: false,
    }),
    /Call get_debug_log_body with one of the ids above/u,
  );
  assert.match(
    apexLogsHint(new Set(), {
      returnedCount: 2, totalCount: 9, statusFilterApplied: false, observedStatuses: ['成功'], budgetDropped: false,
    }),
    /fetched separately, by log id/u,
  );

  assert.match(
    debugLogBodyHint(new Set(['run_diagnostic_tooling_query']), {
      truncated: false, maxCharacters: 60_000, parseStatus: 'PARSED', apexClass: 'MyClass', lineNumber: 12,
    }),
    /Call run_diagnostic_tooling_query with/u,
  );
  const noQuery = debugLogBodyHint(new Set(), {
    truncated: false, maxCharacters: 60_000, parseStatus: 'PARSED', apexClass: 'MyClass', lineNumber: 12,
  });
  assert.doesNotMatch(noQuery, /run_diagnostic_tooling_query/u);
  assert.match(noQuery, /MyClass line 12/u);
});

test('an empty log list is never a bare zero, and a status-filtered empty list says something else again', () => {
  // The single most mis-readable answer these Tools produce: "no rows" read as "nothing went wrong".
  const empty = apexLogsHint(new Set(), {
    returnedCount: 0, totalCount: 0, statusFilterApplied: false, observedStatuses: [], budgetDropped: false,
  });
  assert.match(empty, /not a statement about whether the request succeeded/u);
  assert.match(empty, /trace must be open/u);
  assert.match(empty, /retention is short/u);

  // A filtered empty list is not the same finding: the filter is matched against values this org may
  // have localized, so the answer names what the scanned rows actually carry.
  const filtered = apexLogsHint(new Set(), {
    returnedCount: 0, totalCount: 8, statusFilterApplied: true, observedStatuses: ['成功'], budgetDropped: false,
  });
  assert.match(filtered, /not the same as no matching execution/u);
  assert.match(filtered, /the scanned rows carry '成功'/u);
  assert.match(filtered, /Re-run without the status filter/u);

  const filteredUnreadable = apexLogsHint(new Set(), {
    returnedCount: 0, totalCount: 0, statusFilterApplied: true, observedStatuses: [], budgetDropped: false,
  });
  assert.match(filteredUnreadable, /no Status value at all could be read/u);
});

test('a budget-dropped list is an incomplete-by-size answer, and never the empty-window answer', () => {
  // `trimToByteBudget` removes whole items, so a list can come back short of its own limit or, in the
  // worst case, with nothing on the page at all. Reporting the latter as "no log was found" would be
  // the silent-empty failure the T2 prohibitions forbid.
  const droppedWithRows = apexLogsHint(new Set(), {
    returnedCount: 4, totalCount: 9, statusFilterApplied: false, observedStatuses: ['成功'], budgetDropped: true,
  });
  assert.match(droppedWithRows, /incomplete by size rather than by count/u);
  assert.match(droppedWithRows, /smaller limit or a narrower timeWindowMinutes/u);
  assert.doesNotMatch(droppedWithRows, /No log was found in this window/u);

  const droppedToNothing = apexLogsHint(new Set(), {
    returnedCount: 0, totalCount: 9, statusFilterApplied: false, observedStatuses: ['成功'], budgetDropped: true,
  });
  assert.match(droppedToNothing, /no row at all fitted, which is a size problem and not an empty window/u);
  assert.doesNotMatch(droppedToNothing, /No log was found in this window/u);
});

test('a truncated body points at a re-trace with a named tier when the writer is available', () => {
  const withWriter = debugLogBodyHint(new Set(['set_trace_flag']), {
    truncated: true, maxCharacters: 60_000, parseStatus: 'PARSED', apexClass: 'MyClass', lineNumber: 12,
  });
  assert.match(withWriter, /set_trace_flag at logLevel MINIMAL/u);
  // The end of the log is where the exception is written, which is exactly what the cut removes.
  assert.match(withWriter, /exception is written/u);

  const withoutWriter = debugLogBodyHint(new Set(), {
    truncated: true, maxCharacters: 60_000, parseStatus: 'PARSED', apexClass: 'MyClass', lineNumber: 12,
  });
  assert.doesNotMatch(withoutWriter, /set_trace_flag/u);
  assert.match(withoutWriter, /reduce the log level the trace is opened at/u);
});

// ---------------------------------------------------------------------------------------------
// ADR-0029 §4b: the FROM-target check on run_diagnostic_tooling_query
// ---------------------------------------------------------------------------------------------

test('the query target check refuses every business object the probe measured, and the allowlist holds none', () => {
  for (const target of ['Lead', 'Account', 'Value_Bill__c', 'Order__c', 'Contact', 'Case', 'Opportunity']) {
    assert.equal(isAllowedDiagnosticQueryTarget(target), false, target);
    const rejection = checkDiagnosticQueryTargets(`SELECT Id FROM ${target} LIMIT 1`);
    assert.ok(rejection !== null, target);
    assert.equal(rejection.target, target);
    assert.match(rejection.message, /not in the allowlist/u);
  }
  // The five measured Setup types are the ones the diagnostic workflow itself needs.
  for (const target of ['ApexClass', 'ApexLog', 'TraceFlag', 'DebugLevel', 'ValidationRule']) {
    assert.equal(isAllowedDiagnosticQueryTarget(target), true, target);
    assert.equal(checkDiagnosticQueryTargets(`SELECT Id FROM ${target}`), null, target);
  }
});

test('the target check is case-insensitive, deduplicating, and reads a subquery as well as the top level', () => {
  assert.equal(checkDiagnosticQueryTargets('SELECT Id FROM apexclass'), null);
  assert.deepEqual(
    [...extractDiagnosticQueryTargets('SELECT Id FROM ApexClass WHERE Id IN (SELECT ApexClassId FROM ApexTestResult)')],
    ['ApexClass', 'ApexTestResult'],
  );
  assert.deepEqual([...extractDiagnosticQueryTargets('SELECT Id FROM ApexClass WHERE Id IN (SELECT Id FROM ApexClass)')],
    ['ApexClass']);
  // A subquery naming a business object is refused even though the outer target is allowed.
  const nested = checkDiagnosticQueryTargets('SELECT Id FROM ApexClass WHERE Id IN (SELECT Id FROM Lead)');
  assert.equal(nested?.target, 'Lead');
});

test('the word FROM inside a string literal is not a target, so a legitimate filter is not refused', () => {
  // The one subtle step: a literal can contain the keyword, and stripping literals can only lose a
  // false target — a real FROM is outside every literal by construction.
  assert.deepEqual([...extractDiagnosticQueryTargets("SELECT Id FROM ApexClass WHERE Operation = 'FROM Lead'")], ['ApexClass']);
  assert.equal(checkDiagnosticQueryTargets("SELECT Id FROM ApexLog WHERE Operation = 'FROM Lead'"), null);
  // An escaped quote inside the literal does not end it early.
  assert.equal(checkDiagnosticQueryTargets("SELECT Id FROM ApexLog WHERE Operation = 'it\\'s FROM Lead'"), null);
});

test('a USING clause and an unreadable statement are both refused rather than passed through', () => {
  const using = checkDiagnosticQueryTargets('SELECT Id FROM ApexClass USING SCOPE mine');
  assert.equal(using?.target, 'USING');
  assert.match(using?.message ?? '', /does not accept a USING clause/u);

  // This check reads targets, not statement kinds — the SELECT-only gate is the input schema's job —
  // so the case it has to refuse by itself is a statement whose target cannot be read at all.
  const unreadable = checkDiagnosticQueryTargets('SELECT 1');
  assert.equal(unreadable?.target, '(none)');
  assert.match(unreadable?.suggestion ?? '', /explicit `SELECT … FROM <Type>` source/u);
  assert.equal(checkDiagnosticQueryTargets('')?.target, '(none)');
});

test('the check throws the structured refusal the Tool reports, with the remedy rather than a dead end', () => {
  assert.throws(
    () => assertDiagnosticQueryTargets('SELECT Id FROM Lead'),
    (error: unknown) => {
      assert.ok(error instanceof ContextRuntimeError);
      assert.equal(error.code, 'MCP_DIAGNOSTIC_QUERY_OBJECT_NOT_ALLOWED');
      assert.match(error.message, /Lead is not in the allowlist/u);
      assert.match(error.suggestion ?? '', /business records are deliberately\s+unreachable/u);
      return true;
    },
  );
  assert.doesNotThrow(() => assertDiagnosticQueryTargets('SELECT Id FROM ApexClass'));
});

test('every allowlisted diagnostic type is a Setup-layer name, and no business object is hiding in the list', () => {
  assert.ok(DIAGNOSTIC_TOOLING_TYPES.length >= 20);
  // SObject API names are one word; a name with a space or a label-shaped string would be a mistake
  // that matched nothing at runtime.
  for (const target of DIAGNOSTIC_TOOLING_TYPES) {
    assert.match(target, /^[A-Za-z][A-Za-z0-9_]*$/u, target);
    assert.equal(isAllowedDiagnosticQueryTarget(target), true, target);
  }
  assert.equal(DIAGNOSTIC_TOOLING_TYPES.includes('Account'), false);
  assert.equal(DIAGNOSTIC_TOOLING_TYPES.includes('Lead'), false);
});

// ---------------------------------------------------------------------------------------------
// The three Tools' own contracts, and the Provider that builds them
// ---------------------------------------------------------------------------------------------

test('the three Tools are GA, on the DATA toolset, and each says which role it runs on', () => {
  const tools = [
    new SetTraceFlagMcpTool(stubTraceFlagWriter()),
    new GetApexLogsMcpTool(stubApexLogReader()),
    new GetDebugLogBodyMcpTool(stubDebugLogBodyReader()),
  ];
  assert.deepEqual(tools.map((tool) => tool.getName()), ['set_trace_flag', 'get_apex_logs', 'get_debug_log_body']);
  assert.deepEqual(tools.map((tool) => tool.getReleaseState()), [ReleaseState.GA, ReleaseState.GA, ReleaseState.GA]);
  for (const tool of tools) {
    assert.deepEqual(tool.getToolsets(), [Toolset.DATA]);
    assert.match(tool.getConfig().description ?? '', /server-owned DIAGNOSTIC identity/u);
    assert.ok(tool.getConfig().outputSchema);
  }
});

test('set_trace_flag is the one Tool that does not claim to be read-only, and it says why', () => {
  const config = new SetTraceFlagMcpTool(stubTraceFlagWriter()).getConfig();
  assert.deepEqual(config.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    // Not idempotent: a second call moves the expiration forward.
    idempotentHint: false,
    openWorldHint: true,
  });
  const description = config.description ?? '';
  assert.match(description, /This Tool WRITES/u);
  // The write surface is stated, because a caller has to be able to check the claim. The two objects
  // named here are the only two the probe measured this Tool touching.
  assert.match(description, /TraceFlag and may create a DebugLevel/u);
  assert.match(description, /no business record is readable or writable/u);
  assert.match(description, /never deletes a flag/u);
  // And the operational rules that a caller depends on rather than discovers.
  assert.match(description, /never shortened/u);
  assert.match(description, /extended rather than duplicated/u);

  for (const tool of [new GetApexLogsMcpTool(stubApexLogReader()), new GetDebugLogBodyMcpTool(stubDebugLogBodyReader())]) {
    assert.deepEqual(tool.getConfig().annotations, {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    });
  }
});

test('the log Tools state the traps rather than leaving them to be discovered', () => {
  const listing = new GetApexLogsMcpTool(stubApexLogReader()).getConfig().description ?? '';
  assert.match(listing, /may be localized/u);
  assert.match(listing, /observedStatuses/u);
  // An empty list is the mis-read answer, so the description says what it means before it is returned.
  assert.match(listing, /NOT the same as the target being/u);
  assert.match(listing, /Read-only/u);

  const body = new GetDebugLogBodyMcpTool(stubDebugLogBodyReader()).getConfig().description ?? '';
  assert.match(body, /header/u);
  assert.match(body, /truncated/u);
});

test('the Tool input schemas expose no field a caller could use to choose an identity or a surface', () => {
  const forbidden = ['platformUserId', 'connectionRole', 'diagnosticUsername', 'username', 'usernameOrAlias',
    'targetUsername', 'salesforceUsername', 'credentialProfile', 'accessToken', 'instanceUrl', 'useToolingApi',
    'directory', 'sourceDir', 'manifest', 'outputPath', 'arbitraryRestUrl'];
  const configs = [
    new SetTraceFlagMcpTool(stubTraceFlagWriter()).getConfig(),
    new GetApexLogsMcpTool(stubApexLogReader()).getConfig(),
    new GetDebugLogBodyMcpTool(stubDebugLogBodyReader()).getConfig(),
  ];
  assert.deepEqual(Object.keys(configs[0]?.inputSchema ?? {}),
    ['tracedEntityKind', 'tracedEntityId', 'durationMinutes', 'logLevel']);
  assert.deepEqual(Object.keys(configs[1]?.inputSchema ?? {}),
    ['timeWindowMinutes', 'userId', 'status', 'limit']);
  assert.deepEqual(Object.keys(configs[2]?.inputSchema ?? {}), ['logId', 'maxCharacters']);
  for (const config of configs) {
    assert.deepEqual(Object.keys(config.inputSchema ?? {}).filter((name) => forbidden.includes(name)), []);
  }
});

test('the Provider exposes every context Tool in the role map\'s own order, and the roles are total', async () => {
  const provider = new SfoaContextMcpProvider({
    diagnosticQueryExecutor: { execute: async () => ({ records: [], totalSize: 0, returnedRecords: 0, done: true, truncated: false }) },
    metadataListExecutor: {
      execute: async (input) => ({
        success: true, executionRole: 'DIAGNOSTIC', metadataType: input.metadataType, components: [],
        totalCount: 0, returnedCount: 0, truncated: false, includeInactive: input.includeInactive === true,
        hint: 'no components',
      }),
    },
    metadataContextExecutor: {
      execute: async (input) => ({
        success: true, executionRole: 'DIAGNOSTIC', metadataType: input.metadataType, fullName: input.fullName,
        files: [], omittedFiles: [], totalFiles: 0, returnedFiles: 0, totalBytes: 0, returnedBytes: 0,
        truncated: false,
        limits: { maxReturnedFiles: 40, maxFileBytes: 65_536, maxTotalBytes: 262_144, maxFileSummaries: 100 },
      }),
    },
    orgLimitsExecutor: stubOrgLimitsReader(),
    traceFlagExecutor: stubTraceFlagWriter(),
    apexLogsExecutor: stubApexLogReader(),
    debugLogBodyExecutor: stubDebugLogBodyReader(),
    // `explain_field_access` is the one Tool added after this test was written, and it is required like
    // every other — the count and the order below are what keep the role map and the advertised list from
    // drifting apart as Tools are added.
    fieldAccessExplainer: {
      execute: async (input) => ({
        success: true, executionRole: 'DIAGNOSTIC', api: 'STANDARD', objectApiName: input.objectApiName,
        requestedFieldCount: input.fieldApiNames.length, returnedFieldCount: input.fieldApiNames.length,
        fields: [], truncated: false,
      }),
    },
    // `get_platform_diagnostics` is the same kind of arrival: a Tool added after this test was written,
    // required like every other. Its aggregation has its own Toolset test; here it needs only to exist.
    platformDiagnosticsReader: {
      execute: async () => ({ success: true, executionRole: 'DIAGNOSTIC', api: 'STANDARD' }),
    },
  });

  const tools = await provider.provideTools(createServices());
  assert.deepEqual(tools.map((tool) => tool.getName()), [...SFOA_CONTEXT_TOOL_NAMES]);
  assert.equal(SFOA_CONTEXT_TOOL_NAMES.length, 13);
  // The three debug-log Tools are advertised together and in workflow order, because that order is
  // what the chained hints assume and what an Agent walking them reads. Asserted as a contiguous run
  // rather than a tail slice, so appending a Tool cannot silently break the invariant this protects.
  const debugLogStart = SFOA_CONTEXT_TOOL_NAMES.indexOf('set_trace_flag');
  assert.deepEqual(
    SFOA_CONTEXT_TOOL_NAMES.slice(debugLogStart, debugLogStart + 3),
    ['set_trace_flag', 'get_apex_logs', 'get_debug_log_body'],
  );
  for (const name of ['set_trace_flag', 'get_apex_logs', 'get_debug_log_body'] as const) {
    assert.equal(SFOA_CONTEXT_TOOL_ROLES[name], 'DIAGNOSTIC');
  }
  // A write must not be routed as a read: the role map is what decides the identity the call runs on.
  assert.equal(SFOA_CONTEXT_TOOL_ROLES.set_trace_flag, 'DIAGNOSTIC');
});

test('the Provider refuses to build a debug-log Tool without its executor rather than advertising a dead Tool', async () => {
  const base = {
    diagnosticQueryExecutor: { execute: async () => ({ records: [], totalSize: 0, returnedRecords: 0, done: true, truncated: false }) },
    metadataContextExecutor: {
      execute: async (input: MetadataContextInput) => ({
        success: true, executionRole: 'DIAGNOSTIC' as const, metadataType: input.metadataType, fullName: input.fullName,
        files: [], omittedFiles: [], totalFiles: 0, returnedFiles: 0, totalBytes: 0, returnedBytes: 0,
        truncated: false,
        limits: { maxReturnedFiles: 40, maxFileBytes: 65_536, maxTotalBytes: 262_144, maxFileSummaries: 100 },
      }),
    },
    orgLimitsExecutor: stubOrgLimitsReader(),
  };
  for (const [toolName, expected] of [
    ['set_trace_flag', 'set_trace_flag requires a trace flag executor'],
    ['get_apex_logs', 'get_apex_logs requires an apex log executor'],
    ['get_debug_log_body', 'get_debug_log_body requires a debug log body executor'],
  ] as const) {
    const provider = new SfoaContextMcpProvider({ ...base, toolNames: [toolName as SfoaContextToolName] });
    await assert.rejects(
      async () => provider.provideTools(createServices()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, `${expected}.`);
        return true;
      },
      toolName,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/**
 * A log of the shape the probe sampled: a header the org did not write the version of, one
 * `USER_DEBUG` line, and a fatal exception with a two-frame stack.
 */
const FAILING_LOG = [
  '56.0 APEX_CODE,FINEST;APEX_PROFILING,NONE;CALLOUT,NONE;DB,INFO;NBA,NONE;SYSTEM,DEBUG;VALIDATION,INFO;VISUALFORCE,NONE;WAVE,NONE;WORKFLOW,INFO',
  '00:00:00.0 (1)|EXECUTION_STARTED',
  '00:00:00.1 (2)|CODE_UNIT_STARTED|[EXTERNAL]|01p000000000001|MyClass.myMethod',
  '00:00:00.2 (3)|USER_DEBUG|[1]|DEBUG|entering myMethod',
  '00:00:00.3 (4)|FATAL_ERROR|System.NullPointerException: Attempt to de-reference a null object',
  'Class.MyClass.myMethod: line 12, column 1',
  'Trigger.MyTrigger: line 3, column 1',
  '00:00:00.4 (5)|EXECUTION_FINISHED',
].join('\n');

function traceFlagSuccessOutput(overrides: Partial<TraceFlagOutput>): TraceFlagOutput {
  return {
    success: true,
    executionRole: 'DIAGNOSTIC',
    api: 'TOOLING',
    traceFlagId: '7tf000000000001AAA',
    tracedEntityKind: 'USER',
    tracedEntityId: '005000000000001AAA',
    logType: 'DEVELOPER_LOG',
    debugLevelId: '7dl000000000001AAA',
    debugLevelDeveloperName: 'SFOA_P10_DEBUG',
    debugLevelTier: 'DEBUG',
    debugLevelCreated: false,
    debugLevelLevels: undefined,
    startDate: '2026-09-30T00:00:00.000Z',
    expirationDate: '2026-09-30T00:30:00.000Z',
    previousExpirationDate: null,
    replacedExisting: false,
    requestedDurationMinutes: 30,
    verified: true,
    ...overrides,
  };
}

function stubTraceFlagWriter(): TraceFlagWriter {
  return { execute: async () => traceFlagSuccessOutput({}) };
}

function stubApexLogReader(): ApexLogReader {
  return {
    execute: async () => ({
      success: true, executionRole: 'DIAGNOSTIC', api: 'TOOLING', logs: [], totalCount: 0,
      returnedCount: 0, scannedCount: 0, truncated: false, timeWindowMinutes: 60,
      windowStartedAt: '2026-09-30T00:00:00.000Z', observedStatuses: [],
    }),
  };
}

function stubDebugLogBodyReader(): DebugLogBodyReader {
  return {
    execute: async (input) => ({
      success: true, executionRole: 'DIAGNOSTIC', api: 'TOOLING', logId: input.logId,
      body: 'x', totalBytes: 1, returnedBytes: 1, totalCharacters: 1, returnedCharacters: 1,
      maxCharacters: 60_000, truncated: false, logLength: 1, lastModifiedDate: null,
    }),
  };
}

function stubOrgLimitsReader() {
  return {
    execute: async () => ({
      success: true as const, executionRole: 'DIAGNOSTIC' as const, api: 'REST' as const, verbose: false,
      limits: { DailyApiRequests: { max: 1, remaining: 1, used: 0, measured: true } },
      highlights: {
        dailyApiRequests: { key: 'DailyApiRequests', present: true, max: 1, remaining: 1, used: 0 },
        dailyBulkApiRequests: { key: null, present: false, max: null, remaining: null, used: null },
        dailyAsyncApexExecutions: { key: null, present: false, max: null, remaining: null, used: null },
        dataStorageMB: { key: null, present: false, max: null, remaining: null, used: null },
        fileStorageMB: { key: null, present: false, max: null, remaining: null, used: null },
      },
      totalLimits: 1, returnedLimits: 1, unreadableLimits: 0, truncated: false,
    }),
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
