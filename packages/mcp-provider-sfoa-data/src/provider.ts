import { McpProvider, type McpTool, type Services } from '@salesforce/mcp-provider-api';
import { GetBulkQueryResultsExecutor } from './bulk-query-results-executor.js';
import { SubmitBulkQueryExecutor } from './bulk-query-submit-executor.js';
import { DescribeSobjectExecutor } from './describe-sobject-executor.js';
import { ListSobjectsExecutor } from './list-sobjects-executor.js';
import { QueryRecordsExecutor } from './query-records-executor.js';
import { SearchRecordsExecutor } from './search-records-executor.js';
import { DescribeSobjectMcpTool } from './tools/describe-sobject.js';
import { GetBulkQueryResultsMcpTool } from './tools/get-bulk-query-results.js';
import { ListSobjectsMcpTool } from './tools/list-sobjects.js';
import { QueryRecordsMcpTool } from './tools/query-records.js';
import { SearchRecordsMcpTool } from './tools/search-records.js';
import { SubmitBulkQueryMcpTool } from './tools/submit-bulk-query.js';

/**
 * Every SFOA Data Tool is READ and USER-scoped: it reads Salesforce data or schema through
 * the request-scoped USER identity and never mutates business data. The role map is the
 * single source of truth the host uses to fix the execution role per tool name, so an
 * Agent can never switch roles through Tool input or batching.
 *
 * The two Bulk query Tools are USER-scoped for a reason beyond the general rule: a Bulk query
 * job belongs to the identity that created it, so binding every call to the request's own
 * identity is what makes "read someone else's export" structurally impossible rather than
 * merely refused.
 */
export const SFOA_DATA_TOOL_ROLES = Object.freeze({
  list_sobjects: 'USER',
  describe_sobject: 'USER',
  query_records: 'USER',
  search_records: 'USER',
  submit_bulk_query: 'USER',
  get_bulk_query_results: 'USER',
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
  /**
   * Every Tool name this session advertises, across all providers — the set a hint may name.
   *
   * This is deliberately not `toolNames`. The truncation hints recommend Tools that live in other
   * providers (`get_org_limits` is a context Tool), so gating them on the Data subset alone would
   * silently drop the recommendation. Omitted means no cross-provider Tool may be named.
   */
  advertisedToolNames?: readonly string[];
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
    // A hint may only name a Tool `tools/list` advertises. `advertisedToolNames` is that set; when
    // the caller does not supply one, the Data subset is the best available answer.
    const advertised = this.options.advertisedToolNames ?? requested;
    const orgService = services.getOrgService();
    const tools: McpTool[] = [];
    if (requested.includes('list_sobjects')) {
      tools.push(new ListSobjectsMcpTool(new ListSobjectsExecutor(orgService)));
    }
    if (requested.includes('describe_sobject')) {
      tools.push(new DescribeSobjectMcpTool(new DescribeSobjectExecutor(orgService)));
    }
    if (requested.includes('query_records')) {
      // The executor uses this set to keep a truncation hint from recommending a Tool (the bulk
      // export, the org-limits read) that `tools/list` does not advertise.
      tools.push(new QueryRecordsMcpTool(
        new QueryRecordsExecutor(orgService, { enabledToolNames: advertised }),
      ));
    }
    if (requested.includes('search_records')) {
      // Same contract as `query_records`: the ids-only hint may only name a Tool this session
      // actually advertises, which for a search that found records is `query_records`.
      tools.push(new SearchRecordsMcpTool(
        new SearchRecordsExecutor(orgService, { enabledToolNames: advertised }),
      ));
    }
    if (requested.includes('submit_bulk_query')) {
      // The submission hint names the result reader, and its allowance branch names
      // `get_org_limits` — a context Tool — so both are gated on the session's advertised set.
      tools.push(new SubmitBulkQueryMcpTool(
        new SubmitBulkQueryExecutor(orgService, { enabledToolNames: advertised }),
      ));
    }
    if (requested.includes('get_bulk_query_results')) {
      tools.push(new GetBulkQueryResultsMcpTool(
        new GetBulkQueryResultsExecutor(orgService, { enabledToolNames: advertised }),
      ));
    }
    return Promise.resolve(tools);
  }
}
