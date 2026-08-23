import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpTool } from '@salesforce/mcp-provider-api';
import { z } from 'zod';
import { routeAllowsUsernameOrAlias, type SalesforceIdentityRoute } from './contracts.js';
import { CwdExecutionGuard } from './cwd-execution-guard.js';
import {
  IdentityRuntimeError,
  redactSensitiveText,
  runtimeErrorToolResult,
  toIdentityRuntimeError,
  withCorrelation,
} from './errors.js';
import type { RequestContext } from './request-context.js';
import type { RuntimeLogger } from './runtime-logger.js';
import type { RequestWorkspace } from './workspace.js';

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolInput = Record<string, unknown>;

const toolInputSchema = z.record(z.unknown());

export class RequestScopedToolExecutionAdapter {
  public constructor(
    private readonly context: RequestContext,
    private readonly route: SalesforceIdentityRoute,
    private readonly workspace: RequestWorkspace,
    private readonly cwdGuard: CwdExecutionGuard,
    private readonly logger: RuntimeLogger,
    private readonly redactionSecrets: readonly string[] = [],
  ) {}

  public async execute(tool: McpTool, input: ToolInput, extra: ToolExtra): Promise<CallToolResult> {
    const started = performance.now();
    try {
      const rewritten = this.prepareInput(tool.getName(), input);
      const operation = async (): Promise<CallToolResult> => tool.exec(rewritten, extra);
      const result =
        tool.getName() === 'retrieve_metadata'
          ? await this.cwdGuard.runExclusive(operation)
          : await this.cwdGuard.runShared(operation);
      const sanitized = sanitizeToolResult(result, this.redactionSecrets, this.context.correlationId);
      this.logger.log({
        correlationId: this.context.correlationId,
        platformUserId: this.context.platformUserId,
        salesforceUsername: this.route.salesforceUsername,
        executionRole: this.route.connectionRole,
        toolName: tool.getName(),
        durationMs: elapsed(started),
        result: sanitized.isError === true ? 'ERROR' : 'PASS',
      });
      return sanitized;
    } catch (error) {
      const runtimeError = withCorrelation(
        toIdentityRuntimeError(
          error,
          'MCP_REQUEST_SCOPE_FAILED',
          'The request-scoped official Tool execution failed before a safe result was produced.',
        ),
        this.context.correlationId,
      );
      this.logger.log({
        correlationId: this.context.correlationId,
        platformUserId: this.context.platformUserId,
        salesforceUsername: this.route.salesforceUsername,
        executionRole: this.route.connectionRole,
        toolName: tool.getName(),
        durationMs: elapsed(started),
        result: runtimeError.code === 'MCP_IDENTITY_CONTEXT_MISMATCH' ? 'BLOCKED' : 'ERROR',
        errorCode: runtimeError.code,
      });
      return runtimeErrorToolResult(runtimeError, this.redactionSecrets, this.context.correlationId);
    }
  }

  private prepareInput(toolName: string, input: ToolInput): ToolInput {
    const parsed = toolInputSchema.parse(input);
    const usernameOrAlias = parsed.usernameOrAlias;
    if (usernameOrAlias !== undefined) {
      if (typeof usernameOrAlias !== 'string' || !routeAllowsUsernameOrAlias(this.route, usernameOrAlias)) {
        throw new IdentityRuntimeError(
          'MCP_IDENTITY_CONTEXT_MISMATCH',
          'The Tool usernameOrAlias does not match the Salesforce identity resolved from X-Platform-User-Id.',
          { correlationId: this.context.correlationId },
        );
      }
    }

    const rewritten: ToolInput = { ...parsed, directory: this.workspace.root };
    if (parsed.manifest !== undefined) {
      if (typeof parsed.manifest !== 'string') {
        throw new IdentityRuntimeError('MCP_REQUEST_WORKSPACE_FAILED', 'The metadata manifest path is invalid.');
      }
      rewritten.manifest = this.workspace.resolveClientPath(parsed.manifest);
    }

    if (parsed.sourceDir !== undefined) {
      if (!Array.isArray(parsed.sourceDir) || !parsed.sourceDir.every((entry) => typeof entry === 'string')) {
        throw new IdentityRuntimeError('MCP_REQUEST_WORKSPACE_FAILED', 'The metadata sourceDir paths are invalid.');
      }
      rewritten.sourceDir = parsed.sourceDir.map((entry) => this.workspace.resolveClientPath(entry));
    }

    if (!['get_username', 'run_soql_query', 'retrieve_metadata'].includes(toolName)) {
      throw new IdentityRuntimeError(
        'MCP_REQUEST_SCOPE_FAILED',
        'The requested Tool is outside the P1 official Tool selection.',
      );
    }
    return rewritten;
  }
}

function sanitizeToolResult(
  result: CallToolResult,
  secrets: readonly string[],
  correlationId: string,
): CallToolResult {
  const suffix = result.isError === true ? `\nCorrelation ID: ${correlationId}.` : '';
  return {
    ...result,
    content: result.content.map((block) =>
      block.type === 'text'
        ? { ...block, text: `${redactSensitiveText(block.text, secrets)}${suffix}` }
        : block,
    ),
  };
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
