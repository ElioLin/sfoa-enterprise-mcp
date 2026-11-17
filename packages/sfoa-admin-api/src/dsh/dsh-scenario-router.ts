import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ControlPlaneError,
  dshAttachmentIdSchema,
  dshAttachmentUploadSchema,
  dshScenarioCreateSchema,
  dshScenarioIdSchema,
  dshScenarioListQuerySchema,
  dshScenarioUpdateSchema,
  type DshAttachmentMutationResponse,
  type DshDeletedScenarioResponse,
  type DshScenarioListResponse,
  type DshScenarioResponse,
  type DshScenarioService,
} from '@sfoa/control-plane';
import { redactSensitiveText } from '@sfoa/identity-runtime';
import { ZodError, type ZodTypeAny } from 'zod';
import type { AdminSession } from '../auth.js';
import { resolveDshScenarioActor, type DshActorResolution, type DshActorResolverDeps } from './dsh-actor.js';

/**
 * The DSH Standard Scenarios REST surface (DSH-01).
 *
 * This is a plugin-facing API, not an Admin Console endpoint, so it lives beside `/admin/api`
 * rather than inside it: its callers are the DSH client plugin (which authenticates with a Buntu
 * token or a USER_BOUND credential) and the Console page (which authenticates with the Admin
 * session cookie and is therefore still bounded by its module list).
 *
 * Three properties are deliberate:
 *
 * - **Reads never fail on identity.** `GET /api/dsh/scenarios` answers with the published
 *   catalogue and `auth.authenticated: false` when no credential resolves. A plugin must be able
 *   to render its standard-scenario list before the user signs in, and the catalogue is public
 *   within the deployment anyway.
 * - **Writes fail closed with one code.** Every write requires
 *   `canManageStandardScenario === true`; the refusal is always
 *   `403 DSH_SCENARIO_PERMISSION_DENIED`, so the plugin can branch on a single code.
 * - **The route never throws to its caller.** It always writes its own response, including
 *   errors, because the surrounding Admin error path would render an Admin envelope for a plugin
 *   that does not speak it.
 */

export const DSH_API_PREFIX = '/api/dsh';
/** Reserved because `GET /api/dsh/scenarios/permission` would otherwise be a scenario lookup. */
export const DSH_PERMISSION_SEGMENT = 'permission';

const MAX_JSON_BODY_BYTES = 1_048_576;
const MAX_MULTIPART_OVERHEAD_BYTES = 65_536;

export type DshScenarioRouterOptions = Readonly<{
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  correlationId: string;
  service: DshScenarioService;
  actorDeps: DshActorResolverDeps;
  /** Exact Admin Console origin; a session-authenticated write must come from it. */
  adminAllowedOrigin: string;
  /** `'*'` or exact origins for the plugin surface. */
  allowedOrigins: readonly string[];
  maxAttachmentBytes: number;
  redactionSecrets?: readonly string[];
}>;

class DshHttpError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly issues?: readonly Readonly<{ path: string; message: string }>[],
  ) {
    super(message);
    this.name = 'DshHttpError';
  }
}

export function isDshApiPath(pathname: string): boolean {
  return pathname === DSH_API_PREFIX || pathname.startsWith(`${DSH_API_PREFIX}/`);
}

/** Handles one DSH request and always writes its own response. */
export async function handleDshScenarioRequest(options: DshScenarioRouterOptions): Promise<void> {
  const { request, response, url } = options;
  try {
    applyCorsHeaders(options);
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }
    const route = matchDshRoute(url.pathname);
    assertMethodAllowed(route, request.method);

    const body = await readBodyIfPresent(request, route, options.maxAttachmentBytes);
    const bodyToken = readBodyToken(body);
    const resolution = await resolveDshScenarioActor(
      request,
      url,
      options.actorDeps,
      { ...(bodyToken ? { bodyToken } : {}), correlationId: options.correlationId },
    );

    switch (route.kind) {
      case 'COLLECTION':
        if (request.method === 'POST') {
          await handleCreate(options, resolution, body);
        } else {
          await handleList(options, resolution);
        }
        return;
      case 'PERMISSION':
        writeJson(response, 200, resolution.auth);
        return;
      case 'SCENARIO':
        if (request.method === 'PUT') {
          await handleUpdate(options, resolution, route.scenarioId, body);
        } else {
          await handleDelete(options, resolution, route.scenarioId);
        }
        return;
      case 'UPLOAD':
        await handleUpload(options, resolution, route.scenarioId, body);
        return;
      case 'ATTACHMENT':
        if (request.method === 'DELETE') {
          await handleDeleteAttachment(options, resolution, route.scenarioId, route.attachmentId);
        } else {
          await handleDownload(options, resolution, route.scenarioId, route.attachmentId);
        }
        return;
    }
  } catch (error) {
    const mapped = mapDshError(error, options.redactionSecrets ?? []);
    if (!response.headersSent) {
      writeError(response, mapped, options.correlationId);
    } else {
      response.destroy();
    }
    process.stderr.write(`${JSON.stringify({
      level: 'error',
      channel: 'DSH',
      code: mapped.code,
      correlationId: options.correlationId,
    })}\n`);
  }
}

async function handleList(options: DshScenarioRouterOptions, resolution: DshActorResolution): Promise<void> {
  const query = parseWithSchema(dshScenarioListQuerySchema, queryObject(options.url));
  // Archived scenarios are unpublished drafts: only a caller that could edit them may list them.
  const includeArchived = query.includeArchived && resolution.auth.canManageStandardScenario;
  const result = await options.service.list({
    includeArchived,
    includeDeleted: query.includeDeleted,
    ...(query.businessSystem === undefined ? {} : { businessSystem: query.businessSystem }),
  });
  const body: DshScenarioListResponse = Object.freeze({
    auth: resolution.auth,
    scenarios: result.scenarios,
    deletedScenarioIds: result.deletedScenarioIds,
  });
  writeJson(options.response, 200, body);
}

async function handleCreate(
  options: DshScenarioRouterOptions,
  resolution: DshActorResolution,
  body: ParsedBody,
): Promise<void> {
  assertCanManage(options, resolution);
  const input = parseWithSchema(dshScenarioCreateSchema, requireJsonBody(body));
  const scenario = await options.service.create(input, resolution.actor);
  const responseBody: DshScenarioResponse = Object.freeze({ auth: resolution.auth, scenario });
  writeJson(options.response, 201, responseBody);
}

async function handleUpdate(
  options: DshScenarioRouterOptions,
  resolution: DshActorResolution,
  scenarioId: string,
  body: ParsedBody,
): Promise<void> {
  assertCanManage(options, resolution);
  const input = parseWithSchema(dshScenarioUpdateSchema, requireJsonBody(body));
  const scenario = await options.service.update(scenarioId, input, resolution.actor);
  const responseBody: DshScenarioResponse = Object.freeze({ auth: resolution.auth, scenario });
  writeJson(options.response, 200, responseBody);
}

async function handleDelete(
  options: DshScenarioRouterOptions,
  resolution: DshActorResolution,
  scenarioId: string,
): Promise<void> {
  assertCanManage(options, resolution);
  const scenario = await options.service.softDelete(scenarioId, resolution.actor);
  const deletedScenarioIds = (await options.service.list({ includeArchived: true, includeDeleted: true }))
    .deletedScenarioIds;
  const body: DshDeletedScenarioResponse = Object.freeze({
    auth: resolution.auth,
    deleted: true,
    scenarioId: scenario.scenarioId,
    revision: scenario.revision,
    deletedScenarioIds,
  });
  writeJson(options.response, 200, body);
}

async function handleUpload(
  options: DshScenarioRouterOptions,
  resolution: DshActorResolution,
  scenarioId: string,
  body: ParsedBody,
): Promise<void> {
  assertCanManage(options, resolution);
  const upload = parseUpload(options, body);
  if (upload.content.length > options.maxAttachmentBytes) {
    throw new DshHttpError(
      'DSH_SCENARIO_REQUEST_TOO_LARGE',
      `A preset attachment must not exceed ${options.maxAttachmentBytes} bytes.`,
      413,
    );
  }
  const result = await options.service.addAttachment(scenarioId, upload, resolution.actor);
  const responseBody: DshAttachmentMutationResponse = Object.freeze({
    auth: resolution.auth,
    scenario: result.scenario,
    attachment: result.attachment,
  });
  writeJson(options.response, 201, responseBody);
}

async function handleDeleteAttachment(
  options: DshScenarioRouterOptions,
  resolution: DshActorResolution,
  scenarioId: string,
  attachmentId: string,
): Promise<void> {
  assertCanManage(options, resolution);
  const scenario = await options.service.deleteAttachment(scenarioId, attachmentId, resolution.actor);
  const responseBody: DshScenarioResponse = Object.freeze({ auth: resolution.auth, scenario });
  writeJson(options.response, 200, responseBody);
}

/**
 * Downloads one preset attachment. The bytes of a DELETED scenario are gone (the delete path
 * removes them); an ARCHIVED scenario is still downloadable for a caller that could publish it.
 */
async function handleDownload(
  options: DshScenarioRouterOptions,
  resolution: DshActorResolution,
  scenarioId: string,
  attachmentId: string,
): Promise<void> {
  const scenario = await options.service.get(scenarioId);
  if (!scenario || scenario.status === 'DELETED') {
    throw new DshHttpError('DSH_SCENARIO_NOT_FOUND', 'Standard scenario was not found.', 404);
  }
  if (scenario.status === 'ARCHIVED' && !resolution.auth.canManageStandardScenario) {
    throw new DshHttpError('DSH_SCENARIO_NOT_FOUND', 'Standard scenario is not published.', 404);
  }
  const file = await options.service.getAttachment(scenarioId, attachmentId);
  if (!file) throw new DshHttpError('DSH_SCENARIO_NOT_FOUND', 'Preset attachment was not found.', 404);

  options.response.statusCode = 200;
  options.response.setHeader('Content-Type', file.mimeType);
  options.response.setHeader('Content-Length', String(file.content.length));
  options.response.setHeader('Content-Disposition', contentDisposition(file.fileName));
  // The digest is the only integrity evidence a downloader can check without an extra call.
  options.response.setHeader('X-SFoA-Content-Sha256', file.sha256);
  options.response.end(file.content);
}

/**
 * The single write gate. Two things must hold: the resolved actor may manage scenarios, and — for
 * a Console session specifically — the request carries the same Origin + CSRF proof every other
 * Admin mutation requires. A plugin write has no cookie, so CSRF cannot apply to it.
 */
function assertCanManage(options: DshScenarioRouterOptions, resolution: DshActorResolution): void {
  if (!resolution.auth.canManageStandardScenario) {
    throw new DshHttpError(
      'DSH_SCENARIO_PERMISSION_DENIED',
      'This account is not permitted to manage DSH standard scenarios.',
      403,
    );
  }
  if (resolution.source === 'ADMIN_SESSION') assertAdminMutationGuards(options, resolution);
}

function assertAdminMutationGuards(options: DshScenarioRouterOptions, resolution: DshActorResolution): void {
  const session: AdminSession | null = resolution.session;
  if (!session) throw new DshHttpError('DSH_SCENARIO_PERMISSION_DENIED', 'A valid Admin session is required.', 403);
  const origin = singleHeader(options.request.headers.origin);
  if (!origin || origin !== options.adminAllowedOrigin) {
    throw new DshHttpError(
      'DSH_SCENARIO_ORIGIN_NOT_ALLOWED',
      'The request Origin is not the configured Admin Console origin.',
      403,
    );
  }
  const csrf = singleHeader(options.request.headers['x-sfoa-csrf-token']);
  if (!csrf || !safeTextEqual(csrf, session.csrfToken)) {
    throw new DshHttpError('DSH_SCENARIO_CSRF_INVALID', 'A valid Admin CSRF token is required.', 403);
  }
}

type DshRoute =
  | Readonly<{ kind: 'COLLECTION' }>
  | Readonly<{ kind: 'PERMISSION' }>
  | Readonly<{ kind: 'SCENARIO'; scenarioId: string }>
  | Readonly<{ kind: 'UPLOAD'; scenarioId: string }>
  | Readonly<{ kind: 'ATTACHMENT'; scenarioId: string; attachmentId: string }>;

function matchDshRoute(pathname: string): DshRoute {
  if (!isDshApiPath(pathname)) throw notFound();
  const rest = pathname.slice(DSH_API_PREFIX.length).replace(/^\/+/u, '').replace(/\/+$/u, '');
  if (rest !== 'scenarios' && !rest.startsWith('scenarios/')) throw notFound();
  const parts = rest.split('/').map(decodePathSegment);
  if (parts[0] !== 'scenarios') throw notFound();
  if (parts.length === 1) return Object.freeze({ kind: 'COLLECTION' });
  if (parts.length === 2) {
    if (parts[1] === DSH_PERMISSION_SEGMENT) return Object.freeze({ kind: 'PERMISSION' });
    const scenarioId = parseScenarioIdSegment(parts[1] as string);
    return Object.freeze({ kind: 'SCENARIO', scenarioId });
  }
  const scenarioId = parseScenarioIdSegment(parts[1] as string);
  if (parts.length === 3) {
    if (parts[2] !== 'attachments') throw notFound();
    return Object.freeze({ kind: 'UPLOAD', scenarioId });
  }
  if (parts.length === 4) {
    if (parts[2] !== 'attachments') throw notFound();
    const attachmentId = parseWithSchema(dshAttachmentIdSchema, parts[3]);
    return Object.freeze({ kind: 'ATTACHMENT', scenarioId, attachmentId });
  }
  throw notFound();
}

function assertMethodAllowed(route: DshRoute, method: string | undefined): void {
  const allowed: readonly string[] = route.kind === 'COLLECTION'
    ? ['GET', 'POST']
    : route.kind === 'PERMISSION'
      ? ['GET']
      : route.kind === 'UPLOAD'
          ? ['POST']
          : route.kind === 'SCENARIO'
            ? ['PUT', 'DELETE']
            : ['GET', 'DELETE'];
  if (!method || !allowed.includes(method)) {
    throw new DshHttpError(
      'DSH_SCENARIO_METHOD_NOT_ALLOWED',
      `This DSH endpoint accepts ${allowed.join(', ')}.`,
      405,
    );
  }
}

function parseScenarioIdSegment(value: string | undefined): string {
  return parseWithSchema(dshScenarioIdSchema, value);
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new DshHttpError('DSH_SCENARIO_REQUEST_INVALID', 'Path identifier encoding is invalid.', 400);
  }
}

type ParsedBody = Readonly<{ raw: Buffer; json: unknown }>;

async function readBodyIfPresent(
  request: IncomingMessage,
  route: DshRoute,
  maxAttachmentBytes: number,
): Promise<ParsedBody> {
  const method = request.method;
  if (method !== 'POST' && method !== 'PUT') return Object.freeze({ raw: Buffer.alloc(0), json: undefined });
  const contentType = singleHeader(request.headers['content-type'])?.toLocaleLowerCase('en-US') ?? '';
  const isUpload = route.kind === 'UPLOAD';
  const limit = isUpload
    ? contentType.startsWith('multipart/form-data')
      ? maxAttachmentBytes + MAX_MULTIPART_OVERHEAD_BYTES
      : Math.ceil((maxAttachmentBytes * 4) / 3) + MAX_JSON_BODY_BYTES
    : MAX_JSON_BODY_BYTES;
  const raw = await readRawBody(request, limit);
  if (raw.length === 0) return Object.freeze({ raw, json: undefined });
  if (contentType.startsWith('multipart/form-data')) return Object.freeze({ raw, json: undefined });
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/u.test(contentType)) {
    throw new DshHttpError(
      'DSH_SCENARIO_UNSUPPORTED_MEDIA_TYPE',
      isUpload
        ? 'Send the attachment as application/json (contentBase64) or multipart/form-data.'
        : 'Content-Type must be application/json.',
      415,
    );
  }
  try {
    return Object.freeze({ raw, json: JSON.parse(raw.toString('utf8')) as unknown });
  } catch {
    throw new DshHttpError('DSH_SCENARIO_REQUEST_INVALID', 'The request body is not valid JSON.', 400);
  }
}

/** `buntuToken` is an identity carrier, never a scenario field, so it is removed before validation. */
function readBodyToken(body: ParsedBody): string | undefined {
  if (typeof body.json !== 'object' || body.json === null || Array.isArray(body.json)) return undefined;
  const value = (body.json as Record<string, unknown>).buntuToken;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireJsonBody(body: ParsedBody): unknown {
  if (body.json === undefined) {
    throw new DshHttpError('DSH_SCENARIO_REQUEST_INVALID', 'A JSON request body is required.', 400);
  }
  if (typeof body.json !== 'object' || body.json === null || Array.isArray(body.json)) return body.json;
  const { buntuToken: _token, ...rest } = body.json as Record<string, unknown>;
  return rest;
}

/**
 * Both documented upload transports, behind one normalizer: base64 JSON (works from every runtime)
 * and a single-file `multipart/form-data` (what a browser `FormData` produces). A multipart body
 * carries exactly one file part; extra text fields are ignored rather than becoming part of the
 * stored metadata.
 */
function parseUpload(
  options: DshScenarioRouterOptions,
  body: ParsedBody,
): Readonly<{ fileName: string; mimeType: string; content: Buffer; sha256?: string }> {
  const contentType = singleHeader(options.request.headers['content-type']) ?? '';
  if (!contentType.toLocaleLowerCase('en-US').startsWith('multipart/form-data')) {
    const input = parseWithSchema(dshAttachmentUploadSchema, requireJsonBody(body));
    const content = Buffer.from(input.contentBase64, 'base64');
    if (content.length === 0) {
      throw new DshHttpError('DSH_SCENARIO_REQUEST_INVALID', 'contentBase64 did not decode to any bytes.', 400);
    }
    return Object.freeze({
      fileName: input.fileName,
      mimeType: input.mimeType,
      content,
      ...(input.sha256 ? { sha256: input.sha256 } : {}),
    });
  }
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType);
  const value = boundary?.[1] ?? boundary?.[2]?.trim();
  if (!value) {
    throw new DshHttpError('DSH_SCENARIO_REQUEST_INVALID', 'The multipart boundary is missing.', 400);
  }
  const part = parseSingleFileMultipart(body.raw, value);
  if (!part) {
    throw new DshHttpError('DSH_SCENARIO_REQUEST_INVALID', 'The multipart body must contain exactly one file part.', 400);
  }
  return Object.freeze({
    fileName: sanitizeFileName(part.fileName),
    mimeType: part.mimeType,
    content: part.content,
  });
}

type MultipartFile = Readonly<{ fileName: string; mimeType: string; content: Buffer }>;

function parseSingleFileMultipart(raw: Buffer, boundary: string): MultipartFile | undefined {
  const delimiter = Buffer.from(`--${boundary}`, 'latin1');
  let cursor = raw.indexOf(delimiter);
  if (cursor < 0) return undefined;
  while (cursor >= 0) {
    const headerStart = cursor + delimiter.length;
    // `--` right after the delimiter is the closing marker.
    if (raw.subarray(headerStart, headerStart + 2).toString('latin1') === '--') return undefined;
    const next = raw.indexOf(delimiter, headerStart);
    if (next < 0) return undefined;
    const section = raw.subarray(headerStart, trimTrailingCrlf(raw, next));
    const separator = section.indexOf('\r\n\r\n');
    if (separator >= 0) {
      const headers = section.subarray(0, separator).toString('utf8');
      const content = section.subarray(separator + 4);
      const disposition = /content-disposition:([^\r\n]+)/iu.exec(headers)?.[1] ?? '';
      const fileName = /filename="([^"]*)"/iu.exec(disposition)?.[1];
      if (fileName !== undefined && fileName.length > 0) {
        const mimeType = /content-type:\s*([^\r\n;]+)/iu.exec(headers)?.[1]?.trim() ?? 'application/octet-stream';
        if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/u.test(mimeType)) {
          throw new DshHttpError('DSH_SCENARIO_REQUEST_INVALID', 'The multipart part has an invalid Content-Type.', 400);
        }
        return Object.freeze({ fileName, mimeType, content: Buffer.from(content) });
      }
    }
    cursor = next;
  }
  return undefined;
}

/** The CRLF that precedes the next boundary belongs to the delimiter, not to the file. */
function trimTrailingCrlf(raw: Buffer, boundaryIndex: number): number {
  return raw[boundaryIndex - 2] === 0x0d && raw[boundaryIndex - 1] === 0x0a ? boundaryIndex - 2 : boundaryIndex;
}

function sanitizeFileName(value: string): string {
  const base = value.split(/[\\/]/u).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001F\u007F]/gu, '').trim();
  if (cleaned.length === 0) {
    throw new DshHttpError('DSH_SCENARIO_REQUEST_INVALID', 'The uploaded file has no usable file name.', 400);
  }
  return cleaned.slice(0, 255);
}

async function readRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(singleHeader(request.headers['content-length']));
  if (Number.isFinite(declared) && declared > maxBytes) {
    request.resume();
    throw new DshHttpError('DSH_SCENARIO_REQUEST_TOO_LARGE', `The request body exceeds ${maxBytes} bytes.`, 413);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > maxBytes) {
      request.resume();
      throw new DshHttpError('DSH_SCENARIO_REQUEST_TOO_LARGE', `The request body exceeds ${maxBytes} bytes.`, 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

const CORS_ALLOWED_HEADERS = 'Authorization, Content-Type, X-Buntu-Token, X-SFoA-CSRF-Token, Accept';
const CORS_EXPOSED_HEADERS = 'Content-Disposition, X-SFoA-Content-Sha256, X-Correlation-Id';

/**
 * CORS for the plugin surface. A wildcard allowlist answers with the caller's origin but never
 * with credentials, because `*` plus `Allow-Credentials` is the browser-forbidden combination and a
 * cookie must not travel to an origin the operator did not name. An explicitly allowlisted origin
 * may use credentials (that is how a separately hosted Console would talk to this API).
 */
function applyCorsHeaders(options: DshScenarioRouterOptions): void {
  const origin = singleHeader(options.request.headers.origin);
  if (!origin) return;
  const wildcard = options.allowedOrigins.includes('*');
  const listed = options.allowedOrigins.some((candidate) => candidate !== '*' && candidate === origin);
  const requestHost = singleHeader(options.request.headers.host);
  const sameOrigin = Boolean(requestHost) && safeOriginHost(origin) === requestHost;
  if (!wildcard && !listed && !sameOrigin) {
    throw new DshHttpError('DSH_SCENARIO_ORIGIN_NOT_ALLOWED', 'The request Origin is not allowed.', 403);
  }
  options.response.setHeader('Access-Control-Allow-Origin', origin);
  options.response.setHeader('Vary', 'Origin');
  options.response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  options.response.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
  options.response.setHeader('Access-Control-Expose-Headers', CORS_EXPOSED_HEADERS);
  options.response.setHeader('Access-Control-Max-Age', '600');
  if (listed) options.response.setHeader('Access-Control-Allow-Credentials', 'true');
}

function safeOriginHost(origin: string): string | undefined {
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}

function contentDisposition(fileName: string): string {
  // RFC 6266: an ASCII fallback for legacy clients plus the exact UTF-8 name.
  const fallback = fileName.replace(/[^\x20-\x7E]/gu, '_').replace(/["\\]/gu, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function parseWithSchema<S extends ZodTypeAny>(schema: S, value: unknown): ReturnType<S['parse']> {
  const result = schema.safeParse(value);
  if (!result.success) throw invalidInput(result.error);
  return result.data as ReturnType<S['parse']>;
}

function queryObject(url: URL): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(result, key)) {
      throw new DshHttpError('DSH_SCENARIO_REQUEST_INVALID', `Query parameter ${key} must not be repeated.`, 400);
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

function invalidInput(error: ZodError): DshHttpError {
  return new DshHttpError(
    'DSH_SCENARIO_INPUT_INVALID',
    'The request did not match the strict DSH scenario contract.',
    400,
    Object.freeze(error.issues.slice(0, 20).map((issue) => Object.freeze({
      path: issue.path.join('.'),
      message: issue.message,
    }))),
  );
}

function mapDshError(error: unknown, secrets: readonly string[]): DshHttpError {
  if (error instanceof DshHttpError) return error;
  if (error instanceof ZodError) return invalidInput(error);
  if (error instanceof ControlPlaneError) {
    const status = error.code === 'MCP_CONTROL_PLANE_NOT_FOUND'
      ? 404
      : error.code === 'MCP_ADMIN_CONCURRENT_MODIFICATION' || error.code === 'MCP_CONTROL_PLANE_CONFLICT'
        ? 409
        : error.code === 'MCP_ADMIN_INPUT_INVALID' || error.code === 'MCP_CONTROL_PLANE_CONFIGURATION_INVALID'
          ? 400
          : error.code === 'MCP_ADMIN_AUDIT_FAILED'
            ? 500
            : 503;
    return new DshHttpError(
      error.code === 'MCP_CONTROL_PLANE_NOT_FOUND' ? 'DSH_SCENARIO_NOT_FOUND' : error.code,
      redactSensitiveText(error.message, secrets),
      status,
    );
  }
  return new DshHttpError(
    'DSH_SCENARIO_INTERNAL_ERROR',
    'The DSH scenario request could not be completed. Use the correlation ID to inspect server-side logs.',
    500,
  );
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', payload.length);
  response.end(payload);
}

function writeError(response: ServerResponse, error: DshHttpError, correlationId: string): void {
  writeJson(response, error.status, {
    error: {
      code: error.code,
      message: error.message,
      ...(error.issues ? { issues: error.issues } : {}),
    },
    correlationId,
  });
}

function notFound(): DshHttpError {
  return new DshHttpError('DSH_SCENARIO_NOT_FOUND', 'DSH endpoint was not found.', 404);
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function safeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
