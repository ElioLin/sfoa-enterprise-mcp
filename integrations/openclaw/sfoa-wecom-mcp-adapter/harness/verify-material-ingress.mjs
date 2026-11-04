#!/usr/bin/env node
/** Original-file integration probe. No model run, channel delivery or Salesforce DML. */
import { readFile, writeFile, mkdir, readdir, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, args) => {
  if (index % 2 === 0) pairs.push([arg.replace(/^--/, ''), args[index + 1]]);
  return pairs;
}, []));
for (const name of ['config', 'plugin-root', 'fixtures', 'requester', 'output']) {
  if (!options[name] || options[name].startsWith('--')) throw new Error(`Missing --${name}`);
}
const output = path.resolve(options.output);
await mkdir(output, { recursive: false, mode: 0o700 });
const config = JSON.parse(await readFile(options.config, 'utf8'));
const pluginConfig = config.plugins?.entries?.['sfoa-wecom-mcp-adapter']?.config;
if (pluginConfig?.attachmentBridgeEnabled !== true) throw new Error('Actual attachment bridge is not enabled');
const root = path.resolve(options['plugin-root']);
const source = (name) => pathToFileURL(path.join(root, 'src', name)).href;
const { default: plugin } = await import(source('index.js'));
const { normalizeStagedMediaRoots } = await import(source('attachments.js'));
const mediaRoots = normalizeStagedMediaRoots({ mediaRoot: pluginConfig.attachmentMediaRoot, mediaRoots: pluginConfig.attachmentMediaRoots });
if (!mediaRoots.length) throw new Error('No actual trusted staging root');
const runId = `material-verify-${randomUUID()}`;
const staging = path.join(mediaRoots[0], runId);
await mkdir(staging, { recursive: true, mode: 0o700 });
const hashes = {};
for (const name of ['index.js', 'attachments.js', 'material-tasks.js', 'material-reader.js', 'read-office.py']) {
  hashes[name] = createHash('sha256').update(await readFile(path.join(root, 'src', name))).digest('hex');
}
const mime = { '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.m4a': 'audio/mp4', '.amr': 'audio/amr', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
const files = [];
for (const entry of await readdir(options.fixtures, { withFileTypes: true })) {
  if (!entry.isFile() || !mime[path.extname(entry.name).toLowerCase()]) continue;
  const from = path.join(options.fixtures, entry.name);
  const to = path.join(staging, entry.name);
  await copyFile(from, to);
  files.push({ name: entry.name, path: to, contentType: mime[path.extname(entry.name).toLowerCase()],
    byteSize: (await stat(to)).size, sha256: createHash('sha256').update(await readFile(to)).digest('hex') });
}
if (!files.length) throw new Error('No supported original fixtures');

// This is explicitly a test-owned store. It never opens the main Agent's state.
const data = new Map();
const store = { lookup: async (key) => data.get(key), register: async (key, value) => data.set(key, structuredClone(value)),
  entries: async () => [...data].map(([key, value]) => ({ key, value })), delete: async (key) => data.delete(key) };
const hooks = new Map();
const tools = new Map();
const logs = [];
plugin.register({ config, pluginConfig, runtime: { state: { openKeyedStore: () => store } },
  logger: { info: () => {}, debug: () => {}, warn: (message) => {
    // Never retain arbitrary SDK/config error messages or credentials.
    logs.push({ warning: true, code: /code=([A-Z0-9_]+)/u.exec(message)?.[1] ?? 'ADAPTER_WARNING' });
  } }, registerMcpServerConnectionResolver() {}, on: (name, handler) => hooks.set(name, handler),
  registerTool: (factory, details) => tools.set(details.name, factory) });
const accountId = options.account ?? 'default';
const sessionKey = `agent:main:${runId}`;
const senderId = options.requester;
const hookContext = { channelId: 'wecom', accountId, sessionKey, runId, senderId };
const promptContext = { channel: 'wecom', accountId, sessionKey, runId, senderId };
const batches = [];
for (let index = 0; index < files.length; index += 10) {
  const group = files.slice(index, index + 10);
  const messageId = `${runId}-${index}`;
  await hooks.get('message_received')({ senderId, sessionKey, runId, messageId,
    content: '合成验收材料，分批收集，不执行任何 Salesforce 写入。',
    media: group.map((file) => ({ path: file.path, contentType: file.contentType, messageId })) }, hookContext);
  const injected = await hooks.get('before_prompt_build')({ prompt: '', currentUserMessageId: messageId, messages: [] }, promptContext);
  batches.push({ messageId, supplied: group.length, contextInjected: typeof injected?.appendContext === 'string',
    injectedCharacters: injected?.appendContext?.length ?? 0 });
}
await hooks.get('message_received')({ senderId, sessionKey, runId, messageId: `${runId}-confirm`, content: '材料发完了；本次只验证读取，不建单。' }, hookContext);
const tool = tools.get('sfoa_material_task')?.({ messageChannel: 'wecom', agentAccountId: accountId, requesterSenderId: senderId, sessionKey });
if (!tool) throw new Error('Task note tool unavailable with configured requester context');
const inspected = await tool.execute('material-inspect', { operation: 'inspect' });
const task = inspected.details;
const nativeReads = [];
const asr = config.tools?.media?.models?.find((item) => item.type === 'cli' && item.capabilities?.includes('audio'));
for (const file of files) {
  if (file.contentType === 'application/pdf') {
    try {
      const { stdout } = await exec('/usr/bin/pdftotext', [file.path, '-'], { timeout: 30000, maxBuffer: 1024 * 1024 });
      await writeFile(path.join(output, `${file.name}.extracted.txt`), stdout, { mode: 0o600 });
      nativeReads.push({ file: file.name, method: 'HOST_PDFTOTEXT', textCharacters: stdout.trim().length,
        status: stdout.trim() ? 'TEXT_EXTRACTED_NOT_MODEL_READ' : 'NO_TEXT_NATIVE_VISION_REQUIRED',
        pages: 'UNKNOWN' });
    } catch { nativeReads.push({ file: file.name, status: 'PDF_EXTRACTION_FAILED' }); }
  } else if (file.contentType.startsWith('audio/')) {
    if (!asr || typeof asr.command !== 'string') { nativeReads.push({ file: file.name, status: 'ASR_NOT_CONFIGURED' }); continue; }
    if (!Array.isArray(asr.args) || asr.args.some((arg) => typeof arg !== 'string' || /\{\{(?!AttachmentPath\}\})/u.test(arg))) {
      nativeReads.push({ file: file.name, status: 'ASR_ARGUMENT_TEMPLATE_UNSUPPORTED' }); continue;
    }
    try {
      const args = asr.args.map((arg) => arg.replaceAll('{{AttachmentPath}}', file.path));
      const { stdout } = await exec(asr.command, args, { timeout: 180000, maxBuffer: 1024 * 1024 });
      await writeFile(path.join(output, `${file.name}.transcript.txt`), stdout, { mode: 0o600 });
      nativeReads.push({ file: file.name, method: 'ACTUAL_CONFIGURED_LOCAL_ASR',
        commandSha256: createHash('sha256').update(asr.command).digest('hex'),
        status: stdout.trim() ? 'TRANSCRIBED_NOT_MODEL_READ' : 'EMPTY_TRANSCRIPT', transcriptCharacters: stdout.trim().length,
        speakers: 'UNKNOWN', wordTimestamps: 'UNKNOWN', confidence: 'UNKNOWN' });
    } catch { nativeReads.push({ file: file.name, status: 'ASR_FAILED' }); }
  } else if (file.contentType.startsWith('image/')) nativeReads.push({ file: file.name, status: 'STAGED_NATIVE_VISION_NOT_EXECUTED' });
}
const report = { runId, scope: 'ORIGINAL_MATERIAL_ADAPTER_INGRESS_INTEGRATION',
  notCovered: ['Real WeCom entry', 'Model reading or business interpretation', 'Salesforce DML or upload publication', 'Native voice channel delivery'],
  taskState: 'ISOLATED_TEST_STORE', pluginRoot: root, sourceHashes: hashes,
  inputFiles: files.map(({ path: _path, ...file }) => file), batches, warnings: logs,
  materialsAfterTextConfirmation: task?.materials?.map((entry) => ({ fileName: entry.fileName,
    originalStaging: entry.staging, ...(entry.stagingFailure ? { stagingFailure: entry.stagingFailure } : {}),
    originalHashMatches: files.find((file) => file.name === entry.fileName)?.sha256 === entry.contentSha256,
    hasOriginalRef: typeof entry.attachmentRef === 'string', expiresAt: entry.expiresAt,
    reading: { status: entry.reading.status, source: entry.reading.source, coverage: entry.reading.coverage,
      reason: entry.reading.reason, reasons: entry.reading.reasons } })),
  nativeReads, rawAudioPresent: files.some((file) => file.contentType.startsWith('audio/')),
  cleanup: 'No Salesforce writes. Ingress originals expire by their real TTL. Synthetic local source copies remain at stagingDirectory.', stagingDirectory: staging };
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ runId, report: path.join(output, 'report.json'), inputFiles: files.length,
  staged: report.materialsAfterTextConfirmation?.filter((entry) => entry.hasOriginalRef).length ?? 0,
  retainedAfterText: task?.materials?.length ?? 0, scope: report.scope }));
