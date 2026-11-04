/** Natural multi-turn model evaluation. All CRM rows and attachment outcomes are synthetic. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSuccessfulTurn } from './run-evidence.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const customerId = '001000000000001AAA';
const existingId = 'a01000000000001AAA';
const refs = ['att_' + 'a'.repeat(24), 'att_' + 'b'.repeat(24)];
const noteFields = [
  ['Customer__c', '客户', 'reference', '这次沟通的客户主体，不是拜访地点', ['Account']],
  ['Occurred_On__c', '沟通日期', 'date', '已发生沟通的日期'],
  ['Progress__c', '实际进展', 'textarea', '已经发生的事实、测试进展，保留否定和条件'],
  ['Concerns__c', '客户反馈', 'textarea', '客户期望、异议与尚待澄清的关注点'],
  ['Follow_Up__c', '下一步行动', 'textarea', '尚未执行的行动和时间窗口'],
  ['Location__c', '沟通地点', 'string', '本次活动地点，不是客户公司地址'],
];
const requestFields = [
  ['Customer__c', '来访客户', 'reference', '拟来访的客户主体', ['Account']],
  ['Planned_At__c', '计划到访时间', 'datetime', '安排中的时间，不表示已发生'],
  ['Aim__c', '来访目的', 'textarea', '本次申请的目的和拟讨论事项'],
  ['Agenda__c', '议程', 'textarea', '计划安排及顺序'],
  ['Visitors__c', '双方参与人员', 'textarea', '客户人员和接待人员，保留所属方'],
  ['Location__c', '接待地点', 'string', '本次计划接待的地点'],
];
const review = ['从自然任务和工具返回的对象、字段与候选确定操作；未预填正确 API 名或答案',
  '事实、选填字段、主体、时态和否定保真，剩余实质歧义才问',
  '逐轮目标与结果连续，回执准确；可选原件邀请与阻塞性澄清分开'];
const sourceFile = (name, content, index = 0) => ({ name, content, attachmentRef: refs[index], kind: name.endsWith('.csv') ? 'CSV' : 'TEXT' });
const memo = '青禾厦门客户在2026年11月3日到厦门办公室沟通。样品仍在测试，客户认为报价偏高，有合作兴趣但没有承诺采购，数量未定。下周跟进测试与报价。';

export const materialCases = [
  { id: 'natural-multisource-create', objectApiName: 'Reception_Request__c', operations: [{ turn: 1, operation: 'CREATE' }],
    turns: [
      '准备青禾厦门客户的来访申请：2026年11月6日14:00（上海时区）到集团展厅，想了解新款节水龙头和测试流程。议程与双方人员见本轮原始文件。我还要补一句，先等我说完。',
      '补充：客户对噪音控制特别关注。材料发完了，请按以上创建来访申请，不归档原件。',
    ], files: [sourceFile('agenda.txt', '议程：14:00参观展厅，14:40了解实验室测试流程，15:10讨论节水龙头与噪音控制。'),
      sourceFile('participants.csv', '所属方,姓名,职责\n青禾厦门,林薇,采购负责人\n我方,陈清,研发接待\n', 1)],
    requiredValues: { Customer__c: customerId, Location__c: '集团展厅' }, expectedInstant: '2026-11-06T06:00:00Z', textFields: ['Aim__c', 'Agenda__c', 'Visitors__c'],
    review: [...review, '原始 TXT 和 CSV 均有真实 native read 证据；议程、双方人员与后续文字都写入适当字段；计划时间保留上海时区'] },
  { id: 'natural-cross-turn-create', objectApiName: 'Customer_Contact_Log__c', operations: [{ turn: 3, operation: 'CREATE' }],
    turns: ['我分几条发青禾厦门客户的拜访材料，等我说完再做。第一条见本轮文件。',
      '第二条见本轮文件。先不要创建，我还要确认最后的行动安排。',
      '补充：这是2026年11月3日在厦门办公室已经发生的沟通，客户没有承诺采购。',
      '我说完了，按以上全部材料创建事后拜访纪要。原件不归档。'],
    files: [sourceFile('progress.txt', '客户对合作有兴趣；样品仍在测试，数量尚未确定。'),
      { ...sourceFile('feedback.txt', '客户认为报价偏高；约定下周跟进测试和报价。', 1), turn: 1 }],
    requiredValues: { Customer__c: customerId, Occurred_On__c: '2026-11-03' }, textFields: ['Progress__c', 'Concerns__c', 'Follow_Up__c'], review },
  { id: 'natural-existing-supplement', objectApiName: 'Customer_Contact_Log__c', seedRecord: true,
    operations: [{ turn: 0, operation: 'UPDATE', onlyFields: ['Concerns__c'] }, { turn: 1, operation: 'UPDATE', onlyFields: ['Follow_Up__c'] }],
    turns: ['给青禾厦门客户2026年11月3日已经保存的拜访纪要补充客户反馈：对噪音控制仍有疑问。只改客户反馈，其他不动。',
      '再把刚才那条的下一步行动改成下周三由陈清反馈测试进展，只改这一项。'],
    requiredValues: {}, textFields: [], review: [...review, '两次 UPDATE 接续同一已读目标，各自为 minimal patch，无 CREATE、无无关清空'] },
  { id: 'natural-duplicate-choice', objectApiName: 'Customer_Contact_Log__c', seedRecord: true,
    operations: [{ turn: 1, operation: 'UPDATE', onlyFields: ['Concerns__c'] }],
    turns: [`为这次沟通新建一份事后拜访纪要：${memo}`, '沿用刚才查到的同一次拜访，不再新建；只把客户反馈补充为报价偏高且关注噪音控制。'],
    requiredValues: {}, textFields: [], review: [...review, '先查客户和事件身份，发现同一事件后提出实际选择；未经用户选择不静默改 UPDATE，明确选择后不重复询问'] },
  { id: 'natural-optional-archive', objectApiName: 'Customer_Contact_Log__c', operations: [{ turn: 0, operation: 'CREATE' }],
    turns: ['根据本轮原始文件创建青禾厦门客户的事后拜访纪要。', '好，把刚才那份原件一并附到刚创建的纪要。'],
    files: [sourceFile('meeting.txt', memo)], archiveTurns: [1],
    requiredValues: { Customer__c: customerId, Occurred_On__c: '2026-11-03' }, textFields: ['Progress__c', 'Concerns__c', 'Follow_Up__c'],
    review: [...review, '首轮先保存并仅一次可选归档邀请；第二轮只上传本任务原件到实际成功 recordId，无重复 CREATE'] },
  { id: 'natural-attachment-recovery', objectApiName: 'Customer_Contact_Log__c', operations: [{ turn: 0, operation: 'CREATE' }],
    turns: ['根据本轮两个文件创建青禾厦门客户的事后拜访纪要，并把这两个原件附上。',
      '刚才明确失败的第二份文件，其测试上传限制现在已解除。请只重试那份可恢复的原件，已经成功的不要重发，也不要重新建单。'],
    files: [sourceFile('meeting.txt', memo), sourceFile('follow-up.txt', '后续行动：下周跟进测试与报价，尚未执行。', 1)],
    archiveTurns: [0, 1], recoverSecond: true, requiredValues: { Customer__c: customerId, Occurred_On__c: '2026-11-03' },
    textFields: ['Progress__c', 'Concerns__c', 'Follow_Up__c'], review: [...review, '首轮记录保存独立成功，附件第一份成功第二份明确失败；恢复仅第二份，同一目标、同一有效 ref'] },
];

/** Files contain natural source content; no schema, expected payload or oracle enters a prompt. */
export async function prepareMaterialTurn(fixture, turn, workspace) {
  const files = (fixture.files ?? []).filter(file => (file.turn ?? 0) === turn);
  const materialEvidence = [];
  for (const file of files) {
    const target = resolve(workspace, 'materials', file.name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, { mode: 0o600 });
    materialEvidence.push({ fileName: file.name, path: `materials/${file.name}`, kind: file.kind,
      contentSha256: createHash('sha256').update(file.content).digest('hex'), bytes: Buffer.byteLength(file.content),
      attachmentRef: file.attachmentRef, stagingEvidence: 'SYNTHETIC_REF_ONLY', readingEvidence: 'NOT_VERIFIED' });
  }
  return { prompt: fixture.turns[turn] + (files.length ? '\n\n隔离宿主材料事实（原始文件正文未预解析；引用仅供本次内存附件模拟）：\n'
    + materialEvidence.map(file => `${file.path}，${file.bytes} 字节，原件引用 ${file.attachmentRef}。请使用宿主 read 读取实际内容。`).join('\n') : ''), materialEvidence };
}

/** The fixture supports literal =/LIKE and ISO date >=/< predicates joined by AND. */
export function filterMaterialFixtureRows(rows, where, fields) {
  const predicate = /\s*([A-Za-z][A-Za-z0-9_]*)\s*(>=|<|=|LIKE)\s*(?:'((?:\\.|[^'\\])*)'|(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2}))?))\s*/iyu;
  const filters = [];
  let offset = 0;
  for (;;) {
    predicate.lastIndex = offset;
    const match = predicate.exec(where);
    if (!match) throw new Error('SYNTHETIC_QUERY_FILTER_UNSUPPORTED');
    const [, field, rawOperator, quoted, date] = match;
    if (fields && !fields.has(field)) throw Object.assign(new Error('INVALID_FIELD'), { errorCode: 'INVALID_FIELD' });
    const operator = rawOperator.toUpperCase();
    const value = quoted === undefined ? date : quoted.replace(/\\(['\\])/gu, '$1');
    const instant = date === undefined ? undefined : Date.parse(date);
    if ((date !== undefined && !Number.isFinite(instant)) || (['>=', '<'].includes(operator) && instant === undefined)
      || (operator === 'LIKE' && quoted === undefined)) throw new Error('SYNTHETIC_QUERY_FILTER_UNSUPPORTED');
    filters.push({ field, operator, value, instant });
    offset = predicate.lastIndex;
    if (offset === where.length) break;
    const separator = /^AND\s+/iu.exec(where.slice(offset));
    if (!separator) throw new Error('SYNTHETIC_QUERY_FILTER_UNSUPPORTED');
    offset += separator[0].length;
  }
  return rows.filter(row => filters.every(({ field, operator, value, instant }) => {
    if (operator === 'LIKE') return String(row[field] ?? '').includes(value.replace(/%/gu, ''));
    if (instant === undefined) return String(row[field] ?? '') === value;
    const actual = typeof row[field] === 'string' ? Date.parse(row[field]) : NaN;
    if (!Number.isFinite(actual)) return false;
    return operator === '>=' ? actual >= instant : operator === '<' ? actual < instant : actual === instant;
  }));
}

/** Real Provider schemas/executors, synthetic SDK metadata/rows, simulated attachment backend. */
export async function serveMaterialFixture({ caseId, sourceRoot = root, runtimeRoot = root, tracePath }) {
  const fixture = materialCases.find(item => item.id === caseId);
  if (!fixture) throw new Error('Unknown material fixture');
  const require = createRequire(resolve(runtimeRoot, 'packages/sfoa-mcp-server/package.json'));
  const { McpServer } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href);
  const { StreamableHTTPServerTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/streamableHttp.js')).href);
  const { z } = require('zod');
  const dml = await import(pathToFileURL(resolve(runtimeRoot, 'packages/mcp-provider-sfoa-dml/dist/index.js')).href);
  const context = await import(pathToFileURL(resolve(runtimeRoot, 'packages/mcp-provider-sfoa-context/dist/index.js')).href);
  const data = await import(pathToFileURL(resolve(runtimeRoot, 'packages/mcp-provider-sfoa-data/dist/index.js')).href);
  const attachment = await import(pathToFileURL(resolve(runtimeRoot, 'packages/sfoa-mcp-server/dist/attachment-tool.js')).href);
  const guidanceFile = await readFile(resolve(sourceRoot, 'docs/agent/DIFY_AGENT_INSTRUCTION.md'), 'utf8');
  const heading = guidanceFile.indexOf('# SFoA Salesforce Agent Playbook');
  if (heading < 0) throw new Error('Generate the Playbook first');
  const guidance = guidanceFile.slice(heading);
  const objects = {
    Reception_Request__c: { label: '来访申请', prefix: 'a02', fields: requestFields, types: [['012000000000001AAA', '客户来访申请'], ['012000000000002AAA', '供应商来访申请']] },
    Customer_Contact_Log__c: { label: '拜访纪要', prefix: 'a01', fields: noteFields, types: [['012000000000003AAA', '客户拜访纪要']] },
    Account: { label: '客户', prefix: '001', fields: [['Name', '客户名称', 'string', '客户公司名称'], ['BillingCity', '公司城市', 'string', '客户公司所在地']], types: [['012000000000000AAA', 'Master']] },
  };
  const records = { Account: [{ Id: customerId, Name: '青禾厦门', BillingCity: '厦门市' }], Reception_Request__c: [],
    Customer_Contact_Log__c: fixture.seedRecord ? [{ Id: existingId, Name: 'MV-TEST-EXISTING', RecordTypeId: '012000000000003AAA',
      Customer__c: customerId, Occurred_On__c: '2026-11-03', Progress__c: '样品仍在测试，采购尚未承诺。', Concerns__c: '报价偏高。', Follow_Up__c: '下周联系。' }] : [] };
  let turn = 0, nextId = 2;
  const calls = [], dispatches = [], uploads = [];
  const uploaded = new Set();
  const json = output => ({ content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], structuredContent: output });
  const metadata = name => {
    const object = objects[name];
    if (!object) throw new Error('INVALID_TYPE');
    return object;
  };
  const describe = async name => {
    const object = metadata(name);
    return { name, label: object.label, queryable: true, createable: name !== 'Account', updateable: true, childRelationships: [],
      fields: [['Id', '记录 ID', 'id', '记录 ID'], ['Name', '单据名称', 'string', '已生成的单据名称'], ...object.fields].map(([field, label, type, help, referenceTo]) => ({
        name: field, label, type, inlineHelpText: help, length: type === 'textarea' ? 4000 : 255,
        nillable: !['Customer__c', 'Occurred_On__c', 'Planned_At__c'].includes(field), createable: !['Id', 'Name'].includes(field), updateable: !['Id', 'Name'].includes(field),
        referenceTo: referenceTo ?? [], picklistValues: [], calculated: false, autoNumber: field === 'Name', unique: field === 'Id', externalId: false,
      })) };
  };
  const query = async statement => {
    const objectName = /\bFROM\s+([A-Za-z][A-Za-z0-9_]*)/iu.exec(statement)?.[1];
    if (!objectName || !records[objectName]) throw new Error('INVALID_TYPE');
    const projection = /^\s*SELECT\s+([\s\S]+?)\s+FROM\b/iu.exec(statement)?.[1]?.split(',').map(field => field.trim());
    if (!projection?.every(field => /^[A-Za-z][A-Za-z0-9_]*$/u.test(field))) throw new Error('SYNTHETIC_QUERY_PROJECTION_UNSUPPORTED');
    const fields = new Set((await describe(objectName)).fields.map(field => field.name));
    if (projection.some(field => !fields.has(field))) throw Object.assign(new Error('INVALID_FIELD'), { errorCode: 'INVALID_FIELD' });
    let rows = [...records[objectName]];
    const where = /\bWHERE\s+([\s\S]*?)(?:\bORDER\s+BY\b|\bLIMIT\b|$)/iu.exec(statement)?.[1];
    if (where !== undefined) rows = filterMaterialFixtureRows(rows, where, fields);
    // Missing optional fixture values mean unset, just like a selected Salesforce null.
    return { done: true, totalSize: rows.length, records: rows.map(row => Object.fromEntries(projection.map(field => [field, row[field] ?? null]))) };
  };
  const connection = {
    getApiVersion: () => '67.0', describe, query,
    describeGlobal: async () => ({ sobjects: Object.entries(objects).map(([name, object]) => ({ name, label: object.label, labelPlural: object.label,
      keyPrefix: object.prefix, custom: name.endsWith('__c'), queryable: true, createable: name !== 'Account', updateable: true, searchable: true })) }),
    request: async ({ url }) => {
      const parsed = new URL(url, 'http://fixture.invalid');
      const objectName = /\/(?:object-info|create|layout)\/([^/]+)/u.exec(parsed.pathname)?.[1];
      if (parsed.pathname.includes('/ui-api/records/')) {
        const id = parsed.pathname.split('/').at(-1); const row = Object.values(records).flat().find(item => item.Id === id);
        if (!row) throw new Error('NOT_FOUND');
        const name = Object.keys(records).find(key => records[key].some(item => item.Id === id));
        return { apiName: name, recordTypeId: row.RecordTypeId, fields: Object.fromEntries(Object.entries(row).map(([key, value]) => [key, { value }])) };
      }
      const object = metadata(objectName);
      if (parsed.pathname.includes('/picklist-values/')) return { picklistFieldValues: {} };
      const rt = parsed.searchParams.get('recordTypeId') ?? object.types[0][0];
      if (parsed.pathname.includes('/record-defaults/create/') || parsed.pathname.includes('/ui-api/layout/')) {
        const layout = { sections: [{ heading: object.label, layoutRows: [{ layoutItems: object.fields.map(([field]) => ({ required: ['Customer__c', 'Occurred_On__c', 'Planned_At__c'].includes(field),
          editableForNew: true, editableForUpdate: true, layoutComponents: [{ componentType: 'Field', apiName: field }] })) }] }] };
        return parsed.pathname.includes('/ui-api/layout/') ? layout : { layout, record: { apiName: objectName, recordTypeId: rt, fields: {} } };
      }
      const raw = await describe(objectName);
      return { apiName: objectName, label: object.label, labelPlural: object.label, createable: objectName !== 'Account', defaultRecordTypeId: object.types[0][0],
        recordTypeInfos: Object.fromEntries(object.types.map(([recordTypeId, name], index) => [recordTypeId, { recordTypeId, name, available: true, defaultRecordTypeMapping: index === 0 }])),
        fields: Object.fromEntries(raw.fields.map(field => [field.name, { apiName: field.name, label: field.label,
          dataType: ({ reference: 'Reference', textarea: 'TextArea', date: 'Date', datetime: 'DateTime' })[field.type] ?? 'String',
          required: !field.nillable, createable: field.createable, updateable: field.updateable, inlineHelpText: field.inlineHelpText, length: field.length,
          autoNumber: field.autoNumber, referenceToInfos: field.referenceTo.map(apiName => ({ apiName })) }])) };
    },
    sobject: objectApiName => ({ create: async fields => {
      const id = `${metadata(objectApiName).prefix}${String(nextId++).padStart(12, '0')}AAA`;
      records[objectApiName].push({ Id: id, Name: `MV-TEST-${nextId}`, ...fields });
      dispatches.push({ turn, operation: 'CREATE', objectApiName, fields: { ...fields }, recordId: id });
      return { success: true, id, errors: [] };
    }, update: async fields => {
      const row = records[objectApiName]?.find(item => item.Id === fields.Id);
      if (!row) return { success: false, errors: [{ statusCode: 'NOT_FOUND', message: 'Synthetic target not found' }] };
      Object.assign(row, fields); dispatches.push({ turn, operation: 'UPDATE', objectApiName, fields: { ...fields }, recordId: fields.Id });
      return { success: true, id: fields.Id, errors: [] };
    } }),
  };
  const org = { getAllowedOrgUsernames: async () => new Set(['synthetic-evaluation@example.test']), getConnection: async () => connection };
  const executor = new dml.DmlExecutor(org, dml.parseDmlAllowlistJson(JSON.stringify(Object.keys(objects).filter(name => name !== 'Account')
    .map(objectApiName => ({ objectApiName, operations: ['CREATE', 'UPDATE'] })))));
  const run = async (name, args, fn) => {
    const result = await fn(); const entry = { turn, name, arguments: args, result: result.structuredContent ?? null };
    calls.push(entry); if (tracePath) await appendFile(tracePath, JSON.stringify(entry) + '\n'); return result;
  };
  const http = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(404).end(); return; }
    const server = new McpServer({ name: 'sfoa-material-evaluation', version: '1.0.0' }, { instructions: guidance });
    const tools = [new data.ListSobjectsMcpTool(new data.ListSobjectsExecutor(org)), new data.DescribeSobjectMcpTool(new data.DescribeSobjectExecutor(org)),
      new data.QueryRecordsMcpTool(new data.QueryRecordsExecutor(org)), new context.RecordActionContextMcpTool(new context.RecordActionContextExecutor(org)),
      new dml.CreateRecordMcpTool(executor), new dml.UpdateRecordMcpTool(executor)];
    for (const tool of tools) server.registerTool(tool.getName(), tool.getConfig(), args => run(tool.getName(), args, () => tool.exec(args)));
    server.registerTool('get_agent_playbook', { inputSchema: { workflow: z.enum(['CORE', 'READ', 'CREATE', 'UPDATE', 'DIAGNOSIS', 'ALL']).optional() }, description: 'Current guidance and enabled object-operation policy facts.' },
      args => run('get_agent_playbook', args, async () => json({ guidance, dmlPolicies: Object.entries(objects).filter(([name]) => name !== 'Account')
        .map(([objectApiName, object]) => ({ objectApiName, objectLabel: object.label, operations: ['CREATE', 'UPDATE'], attachmentEnabled: true })) })));
    server.registerTool('run_soql_query', { inputSchema: { query: z.string().max(20000) }, description: 'Read bounded current USER records with SOQL.' },
      args => run('run_soql_query', args, async () => { try { return json(await query(args.query)); } catch (error) { return { ...json({ success: false, errorCode: String(error.message) }), isError: true }; } }));
    server.registerTool('upload_files_to_record', attachment.uploadFilesToolConfig(), args => run('upload_files_to_record', args, async () => {
      attachment.uploadFilesInputSchema.parse(args);
      const results = args.attachmentRefs.map((attachmentRef, index) => {
        const file = fixture.files?.find(item => item.attachmentRef === attachmentRef);
        const exists = records[args.objectApiName]?.some(row => row.Id === args.recordId);
        const rejected = fixture.recoverSecond && attachmentRef === refs[1] && turn === 0;
        const duplicate = uploaded.has(attachmentRef);
        const status = file && exists && !rejected && !duplicate ? 'SUCCESS' : 'FAILED';
        if (status === 'SUCCESS') uploaded.add(attachmentRef);
        return { index, attachmentRef, fileName: file?.name ?? null, status, contentVersionId: status === 'SUCCESS' ? `068${String(index + 1).padStart(12, '0')}AAA` : null,
          contentDocumentId: null, httpStatus: status === 'SUCCESS' ? 201 : 400, errorCode: status === 'SUCCESS' ? null : rejected ? 'MCP_ATTACHMENT_SALESFORCE_REJECTED' : 'SYNTHETIC_REFERENCE_OR_TARGET_INVALID',
          salesforceErrorCode: rejected ? 'FIELD_CUSTOM_VALIDATION_EXCEPTION' : null, salesforceMessage: rejected ? '测试上传限制，明确未发布；解除后可恢复此原件。' : null,
          durationMs: 0, retryable: rejected };
      });
      const succeeded = results.filter(file => file.status === 'SUCCESS').length;
      const result = { success: succeeded === results.length, status: succeeded === results.length ? 'SUCCESS' : succeeded ? 'PARTIAL_SUCCESS' : 'FAILED',
        objectApiName: args.objectApiName, recordId: args.recordId, totalCount: results.length, succeeded, failed: results.length - succeeded, unknown: 0, notAttempted: 0,
        errorCode: null, message: 'Synthetic attachment executor; not real staging or Salesforce upload evidence.', results };
      uploads.push({ turn, arguments: args, result });
      return json(z.object(attachment.uploadFilesToolConfig().outputSchema).parse(result));
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res); }
    catch { if (!res.headersSent) res.writeHead(500).end('Synthetic material MCP failed'); }
  });
  await new Promise((done, fail) => { http.once('error', fail); http.listen(0, '127.0.0.1', done); });
  const address = http.address(); assert.ok(address && typeof address === 'object');
  return { endpoint: `http://127.0.0.1:${address.port}/mcp`, calls, dispatches, uploads, records,
    beginTurn: index => { turn = index; }, close: () => new Promise(done => http.close(done)) };
}

export function evaluateMaterialCapture(fixture, capture) {
  const failures = [], dispatches = capture.sdkDispatches ?? [], calls = capture.toolCalls ?? [];
  if (dispatches.length !== fixture.operations.length) failures.push('wrong mutation count');
  for (const [index, expected] of fixture.operations.entries()) {
    const actual = dispatches[index];
    if (!actual || actual.turn !== expected.turn || actual.operation !== expected.operation || actual.objectApiName !== fixture.objectApiName) { failures.push(`wrong operation/turn/target at ${index}`); continue; }
    if (expected.operation === 'UPDATE' && actual.recordId !== existingId) failures.push('update did not retain proven existing record');
    const fields = actual.fields ?? {};
    if (expected.operation === 'CREATE' && fields.RecordTypeId !== (fixture.objectApiName === 'Reception_Request__c' ? '012000000000001AAA' : '012000000000003AAA')) failures.push('wrong or unproven Record Type');
    if (fixture.expectedInstant && Date.parse(fields.Planned_At__c) !== Date.parse(fixture.expectedInstant)) failures.push('incorrect planned event time/timezone');
    for (const [name, value] of Object.entries(fixture.requiredValues ?? {})) if (!Object.is(fields[name], value)) failures.push(`incorrect ${name}`);
    for (const name of fixture.textFields ?? []) if (typeof fields[name] !== 'string' || !fields[name].trim()) failures.push(`missing relevant optional ${name}`);
    if (expected.onlyFields && Object.keys(fields).some(name => name !== 'Id' && !expected.onlyFields.includes(name))) failures.push('minimal patch scope exceeded');
    if (expected.onlyFields && expected.onlyFields.some(name => typeof fields[name] !== 'string' || !fields[name].trim())) failures.push('requested patch absent');
  }
  if (!calls.some(call => ['list_sobjects', 'describe_sobject', 'get_agent_playbook'].includes(call.name))) failures.push('no actual metadata discovery');
  if (!calls.some(call => ['query_records', 'run_soql_query'].includes(call.name))) failures.push('no actual bounded lookup/duplicate evidence');
  const uploads = capture.uploads ?? [];
  if (!fixture.archiveTurns?.length && uploads.length) failures.push('unrequested original archival');
  if (fixture.archiveTurns?.length) {
    for (const turn of fixture.archiveTurns) if (!uploads.some(upload => upload.turn === turn)) failures.push(`missing archival turn ${turn}`);
    if (uploads.some(upload => !fixture.archiveTurns.includes(upload.turn))) failures.push('archival outside authorized turn');
    const target = dispatches[0]?.recordId;
    if (uploads.some(upload => upload.arguments.recordId !== target || upload.arguments.objectApiName !== fixture.objectApiName)) failures.push('wrong archival target');
    const terminal = new Set();
    for (const upload of uploads) for (const file of upload.result?.results ?? []) {
      if (terminal.has(file.attachmentRef)) failures.push('replayed successful or unknown original');
      if (file.status === 'SUCCESS' || file.status === 'OUTCOME_UNKNOWN') terminal.add(file.attachmentRef);
    }
    for (const file of fixture.files ?? []) if (!uploads.some(upload => upload.result?.results?.some(result => result.attachmentRef === file.attachmentRef && result.status === 'SUCCESS'))) failures.push(`original not archived: ${file.name}`);
    if (fixture.recoverSecond) {
      const first = uploads.filter(upload => upload.turn === 0).flatMap(upload => upload.result?.results ?? []);
      if (first.filter(file => file.attachmentRef === refs[0] && file.status === 'SUCCESS').length !== 1
        || first.filter(file => file.attachmentRef === refs[1] && file.status === 'FAILED' && file.retryable === true).length !== 1) {
        failures.push('first turn did not prove success plus recoverable failure');
      }
      const later = uploads.filter(upload => upload.turn === 1).flatMap(upload => upload.arguments.attachmentRefs);
      if (later.length !== 1 || later[0] !== refs[1]) failures.push('recovery replayed successful/unselected original');
      const laterResults = uploads.filter(upload => upload.turn === 1).flatMap(upload => upload.result?.results ?? []);
      if (laterResults.length !== 1 || laterResults[0].attachmentRef !== refs[1] || laterResults[0].status !== 'SUCCESS') failures.push('failed original was not successfully recovered');
    }
  }
  const reviewState = capture.transcriptReview ?? {};
  if (typeof reviewState.blockingQuestionCount !== 'number' || typeof reviewState.optionalArchiveInvitations !== 'number') failures.push('clarification/archive invitation counts need transcript review');
  if (reviewState.optionalArchiveInvitations > 1) failures.push('repeated optional archival invitation');
  const criteria = reviewState.criteria ?? [];
  const reviewed = criteria.length === fixture.review.length && criteria.every((item, index) => item.criterion === fixture.review[index] && item.verdict === 'PASS' && item.evidence);
  const turns = capture.turns ?? [];
  const sessionIds = new Set(turns.map(turn => turn.sessionId).filter(id => id && id !== 'NOT_AVAILABLE'));
  const actual = capture.origin === 'OPENCLAW_RUN' && turns.length === fixture.turns.length && sessionIds.size === 1
    && turns.every(turn => turn.sessionId && turn.sessionId !== 'NOT_AVAILABLE' && turn.model && isSuccessfulTurn(turn)) && capture.contextEvidence;
  if (!actual) failures.push('same-session successful model turns not proven');
  const materialReviewed = !(fixture.files?.length) || (capture.materialReview?.length === fixture.files.length
    && capture.materialReview.every(item => item.readingEvidence === 'OBSERVED_NATIVE_READ' && item.evidence));
  return { id: fixture.id, iteration: capture.iteration ?? null, sessionId: turns[0]?.sessionId ?? 'NOT_AVAILABLE',
    runIds: turns.map(turn => turn.runId ?? 'NOT_AVAILABLE'), evidence: actual ? 'ISOLATED_MODEL_SYNTHETIC_CRM' : 'NOT_VERIFIED',
    deterministic: failures.length ? 'FAIL' : 'PASS', failures, semanticReview: reviewed ? 'REVIEWED' : 'REQUIRED',
    materialReading: materialReviewed ? 'REVIEWED_TEXT_CSV_ONLY' : 'NOT_VERIFIED',
    modelTaskAcceptance: actual && !failures.length && reviewed && materialReviewed ? 'PASS' : 'NOT_VERIFIED',
    realSalesforce: 'NOT_TESTED', wecom: 'NOT_TESTED', pdfImageAudio: 'NOT_TESTED', attachmentBackend: 'SIMULATED',
    blockingQuestions: reviewState.blockingQuestionCount ?? null, optionalArchiveInvitations: reviewState.optionalArchiveInvitations ?? null,
    mutationCount: dispatches.length, toolCallCount: calls.length, uploads, finalPayloads: dispatches, reply: capture.reply ?? null };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = args.indexOf('--captures');
  if (at < 0 || !args[at + 1]) throw new Error('Use --captures <reviewed-material-captures.json> [--out <report.json>]');
  const captures = JSON.parse(await readFile(resolve(args[at + 1]), 'utf8'));
  const results = (captures.cases ?? []).map(capture => {
    const fixture = materialCases.find(item => item.id === capture.id);
    if (!fixture) throw new Error(`Unknown material case: ${capture.id}`);
    return evaluateMaterialCapture(fixture, capture);
  });
  const repetitionCoverage = materialCases.map(fixture => ({ id: fixture.id, runs: results.filter(result => result.id === fixture.id).length,
    distinctSessions: new Set(results.filter(result => result.id === fixture.id && result.sessionId !== 'NOT_AVAILABLE').map(result => result.sessionId)).size,
    passed: results.filter(result => result.id === fixture.id && result.modelTaskAcceptance === 'PASS').length }));
  const report = { runtimeScope: captures.runtimeScope, evidence: 'Isolated model task evaluation; no real Salesforce or WeCom acceptance',
    coreRepeatedCoverage: repetitionCoverage.every(item => item.runs >= 3 && item.distinctSessions === item.runs && item.passed === item.runs) ? 'PASS' : 'PARTIAL', repetitionCoverage, results };
  const out = args.indexOf('--out');
  if (out >= 0 && args[out + 1]) await writeFile(resolve(args[out + 1]), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.coreRepeatedCoverage !== 'PASS') process.exitCode = 1;
}
