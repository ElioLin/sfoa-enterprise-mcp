import { z } from 'zod';
import { RemoteRuntimeError } from './errors.js';

/**
 * The SFoA attachment capability's own policy channel.
 *
 * It is deliberately NOT part of the `MCP_DML_ALLOWLIST_JSON` object-operation
 * allowlist. Attaching a file is not a CREATE and is not a field UPDATE, the Salesforce
 * Files objects are internal technical objects that must never appear as generic DML
 * targets, and an object may legitimately accept files while accepting no record
 * mutation at all. Sharing one channel would make each of those statements false the
 * moment someone added `ATTACHMENT` to an operations array to make a tool load.
 */
export const SFOA_ATTACHMENT_TOOL_NAMES = Object.freeze(['upload_files_to_record'] as const);
export type SfoaAttachmentToolName = (typeof SFOA_ATTACHMENT_TOOL_NAMES)[number];

export function isSfoaAttachmentToolName(value: string): value is SfoaAttachmentToolName {
  return (SFOA_ATTACHMENT_TOOL_NAMES as readonly string[]).includes(value);
}

export interface AttachmentPolicy {
  /** Throws `MCP_ATTACHMENT_OBJECT_NOT_ALLOWED` unless this object accepts attachments. */
  assertAllowed(objectApiName: string): void;
  /** Whether any object accepts attachments at all. Guards tool advertisement. */
  allowsAny(): boolean;
  getObjects(): readonly string[];
}

const objectApiNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z][A-Za-z0-9_]*$/u,
    'must be a Salesforce object API name without a relationship path',
  );

const objectRuleSchema = z.object({ objectApiName: objectApiNameSchema }).strict();

const policySchema = z.array(objectRuleSchema).max(1_000).superRefine((rules, context) => {
  const seen = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    const normalized = normalizeObjectApiName(rule.objectApiName);
    if (seen.has(normalized)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'objectApiName'],
        message: `duplicate object ${rule.objectApiName} is not allowed`,
      });
    }
    seen.add(normalized);
  }
});

export class StaticAttachmentPolicy implements AttachmentPolicy {
  private readonly objects: readonly string[];
  private readonly allowed: ReadonlySet<string>;

  public constructor(rules: readonly { objectApiName: string }[]) {
    this.objects = Object.freeze(rules.map((rule) => rule.objectApiName));
    this.allowed = new Set(this.objects.map(normalizeObjectApiName));
  }

  public assertAllowed(objectApiName: string): void {
    if (!this.allowed.has(normalizeObjectApiName(objectApiName))) {
      throw new RemoteRuntimeError(
        'MCP_ATTACHMENT_OBJECT_NOT_ALLOWED',
        `Object ${objectApiName} is not configured to accept file attachments.`,
      );
    }
  }

  public allowsAny(): boolean {
    return this.objects.length > 0;
  }

  public getObjects(): readonly string[] {
    return this.objects;
  }
}

export function parseAttachmentPolicyJson(value: string | undefined): AttachmentPolicy {
  if (!value?.trim()) return new StaticAttachmentPolicy([]);

  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new RemoteRuntimeError(
      'MCP_ATTACHMENT_CONFIGURATION_INVALID',
      'The attachment policy must be valid JSON containing an array of object rules.',
    );
  }

  const parsed = policySchema.safeParse(decoded);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.length === 0 ? 'policy' : issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new RemoteRuntimeError(
      'MCP_ATTACHMENT_CONFIGURATION_INVALID',
      `Invalid attachment policy: ${details}`,
    );
  }

  return new StaticAttachmentPolicy(parsed.data);
}

function normalizeObjectApiName(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}
