import assert from 'node:assert/strict';
import test from 'node:test';
import type { Services } from '@salesforce/mcp-provider-api';
import { createFixture } from './data-fixtures.js';
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
  assert.deepEqual([...SFOA_DATA_TOOL_NAMES].sort(), ['describe_sobject', 'list_sobjects', 'query_records']);
  assert.deepEqual(
    { ...SFOA_DATA_TOOL_ROLES },
    { list_sobjects: 'USER', describe_sobject: 'USER', query_records: 'USER' },
  );
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
    ['describe_sobject', 'list_sobjects', 'query_records'],
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
