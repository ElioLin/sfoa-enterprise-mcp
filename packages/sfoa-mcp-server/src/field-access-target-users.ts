/**
 * The `targetUserId` boundary: which Salesforce users this deployment lets a caller ask about.
 *
 * `explain_field_access` answers "why can this person see or edit that field", and answering it about a
 * *named* user is what makes the Tool useful — an administrator diagnosing a complaint cannot do it from
 * their own account, because the identity that runs this Tool is the server-owned DIAGNOSTIC account and
 * its own permissions are not the reporter's. But the same capability, unbounded, is account-access
 * reconnaissance: a Tool that accepted any user Id would let a caller enumerate an org's users and read
 * back each one's permission sets. So the set is bounded, and this module is the bound.
 *
 * **The set is the identity-route table.** The users this deployment has configured as platform identity
 * routes are exactly the users the platform already knows how to act as, and they are the users an
 * operator here is entitled to ask about — because they are the ones whose access the deployment was
 * built to explain. `IdentityRouteRepository.listActiveSalesforceUsernames()` is the source; it is an
 * existing read-only control-plane query, not something added for this Tool.
 *
 * **Why this is host-side.** Routes are the host's model. The provider package knows the Tool contract
 * and nothing about a MySQL identity-route table, so a provider-side implementation would be handed a
 * Connection and no way to tell which users are configured — leaving it to either accept any Id or
 * answer about nobody. The host injects the set instead, which is why `FieldAccessExplainer` lives on
 * this side of the boundary (see the contract's doc comment).
 *
 * **Why the bound is enforced inside a query rather than after one.** The subject is resolved with
 * `WHERE Id = :id AND Username IN (:configured)`, so an Id that is not a configured route and an Id that
 * does not exist both produce an empty result set. The Tool therefore never holds a row for a
 * non-configured user, and the refusal it returns is *structurally* identical in both cases rather than
 * identical by convention — there is no branch that could drift.
 */

import { ContextRuntimeError, type ContextErrorCode } from '@sfoa/mcp-provider-sfoa-context';

/**
 * The identity-route facts the boundary needs, as the host supplies them per request.
 *
 * `selfSalesforceUsername` is the requesting user's own route for this request, or `null` when the
 * request arrived on a runtime with no route behind it. `configuredSalesforceUsernames` is the
 * deployment's enabled routes.
 */
export type FieldAccessTargetUsers = Readonly<{
  selfSalesforceUsername: string | null;
  configuredSalesforceUsernames: readonly string[];
}>;

/**
 * The same facts on the environment-configured runtime, whose route table is its identity config.
 *
 * Nothing here is a second derivation of the routes: the caller passes the list
 * `buildIdentityRoutes()` built for the runtime, so the set this Tool bounds `targetUserId` to is
 * literally the set the runtime resolves calls through. Deriving the usernames from
 * `primaryUsername`/`secondaryUsername` here instead would be a copy free to drift from what the
 * runtime actually routes.
 *
 * Only `USER` routes are in that list by construction — the diagnostic identity is a separate config
 * key and is not one of them — which is the right set for this Tool twice over: it explains the access
 * of the users the deployment acts as, and the server's own service account is not one of them.
 */
export function envFieldAccessTargetUsers(
  routes: readonly Readonly<{ platformUserId: string; salesforceUsername: string }>[],
  platformUserId: string,
): FieldAccessTargetUsers {
  const self = routes.find((route) => route.platformUserId === platformUserId);
  return Object.freeze({
    selfSalesforceUsername: self?.salesforceUsername ?? null,
    configuredSalesforceUsernames: Object.freeze(routes.map((route) => route.salesforceUsername)),
  });
}

/**
 * How many configured route usernames may be embedded in the subject query.
 *
 * A bound exists because the `IN` list goes into the request; above it the Tool refuses rather than
 * silently narrowing to the first N routes, since a narrowed set would make some configured users
 * unaskable for no reason the caller could see. 500 is far above any deployment this platform serves and
 * well inside what a SOQL `IN` list and a request URL carry.
 */
export const FIELD_ACCESS_MAX_ROUTE_USERNAMES = 500;

export type FieldAccessSubjectSelection = Readonly<{
  /** The subject's Salesforce User Id, or `null` when the subject is the requesting user, which the query resolves. */
  targetUserId: string | null;
  /** True when the caller named `targetUserId` rather than being explained their own access. */
  targetNamed: boolean;
  /** The username the subject query is scoped to for a self-subject; `null` for a named target. */
  selfSalesforceUsername: string | null;
  /** The route usernames the subject query is allowed to match. */
  allowedUsernames: readonly string[];
}>;

/**
 * The subject rule, as a pure function so its refusals are unit-testable without a Salesforce org.
 *
 * `targetUserId` omitted means "explain the requesting user's own access", and that requires knowing
 * which Salesforce user the requester is — which is the *business* identity route, not the DIAGNOSTIC
 * connection this Tool runs on. On the MySQL runtime that route is resolved for every request; on the
 * environment-configured runtime there is no route table and therefore no answer, and the Tool refuses
 * rather than reporting every field as `INDETERMINATE`. The refusal is the honest outcome: a conclusion
 * is a claim *about a user*, and a table of gaps would look like an answer without being one.
 */
export function selectFieldAccessSubject(
  targetUserId: string | undefined,
  users: FieldAccessTargetUsers,
): FieldAccessSubjectSelection {
  if (users.configuredSalesforceUsernames.length > FIELD_ACCESS_MAX_ROUTE_USERNAMES) {
    throw new ContextRuntimeError(
      'MCP_DIAGNOSTIC_PREREQUISITE_MISSING',
      'This deployment configures more Salesforce identity routes than this Tool can scope a subject query to.',
      {
        prerequisite: `identity routes > ${FIELD_ACCESS_MAX_ROUTE_USERNAMES}`,
        suggestion: `The \`targetUserId\` boundary is enforced by scoping the subject query to the deployment's enabled identity `
          + `routes, and this deployment has more than ${FIELD_ACCESS_MAX_ROUTE_USERNAMES} of them. The boundary is deliberately not `
          + 'narrowed to the first N, because that would silently make some configured users unaskable. Raise this Tool\'s limit '
          + 'together with the query strategy, or disable the Tool on this deployment.',
      },
    );
  }
  const allowedUsernames = [...new Set(users.configuredSalesforceUsernames)].sort();
  if (targetUserId !== undefined) {
    if (allowedUsernames.length === 0) {
      throw targetNotAllowed('This runtime has no configured Salesforce identity routes to scope a target user to.');
    }
    return Object.freeze({
      targetUserId,
      targetNamed: true,
      selfSalesforceUsername: null,
      allowedUsernames: Object.freeze(allowedUsernames),
    });
  }
  const self = users.selfSalesforceUsername;
  if (self === null || self.trim().length === 0) {
    throw new ContextRuntimeError(
      'MCP_DIAGNOSTIC_PREREQUISITE_MISSING',
      'This request has no Salesforce identity route of its own, so there is no user whose access could be explained.',
      {
        prerequisite: 'requesting-user route unavailable',
        suggestion: 'Omitting targetUserId explains the requesting user\'s own access, which requires the platform to know which '
          + 'Salesforce user that is. This runtime resolved no business identity route for the request — either it is configured '
          + 'from the environment rather than from the identity-route table, or the calling user has no enabled route. Name an '
          + 'explicit targetUserId, or run on a runtime with identity routes configured.',
      },
    );
  }
  return Object.freeze({
    targetUserId: null,
    targetNamed: false,
    selfSalesforceUsername: self,
    allowedUsernames: Object.freeze(allowedUsernames),
  });
}

/**
 * The one refusal for "this Id is not a user you may ask about".
 *
 * Deliberately indistinguishable from "no such user": the same code, the same wording, for an Id that
 * exists but is not configured and for an Id that exists nowhere. Telling the two apart is what would
 * turn the Tool into an account-existence oracle.
 */
export function targetNotAllowed(detail?: string): ContextRuntimeError {
  return new ContextRuntimeError(
    'MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED' satisfies ContextErrorCode,
    'The requested user is not one this deployment explains access for.'
      + (detail === undefined ? '' : ` ${detail}`),
    {
      // No `prerequisite`: nothing in ADR-0029 §2's deployment list is missing. This is the Tool's own
      // boundary answering a request that is outside it, which is a decision and not a gap.
      suggestion: 'targetUserId must be a Salesforce user this deployment has configured as an enabled identity route. '
        + 'Omit it to explain your own access instead. This refusal is the same whether or not the Id names a user, so it '
        + 'cannot be used to test which Ids exist.',
    },
  );
}
