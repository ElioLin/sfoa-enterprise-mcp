import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpTool } from '@salesforce/mcp-provider-api';
import { readSalesforceFailure, trimToByteBudget } from '@sfoa/mcp-provider-sfoa-data';
import {
  ContextRuntimeError,
  METADATA_LIST_DEFAULT_LIMIT,
  metadataListHint,
  type DiagnosticQueryEvidence,
  type DiagnosticQueryInput,
  type DiagnosticToolingQueryExecutor,
  type MetadataComponentContext,
  type MetadataComponentContextExecutor,
  type MetadataComponentLister,
  type MetadataContextInput,
  type MetadataListComponent,
  type MetadataListInput,
  type MetadataListOutput,
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
    const connection = await this.scope.getConnection();
    const manifestRelativePath = 'manifest/p4-context-package.xml';
    const manifestPath = this.scope.workspace.resolveClientPath(manifestRelativePath);
    await writeFile(
      manifestPath,
      createManifest(connection.getApiVersion(), input.metadataType, input.fullName),
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

/**
 * The listing half of the metadata pair, on the request's fixed DIAGNOSTIC identity.
 *
 * This lives in the host for the same reason `ScopedOrgLimitsExecutor` does, and one reason of its own:
 * the response `hint` must only name a Tool `tools/list` advertises, and the advertised set is a property
 * of *this request's* composition — which Tools the Console enabled for this route — that the provider
 * cannot see. The executor is therefore handed the session's advertised names and passes them to the pure
 * hint builder, so a deployment with the reader switched off gets a hint that names no Tool instead of a
 * dangling reference.
 *
 * `fullName` is never normalized. This org stores localized, URL-escaped component names
 * (`风控负责`, `WRN业务员%2F业务主管%2F市场开发`), and the whole point of the pair is that one of them is
 * copied verbatim into `get_metadata_component_context`. Decoding `%2F` here would hand the caller a name
 * that addresses a different component — or none — so the string is carried exactly as the listing gave it.
 */
export class OfficialMetadataComponentLister implements MetadataComponentLister {
  private readonly advertised: ReadonlySet<string>;

  public constructor(
    private readonly scope: RequestScope,
    advertisedToolNames: readonly string[],
  ) {
    this.advertised = new Set(advertisedToolNames);
  }

  public async execute(input: MetadataListInput): Promise<MetadataListOutput> {
    assertDiagnosticScope(this.scope, 'list_metadata_components');
    const includeInactive = input.includeInactive === true;
    const prefix = input.developerNamePrefix;
    const limit = input.limit ?? METADATA_LIST_DEFAULT_LIMIT;
    try {
      const connection = await this.scope.getConnection();
      const listed: unknown = await connection.metadata.list([{ type: input.metadataType }]);
      const matched = readMetadataListEntries(listed).filter(
        (entry) =>
          (includeInactive || !isInactiveMetadataEntry(entry))
          && (prefix === undefined || entry.fullName.startsWith(prefix)),
      );
      // `limit` caps what is considered at all; the byte budget then decides what fits, because a limit
      // alone cannot bound a response whose every entry carries a caller-visible name of unknown length.
      const candidates = matched.slice(0, limit);
      const build = (kept: readonly MetadataListComponent[]): MetadataListOutput => {
        // Strict `>`: equal counts mean nothing was dropped, whichever mechanism did the dropping.
        const truncated = kept.length < matched.length;
        return {
          success: true,
          executionRole: 'DIAGNOSTIC',
          metadataType: input.metadataType,
          components: [...kept],
          // Post-filter, pre-slice: the count a caller would see if neither the limit nor the budget applied.
          // Reporting the type's *org-wide* size here would make `truncated` meaningless, since a filtered
          // listing is narrowed by the caller's own filter rather than by this Tool.
          totalCount: matched.length,
          returnedCount: kept.length,
          truncated,
          includeInactive,
          ...(prefix === undefined ? {} : { developerNamePrefix: prefix }),
          hint: metadataListHint(this.advertised, {
            returnedCount: kept.length,
            totalCount: matched.length,
            truncated,
            includeInactive,
            prefixApplied: prefix !== undefined,
          }),
        };
      };
      return build(trimToByteBudget(candidates, MAX_DIAGNOSTIC_RESULT_BYTES, build).kept);
    } catch (error) {
      throw mapMetadataListFailure(error, input.metadataType);
    }
  }
}

/**
 * Normalizes whatever `metadata.list` returned into entries this Tool can describe.
 *
 * jsforce types the call as an array, but the wire form is per-type and a single-type request is the kind
 * of call that comes back unwrapped, so both shapes are accepted. An entry with no usable `fullName` is
 * skipped rather than emitted with an empty name: a nameless component is not actionable — it cannot be
 * passed to the reader — and a blank `fullName` in the list would read as a component that exists.
 */
function readMetadataListEntries(listed: unknown): readonly MetadataListComponent[] {
  const raw = Array.isArray(listed) ? listed : [listed];
  const entries: MetadataListComponent[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) continue;
    const fullName = nonEmptyString(candidate.fullName);
    if (fullName === undefined) continue;
    const manageableState = nonEmptyString(candidate.manageableState);
    const lastModifiedBy = nonEmptyString(candidate.lastModifiedByName) ?? nonEmptyString(candidate.lastModifiedById);
    const lastModifiedDate = nonEmptyString(candidate.lastModifiedDate);
    const fileName = nonEmptyString(candidate.fileName);
    entries.push({
      fullName,
      ...(manageableState === undefined ? {} : { manageableState }),
      ...(lastModifiedBy === undefined ? {} : { lastModifiedBy }),
      ...(lastModifiedDate === undefined ? {} : { lastModifiedDate }),
      ...(fileName === undefined ? {} : { fileName }),
    });
  }
  // Sorted so that the entries the limit and the budget drop are the same ones on every run: an
  // inventory whose membership changes between identical calls is not evidence a caller can cite.
  return entries.sort((left, right) => (left.fullName < right.fullName ? -1 : left.fullName > right.fullName ? 1 : 0));
}

/**
 * The Metadata API's one "this component is not active" signal in a listing.
 *
 * `manageableState: 'deleted'` is a component sitting in the org's recycle bin — the entry is still
 * listed, so a caller who wanted "the validation rules this org enforces" would otherwise be handed a
 * rule that no longer runs. `released`/`installed`/`unmanaged`/`deprecated`/`beta` are all live states and
 * are not dropped. This is the narrow reading on purpose, and it is the reading the live probe measures:
 * per ADR-0032 only some types carry `manageableState` at all (`Profile` carries none), so an entry
 * without the field is treated as active rather than as unknown.
 */
const INACTIVE_MANAGEABLE_STATES: ReadonlySet<string> = new Set(['deleted']);

function isInactiveMetadataEntry(entry: MetadataListComponent): boolean {
  return entry.manageableState !== undefined && INACTIVE_MANAGEABLE_STATES.has(entry.manageableState);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Salesforce codes that mean "this org will not list this type to this identity". */
const METADATA_LIST_UNAVAILABLE_CODES = [
  'INSUFFICIENT_ACCESS',
  'INSUFFICIENT_ACCESS_OR_READONLY',
  'INSUFFICIENT_PRIVILEGES',
  'API_DISABLED_FOR_ORG',
  'NOT_FOUND',
  'INVALID_TYPE',
  'UNKNOWN_EXCEPTION',
] as const;

/**
 * ADR-0029 §3's degradation contract, applied per type: a type this org will not list is a **structured
 * error naming the missing prerequisite**, never an empty list. An empty `components` array would be
 * indistinguishable from "this org holds no component of this type", which is a claim about the org the
 * Tool has not earned — and the two readings have opposite operational consequences.
 *
 * The `prerequisite` is `A-4` because that is the prerequisite `ADR-0029` names for the T4 types: "the
 * metadata types beyond the three probed are retrievable by this identity". It is emitted per type, which
 * is what A-4 demands, and the message names the type so a reader can tell which entry of the widened
 * allowlist the deployment does not actually serve.
 */
function mapMetadataListFailure(error: unknown, metadataType: string): ContextRuntimeError {
  if (error instanceof ContextRuntimeError) return error;
  const failure = readSalesforceFailure(error);
  const normalized = failure.code?.toLocaleUpperCase('en-US');
  const unavailable = normalized !== undefined
    && METADATA_LIST_UNAVAILABLE_CODES.some((code) => code === normalized);
  if (!unavailable) {
    return new ContextRuntimeError(
      'MCP_METADATA_LIST_FAILED',
      `Salesforce could not list ${metadataType} components for this request.`,
      {
        cause: error,
        ...(failure.code === null ? {} : { salesforceErrorCode: failure.code }),
        suggestion: 'Retry once; if it fails again the diagnostic identity or the org\'s API access needs to be '
          + 'checked. This affects the metadata listing only: other Salesforce Tools are unaffected.',
      },
    );
  }
  return new ContextRuntimeError(
    'MCP_METADATA_TYPE_UNAVAILABLE',
    `This org did not list ${metadataType} components to the fixed DIAGNOSTIC identity this Tool runs on.`,
    {
      cause: error,
      ...(failure.code === null ? {} : { salesforceErrorCode: failure.code }),
      prerequisite: 'A-4',
      suggestion: `The empty result is not "this org has no ${metadataType}": it is that the type could not be `
        + 'listed at all, so treat the inventory as unknown rather than as zero. The type is on the allowlist '
        + 'because it was measured as retrievable on the deployment this allowlist was built from, so a refusal '
        + 'here means this org differs per type — that is a per-type authorization fact, not an API outage. '
        + 'Widening a business integration identity to see Setup is not the remedy. Read the inventory from '
        + 'Salesforce Setup instead of retrying, and record the type in ADR-0032.',
    },
  );
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

/**
 * The one wording for "this request is not on the fixed DIAGNOSTIC identity".
 *
 * Exported because every diagnostic Tool needs it, including the ones whose executor lives outside
 * this module: a second, inlined copy of the check would be free to drift from this code and message,
 * and this is the guard an operator reads in the audit trail when a role mix-up is suspected.
 */
export function assertDiagnosticScope(scope: RequestScope, toolName: string): void {
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
