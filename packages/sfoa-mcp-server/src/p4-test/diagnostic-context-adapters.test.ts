import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from '@salesforce/core';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import {
  CwdExecutionGuard,
  createIdentityRuntime,
  NoopRuntimeLogger,
  RequestScopedToolExecutionAdapter,
  RequestWorkspaceFactory,
  type RequestScope,
  type SalesforceConnectionFactory,
  type SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import { z } from 'zod';
import {
  METADATA_CONTEXT_LIMITS,
  OfficialDiagnosticToolingQueryExecutor,
  OfficialMetadataComponentContextExecutor,
  OfficialMetadataComponentLister,
} from '../diagnostic-context-adapters.js';

const diagnosticUsername = 'fixed-diagnostic@example.test';

test('diagnostic query adapter forces the fixed identity, workspace, and Tooling API while bounding results', async () => {
  const fixture = await createDiagnosticFixture();
  const tool = new FakeQueryTool();
  const adapter = createAdapter(fixture.scope, fixture.runtime.cwdGuard);
  try {
    const output = await new OfficialDiagnosticToolingQueryExecutor(fixture.scope, adapter, tool).execute({
      query: 'SELECT Id FROM ApexClass',
    });
    assert.equal(tool.inputs.length, 1);
    assert.equal(tool.inputs[0]?.usernameOrAlias, diagnosticUsername);
    assert.equal(tool.inputs[0]?.directory, fixture.scope.workspace.root);
    assert.equal(tool.inputs[0]?.useToolingApi, true);
    assert.equal(output.totalSize, 205);
    assert.equal(output.returnedRecords, 200);
    assert.equal(output.truncated, true);
    assert.equal(output.records[0]?.Id, 'tooling-0');
    assert.equal(output.records[0]?.Secret, 'Bearer <redacted>');
  } finally {
    await fixture.close();
  }
});

test('metadata adapter generates its own manifest, reuses official retrieve, bounds content, restores CWD, and cleans exactly', async () => {
  const fixture = await createDiagnosticFixture();
  const tool = new FakeRetrieveTool();
  const adapter = createAdapter(fixture.scope, fixture.runtime.cwdGuard);
  const originalCwd = process.cwd();
  const root = fixture.scope.workspace.root;
  try {
    const output = await new OfficialMetadataComponentContextExecutor(fixture.scope, adapter, tool).execute({
      metadataType: 'ApexClass',
      fullName: 'ControlledClass',
    });
    assert.equal(tool.inputs.length, 1);
    assert.equal(tool.inputs[0]?.usernameOrAlias, diagnosticUsername);
    assert.equal(tool.inputs[0]?.directory, root);
    assert.equal(tool.inputs[0]?.ignoreConflicts, true);
    assert.ok(tool.inputs[0]?.manifest.startsWith(root));
    assert.equal(process.cwd(), originalCwd);
    assert.equal(output.executionRole, 'DIAGNOSTIC');
    assert.equal(output.totalFiles, 46);
    assert.ok((output.returnedFiles ?? 0) <= METADATA_CONTEXT_LIMITS.maxReturnedFiles);
    assert.ok((output.returnedBytes ?? 0) <= METADATA_CONTEXT_LIMITS.maxTotalBytes);
    assert.equal(output.truncated, true);
    assert.ok(output.files?.every((file) => file.returnedBytes <= METADATA_CONTEXT_LIMITS.maxFileBytes));
    assert.doesNotMatch(JSON.stringify(output.files), /BEGIN PRIVATE KEY/u);
    assert.match(JSON.stringify(output.files), /redacted-private-key/u);
    const manifest = await readFile(tool.inputs[0]?.manifest ?? '', 'utf8');
    assert.match(manifest, /<members>ControlledClass<\/members>/u);
    assert.match(manifest, /<name>ApexClass<\/name>/u);
  } finally {
    await fixture.close();
  }
  assert.equal(await pathExists(root), false);
  assert.equal(fixture.runtime.workspaceFactory.getMetrics().active, 0);
  assert.equal(fixture.runtime.workspaceFactory.getMetrics().created, fixture.runtime.workspaceFactory.getMetrics().cleaned);
});

test('concurrent official metadata calls are serialized by the accepted process CWD guard', async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p4-metadata-concurrency-'));
  const originalCwd = process.cwd();
  const connectionFactory = new TestConnectionFactory();
  const workspaceFactory = new RequestWorkspaceFactory({ baseRoot: path.join(testRoot, 'requests') });
  const cwdGuard = new CwdExecutionGuard();
  const runtime = createIdentityRuntime(identityConfig(testRoot), {
    connectionFactory,
    workspaceFactory,
    cwdGuard,
    logger: new NoopRuntimeLogger(),
  });
  const first = await runtime.diagnosticScopeFactory?.create({ platformUserId: 'user-a', correlationId: 'meta-a' });
  const second = await runtime.diagnosticScopeFactory?.create({ platformUserId: 'user-b', correlationId: 'meta-b' });
  assert.ok(first && second);
  const tool = new FakeRetrieveTool(30);
  try {
    const firstExecutor = new OfficialMetadataComponentContextExecutor(first, createAdapter(first, cwdGuard), tool);
    const secondExecutor = new OfficialMetadataComponentContextExecutor(second, createAdapter(second, cwdGuard), tool);
    await Promise.all([
      firstExecutor.execute({ metadataType: 'ApexClass', fullName: 'One' }),
      secondExecutor.execute({ metadataType: 'ApexClass', fullName: 'Two' }),
    ]);
    assert.equal(tool.maxActive, 1);
    assert.equal(process.cwd(), originalCwd);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/**
 * The listing half of the metadata pair, on a scripted connection.
 *
 * Every assertion here is about a decision the *host* makes rather than the provider: which identity the
 * Connection belongs to, which entries survive the filters, which the limit and the budget drop, and
 * whether the hint may name a Tool this session advertises. The provider cannot see any of that, which is
 * why the executor lives here.
 */
test('the metadata lister enumerates one type on the fixed identity, filters, sorts, and echoes the effective switches', async () => {
  const factory = new ScriptedMetadataListConnectionFactory([
    // Deliberately unsorted, and carrying the shapes T0 measured: a localized name, an escaped name, a
    // `deleted` component, and one entry with no provenance at all (the `Profile` shape).
    { fullName: '风控负责', manageableState: 'released', lastModifiedByName: 'Wang', fileName: 'profiles/a.profile' },
    { fullName: 'WRN业务员%2F业务主管%2F市场开发', manageableState: 'released', lastModifiedByName: 'Li' },
    { fullName: 'Admin' },
    { fullName: 'Binned', manageableState: 'deleted', lastModifiedByName: 'Zhao' },
    { fullName: 'Alpha', manageableState: 'released', lastModifiedByName: 'Chen', lastModifiedDate: '2026-09-01T00:00:00.000Z' },
  ]);
  const fixture = await createDiagnosticFixture(factory);
  try {
    const output = await new OfficialMetadataComponentLister(fixture.scope, ['list_metadata_components'])
      .execute({ metadataType: 'Profile' });

    // One call, for the one requested type, on the request's own Connection — never a shared one.
    assert.deepEqual(factory.listCalls, [{ type: 'Profile' }]);
    assert.equal(output.executionRole, 'DIAGNOSTIC');
    assert.equal(output.metadataType, 'Profile');
    assert.equal(output.includeInactive, false);
    // `deleted` is dropped by the default, so the matched count is 4 and nothing was truncated.
    assert.equal(output.totalCount, 4);
    assert.equal(output.returnedCount, 4);
    assert.equal(output.truncated, false);
    assert.equal(output.developerNamePrefix, undefined);
    // Sorted by full name, so the same call drops the same entries when the limit binds.
    assert.deepEqual(output.components?.map((component) => component.fullName),
      ['Admin', 'Alpha', 'WRN业务员%2F业务主管%2F市场开发', '风控负责']);
    // Byte-exact, both the escaped and the localized name: a decoded form addresses another component.
    assert.ok(output.components?.some((component) => component.fullName === 'WRN业务员%2F业务主管%2F市场开发'));
    assert.ok(output.components?.some((component) => component.fullName === '风控负责'));
    // `lastModifiedBy` comes from whatever the listing carries, and a missing field is absent rather
    // than empty — `Profile` carries no `manageableState` at all, and that is not a contract violation.
    assert.equal(output.components?.[1]?.lastModifiedBy, 'Chen');
    assert.equal(output.components?.[1]?.lastModifiedDate, '2026-09-01T00:00:00.000Z');
    assert.deepEqual(output.components?.[0], { fullName: 'Admin' });
    assert.match(output.hint ?? '', /4 component/u);
    // The reader is not advertised here, so the hint must not name it.
    assert.doesNotMatch(output.hint ?? '', /get_metadata_component_context/u);
  } finally {
    await fixture.close();
  }
});

test('the metadata lister keeps a deleted component only when the caller asks, and says so in the response', async () => {
  const factory = new ScriptedMetadataListConnectionFactory([
    { fullName: 'Admin' },
    { fullName: 'Binned', manageableState: 'deleted' },
    // Not `deleted`: every other manageable state is live, so a wider definition of "inactive" would
    // drop a component the org still enforces.
    { fullName: 'Deprecated', manageableState: 'deprecated' },
  ]);
  const fixture = await createDiagnosticFixture(factory);
  try {
    const output = await new OfficialMetadataComponentLister(fixture.scope, ['get_metadata_component_context'])
      .execute({ metadataType: 'Profile', includeInactive: true });
    assert.equal(output.includeInactive, true);
    assert.deepEqual(output.components?.map((component) => component.fullName),
      ['Admin', 'Binned', 'Deprecated']);
    assert.equal(output.totalCount, 3);
    // The reader *is* advertised here, so the hint may name it — and must say "verbatim".
    assert.match(output.hint ?? '', /get_metadata_component_context/u);
    assert.match(output.hint ?? '', /verbatim/u);
  } finally {
    await fixture.close();
  }
});

test('the metadata lister applies the prefix locally and reports the matched count separately from what it returns', async () => {
  const factory = new ScriptedMetadataListConnectionFactory(
    ['SHRN工程管理总监%2F项目经理', 'SHRN工程管理总监', 'SHRN其他', 'Other'].map((fullName) => ({ fullName })),
  );
  const fixture = await createDiagnosticFixture(factory);
  try {
    const lister = new OfficialMetadataComponentLister(fixture.scope, ['list_metadata_components']);
    const prefixed = await lister.execute({ metadataType: 'Profile', developerNamePrefix: 'SHRN', limit: 2 });
    // The filter is local: the Connection still sees exactly one query, and the count is post-filter.
    assert.deepEqual(factory.listCalls, [{ type: 'Profile' }]);
    assert.equal(prefixed.developerNamePrefix, 'SHRN');
    assert.equal(prefixed.totalCount, 3);
    assert.equal(prefixed.returnedCount, 2);
    // The limit cut the list, so this is incomplete — and incomplete by the caller's own bound, which
    // the hint has to say rather than blaming the response budget.
    assert.equal(prefixed.truncated, true);
    assert.match(prefixed.hint ?? '', /2 of 3/u);
    assert.match(prefixed.hint ?? '', /developerNamePrefix/u);

    const missed = await lister.execute({ metadataType: 'Profile', developerNamePrefix: '不存在的' });
    assert.equal(missed.totalCount, 0);
    assert.equal(missed.returnedCount, 0);
    assert.equal(missed.truncated, false);
    // "Your prefix matched nothing" is a statement about the prefix, not about the org.
    assert.doesNotMatch(missed.hint ?? '', /no component of this type/u);
  } finally {
    await fixture.close();
  }
});

test('an org that refuses to list a type produces the A-4 refusal rather than an empty inventory', async () => {
  const factory = new ScriptedMetadataListConnectionFactory(
    Object.assign(new Error('denied'), { errorCode: 'INSUFFICIENT_ACCESS' }),
  );
  const fixture = await createDiagnosticFixture(factory);
  try {
    // The distinction this asserts is the whole of ADR-0029 §3: an empty list would read as "this org
    // has no PermissionSet", which is a claim the Tool never earned.
    await assert.rejects(
      async () => new OfficialMetadataComponentLister(fixture.scope, []).execute({ metadataType: 'PermissionSet' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const contextError = error as Error & { code?: string; prerequisite?: string; salesforceErrorCode?: string };
        assert.equal(contextError.code, 'MCP_METADATA_TYPE_UNAVAILABLE');
        assert.equal(contextError.prerequisite, 'A-4');
        assert.equal(contextError.salesforceErrorCode, 'INSUFFICIENT_ACCESS');
        assert.match(contextError.message, /PermissionSet/u);
        return true;
      },
    );
  } finally {
    await fixture.close();
  }
});

test('a jsforce-namespaced code still classifies as the A-4 refusal, not as an API failure', async () => {
  // The shape is the one the test org actually threw, not a convenient one: the Metadata API answers a
  // type it does not know with `errorCode: 'sf:INVALID_TYPE'` at the top level and again under `data`, and
  // the shared reader's identifier-only safety pattern drops a colon-bearing code to null. Before this was
  // handled, that combination made every code in METADATA_LIST_UNAVAILABLE_CODES unreachable and reported
  // a per-type authorization fact as a generic retryable failure — the live run found it, the unit tests
  // had not, because they threw bare codes.
  const factory = new ScriptedMetadataListConnectionFactory(Object.assign(new Error('Invalid type'), {
    name: 'sf:INVALID_TYPE',
    errorCode: 'sf:INVALID_TYPE',
    data: { errorCode: 'sf:INVALID_TYPE', message: 'INVALID_TYPE: Unknown type:CustomSetting' },
  }));
  const fixture = await createDiagnosticFixture(factory);
  try {
    await assert.rejects(
      async () => new OfficialMetadataComponentLister(fixture.scope, []).execute({ metadataType: 'PermissionSet' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const contextError = error as Error & { code?: string; prerequisite?: string; salesforceErrorCode?: string };
        assert.equal(contextError.code, 'MCP_METADATA_TYPE_UNAVAILABLE');
        assert.equal(contextError.prerequisite, 'A-4');
        // The bare code, not jsforce's namespace: the field is what an operator searches Salesforce for.
        assert.equal(contextError.salesforceErrorCode, 'INVALID_TYPE');
        return true;
      },
    );
  } finally {
    await fixture.close();
  }
});

test('a namespaced code the allowlist does not classify stays a plain failure', async () => {
  // The namespace strip must not turn every SOAP fault into a per-type authorization fact: only the codes
  // METADATA_LIST_UNAVAILABLE_CODES names may carry `prerequisite`, whatever prefix they arrived with.
  const factory = new ScriptedMetadataListConnectionFactory(
    Object.assign(new Error('boom'), { errorCode: 'sf:UNKNOWN_FAULT' }),
  );
  const fixture = await createDiagnosticFixture(factory);
  try {
    await assert.rejects(
      async () => new OfficialMetadataComponentLister(fixture.scope, []).execute({ metadataType: 'Flow' }),
      (error: unknown) => {
        const contextError = error as Error & { code?: string; prerequisite?: string; salesforceErrorCode?: string };
        assert.equal(contextError.code, 'MCP_METADATA_LIST_FAILED');
        assert.equal(contextError.prerequisite, undefined);
        assert.equal(contextError.salesforceErrorCode, 'UNKNOWN_FAULT');
        return true;
      },
    );
  } finally {
    await fixture.close();
  }
});

test('an unrecognized Salesforce failure is reported as a failure, not as a missing prerequisite', async () => {
  const factory = new ScriptedMetadataListConnectionFactory(
    Object.assign(new Error('gateway'), { errorCode: 'SERVER_UNAVAILABLE' }),
  );
  const fixture = await createDiagnosticFixture(factory);
  try {
    await assert.rejects(
      async () => new OfficialMetadataComponentLister(fixture.scope, []).execute({ metadataType: 'Flow' }),
      (error: unknown) => {
        const contextError = error as Error & { code?: string; prerequisite?: string };
        assert.equal(contextError.code, 'MCP_METADATA_LIST_FAILED');
        // No `prerequisite`: nothing was measured about this deployment, so naming A-4 would send an
        // operator to look for a per-type authorization fact that was never in question.
        assert.equal(contextError.prerequisite, undefined);
        return true;
      },
    );
  } finally {
    await fixture.close();
  }
});

test('the metadata lister refuses a business-identity scope before it opens a Connection', async () => {
  const factory = new ScriptedMetadataListConnectionFactory([{ fullName: 'Admin' }]);
  const fixture = await createDiagnosticFixture(factory);
  try {
    // The executor holds the scope, so it is the last point that can prove the identity. A lister that
    // ran here would enumerate the org's access shape on a business identity.
    const userScope = await fixture.runtime.scopeFactory.create({ platformUserId: 'user-a', correlationId: 'meta-user' });
    try {
      await assert.rejects(
        async () => new OfficialMetadataComponentLister(userScope, []).execute({ metadataType: 'Profile' }),
        (error: unknown) => {
          const contextError = error as Error & { code?: string };
          assert.equal(contextError.code, 'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED');
          assert.match(contextError.message, /list_metadata_components/u);
          return true;
        },
      );
      assert.deepEqual(factory.listCalls, []);
    } finally {
      await userScope.close();
    }
  } finally {
    await fixture.close();
  }
});

const queryInputSchema = z.object({
  query: z.string(),
  usernameOrAlias: z.string(),
  directory: z.string(),
  useToolingApi: z.boolean().optional(),
});
type QueryInput = z.infer<typeof queryInputSchema>;

class FakeQueryTool extends McpTool<typeof queryInputSchema.shape> {
  public readonly inputs: QueryInput[] = [];

  public getReleaseState(): ReleaseState { return ReleaseState.GA; }
  public getToolsets(): Toolset[] { return [Toolset.DATA]; }
  public getName(): string { return 'run_soql_query'; }
  public getConfig(): McpToolConfig<typeof queryInputSchema.shape> { return { inputSchema: queryInputSchema.shape }; }

  public async exec(input: QueryInput): Promise<CallToolResult> {
    this.inputs.push(input);
    const records = Array.from({ length: 205 }, (_, index) => ({
      Id: `tooling-${index}`,
      ...(index === 0 ? { Secret: 'Bearer diagnostic-test-token' } : {}),
    }));
    return {
      content: [{ type: 'text', text: `SOQL query results:\n\n${JSON.stringify({ records, totalSize: 205, done: true })}` }],
    };
  }
}

const retrieveInputSchema = z.object({
  ignoreConflicts: z.boolean().optional(),
  sourceDir: z.array(z.string()).optional(),
  manifest: z.string().optional(),
  usernameOrAlias: z.string(),
  directory: z.string(),
});
type RetrieveInput = z.infer<typeof retrieveInputSchema>;

class FakeRetrieveTool extends McpTool<typeof retrieveInputSchema.shape> {
  public readonly inputs: Array<RetrieveInput & { manifest: string }> = [];
  public active = 0;
  public maxActive = 0;

  public constructor(private readonly delayMs = 0) { super(); }
  public getReleaseState(): ReleaseState { return ReleaseState.GA; }
  public getToolsets(): Toolset[] { return [Toolset.METADATA]; }
  public getName(): string { return 'retrieve_metadata'; }
  public getConfig(): McpToolConfig<typeof retrieveInputSchema.shape> { return { inputSchema: retrieveInputSchema.shape }; }

  public async exec(rawInput: RetrieveInput): Promise<CallToolResult> {
    const input = retrieveInputSchema.parse(rawInput);
    if (!input.manifest) return { isError: true, content: [{ type: 'text', text: 'manifest missing' }] };
    this.inputs.push({ ...input, manifest: input.manifest });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    process.chdir(input.directory);
    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      const classes = path.join(input.directory, 'force-app', 'main', 'default', 'classes');
      await mkdir(classes, { recursive: true });
      await writeFile(
        path.join(classes, 'ControlledClass.cls'),
        `-----BEGIN PRIVATE KEY-----\ntest-only-secret\n-----END PRIVATE KEY-----\n${'x'.repeat(70_000)}`,
        'utf8',
      );
      for (let index = 0; index < 45; index += 1) {
        await writeFile(
          path.join(classes, `ControlledClass${String(index).padStart(2, '0')}.cls-meta.xml`),
          `<?xml version="1.0"?><ApexClass><apiVersion>${index}</apiVersion></ApexClass>`,
          'utf8',
        );
      }
      return { content: [{ type: 'text', text: 'Retrieve result: {"success":true}' }] };
    } finally {
      this.active -= 1;
    }
  }
}

async function createDiagnosticFixture(
  connectionFactory: SalesforceConnectionFactory = new TestConnectionFactory(),
): Promise<{
  scope: RequestScope;
  runtime: ReturnType<typeof createIdentityRuntime>;
  close(): Promise<void>;
}> {
  const testRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p4-diagnostic-adapter-'));
  const workspaceFactory = new RequestWorkspaceFactory({ baseRoot: path.join(testRoot, 'requests') });
  const runtime = createIdentityRuntime(identityConfig(testRoot), {
    connectionFactory,
    workspaceFactory,
    logger: new NoopRuntimeLogger(),
  });
  const scope = await runtime.diagnosticScopeFactory?.create({
    platformUserId: 'trigger-user',
    correlationId: 'p4-adapter',
  });
  assert.ok(scope);
  return {
    scope,
    runtime,
    close: async () => {
      await scope.close();
      await rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

function createAdapter(scope: RequestScope, cwdGuard: CwdExecutionGuard): RequestScopedToolExecutionAdapter {
  return new RequestScopedToolExecutionAdapter(
    scope.context,
    scope.route,
    scope.workspace,
    cwdGuard,
    new NoopRuntimeLogger(),
  );
}

class TestConnectionFactory implements SalesforceConnectionFactory {
  public async create(_route: SalesforceIdentityRoute): Promise<Connection> {
    return { getApiVersion: () => '67.0' } as unknown as Connection;
  }
}

/**
 * A Connection whose `metadata.list` returns a scripted listing — or throws a scripted failure.
 *
 * It records the queries it was given so a test can assert *what the Tool asked Salesforce for*, which is
 * the half of the contract a response alone cannot prove: a Tool that filtered server-side and a Tool that
 * filtered locally produce the same list, and only the recorded query tells them apart.
 */
class ScriptedMetadataListConnectionFactory implements SalesforceConnectionFactory {
  public readonly listCalls: Array<{ type: string }> = [];

  public constructor(private readonly listed: unknown) {}

  public async create(_route: SalesforceIdentityRoute): Promise<Connection> {
    return {
      getApiVersion: () => '67.0',
      metadata: {
        list: async (queries: readonly { type: string }[]): Promise<unknown> => {
          this.listCalls.push(...queries.map((query) => ({ type: query.type })));
          if (this.listed instanceof Error) throw this.listed;
          return this.listed;
        },
      },
    } as unknown as Connection;
  }
}

function identityConfig(projectRoot: string) {
  return {
    projectRoot,
    instanceUrl: 'https://example.test',
    primaryUsername: 'user@example.test',
    diagnosticUsername,
    clientId: 'test-client',
    privateKeyPath: path.join(projectRoot, 'unused.pem'),
    platformUserA: 'user-a',
    platformUserB: 'user-b',
    concurrentRequests: 20,
    port: 3000,
  } as const;
}

async function pathExists(candidate: string): Promise<boolean> {
  return stat(candidate).then(
    () => true,
    () => false,
  );
}
