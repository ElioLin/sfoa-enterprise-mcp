import { z } from 'zod';
import { DmlRuntimeError } from './errors.js';

export const DML_OPERATIONS = ['CREATE', 'UPDATE'] as const;
export type DmlOperation = (typeof DML_OPERATIONS)[number];

export type DmlAllowlistRule = Readonly<{
  objectApiName: string;
  operations: readonly DmlOperation[];
}>;

export interface DmlAllowlistPolicy {
  assertAllowed(objectApiName: string, operation: DmlOperation): void;
  allowsAny(operation: DmlOperation): boolean;
  getRules(): readonly DmlAllowlistRule[];
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

const ruleSchema = z
  .object({
    objectApiName: objectApiNameSchema,
    operations: z.array(z.enum(DML_OPERATIONS)).min(1).max(DML_OPERATIONS.length),
  })
  .strict()
  .superRefine((rule, context) => {
    const seen = new Set<DmlOperation>();
    for (const operation of rule.operations) {
      if (seen.has(operation)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['operations'],
          message: `duplicate operation ${operation} is not allowed`,
        });
      }
      seen.add(operation);
    }
  });

const allowlistSchema = z.array(ruleSchema).max(1_000).superRefine((rules, context) => {
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

export class StaticDmlAllowlistPolicy implements DmlAllowlistPolicy {
  private readonly rules: readonly DmlAllowlistRule[];
  private readonly operationsByObject: ReadonlyMap<string, ReadonlySet<DmlOperation>>;

  public constructor(rules: readonly DmlAllowlistRule[]) {
    const copiedRules = rules.map((rule) =>
      Object.freeze({
        objectApiName: rule.objectApiName,
        operations: Object.freeze([...rule.operations]),
      }),
    );
    this.rules = Object.freeze(copiedRules);
    this.operationsByObject = new Map(
      copiedRules.map((rule) => [
        normalizeObjectApiName(rule.objectApiName),
        new Set(rule.operations),
      ]),
    );
  }

  public assertAllowed(objectApiName: string, operation: DmlOperation): void {
    const operations = this.operationsByObject.get(normalizeObjectApiName(objectApiName));
    if (!operations) {
      throw new DmlRuntimeError(
        'MCP_DML_OBJECT_NOT_ALLOWED',
        `Object ${objectApiName} is not configured for SFoA record mutation.`,
      );
    }
    if (!operations.has(operation)) {
      throw new DmlRuntimeError(
        'MCP_DML_OPERATION_NOT_ALLOWED',
        `${operation} is not configured for object ${objectApiName}.`,
      );
    }
  }

  public allowsAny(operation: DmlOperation): boolean {
    return this.rules.some((rule) => rule.operations.includes(operation));
  }

  public getRules(): readonly DmlAllowlistRule[] {
    return this.rules;
  }
}

export function parseDmlAllowlistJson(value: string | undefined): DmlAllowlistPolicy {
  if (!value?.trim()) return new StaticDmlAllowlistPolicy([]);

  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new DmlRuntimeError(
      'MCP_DML_CONFIGURATION_INVALID',
      'MCP_DML_ALLOWLIST_JSON must be valid JSON containing an array of object-operation rules.',
    );
  }

  const parsed = allowlistSchema.safeParse(decoded);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${formatPath(issue.path)}: ${issue.message}`)
      .join('; ');
    throw new DmlRuntimeError(
      'MCP_DML_CONFIGURATION_INVALID',
      `Invalid MCP_DML_ALLOWLIST_JSON: ${details}`,
    );
  }

  return new StaticDmlAllowlistPolicy(parsed.data);
}

function normalizeObjectApiName(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function formatPath(path: (string | number)[]): string {
  return path.length === 0 ? 'allowlist' : path.join('.');
}
