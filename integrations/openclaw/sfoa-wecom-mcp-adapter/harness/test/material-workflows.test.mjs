import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { materialCases, prepareMaterialTurn, serveMaterialFixture, evaluateMaterialCapture, filterMaterialFixtureRows } from '../material-workflows.mjs';
import { agentCommand, normalizeTurnResult, readRunOptions } from '../run-evidence.mjs';
import { businessCases, evaluateCapture } from '../business-autonomy.mjs';
import { projectProviderInput } from '../provider-input-observer.mjs';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const require = createRequire(resolve(root, 'packages/sfoa-mcp-server/package.json'));
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href);

test('six natural journeys expose neither the schema/expected payload nor pre-parsed file content in messages', async () => {
  assert.equal(materialCases.length, 6);
  const directory = await mkdtemp(resolve(tmpdir(), 'sfoa-natural-input-'));
  try {
    for (const fixture of materialCases) for (let turn = 0; turn < fixture.turns.length; turn++) {
      const prepared = await prepareMaterialTurn(fixture, turn, directory);
      assert.doesNotMatch(prepared.prompt, /objectApiName|requiredValues|candidateFields|RecordTypeId|\w+__c|已解析材料正文/u);
      for (const evidence of prepared.materialEvidence) {
        assert.equal(evidence.readingEvidence, 'NOT_VERIFIED');
        const file = fixture.files.find(item => item.name === evidence.fileName);
        assert.equal(await readFile(resolve(directory, evidence.path), 'utf8'), file.content);
        assert.equal(evidence.contentSha256.length, 64);
        assert.equal(evidence.stagingEvidence, 'SYNTHETIC_REF_ONLY');
      }
    }
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  }
});

test('runner defaults material journeys to three independent repeats and labels shared runtime scope', () => {
  const options = readRunOptions(['--suite', 'material'], root);
  assert.equal(options.repeats, 3);
  assert.equal(options.runtimeScope, 'SHARED_PROVIDER_RUNTIME_GUIDANCE_COMPARISON_ONLY');
  assert.throws(() => readRunOptions(['--before-runtime', '/before'], root), /both/u);
  assert.throws(() => readRunOptions(['--repeats', '0'], root), /1\.\.10/u);
  assert.throws(() => readRunOptions(['--repeats', 'NaN'], root), /1\.\.10/u);
  const distinct = readRunOptions(['--before-runtime', '/before', '--after-runtime', '/after'], root);
  assert.notEqual(distinct.runtimeRoots.before, distinct.runtimeRoots.after);
  assert.equal(distinct.runtimeScope, 'EXPLICIT_PROVIDER_RUNTIME_ROOTS_SYNTHETIC_SDK');
});

test('verified CLI surface uses isolated local sessions for natural turns, never delivery or guessed exec resume flags', () => {
  const input = { suite: 'material', configPath: '/private/config', workspace: '/isolated/workspace', state: '/isolated/state', messageFile: '/isolated/turn', sessionId: 'same-id', sessionKey: 'agent:main:test' };
  const first = agentCommand(input), second = agentCommand({ ...input, messageFile: '/isolated/turn2' });
  assert.equal(first.args.includes('--local'), true);
  assert.equal(first.args.includes('--deliver'), false);
  assert.equal(first.args.includes('exec'), false);
  assert.equal(first.args[first.args.indexOf('--session-id') + 1], second.args[second.args.indexOf('--session-id') + 1]);
  assert.deepEqual(first.env, { OPENCLAW_CONFIG_PATH: '/private/config', OPENCLAW_STATE_DIR: '/isolated/state' });
  assert.equal(agentCommand({ ...input, suite: 'legacy' }).args.includes('exec'), true);
});

test('exec and local envelopes preserve actual model/session, failures never gain a fabricated successful result', () => {
  assert.deepEqual(normalizeTurnResult({ status: 'ok', sessionId: 'real-id', model: 'real-model', final: 'done' }),
    { runId: 'NOT_AVAILABLE', sessionId: 'real-id', model: 'real-model', reply: 'done', replayInvalid: null, executionStatus: 'ok', usage: null, durationMs: null });
  assert.equal(normalizeTurnResult({ payloads: [{ text: 'done' }], meta: { agentMeta: { sessionId: 'session', provider: 'provider', model: 'model' } } }).sessionId, 'session');
  assert.equal(normalizeTurnResult({ runId: 'actual-run', sessionId: 'actual-session' }).runId, 'actual-run');
  assert.equal(normalizeTurnResult({ payloads: [], meta: { aborted: true, agentMeta: {} } }).executionStatus, 'aborted');
  assert.equal(normalizeTurnResult({}).executionStatus, 'INVALID_RESULT');
});

test('optional archival invitations are counted separately from blocking questions in legacy evaluations', () => {
  const fixture = businessCases.find(item => item.id === 'company-xiamen-text');
  const capture = { toolCalls: [{ name: 'create_record', arguments: { objectApiName: fixture.objectApiName, fields: fixture.candidateFields } }],
    transcriptReview: { questionCount: 1, blockingQuestionCount: 0, optionalArchiveInvitations: 1 } };
  const result = evaluateCapture(fixture, capture);
  assert.equal(result.deterministic, 'PASS');
  assert.equal(result.optionalArchiveInvitations, 1);
  assert.equal(result.businessAcceptance, 'NOT_VERIFIED');
});

test('natural MCP uses actual metadata/context/query/DML executors and exposes only queried rows/fields', async () => {
  const mock = await serveMaterialFixture({ caseId: 'natural-multisource-create' });
  const client = new Client({ name: 'natural-contract-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mock.endpoint)));
    const inventory = await client.callTool({ name: 'list_sobjects', arguments: {} });
    assert.deepEqual(inventory.structuredContent.sobjects.map(item => item.label), ['客户', '拜访纪要', '来访申请']);
    const selected = await client.callTool({ name: 'get_record_action_context', arguments: { objectApiName: 'Reception_Request__c', action: 'CREATE' } });
    assert.equal(selected.structuredContent.recordTypeSelectionRequired, true);
    const context = await client.callTool({ name: 'get_record_action_context', arguments: { objectApiName: 'Reception_Request__c', action: 'CREATE', recordTypeId: '012000000000001AAA' } });
    assert.equal(context.isError, undefined);
    assert.equal(context.structuredContent.fields.find(field => field.apiName === 'Visitors__c').label, '双方参与人员');
    const customer = await client.callTool({ name: 'query_records', arguments: { query: "SELECT Id, Name FROM Account WHERE Name LIKE '%青禾%' LIMIT 5" } });
    assert.equal(customer.isError, undefined);
    assert.equal(JSON.stringify(customer.structuredContent).includes('BillingCity'), false, 'unqueried current values must not leak into the answer');
    const none = await client.callTool({ name: 'query_records', arguments: { query: "SELECT Id FROM Customer_Contact_Log__c WHERE Customer__c = '001000000000001AAA' LIMIT 5" } });
    assert.equal(none.structuredContent.records.length, 0);
    mock.beginTurn(1);
    const result = await client.callTool({ name: 'create_record', arguments: { objectApiName: 'Reception_Request__c', recordTypeId: '012000000000001AAA',
      fields: { Customer__c: '001000000000001AAA', Planned_At__c: '2026-11-06T06:00:00Z', Aim__c: '了解节水龙头与噪音控制', Agenda__c: '先展厅，后实验室', Visitors__c: '客户林薇，我方陈清', Location__c: '集团展厅' } } });
    assert.equal(result.isError, undefined);
    assert.equal(mock.dispatches.length, 1);
    assert.equal(mock.dispatches[0].turn, 1);
    assert.equal(mock.records.Reception_Request__c.length, 1);
  } finally { await client.close(); await mock.close(); }
});

test('fixture query rejects fields absent from describe even when the object has no records', async () => {
  const mock = await serveMaterialFixture({ caseId: 'natural-multisource-create' });
  const client = new Client({ name: 'unknown-field-contract-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mock.endpoint)));
    for (const query of ['SELECT Id, BillingProvince FROM Account', 'SELECT Id, Account_Name__c FROM Reception_Request__c']) {
      const result = await client.callTool({ name: 'query_records', arguments: { query } });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.errorCode, 'MCP_QUERY_FIELD_INVALID');
      assert.match(result.structuredContent.message, /INVALID_FIELD/u);
    }
  } finally { await client.close(); await mock.close(); }
});

test('fixture query rejects unknown predicate fields instead of reporting no matching event', async () => {
  const mock = await serveMaterialFixture({ caseId: 'natural-existing-supplement' });
  const client = new Client({ name: 'unknown-predicate-contract-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mock.endpoint)));
    for (const query of ['SELECT Id FROM Customer_Contact_Log__c WHERE OccurredOn__c = 2026-11-03',
      'SELECT Id FROM Reception_Request__c WHERE PlannedAt__c >= 2026-11-06T00:00:00Z']) {
      const result = await client.callTool({ name: 'query_records', arguments: { query } });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.errorCode, 'MCP_QUERY_FIELD_INVALID');
      assert.match(result.structuredContent.message, /INVALID_FIELD/u);
      assert.equal(result.structuredContent.records, undefined);
    }
  } finally { await client.close(); await mock.close(); }
});

test('fixture query returns explicit null for a selected known but unset field', async () => {
  const mock = await serveMaterialFixture({ caseId: 'natural-existing-supplement' });
  const client = new Client({ name: 'null-field-contract-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mock.endpoint)));
    const result = await client.callTool({ name: 'query_records', arguments: { query: 'SELECT Id, Location__c FROM Customer_Contact_Log__c' } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.records.length, 1);
    assert.equal(Object.hasOwn(result.structuredContent.records[0], 'Location__c'), true);
    assert.equal(result.structuredContent.records[0].Location__c, null);
    assert.equal(Object.hasOwn(result.structuredContent.records[0], 'Progress__c'), false);
  } finally { await client.close(); await mock.close(); }
});

test('fixture ISO date ranges filter cross-date events through the actual query tool', async () => {
  const mock = await serveMaterialFixture({ caseId: 'natural-multisource-create' });
  const client = new Client({ name: 'date-range-contract-test', version: '1' });
  const customer = '001000000000001AAA';
  mock.records.Reception_Request__c.push(
    { Id: 'before', Customer__c: customer, Planned_At__c: '2026-11-05T15:59:59Z' },
    { Id: 'start', Customer__c: customer, Planned_At__c: '2026-11-05T16:00:00Z' },
    { Id: 'inside', Customer__c: customer, Planned_At__c: '2026-11-06T06:00:00Z' },
    { Id: 'end', Customer__c: customer, Planned_At__c: '2026-11-06T16:00:00Z' },
    { Id: 'other', Customer__c: '001000000000002AAA', Planned_At__c: '2026-11-06T06:00:00Z' },
  );
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mock.endpoint)));
    const result = await client.callTool({ name: 'run_soql_query', arguments: { query:
      `SELECT Id FROM Reception_Request__c WHERE Customer__c = '${customer}' AND Planned_At__c >= 2026-11-06T00:00:00+08:00 AND Planned_At__c < 2026-11-07T00:00:00+08:00` } });
    assert.deepEqual(result.structuredContent.records.map(row => row.Id), ['start', 'inside']);
    const unsupported = await client.callTool({ name: 'run_soql_query', arguments: { query:
      `SELECT Id FROM Reception_Request__c WHERE Customer__c = '${customer}' AND Planned_At__c != 2026-11-06T06:00:00Z` } });
    assert.equal(unsupported.isError, true);
    assert.equal(unsupported.structuredContent.errorCode, 'SYNTHETIC_QUERY_FILTER_UNSUPPORTED');
  } finally { await client.close(); await mock.close(); }
});

test('fixture predicates consume the whole AND expression and reject unknown syntax even with no rows', () => {
  const rows = [{ day: '2026-11-02' }, { day: '2026-11-03' }, { day: '2026-11-04' }];
  assert.deepEqual(filterMaterialFixtureRows(rows, 'day >= 2026-11-03 AND day < 2026-11-04'), [rows[1]]);
  assert.equal(filterMaterialFixtureRows([{ Name: "O'Brien AND co" }], "Name = 'O\\'Brien AND co'").length, 1);
  for (const where of ["Name = 'x' AND day != 2026-11-03", "Name = 'x' OR Name = 'y'", "Name = 'x' AND", "Name = 'x' garbage", 'day >= TODAY', "day >= 'yesterday'", "Name = 'x' AND day IN ('2026-11-03')"]) {
    assert.throws(() => filterMaterialFixtureRows([], where), /SYNTHETIC_QUERY_FILTER_UNSUPPORTED/u, where);
  }
});

test('simulated attachment partial failure keeps the record and permits only the failed original on recovery turn', async () => {
  const fixture = materialCases.find(item => item.id === 'natural-attachment-recovery');
  const mock = await serveMaterialFixture({ caseId: fixture.id });
  const client = new Client({ name: 'attachment-contract-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mock.endpoint)));
    const created = await client.callTool({ name: 'create_record', arguments: { objectApiName: fixture.objectApiName, recordTypeId: '012000000000003AAA', fields: {
      Customer__c: '001000000000001AAA', Occurred_On__c: '2026-11-03', Progress__c: '仍在测试', Concerns__c: '报价高', Follow_Up__c: '下周跟进' } } });
    assert.equal(created.isError, undefined);
    const recordId = mock.dispatches[0].recordId;
    const first = await client.callTool({ name: 'upload_files_to_record', arguments: { objectApiName: fixture.objectApiName, recordId, attachmentRefs: fixture.files.map(file => file.attachmentRef) } });
    assert.equal(first.structuredContent.status, 'PARTIAL_SUCCESS');
    assert.deepEqual(first.structuredContent.results.map(file => [file.status, file.retryable]), [['SUCCESS', false], ['FAILED', true]]);
    mock.beginTurn(1);
    const recovered = await client.callTool({ name: 'upload_files_to_record', arguments: { objectApiName: fixture.objectApiName, recordId, attachmentRefs: [fixture.files[1].attachmentRef] } });
    assert.equal(recovered.structuredContent.status, 'SUCCESS');
    assert.equal(mock.records[fixture.objectApiName].length, 1);
    const evaluation = evaluateMaterialCapture(fixture, { sdkDispatches: mock.dispatches, toolCalls: mock.calls, uploads: mock.uploads,
      transcriptReview: { blockingQuestionCount: 0, optionalArchiveInvitations: 0 } });
    assert.equal(evaluation.modelTaskAcceptance, 'NOT_VERIFIED');
    assert.equal(evaluation.realSalesforce, 'NOT_TESTED');
    assert.equal(evaluation.attachmentBackend, 'SIMULATED');
    assert.equal(evaluation.failures.includes('recovery replayed successful/unselected original'), false);
    assert.equal(evaluation.failures.includes('first turn did not prove success plus recoverable failure'), false);
    const incomplete = structuredClone(mock.uploads);
    incomplete[0].result.results = incomplete[0].result.results.filter(file => file.status === 'SUCCESS');
    const falseRecovery = evaluateMaterialCapture(fixture, { sdkDispatches: mock.dispatches, toolCalls: mock.calls, uploads: incomplete,
      transcriptReview: { blockingQuestionCount: 0, optionalArchiveInvitations: 0 } });
    assert.equal(falseRecovery.failures.includes('first turn did not prove success plus recoverable failure'), true);
  } finally { await client.close(); await mock.close(); }
});

test('handwritten payloads and missing actual read/session evidence cannot become model acceptance', () => {
  for (const fixture of materialCases) {
    const result = evaluateMaterialCapture(fixture, { origin: 'FIXTURE', turns: [], sdkDispatches: [], toolCalls: [],
      transcriptReview: { blockingQuestionCount: 0, optionalArchiveInvitations: 0, criteria: fixture.review.map(criterion => ({ criterion, verdict: 'PASS', evidence: 'manual fixture' })) } });
    assert.equal(result.modelTaskAcceptance, 'NOT_VERIFIED');
    assert.equal(result.evidence, 'NOT_VERIFIED');
    assert.equal(result.wecom, 'NOT_TESTED');
    if (fixture.files?.length) assert.equal(result.materialReading, 'NOT_VERIFIED');
  }
});

test('provider input observation correlates original material reads without saving the body or full local path', () => {
  const observed = projectProviderInput({ messages: [
    { role: 'assistant', tool_calls: [{ id: 'read-1', function: { name: 'read', arguments: JSON.stringify({ path: '/private/workspace/materials/meeting.txt' }) } }] },
    { role: 'tool', tool_call_id: 'read-1', content: 'PRIVATE_SYNTHETIC_MATERIAL_TEXT' },
  ] });
  assert.equal(observed.messages[1].materialFile, 'meeting.txt');
  assert.equal(observed.messages[1].materialReadEvidence, 'TOOL_RESULT_OBSERVED_REQUIRES_REVIEW');
  assert.doesNotMatch(JSON.stringify(observed), /PRIVATE_SYNTHETIC_MATERIAL_TEXT|private\/workspace/u);
});
