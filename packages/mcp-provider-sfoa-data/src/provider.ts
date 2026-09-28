import { McpProvider, type McpTool, type Services } from '@salesforce/mcp-provider-api';
import { DescribeSobjectExecutor } from './describe-sobject-executor.js';
import { ListSobjectsExecutor } from './list-sobjects-executor.js';
import { OrgLimitsExecutor } from './org-limits-executor.js';
import { QueryRecordsExecutor } from './query-records-executor.js';
import { SearchRecordsExecutor } from './search-records-executor.js';
import { DescribeSobjectMcpTool } from './tools/describe-sobject.js';
import { GetOrgLimitsMcpTool } from './tools/get-org-limits.js';
import { ListSobjectsMcpTool } from './tools/list-sobjects.js';
import { QueryRecordsMcpTool } from './tools/query-records.js';
import { SearchRecordsMcpTool } from './tools/search-records.js';

/**
 * Every P9 Data Tool is READ and USER-scoped: it reads Salesforce data or schema through
 * the request-scoped USER identity and never mutates business data. The role map is the
 * single source of truth the host uses to fix the execution role per tool name, so an
 * Agent can never switch roles through Tool input or batching.
 */
export const SFOA_DATA_TOOL_ROLES = Object.freeze({
  list_sobjects: 'USER',
  describe_sobject: 'USER',
  query_records: 'USER',
  get_org_limits: 'USER',
  search_records: 'USER',
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
    if (requested.includes('query_records')) {
      // `requested` is the session's enabled set, so it is exactly the list of SFOA Data Tools
      // the caller can see. The executor uses it to keep a truncation hint from recommending a
      // Tool (the bulk export, the org-limits read) that `tools/list` does not advertise.
      tools.push(new QueryRecordsMcpTool(
        new QueryRecordsExecutor(orgService, { enabledToolNames: requested }),
      ));
    }
    if (requested.includes('get_org_limits')) {
      tools.push(new GetOrgLimitsMcpTool(new OrgLimitsExecutor(orgService)));
    }
    if (requested.includes('search_records')) {
      // Same contract as `query_records`: the ids-only hint may only name a Tool this session
      // actually advertises, which for a search that found records is `query_records`.
      tools.push(new SearchRecordsMcpTool(
        new SearchRecordsExecutor(orgService, { enabledToolNames: requested }),
      ));
    }
    return Promise.resolve(tools);
  }
}
