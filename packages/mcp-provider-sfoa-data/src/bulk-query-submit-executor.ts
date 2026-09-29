import type { OrgService } from '@salesforce/mcp-provider-api';
import {
  BULK_QUERY_RESULTS_TOOL_NAME,
  createBulkQueryApi,
  type BulkQueryApiFactory,
} from './bulk-query-api.js';
import { DataRuntimeError } from './errors.js';
import { resolveRequestConnection } from './org-connection.js';
import { ORG_LIMITS_TOOL_NAME } from './query-records-executor.js';
import { mapDataFailure, type DataFailureMapping } from './salesforce-errors.js';
import { inspectSoqlQuery } from './soql.js';
import type { SubmitBulkQueryInput, SubmitBulkQueryOutput } from './schemas.js';

export type SubmitBulkQueryExecutorOptions = Readonly<{
  /** The Tools this session advertises; a hint may name only one of them. */
  enabledToolNames?: readonly string[];
  apiFactory?: BulkQueryApiFactory;
}>;

/**
 * Creates a Bulk API 2.0 **query** job and returns its Id.
 *
 * This is the half of the capability `query_records` structurally cannot provide: a REST SOQL
 * query is capped at 2000 rows per page and its continuation cursor eventually stops, so a
 * several-hundred-thousand-row export has no bounded path through it. A Bulk query job is
 * executed by Salesforce and its results are read page by page afterwards.
 *
 * **No server-side job state exists anywhere in this path.** The job lives in Salesforce, the
 * caller holds the Id, and every later call re-states it. That is what keeps the Tool
 * compatible with the stateless HTTP runtime (`sessionIdGenerator: undefined`): nothing has to
 * survive between requests except the Id the Agent is already carrying.
 *
 * **Read-only in the sense the annotation claims.** Creating a query job reads business data
 * and changes none of it: `operation` is fixed to `query` inside the provider, so the ingest
 * and DML Bulk operations are not reachable through any input.
 *
 * **There is no quota pre-flight, deliberately.** A pre-flight would read
 * `Connection.limits()`, and no identity this deployment can route is permitted to read the
 * `limits` resource (`API_DISABLED_FOR_ORG`, measured — see ADR-0027); the DATA Tools are also
 * fixed to the request's USER identity, so they cannot borrow the diagnostic one. Instead the
 * submission reports the quota fact the response itself carries — the org's own
 * `Sforce-Limit-Info` counter — and a refusal that *is* about the allowance names
 * `get_org_limits` when the session advertises it.
 */
export class SubmitBulkQueryExecutor {
  private readonly enabledToolNames: readonly string[];

  public constructor(
    private readonly orgService: OrgService,
    private readonly options: SubmitBulkQueryExecutorOptions = {},
  ) {
    this.enabledToolNames = options.enabledToolNames ?? [];
  }

  public async execute(input: SubmitBulkQueryInput): Promise<SubmitBulkQueryOutput> {
    try {
      // Re-inspected here rather than trusted from the caller, for the same reason
      // `query_records` does it: the registered wire schema is a raw shape whose JSON Schema
      // cannot express the statement rules (see ADR-0024).
      const inspection = inspectSoqlQuery(input.query);
      if (!inspection.usable) {
        throw new DataRuntimeError('MCP_BULK_QUERY_INVALID', `Invalid Bulk query: ${inspection.message}`, {
          suggestion: 'Correct the statement and retry, or use query_records for a small result set.',
        });
      }
      const connection = await resolveRequestConnection(this.orgService);
      const api = (this.options.apiFactory ?? createBulkQueryApi)(connection);
      const job = await api.createQueryJob(input.query);
      const hint = submitHint(job.state, this.hasTool(BULK_QUERY_RESULTS_TOOL_NAME));
      return {
        success: true,
        executionRole: 'USER',
        api: 'REST',
        operation: 'query',
        jobId: job.jobId,
        ...(job.state === null ? {} : { state: job.state }),
        ...(job.stateMessage === null ? {} : { stateMessage: job.stateMessage }),
        apiVersion: api.apiVersion,
        ...(job.apiUsage === null ? {} : { apiUsage: job.apiUsage }),
        hint,
      };
    } catch (error) {
      throw mapDataFailure(error, submitFailureMapping(this.hasTool(ORG_LIMITS_TOOL_NAME)));
    }
  }

  private hasTool(name: string): boolean {
    return this.enabledToolNames.includes(name);
  }
}

/**
 * The next step after a submission, worded around the state the platform actually returned.
 * A job is created asynchronously, so "now go and read it" is only true once it has a result
 * set; before that the honest instruction is to look again.
 */
function submitHint(state: string | null, hasResultsTool: boolean): string {
  if (!hasResultsTool) {
    return 'The job is running in Salesforce. Ask an administrator to enable the Bulk result-reading capability to read its rows.';
  }
  if (state === 'JobComplete') {
    return `The job is already complete: call ${BULK_QUERY_RESULTS_TOOL_NAME} with this jobId to read its rows.`;
  }
  if (state === 'Failed' || state === 'Aborted') {
    return `Salesforce reports this job as ${state}, so it will produce no result set. Read stateMessage for the reason, correct the statement and submit a new job.`;
  }
  return `Salesforce is running the job. Call ${BULK_QUERY_RESULTS_TOOL_NAME} with this jobId to check its state; rows become readable once the state is JobComplete. Bulk jobs are asynchronous, so a job that is still UploadComplete or InProgress needs another look rather than a resubmission.`;
}

/**
 * Error mapping for `submit_bulk_query`.
 *
 * The allowance branch is the interesting one. `REQUEST_LIMIT_EXCEEDED` and
 * `API_DISABLED_FOR_ORG` are the two ways this org refuses work when the API allowance is
 * gone, and the suggestion names `get_org_limits` only when the session advertises it — a
 * hint that sends an Agent after a Tool `tools/list` does not contain costs it a turn to
 * discover that.
 */
function submitFailureMapping(hasOrgLimitsTool: boolean): DataFailureMapping {
  return {
    fallbackCode: 'MCP_BULK_SUBMIT_FAILED',
    fallbackMessage: 'Salesforce did not accept the Bulk query job for this request.',
    fallbackSuggestion: 'Retry once; if it fails again, verify the statement with query_records first, then submit it again as a Bulk job.',
    rules: [
      {
        codes: ['INVALID_FIELD', 'INVALID_TYPE', 'INVALID_SOBJECT', 'INVALID_ENTITY', 'NOT_FOUND'],
        code: 'MCP_BULK_QUERY_INVALID',
        message: 'The Bulk query names a field or object that Salesforce does not expose to this request\'s identity.',
        suggestion: 'Call describe_sobject for the object to read its real field and relationship names, and list_sobjects to confirm the object API name, then correct the statement and resubmit.',
      },
      {
        codes: ['MALFORMED_QUERY', 'INVALID_QUERY', 'INVALID_QUERY_FILTER_OPERATOR', 'UNSUPPORTED_QUERY'],
        code: 'MCP_BULK_MALFORMED',
        message: 'Salesforce rejected the SOQL statement as malformed.',
        suggestion: 'Fix the statement and resubmit. Bulk API 2.0 accepts ordinary SOQL SELECT statements; a statement that query_records runs successfully is a good first check.',
      },
      {
        codes: ['REQUEST_LIMIT_EXCEEDED', 'API_DISABLED_FOR_ORG', 'TOTAL_REQUESTS_LIMIT_EXCEEDED'],
        code: 'MCP_BULK_LIMIT_EXCEEDED',
        message: hasOrgLimitsTool
          ? `Salesforce refused the Bulk submission because the org's API allowance is exhausted. Call ${ORG_LIMITS_TOOL_NAME} to read the remaining allowance.`
          : 'Salesforce refused the Bulk submission because the org\'s API allowance is exhausted.',
        suggestion: hasOrgLimitsTool
          ? `Read ${ORG_LIMITS_TOOL_NAME} to see when the allowance resets, and wait for it rather than retrying: a Bulk job costs calls to create and calls to read.`
          : 'Wait for the 24-hour rolling allowance to reset rather than retrying: a Bulk job costs calls to create and calls to read.',
      },
      {
        codes: ['INSUFFICIENT_ACCESS', 'INSUFFICIENT_ACCESS_OR_READONLY', 'INSUFFICIENT_PRIVILEGES'],
        code: 'MCP_BULK_ACCESS_DENIED',
        message: 'The Salesforce user for this request may not read one of the objects or fields in the statement.',
        suggestion: 'Report the missing Salesforce permission instead of retrying; do not work around the org\'s sharing rules.',
      },
    ],
  };
}
