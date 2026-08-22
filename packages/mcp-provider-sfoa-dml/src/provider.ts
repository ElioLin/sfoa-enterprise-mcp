import { McpProvider, type McpTool, type Services } from '@salesforce/mcp-provider-api';
import type { DmlAllowlistPolicy, DmlOperation } from './allowlist.js';
import { DmlExecutor } from './dml-executor.js';
import { CreateRecordMcpTool } from './tools/create-record.js';
import { UpdateRecordMcpTool } from './tools/update-record.js';

export const SFOA_DML_TOOL_OPERATIONS = Object.freeze({
  create_record: 'CREATE',
  update_record: 'UPDATE',
} as const satisfies Readonly<Record<string, DmlOperation>>);

export type SfoaDmlToolName = keyof typeof SFOA_DML_TOOL_OPERATIONS;
export const SFOA_DML_TOOL_NAMES = Object.freeze(
  Object.keys(SFOA_DML_TOOL_OPERATIONS) as SfoaDmlToolName[],
);

export function isSfoaDmlToolName(value: string): value is SfoaDmlToolName {
  return Object.hasOwn(SFOA_DML_TOOL_OPERATIONS, value);
}

export class SfoaDmlMcpProvider extends McpProvider {
  public constructor(private readonly allowlist: DmlAllowlistPolicy) {
    super();
  }

  public getName(): string {
    return 'SfoaDmlMcpProvider';
  }

  public provideTools(services: Services): Promise<McpTool[]> {
    const executor = new DmlExecutor(services.getOrgService(), this.allowlist);
    return Promise.resolve([
      new CreateRecordMcpTool(executor),
      new UpdateRecordMcpTool(executor),
    ]);
  }
}
