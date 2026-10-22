# Development and review

## Change workflow

1. Clarify the behavior and affected authority boundary.
2. Inspect current code, tests, nearest package docs, and executable contracts.
3. Apply upstream-first reuse and identify the smallest cohesive change.
4. Preserve strict TypeScript, `unknown` validation, async/await, and explicit Promise return types on I/O.
5. Add unit/contract/error/isolation coverage proportional to risk.
6. Run package lint/test/build, MySQL integration when persistence changes, MCP protocol/live gates when runtime changes, and Admin browser gates when UI/API changes.
7. Check Audit impact and whether durable Skill/project documentation changed.

Reasonable refactoring is allowed when evidence justifies it. Do not preserve obsolete architecture merely because this Skill describes it; update the accepted baseline/ADR when the decision changes.

## MCP review points

- Stable action-oriented `snake_case` name, strict bounded Zod input, useful output schema/structured content, concise text compatibility, all applicable annotations.
- Tool-level actionable safe failures; protocol errors only for protocol failures.
- Registration-time visibility and authorization remain separate from annotations.
- List/query bounds, pagination/cursor, `has_more`, and explicit truncation.
- Stdio stdout remains protocol-only; HTTP auth/identity occurs before Salesforce scope creation.
- Keep Salesforce access behind the request-owned `SalesforceConnectionProvider`. Route/context/Control Plane/workspace-directory composition must not call `getConnection()`; only verified Salesforce-dependent execution paths may obtain it. Do not add Tool-name skip lists or cross-request caches.

## Data and UI review points

- MySQL migrations are forward-only and old migrations are never edited after release.
- Repository/API/UI share current contracts; optimistic row versions and transaction semantics remain explicit.
- Audit list/detail never load `safe_payload` eagerly.
- React changes cover loading, empty, error, narrow layout, URL/query state, and Chinese-first operator labels without obscuring technical codes.

## CRM embedded chat review points

- Apex token verification pins the certificate/issuer/audience/org; never fetch a key from the token or a URL and never negotiate the algorithm.
- The `jti` consumption is a database primary-key insert, not a read-then-write; browser chat tokens are stored only as SHA-256.
- `(orgId,userId) → platformUserId` is explicit, and the route's `salesforce_username` must equal the Apex `username`; no nickname/first-match/admin fallback.
- Conversation, history, run events and stop must check `orgId + userId` ownership; cross-user access is 404.
- A duplicate `clientMessageId` must not re-dispatch; unknown outcomes are `UNKNOWN` and never automatically retried.
- `SenderId` is set only by the CRM plugin's credentialed ingress; message text/tool arguments/model output never choose identity.
- Keep Salesforce credentials and the user-facing turn path free of the Gateway token. The one exception is the history-only `CRM_GATEWAY_HISTORY_TOKEN` behind the `auth:"gateway"` + trusted-operator route; never use it as a user identity or for arbitrary Gateway methods.
- Run `yarn workspace @sfoa/crm-gateway test` and `test:mysql` when persistence changes; real OpenClaw/Salesforce/browser gates remain separate evidence layers.

Avoid new dependencies or abstractions without a demonstrated repeated use. Do not refactor official Salesforce code for style.
