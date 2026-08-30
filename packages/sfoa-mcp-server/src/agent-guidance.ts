import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  AGENT_PLAYBOOK_VERSION,
  AGENT_WORKFLOWS,
  createAgentCapabilities,
  renderFullPlaybook,
  renderServerInstructions,
  renderWorkflow,
  type AgentCapabilities,
  type AgentWorkflow,
} from '@sfoa/agent-playbook';
import {
  RequestAuditContextController,
  runWithRequestAuditContext,
  type RequestAuditClientMetadata,
  type RequestAuditIdentitySource,
  type RequestScope,
  type RuntimeLogger,
} from '@sfoa/identity-runtime';
import type { DmlAllowlistPolicy } from '@sfoa/mcp-provider-sfoa-dml';
import { z } from 'zod';
import { RemoteRuntimeError, remoteRuntimeErrorToolResult } from './errors.js';
import type { RuntimeManagedDmlFieldRule } from './dml-managed-fields.js';

export const AGENT_PLAYBOOK_RESOURCE_URI = 'sfoa://agent-playbook/current';
export const AGENT_CAPABILITIES_RESOURCE_URI = 'sfoa://agent-capabilities/current';
export const AGENT_PROMPT_NAME = 'sfoa_salesforce_assistant';

const agentWorkflowSchema = z.enum(AGENT_WORKFLOWS).describe('Canonical SFoA workflow to render.');
const recordDescriptorSchema = z.object({
  objectApiName: z.string().trim().min(1).max(128).regex(
    /^[A-Za-z][A-Za-z0-9_]*$/u,
    'must be a Salesforce object API name without a relationship path',
  ).describe('Salesforce object API name, for example Account or ns__Object__c.'),
  recordId: z.string().trim().regex(
    /^(?:[A-Za-z0-9]{15}|[A-Za-z0-9]{18})$/u,
    'must be a 15- or 18-character Salesforce Record ID',
  ).describe('Validated Salesforce 15- or 18-character Record ID.'),
  displayName: z.string().trim().min(1).max(512).refine(
    (value) => !/[\u0000-\u001F\u007F]/u.test(value),
    'must not contain control characters',
  ).optional().describe('Optional display label copied to the result without using it as authority.'),
}).strict();

export type RegisterAgentGuidanceOptions = Readonly<{
  scope: RequestScope;
  logger: RuntimeLogger;
  clientId: string;
  capabilities: AgentCapabilities;
  enabledTools: readonly string[];
  redactionSecrets?: readonly string[];
  lightningBaseUrl?: string;
  auditIdentity: Readonly<{
    identitySource: RequestAuditIdentitySource;
    identityCredentialId?: string;
  }>;
  auditClientMetadata?: RequestAuditClientMetadata;
  requestAuditContext?: RequestAuditContextController;
}>;

export function createRuntimeAgentCapabilities(
  enabledTools: readonly string[],
  dmlAllowlist: DmlAllowlistPolicy,
  diagnosticReady: boolean,
  managedDmlFieldRules: readonly RuntimeManagedDmlFieldRule[] = [],
): AgentCapabilities {
  const rules = dmlAllowlist.getRules();
  return createAgentCapabilities({
    enabledTools,
    createAllowedObjects: rules
      .filter((rule) => rule.operations.includes('CREATE'))
      .map((rule) => rule.objectApiName),
    updateAllowedObjects: rules
      .filter((rule) => rule.operations.includes('UPDATE'))
      .map((rule) => rule.objectApiName),
    diagnosticReady,
    dynamicFormEvidence: 'NOT_AVAILABLE',
    managedDmlFields: managedDmlFieldRules.filter((rule) => rule.enabled).map((rule) => ({
      objectApiName: rule.objectApiName,
      fieldApiName: rule.targetFieldApiName,
      operations: [
        ...(rule.applyOnCreate ? ['CREATE' as const] : []),
        ...(rule.applyOnUpdate ? ['UPDATE' as const] : []),
      ],
      managedBy: 'MCP' as const,
      strategy: rule.strategy === 'PLATFORM_USER_LOOKUP' ? 'PLATFORM_IDENTITY' as const : 'AI_CREATED_MARKER' as const,
    })),
  });
}

export function registerAgentGuidance(
  server: McpServer,
  options: RegisterAgentGuidanceOptions,
): readonly string[] {
  registerResources(server, options.capabilities);
  registerPrompt(server, options.capabilities);
  const registered: string[] = [];
  if (options.enabledTools.includes('get_agent_playbook')) {
    registerPlaybookTool(server, options);
    registered.push('get_agent_playbook');
  }
  if (options.enabledTools.includes('get_record_links')) {
    registerRecordLinksTool(server, options);
    registered.push('get_record_links');
  }
  return Object.freeze(registered);
}

export function trustedLightningOrigin(lightningBaseUrl: string | undefined): string {
  if (!lightningBaseUrl?.trim()) {
    throw new RemoteRuntimeError(
      'MCP_RECORD_LINK_BASE_URL_NOT_CONFIGURED',
      'Salesforce record links are unavailable because SFOA_LIGHTNING_BASE_URL is not configured.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(lightningBaseUrl);
  } catch (error) {
    throw new RemoteRuntimeError(
      'MCP_RUNTIME_CONFIGURATION_INVALID',
      'SFOA_LIGHTNING_BASE_URL is invalid.',
      { cause: error },
    );
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.hostname.length === 0
    || parsed.pathname !== '/'
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new RemoteRuntimeError(
      'MCP_RUNTIME_CONFIGURATION_INVALID',
      'SFOA_LIGHTNING_BASE_URL must be a credential-free HTTPS origin root.',
    );
  }
  return parsed.origin;
}

function registerResources(server: McpServer, capabilities: AgentCapabilities): void {
  server.registerResource(
    'sfoa-agent-playbook-current',
    AGENT_PLAYBOOK_RESOURCE_URI,
    {
      title: 'Current SFoA Salesforce Agent Playbook',
      description: `Canonical version ${AGENT_PLAYBOOK_VERSION} Salesforce Agent operating contract with request capabilities.`,
      mimeType: 'text/markdown',
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderFullPlaybook(capabilities) }],
    }),
  );
  server.registerResource(
    'sfoa-agent-capabilities-current',
    AGENT_CAPABILITIES_RESOURCE_URI,
    {
      title: 'Current SFoA Agent capabilities',
      description: 'Safe request-scoped Tool, DML allowlist, Diagnostic, and context evidence facts.',
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(capabilities, null, 2) }],
    }),
  );
}

function registerPrompt(server: McpServer, capabilities: AgentCapabilities): void {
  server.registerPrompt(
    AGENT_PROMPT_NAME,
    {
      title: 'SFoA Salesforce Assistant',
      description: `Apply canonical SFoA Agent Playbook ${AGENT_PLAYBOOK_VERSION} to one Salesforce workflow.`,
      argsSchema: {
        workflow: agentWorkflowSchema.optional().describe('Defaults to ALL.'),
      },
    },
    ({ workflow }) => {
      const selected: AgentWorkflow = workflow ?? 'ALL';
      return {
        description: `SFoA Salesforce Agent Playbook ${AGENT_PLAYBOOK_VERSION} — ${selected}`,
        messages: [{ role: 'user', content: { type: 'text', text: renderWorkflow(selected, capabilities) } }],
      };
    },
  );
}

function registerPlaybookTool(server: McpServer, options: RegisterAgentGuidanceOptions): void {
  server.registerTool(
    'get_agent_playbook',
    {
      title: 'Get SFoA Agent Playbook',
      description: 'Return the current canonical SFoA Salesforce Agent workflow for clients without MCP Resource or Prompt support.',
      inputSchema: {
        workflow: agentWorkflowSchema.optional().describe('Defaults to ALL.'),
      },
      outputSchema: {
        playbookVersion: z.literal(AGENT_PLAYBOOK_VERSION),
        workflow: agentWorkflowSchema,
        guidance: z.string(),
        enabledTools: z.array(z.string()),
        hasMore: z.literal(false),
        nextCursor: z.null(),
        truncated: z.literal(false),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workflow }): Promise<CallToolResult> => withAgentAudit(options, 'get_agent_playbook', async () => {
      const started = performance.now();
      const selected: AgentWorkflow = workflow ?? 'ALL';
      const guidance = renderWorkflow(selected, options.capabilities);
      const structuredContent = {
        playbookVersion: AGENT_PLAYBOOK_VERSION,
        workflow: selected,
        guidance,
        enabledTools: [...options.capabilities.enabledTools],
        hasMore: false as const,
        nextCursor: null,
        truncated: false as const,
      };
      await logTool(options, 'get_agent_playbook', started, 'PASS', {
        workflow: selected,
      }, {
        playbookVersion: AGENT_PLAYBOOK_VERSION,
        workflow: selected,
      });
      return {
        content: [{ type: 'text', text: `SFoA Agent Playbook ${AGENT_PLAYBOOK_VERSION} (${selected}) returned in structuredContent.guidance.` }],
        structuredContent,
      };
    }),
  );
}

function registerRecordLinksTool(server: McpServer, options: RegisterAgentGuidanceOptions): void {
  server.registerTool(
    'get_record_links',
    {
      title: 'Get trusted Salesforce record links',
      description: 'Build Lightning record links from validated record descriptors and the configured trusted Lightning origin. Performs no Salesforce API call.',
      inputSchema: {
        records: z.array(recordDescriptorSchema).min(1).max(50).describe('One to 50 Salesforce record descriptors.'),
      },
      outputSchema: {
        records: z.array(z.object({
          objectApiName: z.string(),
          recordId: z.string(),
          displayName: z.string().optional(),
          recordUrl: z.string().url(),
        }).strict()).max(50),
        count: z.number().int().min(0).max(50),
        hasMore: z.literal(false),
        nextCursor: z.null(),
        truncated: z.literal(false),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ records }): Promise<CallToolResult> => withAgentAudit(options, 'get_record_links', async () => {
      const started = performance.now();
      try {
        const origin = trustedLightningOrigin(options.lightningBaseUrl);
        const linked = records.map((record) => ({
          objectApiName: record.objectApiName,
          recordId: record.recordId,
          ...(record.displayName ? { displayName: record.displayName } : {}),
          recordUrl: `${origin}/lightning/r/${encodeURIComponent(record.objectApiName)}/${encodeURIComponent(record.recordId)}/view`,
        }));
        const structuredContent = {
          records: linked,
          count: linked.length,
          hasMore: false as const,
          nextCursor: null,
          truncated: false as const,
        };
        await logTool(options, 'get_record_links', started, 'PASS', {
          recordCount: records.length,
          objectApiNames: [...new Set(records.map((record) => record.objectApiName))].sort(),
        }, {
          recordCount: linked.length,
        });
        return {
          content: [{ type: 'text', text: `Built ${linked.length} trusted Salesforce Lightning record link${linked.length === 1 ? '' : 's'}.` }],
          structuredContent,
        };
      } catch (error) {
        const runtimeError = error instanceof RemoteRuntimeError
          ? error
          : new RemoteRuntimeError(
              'MCP_RUNTIME_CONFIGURATION_INVALID',
              'The configured Salesforce Lightning record origin could not be resolved.',
              { cause: error },
            );
        await logTool(options, 'get_record_links', started, 'ERROR', {
          recordCount: records.length,
          objectApiNames: [...new Set(records.map((record) => record.objectApiName))].sort(),
        }, {
          errorCode: runtimeError.code,
        }, runtimeError.code);
        return remoteRuntimeErrorToolResult(
          runtimeError,
          options.redactionSecrets,
          options.scope.context.correlationId,
        );
      }
    }),
  );
}

function withAgentAudit<T>(
  options: RegisterAgentGuidanceOptions,
  toolName: string,
  callback: () => T,
): T {
  const context = options.requestAuditContext ?? RequestAuditContextController.create({
    correlationId: options.scope.context.correlationId,
    channel: 'MCP_HTTP',
    clientId: options.clientId,
    toolName,
    clientMetadata: options.auditClientMetadata,
  });
  context
    .withResolvedIdentity({
      platformUserId: options.scope.context.platformUserId,
      identitySource: options.auditIdentity.identitySource,
      ...(options.auditIdentity.identityCredentialId
        ? { identityCredentialId: options.auditIdentity.identityCredentialId }
        : {}),
    })
    .withSalesforceRoute({
      salesforceUsername: options.scope.route.salesforceUsername,
      executionRole: options.scope.route.connectionRole,
    });
  return runWithRequestAuditContext(context, callback);
}

async function logTool(
  options: RegisterAgentGuidanceOptions,
  toolName: 'get_agent_playbook' | 'get_record_links',
  started: number,
  result: 'PASS' | 'ERROR',
  requestSummary: unknown,
  responseSummary: unknown,
  errorCode?: string,
): Promise<void> {
  await Promise.resolve(options.logger.log({
    correlationId: options.scope.context.correlationId,
    clientId: options.clientId,
    platformUserId: options.scope.context.platformUserId,
    salesforceUsername: options.scope.route.salesforceUsername,
    executionRole: options.scope.route.connectionRole,
    toolName,
    durationMs: Math.round(performance.now() - started),
    result,
    outcome: result === 'PASS' ? 'SUCCESS' : 'FAILED',
    ...(errorCode ? { errorCode } : {}),
    requestSummary,
    responseSummary,
  })).catch(() => undefined);
}

export function serverInstructions(capabilities: AgentCapabilities): string {
  return renderServerInstructions(capabilities);
}
