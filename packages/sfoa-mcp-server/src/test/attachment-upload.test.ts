/**
 * Skill-02C machine gates for the SFoA attachment capability.
 *
 * These are the gates the acceptance contract names, one describe-level block each:
 * governance, identity, security, Salesforce (fixtures only), multiple files, audit.
 * Every Salesforce interaction is served by a local responder — no test in this file
 * reaches a real org, and none may ever be changed to.
 *
 * The gates that live elsewhere, so this file does not duplicate them:
 *   - OpenClaw side (path/URL refusal before a file is opened, log hygiene):
 *     `integrations/openclaw/sfoa-wecom-mcp-adapter/test/attachments.test.js` + `bridge.test.js`
 *   - Admin DTO/UI, migration default, playbook rendering, skill doctrine:
 *     the admin-api, admin-web, control-plane, agent-playbook and skill gate suites.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ReleaseState } from '@salesforce/mcp-provider-api';
import type {
  RequestContext,
  RuntimeLogger,
  SalesforceIdentityRoute,
  SalesforceConnectionProvider,
} from '@sfoa/identity-runtime';
import type { Connection } from '@salesforce/core';
import type {
  AttachmentStagingCreateInput,
  AttachmentStagingRecord,
  AttachmentStagingRepository,
} from '@sfoa/control-plane';
import { AttachmentIngress } from '../attachment-ingress.js';
import { parseAttachmentPolicyJson, StaticAttachmentPolicy } from '../attachment-policy.js';
import { AttachmentToolGovernancePolicy } from '../attachment-tool-governance.js';
import {
  UploadFilesToRecordTool,
  UPLOAD_FILES_TO_RECORD_TOOL_NAME,
  createUploadFilesToRecordTool,
  uploadFilesInputSchema,
  uploadFilesToolResult,
} from '../attachment-tool.js';
import { AttachmentToolFacade } from '../attachment-tool-facade.js';
import {
  SalesforceAttachmentUploader,
  aggregateAttachmentOutcome,
  type AttachmentFileResult,
  type AttachmentFileStatus,
} from '../attachment-upload.js';
import { RemoteRuntimeError } from '../errors.js';

/** One terminal audit event, as the harness receives it. */
type LoggedEvent = Parameters<RuntimeLogger['log']>[0];

/** A settled per-file result, for the aggregate-contract gate. */
function stagedFileResult(index: number, status: AttachmentFileStatus): AttachmentFileResult {
  return {
    index,
    attachmentRef: `att_${'a'.repeat(24)}`,
    fileName: 'invoice.pdf',
    status,
    contentVersionId: null,
    contentDocumentId: null,
    httpStatus: null,
    errorCode: null,
    salesforceErrorCode: null,
    salesforceMessage: null,
    durationMs: 1,
  };
}

/** Runs a call that must be refused and returns the refusal, rather than the value. */
async function refusal(promise: Promise<unknown>): Promise<RemoteRuntimeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RemoteRuntimeError) return error;
    throw error;
  }
  throw new Error('expected the call to be refused, but it resolved');
}

const INSTANCE_URL = 'https://example.test';
const API_VERSION = '67.0';
const TARGET_OBJECT = 'Opportunity';
const TARGET_ID = '006000000000001AAA';
const ACCESS_TOKEN = 'fixture-access-token-not-a-real-credential';
const OWNER = 'requester-a';
const OTHER = 'requester-b';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** In-memory staging storage. Narrow on purpose — it mirrors the repository contract. */
class MemoryStagingRepository implements AttachmentStagingRepository {
  public readonly rows = new Map<string, AttachmentStagingRecord>();
  private sequence = 0;

  public async create(input: AttachmentStagingCreateInput): Promise<AttachmentStagingRecord> {
    this.sequence += 1;
    const row: AttachmentStagingRecord = Object.freeze({
      id: `row-${this.sequence}`,
      state: 'STAGED',
      failureCode: null,
      consumedAt: null,
      ...input,
      createdAt: input.createdAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
    });
    this.rows.set(row.attachmentRef, row);
    return row;
  }

  public async getByRef(attachmentRef: string): Promise<AttachmentStagingRecord | undefined> {
    return this.rows.get(attachmentRef);
  }

  public async markConsumed(id: string, consumedAt: Date): Promise<void> {
    this.transition(id, { state: 'CONSUMED', consumedAt: consumedAt.toISOString() });
  }

  public async markFailed(id: string, failureCode: string): Promise<void> {
    this.transition(id, { state: 'FAILED', failureCode });
  }

  public async markExpired(id: string): Promise<void> {
    this.transition(id, { state: 'EXPIRED' });
  }

  public async listExpired(now: Date, limit: number): Promise<readonly AttachmentStagingRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.state === 'STAGED' && Date.parse(row.expiresAt) <= now.getTime())
      .slice(0, limit);
  }

  public async listStagedByOwner(platformUserId: string): Promise<readonly AttachmentStagingRecord[]> {
    return [...this.rows.values()].filter(
      (row) => row.state === 'STAGED' && row.platformUserId === platformUserId,
    );
  }

  public async deleteById(id: string): Promise<void> {
    for (const [ref, row] of this.rows) if (row.id === id) this.rows.delete(ref);
  }

  /** Deliberate back door for the tampered-row security gate. */
  public poison(attachmentRef: string, patch: Partial<AttachmentStagingRecord>): void {
    const row = this.rows.get(attachmentRef);
    if (!row) throw new Error(`no staged row ${attachmentRef}`);
    this.rows.set(attachmentRef, Object.freeze({ ...row, ...patch }));
  }

  private transition(id: string, patch: Partial<AttachmentStagingRecord>): void {
    for (const [ref, row] of this.rows) if (row.id === id) this.rows.set(ref, Object.freeze({ ...row, ...patch }));
  }
}

const fixtureConnection = {
  instanceUrl: INSTANCE_URL,
  accessToken: ACCESS_TOKEN,
  version: API_VERSION,
} as unknown as Connection;

function fixtureProvider(): SalesforceConnectionProvider & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() { return calls; },
    getConnection: async () => {
      calls += 1;
      return fixtureConnection;
    },
  };
}

type RecordedCall = Readonly<{
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
}>;

type Responder = (call: RecordedCall) => Response | Promise<Response>;

async function consumeBody(body: unknown): Promise<Buffer> {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, 'utf8'));
  }
  return Buffer.concat(chunks);
}

/** Installs the only Salesforce the runtime can reach for the duration of `body`. */
async function withSalesforce(responder: Responder, body: (calls: RecordedCall[]) => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: RecordedCall = Object.freeze({
      url: String(input),
      method: String(init?.method ?? 'GET'),
      headers: Object.freeze(Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      )) as Record<string, string>,
      body: await consumeBody(init?.body),
    });
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  try {
    await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** The three Salesforce calls one successful single-file upload makes. */
function successfulSalesforce(): Responder {
  return (call) => {
    if (call.method === 'GET' && call.url.includes('/sobjects/')) {
      return Response.json({ Id: TARGET_ID, attributes: { type: TARGET_OBJECT } });
    }
    if (call.method === 'POST' && call.url.endsWith('/sobjects/ContentVersion')) {
      return Response.json({ id: '068000000000001AAA', success: true, errors: [] });
    }
    if (call.method === 'GET' && call.url.includes('/query')) {
      return Response.json({ records: [{ ContentDocumentId: '069000000000001AAA' }] });
    }
    throw new Error(`unexpected Salesforce call ${call.method} ${call.url}`);
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let root: string;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sfoa-attachment-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

type Harness = Readonly<{
  ingress: AttachmentIngress;
  store: MemoryStagingRepository;
  root: string;
}>;

async function createHarness(options: Partial<{ ttlMs: number; maxFileBytes: number; maxFilesPerOwner: number }> = {}): Promise<Harness> {
  const store = new MemoryStagingRepository();
  const stagingRoot = await mkdtemp(path.join(root, 'run-'));
  const ingress = new AttachmentIngress(store, {
    root: stagingRoot,
    ttlMs: options.ttlMs ?? 900_000,
    maxFileBytes: options.maxFileBytes ?? 1_048_576,
    maxFilesPerOwner: options.maxFilesPerOwner ?? 50,
  });
  return { ingress, store, root: stagingRoot };
}

async function stageOne(
  harness: Harness,
  content: Buffer | string,
  overrides: Partial<{ platformUserId: string; fileName: string; mimeType: string | null }> = {},
): Promise<string> {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const staged = await harness.ingress.stage({
    platformUserId: overrides.platformUserId ?? OWNER,
    sourceChannel: 'WECOM',
    runId: 'run-fixture',
    fileName: overrides.fileName ?? 'invoice.pdf',
    mimeType: overrides.mimeType === undefined ? 'application/pdf' : overrides.mimeType,
    body: Readable.from([bytes]),
  });
  return staged.attachmentRef;
}

function uploader(
  harness: Harness,
  provider: SalesforceConnectionProvider,
  objects: readonly string[] = [TARGET_OBJECT],
  platformUserId = OWNER,
): SalesforceAttachmentUploader {
  return new SalesforceAttachmentUploader({
    connectionProvider: provider,
    ingress: harness.ingress,
    policy: new StaticAttachmentPolicy(objects.map((objectApiName) => ({ objectApiName }))),
    platformUserId,
    uploadTimeoutMs: 5_000,
  });
}

// ---------------------------------------------------------------------------

describe('gate: tool governance', () => {
  test('the attachment Tool is enabled only through its own inventory and its own policy', () => {
    const governance = new AttachmentToolGovernancePolicy(
      [UPLOAD_FILES_TO_RECORD_TOOL_NAME],
      new StaticAttachmentPolicy([{ objectApiName: TARGET_OBJECT }]),
    );
    assert.deepEqual(governance.enabledTools, [UPLOAD_FILES_TO_RECORD_TOOL_NAME]);
    assert.equal(governance.isEnabled(UPLOAD_FILES_TO_RECORD_TOOL_NAME), true);
    // An unrelated DML Tool is never attachment-enabled by this policy.
    assert.equal(governance.isEnabled('create_record'), false);
    // Requesting nothing enables nothing.
    assert.deepEqual(
      new AttachmentToolGovernancePolicy([], new StaticAttachmentPolicy([])).enabledTools,
      [],
    );
  });

  test('a Tool name outside the explicit attachment inventory is refused', () => {
    assert.throws(
      () => new AttachmentToolGovernancePolicy(['create_record'], new StaticAttachmentPolicy([{ objectApiName: TARGET_OBJECT }])),
      (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_TOOL_NOT_AVAILABLE',
    );
  });

  test('enabling the Tool with no attachment-enabled object is a configuration error, not a runtime surprise', () => {
    assert.throws(
      () => new AttachmentToolGovernancePolicy([UPLOAD_FILES_TO_RECORD_TOOL_NAME], new StaticAttachmentPolicy([])),
      (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_ATTACHMENT_CONFIGURATION_INVALID',
    );
  });

  test('the attachment policy is parsed from its own channel and refuses a malformed or duplicated rule set', () => {
    assert.equal(parseAttachmentPolicyJson(undefined).allowsAny(), false);
    assert.deepEqual(parseAttachmentPolicyJson('[{"objectApiName":"Opportunity"}]').getObjects(), ['Opportunity']);
    // Attachment enablement is independent of the DML allowlist. The rule shape carries an
    // object and nothing else, so a policy that tries to describe attachment enablement as
    // an *operation* — the shape the DML allowlist uses — is rejected outright rather than
    // quietly accepted and then ignored.
    assert.throws(
      () => parseAttachmentPolicyJson('[{"objectApiName":"Opportunity","operations":["CREATE"]}]'),
      (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_ATTACHMENT_CONFIGURATION_INVALID',
    );
    for (const invalid of ['{', '{"objectApiName":"Opportunity"}', '[{"objectApiName":"opportunity"},{"objectApiName":"Opportunity"}]']) {
      assert.throws(
        () => parseAttachmentPolicyJson(invalid),
        (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_ATTACHMENT_CONFIGURATION_INVALID',
        `expected refusal for ${invalid}`,
      );
    }
  });

  test('the Tool descriptor is discoverable by name and carries no executable path', () => {
    const tool = createUploadFilesToRecordTool();
    assert.ok(tool instanceof UploadFilesToRecordTool);
    assert.equal(tool.getName(), UPLOAD_FILES_TO_RECORD_TOOL_NAME);
    assert.equal(tool.getReleaseState(), ReleaseState.GA);
    // The descriptor exists so the runtime can *name* every enabled Tool; the facade is
    // the only execution path, and the descriptor says so instead of pretending.
    assert.throws(
      () => tool.exec(),
      (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_TOOL_NOT_AVAILABLE',
    );
  });

  test('the tool result holds the P8-07 outcome contract: a partial upload completed, an unknown one did not', () => {
    // The same four-case contract `packages/mcp-provider-sfoa-dml/src/test/batch.test.ts`
    // pins for `create_records`/`update_records`, so an operator reads one model across
    // both mutation surfaces. A PARTIAL_SUCCESS is a finished execution with an incomplete
    // business result; an OUTCOME_UNKNOWN is not a finished execution at all.
    const request = { objectApiName: TARGET_OBJECT, recordId: TARGET_ID };
    const resultFor = (...statuses: AttachmentFileStatus[]) =>
      uploadFilesToolResult(
        aggregateAttachmentOutcome(request, statuses.map((status, index) => stagedFileResult(index, status))),
      );

    const cases = [
      { statuses: ['SUCCESS', 'SUCCESS'], status: 'SUCCESS', isError: false },
      { statuses: ['SUCCESS', 'FAILED'], status: 'PARTIAL_SUCCESS', isError: false },
      { statuses: ['FAILED', 'FAILED'], status: 'FAILED', isError: true },
      { statuses: ['SUCCESS', 'OUTCOME_UNKNOWN', 'NOT_ATTEMPTED'], status: 'OUTCOME_UNKNOWN', isError: true },
    ] as const;

    for (const scenario of cases) {
      const result = resultFor(...scenario.statuses);
      assert.equal((result.structuredContent as { status: string }).status, scenario.status);
      assert.equal(result.isError, scenario.isError, `${scenario.status} must report isError=${scenario.isError}`);
    }
  });
});

describe('gate: requester-scoped identity', () => {
  test('a reference resolves only for the requester it was staged for', async () => {
    const harness = await createHarness();
    const ref = await stageOne(harness, 'owner-only bytes');

    await assert.rejects(
      harness.ingress.resolveForOwner(ref, OTHER),
      (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_ATTACHMENT_NOT_OWNED',
    );
    assert.equal((await harness.ingress.resolveForOwner(ref, OWNER)).attachmentRef, ref);
  });

  test('an unknown reference and another requester reference are indistinguishable', async () => {
    const harness = await createHarness();
    const ref = await stageOne(harness, 'bytes');

    const foreign = await refusal(harness.ingress.resolveForOwner(ref, OTHER));
    const unknown = await refusal(harness.ingress.resolveForOwner(`att_${'z'.repeat(24)}`, OTHER));

    // Same code, same message: otherwise the ingress is an existence oracle a caller can
    // probe to learn which references are real without ever owning one.
    assert.equal(foreign.code, 'MCP_ATTACHMENT_NOT_OWNED');
    assert.equal(unknown.code, foreign.code);
    assert.equal(unknown.message, foreign.message);
  });

  test('the uploader resolves every reference against the requesting platform user', async () => {
    const harness = await createHarness();
    const ref = await stageOne(harness, 'bytes', { platformUserId: OWNER });

    // Calling as the other requester must fail the reference, not the Salesforce call.
    await withSalesforce(successfulSalesforce(), async (calls) => {
      const outcome = await uploader(harness, fixtureProvider(), [TARGET_OBJECT], OTHER)
        .upload({ objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: [ref] });
      assert.equal(outcome.status, 'FAILED');
      assert.equal(outcome.results[0]?.errorCode, 'MCP_ATTACHMENT_NOT_OWNED');
      assert.deepEqual(calls, [], 'a reference that is not owned must not reach Salesforce');
    });
  });

  test('a DIAGNOSTIC authority can never publish a file, and the refusal costs no Salesforce call', async () => {
    const harness = await createHarness();
    const ref = await stageOne(harness, 'bytes');
    const provider = fixtureProvider();
    const events: LoggedEvent[] = [];

    const facade = new AttachmentToolFacade({
      tool: createUploadFilesToRecordTool(),
      context: { platformUserId: OWNER, correlationId: 'corr-diagnostic', workspaceRoot: root } satisfies RequestContext,
      route: {
        platformUserId: OWNER,
        salesforceUsername: 'diagnostic@example.test',
        credentialProfile: 'DIAGNOSTIC',
        connectionRole: 'DIAGNOSTIC',
        aliases: [],
      } satisfies SalesforceIdentityRoute,
      toolTimeoutMs: 5_000,
      logger: { log: (event) => { events.push(event); } },
      clientId: 'fixture-client',
      connectionProvider: provider,
      ingress: harness.ingress,
      attachmentPolicy: new StaticAttachmentPolicy([{ objectApiName: TARGET_OBJECT }]),
      platformUserId: OWNER,
    });

    await withSalesforce(successfulSalesforce(), async (calls) => {
      const result = await facade.execute(
        { objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: [ref] },
        {} as never,
      );
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED/u);
      assert.deepEqual(calls, []);
    });
    assert.equal(provider.calls, 0, 'a refused Tool must not build a Salesforce Connection');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.result, 'BLOCKED');
  });
});

describe('gate: security', () => {
  test('the Tool accepts no path, no URL and no file content — the schema has no such field', () => {
    const shape = Object.keys(uploadFilesInputSchema.shape);
    assert.deepEqual(shape.sort(), ['attachmentRefs', 'objectApiName', 'recordId']);

    const forbidden = [
      'filePath', 'path', 'localPath', 'stagedPath',
      'sourceUrl', 'url', 'fileUrl',
      'content', 'base64', 'versionData', 'bytes', 'body',
      'fileName', 'mimeType', 'size',
    ];
    for (const field of forbidden) {
      const parsed = uploadFilesInputSchema.safeParse({
        objectApiName: TARGET_OBJECT,
        recordId: TARGET_ID,
        attachmentRefs: [`att_${'a'.repeat(24)}`],
        [field]: 'anything',
      });
      assert.equal(parsed.success, false, `the schema must not accept ${field}`);
    }
  });

  test('a path, a URL or a metadata address is refused as a reference before any storage lookup', async () => {
    const harness = await createHarness();
    const provider = fixtureProvider();
    const candidates = [
      '/etc/passwd',
      'C:\\Windows\\System32\\config\\SAM',
      '../../../../etc/passwd',
      'file:///etc/passwd',
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'https://localhost/secret',
      'http://127.0.0.1:8080/attachments',
      `att_${'a'.repeat(23)}`,   // one character short of a well-formed reference
      `att_${'a'.repeat(24)}!`,  // one character too many
    ];

    await withSalesforce(successfulSalesforce(), async (calls) => {
      const outcome = await uploader(harness, provider).upload({
        objectApiName: TARGET_OBJECT,
        recordId: TARGET_ID,
        attachmentRefs: candidates,
      });
      assert.equal(outcome.status, 'FAILED');
      for (const result of outcome.results) {
        assert.equal(result.status, 'FAILED');
        assert.equal(result.errorCode, 'MCP_ATTACHMENT_NOT_OWNED');
      }
      assert.deepEqual(calls, [], 'no path, URL or malformed reference may reach Salesforce');
    });
    assert.equal(provider.calls, 0, 'a request whose references all fail ownership builds no Connection');
  });

  test('a staged row poisoned with a path outside the staging root is refused and nothing outside is touched', async () => {
    const harness = await createHarness();
    const outsider = path.join(root, 'outside-the-staging-root.txt');
    await writeFile(outsider, 'must survive', 'utf8');

    // The row is the one thing an attacker with database access could edit; the ingress
    // must re-derive containment at open time rather than trust it.
    const ref = await stageOne(harness, 'legitimate bytes');
    for (const stagedPath of [outsider, path.join(harness.root, '..', '..', 'etc', 'passwd')]) {
      harness.store.poison(ref, { stagedPath });
      await assert.rejects(
        harness.ingress.openForUpload(harness.store.rows.get(ref)!),
        (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_ATTACHMENT_PATH_INVALID',
        `expected refusal for stagedPath ${stagedPath}`,
      );
    }

    // Cleanup must not follow a poisoned row out of the staging root either.
    harness.store.poison(ref, { stagedPath: outsider });
    await harness.ingress.fail(harness.store.rows.get(ref)!, 'MCP_ATTACHMENT_UPLOAD_FAILED');
    assert.equal(await readFile(outsider, 'utf8'), 'must survive');
  });

  test('a staged file whose bytes changed after staging is refused rather than published', async () => {
    const harness = await createHarness();
    const ref = await stageOne(harness, 'original bytes');
    const row = harness.store.rows.get(ref)!;
    await writeFile(row.stagedPath, 'tampered bytes with a different length', 'utf8');

    await assert.rejects(
      harness.ingress.openForUpload(harness.store.rows.get(ref)!),
      (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_ATTACHMENT_PATH_INVALID',
    );
  });

  test('an oversized or empty body is refused while streaming and leaves no file behind', async () => {
    const harness = await createHarness({ maxFileBytes: 16 });

    await assert.rejects(
      harness.ingress.stage({
        platformUserId: OWNER, sourceChannel: 'WECOM', runId: null,
        fileName: 'big.bin', mimeType: null, body: Readable.from([Buffer.alloc(64, 1)]),
      }),
      (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_ATTACHMENT_TOO_LARGE',
    );
    await assert.rejects(
      harness.ingress.stage({
        platformUserId: OWNER, sourceChannel: 'WECOM', runId: null,
        fileName: 'empty.bin', mimeType: null, body: Readable.from([]),
      }),
      (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_ATTACHMENT_INPUT_INVALID',
    );

    assert.deepEqual(await readdir(path.join(harness.root, 'staged')), [], 'a rejected upload must leave nothing staged');
  });

  test('the staging root is created private and every staged file is owner-only', async () => {
    const harness = await createHarness();
    const ref = await stageOne(harness, 'bytes');
    if (process.platform !== 'win32') {
      assert.equal((await stat(path.join(harness.root, 'staged'))).mode & 0o777, 0o700);
      assert.equal((await stat(harness.store.rows.get(ref)!.stagedPath)).mode & 0o777, 0o600);
    }
    // The minted reference is the file name: it carries no structure a caller could
    // decode into a path, an owner or a Salesforce id.
    assert.match(ref, /^att_[A-Za-z0-9_-]{24}$/u);
    assert.equal(path.basename(harness.store.rows.get(ref)!.stagedPath), ref);
  });

  test('a staged file name is reduced to a display label and can never become a path', async () => {
    const harness = await createHarness();
    for (const name of ['../../etc/passwd', 'C:\\Windows\\evil.exe', 'a\u0000b.pdf', '   ']) {
      const staged = await harness.ingress.stage({
        platformUserId: OWNER, sourceChannel: 'WECOM', runId: null,
        fileName: name, mimeType: null, body: Readable.from([Buffer.from('x')]),
      });
      assert.equal(staged.fileName.includes('/'), false);
      assert.equal(staged.fileName.includes('\\'), false);
      assert.equal(staged.fileName.includes('\u0000'), false);
      assert.ok(staged.fileName.length > 0);
      assert.equal(path.basename(harness.store.rows.get(staged.attachmentRef)!.stagedPath), staged.attachmentRef);
    }
  });
});

describe('gate: Salesforce access (fixtures only)', () => {
  test('the upload uses the requester Connection instance, version and token — never a runtime constant', async () => {
    const harness = await createHarness();
    const ref = await stageOne(harness, 'invoice bytes');

    await withSalesforce(successfulSalesforce(), async (calls) => {
      const outcome = await uploader(harness, fixtureProvider()).upload({
        objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: [ref],
      });
      assert.equal(outcome.status, 'SUCCESS');

      assert.deepEqual(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`), [
        `GET /services/data/v${API_VERSION}/sobjects/${TARGET_OBJECT}/${TARGET_ID}`,
        `POST /services/data/v${API_VERSION}/sobjects/ContentVersion`,
        `GET /services/data/v${API_VERSION}/query`,
      ]);
      for (const call of calls) {
        assert.ok(call.url.startsWith(`${INSTANCE_URL}/`), `unexpected host in ${call.url}`);
        assert.equal(call.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
      }
      // The target record is proven to belong to the object before the first upload, and
      // proven with the requester's own identity rather than a fixed integration user.
      assert.equal(new URL(calls[0]!.url).search, `?fields=Id`);
    });
  });

  test('the ContentVersion call is a multipart publish carrying FirstPublishLocationId and the exact staged bytes', async () => {
    const harness = await createHarness();
    const payload = Buffer.from('the invoice bytes, byte for byte', 'utf8');
    const ref = await stageOne(harness, payload, { fileName: 'invoice.pdf', mimeType: 'application/pdf' });

    await withSalesforce(successfulSalesforce(), async (calls) => {
      const outcome = await uploader(harness, fixtureProvider()).upload({
        objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: [ref],
      });
      assert.equal(outcome.status, 'SUCCESS');

      const post = calls.find((call) => call.method === 'POST')!;
      const contentType = post.headers['content-type']!;
      assert.match(contentType, /^multipart\/form-data; boundary=/u);
      assert.equal(post.headers['content-length'], String(post.body.byteLength), 'the length must be exact, so the body is not chunked');

      const boundary = contentType.slice(contentType.indexOf('boundary=') + 'boundary='.length);
      const parts = post.body.toString('utf8').split(`--${boundary}`);
      const entityPart = parts.find((part) => part.includes('name="entity_content"'))!;
      const entity = JSON.parse(entityPart.slice(entityPart.indexOf('\r\n\r\n') + 4).trim()) as Record<string, string>;

      assert.equal(entity.FirstPublishLocationId, TARGET_ID, 'the file must be published onto the target record');
      assert.equal(entity.PathOnClient, 'invoice.pdf');
      assert.equal(entity.Title, 'invoice');
      // No VersionData: the runtime never base64-encodes a file into the JSON part.
      assert.equal('VersionData' in entity, false);

      // The bytes are in the file part and nowhere else in the request.
      assert.equal(post.body.includes(payload), true, 'the staged bytes must be the published body');
      assert.equal(post.body.toString('utf8').includes(payload.toString('base64')), false);
    });
  });

  test('the ContentDocumentId is read back with the platform query API and reported when the publish succeeded', async () => {
    const harness = await createHarness();
    const ref = await stageOne(harness, 'bytes');

    await withSalesforce(successfulSalesforce(), async (calls) => {
      const outcome = await uploader(harness, fixtureProvider()).upload({
        objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: [ref],
      });
      const [result] = outcome.results;
      assert.equal(result?.contentVersionId, '068000000000001AAA');
      assert.equal(result?.contentDocumentId, '069000000000001AAA');
      assert.equal(result?.httpStatus, 200);

      // The document id is discovered, never inserted: no ContentDocument or
      // ContentDocumentLink write appears anywhere in the call list.
      const query = calls.find((call) => call.url.includes('/query'))!;
      const soql = new URL(query.url).searchParams.get('q')!;
      assert.match(soql, /^SELECT ContentDocumentId FROM ContentVersion WHERE Id = '068000000000001AAA'$/u);
      assert.equal(calls.some((call) => /ContentDocument\b|ContentDocumentLink/u.test(call.url)), false);
      assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
    });
  });

  test('a publish that succeeded is still SUCCESS when the document-id lookup fails', async () => {
    const harness = await createHarness();
    const ref = await stageOne(harness, 'bytes');

    await withSalesforce((call) => {
      if (call.method === 'POST') return Response.json({ id: '068000000000002AAA', success: true });
      if (call.url.includes('/query')) return new Response('upstream is unwell', { status: 503 });
      return Response.json({ Id: TARGET_ID });
    }, async () => {
      const outcome = await uploader(harness, fixtureProvider()).upload({
        objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: [ref],
      });
      assert.equal(outcome.status, 'SUCCESS');
      assert.equal(outcome.results[0]?.contentDocumentId, null);
      // Missing evidence is not an unknown outcome: the file is proven published.
      assert.equal(outcome.results[0]?.status, 'SUCCESS');
    });
  });

  test('a target record that is not visible as that object fails the call without publishing anything', async () => {
    const harness = await createHarness();
    const ref = await stageOne(harness, 'bytes');

    await withSalesforce((call) => {
      if (call.url.includes('/sobjects/')) {
        return Response.json(
          [{ message: 'insufficient access rights on object id', errorCode: 'INSUFFICIENT_ACCESS_OR_READONLY' }],
          { status: 403 },
        );
      }
      throw new Error(`nothing else may be called, got ${call.url}`);
    }, async (calls) => {
      // The target is proven before the first publish, so an invisible record is a
      // terminal error rather than an outcome: there is no file result to report.
      await assert.rejects(
        uploader(harness, fixtureProvider()).upload({
          objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: [ref],
        }),
        (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_ATTACHMENT_TARGET_INVALID',
      );
      assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
    });
  });

  test('an object that is not attachment-enabled is refused before any Salesforce call', async () => {
    const harness = await createHarness();
    const ref = await stageOne(harness, 'bytes');
    const provider = fixtureProvider();

    await withSalesforce(successfulSalesforce(), async (calls) => {
      await assert.rejects(
        uploader(harness, provider, ['Account']).upload({
          objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: [ref],
        }),
        (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_ATTACHMENT_OBJECT_NOT_ALLOWED',
      );
      assert.deepEqual(calls, []);
    });
    assert.equal(provider.calls, 0);
  });

  test('a malformed target id is refused before any Salesforce call', async () => {
    const harness = await createHarness();
    const ref = await stageOne(harness, 'bytes');
    const provider = fixtureProvider();

    await withSalesforce(successfulSalesforce(), async (calls) => {
      for (const recordId of ['', 'not-an-id', '006000000000001AA', '../../etc/passwd']) {
        await assert.rejects(
          uploader(harness, provider).upload({ objectApiName: TARGET_OBJECT, recordId, attachmentRefs: [ref] }),
          (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_ATTACHMENT_TARGET_INVALID',
          `expected refusal for ${recordId}`,
        );
      }
      assert.deepEqual(calls, []);
    });
  });

  test("Salesforce's own error code and message are preserved verbatim", async () => {
    const harness = await createHarness();
    const ref = await stageOne(harness, 'bytes');
    const platform = [{
      message: 'File is too large. Maximum size is 2 GB.',
      errorCode: 'FILE_TOO_LARGE',
      fields: [],
    }];

    await withSalesforce((call) => {
      if (call.method === 'POST') return Response.json(platform, { status: 400 });
      return Response.json({ Id: TARGET_ID });
    }, async () => {
      const outcome = await uploader(harness, fixtureProvider()).upload({
        objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: [ref],
      });
      assert.equal(outcome.status, 'FAILED');
      assert.equal(outcome.results[0]?.salesforceErrorCode, 'FILE_TOO_LARGE');
      assert.equal(outcome.results[0]?.salesforceMessage, 'File is too large. Maximum size is 2 GB.');
      assert.equal(outcome.results[0]?.httpStatus, 400);
      // The runtime invented nothing: no local size/type rule was consulted, and the
      // reason the caller sees is the platform's own.
      assert.equal(outcome.results[0]?.errorCode, 'MCP_ATTACHMENT_UPLOAD_FAILED');
    });
  });

  test('a JSON refusal is a proven failure with the platform reason intact; an unintelligible answer is unknown', async () => {
    // Salesforce rejects with a JSON *array* and accepts with a JSON *object*. Both are
    // Salesforce answering, so both are definite: a body Salesforce wrote can never be
    // reported as an unknown outcome, and the platform's own errorCode and message must
    // survive into the result. Only a body Salesforce did not write leaves it unknown.
    const cases = [
      {
        name: 'a refusal shaped as an array of errors',
        respond: () => Response.json([{ message: 'File is too large.', errorCode: 'FILE_TOO_LARGE' }], { status: 400 }),
        status: 'FAILED', httpStatus: 400, code: 'FILE_TOO_LARGE', message: 'File is too large.',
      },
      {
        name: 'a refusal shaped as an object carrying errors',
        respond: () => Response.json(
          { success: false, errors: [{ message: 'Invalid file type.', errorCode: 'INVALID_TYPE' }] },
          { status: 400 },
        ),
        status: 'FAILED', httpStatus: 400, code: 'INVALID_TYPE', message: 'Invalid file type.',
      },
      {
        name: 'a gateway page that is not Salesforce speaking',
        respond: () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
        status: 'OUTCOME_UNKNOWN', httpStatus: 502, code: null, message: null,
      },
      {
        name: 'an empty body',
        respond: () => new Response('', { status: 200 }),
        status: 'OUTCOME_UNKNOWN', httpStatus: 200, code: null, message: null,
      },
    ] as const;

    for (const scenario of cases) {
      const harness = await createHarness();
      const ref = await stageOne(harness, 'bytes');
      await withSalesforce((call) => {
        if (call.method === 'POST') return scenario.respond();
        return Response.json({ Id: TARGET_ID });
      }, async () => {
        const outcome = await uploader(harness, fixtureProvider()).upload({
          objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: [ref],
        });
        const [result] = outcome.results;
        assert.equal(outcome.status, scenario.status, scenario.name);
        assert.equal(result?.status, scenario.status, scenario.name);
        assert.equal(result?.httpStatus, scenario.httpStatus, scenario.name);
        assert.equal(result?.salesforceErrorCode, scenario.code, scenario.name);
        assert.equal(result?.salesforceMessage, scenario.message, scenario.name);
      });
    }
  });
});

describe('gate: multiple files', () => {
  test('every file succeeding is an aggregate SUCCESS', async () => {
    const harness = await createHarness();
    const refs = [await stageOne(harness, 'one'), await stageOne(harness, 'two'), await stageOne(harness, 'three')];

    await withSalesforce(successfulSalesforce(), async () => {
      const outcome = await uploader(harness, fixtureProvider()).upload({
        objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: refs,
      });
      assert.equal(outcome.status, 'SUCCESS');
      assert.deepEqual(
        [outcome.totalCount, outcome.succeeded, outcome.failed, outcome.unknown, outcome.notAttempted],
        [3, 3, 0, 0, 0],
      );
      assert.deepEqual(outcome.results.map((result) => result.status), ['SUCCESS', 'SUCCESS', 'SUCCESS']);
    });
  });

  test('a mix of successes and a platform rejection is PARTIAL_SUCCESS, per file and in the aggregate', async () => {
    const harness = await createHarness();
    const refs = [await stageOne(harness, 'one'), await stageOne(harness, 'two'), await stageOne(harness, 'three')];
    let posts = 0;

    await withSalesforce((call) => {
      if (call.method === 'POST') {
        posts += 1;
        return posts === 2
          ? Response.json([{ message: 'The file type is not supported.', errorCode: 'INVALID_TYPE' }], { status: 400 })
          : Response.json({ id: `06800000000000${posts}AAA`, success: true });
      }
      if (call.url.includes('/query')) return Response.json({ records: [{ ContentDocumentId: '069000000000001AAA' }] });
      return Response.json({ Id: TARGET_ID });
    }, async () => {
      const outcome = await uploader(harness, fixtureProvider()).upload({
        objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: refs,
      });
      assert.equal(outcome.status, 'PARTIAL_SUCCESS');
      assert.deepEqual(
        [outcome.totalCount, outcome.succeeded, outcome.failed, outcome.unknown, outcome.notAttempted],
        [3, 2, 1, 0, 0],
      );
      assert.deepEqual(outcome.results.map((result) => result.status), ['SUCCESS', 'FAILED', 'SUCCESS']);
      assert.equal(outcome.results[1]?.salesforceErrorCode, 'INVALID_TYPE');
      // The failure is reported at its own index, so the caller knows which file to retry.
      assert.equal(outcome.results[1]?.index, 1);
    });
  });

  test('every file failing is an aggregate FAILED', async () => {
    const harness = await createHarness();
    const refs = [await stageOne(harness, 'one'), await stageOne(harness, 'two')];

    await withSalesforce((call) => {
      if (call.method === 'POST') return Response.json([{ message: 'nope', errorCode: 'INVALID_TYPE' }], { status: 400 });
      return Response.json({ Id: TARGET_ID });
    }, async () => {
      const outcome = await uploader(harness, fixtureProvider()).upload({
        objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: refs,
      });
      assert.equal(outcome.status, 'FAILED');
      assert.deepEqual(
        [outcome.totalCount, outcome.succeeded, outcome.failed, outcome.unknown, outcome.notAttempted],
        [2, 0, 2, 0, 0],
      );
    });
  });

  test('an interrupted upload is OUTCOME_UNKNOWN, stops the call, and the rest are NOT_ATTEMPTED', async () => {
    const harness = await createHarness();
    const refs = [await stageOne(harness, 'one'), await stageOne(harness, 'two'), await stageOne(harness, 'three')];
    let posts = 0;

    await withSalesforce((call) => {
      if (call.method === 'POST') {
        posts += 1;
        // No HTTP response at all: the transport failed after the body was sent, which is
        // indistinguishable from a reset after Salesforce accepted it.
        if (posts === 2) throw new Error('socket hang up');
        return Response.json({ id: `06800000000000${posts}AAA`, success: true });
      }
      if (call.url.includes('/query')) return Response.json({ records: [{ ContentDocumentId: '069000000000001AAA' }] });
      return Response.json({ Id: TARGET_ID });
    }, async () => {
      const outcome = await uploader(harness, fixtureProvider()).upload({
        objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: refs,
      });
      assert.equal(outcome.status, 'OUTCOME_UNKNOWN');
      assert.deepEqual(
        [outcome.totalCount, outcome.succeeded, outcome.failed, outcome.unknown, outcome.notAttempted],
        [3, 1, 0, 1, 1],
      );
      assert.deepEqual(
        outcome.results.map((result) => result.status),
        ['SUCCESS', 'OUTCOME_UNKNOWN', 'NOT_ATTEMPTED'],
      );
      // Nothing is sent after an unknown outcome, so the stop is real and not cosmetic.
      assert.equal(posts, 2);
      // An unattempted file carries no error code: nothing failed, and a code would
      // invite a caller to treat it as a retryable failure.
      assert.equal(outcome.results[2]?.errorCode, null);
      assert.equal(outcome.results[1]?.errorCode, 'MCP_ATTACHMENT_OUTCOME_UNKNOWN');
    });
  });

  test('a success that cannot be proven is unknown, not a failure', async () => {
    const harness = await createHarness();
    const ref = await stageOne(harness, 'bytes');

    await withSalesforce((call) => {
      // 200 with a body the runtime cannot parse: the response is not evidence of failure.
      if (call.method === 'POST') return new Response('<html>gateway</html>', { status: 200 });
      return Response.json({ Id: TARGET_ID });
    }, async () => {
      const outcome = await uploader(harness, fixtureProvider()).upload({
        objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: [ref],
      });
      assert.equal(outcome.status, 'OUTCOME_UNKNOWN');
      assert.equal(outcome.results[0]?.status, 'OUTCOME_UNKNOWN');
    });
  });

  test('the aggregate is forced to OUTCOME_UNKNOWN when a host deadline fires mid-upload', async () => {
    const harness = await createHarness();
    const ref = await stageOne(harness, 'bytes');

    await withSalesforce(successfulSalesforce(), async () => {
      const results = await uploader(harness, fixtureProvider())
        .upload({ objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: [ref] })
        .then((outcome) => outcome.results);
      // Two successes then a timeout: the third may or may not have been published, so
      // the aggregate cannot be summarised as a clean success.
      const forced = aggregateAttachmentOutcome(
        { objectApiName: TARGET_OBJECT, recordId: TARGET_ID },
        [
          { ...results[0]!, index: 0 },
          { ...results[0]!, index: 1 },
          { ...results[0]!, index: 2, status: 'OUTCOME_UNKNOWN', contentVersionId: null },
        ],
        'OUTCOME_UNKNOWN',
      );
      assert.equal(forced.status, 'OUTCOME_UNKNOWN');
      assert.equal(forced.unknown, 1);
      assert.equal(forced.succeeded, 2);
    });
  });

  test('an outcome carries one result per requested reference, in order', async () => {
    const harness = await createHarness();
    const refs = [
      await stageOne(harness, 'one'),
      `att_${'q'.repeat(24)}`, // never staged
      await stageOne(harness, 'three'),
    ];

    await withSalesforce(successfulSalesforce(), async () => {
      const outcome = await uploader(harness, fixtureProvider()).upload({
        objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: refs,
      });
      assert.deepEqual(outcome.results.map((result) => result.index), [0, 1, 2]);
      assert.deepEqual(outcome.results.map((result) => result.attachmentRef), refs);
      assert.equal(outcome.status, 'PARTIAL_SUCCESS');
    });
  });

  test('a reference may not be replayed once it has been consumed, and expires on its own clock', async () => {
    const harness = await createHarness({ ttlMs: 1_000 });
    const ref = await stageOne(harness, 'bytes');

    await withSalesforce(successfulSalesforce(), async () => {
      const uploaderInstance = uploader(harness, fixtureProvider());
      const first = await uploaderInstance.upload({
        objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: [ref],
      });
      assert.equal(first.status, 'SUCCESS');
      assert.equal(harness.store.rows.get(ref)?.state, 'CONSUMED');

      const replay = await uploaderInstance.upload({
        objectApiName: TARGET_OBJECT, recordId: TARGET_ID, attachmentRefs: [ref],
      });
      assert.equal(replay.status, 'FAILED');
      assert.equal(replay.results[0]?.errorCode, 'MCP_ATTACHMENT_EXPIRED');
    });

    const expiring = await stageOne(harness, 'bytes');
    harness.store.poison(expiring, { expiresAt: new Date(Date.now() - 1).toISOString() });
    await assert.rejects(
      harness.ingress.resolveForOwner(expiring, OWNER),
      (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_ATTACHMENT_EXPIRED',
    );
  });

  test('the reaper deletes expired staged files and a single owner cannot hoard staging space', async () => {
    const harness = await createHarness({ ttlMs: 1, maxFilesPerOwner: 2 });
    const first = await stageOne(harness, 'one');
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(await harness.ingress.reapExpired(new Date(), 100), 1);
    assert.equal(harness.store.rows.get(first)?.state, 'EXPIRED');
    await assert.rejects(readFile(harness.store.rows.get(first)!.stagedPath), /ENOENT/u);

    // Bounding an owner evicts oldest-first, so the newest file is never the one lost.
    const a = await stageOne(harness, 'a');
    const b = await stageOne(harness, 'b');
    const c = await stageOne(harness, 'c');
    assert.equal(harness.store.rows.get(a)?.state, 'EXPIRED');
    assert.equal(harness.store.rows.get(b)?.state, 'STAGED');
    assert.equal(harness.store.rows.get(c)?.state, 'STAGED');
    // Another owner is untouched by one user's overflow.
    const other = await stageOne(harness, 'other', { platformUserId: OTHER });
    assert.equal(harness.store.rows.get(other)?.state, 'STAGED');
  });
});

describe('gate: audit', () => {
  async function runFacade(
    responder: Responder,
    refs: readonly string[],
    harness: Harness,
    objectApiName = TARGET_OBJECT,
  ): Promise<{ events: LoggedEvent[]; content: string; status: string | undefined }> {
    const events: LoggedEvent[] = [];
    const facade = new AttachmentToolFacade({
      tool: createUploadFilesToRecordTool(),
      context: { platformUserId: OWNER, correlationId: 'corr-fixture', workspaceRoot: root } satisfies RequestContext,
      route: {
        platformUserId: OWNER,
        salesforceUsername: 'requester@example.test',
        credentialProfile: 'USER',
        connectionRole: 'USER',
        aliases: [],
      } satisfies SalesforceIdentityRoute,
      toolTimeoutMs: 5_000,
      logger: { log: (event) => { events.push(event as LoggedEvent); } },
      clientId: 'fixture-client',
      connectionProvider: fixtureProvider(),
      ingress: harness.ingress,
      attachmentPolicy: new StaticAttachmentPolicy([{ objectApiName: TARGET_OBJECT }]),
      platformUserId: OWNER,
      redactionSecrets: [ACCESS_TOKEN],
    });

    let content = '';
    let status: string | undefined;
    await withSalesforce(responder, async () => {
      const result = await facade.execute(
        { objectApiName, recordId: TARGET_ID, attachmentRefs: refs },
        {} as never,
      );
      content = JSON.stringify(result.content) + JSON.stringify(result.structuredContent);
      status = (result.structuredContent as { status?: string } | undefined)?.status;
    });
    return { events, content, status };
  }

  test('the terminal event records the platform ids and the Salesforce ids for every file', async () => {
    const harness = await createHarness();
    const refs = [await stageOne(harness, 'one'), await stageOne(harness, 'two')];
    const { events } = await runFacade(successfulSalesforce(), refs, harness);

    assert.equal(events.length, 1);
    const event = events[0]!;
    const summary = event.responseSummary as Record<string, unknown>;
    const files = summary.files as Record<string, unknown>[];

    assert.equal(event.operation, 'ATTACHMENT');
    assert.equal(event.objectApiName, TARGET_OBJECT);
    assert.equal(event.recordId, TARGET_ID);
    assert.equal(event.salesforceUsername, 'requester@example.test');
    assert.equal(event.platformUserId, OWNER);
    assert.equal(event.executionRole, 'USER');
    assert.equal(summary.salesforceApiType, 'REST_API');
    assert.deepEqual((event.requestSummary as Record<string, unknown>).attachmentRefs, refs);
    assert.equal(files.length, 2);
    for (const file of files) {
      assert.equal(file.contentVersionId, '068000000000001AAA');
      assert.equal(file.contentDocumentId, '069000000000001AAA');
      assert.equal(file.status, 'SUCCESS');
      assert.equal(file.httpStatus, 200);
      assert.equal(typeof file.durationMs, 'number');
      assert.equal(typeof file.fileName, 'string');
    }
    assert.deepEqual(event.auditEvent, {
      eventCategory: 'TOOL', eventType: 'TOOL_TERMINAL', eventName: UPLOAD_FILES_TO_RECORD_TOOL_NAME, terminalSource: 'TOOL',
    });
  });

  test('no audit event, and no tool result, carries a byte, a base64 form, the multipart body, a staged path or the token', async () => {
    const harness = await createHarness();
    const payload = 'CONFIDENTIAL restructuring plan for the acquisition';
    const ref = await stageOne(harness, payload, { fileName: 'confidential.pdf' });
    const stagedPath = harness.store.rows.get(ref)!.stagedPath;

    const { events, content } = await runFacade(successfulSalesforce(), [ref], harness);
    const serialized = JSON.stringify(events);

    assert.equal(serialized.includes(payload), false, 'the file bytes must never be recorded');
    assert.equal(serialized.includes(Buffer.from(payload).toString('base64')), false);
    assert.equal(serialized.includes('multipart/form-data'), false, 'the raw multipart body must never be recorded');
    assert.equal(serialized.includes('VersionData'), false);
    assert.equal(serialized.includes(stagedPath), false, 'a staged absolute path must never be recorded');
    assert.equal(serialized.includes(harness.root), false);
    assert.equal(serialized.includes(ACCESS_TOKEN), false, 'the Bearer token must never be recorded');
    // The tool result echoes the same guarantee: references and metadata, never bytes.
    assert.equal(content.includes(payload), false);
    assert.equal(content.includes(stagedPath), false);
    assert.equal(content.includes(ACCESS_TOKEN), false);
  });

  test('a partial upload is audited as partial with the platform reason, once', async () => {
    const harness = await createHarness();
    const refs = [await stageOne(harness, 'one'), await stageOne(harness, 'two')];
    let posts = 0;

    const { events, status } = await runFacade((call) => {
      if (call.method === 'POST') {
        posts += 1;
        return posts === 2
          ? Response.json([{ message: 'File is too large.', errorCode: 'FILE_TOO_LARGE' }], { status: 400 })
          : Response.json({ id: '068000000000001AAA', success: true });
      }
      if (call.url.includes('/query')) return Response.json({ records: [{ ContentDocumentId: '069000000000001AAA' }] });
      return Response.json({ Id: TARGET_ID });
    }, refs, harness);

    assert.equal(status, 'PARTIAL_SUCCESS');
    assert.equal(events.length, 1, 'one terminal event per invocation, not one per file');
    const event = events[0]!;
    const summary = event.responseSummary as Record<string, unknown>;
    assert.equal(summary.status, 'PARTIAL_SUCCESS');
    assert.equal(summary.partial, true);
    assert.equal(summary.businessOutcome, 'PARTIAL_SUCCESS');
    assert.equal(summary.succeededCount, 1);
    assert.equal(summary.failedCount, 1);
    assert.equal(event.result, 'PASS', 'a partial upload is not a failed request');
    const files = summary.files as Record<string, unknown>[];
    assert.equal(files[1]?.salesforceErrorCode, 'FILE_TOO_LARGE');
    assert.equal(files[1]?.salesforceMessage, 'File is too large.');
  });

  test('an unknown outcome is audited with the unknown event type and a started mutation', async () => {
    const harness = await createHarness();
    const ref = await stageOne(harness, 'bytes');

    const { events, status } = await runFacade((call) => {
      if (call.method === 'POST') throw new Error('socket hang up');
      return Response.json({ Id: TARGET_ID });
    }, [ref], harness);

    assert.equal(status, 'OUTCOME_UNKNOWN');
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.result, 'ERROR');
    assert.equal(event.outcome, 'UNKNOWN');
    assert.equal(event.mutationStarted, true);
    assert.equal(event.terminationLayer, 'TOOL');
    assert.equal(event.errorCode, 'MCP_ATTACHMENT_OUTCOME_UNKNOWN');
    assert.deepEqual((event.auditEvent as Record<string, unknown>).eventType, 'ATTACHMENT_OUTCOME_UNKNOWN');
  });

  test('a call refused before anything was sent is audited as a terminal error with no mutation evidence', async () => {
    const harness = await createHarness();
    const ref = await stageOne(harness, 'bytes');

    const { events, status } = await runFacade(successfulSalesforce(), [ref], harness, 'Account');

    assert.equal(status, undefined, 'a refused call reports an error, not an outcome');
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.result, 'ERROR');
    assert.equal(event.errorCode, 'MCP_ATTACHMENT_OBJECT_NOT_ALLOWED');
    assert.equal(event.mutationStarted, undefined, 'nothing was sent, so nothing may claim a started mutation');
  });

  test('a file that is not owned is reported per file and never reaches Salesforce', async () => {
    const harness = await createHarness();
    const ref = await stageOne(harness, 'bytes');

    const { events, status } = await runFacade(
      successfulSalesforce(),
      [ref, `att_${'q'.repeat(24)}`],
      harness,
    );

    assert.equal(status, 'PARTIAL_SUCCESS');
    const files = (events[0]!.responseSummary as Record<string, unknown>).files as Record<string, unknown>[];
    assert.equal(files[1]?.status, 'FAILED');
    assert.equal(files[1]?.errorCode, 'MCP_ATTACHMENT_NOT_OWNED');
    assert.equal(files[1]?.fileName, null, 'an unresolved reference has no file name to report');
  });
});
