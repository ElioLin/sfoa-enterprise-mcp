/**
 * The first-line object check on `run_diagnostic_tooling_query`, and the allowlist it enforces.
 *
 * ADR-0029 §4b assigns this to T2. The Tool's input is a free-form Tooling SOQL `SELECT`, so a
 * mistyped or hostile statement is answered only by whatever the platform does with it. §4a measured
 * that answer: the Tooling API refuses `Lead`, `Account`, `Value_Bill__c` and `Order__c` with
 * `INVALID_TYPE` while `ApexClass` resolves — a genuine guarantee, and the reason the Tool is not a
 * business-data path today.
 *
 * But §0.3.1 requires the query target to be in a hardcoded, unit-tested whitelist, and this is the one
 * diagnostic Tool where that was not true. This module supplies it: the top-level `FROM` targets are
 * extracted and compared against a fixed set **before** the statement reaches Salesforce, and the
 * platform's own refusal stays in place as the backstop it already is.
 *
 * **This is defence in depth, and it must not be described as anything more.** A regular expression over
 * SOQL is not a parser; a crafted statement could in principle evade the extraction, and a reviewer
 * should assume it can. That is acceptable *only* because the backstop is measured and structural — an
 * evasion is answered with `INVALID_TYPE`, never with rows. Read this as a second lock on a door whose
 * first lock was measured, not as a parser that makes the first lock unnecessary.
 *
 * The allowlist is deliberately not a list of canned queries: an operator asking an arbitrary Tooling
 * question during an incident keeps that ability for every type in the set, and a type outside it is a
 * whitelist change with a measurement and a test rather than a runtime escape hatch.
 */

import { ContextRuntimeError } from './errors.js';

/**
 * Whether a target's inclusion was measured on this deployment by `probe:p10`, or comes from
 * Salesforce's Tooling API object reference.
 *
 * The split is kept because the two are not equal evidence, and the ADR's own lesson is that an
 * unmeasured entry must not borrow the authority of a measured one. It also marks exactly where a later
 * run should start measuring.
 */
export type DiagnosticToolingTypeBasis = 'MEASURED' | 'DOCUMENTED';

/**
 * Tooling entities this diagnostic query surface may address, and the basis for each.
 *
 * The `MEASURED` five are the types `probe:p10` actually resolved through the diagnostic identity
 * (`ApexClass` as the §9 control, `ApexLog` §1, `TraceFlag` §2, `DebugLevel` §3, `ValidationRule` §7).
 *
 * The `DOCUMENTED` group is **not verified against a live org**. This deployment's probe sampled five
 * types, not twenty-four, so these names come from Salesforce's Tooling API object reference the same
 * way `ORG_LIMIT_HIGHLIGHT_ALIASES` took its org keys from documentation when no identity could read
 * the limits resource. A wrong inclusion is not a leak: the platform refuses a type it does not carry,
 * and the operator sees that refusal. A wrong *omission* is the failure this list can actually cause —
 * a legitimate investigation blocked by our own check — and the remedy is to measure the type and add
 * it here.
 *
 * No business object appears in either group, and none may be added: `Lead`, `Account` and the two
 * custom objects measured in §9 are the exact targets this check exists to refuse.
 */
export const DIAGNOSTIC_TOOLING_TYPE_BASIS: Readonly<Record<string, DiagnosticToolingTypeBasis>> =
  Object.freeze({
    // Measured on this deployment through the diagnostic identity (`probe:p10`).
    ApexClass: 'MEASURED',
    ApexLog: 'MEASURED',
    DebugLevel: 'MEASURED',
    TraceFlag: 'MEASURED',
    ValidationRule: 'MEASURED',
    // Documented Tooling API entities; Setup-layer by construction, unmeasured here.
    ApexCodeCoverage: 'DOCUMENTED',
    ApexCodeCoverageAggregate: 'DOCUMENTED',
    ApexComponent: 'DOCUMENTED',
    ApexExecutionOverlayAction: 'DOCUMENTED',
    ApexExecutionOverlayResult: 'DOCUMENTED',
    ApexOrgWideCoverage: 'DOCUMENTED',
    ApexPage: 'DOCUMENTED',
    ApexTestQueueItem: 'DOCUMENTED',
    ApexTestResult: 'DOCUMENTED',
    ApexTestRunResult: 'DOCUMENTED',
    ApexTrigger: 'DOCUMENTED',
    AsyncApexJob: 'DOCUMENTED',
    CronTrigger: 'DOCUMENTED',
    EntityDefinition: 'DOCUMENTED',
    FieldDefinition: 'DOCUMENTED',
    MetadataComponentDependency: 'DOCUMENTED',
    SetupAuditTrail: 'DOCUMENTED',
    StaticResource: 'DOCUMENTED',
    WorkflowRule: 'DOCUMENTED',
  });

export const DIAGNOSTIC_TOOLING_TYPES: readonly string[] = Object.freeze(
  Object.keys(DIAGNOSTIC_TOOLING_TYPE_BASIS),
);

const ALLOWED_TARGETS = new Set(DIAGNOSTIC_TOOLING_TYPES.map((name) => name.toLocaleUpperCase('en-US')));

/**
 * `FROM SomeType`, anywhere in the statement, so a subquery or a semi-join is caught as well as the
 * top-level source.
 *
 * The capture requires a leading letter and excludes dots, which matches every API name: a relationship
 * path cannot appear in a `FROM` clause, and `FROM Account.Contacts` is not a shape SOQL accepts.
 */
const QUERY_TARGET_PATTERN = /\bFROM\s+([A-Za-z][A-Za-z0-9_]*)/gu;

/** Single-quoted SOQL literal, with backslash escapes, as SOQL writes them. */
const STRING_LITERAL_PATTERN = /'(?:[^'\\]|\\.)*'/gu;

/**
 * Tooling SOQL has no `USING` clause this Tool supports — the standard API's `USING SCOPE` selects on
 * record sharing, and a Tooling query returns Setup records with no sharing to select on.
 *
 * It is refused outright rather than extracted and compared, because the clause's own argument
 * (`mine`, `team`, `everything`) is a sharing scope and not a type, so there is nothing sensible to
 * compare it against. Failing closed here costs nothing: a statement carrying it would have been
 * refused by the platform with `MALFORMED_QUERY` anyway, and this refusal says why.
 */
const USING_CLAUSE_PATTERN = /\bUSING\b/iu;

export type DiagnosticQueryTargetRejection = Readonly<{
  /** The offending target verbatim as the statement wrote it, or a description of its absence. */
  target: string;
  message: string;
  suggestion: string;
}>;

/**
 * The `FROM` targets of a statement, in order and deduplicated, with string literals removed first.
 *
 * Stripping literals is the one subtle step. A literal can contain the word `FROM` — a query filtering
 * `WHERE Operation = 'FROM Lead'` is not a query against `Lead` — and removing literals can only lose a
 * false target, never hide a real one, because a real `FROM` is outside every literal by construction.
 */
export function extractDiagnosticQueryTargets(statement: string): readonly string[] {
  const scrubbed = statement.replace(STRING_LITERAL_PATTERN, "''");
  const targets: string[] = [];
  for (const match of scrubbed.matchAll(QUERY_TARGET_PATTERN)) {
    const target = match[1];
    if (target !== undefined && !targets.includes(target)) targets.push(target);
  }
  return Object.freeze(targets);
}

export function isAllowedDiagnosticQueryTarget(target: string): boolean {
  return ALLOWED_TARGETS.has(target.toLocaleUpperCase('en-US'));
}

/**
 * Null when the statement may be sent, a rejection describing the first problem otherwise.
 *
 * Returns rather than throws so the caller can decide how a refusal is reported; `assert…` wraps it for
 * the Tool, which wants the throw.
 */
export function checkDiagnosticQueryTargets(statement: string): DiagnosticQueryTargetRejection | null {
  if (USING_CLAUSE_PATTERN.test(statement)) {
    return Object.freeze({
      target: 'USING',
      message: 'This Tool does not accept a USING clause: the Tooling API has no record-sharing scope to '
        + 'select on, so there is no way to honour one.',
      suggestion: 'Remove the USING clause. This Tool reads platform and code metadata, which is not governed '
        + 'by record sharing — there is nothing for the clause to narrow.',
    });
  }
  const targets = extractDiagnosticQueryTargets(statement);
  const first = targets[0];
  if (first === undefined) {
    // A `SELECT` whose target could not be extracted. That is not the same as an allowed target: it
    // means this check cannot say what the statement reads, so it refuses rather than guesses.
    return Object.freeze({
      target: '(none)',
      message: 'No FROM target could be read from this statement, so which object it addresses could not be '
        + 'established.',
      suggestion: 'Write the query with an explicit `SELECT … FROM <Type>` source. This Tool refuses a '
        + 'statement whose target it cannot read, rather than passing it to Salesforce unchecked.',
    });
  }
  for (const target of targets) {
    if (isAllowedDiagnosticQueryTarget(target)) continue;
    const measured = DIAGNOSTIC_TOOLING_TYPES.join(', ');
    return Object.freeze({
      target,
      message: `${target} is not in the allowlist of platform and code types this diagnostic query surface may `
        + `address. Allowed: ${measured}.`,
      suggestion: 'Query an allowlisted type, or read this answer another way: business records are deliberately '
        + 'unreachable from the DIAGNOSTIC identity\'s Tooling route, and this refusal is that boundary working '
        + 'rather than a missing permission. If the type is genuinely Setup-layer and missing from the list, it is '
        + 'added by measuring it on the deployment and extending the list — not by bypassing the check.',
    });
  }
  return null;
}

/**
 * The Tool-facing form: throws the structured error the §3 degradation contract reports.
 *
 * The message repeats the check's own wording rather than restating it, so the refusal an operator reads
 * in the audit trail and the one they read in the Tool result cannot drift apart.
 */
export function assertDiagnosticQueryTargets(statement: string): void {
  const rejection = checkDiagnosticQueryTargets(statement);
  if (rejection === null) return;
  throw new ContextRuntimeError('MCP_DIAGNOSTIC_QUERY_OBJECT_NOT_ALLOWED', rejection.message, {
    suggestion: rejection.suggestion,
  });
}
