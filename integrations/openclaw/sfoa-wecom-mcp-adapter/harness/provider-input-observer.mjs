/** Isolated synthetic evaluation only. Forward to the configured model; persist metadata, never headers or prompt bodies. */
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';

export function projectProviderInput(body) {
  const toolNames = new Map((body.messages ?? []).flatMap(message =>
    (message.tool_calls ?? []).map(call => [call.id, call.function?.name])));
  const materialReads = new Map((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).flatMap(call => {
    if (!/(?:^|__)read$/u.test(call.function?.name ?? '')) return [];
    let args; try { args = JSON.parse(call.function.arguments); } catch { return []; }
    const fileName = /(?:^|[/\\])materials[/\\]([^/\\]+)$/u.exec(args?.path ?? args?.file_path ?? '')?.[1];
    return fileName ? [[call.id, fileName]] : [];
  })));
  return { model: body.model, messages: (body.messages ?? []).map((message, index) => {
    const text = typeof message.content === 'string' ? message.content
      : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    let data; try { data = JSON.parse(text.replace(/^structuredContent:\n/, '')); } catch { /* Non-JSON Tool result. */ }
    return { index, role: message.role, ...(message.role === 'tool' ? { tool: toolNames.get(message.tool_call_id) } : {}),
      ...(message.role === 'tool' && materialReads.has(message.tool_call_id)
        ? { materialFile: materialReads.get(message.tool_call_id), materialReadEvidence: 'TOOL_RESULT_OBSERVED_REQUIRES_REVIEW' } : {}),
      bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'),
      clipped: /more characters truncated|Oversized diagnostic JSON redacted/.test(text),
      ...(message.role === 'tool' && /name: (sfoa-[a-z-]+)/.test(text) ? { skillRead: text.match(/name: (sfoa-[a-z-]+)/)[1] } : {}),
      ...(typeof data?.guidance === 'string' ? { guidanceBytes: Buffer.byteLength(data.guidance) } : {}),
      ...(Array.isArray(data?.fields) ? { fieldCount: data.fields.length,
        fields: data.fields.map(field => ({ apiName: field.apiName, label: field.label,
          helpPresent: Object.hasOwn(field, 'inlineHelpText'), helpBytes: Buffer.byteLength(field.inlineHelpText ?? ''),
          length: field.length, precision: field.precision, scale: field.scale,
          ...(field.picklist ? { candidateCount: field.picklist.values.length, nextValueOffset: field.picklist.nextValueOffset,
            dependenciesTruncated: field.picklist.dependenciesTruncated } : {}) })),
        coverage: data.coverage } : {}) };
  }) };
}

export async function observeProviderInput(models, primary, tracePath) {
  const provider = primary.split('/')[0];
  const configured = models.providers?.[provider];
  if (!configured?.baseUrl) throw new Error('Provider-input observation requires the actual primary provider baseUrl.');
  const upstream = new URL(configured.baseUrl);
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) throw new Error('Evaluation body bound'); chunks.push(chunk); }
      const body = Buffer.concat(chunks);
      await appendFile(tracePath, JSON.stringify(projectProviderInput(JSON.parse(body.toString('utf8')))) + '\n', { mode: 0o600 });
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => !['host', 'connection', 'content-length'].includes(key)));
      const result = await fetch(upstream.origin + path, { method: request.method, headers, body, redirect: 'error' });
      response.writeHead(result.status, { 'content-type': result.headers.get('content-type') ?? 'application/json' });
      if (result.body) Readable.fromWeb(result.body).pipe(response); else response.end();
    } catch { if (!response.headersSent) response.writeHead(502); response.end('Synthetic evaluation provider observation failed'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  return { models: { ...models, providers: { ...models.providers, [provider]: { ...configured,
    baseUrl: `http://127.0.0.1:${port}${upstream.pathname}` } } },
    close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) };
}
