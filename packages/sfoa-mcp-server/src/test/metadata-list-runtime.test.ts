import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpTool, ReleaseState, type McpToolConfig, Toolset } from '@salesforce/mcp-provider-api';
import {
  CwdExecutionGuard,
  RequestWorkspaceFactory,
  createIdentityRuntime,
  type RequestToolSource,
  type RuntimeLogEvent,
  type RuntimeLogger,
} from '@sfoa/identity-runtime';
import { z } from 'zod';
import { startRemoteMcpServer, type RemoteMcpServer } from '../http-server.js';
import { DEFAULT_ENABLED_TOOLS } from '../tool-governance.js';
import {
  RecordingConnectionFactory,
  TEST_CLIENT_TOKEN,
  TEST_DIAGNOSTIC_USERNAME,
  TEST_PLATFORM_USER_A,
  TEST_PLATFORM_USER_B,
  TEST_USERNAME_A,
  TEST_USERNAME_B,
  createTestRemoteConfig,
  mcpHeaders,
} from './helpers.js';

/**
 * `list_metadata_components` at the protocol boundary, over the real Streamable HTTP surface.
 *
 * The provider suite covers the listing as a function — the filter, the counts, the byte budget, the hint
 * builder. Four claims are only true here, and neither a provider-side nor a host-side unit test can make
 * any of them:
 *
 * 1. **Invisible until enabled.** Governance decides which names exist. A Tool the Console has not enabled
 *    is absent from `tools/list`, so an Agent cannot plan around it, and a call to the name is denied
 *    before a Provider is composed and before any Connection is opened.
 * 2. **Routed to the server-owned DIAGNOSTIC identity.** The role map decides that before the Tool body
 *    runs, so the `metadata.list` call is made on the Connection carrying the fixed diagnostic username
 *    rather than the caller's route — the failure the whole role classification exists to prevent, and
 *    one that is invisible to a test that hands the executor a scope directly.
 * 3. **The name the listing returns is the name the reader accepts, byte-for-byte.** This org stores
 *    localized, URL-escaped component full names (`风控负责`, `WRN业务员%2F业务主管%2F市场开发`). The pair
 *    is only a pair if the listing's output is the reader's input *verbatim*: decoding `%2F` addresses a
 *    different component, so the round trip is asserted here, across two real Tools on one session.
 * 4. **The enumeration is audited under its own purpose,** separate from the reader's.
 */
const LIST_TOOLS = ['list_metadata_components'] as const;
const READER_TOOL = 'get_metadata_component_context';

/**
 * The names this org actually stores, as T0 measured them: one ASCII name, one Chinese name, and one whose
 * separators are URL-escaped. A fixture of ASCII-only names would let the whole `%2F` class of defect pass.
 */
const URL_ESCAPED_NAME = 'WRN业务员%2F业务主管%2F市场开发';
const LOCALIZED_NAME = '风控负责';
const DELETED_NAME = '已废弃的配置';

class RecordingLogger implements RuntimeLogger {
  public readonly events: RuntimeLogEvent[] = [];

  public log(event: RuntimeLogEvent): void {
    this.events.push(event);
  }

  public forTool(toolName: string): RuntimeLogEvent[] {
    return this.events.filter((event) => event.toolName === toolName);
  }
}

/**
 * The `Profile` inventory, shaped the way the Metadata API returns one.
 *
 * `Profile` is the fixture type on purpose: it is the type that carries **no** `manageableState` on some
 * orgs and no `maintainable`-style fields at all, so it is the type that proves the entry projection is
 * per-type rather than a fixed shape — while still carrying a `deleted` member here, which is what the
 * `includeInactive` default has to filter.
 */
function profileInventory(): unknown {
  return [
    { fullName: DELETED_NAME, manageableState: 'deleted', lastModifiedByName: 'Someone', fileName: 'profiles/old.profile' },
    { fullName: LOCALIZED_NAME, manageableState: 'unmanaged' },
    { fullName: URL_ESCAPED_NAME, manageableState: 'released', lastModifiedByName: 'Somebody' },
    {
      fullName: 'Admin',
      manageableState: 'released',
      lastModifiedByName: '管理员',
      lastModifiedDate: '2026-09-30T00:00:00.000+0000',
      fileName: 'profiles/Admin.profile',
    },
  ];
}

type Harness = Readonly<{
  server: RemoteMcpServer;
  client: Client;
  factory: RecordingConnectionFactory;
  logger: RecordingLogger;
  close(): Promise<void>;
}>;

async function startHarness(options: Readonly<{
  enabledTools: readonly string[];
  diagnosticUsername?: string;
  toolSource?: RequestToolSource;
  /** The Metadata API answer. The default is refused by the fixture rather than answered. */
  metadataList?: (queries: readonly { type: string }[]) => unknown;
}>): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-p10-metadatalist-http-'));
  const factory = new RecordingConnectionFactory(
    options.metadataList === undefined ? {} : { metadataList: options.metadataList },
  );
  const logger = new RecordingLogger();
  const identity = {
    projectRoot: root,
    instanceUrl: 'https://example.test',
    primaryUsername: TEST_USERNAME_A,
    secondaryUsername: TEST_USERNAME_B,
    clientId: 'test-connected-app',
    privateKeyPath: path.join(root, 'unused.pem'),
    platformUserA: TEST_PLATFORM_USER_A,
    platformUserB: TEST_PLATFORM_USER_B,
    concurrentRequests: 50,
    port: 3000,
    ...(options.diagnosticUsername === undefined ? {} : { diagnosticUsername: options.diagnosticUsername }),
  } as const;
  const identityRuntime = createIdentityRuntime(identity, {
    connectionFactory: factory,
    workspaceFactory: new RequestWorkspaceFactory({ baseRoot: path.join(root, 'requests') }),
    cwdGuard: new CwdExecutionGuard(),
    logger,
  });
  const config = {
    ...createTestRemoteConfig({
      enabledTools: options.enabledTools,
      requestTimeoutMs: 10_000,
      toolTimeoutMs: 5_000,
    }),
    identity,
  };
  const server = await startRemoteMcpServer({
    config,
    identityRuntime,
    ...(options.toolSource === undefined ? {} : { toolSource: options.toolSource }),
  });
  const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
    requestInit: { headers: mcpHeaders(TEST_PLATFORM_USER_A, TEST_CLIENT_TOKEN) },
  });
  const client = new Client({ name: 'p10-metadatalist-http-test', version: '1.0.0' });
  await client.connect(transport);
  return {
    server,
    client,
    factory,
    logger,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

/** The Tool's structured answer, narrowed back to something a test can read key by key. */
function structured(result: unknown): Record<string, unknown> {
  const content = (result as { structuredContent?: unknown }).structuredContent;
  assert.ok(content !== undefined, 'the Tool must answer with structuredContent');
  return content as Record<string, unknown>;
}

function componentNames(output: Record<string, unknown>): string[] {
  const components = output.components;
  assert.ok(Array.isArray(components), 'the answer must carry a components array');
  return components.map((component) => String((component as Record<string, unknown>).fullName));
}

test('list_metadata_components is absent from tools/list until an Admin enables it', async () => {
  const harness = await startHarness({
    enabledTools: [...DEFAULT_ENABLED_TOOLS],
    diagnosticUsername: TEST_DIAGNOSTIC_USERNAME,
  });
  try {
    const names = (await harness.client.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.includes('list_metadata_components'), false,
      'list_metadata_components must not be advertised while it is disabled');

    await assert.rejects(
      harness.client.callTool({ name: 'list_metadata_components', arguments: { metadataType: 'Profile' } }),
      (error: unknown) => /list_metadata_components/u.test(String(error)),
    );
    const denial = harness.logger.forTool('list_metadata_components')
      .find((event) => event.auditEvent?.eventType === 'GOVERNANCE_DENIED');
    assert.ok(denial !== undefined, 'a disabled-Tool attempt must be audited as a governance denial');
    assert.equal(denial.result, 'BLOCKED');
    assert.equal(denial.outcome, 'DENIED');
    assert.equal(denial.errorCode, 'MCP_TOOL_DISABLED');
    // A refusal that had already reached the org would not be a refusal: the denial happens before the
    // Provider is composed, so neither a Connection nor a Metadata API call can have happened.
    assert.deepEqual(harness.factory.creations, []);
    assert.deepEqual(harness.factory.metadataListCalls, []);
  } finally {
    await harness.close();
  }
});

test('an enabled list_metadata_components call enumerates on the fixed DIAGNOSTIC identity with byte-exact names', async () => {
  const harness = await startHarness({
    enabledTools: [...DEFAULT_ENABLED_TOOLS, ...LIST_TOOLS],
    diagnosticUsername: TEST_DIAGNOSTIC_USERNAME,
    metadataList: () => profileInventory(),
  });
  try {
    const listed = await harness.client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === 'list_metadata_components');
    assert.ok(tool !== undefined, 'list_metadata_components must be advertised once an Admin enables it');
    assert.deepEqual(
      Object.keys(tool.inputSchema.properties ?? {}).sort(),
      ['developerNamePrefix', 'includeInactive', 'limit', 'metadataType'].sort(),
    );
    // Read-only, and the annotation is a claim an Agent plans on: this Tool enumerates component
    // definitions and must never be mistaken for one that can change them.
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(harness.factory.creations.length, 0, 'initialize and tools/list must not open a Connection');

    const result = await harness.client.callTool({
      name: 'list_metadata_components',
      arguments: { metadataType: 'Profile' },
    });
    assert.equal(result.isError === true, false);
    const output = structured(result);
    assert.equal(output.executionRole, 'DIAGNOSTIC');
    assert.equal(output.metadataType, 'Profile');
    assert.equal(output.includeInactive, false);
    // The recycled component is excluded by the default and the three live ones are not, and the counts
    // are post-filter: the number an operator reads has to be the number the filter produced.
    assert.equal(output.totalCount, 3);
    assert.equal(output.returnedCount, 3);
    assert.equal(output.truncated, false);
    // Byte-exact, not merely present: the `%2F` is the stored form and the localized name is the stored
    // string, and a caller passing either of them back is the only way the pair works.
    assert.deepEqual(componentNames(output), ['Admin', URL_ESCAPED_NAME, LOCALIZED_NAME]);
    assert.deepEqual(output.components, [
      {
        fullName: 'Admin',
        manageableState: 'released',
        lastModifiedBy: '管理员',
        lastModifiedDate: '2026-09-30T00:00:00.000+0000',
        fileName: 'profiles/Admin.profile',
      },
      { fullName: URL_ESCAPED_NAME, manageableState: 'released', lastModifiedBy: 'Somebody' },
      { fullName: LOCALIZED_NAME, manageableState: 'unmanaged' },
    ]);
    // The reader is switched off in this composition, so the hint may not name it: a hint that did would
    // send the Agent to a Tool its own `tools/list` does not carry.
    assert.doesNotMatch(String(output.hint), new RegExp(READER_TOOL, 'u'));
    assert.match(String(output.hint), /exact full name/u);

    // The enumeration ran on the server-owned diagnostic identity, and the caller's own route was never
    // used for it.
    assert.deepEqual(harness.factory.metadataListCalls, ['Profile']);
    assert.ok(harness.factory.creations.some((entry) =>
      entry.connectionRole === 'DIAGNOSTIC' && entry.salesforceUsername === TEST_DIAGNOSTIC_USERNAME));
    assert.equal(harness.factory.creations.some((entry) => entry.connectionRole === 'USER'), false,
      'a diagnostic Tool must not open a Connection as the caller');

    const terminal = harness.logger.forTool('list_metadata_components')
      .find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
    assert.ok(terminal !== undefined, 'list_metadata_components must emit a TOOL_TERMINAL audit event');
    assert.equal(terminal.result, 'PASS');
    assert.equal(terminal.executionRole, 'DIAGNOSTIC');
    assert.equal(terminal.salesforceUsername, TEST_DIAGNOSTIC_USERNAME);
    assert.equal(terminal.platformUserId, TEST_PLATFORM_USER_A);
    // Which type was enumerated, and with what filter: "who listed every Profile" is unanswerable from a
    // row that recorded only that a listing happened.
    assert.deepEqual(terminal.requestSummary, {
      metadataType: 'Profile',
      developerNamePrefix: null,
      includeInactive: false,
      limit: null,
    });
    assert.deepEqual(terminal.responseSummary, {
      isError: false,
      returnedCount: 3,
      totalCount: 3,
      truncated: false,
    });
  } finally {
    await harness.close();
  }
});

test('the wire honours includeInactive, the limit and the prefix, and reports truncation with the honest counts', async () => {
  const harness = await startHarness({
    enabledTools: [...DEFAULT_ENABLED_TOOLS, ...LIST_TOOLS],
    diagnosticUsername: TEST_DIAGNOSTIC_USERNAME,
    metadataList: () => profileInventory(),
  });
  try {
    const withInactive = structured(await harness.client.callTool({
      name: 'list_metadata_components',
      arguments: { metadataType: 'Profile', includeInactive: true },
    }));
    assert.equal(withInactive.includeInactive, true);
    assert.equal(withInactive.totalCount, 4);
    assert.deepEqual(componentNames(withInactive).includes(DELETED_NAME), true,
      'includeInactive: true must surface the recycled component the default hides');
    // The effective default is stated on the response rather than left to the caller to infer from the
    // counts, and the hint drops its inactive note once the caller has asked for them.
    assert.doesNotMatch(String(withInactive.hint), /includeInactive to/u);

    const limited = structured(await harness.client.callTool({
      name: 'list_metadata_components',
      arguments: { metadataType: 'Profile', limit: 1 },
    }));
    assert.equal(limited.totalCount, 3, 'the matched count is post-filter and pre-slice');
    assert.equal(limited.returnedCount, 1);
    assert.equal(limited.truncated, true);
    assert.deepEqual(componentNames(limited), ['Admin']);
    // There is no offset parameter, so the hint has to name the remedy that exists: walk past the cap with
    // a narrower prefix rather than re-running the same call.
    assert.match(String(limited.hint), /1 of 3/u);
    assert.match(String(limited.hint), /narrow developerNamePrefix/u);

    const prefixMiss = structured(await harness.client.callTool({
      name: 'list_metadata_components',
      arguments: { metadataType: 'Profile', developerNamePrefix: 'Nonexistent' },
    }));
    assert.equal(prefixMiss.totalCount, 0);
    assert.equal(prefixMiss.returnedCount, 0);
    assert.equal(prefixMiss.truncated, false);
    assert.equal(prefixMiss.developerNamePrefix, 'Nonexistent');
    // "your filter matched nothing" is not "this org has none", and the hint says which one it is.
    assert.match(String(prefixMiss.hint), /not about/u);
    assert.doesNotMatch(String(prefixMiss.hint), /lists no component of this type/u);

    assert.deepEqual(harness.factory.metadataListCalls, ['Profile', 'Profile', 'Profile']);
  } finally {
    await harness.close();
  }
});

const retrieveSchema = z.object({
  ignoreConflicts: z.boolean().optional(),
  sourceDir: z.array(z.string()).optional(),
  manifest: z.string().optional(),
  usernameOrAlias: z.string(),
  directory: z.string(),
});
type RetrieveInput = z.infer<typeof retrieveSchema>;

/**
 * A stand-in for the official `retrieve_metadata` Tool, faithful in the one respect this test reads: it
 * writes the retrieved member under **the name the manifest asked for**, so the name that reached
 * Salesforce is observable in the file the reader then returns. A fake that wrote a fixed file would let
 * a decoded or re-encoded `fullName` pass.
 */
class RecordingRetrieveToolSource implements RequestToolSource {
  public readonly manifests: string[] = [];

  public provideTools(): Promise<McpTool[]> {
    return Promise.resolve([new RecordingRetrieveTool(this.manifests)]);
  }
}

class RecordingRetrieveTool extends McpTool<typeof retrieveSchema.shape> {
  public constructor(private readonly manifests: string[]) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.METADATA];
  }

  public getName(): string {
    return 'retrieve_metadata';
  }

  public getConfig(): McpToolConfig<typeof retrieveSchema.shape> {
    return { inputSchema: retrieveSchema.shape };
  }

  public async exec(input: RetrieveInput): Promise<CallToolResult> {
    const parsed = retrieveSchema.parse(input);
    const manifest = parsed.manifest;
    if (manifest === undefined) {
      return { isError: true, content: [{ type: 'text', text: 'manifest required' }] };
    }
    // `manifest` arrives **absolute**: the adapter hands the runtime a path relative to the request
    // workspace and the execution adapter resolves it inside that workspace before the Tool runs. Reading
    // it directly is therefore both what the official Tool does and the reason a forged
    // `..\\secret.xml` cannot reach this Tool at all.
    const declared = await readFile(manifest, 'utf8');
    this.manifests.push(declared);
    const member = /<members>([\s\S]*?)<\/members>/u.exec(declared)?.[1] ?? 'Unknown';
    const type = /<name>([\s\S]*?)<\/name>/u.exec(declared)?.[1] ?? 'Unknown';
    const target = path.join(parsed.directory, 'force-app', 'main', 'default', type.toLocaleLowerCase('en-US'));
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, `${member}.${type}-meta.xml`), '<?xml version="1.0"?><Profile/>', 'utf8');
    return { content: [{ type: 'text', text: 'Retrieve result: {"success":true}' }] };
  }
}

test('the listing and the reader round-trip this org\'s URL-escaped name over one session', async () => {
  const source = new RecordingRetrieveToolSource();
  // Only the two metadata Tools are enabled here: this composition is about the pair, and a source that
  // supplies the official Tool inventory has to supply every name the policy is asked for.
  const harness = await startHarness({
    enabledTools: [...LIST_TOOLS, READER_TOOL],
    diagnosticUsername: TEST_DIAGNOSTIC_USERNAME,
    metadataList: () => profileInventory(),
    toolSource: source,
  });
  try {
    const names = (await harness.client.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.includes(READER_TOOL), true, 'the reader is advertised once it is enabled');

    const listing = structured(await harness.client.callTool({
      name: 'list_metadata_components',
      arguments: { metadataType: 'Profile' },
    }));
    const escaped = componentNames(listing).find((name) => name === URL_ESCAPED_NAME);
    assert.ok(escaped !== undefined, 'the listing must carry the URL-escaped name byte-for-byte');
    // With the reader advertised, the hint is allowed to name it — and does, because the whole point of
    // the listing is to hand a name to it.
    assert.match(String(listing.hint), new RegExp(READER_TOOL, 'u'));
    assert.match(String(listing.hint), /verbatim/u);

    const read = await harness.client.callTool({
      name: READER_TOOL,
      arguments: { metadataType: 'Profile', fullName: escaped },
    });
    assert.equal(
      read.isError === true,
      false,
      `the reader must accept the name the listing returned unchanged, but it answered ${JSON.stringify(read)}`,
    );
    const output = structured(read);
    assert.equal(output.executionRole, 'DIAGNOSTIC');
    assert.equal(output.fullName, escaped);
    assert.equal(output.truncated, false);

    // What reached the official retrieve is the same string, escaped but never decoded: `%2F` is not a
    // path separator here and must not become one.
    assert.equal(source.manifests.length, 1);
    assert.match(source.manifests[0] ?? '', /<members>WRN业务员%2F业务主管%2F市场开发<\/members>/u);
    const files = output.files as Record<string, unknown>[];
    assert.equal(files.length, 1);
    // The directory is lowercased and the file name is not: the source tree keeps the type's own casing in
    // the member name, which is what makes this the retrieved component rather than a fixed fixture file.
    assert.match(String(files[0]?.relativePath), /profile\/WRN业务员%2F业务主管%2F市场开发\.Profile-meta\.xml$/u);
  } finally {
    await harness.close();
  }
});

test('the enumeration is audited under its own purpose, separate from the reader\'s retrieval', async () => {
  // The purpose is attached to Salesforce API audit records the instrumented Connection emits, which this
  // fixture deliberately does not model, so reading the table is the only way to fail when a later edit
  // folds the two together. The distinction matters for the reason the map's own comment gives: `listMetadata`
  // and `retrieve` are different Metadata API operations and the wire category (`METADATA_API`) is the same
  // for both, so the purpose is the only field that can tell "who enumerated this org's permission sets"
  // from "who read one".
  const source = await readFile(new URL('../context-tool-facade.js', import.meta.url), 'utf8');
  assert.match(source, /list_metadata_components: 'METADATA_LIST'/u);
  assert.match(source, /get_metadata_component_context: 'METADATA_RETRIEVE'/u);
});
