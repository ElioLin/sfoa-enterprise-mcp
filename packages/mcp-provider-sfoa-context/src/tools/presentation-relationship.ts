import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpTool, ReleaseState, Toolset, type McpToolConfig } from '@salesforce/mcp-provider-api';
import type { z } from 'zod';
import { PresentationRelationshipExecutor, displayValuesInputSchema, displayValuesOutputSchema,
  relationshipInputSchema, relationshipOutputSchema } from '../presentation-relationship.js';

export class PresentationRelationshipMcpTool extends McpTool<z.ZodRawShape, z.ZodRawShape> {
  public constructor(private readonly executor: PresentationRelationshipExecutor,
    private readonly kind: 'DISPLAY' | 'RELATIONSHIP') { super(); }
  public getName(): string { return this.kind === 'DISPLAY' ? 'resolve_field_display_values' : 'get_record_relationship_context'; }
  public getReleaseState(): ReleaseState { return ReleaseState.GA; }
  public getToolsets(): Toolset[] { return [Toolset.DATA]; }
  public getConfig(): McpToolConfig<z.ZodRawShape, z.ZodRawShape> {
    return { title: this.kind === 'DISPLAY' ? 'Resolve Salesforce Display Values' : 'Get Salesforce Relationship Context',
      description: this.kind === 'DISPLAY'
        ? 'Resolve up to 200 raw Picklist/MultiPicklist values to current Salesforce labels as the request USER. Supply each row Record Type for mixed-type data; omitted type uses current USER default. At most 25 field/type metadata groups, 5 seconds. Each multi-value item resolves separately; unresolved values retain raw fallback with explicit status. Presentation only: SOQL, filters, DML and Audit retain API values. No translation or inferred labels.'
        : 'Read bounded current USER relationship metadata for a root CREATE intent. At most 20 child relationships and 5 seconds; returns only CREATE-allowlisted, Salesforce-createable children and relationship fields. Metadata describes possible relationships, not instructions to create unrequested children. No org-wide schema, business workflow, Diagnostic identity or mutation.',
      inputSchema: this.kind === 'DISPLAY' ? displayValuesInputSchema.shape : relationshipInputSchema.shape,
      outputSchema: this.kind === 'DISPLAY' ? displayValuesOutputSchema.shape
        : relationshipOutputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } };
  }
  public async exec(input: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const output = this.kind === 'DISPLAY' ? await this.executor.display(displayValuesInputSchema.parse(input))
        : await this.executor.relationships(relationshipInputSchema.parse(input));
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    } catch {
      return { isError: true, content: [{ type: 'text', text: 'MCP_CONTEXT_READ_FAILED: validate input and current USER metadata access; no mutation was performed.' }] };
    }
  }
}
