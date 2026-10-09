import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ReleaseState,
  Toolset,
  type OrgService,
  type Services,
} from '@salesforce/mcp-provider-api';
import {
  CONTEXT_ERROR_CODES,
  ContextRuntimeError,
} from '../errors.js';
import { metadataListHint } from '../metadata-hints.js';
import {
  SFOA_CONTEXT_TOOL_NAMES,
  SFOA_CONTEXT_TOOL_ROLES,
  SfoaContextMcpProvider,
} from '../provider.js';
import {
  METADATA_CONTEXT_TYPES,
  METADATA_LIST_DEFAULT_LIMIT,
  METADATA_LIST_MAX_LIMIT,
  metadataContextInputSchema,
  metadataListInputSchema,
  metadataListOutputSchema,
} from '../schemas.js';
import { contextExecutionErrorToolResult } from '../tool-results.js';
import {
  LIST_METADATA_COMPONENTS_LIMITS,
  ListMetadataComponentsMcpTool,
} from '../tools/list-metadata-components.js';
import type { MetadataComponentLister } from '../contracts.js';

/**
 * The 21 types P10-T4 declared, written out rather than derived.
 *
 * Derived from `METADATA_CONTEXT_TYPES` this would pass no matter what the allowlist became, and the
 * whole point of the assertion is that widening an authorization allowlist is a reviewed act — the
 * ADR's table and this list have to be changed together. The eight leading entries are the ones the
 * allowlist carried before T4, kept in place so the widening is visible as the tail it is.
 *
 * The prompt named twenty-two and the live run corrected two of them (ADR-0032 §8): `SharingRule` came
 * back `INVALID_TYPE: Unknown type` and is `SharingRules` in the Metadata API, and `CustomSetting` is not
 * a Metadata API type at all. Both names are absent here on purpose, so a silent re-addition fails.
 */
const EXPECTED_CONTEXT_TYPES = [
  'CustomObject',
  'CustomField',
  'ValidationRule',
  'Flow',
  'ApexClass',
  'ApexTrigger',
  'Layout',
  'FlexiPage',
  'EmailTemplate',
  'NamedCredential',
  'CustomMetadata',
  'QuickAction',
  'RecordType',
  'DuplicateRule',
  'AssignmentRule',
  'AutoResponseRule',
  'EscalationRule',
  'SharingRules',
  'Workflow',
  'PermissionSet',
  'Profile',
] as const;

function stubLister(): MetadataComponentLister {
  return {
    execute: async (input) => ({
      success: true,
      executionRole: 'DIAGNOSTIC',
      metadataType: input.metadataType,
      components: [],
      totalCount: 0,
      returnedCount: 0,
      truncated: false,
      includeInactive: input.includeInactive === true,
      hint: 'no components',
    }),
  };
}

test('the metadata type allowlist is exactly the 21 types T4 declared, with no duplicates', () => {
  assert.deepEqual([...METADATA_CONTEXT_TYPES], [...EXPECTED_CONTEXT_TYPES]);
  assert.equal(METADATA_CONTEXT_TYPES.length, 21);
  assert.equal(new Set(METADATA_CONTEXT_TYPES).size, METADATA_CONTEXT_TYPES.length);
});

/**
 * The reader's `fullName` constraint is the half of the pair that has to accept what the listing
 * returns, and this org's names are localized and URL-escaped. This is the test that would fail if a
 * later edit re-narrowed the schema back to an ASCII whitelist: the hint's "pass it back verbatim"
 * step would become unactionable, and no unit test of the *listing* would notice.
 */
test('the reader accepts this org\'s localized and URL-escaped component names byte-for-byte', () => {
  for (const fullName of [
    'Admin',
    'Lead.Rule_Name',
    '风控负责',
    'WRN业务员%2F业务主管%2F市场开发',
    'SHRN工程管理总监%2F项目经理',
  ]) {
    const parsed = metadataContextInputSchema.safeParse({ metadataType: 'Profile', fullName });
    assert.equal(parsed.success, true, `expected ${fullName} to be accepted`);
    // Byte-exact, not merely accepted: a decoded or re-encoded name addresses a different component.
    assert.equal(parsed.success ? parsed.data.fullName : null, fullName);
  }
});

test('the reader still refuses traversal, filesystem separators and control characters', () => {
  for (const fullName of ['../Secret', '..', 'a/b', 'a\\b', 'x\u0000y', 'x\u001fy', '']) {
    assert.equal(
      metadataContextInputSchema.safeParse({ metadataType: 'Profile', fullName }).success,
      false,
      `expected ${JSON.stringify(fullName)} to be refused`,
    );
  }
});

test('the list input is a strict, bounded, allowlisted enum with a safety-only prefix filter', () => {
  assert.equal(metadataListInputSchema.safeParse({ metadataType: 'ValidationRule' }).success, true);
  assert.equal(metadataListInputSchema.safeParse({ metadataType: 'Profile', developerNamePrefix: '风控' }).success, true);
  assert.equal(metadataListInputSchema.safeParse({ metadataType: 'DuplicateRule', includeInactive: true, limit: 200 }).success, true);

  // The type is an enum, so a type outside the allowlist is refused before any Salesforce call.
  assert.equal(metadataListInputSchema.safeParse({ metadataType: 'Dashboard' }).success, false);
  assert.equal(metadataListInputSchema.safeParse({}).success, false);
  // The prefix is validated for safety rather than for shape: control characters and traversal are
  // refused, and everything a legitimate localized component name may contain is not.
  assert.equal(metadataListInputSchema.safeParse({ metadataType: 'Flow', developerNamePrefix: '..' }).success, false);
  assert.equal(metadataListInputSchema.safeParse({ metadataType: 'Flow', developerNamePrefix: 'a\u0000b' }).success, false);
  assert.equal(metadataListInputSchema.safeParse({ metadataType: 'Flow', developerNamePrefix: '' }).success, false);
  // The limit is bounded at both ends, and the bounds are the exported constants rather than literals.
  assert.equal(metadataListInputSchema.safeParse({ metadataType: 'Flow', limit: 0 }).success, false);
  assert.equal(metadataListInputSchema.safeParse({ metadataType: 'Flow', limit: METADATA_LIST_MAX_LIMIT + 1 }).success, false);
  assert.equal(metadataListInputSchema.safeParse({ metadataType: 'Flow', limit: 1 }).success, true);
  assert.equal(metadataListInputSchema.safeParse({ metadataType: 'Flow', limit: 1.5 }).success, false);
  // Strict: a caller cannot smuggle identity, path or manifest arguments past the contract.
  for (const forged of ['username', 'directory', 'manifest', 'platformUserId', 'connectionRole', 'useToolingApi']) {
    assert.equal(metadataListInputSchema.safeParse({ metadataType: 'Flow', [forged]: 'x' }).success, false);
  }
});

test('the list Tool is a GA read whose advertised bounds are its exported bounds', () => {
  const tool = new ListMetadataComponentsMcpTool(stubLister());
  assert.equal(tool.getName(), 'list_metadata_components');
  assert.equal(tool.getReleaseState(), ReleaseState.GA);
  assert.deepEqual(tool.getToolsets(), [Toolset.METADATA]);

  const config = tool.getConfig();
  assert.deepEqual(config.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.deepEqual(Object.keys(config.inputSchema ?? {}),
    ['metadataType', 'developerNamePrefix', 'includeInactive', 'limit']);
  // One declaration for the defaults, asserted where an Agent actually reads them: the `limit` field's
  // own description carries both numbers, and they are the exported constants rather than literals
  // repeated in prose.
  assert.equal(LIST_METADATA_COMPONENTS_LIMITS.defaultLimit, METADATA_LIST_DEFAULT_LIMIT);
  assert.equal(LIST_METADATA_COMPONENTS_LIMITS.maxLimit, METADATA_LIST_MAX_LIMIT);
  assert.match(metadataListInputSchema.shape.limit.description ?? '',
    new RegExp(`Defaults to ${METADATA_LIST_DEFAULT_LIMIT}`, 'u'));
  assert.match(metadataListInputSchema.shape.limit.description ?? '',
    new RegExp(`maximum ${METADATA_LIST_MAX_LIMIT}`, 'u'));
  // The default that must not be silent is `includeInactive`: the field description says which value
  // applies when the caller does not choose one.
  assert.match(metadataListInputSchema.shape.includeInactive.description ?? '', /Defaults to false/u);
  assert.match(config.description ?? '', /get_metadata_component_context/u);
  assert.match(config.description ?? '', /server-owned DIAGNOSTIC identity/u);
});

test('the list output schema accepts the success shape and the prerequisite refusal shape', () => {
  assert.equal(metadataListOutputSchema.safeParse({
    success: true,
    executionRole: 'DIAGNOSTIC',
    metadataType: 'ValidationRule',
    components: [{ fullName: '风控负责', manageableState: 'released', lastModifiedBy: 'Someone' }],
    totalCount: 1,
    returnedCount: 1,
    truncated: false,
    includeInactive: false,
    hint: 'one component',
  }).success, true);
  // A component entry is per-type: `Profile` carries no `manageableState`, so every provenance field
  // except `fullName` has to stay optional or the allowlist's own members violate the contract.
  assert.equal(metadataListOutputSchema.safeParse({
    success: true, metadataType: 'Profile', components: [{ fullName: 'Admin' }],
    totalCount: 1, returnedCount: 1, truncated: false,
  }).success, true);

  // ADR-0029 §3's refusal has to survive the Tool's strict output schema, or the one error the
  // degradation contract is built on would be the one error the declared contract rejects.
  const refusal = contextExecutionErrorToolResult(
    new ContextRuntimeError('MCP_METADATA_TYPE_UNAVAILABLE', 'not listed', {
      prerequisite: 'A-4',
      suggestion: 'read it from Setup',
      salesforceErrorCode: 'INSUFFICIENT_ACCESS',
    }),
    'MCP_METADATA_LIST_FAILED',
  );
  assert.equal(metadataListOutputSchema.safeParse(refusal.structuredContent).success, true);
  assert.equal(metadataListOutputSchema.safeParse({
    success: false, errorCode: 'MCP_METADATA_LIST_FAILED', message: 'x', prerequisite: 'A-4',
  }).success, true);
  // Still strict about anything else: an undeclared field is a contract violation, not a fact to keep.
  assert.equal(metadataListOutputSchema.safeParse({ success: true, componentCount: 1 }).success, false);
});

test('the two metadata error codes are part of the declared vocabulary', () => {
  assert.ok(CONTEXT_ERROR_CODES.includes('MCP_METADATA_LIST_FAILED'));
  assert.ok(CONTEXT_ERROR_CODES.includes('MCP_METADATA_TYPE_UNAVAILABLE'));
});

test('the listing hint names the reader only when the reader is advertised', () => {
  const facts = { returnedCount: 2, totalCount: 2, truncated: false, includeInactive: false, prefixApplied: false };
  const advertised = metadataListHint(new Set(['list_metadata_components', 'get_metadata_component_context']), facts);
  assert.match(advertised, /get_metadata_component_context/u);
  // Verbatim is the instruction that exists because this org URL-escapes names: a caller who decodes
  // `%2F` addresses a different component, so the hint has to say so explicitly.
  assert.match(advertised, /verbatim/u);

  // The reader is enabled independently of the listing, so a hint naming it while it is off would send
  // the Agent to a name its own `tools/list` does not carry.
  const unadvertised = metadataListHint(new Set(['list_metadata_components']), facts);
  assert.doesNotMatch(unadvertised, /get_metadata_component_context/u);
  assert.match(unadvertised, /exact full name/u);
});

test('the listing hint separates "nothing matched your filter" from "this org has none"', () => {
  const truncated = metadataListHint(new Set(['get_metadata_component_context']), {
    returnedCount: 50, totalCount: 245, truncated: true, includeInactive: false, prefixApplied: false,
  });
  assert.match(truncated, /50 of 245/u);
  assert.match(truncated, /narrow developerNamePrefix/u);

  const prefixMiss = metadataListHint(new Set(['get_metadata_component_context']), {
    returnedCount: 0, totalCount: 0, truncated: false, includeInactive: false, prefixApplied: true,
  });
  assert.match(prefixMiss, /not about\s+the org|not about the org/u);
  assert.doesNotMatch(prefixMiss, /lists no component of this type/u);

  const empty = metadataListHint(new Set(['get_metadata_component_context']), {
    returnedCount: 0, totalCount: 0, truncated: false, includeInactive: false, prefixApplied: false,
  });
  assert.match(empty, /no component of this type/u);
  // The default is stated, because a listing narrowed by a default the caller did not choose is the
  // silent-short-list failure this Toolset exists to avoid.
  assert.match(empty, /includeInactive/u);

  const emptyIncludingInactive = metadataListHint(new Set(['get_metadata_component_context']), {
    returnedCount: 0, totalCount: 0, truncated: false, includeInactive: true, prefixApplied: false,
  });
  assert.doesNotMatch(emptyIncludingInactive, /includeInactive/u);
});

test('every hint the builder can produce fits the declared 1000-character bound', () => {
  const sets = [new Set<string>(), new Set(['get_metadata_component_context']), new Set(SFOA_CONTEXT_TOOL_NAMES)];
  for (const advertised of sets) {
    for (const truncated of [true, false]) {
      for (const includeInactive of [true, false]) {
        for (const prefixApplied of [true, false]) {
          for (const counts of [[0, 0], [0, 245], [200, 245], [50, 50]]) {
            const hint = metadataListHint(advertised, {
              returnedCount: counts[0] ?? 0,
              totalCount: counts[1] ?? 0,
              truncated,
              includeInactive,
              prefixApplied,
            });
            assert.ok(hint.length > 0 && hint.length <= 1_000, `hint was ${hint.length} characters`);
          }
        }
      }
    }
  }
});

test('the Provider refuses to build the listing Tool without an executor rather than advertising a dead Tool', async () => {
  const provider = new SfoaContextMcpProvider({
    diagnosticQueryExecutor: { execute: async () => ({ records: [], totalSize: 0, returnedRecords: 0, done: true, truncated: false }) },
    toolNames: ['list_metadata_components'],
  });
  await assert.rejects(
    async () => provider.provideTools(createServices()),
    /list_metadata_components requires a metadata list executor/u,
  );
});

test('the listing and reading Tools are advertised adjacent and in the role map\'s order, both DIAGNOSTIC', async () => {
  const tools = await new SfoaContextMcpProvider({
    diagnosticQueryExecutor: { execute: async () => ({ records: [], totalSize: 0, returnedRecords: 0, done: true, truncated: false }) },
    metadataListExecutor: stubLister(),
    metadataContextExecutor: {
      execute: async (input) => ({
        success: true, executionRole: 'DIAGNOSTIC', metadataType: input.metadataType, fullName: input.fullName,
        files: [], omittedFiles: [], totalFiles: 0, returnedFiles: 0, totalBytes: 0, returnedBytes: 0,
        truncated: false,
        limits: { maxReturnedFiles: 40, maxFileBytes: 65_536, maxTotalBytes: 262_144, maxFileSummaries: 100 },
      }),
    },
    toolNames: ['list_metadata_components', 'get_metadata_component_context'],
  }).provideTools(createServices());
  assert.deepEqual(tools.map((tool) => tool.getName()),
    ['list_metadata_components', 'get_metadata_component_context']);

  // The pair is contiguous in the role map, listing first — the order an Agent walks them in, and the
  // order `tools/list` advertises. A reordering would make the hint's next-step advice read backwards.
  const listIndex = SFOA_CONTEXT_TOOL_NAMES.indexOf('list_metadata_components');
  assert.deepEqual(
    SFOA_CONTEXT_TOOL_NAMES.slice(listIndex, listIndex + 2),
    ['list_metadata_components', 'get_metadata_component_context'],
  );
  assert.equal(SFOA_CONTEXT_TOOL_ROLES.list_metadata_components, 'DIAGNOSTIC');
  assert.equal(SFOA_CONTEXT_TOOL_ROLES.get_metadata_component_context, 'DIAGNOSTIC');
});

function createServices(): Services {
  const orgService = {
    getAllowedOrgUsernames: async () => new Set(['user@example.test']),
    getConnection: async () => {
      throw new Error('not invoked by Tool contract test');
    },
  } as unknown as OrgService;
  return {
    getOrgService: () => orgService,
    getTelemetryService: () => ({ sendEvent: () => undefined }),
    getConfigService: () => ({
      getDataDir: () => process.cwd(),
      getStartupFlags: () => ({ 'allow-non-ga-tools': false, debug: false }),
    }),
  };
}
