# P3-Closure HOTFIX01 Final Report

Baseline: `P3-BL-1.2`

Branch: `feature/p3-generic-dml-allowlist`

Date: 2026-08-23

Scope: Ambiguous Mutation Outcome Safety only

## Executive Result

`P3-CLOSURE HOTFIX01 = PASS`

The Closure fixes outcome semantics without attempting absolute idempotence. SFoA no longer claims that Salesforce rejected a CREATE/UPDATE when the runtime has only a timeout, transport interruption, or unstructured SDK exception after entering the mutation execution boundary.

P3 architecture, identity routing, Object-by-Operation governance, Salesforce authorization ownership, Tool names, and SDK execution path remain unchanged. P4 was not started.

## Scope Boundary

Implemented:

- one stable `MCP_DML_OUTCOME_UNKNOWN` error code;
- conservative structured Salesforce rejection detection;
- DML-specific Host Tool-timeout mapping;
- structured UNKNOWN Tool results with actionable no-retry guidance;
- non-idempotence/read-before-retry Tool descriptions;
- deterministic timeout, late-completion, transport, no-retry, logging, and rejection-regression tests.

Not implemented:

- database or mutation ledger;
- Redis;
- idempotency table/key/framework;
- retry queue or automatic retry;
- External ID or UPSERT;
- DELETE, UNDELETE, MERGE, or Bulk DML;
- request replay or distributed transaction;
- Connection or token cache;
- Describe, Page Layout, UI API, Lightning Page, Dynamic Forms, record-type, picklist, diagnosis, or other P4 capability.

## Mutation Semantics

```text
Explicit Salesforce rejection
-> MCP_SALESFORCE_DML_FAILED

Ambiguous mutation outcome
-> MCP_DML_OUTCOME_UNKNOWN
```

### Explicit Salesforce rejection

`MCP_SALESFORCE_DML_FAILED` is returned only when the runtime has affirmative rejection evidence:

1. the official SDK returns `SaveResult.success === false`; or
2. a thrown mutation exception retains reliable structured Salesforce `errorCode`, `message`, and `fields` evidence.

Examples verified as deterministic rejections:

```text
REQUIRED_FIELD_MISSING
FIELD_CUSTOM_VALIDATION_EXCEPTION
INSUFFICIENT_ACCESS_OR_READONLY
```

Their bounded safe Salesforce code, message, and fields remain available in `salesforceErrors`. SFoA does not reinterpret them as its own policy.

### Ambiguous mutation outcome

`MCP_DML_OUTCOME_UNKNOWN` is returned when the runtime cannot prove rejection after the mutation reaches the execution boundary, including:

- DML Tool timeout;
- transport/network interruption;
- SDK Promise rejection without reliable structured Salesforce rejection evidence.

The stable message states:

```text
Outcome is unknown.
The runtime cannot determine whether Salesforce committed the mutation.
Do not automatically retry.
Salesforce server-side cancellation is not guaranteed.
Use a read-only Tool to verify Salesforce state before another mutation.
Inform the user when the state cannot be confirmed.
```

No exception class name, missing HTTP status, or message substring is used to guess rejection. When evidence is insufficient, UNKNOWN is preferred to a false FAILED claim.

## Pinned SDK Error-Shape Audit

The installed runtime was inspected directly before implementation:

```text
@salesforce/core             8.29.0
@jsforce/jsforce-node        3.10.13
```

The pinned JSforce implementation shows:

- single-record CREATE sends one REST `POST` and returns the response as `SaveResult`;
- single-record UPDATE sends one REST `PATCH` and maps HTTP 204 to a successful `SaveResult`;
- HTTP error responses are wrapped with `errorCode`, while the parsed Salesforce body is retained under `HttpApiError.data`;
- a transport-layer rejection is rethrown without manufacturing Salesforce rejection evidence.

SFoA reads only this public runtime error structure. It does not patch, copy, or depend on a private Salesforce Tool implementation.

## Host Tool Timeout

`DmlToolFacade` still uses the common bounded Promise race, but a DML `MCP_TOOL_TIMEOUT` is converted before returning to the client:

```text
internal timeout signal: MCP_TOOL_TIMEOUT
client DML Tool result:  MCP_DML_OUTCOME_UNKNOWN
```

The underlying mutation Promise is neither cancelled nor replayed. A deterministic fixture proved that CREATE can resolve successfully after the Host already returned UNKNOWN and that the invocation count remains exactly one.

Official read Tool timeout behavior remains unchanged. This Closure did not broaden or refactor the P2 timeout framework.

## Structured Tool Result

The existing compact `dmlOutputSchema` already supports the new code; no new output model was needed:

```json
{
  "success": false,
  "errorCode": "MCP_DML_OUTCOME_UNKNOWN",
  "message": "Outcome is unknown. ... Do not automatically retry. ..."
}
```

`correlationId` was not added to client output. It remains a log-correlation value only; it is not an idempotency key and cannot query Salesforce commit state.

## Retry

```text
Automatic CREATE retry: NO
Automatic UPDATE retry: NO
```

Provider, facade, and Host contain no retry loop. Timeout/network fixtures assert exactly one mutation invocation. No retry queue, replay, or background status tracker exists.

Tool descriptions now tell the Agent that CREATE and UPDATE are non-idempotent, prohibit automatic retry after an unknown result, require an independent read when possible, and require user disclosure when state cannot be confirmed.

Annotations remain:

```json
{
  "readOnlyHint": false,
  "destructiveHint": true,
  "idempotentHint": false,
  "openWorldHint": true
}
```

## Logging and Secret Boundary

UNKNOWN timeout logs retain:

```text
correlationId
toolName
platformUserId
salesforceUsername
errorCode = MCP_DML_OUTCOME_UNKNOWN
```

Client results do not expose:

- JWT or access/refresh token;
- client secret or private key;
- stack or raw cause;
- request-scoped Connection or authorization record.

## Architecture

The execution path remains:

```text
LLM
  -> create_record / update_record
  -> Object x Operation Allowlist
  -> authenticated request-scoped Connection
  -> official Salesforce SDK single-record DML
  -> Salesforce native authorization and automation
```

Required architecture answers:

```text
Database added: NO
Redis added: NO
Idempotency framework added: NO
UPSERT added: NO
DELETE added: NO
Official Salesforce TypeScript changed: 0
```

Also unchanged:

```text
Root package.json changed: NO
yarn.lock changed: NO
Official Tool copied/reimplemented: NO
Connection cache added: NO
Token cache added: NO
P4 capability added: NO
```

## Tests

Only `PASS`, `FAIL`, `NOT TESTED`, and `KNOWN UPSTREAM DEBT` are used in the Result column.

| Gate | Result | Actual evidence |
| --- | --- | --- |
| Explicit `REQUIRED_FIELD_MISSING` | PASS | `MCP_SALESFORCE_DML_FAILED`, safe details retained |
| Explicit `FIELD_CUSTOM_VALIDATION_EXCEPTION` | PASS | `MCP_SALESFORCE_DML_FAILED`, safe details retained |
| Authorization rejection regression | PASS | `INSUFFICIENT_ACCESS_OR_READONLY` retained |
| Transport/network failure | PASS | `MCP_DML_OUTCOME_UNKNOWN`, not FAILED |
| Unstructured SDK rejection | PASS | `MCP_DML_OUTCOME_UNKNOWN`, no class/message guessing |
| CREATE Tool timeout | PASS | Structured UNKNOWN plus no-retry guidance |
| UPDATE Tool timeout | PASS | Structured UNKNOWN plus no-retry guidance |
| Late CREATE completion | PASS | Timeout returned UNKNOWN; later success; one invocation |
| Automatic CREATE retry | PASS | None; invocation count one |
| Automatic UPDATE retry | PASS | None; invocation count one |
| Timeout log context | PASS | correlation/Tool/platform/Salesforce identity asserted |
| Tool descriptions and annotations | PASS | Actual list contract includes safety guidance; `idempotentHint:false` |
| P3 Provider tests | PASS | 16/16, 0 failed |
| P3 Host tests | PASS | 10/10, 0 failed |
| P3 Provider/Host strict lint | PASS | `tsc --noEmit` exited 0 |
| P3 live Salesforce | PASS | CREATE/UPDATE, required/validation/authz failures, identity, cleanup 2/2 |
| P2 tests | PASS | 18/18, 0 failed |
| P2 live A/B/load | PASS | 50 requests; mismatch/leak/workspace leak/cleanup/reuse/error all 0 |
| P1 tests/live | PASS | 22/22; two users; 20 requests; metadata/CWD/workspace cleanup |
| P0 tests/live | PASS | 9/9; JWT/identity/direct+official SOQL/metadata/CWD |
| Streamable HTTP | PASS | P0 1/1 plus P3/P2 official SDK Client initialize/list/call |
| Upstream compatibility | PASS | Provider API 0.6.0; dx-core 0.10.0; nine GA Tools; zero drift |
| Original Salesforce stdio | PASS | initialize, five-Tool list, official `get_username` |
| MCP Inspector | PASS | Project-local 0.15.0 initialize/list/call for both users |
| Root build | PASS | Git Bash all-workspace build, 70.86 s |
| Root tests | PASS | All workspaces, 284.67 s |
| SFoA changed-code lint | PASS | All five SFoA TypeScript workspaces exited 0 |
| Repository lint | KNOWN UPSTREAM DEBT | Same 47 official code-analyzer errors, 0 warnings; no SFoA path |

The first P2 live invocation in this Closure stopped at configuration because the new shell did not contain `MCP_CLIENT_TOKEN`. A command-local, non-persisted Host validation token was supplied and the complete rerun passed. No Salesforce assertion from the stopped invocation is counted as evidence.

Live ambiguous-commit behavior was not manufactured by disconnecting a real Salesforce request. The required UNKNOWN branch is covered by deterministic mock/integration fixtures; the real Gate continued to verify successful CREATE/UPDATE, native failures, and exact cleanup.

## Upstream Diff

```text
Official Salesforce TypeScript changed: 0
Official Tool copied/reimplemented: NO
Root package.json changed: NO
yarn.lock changed: NO
New database dependency: NO
New Redis dependency: NO
```

All production changes are in SFoA-owned Provider and Host paths. ADR-0008's official SDK selection and request-scoped identity architecture remain unchanged, so no ADR is superseded.

## Final Decision

`P3-CLOSURE HOTFIX01 = PASS`

Recommended maintainer actions after reviewing this Closure:

```text
P3 = FINAL ACCEPTED
merge feature/p3-generic-dml-allowlist -> main
authorize P4
```

These actions are recommendations only. This Closure does not merge the branch, mark maintainer acceptance on the maintainer's behalf, or start P4.
