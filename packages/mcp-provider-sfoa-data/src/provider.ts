import { McpProvider, type McpTool, type Services } from '@salesforce/mcp-provider-api';
import { DescribeSobjectExecutor } from './describe-sobject-executor.js';
import { ListSobjectsExecutor } from './list-sobjects-executor.js';
import { DescribeSobjectMcpTool } from './tools/describe-sobject.js';
import { ListSobjectsMcpTool } from './tools/list-sobjects.js';

/**
 * Every P9 Data Tool is READ and USER-scoped: it reads Salesforce data or schema through
 * the request-scoped USER identity and never mutates business data. The role map is the
 * single source of truth the host uses to fix the execution role per tool name, so an
 * Agent can never switch roles through Tool input or batching.
 */
export const SFOA_DATA_TOOL_ROLES = Object.freeze({
  list_sobjects: 'USER',
  describe_sobject: 'USER',
} as const);

export type SfoaDataToolName = keyof typeof SFOA_DATA_TOOL_ROLES;
export type SfoaDataToolRole = (typeof SFOA_DATA_TOOL_ROLES)[SfoaDataToolName];
export const SFOA_DATA_TOOL_NAMES = Object.freeze(
  Object.keys(SFOA_DATA_TOOL_ROLES) as SfoaDataToolName[],
);

export function isSfoaDataToolName(value: string): value is SfoaDataToolName {
  return Object.hasOwn(SFOA_DATA_TOOL_ROLES, value);
}

export type SfoaDataProviderOptions = Readonly<{
  /** Tools to build. Omitted means every SFOA Data Tool; the host passes the enabled set. */
  toolNames?: readonly SfoaDataToolName[];
}>;

export class SfoaDataMcpProvider extends McpProvider {
  public constructor(private readonly options: SfoaDataProviderOptions = {}) {
    super();
  }

  public getName(): string {
    return 'SfoaDataMcpProvider';
  }

  public provideTools(services: Services): Promise<McpTool[]> {
    const requested = this.options.toolNames ?? SFOA_DATA_TOOL_NAMES;
    const orgService = services.getOrgService();
    const tools: McpTool[] = [];
    if (requested.includes('list_sobjects')) {
      tools.push(new ListSobjectsMcpTool(new ListSobjectsExecutor(orgService)));
    }
    if (requested.includes('describe_sobject')) {
      tools.push(new DescribeSobjectMcpTool(new DescribeSobjectExecutor(orgService)));
    }
    return Promise.resolve(tools);
  }
}
