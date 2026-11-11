import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { businessCases, evaluateCapture, prepareEvaluation, serveFixture } from '../harness/business-autonomy.mjs';
import { projectOpenClawConfig } from '../harness/inspect-openclaw.mjs';
import { observeProviderInput } from '../harness/provider-input-observer.mjs';
import { createServer } from 'node:http';

test('runtime configuration projection reports model, allowlist and paths without credentials or prompt contents', () => {
  const output = projectOpenClawConfig({ agents: { defaults: { model: { primary: 'configured-model', fallbacks: ['configured-fallback'] }, workspace: '/isolated/workspace' },
    entries: { main: { skills: ['crm-core'], systemPrompt: 'SYNTHETIC_PRIVATE_PROMPT' } } },
    skills: { entries: { 'crm-core': { enabled: true, apiKey: 'SYNTHETIC_PRIVATE_KEY' } } },
    mcp: { servers: { sfoa: { headers: { Authorization: 'Bearer SYNTHETIC_PRIVATE_TOKEN' } } } } });
  assert.equal(output.agents[0]?.model.primary, 'configured-model');
  assert.deepEqual(output.agents[0]?.skills, ['crm-core']);
  assert.doesNotMatch(JSON.stringify(output), /SYNTHETIC_PRIVATE/u);
  assert.match(output.evidence, /CONFIG_FILE_ONLY/u);
});

test('fixed business corpus validates fixture payloads without claiming model or semantic acceptance', () => {
  assert.equal(businessCases.length, 24);
  for (const fixture of businessCases) {
    const toolCalls = (fixture.requiredReads ?? []).map(name => ({ name, arguments: fixture.requiredPicklistContinuation ? { picklistValueOffsets: { [fixture.requiredPicklistContinuation.fieldApiName]: fixture.requiredPicklistContinuation.minimumOffset } } : {} }));
    if (fixture.requiredFieldProjection) toolCalls.push({ name: 'get_record_action_context', arguments: { fieldApiNames: fixture.requiredFieldProjection } });
    if (fixture.operation !== 'NONE') toolCalls.push({ name: fixture.operation === 'CREATE' ? 'create_record' : 'update_record', arguments: {
      objectApiName: fixture.objectApiName, fields: fixture.candidateFields,
      ...(fixture.recordId ? { recordId: fixture.recordId } : {}), ...(fixture.recordTypeId ? { recordTypeId: fixture.recordTypeId } : {}),
    } });
    const result = evaluateCapture(fixture, { origin: 'FIXTURE', toolCalls, reply: fixture.candidateReply,
      transcriptReview: { questionCount: fixture.minQuestions ?? 0 } });
    assert.equal(result.deterministic, 'PASS', `${fixture.id}: ${result.failures.join(', ')}`);
    assert.equal(result.businessAcceptance, 'NOT_VERIFIED');
    assert.equal(result.semanticReview, 'REQUIRED');
  }
});

test('provider observer projects actual forwarded input without persisting credentials or prompt bodies', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'sfoa-provider-observer-'));
  const input = { model: 'synthetic-model', messages: [{ role: 'user', content: 'SYNTHETIC_PRIVATE_INPUT' },
    { role: 'assistant', tool_calls: [{ id: 'call-1', function: { name: 'sfoa-eval__get_record_action_context' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'structuredContent:\n' + JSON.stringify({ fields: [
      { apiName: 'City', label: '公司城市', inlineHelpText: '公司地址', length: 255, precision: null, scale: null },
    ], coverage: { truncated: false } }) }] };
  let received;
  const upstream = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received = { body: JSON.parse(Buffer.concat(chunks)), authorization: request.headers.authorization, path: request.url };
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}');
  });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  const trace = resolve(directory, 'provider-input.jsonl');
  const observer = await observeProviderInput({ providers: { synthetic: { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` } } }, 'synthetic/synthetic-model', trace);
  try {
    const result = await fetch(observer.models.providers.synthetic.baseUrl + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer SYNTHETIC_PRIVATE_TOKEN' }, body: JSON.stringify(input),
    });
    assert.deepEqual(await result.json(), { ok: true });
    assert.deepEqual(received, { body: input, authorization: 'Bearer SYNTHETIC_PRIVATE_TOKEN', path: '/v1/chat/completions' });
    const persisted = await readFile(trace, 'utf8');
    assert.doesNotMatch(persisted, /SYNTHETIC_PRIVATE/);
    const projected = JSON.parse(persisted).messages[2];
    assert.equal(projected.tool, 'sfoa-eval__get_record_action_context');
    assert.deepEqual(projected.fields[0], { apiName: 'City', label: '公司城市', helpPresent: true, helpBytes: 12, length: 255, precision: null, scale: null });
  } finally { await observer.close(); upstream.closeAllConnections(); await new Promise(done => upstream.close(done)); await rm(directory, { recursive: true, force: true }); }
});

test('the evaluator rejects missing related payload, incorrect API/Lookup values, scope growth and fabricated quantities', () => {
  for (const [id, fields] of [
    ['company-xiamen-text', { City: '厦门市' }],
    ['picklist-and-lookup', { Nation__c: '中国', Province__c: 'FJ_A', City_Link__c: '厦门市' }],
    ['summary-only', { Summary__c: '测试中', City: '厦门市' }],
    ['visit-material', { Summary__c: '测试中', Requests__c: '报价高', Next_Plan__c: '下周联系', Quantity__c: 100 }],
  ]) {
    const fixture = businessCases.find(item => item.id === id);
    const result = evaluateCapture(fixture, { toolCalls: [{ name: fixture.operation === 'CREATE' ? 'create_record' : 'update_record',
      arguments: { objectApiName: fixture.objectApiName, recordId: fixture.recordId, recordTypeId: fixture.recordTypeId, fields } }], transcriptReview: { questionCount: 0 } });
    assert.equal(result.deterministic, 'FAIL', id);
  }
});

test('evaluation pack includes the four canonical business Skills and no expected answers', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'sfoa-business-eval-'));
  try {
    const result = await prepareEvaluation(directory);
    assert.equal(result.status, 'PREPARED_NOT_RUN');
    assert.equal(result.skills.includes('sfoa-mcp-maintainer'), false);
    const inputs = JSON.parse(await readFile(resolve(directory, 'inputs.json'), 'utf8'));
    for (const input of inputs) for (const key of ['candidateFields', 'candidateReply', 'requiredValues', 'review']) assert.equal(key in input, false);
    assert.match(await readFile(resolve(directory, 'playbook.md'), 'utf8'), /business task/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a model timeout or unexecuted DML cannot pass through a correct-looking proposed payload', () => {
  const fixture = businessCases.find(item => item.id === 'company-xiamen-text');
  const capture = { origin: 'OPENCLAW_RUN', runId: 'synthetic-unit-fixture', model: 'synthetic-model', contextEvidence: 'synthetic-path',
    executionStatus: 'timeout', exitCode: 2, toolCalls: [{ name: 'create_record', arguments: { objectApiName: fixture.objectApiName, fields: fixture.candidateFields } }],
    transcriptReview: { questionCount: 0, criteria: fixture.review.map(criterion => ({ criterion, verdict: 'PASS', evidence: 'synthetic unit fixture' })) } };
  assert.equal(evaluateCapture(fixture, capture).businessAcceptance, 'NOT_VERIFIED');
  assert.equal(evaluateCapture(fixture, { ...capture, executionStatus: 'ok', exitCode: 0, sdkDispatches: [] }).businessAcceptance, 'NOT_VERIFIED');
});

test('Agent-prepared related fields reach the real CREATE/UPDATE Tool and mock SDK unchanged', async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const require = createRequire(resolve(root, 'packages/sfoa-mcp-server/package.json'));
  const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href);
  for (const id of ['company-xiamen-text', 'company-hangzhou-text', 'relocation', 'visit-location', 'summary-only', 'picklist-and-lookup', 'explicit-owner-managed-lookup']) {
    const fixture = businessCases.find(item => item.id === id);
    const mock = await serveFixture({ caseId: id });
    const client = new Client({ name: 'sfoa-offline-fixture', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(mock.endpoint)));
      const payload = { objectApiName: fixture.objectApiName, fields: fixture.candidateFields,
        ...(fixture.recordId ? { recordId: fixture.recordId } : {}), ...(fixture.recordTypeId ? { recordTypeId: fixture.recordTypeId } : {}) };
      const result = await client.callTool({ name: fixture.operation === 'CREATE' ? 'create_record' : 'update_record', arguments: payload });
      assert.equal(result.isError, undefined, id);
      assert.deepEqual(mock.calls[0]?.arguments, payload);
      assert.deepEqual(mock.dispatches[0]?.fields, { ...fixture.candidateFields,
        ...(fixture.recordId ? { Id: fixture.recordId } : {}), ...(fixture.recordTypeId ? { RecordTypeId: fixture.recordTypeId } : {}) });
      assert.equal(mock.dispatches.length, 1);
      // There is no hidden geo enrichment in DML: the Agent's prepared fields are the payload.
    } finally { await client.close(); await mock.close(); }
  }
});
