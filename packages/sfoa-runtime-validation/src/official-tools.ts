import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DxCoreMcpProvider } from '@salesforce/mcp-provider-dx-core';
import type { McpTool, Services } from '@salesforce/mcp-provider-api';
import { z } from 'zod';

const soqlResultSchema = z
  .object({
    records: z.array(z.unknown()),
    totalSize: z.number().optional(),
  })
  .passthrough();

export type OfficialQueryResult = {
  rows?: number;
  error?: string;
};

export type OfficialMetadataResult = {
  success: boolean;
  error?: string;
};

export type OfficialToolSession = {
  providerName: string;
  toolNames: readonly string[];
  callSoql(args: {
    query: string;
    username: string;
    directory: string;
  }): Promise<OfficialQueryResult>;
  callMetadata(args: {
    username: string;
    directory: string;
    manifestPath: string;
  }): Promise<OfficialMetadataResult>;
  close(): Promise<void>;
};

export async function createOfficialToolSession(services: Services): Promise<OfficialToolSession> {
  const provider = new DxCoreMcpProvider();
  const tools = await provider.provideTools(services);
  const selectedTools = tools.filter((tool) => ['run_soql_query', 'retrieve_metadata'].includes(tool.getName()));
  const server = new McpServer({ name: 'sfoa-p0-closure-validation', version: '0.0.0-p0-closure' });

  for (const tool of selectedTools) registerOfficialTool(server, tool);

  const client = new Client({ name: 'sfoa-p0-closure-client', version: '0.0.0-p0-closure' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    providerName: provider.getName(),
    toolNames: selectedTools.map((tool) => tool.getName()),
    callSoql: async ({ query, username, directory }) => {
      const result = CallToolResultSchema.parse(
        await client.callTool({
          name: 'run_soql_query',
          arguments: { query, usernameOrAlias: username, directory, useToolingApi: false },
        }),
      );
      return parseSoqlResult(result);
    },
    callMetadata: async ({ username, directory, manifestPath }) => {
      const result = CallToolResultSchema.parse(
        await client.callTool({
          name: 'retrieve_metadata',
          arguments: {
            usernameOrAlias: username,
            directory,
            manifest: manifestPath,
            ignoreConflicts: true,
          },
        }),
      );
      return result.isError === true
        ? { success: false, error: getText(result) || 'Official retrieve_metadata returned an empty error.' }
        : { success: true };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function registerOfficialTool(server: McpServer, tool: McpTool): void {
  server.registerTool(tool.getName(), tool.getConfig(), (...args) => tool.exec(...args));
}

function parseSoqlResult(result: CallToolResult): OfficialQueryResult {
  const text = getText(result);
  if (result.isError === true) return { error: text || 'Official run_soql_query returned an empty error.' };

  const jsonStart = text.indexOf('{');
  if (jsonStart < 0) return { error: 'Official run_soql_query returned no parseable JSON result.' };

  try {
    const parsed = soqlResultSchema.parse(JSON.parse(text.slice(jsonStart)));
    return { rows: parsed.records.length };
  } catch (error) {
    return { error: `Official run_soql_query response could not be validated: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function getText(result: CallToolResult): string {
  return result.content
    .filter((content): content is Extract<(typeof result.content)[number], { type: 'text' }> => content.type === 'text')
    .map((content) => content.text)
    .join('\n');
}
