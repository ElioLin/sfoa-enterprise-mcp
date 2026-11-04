/** Offline evaluator / loopback mock MCP. Never connects to Salesforce or supplies a WeCom requester. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp, appendFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
export const businessCases = JSON.parse(await readFile(new URL('./business-cases.json', import.meta.url), 'utf8'));
const skills = ['sfoa-crm-core', 'sfoa-record-change', 'sfoa-data-analysis', 'sfoa-org-diagnostics'];
const writes = new Set(['create_record', 'update_record', 'create_records', 'update_records']);

/** Checks parameters/outcomes, never claims to judge arbitrary prose by fixed wording. */
export function evaluateCapture(fixture, capture) {
  const failures = [];
  const calls = capture.toolCalls ?? [];
  const mutations = calls.filter(call => writes.has(call.name));
  const expectedTool = fixture.operation === 'CREATE' ? 'create_record' : 'update_record';
  if (fixture.operation === 'NONE' && mutations.length) failures.push('unexpected mutation');
  if (fixture.operation !== 'NONE') {
    const call = mutations.find(item => item.name === expectedTool);
    if (!call) failures.push(`missing ${expectedTool} payload`);
    if (call) {
      const input = call.arguments;
      if (input.objectApiName !== fixture.objectApiName) failures.push('wrong business object/subject');
      if (fixture.recordId && input.recordId !== fixture.recordId) failures.push('wrong target record');
      if (fixture.recordTypeId && (input.recordTypeId ?? input.fields?.RecordTypeId) !== fixture.recordTypeId) failures.push('wrong Record Type');
      const fields = input.fields ?? {};
      for (const [name, value] of Object.entries(fixture.requiredValues ?? {})) {
        if (!Object.is(fields[name], value)) failures.push(`incorrect or missing ${name}`);
      }
      for (const [name, values] of Object.entries(fixture.allowedValues ?? {})) if (!values.some(value => Object.is(fields[name], value))) failures.push(`incorrect or missing ${name}`);
      for (const name of fixture.textFields ?? []) if (typeof fields[name] !== 'string' || !fields[name].trim()) failures.push(`missing business content ${name}`);
      for (const name of fixture.forbiddenFields ?? []) if (Object.hasOwn(fields, name)) failures.push(`unrelated/fabricated/unchanged field ${name}`);
      if (fixture.onlyFields) for (const name of Object.keys(fields)) if (!fixture.onlyFields.includes(name)) failures.push(`explicit scope exceeded: ${name}`);
    }
    if (mutations.length > 1) failures.push('unexpected repeated write in one-record fixture');
  }
  for (const name of fixture.requiredReads ?? []) if (!calls.some(call => call.name === name)) failures.push(`missing evidence continuation ${name}`);
  if (fixture.requiredPicklistContinuation && !calls.some(call => call.name === 'get_record_action_context' &&
    call.arguments?.picklistValueOffsets?.[fixture.requiredPicklistContinuation.fieldApiName] >= fixture.requiredPicklistContinuation.minimumOffset)) failures.push('missing actual Picklist continuation page');
  if (fixture.requiredFieldProjection && !calls.some(call => call.name === 'get_record_action_context' &&
    fixture.requiredFieldProjection.every(name => call.arguments?.fieldApiNames?.includes(name)))) failures.push('missing actual task context projection');
  // Questions are annotated from the actual transcript, never the model's own claimed count.
  const questions = capture.transcriptReview?.blockingQuestionCount ?? capture.transcriptReview?.questionCount;
  const optionalArchiveInvitations = capture.transcriptReview?.optionalArchiveInvitations ?? null;
  if (typeof questions !== 'number') failures.push('question count not reviewed from transcript');
  else {
    if (fixture.maxQuestions !== undefined && questions > fixture.maxQuestions) failures.push('unnecessary clarification');
    if (fixture.minQuestions !== undefined && questions < fixture.minQuestions) failures.push('unresolved ambiguity ignored');
  }
  const reviews = fixture.review ?? [];
  const semantic = capture.transcriptReview?.criteria ?? [];
  const reviewComplete = semantic.length === reviews.length && semantic.every((item, index) => item.criterion === reviews[index] && item.verdict === 'PASS' && item.evidence);
  const actualModelRun = capture.origin === 'OPENCLAW_RUN'
    && Boolean(((capture.sessionId && capture.sessionId !== 'NOT_AVAILABLE') || (capture.runId && capture.runId !== 'NOT_AVAILABLE')) && capture.model && capture.contextEvidence)
    && capture.executionStatus === 'ok' && capture.exitCode === 0;
  if (capture.origin === 'OPENCLAW_RUN') {
    if (!actualModelRun) failures.push('model execution not successfully captured');
    const dispatches = capture.sdkDispatches ?? [];
    if (!Array.isArray(capture.sdkDispatches) || dispatches.length !== (fixture.operation === 'NONE' ? 0 : 1)) failures.push('missing or unexpected proven SDK dispatch');
    const mutation = mutations[0];
    if (mutation && dispatches.length === 1) {
      const expected = { ...mutation.arguments.fields, ...(mutation.arguments.recordTypeId ? { RecordTypeId: mutation.arguments.recordTypeId } : {}),
        ...(mutation.arguments.recordId ? { Id: mutation.arguments.recordId } : {}) };
      try { assert.deepEqual(dispatches[0], { operation: fixture.operation, objectApiName: fixture.objectApiName, fields: expected }); }
      catch { failures.push('SDK dispatch does not match Agent payload'); }
    }
  }
  return { id: fixture.id, evidence: actualModelRun ? 'MODEL_CAPTURE' : capture.origin === 'OPENCLAW_RUN' ? 'FAILED_MODEL_CAPTURE' : 'FIXTURE_ONLY',
    deterministic: failures.length ? 'FAIL' : 'PASS', failures, questions, optionalArchiveInvitations,
    mutationCount: mutations.length, toolCallCount: calls.length,
    finalPayloads: mutations.map(call => ({ name: call.name, arguments: call.arguments })),
    reply: capture.reply ?? null, semanticReview: reviewComplete ? 'REVIEWED' : 'REQUIRED', reviewCriteria: reviews,
    businessAcceptance: actualModelRun && failures.length === 0 && reviewComplete ? 'PASS' : 'NOT_VERIFIED' };
}

export async function prepareEvaluation(output, sourceRoot = root) {
  const target = resolve(output);
  await mkdir(target, { recursive: true });
  const generated = await readFile(resolve(sourceRoot, 'docs/agent/DIFY_AGENT_INSTRUCTION.md'), 'utf8');
  const at = generated.indexOf('# SFoA Salesforce Agent Playbook');
  if (at < 0) throw new Error('Generate the Playbook first: yarn agent:sync');
  const guidance = generated.slice(at);
  await writeFile(resolve(target, 'playbook.md'), guidance);
  for (const name of skills) await cp(resolve(sourceRoot, 'skills', name), resolve(target, 'skills', name), { recursive: true });
  // Expected answers/candidate payloads never enter the Agent prompt pack.
  const inputs = businessCases.map(({ id, request, material, objectApiName, fields, context, currentValues, candidates }) =>
    ({ id, request, material, objectApiName, fields, context, currentValues, candidates }));
  await writeFile(resolve(target, 'inputs.json'), JSON.stringify(inputs, null, 2));
  await writeFile(resolve(target, 'capture-template.json'), JSON.stringify({ origin: 'OPENCLAW_RUN', runId: '', model: '',
    contextEvidence: '', cases: businessCases.map(f => ({ id: f.id, toolCalls: [], reply: '', transcriptReview: { questionCount: null,
      criteria: f.review.map(criterion => ({ criterion, verdict: 'NOT_REVIEWED', evidence: '' })) } })) }, null, 2));
  return { status: 'PREPARED_NOT_RUN', output: target, caseCount: inputs.length, skills, model: 'NOT_VERIFIED',
    requester: 'none; isolated mock evaluation is not WeCom end-to-end acceptance' };
}

/** Serve one synthetic case through the real generic DML Tools and SDK; no production identity/runtime. */
export async function serveFixture({ caseId, sourceRoot = root, runtimeRoot = root, tracePath, port = 0 }) {
  const fixture = businessCases.find(item => item.id === caseId);
  if (!fixture) throw new Error('Unknown fixture');
  const require = createRequire(resolve(runtimeRoot, 'packages/sfoa-mcp-server/package.json'));
  const { McpServer } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href);
  const { StreamableHTTPServerTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/streamableHttp.js')).href);
  const { z } = require('zod');
  const dml = await import(pathToFileURL(resolve(runtimeRoot, 'packages/mcp-provider-sfoa-dml/dist/index.js')).href);
  const contextProvider = await import(pathToFileURL(resolve(runtimeRoot, 'packages/mcp-provider-sfoa-context/dist/index.js')).href);
  const { PresentationRelationshipMcpTool } = await import(pathToFileURL(resolve(runtimeRoot, 'packages/mcp-provider-sfoa-context/dist/tools/presentation-relationship.js')).href);
  const dataProvider = await import(pathToFileURL(resolve(runtimeRoot, 'packages/mcp-provider-sfoa-data/dist/index.js')).href);
  const generated = await readFile(resolve(sourceRoot, 'docs/agent/DIFY_AGENT_INSTRUCTION.md'), 'utf8');
  const heading = generated.indexOf('# SFoA Salesforce Agent Playbook');
  if (heading < 0) throw new Error('Generate the Playbook first: yarn agent:sync');
  const guidance = generated.slice(heading);
  const calls = [];
  const dispatches = [];
  const recordId = fixture.recordId ?? (fixture.objectApiName === 'Lead' ? '00Q000000000001AAA' : 'a01000000000001AAA');
  const names = [...new Set([...(fixture.fields ?? []).map(field => field.apiName), ...Object.keys(fixture.candidateFields ?? {}), ...Object.keys(fixture.currentValues ?? {}), ...(fixture.textFields ?? [])])];
  const stored = { ...fixture.currentValues };
  const cityChoices = fixture.context?.picklist ? Array.from({ length: fixture.context.picklist.totalValues }, (_, i) =>
    i === 180 ? { label: '厦门市', value: 'CN_FJ_XMN' } : { label: `合成城市${i}`, value: `CITY_${i}` }) : undefined;
  const connection = { describe: async objectApiName => ({ name: objectApiName, label: fixture.context?.label ?? objectApiName,
    queryable: true, createable: true, updateable: true, fields: names.map(name => {
      const field = fixture.fields?.find(item => item.apiName === name);
      return { name, label: field?.label ?? name, type: field?.type ?? 'string', inlineHelpText: field?.inlineHelpText ?? null,
        length: field?.type === 'textarea' ? 2000 : 255, nillable: true, createable: true, updateable: true, picklistValues: name === 'City' ? cityChoices?.map(o => ({ ...o, active: true, defaultValue: false })) : [], referenceTo: name === 'City_Link__c' ? ['Region__c'] : [] };
    }), childRelationships: [] }), sobject: objectApiName => ({ create: async fields => { Object.assign(stored, fields); dispatches.push({ operation: 'CREATE', objectApiName, fields }); return { success: true, id: recordId, errors: [] }; },
    update: async fields => { Object.assign(stored, fields); dispatches.push({ operation: 'UPDATE', objectApiName, fields }); return { success: true, id: recordId, errors: [] }; } }) };
  const org = { getAllowedOrgUsernames: async () => new Set(['isolated-fixture@example.test']), getConnection: async () => connection };
  const executor = new dml.DmlExecutor(org, dml.parseDmlAllowlistJson(JSON.stringify([{ objectApiName: fixture.objectApiName, operations: ['CREATE', 'UPDATE'] }])));
  const log = async (name, args) => {
    const entry = { name, arguments: args };
    calls.push(entry);
    if (tracePath) await appendFile(tracePath, `${JSON.stringify(entry)}\n`);
  };
  const json = output => ({ content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], structuredContent: output });
  const http = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(404).end(); return; }
    const server = new McpServer({ name: 'sfoa-business-eval-mock', version: '1.0.0' }, { instructions: guidance });
    const actionConfig = new contextProvider.RecordActionContextMcpTool({}).getConfig();
    const configs = [new contextProvider.GetApexLogsMcpTool({}), new contextProvider.GetDebugLogBodyMcpTool({}),
      new contextProvider.GetPlatformDiagnosticsMcpTool({}), new dataProvider.QueryRecordsMcpTool({}),
      new PresentationRelationshipMcpTool({}, 'DISPLAY')];
    const readConfigs = new Map(configs.map(tool => [tool.getName(), tool.getConfig()]));
    readConfigs.set('get_record_action_context', actionConfig);
    const read = (name, inputSchema, fn) => {
      const actual = readConfigs.get(name);
      return server.registerTool(name, { inputSchema: actual?.inputSchema ?? inputSchema,
        ...(actual ? { description: actual.description } : {}), annotations: { readOnlyHint: true } }, async args => {
          await log(name, args);
          if (name === 'get_record_action_context') return new contextProvider.RecordActionContextMcpTool({ execute: () => fn(args) }).exec(args);
          return json(await fn(args));
        });
    };
    read('get_agent_playbook', { workflow: z.enum(['CORE','READ','CREATE','UPDATE','DIAGNOSIS','ALL']).optional() }, () => ({ guidance, managedDmlFields: fixture.context?.managedDmlFields ?? [], truncated: false }));
    read('get_record_action_context', { objectApiName: z.string(), action: z.enum(['CREATE', 'UPDATE']), recordId: z.string().optional(), recordTypeId: z.string().optional(),
      draftFields: z.record(z.unknown()).optional(), picklistValueOffsets: z.record(z.number()).optional(), refinement: z.number().optional() }, args => {
      const context = fixture.context ?? {};
      const types = context.availableRecordTypes ?? [{ id: fixture.recordTypeId ?? '012000000000001AAA', name: '适用业务类型', available: true }];
      const descriptors = types.map(type => ({ id: type.id, name: type.name, available: true, defaultForUser: types.length === 1 }));
      const selected = args.recordTypeId ? descriptors.find(type => type.id === args.recordTypeId) : descriptors.length === 1 ? descriptors[0] : undefined;
      const metadataNames = [...names, ...Array.from({ length: context.oversizedFields ?? 0 }, (_, index) => `Extra${index}__c`)];
      const fields = metadataNames.map(name => {
        const source = fixture.fields?.find(field => field.apiName === name);
        const allOptions = name === 'Nation__c' ? context.countryChoices : name === 'Province__c' ? context.provinceChoices : name === 'City' ? cityChoices : undefined;
        const offset = args.picklistValueOffsets?.[name] ?? 0;
        const options = allOptions?.slice(offset, offset + 100);
        return { apiName: name, label: source?.label ?? name, dataType: options ? 'Picklist' : source?.type === 'textarea' ? 'TextArea' : source?.type === 'reference' || name === 'City_Link__c' ? 'Reference' : 'String',
          inlineHelpText: name.startsWith('Extra') ? '与本次任务无关的合成字段帮助。'.repeat(100) : source?.inlineHelpText ?? null,
          length: source?.type === 'textarea' ? 2000 : 255, precision: null, scale: null,
          apiRequired: false, layoutMember: true, layoutRequired: false, fieldCreateable: true, fieldUpdateable: true,
          layoutEditableForCreate: true, layoutEditableForUpdate: true, defaultValue: null, defaultValueTruncated: false,
          section: null, layoutOrder: null, relationshipName: null, referenceTo: context.referenceToByField?.[name] ?? (name === 'City_Link__c' ? context.referenceTo ?? [] : []),
          ...(options && selected ? { picklist: { controllerName: name === 'Province__c' ? 'Nation__c' : null,
            controllerValues: name === 'Province__c' ? context.controllerValues ?? {} : {}, values: options.map(option => ({ ...option, default: false, validFor: option.validFor ?? [] })),
            totalValues: allOptions.length, returnedValues: options.length, truncated: allOptions.length > options.length,
            valueOffset: offset, nextValueOffset: offset + options.length < allOptions.length ? offset + options.length : null, dependenciesTruncated: false } } : {}) };
      });
      const parsed = contextProvider.recordActionContextOutputSchema.parse({ success: true, executionRole: 'USER', objectApiName: fixture.objectApiName,
        objectLabel: context.label ?? fixture.objectApiName, action: args.action, ...(args.recordId ? { recordId: args.recordId } : {}), fields,
        availableRecordTypes: descriptors, recordTypeSelectionRequired: !selected, ...(selected ? { recordType: selected } : {}),
        coverage: { sources: ['UI_API_OBJECT_INFO'], apiCallCount: 0, durationMs: 0, responseBytes: 0, totalVisibleFields: fields.length,
          returnedFields: fields.length, totalPicklistValues: 0, returnedPicklistValues: 0, truncated: context.picklist?.truncated ?? false,
          dynamicFormsEvaluated: false, completeLightningPageEvaluated: false, warnings: ['Synthetic mock fixture; no Salesforce identity or live metadata.'] } });
      return { ...parsed, managedDmlFields: context.managedDmlFields ?? [] };
    });
    read('resolve_field_display_values', {}, args => ({ objectApiName: args.objectApiName, truncated: false, apiCallCount: 0,
      results: args.values.map((item, index) => {
        const choices = item.fieldApiName === 'Nation__c' ? fixture.context?.countryChoices
          : item.fieldApiName === 'Province__c' ? fixture.context?.provinceChoices : item.fieldApiName === 'City' ? cityChoices : [];
        const label = choices?.find(choice => choice.value === item.rawValue)?.label;
        return { index, ...item, recordTypeId: item.recordTypeId ?? null, displayValue: label ?? item.rawValue,
          resolutionStatus: label ? 'RESOLVED' : 'UNRESOLVED' };
      }) }));
    for (const name of ['run_soql_query', 'query_records', 'get_apex_logs', 'get_debug_log_body', 'get_platform_diagnostics']) {
      read(name, { query: z.string().optional(), objectApiName: z.string().optional(), logId: z.string().optional() }, args => {
        const ownerObject = String(fixture.context?.ownerLookupObject ?? 'User').replace(/[^A-Za-z0-9_]/gu, '') || 'User';
        const ownerQuery = new RegExp(`\\bFROM\\s+${ownerObject}\\b`, 'iu').test(args.query ?? args.soql ?? '');
        return { synthetic: true,
          evidence: fixture.context ?? {}, currentValues: fixture.currentValues ?? {}, records: ownerQuery && fixture.context?.ownerMatches ? fixture.context.ownerMatches : [{ Id: recordId, ...stored }], candidates: fixture.candidates ?? [], material: fixture.material ?? null };
      });
    }
    for (const tool of [new dataProvider.DescribeSobjectMcpTool(new dataProvider.DescribeSobjectExecutor(org)), new dml.CreateRecordMcpTool(executor), new dml.UpdateRecordMcpTool(executor)]) {
      const cfg = tool.getConfig();
      server.registerTool(tool.getName(), { description: cfg.description, inputSchema: cfg.inputSchema, outputSchema: cfg.outputSchema, annotations: cfg.annotations }, async args => {
        await log(tool.getName(), args); return tool.exec(args);
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res); }
    catch { if (!res.headersSent) res.writeHead(500).end('Mock MCP request failed'); }
  });
  await new Promise((done, fail) => { http.once('error', fail); http.listen(port, '127.0.0.1', done); });
  const address = http.address();
  assert.ok(address && typeof address === 'object');
  return { endpoint: `http://127.0.0.1:${address.port}/mcp`, calls, dispatches, close: () => new Promise(done => http.close(done)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  if (value('--prepare')) console.log(JSON.stringify(await prepareEvaluation(value('--prepare'), value('--source-root') ?? root), null, 2));
  else if (value('--serve')) {
    const mock = await serveFixture({ caseId: value('--serve'), sourceRoot: value('--source-root') ?? root, tracePath: value('--trace'), port: value('--port') ? Number(value('--port')) : 0 });
    console.log(JSON.stringify({ status: 'MOCK_ONLY', endpoint: mock.endpoint, caseId: value('--serve'), requester: 'none' }));
    process.once('SIGINT', () => { void mock.close(); });
  } else if (value('--captures')) {
    const capture = JSON.parse(await readFile(value('--captures'), 'utf8'));
    const results = businessCases.map(fixture => evaluateCapture(fixture, { ...capture, ...capture.cases?.find(item => item.id === fixture.id) }));
    const report = { evidence: 'Captured results require actual run/model/context provenance and independent semantic review', results };
    if (value('--out')) await writeFile(value('--out'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (results.some(item => item.businessAcceptance !== 'PASS')) process.exitCode = 1;
  } else console.log('Use --prepare <dir> [--source-root <checkout>], --serve <case-id> [--trace <jsonl>], or --captures <json> [--out <json>]. No model, Salesforce endpoint or WeCom requester is fabricated.');
}
