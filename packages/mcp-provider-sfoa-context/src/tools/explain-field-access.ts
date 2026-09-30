import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { FieldAccessExplainer } from '../contracts.js';
import {
  EXPLAIN_FIELD_ACCESS_DEFAULT_RECORD_TYPE_CONTEXT,
  EXPLAIN_FIELD_ACCESS_MAX_FIELDS,
  explainFieldAccessInputSchema,
  explainFieldAccessOutputSchema,
  type ExplainFieldAccessInput,
  type ExplainFieldAccessOutput,
  type FieldAccessConclusion,
  type FieldAccessExplanation,
} from '../schemas.js';
import { contextExecutionErrorToolResult } from '../tool-results.js';

type InputShape = typeof explainFieldAccessInputSchema.shape;
type OutputShape = typeof explainFieldAccessOutputSchema.shape;

/**
 * Explains *why* a field is or is not visible and editable for one Salesforce user.
 *
 * The Tool is an **evidence aggregator, not a permission engine**, and the difference is the whole
 * design. It does not re-implement Salesforce's decision procedure and it does not predict what the
 * platform will do with a particular record; it reads the org's own permission configuration —
 * `FieldPermissions`, `ObjectPermissions`, `PermissionSetAssignment`, `PermissionSet`, `Profile`,
 * `RecordType` — and reports what those tables say about one subject, naming the rows the answer came
 * from so a human can check it in Setup.
 *
 * **What it deliberately does not do.** It does not call `describe` for another user. `describe`
 * answers for the identity that called it, and that identity here is the deployment's fixed DIAGNOSTIC
 * account, so mixing its answer into a named user's explanation would silently report an
 * administrator's permissions as the user's. The measured finding behind this
 * (`docs/sfoa/P10_T0_LIVE_PROBE_FINDINGS.md` §6) is the reason `describeFacts` is returned under a flag
 * that says whose view it is.
 *
 * **The third answer.** `visible` and `editable` are `true`, `false`, or `'INDETERMINATE'`. When a layer
 * an answer depends on could not be read, the answer is the third one — never `false` — because "the
 * evidence is missing" and "the permission is absent" are different facts and only one of them is
 * actionable (ADR-0029 §3).
 *
 * **The subject.** `targetUserId` names whose access to explain, and it is bounded: only Salesforce users
 * this deployment has configured as identity routes may be named. Omitted, the subject is the requesting
 * user. A Tool that accepted an arbitrary user Id would be account-access reconnaissance rather than
 * diagnosis.
 */
export class ExplainFieldAccessMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: FieldAccessExplainer) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return 'explain_field_access';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'Explain Field-Level Access',
      description:
        'Explains whether one Salesforce user can see and edit a set of fields, and which permission sets or profiles '
        + 'carry the grants that decide it. Use it to answer "why can\'t this person edit that field" with the rows the '
        + 'answer came from, instead of guessing from the field\'s type. '
        + `fieldApiNames takes one to ${EXPLAIN_FIELD_ACCESS_MAX_FIELDS} field API names on one object; the names are used `
        + 'only as keys into the permission configuration, and no field value is ever read. '
        + 'targetUserId names whose access to explain, as a Salesforce User Id. Only users this deployment has configured '
        + 'as identity routes may be named — any other Id is refused — and omitting it explains the requesting user\'s own '
        + 'access. '
        + 'structuredContent.userContext reports the permission sets the subject holds and the object-level grant aggregated '
        + `over them. includeRecordTypeContext (default ${EXPLAIN_FIELD_ACCESS_DEFAULT_RECORD_TYPE_CONTEXT}) adds the object's `
        + 'record types; their availability to the subject is reported as INDETERMINATE, because per-user record-type '
        + 'availability is a Profile metadata fact that this Tool\'s read surface does not carry. '
        + 'structuredContent.fields carries one entry per field, each with the grants attributable to the subject and a '
        + 'conclusion whose visible and editable are true, false, or the string "INDETERMINATE" — the third one meaning a '
        + 'layer the answer depends on could not be read, which is NOT a denial. sourceChain names the layers the conclusion '
        + 'was built from, conflicts records where two layers disagree, and caveats says what the answer does not establish. '
        + 'This Tool reports what the org is configured to allow. It is not a permission simulator and does not predict what '
        + 'Salesforce will decide for a particular record: a validation rule, a field dependency or a read-only layout can '
        + 'refuse an edit that field-level security permits, and none of those is readable here. '
        + 'It runs on the server-owned DIAGNOSTIC identity rather than on your own Salesforce user, because the permission '
        + 'tables it reads are an org-configuration surface business identities are not granted. It reads permission '
        + 'configuration only, never a business record. '
        + 'Read-only: it reads permission tables and never modifies anything.',
      inputSchema: explainFieldAccessInputSchema.shape,
      outputSchema: explainFieldAccessOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: ExplainFieldAccessInput): Promise<CallToolResult> {
    try {
      const parsed = explainFieldAccessInputSchema.parse(input);
      const output = await this.executor.execute(parsed);
      return {
        content: [{ type: 'text', text: renderExplainFieldAccessText(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return contextExecutionErrorToolResult(error, 'MCP_FIELD_ACCESS_READ_FAILED');
    }
  }
}

/**
 * The text an Agent reads: the subject, the object-level context, one block per field, then the next step.
 *
 * Every state of a conclusion is printed with a word rather than with the raw value, because the one
 * mistake this renderer can make is the one the wire shape invites: `'INDETERMINATE'` is a truthy string,
 * so `if (conclusion.editable)` would print a gap as a grant. The comparisons here are `=== true` and
 * `=== false` for exactly that reason, and the unit suite pins them.
 */
export function renderExplainFieldAccessText(output: ExplainFieldAccessOutput): string {
  const lines = [
    `explain_field_access: object=${format(output.objectApiName)} `
      + `fields=${format(output.returnedFieldCount)}/${format(output.requestedFieldCount)} `
      + `truncated=${format(output.truncated)} api=${format(output.api)}`,
  ];
  const user = output.userContext;
  if (user === undefined) {
    lines.push('Subject: not resolved.');
  } else {
    lines.push(
      `Subject: ${user.userName ?? user.username ?? user.userId} `
        + `(username=${format(user.username)} id=${user.userId} `
        + `${user.isRequestingUser ? 'requesting user' : 'named targetUserId'}) active=${format(user.isActive)}`,
    );
    if (user.objectAccess === null) {
      lines.push('Object-level grants: not readable, so every field conclusion rests on a gap.');
    } else {
      lines.push(
        `Object-level grants: read=${format(user.objectAccess.read)} edit=${format(user.objectAccess.edit)} `
          + `viewAllRecords=${format(user.objectAccess.viewAllRecords)}`,
      );
      if (user.objectAccess.unreadableParentIds.length > 0) {
        lines.push(`Object-level rows missing for ${user.objectAccess.unreadableParentIds.length} permission set(s).`);
      }
    }
    lines.push(`Permission sets (${user.permissionSets.length}${user.permissionSetsTruncated ? ', truncated' : ''}):`);
    for (const set of user.permissionSets) {
      lines.push(
        `  ${set.id} ${format(set.name)} label=${format(set.label)} `
          + `${set.isOwnedByProfile ? `profile=${format(set.profileName)}` : 'standalone'}`,
      );
    }
  }
  const recordTypes = output.recordTypeContext;
  if (recordTypes !== undefined) {
    lines.push(
      `Record types (${recordTypes.recordTypes.length}${recordTypes.truncated ? ', truncated' : ''}) `
        + `availableToSubject=${recordTypes.availableToSubject}`,
    );
    for (const type of recordTypes.recordTypes) {
      lines.push(`  ${type.id} ${format(type.developerName)} name=${format(type.name)} active=${format(type.isActive)}`);
    }
    lines.push(`Caveat: ${recordTypes.caveat}`);
  }
  for (const field of output.fields ?? []) {
    lines.push(...renderField(field));
  }
  if (typeof output.hint === 'string' && output.hint.length > 0) {
    lines.push(`Next: ${output.hint}`);
  }
  return lines.join('\n');
}

function renderField(field: FieldAccessExplanation): readonly string[] {
  const lines: string[] = [`Field: ${field.fieldApiName}`];
  const describe = field.describeFacts;
  lines.push(describe === null
    ? '  describe: this field was not found on the object.'
    : `  describe (executing identity, not the subject): type=${format(describe.type)} `
      + `createable=${format(describe.createable)} updateable=${format(describe.updateable)} `
      + `accessible=${format(describe.accessible)}`);
  lines.push(`  Subject's grants (${field.grants.length}${field.grantsTruncated ? ', truncated' : ''}):`);
  if (field.grants.length === 0) {
    lines.push('    none attributed to the subject');
  }
  for (const grant of field.grants) {
    lines.push(
      `    ${grant.parentType} ${format(grant.parentName)} label=${format(grant.parentLabel)} `
        + `read=${format(grant.permissionsRead)} edit=${format(grant.permissionsEdit)}`,
    );
  }
  lines.push(...renderConclusion(field.conclusion));
  return lines;
}

function renderConclusion(conclusion: FieldAccessConclusion): readonly string[] {
  const lines = [`  conclusion: visible=${describeState(conclusion.visible)} editable=${describeState(conclusion.editable)}`];
  if (conclusion.sourceChain.length > 0) lines.push(`    sourceChain: ${conclusion.sourceChain.join(' -> ')}`);
  if (conclusion.conflicts.length > 0) lines.push(`    conflicts: ${conclusion.conflicts.join('; ')}`);
  if (conclusion.caveats.length > 0) lines.push(`    caveats: ${conclusion.caveats.join('; ')}`);
  return lines;
}

/**
 * Prints the three states of a conclusion as words.
 *
 * `'INDETERMINATE'` is truthy, so this is the function that stops a gap being rendered as a grant — the
 * reason it is exported and separately asserted rather than inlined as a template expression.
 */
export function describeState(value: boolean | 'INDETERMINATE'): string {
  if (value === true) return 'granted';
  if (value === false) return 'not granted';
  return 'INDETERMINATE (layer not readable)';
}

function format(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  return String(value);
}
