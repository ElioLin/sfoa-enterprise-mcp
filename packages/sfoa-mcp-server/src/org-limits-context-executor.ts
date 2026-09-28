import { DATA_MAX_RESPONSE_BYTES, readSalesforceFailure, trimToByteBudget } from '@sfoa/mcp-provider-sfoa-data';
import {
  ContextRuntimeError,
  ORG_LIMIT_HIGHLIGHT_SLOTS,
  countMeasuredLimits,
  orderLimitKeys,
  readOrgLimitEntries,
  readOrgLimitHighlights,
  type OrgLimitEntry,
  type OrgLimitsInput,
  type OrgLimitsOutput,
} from '@sfoa/mcp-provider-sfoa-context';
import type { RequestScope } from '@sfoa/identity-runtime';
import { assertDiagnosticScope } from './diagnostic-context-adapters.js';

/**
 * Reads the org's governor limits through the request's fixed DIAGNOSTIC identity.
 *
 * This lives in the host rather than in the context provider because the execution role is a host
 * decision: `RequestScope` is the only object that knows which identity a request was routed to, and
 * `assertDiagnosticScope` is the only check that can prove it — a provider-side executor is handed a
 * connection it cannot attribute, so it could never refuse to run on a business identity. The
 * provider owns the Tool contract and the pure derivation; the host owns the identity guard, the
 * Connection and the response budget, the same division the other two diagnostic Tools already use.
 *
 * The prompt this answers is a bulk job's pre-flight: "how much allowance is left?". A resource the
 * org does not meter is reported as an absent slot rather than as a zero, and an org that refuses
 * the resource produces a structured error rather than an empty table.
 */
export class ScopedOrgLimitsExecutor {
  public constructor(private readonly scope: RequestScope) {}

  public async execute(input: OrgLimitsInput): Promise<OrgLimitsOutput> {
    const verbose = input.verbose === true;
    // Depth on top of the facade's own role check: the facade decides what the request may do, this
    // decides which identity a Connection may be opened for. Neither is redundant — the facade is
    // reached through several composition paths and this one is the last point before Salesforce.
    assertDiagnosticScope(this.scope, 'get_org_limits');
    try {
      const connection = await this.scope.getConnection();
      const payload: unknown = await connection.limits();
      const entries = readOrgLimitEntries(payload);
      const readable = countMeasuredLimits(entries);
      // An org that answered with nothing readable is not an org without limits, and returning
      // `limits: {}` would invite exactly that conclusion from an Agent about to size a bulk job.
      if (readable === 0) {
        throw new ContextRuntimeError(
          'MCP_LIMITS_READ_FAILED',
          'Salesforce returned no readable governor-limit entry, so this org\'s quota state is unknown.',
          {
            suggestion: 'Treat this as unknown, never as unlimited: retry once, and if it repeats the org or API version in '
              + 'use does not expose the limits resource, so the allowances have to be read from Salesforce Setup.',
          },
        );
      }
      const ordered = orderLimitKeys(entries);
      const highlights = readOrgLimitHighlights(entries);
      // `build` renders the complete answer for a candidate prefix, so the budget measures what the
      // Agent receives, hint included. The highlight slots sit at the front of `ordered`, which is
      // what lets the hint promise they survive a cut.
      const build = (kept: readonly string[]): OrgLimitsOutput => {
        const limits: Record<string, OrgLimitEntry> = {};
        for (const key of kept) {
          const entry = entries.get(key);
          if (entry !== undefined) limits[key] = entry;
        }
        const truncated = kept.length < ordered.length;
        return {
          success: true,
          executionRole: 'DIAGNOSTIC',
          api: 'REST',
          verbose,
          limits,
          highlights,
          totalLimits: entries.size,
          returnedLimits: kept.length,
          unreadableLimits: entries.size - readable,
          truncated,
          ...(truncated
            ? {
                hint: `Incomplete read: this org reports ${entries.size} limits and ${kept.length} are included here. `
                  + `The ${ORG_LIMIT_HIGHLIGHT_SLOTS.length} highlight slots are always kept; the rest were dropped to fit `
                  + `the ${DATA_MAX_RESPONSE_BYTES}-byte response budget, and no parameter raises it.`,
              }
            : {}),
        };
      };
      return build(trimToByteBudget(ordered, DATA_MAX_RESPONSE_BYTES, build).kept);
    } catch (error) {
      throw mapOrgLimitsFailure(error);
    }
  }
}

const LIMITS_DENIAL_CODES = [
  'INSUFFICIENT_ACCESS',
  'INSUFFICIENT_ACCESS_OR_READONLY',
  'INSUFFICIENT_PRIVILEGES',
  'API_DISABLED_FOR_ORG',
  'NOT_FOUND',
  'INVALID_TYPE',
] as const;

/**
 * `limits` has no access-denied branch of its own beyond this one, because "the identity may not
 * read the limits resource" and "this org does not expose it" arrive as the same Salesforce code.
 * The message therefore states both possibilities rather than picking one.
 *
 * The suggestion names the remedy that is actually available here. This Tool already runs on the
 * server-owned DIAGNOSTIC identity, so the failure is not a missing permission on a business user —
 * and widening a business integration identity to see Setup is deliberately not the fix, because the
 * separation of the diagnostic role from the business roles is the point of that role.
 */
function mapOrgLimitsFailure(error: unknown): ContextRuntimeError {
  if (error instanceof ContextRuntimeError) return error;
  const failure = readSalesforceFailure(error);
  const normalized = failure.code?.toLocaleUpperCase('en-US');
  const denied = normalized !== undefined
    && LIMITS_DENIAL_CODES.some((code) => code === normalized);
  if (!denied) {
    return new ContextRuntimeError(
      'MCP_LIMITS_READ_FAILED',
      'Salesforce could not return the org\'s governor limits for this request.',
      {
        cause: error,
        ...(failure.code === null ? {} : { salesforceErrorCode: failure.code }),
        suggestion: 'Retry once; if it fails again the diagnostic identity or the org\'s API access needs to be checked. '
          + 'This affects quota visibility only: other Salesforce Tools are unaffected.',
      },
    );
  }
  return new ContextRuntimeError(
    'MCP_LIMITS_ACCESS_DENIED',
    'Salesforce refused to report the org\'s governor limits to this request\'s identity.',
    {
      cause: error,
      ...(failure.code === null ? {} : { salesforceErrorCode: failure.code }),
      suggestion: 'This org refuses the limits resource even to the server-owned DIAGNOSTIC identity this Tool runs on, so '
        + 'the refusal is an org-wide configuration fact rather than a missing permission on a business user. Granting a '
        + 'business integration identity Setup visibility is not the remedy and widens an identity that is deliberately '
        + 'kept out of org configuration. Read the allowances from Salesforce Setup instead of retrying, and check the '
        + 'diagnostic identity\'s own access. This affects quota visibility only: other Salesforce Tools are unaffected.',
    },
  );
}
