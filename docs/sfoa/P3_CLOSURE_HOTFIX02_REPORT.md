# P3-Closure HOTFIX02 Final Report

Baseline: `P3-BL-1.3`

Branch: `feature/p3-generic-dml-allowlist`

Starting commit: `4abbd92` (`fix: classify ambiguous DML outcomes`)

Date: 2026-08-23

Scope: Request-Level Mutation Outcome Safety only

## Executive Result

`P3-CLOSURE HOTFIX02 = PASS`

The outer HTTP request deadline can no longer return ordinary `MCP_REQUEST_TIMEOUT` after this request has entered the Salesforce CREATE/UPDATE execution boundary. One minimal state object belongs to each HTTP POST. The DML executor marks that state immediately before the public SDK mutation call. A later outer timeout returns `MCP_DML_OUTCOME_UNKNOWN`, HTTP 504, and explicit no-retry guidance.

Timeout before mutation start and read-only request timeout remain `MCP_REQUEST_TIMEOUT`. This preserves accurate local failure semantics without weakening the conservative mutation boundary.

The Closure adds no idempotency framework, persistence, retry, replay, prohibited mutation, Salesforce/JSforce patch, or P4 capability.

## Cross-Layer Finding

HOTFIX01 correctly classified DML Tool timeout and unstructured post-dispatch failure. The previous defaults nevertheless allowed the complete HTTP deadline to expire first:

```text
old request default = 60000 ms
old Tool default    = 120000 ms
```

Because the outer request layer did not know whether a mutation had started, it could return `MCP_REQUEST_TIMEOUT` after Salesforce dispatch. That semantic could be misread as a safe failure and encourage a duplicate CREATE/UPDATE.

HOTFIX02 closes that separate request-lifecycle path. Timeout ordering is also corrected, but ordering is only an operational guard; request-local mutation awareness is the actual safety boundary.

## Architecture

```text
LLM / MCP Client
  -> Authenticated HTTP MCP Request
  -> P1 platformUserId Identity Route
  -> request-scoped Salesforce Connection
  -> P3 schema + Object x Operation gate
  -> request-local MutationRequestState
  -> Generic CREATE / UPDATE
  -> official Salesforce SDK
  -> Salesforce
```

The concrete start boundary is:

```text
input validation
  -> Object x Operation allowlist
  -> request-scoped Connection
  -> connection.sobject(objectApiName)
  -> onMutationStarted(CREATE | UPDATE)
  -> sobject.create(...) | sobject.update(...)
```

`MutationRequestState` has only the first started operation. One instance is created inside each HTTP POST. It is not global, persisted, shared, or reused. The Provider depends only on this small interface:

```ts
interface MutationExecutionObserver {
  onMutationStarted(operation: 'CREATE' | 'UPDATE'): void;
}
```

The Provider does not depend on the HTTP server. No SETTLED ledger, replay state, request key, database, or state-machine framework was introduced.

### Boundaries that do not mark mutation start

- Bearer and Header validation;
- request body parsing;
- identity resolution failure;
- request Connection failure;
- unknown or disabled Tool;
- read-only Tool execution;
- DML schema rejection;
- Object-by-Operation denial.

Only `create_record` marks CREATE, and only `update_record` marks UPDATE.

## Timeout Hierarchy

```text
Default request timeout:                 180000 ms
Default Tool timeout:                    120000 ms
request > tool:                          YES
Invalid relationship startup blocked:   YES
Invalid relationship error:             MCP_RUNTIME_CONFIGURATION_INVALID
```

Both configuration loading and direct programmatic Host startup call the same invariant. The Host fails closed when:

```text
MCP_REQUEST_TIMEOUT_MS <= MCP_TOOL_TIMEOUT_MS
```

`.env.example`, the Host README, the client contract, and runtime architecture use the same defaults. No fixed margin is claimed as proof that an outer timeout can never win; setup latency and operator timing can still vary, so the request-local state remains authoritative.

## Mutation Outcome Semantics

```text
DML Tool timeout
-> MCP_DML_OUTCOME_UNKNOWN

DML outer Request timeout after mutation start
-> MCP_DML_OUTCOME_UNKNOWN

Request timeout before mutation start
-> MCP_REQUEST_TIMEOUT

Read Tool request timeout
-> MCP_REQUEST_TIMEOUT
```

Explicit Salesforce rejection remains unchanged:

```text
Reliable Salesforce rejection evidence
-> MCP_SALESFORCE_DML_FAILED
```

Verified structured rejection examples are `REQUIRED_FIELD_MISSING`, `FIELD_CUSTOM_VALIDATION_EXCEPTION`, and `INSUFFICIENT_ACCESS_OR_READONLY`. Their bounded safe Salesforce code, message, and fields remain available; SFoA does not reinterpret them as its own authorization or validation policy.

The UNKNOWN message states:

```text
Outcome is unknown.
The runtime cannot determine whether Salesforce committed the mutation.
Do not automatically retry.
Salesforce server-side cancellation is not guaranteed.
Use a read-only Tool to verify Salesforce state before attempting another mutation.
If verification is not possible, inform the user that the outcome remains unknown.
```

## Request-Level JSON-RPC Contract

The outer timeout stays at the transport layer and does not manufacture a Tool `structuredContent` result. Its actual bounded wire contract is:

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32001,
    "message": "[MCP_DML_OUTCOME_UNKNOWN] Outcome is unknown. ...",
    "data": {
      "errorCode": "MCP_DML_OUTCOME_UNKNOWN",
      "correlationId": "bounded-correlation-id",
      "retryable": false
    }
  },
  "id": null
}
```

HTTP status is 504. The stable machine semantic is `error.data.errorCode`; the message also contains the same code for clients that normalize only JSON-RPC messages. The correlation ID is only a safe log-correlation token. It is not an idempotency key and cannot query Salesforce commit state.

Tool-level HOTFIX01 results retain their compact structured form:

```json
{
  "success": false,
  "errorCode": "MCP_DML_OUTCOME_UNKNOWN",
  "message": "Outcome is unknown. ..."
}
```

## Client Disconnect

After a client closes its socket, the Host cannot deliver a response over that connection. This is an unavoidable residual transport condition, not a cancellation signal.

When the small existing composition seam can observe that disconnect after mutation start, the Host records:

```text
outcome = UNKNOWN
mutationStarted = true
terminationLayer = TRANSPORT
```

It does not replay, retry, or claim Salesforce cancellation. A deterministic socket-close fixture proves one CREATE invocation and one late completion. Clients must treat a post-dispatch transport interruption as unknown and perform an independent read before another mutation.

## Retry Audit

```text
Provider automatic CREATE retry:        NO
Provider automatic UPDATE retry:        NO
Host automatic CREATE retry:            NO
Host automatic UPDATE retry:            NO
Pinned JSforce default POST retry:       NO
Pinned JSforce default PATCH retry:      NO
```

The actual installed runtime was inspected and regression-tested:

```text
@salesforce/core                 8.29.0
@jsforce/jsforce-node            3.10.13
default retry methods            GET, PUT, HEAD, OPTIONS, DELETE
CREATE transport method          POST
UPDATE transport method          PATCH
```

The source-contract test resolves the installed package and reads its pinned `lib/request.js` default. POST and PATCH are absent. No latest-version documentation or unpinned source was substituted for this evidence.

Deterministic Provider/Facade/Host fixtures separately prove:

```text
CREATE transport retry count = 0
UPDATE transport retry count = 0
```

JSforce was not patched, forked, wrapped with retry interception, or copied.

## Tool and Identity Contract

`create_record` and `update_record` retain `idempotentHint:false`. Their descriptions now cover Tool timeout, request timeout, and transport interruption: do not automatically repeat the mutation, read Salesforce state first when possible, and tell the user when verification cannot determine the outcome.

The accepted identity path is unchanged:

```text
Authorization + X-Platform-User-Id
  -> IdentityResolver
  -> Salesforce route
  -> fresh request-scoped Connection
  -> DML gate
  -> Salesforce
```

Tool input still cannot select platform user, Salesforce username/alias, token, instance URL, directory, API version, operation, or REST path. Salesforce remains responsible for CRUD, FLS, sharing, required fields, validation, lookup filters, Flow, and Trigger.

## Safe Logging

UNKNOWN logs retain only bounded operational context:

```text
correlationId
toolName
operation
platformUserId
salesforceUsername
errorCode
durationMs
outcome = UNKNOWN
mutationStarted = true
terminationLayer = TOOL | REQUEST | TRANSPORT
```

Client output and logs do not include JWTs, access tokens, client secrets, private keys, stacks, raw causes, or Connection objects. This is a narrow extension of the existing logger, not a P5 audit framework.

## Architecture Boundary

```text
Database added:                         NO
Redis added:                            NO
Idempotency framework added:            NO
Mutation ledger added:                  NO
Retry queue added:                      NO
Automatic retry added:                  NO
Request replay added:                   NO
UPSERT added:                           NO
DELETE added:                           NO
Bulk DML added:                         NO
Official Salesforce TypeScript changed: 0
Official Tool copied/reimplemented:     NO
JSforce patched:                        NO
Root package.json changed:              NO
yarn.lock changed:                      NO
P4 capability added:                    NO
```

P3 remains a thin enterprise mutation gate. No DIAGNOSTIC role, Describe preflight, layout/UI API, Lightning/FlexiPage, record-type, required/default/editable-field context, picklist engine, or diagnosis capability was introduced.

## Tests

Only `PASS`, `FAIL`, `NOT TESTED`, and `KNOWN UPSTREAM DEBT` are used in the Result column.

| Gate | Result | Actual evidence |
| --- | --- | --- |
| Default timeout hierarchy | PASS | Request 180000 ms; Tool 120000 ms; example parity asserted |
| Invalid timeout hierarchy | PASS | Equal/lower request deadline blocked by config loader and direct startup |
| Read-only request timeout | PASS | HTTP 504 `MCP_REQUEST_TIMEOUT` |
| CREATE outer timeout after start | PASS | HTTP 504 JSON-RPC `MCP_DML_OUTCOME_UNKNOWN`; `retryable:false` |
| UPDATE outer timeout after start | PASS | HTTP 504 JSON-RPC `MCP_DML_OUTCOME_UNKNOWN`; `retryable:false` |
| Late CREATE completion | PASS | UNKNOWN first; invocation 1; completion 1; automatic retry 0 |
| Late UPDATE completion | PASS | UNKNOWN first; invocation 1; completion 1; automatic retry 0 |
| Timeout before mutation start | PASS | `MCP_REQUEST_TIMEOUT`; mutation invocation 0 |
| Allowlist denial | PASS | `MCP_DML_OBJECT_NOT_ALLOWED`; observer not marked; invocation 0 |
| Unknown/off-limits Tool | PASS | `delete_record` and `deploy_metadata` do not mark mutation start; invocation 0 |
| Input validation | PASS | `MCP_DML_INPUT_INVALID`; observer not marked |
| DML Tool-timeout regression | PASS | CREATE/UPDATE remain `MCP_DML_OUTCOME_UNKNOWN` |
| Explicit Salesforce rejection regression | PASS | Required/validation/authorization codes remain `MCP_SALESFORCE_DML_FAILED` |
| Network/unstructured SDK rejection | PASS | `MCP_DML_OUTCOME_UNKNOWN`; invocation 1; retry 0 |
| Client disconnect | PASS | UNKNOWN transport log; CREATE invocation/completion 1; replay 0 |
| Pinned JSforce retry audit | PASS | 3.10.13 default retry excludes POST/PATCH |
| P3 Provider tests | PASS | 17/17, 0 failed |
| P3 Host tests | PASS | 18/18, 0 failed |
| P3 live Salesforce | PASS | CREATE/UPDATE, required/validation/authz, A/B isolation, reuse 0, cleanup 2/2 |
| P2 tests | PASS | 18/18, 0 failed |
| P2 live A/B/load | PASS | 50 requests; mismatch/leak/workspace leak/cleanup/reuse/errors all 0 |
| P1 tests/live | PASS | 22/22; two users; 20-request isolation; cleanup PASS |
| P0 tests/live | PASS | 9/9; fresh JWT, identity, direct/official SOQL, metadata, CWD PASS |
| Streamable HTTP | PASS | P0 POC 1/1 and P2/P3 SDK client paths |
| Upstream compatibility | PASS | Provider API 0.6.0; dx-core 0.10.0; nine GA Tools; zero drift |
| Original Salesforce stdio | PASS | initialize, five Tools, official `get_username` call |
| MCP Inspector | PASS | Project-local 0.15.0 initialize/list/call for A and B |
| Root build | PASS | Git Bash all-workspace build, 130.07 s |
| Root tests | PASS | All workspaces, 519.71 s |
| SFoA changed-code lint | PASS | All five SFoA TypeScript workspaces exited 0 |
| Repository lint | KNOWN UPSTREAM DEBT | Same 47 official code-analyzer errors, 0 warnings; no SFoA path |

The real Salesforce Gate did not manufacture a network disconnect during a live mutation. Ambiguous commit timing is covered by deterministic integration fixtures, while the live Gate validates successful CREATE/UPDATE, native rejection boundaries, identity isolation, and exact cleanup.

One development run of the full P3 Host suite returned 16/17 because the UPDATE fixture's narrow timing window expired before dispatch and therefore correctly produced `MCP_REQUEST_TIMEOUT`. The fixture was widened to deterministically establish mutation start before the outer deadline. The final full suite passed 17/17; production classification was not weakened to satisfy the test.

## Upstream Diff

```text
Official Salesforce TypeScript changed: 0
Official Tool copied/reimplemented:      NO
JSforce patched:                         NO
Root package.json changed:               NO
yarn.lock changed:                       NO
New database dependency:                 NO
New Redis dependency:                    NO
```

All production changes remain in SFoA-owned Provider, identity logging contract, and Host composition paths. ADR-0008's public SDK decision and P1/P2 identity architecture remain unchanged, so no accepted ADR is superseded.

## Final Decision

`P3-CLOSURE HOTFIX02 = PASS`

Recommended maintainer actions after reviewing this Closure:

```text
P3 = FINAL ACCEPTED
merge feature/p3-generic-dml-allowlist -> main
authorize P4
```

These are recommendations only. This Closure does not merge the branch, claim maintainer acceptance, or start P4.
