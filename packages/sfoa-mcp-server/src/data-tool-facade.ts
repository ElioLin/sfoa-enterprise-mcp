import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpTool, McpToolConfig } from '@salesforce/mcp-provider-api';
import {
  DataRuntimeError,
  SFOA_DATA_TOOL_ROLES,
  dataFailureToolResult,
  isSfoaDataToolName,
  type SfoaDataToolName,
} from '@sfoa/mcp-provider-sfoa-data';
import type {
  RequestContext,
  RuntimeLogger,
  SalesforceConnectionProvider,
  SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import {
  IdentityRuntimeError,
  runWithSalesforceApiPurpose,
  runWithSalesforceQuerySemantic,
  runtimeErrorToolResult,
  type SalesforceApiPurpose,
} from '@sfoa/identity-runtime';
import { z } from 'zod';
import { RemoteRuntimeError, remoteRuntimeErrorToolResult } from './errors.js';
import { describeSoqlObjectUsageBlock, evaluateSoqlObjectUsageGuard } from './soql-usage-guard.js';
import { withTimeout } from './timeouts.js';

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolInput = Record<string, unknown>;

/**
 * Which Salesforce surface each Data Tool is audited under. Declared as a total map rather
 * than a switch so that adding a Tool to the Provider's role map without deciding its audit
 * purpose is a compile error here, in the layer that owns the audit contract.
 */
const DATA_TOOL_PURPOSES: Readonly<Record<SfoaDataToolName, SalesforceApiPurpose>> = Object.freeze({
  list_sobjects: 'OBJECT_SCHEMA',
  describe_sobject: 'OBJECT_SCHEMA',
  query_records: 'USER_QUERY',
  search_records: 'SOSL_SEARCH',
});

/** Object API names and name prefixes are schema identifiers, not business data. */
const MAX_SUMMARY_TOKEN_LENGTH = 64;

/**
 * How many entries of a requested identifier list the audit keeps. The Tool already bounds each
 * list it accepts, so this only guards the trail against input that never reached the Tool's own
 * schema — the same reason `MAX_SUMMARY_TOKEN_LENGTH` exists.
 */
const MAX_SUMMARY_LIST_LENGTH = 20;

export type DataToolFacadeOptions = Readonly<{
  tool: McpTool;
  context: RequestContext;
  route: SalesforceIdentityRoute;
  toolTimeoutMs: number;
  logger: RuntimeLogger;
  clientId: string;
  connectionProvider?: SalesforceConnectionProvider;
  redactionSecrets?: readonly string[];
}>;

/**
 * Host-side governance wrapper for the P9 SFOA Data Tools.
 *
 * The Provider already refuses to build a Connection it was not given, but the execution
 * role is a host decision: every Data Tool is fixed to the request's USER identity, and a
 * request arriving on a non-USER route is refused here before the Tool body runs, so an
 * Agent can never reach Salesforce schema through a batching or role-switching trick.
 */
export class DataToolFacade {
  public constructor(private readonly options: DataToolFacadeOptions) {
    if (!isSfoaDataToolName(options.tool.getName())) {
      throw new RemoteRuntimeError(
        'MCP_TOOL_NOT_AVAILABLE',
        `Data facade cannot execute non-P9 Tool ${options.tool.getName()}.`,
      );
    }
  }

  public getName(): string {
    return this.options.tool.getName();
  }

  public getConfig(): McpToolConfig<z.ZodRawShape, z.ZodRawShape> {
    return this.options.tool.getConfig();
  }

  public async execute(input: ToolInput, extra: ToolExtra): Promise<CallToolResult> {
    const started = performance.now();
    const name = this.options.tool.getName();
    if (!isSfoaDataToolName(name)) {
      return remoteRuntimeErrorToolResult(
        new RemoteRuntimeError('MCP_TOOL_NOT_AVAILABLE', `Tool ${name} is not a P9 Data Tool.`),
        this.options.redactionSecrets,
        this.options.context.correlationId,
      );
    }
    const expectedRole = SFOA_DATA_TOOL_ROLES[name];
    if (this.options.route.connectionRole !== expectedRole) {
      const result = dataFailureToolResult(
        new DataRuntimeError(
          'MCP_DATA_TOOL_NOT_ALLOWED',
          `Tool ${name} is fixed to the ${expectedRole} execution role; the request cannot switch roles through input or batching.`,
        ),
        'MCP_DATA_TOOL_NOT_ALLOWED',
      );
      await this.log('BLOCKED', elapsed(started), 'MCP_DATA_TOOL_NOT_ALLOWED', input);
      return result;
    }

    // The same org-usage guard the official `run_soql_query` path applies, applied here so the
    // two SOQL Tools cannot disagree about which objects are in use: an org-declared-unused
    // standard object usually returns zero rows, which an Agent reports as "none exists".
    const verdict = name === 'query_records' ? evaluateSoqlObjectUsageGuard(input) : { blocked: false as const };
    if (verdict.blocked) {
      const blocked = new DataRuntimeError(
        'MCP_SOBJECT_NOT_IN_USE',
        describeSoqlObjectUsageBlock(verdict.substitution),
        { suggestion: 'Re-issue the query against the object named above; do not fall back to the unused standard object.' },
      );
      await this.log('BLOCKED', elapsed(started), blocked.code, input);
      return dataFailureToolResult(blocked, 'MCP_SOBJECT_NOT_IN_USE');
    }

    try {
      // Every P9 Data Tool reads with the request-scoped USER Connection, initialized
      // lazily after role enforcement and outside the pre-existing Tool deadline.
      await this.options.connectionProvider?.getConnection();
      const execute = (): Promise<CallToolResult> => Promise.resolve(this.options.tool.exec(input, extra));
      const result = await withTimeout(
        runWithSalesforceApiPurpose(
          DATA_TOOL_PURPOSES[name],
          () => bindQuerySemantic(name, input, execute),
        ),
        this.options.toolTimeoutMs,
        'MCP_TOOL_TIMEOUT',
        `Tool ${name} exceeded MCP_TOOL_TIMEOUT_MS. The runtime stopped waiting; Salesforce server-side cancellation is not guaranteed.`,
        this.options.context.correlationId,
      );
      await this.log(
        result.isError === true ? 'ERROR' : 'PASS',
        elapsed(started),
        resultErrorCode(result),
        input,
        result,
      );
      return result;
    } catch (error) {
      if (error instanceof IdentityRuntimeError) {
        await this.log('ERROR', elapsed(started), error.code, input);
        return runtimeErrorToolResult(error, this.options.redactionSecrets, this.options.context.correlationId);
      }
      if (error instanceof RemoteRuntimeError && error.code === 'MCP_TOOL_TIMEOUT') {
        await this.log('ERROR', elapsed(started), error.code, input);
        return remoteRuntimeErrorToolResult(
          error,
          this.options.redactionSecrets,
          this.options.context.correlationId,
        );
      }
      await this.log('ERROR', elapsed(started), 'MCP_TOOL_EXECUTION_FAILED', input);
      throw error;
    }
  }

  private async log(
    result: 'PASS' | 'ERROR' | 'BLOCKED',
    durationMs: number,
    errorCode?: string,
    input: ToolInput = {},
    response?: CallToolResult,
  ): Promise<void> {
    await Promise.resolve(this.options.logger.log({
      correlationId: this.options.context.correlationId,
      clientId: this.options.clientId,
      platformUserId: this.options.context.platformUserId,
      salesforceUsername: this.options.route.salesforceUsername,
      executionRole: this.options.route.connectionRole,
      toolName: this.getName(),
      durationMs,
      result,
      outcome: result === 'PASS' ? 'SUCCESS' : result === 'BLOCKED' ? 'DENIED' : 'FAILED',
      ...(errorCode ? { errorCode } : {}),
      requestSummary: safeDataRequestSummary(input),
      responseSummary: safeDataResponseSummary(response, errorCode),
      auditEvent: {
        eventCategory: 'TOOL',
        eventType: 'TOOL_TERMINAL',
        eventName: this.getName(),
        terminalSource: result === 'BLOCKED' ? 'GOVERNANCE' : 'TOOL',
      },
    })).catch(() => undefined);
  }
}

/**
 * Binds the SOQL semantic for `query_records` so the request audit records the statement, the
 * object it names and each page's result statistics through the same collector the official
 * `run_soql_query` path uses. The scope is bound to *all* of the Tool's Salesforce calls, so a
 * multi-page continuation is audited as one query rather than as unattributed API traffic.
 *
 * A Tool that carries no statement, or a call the Tool's own schema will reject, executes
 * unbound: recording a query that never reached Salesforce would be worse than recording none.
 */
function bindQuerySemantic(
  name: SfoaDataToolName,
  input: ToolInput,
  execute: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  if (name !== 'query_records' || typeof input.query !== 'string' || input.query.trim().length === 0) {
    return execute();
  }
  return Promise.resolve(runWithSalesforceQuerySemantic({
    queryType: input.useToolingApi === true ? 'TOOLING_SOQL' : 'DATA_SOQL',
    soqlStatement: input.query,
  }, execute));
}

function safeDataRequestSummary(input: ToolInput): unknown {
  return {
    objectApiName: boundedToken(input.objectApiName),
    filter: boundedToken(input.filter),
    // The statement itself is recorded once, by the Salesforce-call semantic above, which
    // bounds it and extracts its object. Repeating it here would put a second, differently
    // bounded copy of the same text into the trail. What is recorded instead is the shape of
    // the request that is not visible from the Salesforce call: which API and which row budget.
    ...(typeof input.query === 'string'
      ? { useToolingApi: input.useToolingApi === true, maxRows: boundedInteger(input.maxRows) }
      : {}),
    // SOSL has no semantic channel: a search is not a SOQL query, so the Salesforce call records
    // an empty semantic and the text has to be captured here or not at all. The term is business
    // data rather than a schema identifier, so it is bounded far harder than the 2000 characters
    // the Tool accepts — the trail keeps enough to recognise the request, not all of it. The
    // object and field lists are the same identifiers `describe_sobject` already records.
    ...(typeof input.search === 'string'
      ? {
          search: boundedToken(input.search),
          objects: boundedTokens(input.objects),
          fields: boundedTokens(input.fields),
          limit: boundedInteger(input.limit),
        }
      : {}),
  };
}

function safeDataResponseSummary(response: CallToolResult | undefined, errorCode?: string): unknown {
  const content = response?.structuredContent;
  if (!content) return { isError: response?.isError === true, ...(errorCode ? { errorCode } : {}) };
  return {
    isError: response?.isError === true,
    ...(typeof content.totalCount === 'number' ? { totalCount: content.totalCount } : {}),
    ...(typeof content.returnedCount === 'number' ? { returnedCount: content.returnedCount } : {}),
    ...(typeof content.totalFields === 'number' ? { totalFields: content.totalFields } : {}),
    ...(typeof content.returnedFields === 'number' ? { returnedFields: content.returnedFields } : {}),
    ...(typeof content.totalSize === 'number' ? { totalSize: content.totalSize } : {}),
    ...(typeof content.fetched === 'number' ? { fetched: content.fetched } : {}),
    ...(typeof content.pages === 'number' ? { pages: content.pages } : {}),
    ...(typeof content.totalReturned === 'number' ? { totalReturned: content.totalReturned } : {}),
    ...(typeof content.objectsReturned === 'number' ? { objectsReturned: content.objectsReturned } : {}),
    ...(typeof content.unreadableRecords === 'number' ? { unreadableRecords: content.unreadableRecords } : {}),
    ...(typeof content.limitSource === 'string' ? { limitSource: content.limitSource } : {}),
    ...(typeof content.complete === 'boolean' ? { complete: content.complete } : {}),
    ...(typeof content.truncated === 'boolean' ? { truncated: content.truncated } : {}),
    ...(typeof content.truncatedReason === 'string' ? { truncatedReason: content.truncatedReason } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

/**
 * The audit record names the object and prefix the Agent asked about — a governance fact —
 * bounded so that input which never reached the Tool's own schema cannot write an
 * arbitrarily long string into the trail.
 */
function boundedToken(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, MAX_SUMMARY_TOKEN_LENGTH) : null;
}

/** The same bound applied to a requested identifier list, which is also bounded in how many entries it keeps. */
function boundedTokens(value: unknown): readonly (string | null)[] | null {
  return Array.isArray(value)
    ? value.slice(0, MAX_SUMMARY_LIST_LENGTH).map((entry) => boundedToken(entry))
    : null;
}

function boundedInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function resultErrorCode(result: CallToolResult): string | undefined {
  const content = result.structuredContent;
  return content && typeof content.errorCode === 'string' ? content.errorCode : undefined;
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
