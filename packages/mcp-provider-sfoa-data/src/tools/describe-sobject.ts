import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { DescribeSobjectExecutor } from '../describe-sobject-executor.js';
import {
  DESCRIBE_SOBJECT_DEFAULT_FIELD_LIMIT,
  DESCRIBE_SOBJECT_MAX_CHILD_RELATIONSHIPS,
  DESCRIBE_SOBJECT_MAX_FIELD_LIMIT,
  DESCRIBE_SOBJECT_MAX_PICKLIST_VALUES,
  describeSobjectInputSchema,
  describeSobjectOutputSchema,
  type DescribeSobjectInput,
} from '../schemas.js';
import { dataFailureToolResult, dataSuccessToolResult } from '../tool-results.js';

type InputShape = typeof describeSobjectInputSchema.shape;
type OutputShape = typeof describeSobjectOutputSchema.shape;

export class DescribeSobjectMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: DescribeSobjectExecutor) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return 'describe_sobject';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'Describe Salesforce Object',
      description:
        'Returns one Salesforce object\'s schema facts: label, key prefix, whether it is queryable/createable/updateable/searchable, its fields (API name, type, nillable, createable/updateable, filterable/sortable, referenceTo, relationship name, bounded picklist values) and its child relationships. '
        + 'Call it before writing a query or payload when a field or relationship name is uncertain, and call it to repair a failed query: an INVALID_FIELD or INVALID_TYPE error means the field or object name is wrong, so describe the object, correct the name and retry instead of guessing again. '
        + 'It reads schema only: it returns no business records and changes nothing. The result states whether the field list is complete.',
      inputSchema: describeSobjectInputSchema.shape,
      outputSchema: describeSobjectOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: DescribeSobjectInput): Promise<CallToolResult> {
    try {
      const parsed = describeSobjectInputSchema.parse(input);
      return dataSuccessToolResult(await this.executor.execute(parsed));
    } catch (error) {
      return dataFailureToolResult(error, 'MCP_SOBJECT_DESCRIBE_FAILED');
    }
  }
}

export const DESCRIBE_SOBJECT_LIMITS = Object.freeze({
  defaultFieldLimit: DESCRIBE_SOBJECT_DEFAULT_FIELD_LIMIT,
  maxFieldLimit: DESCRIBE_SOBJECT_MAX_FIELD_LIMIT,
  maxChildRelationships: DESCRIBE_SOBJECT_MAX_CHILD_RELATIONSHIPS,
  maxPicklistValues: DESCRIBE_SOBJECT_MAX_PICKLIST_VALUES,
});
