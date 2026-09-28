import assert from 'node:assert/strict';
import test from 'node:test';
import type { Services } from '@salesforce/mcp-provider-api';
import { createFixture } from './data-fixtures.js';
import { SearchRecordsMcpTool } from '../tools/search-records.js';
import {
  isSfoaDataToolName,
  SFOA_DATA_TOOL_NAMES,
  SFOA_DATA_TOOL_ROLES,
  SfoaDataMcpProvider,
} from '../provider.js';

function services(): Services {
  const fixture = createFixture({ handler: () => ({ sobjects: [] }) });
  return { getOrgService: () => fixture.orgService } as unknown as Services;
}

test('every P9 Data Tool is a READ capability executed as the request USER', () => {
  assert.deepEqual(
    [...SFOA_DATA_TOOL_NAMES].sort(),
    ['describe_sobject', 'list_sobjects', 'query_records', 'search_records'],
  );
  assert.deepEqual(
    { ...SFOA_DATA_TOOL_ROLES },
    {
      list_sobjects: 'USER',
      describe_sobject: 'USER',
      query_records: 'USER',
      search_records: 'USER',
    },
  );
});

test('get_org_limits is no longer a Data Tool: it became a DIAGNOSTIC context Tool', () => {
  assert.equal(isSfoaDataToolName('get_org_limits'), false);
});

test('isSfoaDataToolName recognizes exactly its own tool names', () => {
  for (const name of SFOA_DATA_TOOL_NAMES) {
    assert.equal(isSfoaDataToolName(name), true, `${name} must be recognized`);
  }
  for (const name of ['run_soql_query', 'get_username', 'toString', 'constructor', '__proto__', '']) {
    assert.equal(isSfoaDataToolName(name), false, `${name} must not be a Data Tool`);
  }
});

test('the provider is named and provides every Data Tool when no subset is requested', async () => {
  const provider = new SfoaDataMcpProvider();
  assert.equal(provider.getName(), 'SfoaDataMcpProvider');

  const tools = await provider.provideTools(services());
  assert.deepEqual(
    tools.map((tool) => tool.getName()).sort(),
    ['describe_sobject', 'list_sobjects', 'query_records', 'search_records'],
  );
  for (const tool of tools) {
    assert.deepEqual(tool.getToolsets(), ['data']);
  }
});

test('the provider only builds the tools the host enabled', async () => {
  const onlyList = await new SfoaDataMcpProvider({ toolNames: ['list_sobjects'] }).provideTools(services());
  assert.deepEqual(onlyList.map((tool) => tool.getName()), ['list_sobjects']);

  const none = await new SfoaDataMcpProvider({ toolNames: [] }).provideTools(services());
  assert.deepEqual(none, []);
});

test('a truncation hint may name a Tool from another provider when this session advertises it', async () => {
  // `get_org_limits` is a context Tool, so it can never appear in `toolNames` — the Data subset.
  // Gating the hint on `toolNames` alone would silently drop the quota remedy from the failure that
  // is supposed to recommend it, which is exactly the regression `advertisedToolNames` prevents.
  const fixture = createFixture({
    handler: () => {
      throw Object.assign(new Error('request limit reached'), { errorCode: 'REQUEST_LIMIT_EXCEEDED' });
    },
  });
  const servicesWithFailures = { getOrgService: () => fixture.orgService } as unknown as Services;

  const [advertised] = await new SfoaDataMcpProvider({
    toolNames: ['search_records'],
    advertisedToolNames: ['search_records', 'get_org_limits'],
  }).provideTools(servicesWithFailures);
  const named = await (advertised as SearchRecordsMcpTool).exec({ search: 'acme' });
  assert.match(JSON.stringify(named.structuredContent), /get_org_limits/u);

  const [hidden] = await new SfoaDataMcpProvider({
    toolNames: ['search_records'],
    advertisedToolNames: ['search_records'],
  }).provideTools(servicesWithFailures);
  const unnamed = await (hidden as SearchRecordsMcpTool).exec({ search: 'acme' });
  assert.doesNotMatch(JSON.stringify(unnamed.structuredContent), /get_org_limits/u);
});
