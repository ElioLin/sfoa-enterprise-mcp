import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpTool } from '@salesforce/mcp-provider-api';
import {
  ContextRuntimeError,
  type DiagnosticQueryEvidence,
  type DiagnosticQueryInput,
  type DiagnosticToolingQueryExecutor,
  type MetadataComponentContext,
  type MetadataComponentContextExecutor,
  type MetadataContextInput,
} from '@sfoa/mcp-provider-sfoa-context';
import type {
  RequestScope,
  RequestScopedToolExecutionAdapter,
} from '@sfoa/identity-runtime';
import { redactSensitiveText } from '@sfoa/identity-runtime';
import { z } from 'zod';

const MAX_DIAGNOSTIC_RECORDS = 200;
const MAX_DIAGNOSTIC_RESULT_BYTES = 262_144;
const MAX_DIAGNOSTIC_VALUE_STRING = 32_768;
const MAX_DIAGNOSTIC_ARRAY_ITEMS = 200;
const MAX_DIAGNOSTIC_OBJECT_KEYS = 200;
const MAX_DIAGNOSTIC_DEPTH = 8;

export const METADATA_CONTEXT_LIMITS = Object.freeze({
  maxReturnedFiles: 40,
  maxFileBytes: 65_536,
  maxTotalBytes: 262_144,
  maxFileSummaries: 100,
} as const);

const MAX_SCANNED_METADATA_FILES = 1_000;
const MAX_SOURCE_FILE_BYTES = 5_242_880;
const TEXT_EXTENSIONS = new Set(['.xml', '.cls', '.trigger']);
const emptyExtra = {} as RequestHandlerExtra<ServerRequest, ServerNotification>;

const officialQueryResultSchema = z
  .object({
    records: z.array(z.record(z.unknown())),
    totalSize: z.number().int().nonnegative().optional(),
    done: z.boolean().optional(),
  })
  .passthrough();

export class OfficialDiagnosticToolingQueryExecutor implements DiagnosticToolingQueryExecutor {
  public constructor(
    private readonly scope: RequestScope,
    private readonly adapter: RequestScopedToolExecutionAdapter,
    private readonly officialQueryTool: McpTool,
  ) {}

  public async execute(input: DiagnosticQueryInput): Promise<DiagnosticQueryEvidence> {
    assertDiagnosticScope(this.scope, 'run_diagnostic_tooling_query');
    if (this.officialQueryTool.getName() !== 'run_soql_query') {
      throw new ContextRuntimeError(
        'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED',
        'The diagnostic query adapter was not bound to the official run_soql_query Tool.',
      );
    }
    const result = await this.adapter.execute(
      this.officialQueryTool,
      {
        query: input.query,
        usernameOrAlias: this.scope.route.salesforceUsername,
        directory: this.scope.workspace.root,
        useToolingApi: true,
      },
      emptyExtra,
    );
    const text = resultText(result);
    if (result.isError === true) {
      throw new ContextRuntimeError(
        'MCP_DIAGNOSTIC_QUERY_FAILED',
        safeOfficialError(text, this.scope) || 'The official run_soql_query Tool returned an empty error.',
      );
    }
    const jsonStart = text.indexOf('{');
    if (jsonStart < 0) {
      throw new ContextRuntimeError(
        'MCP_DIAGNOSTIC_QUERY_FAILED',
        'The official run_soql_query Tool returned no parseable JSON evidence.',
      );
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text.slice(jsonStart));
    } catch (error) {
      throw new ContextRuntimeError(
        'MCP_DIAGNOSTIC_QUERY_FAILED',
        'The official run_soql_query JSON evidence was invalid.',
        { cause: error },
      );
    }
    const parsed = officialQueryResultSchema.parse(parsedJson);
    const records: Record<string, unknown>[] = [];
    let returnedBytes = 0;
    let truncated = parsed.done === false || parsed.records.length > MAX_DIAGNOSTIC_RECORDS;
    for (const record of parsed.records.slice(0, MAX_DIAGNOSTIC_RECORDS)) {
      const bounded = boundUnknown(record, 0);
      if (!isRecord(bounded)) {
        truncated = true;
        continue;
      }
      const bytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8');
      if (returnedBytes + bytes > MAX_DIAGNOSTIC_RESULT_BYTES) {
        truncated = true;
        break;
      }
      records.push(bounded);
      returnedBytes += bytes;
      truncated ||= JSON.stringify(bounded) !== JSON.stringify(record);
    }
    return {
      records,
      totalSize: parsed.totalSize ?? parsed.records.length,
      returnedRecords: records.length,
      ...(parsed.done === undefined ? {} : { done: parsed.done }),
      truncated,
    };
  }
}

export class OfficialMetadataComponentContextExecutor implements MetadataComponentContextExecutor {
  public constructor(
    private readonly scope: RequestScope,
    private readonly adapter: RequestScopedToolExecutionAdapter,
    private readonly officialRetrieveTool: McpTool,
  ) {}

  public async execute(input: MetadataContextInput): Promise<MetadataComponentContext> {
    assertDiagnosticScope(this.scope, 'get_metadata_component_context');
    if (this.officialRetrieveTool.getName() !== 'retrieve_metadata') {
      throw new ContextRuntimeError(
        'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED',
        'The metadata context adapter was not bound to the official retrieve_metadata Tool.',
      );
    }
    const manifestRelativePath = 'manifest/p4-context-package.xml';
    const manifestPath = this.scope.workspace.resolveClientPath(manifestRelativePath);
    await writeFile(
      manifestPath,
      createManifest(this.scope.connection.getApiVersion(), input.metadataType, input.fullName),
      'utf8',
    );
    const result = await this.adapter.execute(
      this.officialRetrieveTool,
      {
        usernameOrAlias: this.scope.route.salesforceUsername,
        directory: this.scope.workspace.root,
        manifest: manifestRelativePath,
        ignoreConflicts: true,
      },
      emptyExtra,
    );
    if (result.isError === true) {
      throw new ContextRuntimeError(
        'MCP_METADATA_CONTEXT_FAILED',
        safeOfficialError(resultText(result), this.scope) || 'The official retrieve_metadata Tool returned an empty error.',
      );
    }
    const sourceRoot = this.scope.workspace.resolveClientPath('force-app/main/default');
    const candidates = await collectMetadataFiles(sourceRoot);
    if (candidates.length === 0) {
      throw new ContextRuntimeError(
        'MCP_METADATA_CONTEXT_FAILED',
        'The official retrieve_metadata Tool succeeded but produced no source files for the requested component.',
      );
    }
    return readBoundedMetadataContext(input, sourceRoot, candidates);
  }
}

type MetadataCandidate = Readonly<{
  absolutePath: string;
  relativePath: string;
  bytes: number;
}>;

async function collectMetadataFiles(sourceRoot: string): Promise<readonly MetadataCandidate[]> {
  const files: MetadataCandidate[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const absolutePath = path.resolve(directory, entry.name);
      assertWithin(sourceRoot, absolutePath);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await lstat(absolutePath);
      files.push({
        absolutePath,
        relativePath: path.relative(sourceRoot, absolutePath).replaceAll('\\', '/'),
        bytes: info.size,
      });
      if (files.length > MAX_SCANNED_METADATA_FILES) {
        throw new ContextRuntimeError(
          'MCP_METADATA_CONTEXT_TOO_LARGE',
          `Retrieved metadata exceeded the safe ${MAX_SCANNED_METADATA_FILES}-file scan bound.`,
        );
      }
    }
  };
  await walk(sourceRoot);
  return files.sort(
    (left, right) =>
      pathDepth(left.relativePath) - pathDepth(right.relativePath) ||
      left.relativePath.localeCompare(right.relativePath, 'en-US'),
  );
}

async function readBoundedMetadataContext(
  input: MetadataContextInput,
  sourceRoot: string,
  candidates: readonly MetadataCandidate[],
): Promise<MetadataComponentContext> {
  const files: NonNullable<MetadataComponentContext['files']> = [];
  const omittedFiles: NonNullable<MetadataComponentContext['omittedFiles']> = [];
  let returnedBytes = 0;
  let totalBytes = 0;
  let truncated = false;
  for (const candidate of candidates) {
    totalBytes += candidate.bytes;
    assertWithin(sourceRoot, candidate.absolutePath);
    const omit = (reason: (typeof omittedFiles)[number]['reason']): void => {
      truncated = true;
      if (omittedFiles.length < METADATA_CONTEXT_LIMITS.maxFileSummaries) {
        omittedFiles.push({ relativePath: candidate.relativePath, bytes: candidate.bytes, reason });
      }
    };
    if (!TEXT_EXTENSIONS.has(path.extname(candidate.relativePath).toLocaleLowerCase('en-US'))) {
      omit('UNSUPPORTED_FILE_TYPE');
      continue;
    }
    if (files.length >= METADATA_CONTEXT_LIMITS.maxReturnedFiles) {
      omit('FILE_LIMIT');
      continue;
    }
    if (returnedBytes >= METADATA_CONTEXT_LIMITS.maxTotalBytes || candidate.bytes > MAX_SOURCE_FILE_BYTES) {
      omit('TOTAL_BYTE_LIMIT');
      continue;
    }
    const buffer = await readFile(candidate.absolutePath);
    let content: string;
    try {
      content = redactSensitiveText(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    } catch {
      omit('NON_UTF8');
      continue;
    }
    const available = Math.min(
      METADATA_CONTEXT_LIMITS.maxFileBytes,
      METADATA_CONTEXT_LIMITS.maxTotalBytes - returnedBytes,
    );
    const boundedContent = truncateUtf8(content, available);
    const boundedBytes = Buffer.byteLength(boundedContent, 'utf8');
    const fileTruncated = boundedBytes < candidate.bytes;
    files.push({
      relativePath: candidate.relativePath,
      bytes: candidate.bytes,
      returnedBytes: boundedBytes,
      truncated: fileTruncated,
      content: boundedContent,
    });
    returnedBytes += boundedBytes;
    truncated ||= fileTruncated;
  }
  if (files.length === 0) {
    throw new ContextRuntimeError(
      'MCP_METADATA_CONTEXT_TOO_LARGE',
      'No retrieved UTF-8 metadata file fit within the configured response bounds.',
    );
  }
  return {
    success: true,
    executionRole: 'DIAGNOSTIC',
    metadataType: input.metadataType,
    fullName: input.fullName,
    files,
    omittedFiles,
    totalFiles: candidates.length,
    returnedFiles: files.length,
    totalBytes,
    returnedBytes,
    truncated,
    limits: { ...METADATA_CONTEXT_LIMITS },
  };
}

function createManifest(apiVersion: string, metadataType: string, fullName: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    '  <types>',
    `    <members>${escapeXml(fullName)}</members>`,
    `    <name>${escapeXml(metadataType)}</name>`,
    '  </types>',
    `  <version>${escapeXml(apiVersion)}</version>`,
    '</Package>',
    '',
  ].join('\n');
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function boundUnknown(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactSensitiveText(value).slice(0, MAX_DIAGNOSTIC_VALUE_STRING);
  if (depth >= MAX_DIAGNOSTIC_DEPTH) return '[TRUNCATED_DEPTH]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_DIAGNOSTIC_ARRAY_ITEMS).map((entry) => boundUnknown(entry, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
        .slice(0, MAX_DIAGNOSTIC_OBJECT_KEYS)
        .map(([key, entry]) => [key, boundUnknown(entry, depth + 1)]),
    );
  }
  return String(value).slice(0, MAX_DIAGNOSTIC_VALUE_STRING);
}

function safeOfficialError(value: string, scope: RequestScope): string {
  return redactSensitiveText(value, [scope.workspace.root, scope.route.salesforceUsername]).slice(0, 2_000);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function resultText(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content
    .filter((block): block is { type: string; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function assertDiagnosticScope(scope: RequestScope, toolName: string): void {
  if (scope.route.connectionRole !== 'DIAGNOSTIC') {
    throw new ContextRuntimeError(
      'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED',
      `${toolName} requires the fixed server-owned DIAGNOSTIC request scope.`,
    );
  }
}

function assertWithin(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ContextRuntimeError(
      'MCP_METADATA_CONTEXT_FAILED',
      'A retrieved metadata path escaped the request-owned source directory.',
    );
  }
}

function pathDepth(value: string): number {
  return value.split('/').length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
