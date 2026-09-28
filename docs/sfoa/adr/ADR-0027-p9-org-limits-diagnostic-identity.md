# ADR-0027: `get_org_limits` runs on the server-owned DIAGNOSTIC identity

- Status: Accepted for P9
- Date: 2026-09-28
- Supersedes: ADR-0026 only where it fixed `get_org_limits` to `READ`/`USER` in the data provider, where it named the available remedies, and where it fixed the live gate's reading order and its inference about what the org refuses. `search_records` is untouched by this ADR.
- Extends: ADR-0026 quotas and SOSL search, ADR-0009 the server-owned DIAGNOSTIC request scope, ADR-0024 the P9 data provider over the official SDK, ADR-0005 remote Tool governance, ADR-0025 bounded completeness and the hint rule

## Context

ADR-0026 shipped `get_org_limits` as `READ`/`USER` in `@sfoa/mcp-provider-sfoa-data`, on the
assumption that a business integration identity could read `Connection.limits()`. The live probe
disproved that for every identity this deployment can route: the resource answers
`API_DISABLED_FOR_ORG` for all four, at every API version from v50.0 to v68.0. The Tool was
therefore correct but unreadable, its live gate could only ever be `NOT TESTED`, and ADR-0026
named two ways out — grant a routed identity `View Setup and Configuration`, or route one that
already has it.

This ADR takes neither. Both of them widen a **business** identity into org configuration, and
ADR-0009's boundary exists precisely to avoid that: the DIAGNOSTIC scope is server-owned,
read-only, request-scoped, and **structurally unavailable to business query/DML Tools**
(ADR-0009 §Decision). Its reason for existing is the class of reads a business integration
identity cannot be granted — the Tooling and Metadata APIs — and the separation is the point of
the role rather than an implementation detail.

So the question this ADR settles is not "who can we widen until the read works" but **which
class of read `limits()` belongs to**. It answers with org-level quota counters and no business
records: no object, no field, no row, no record id. That is the same class as the two Tooling
and Metadata Tools the diagnostic identity already serves — and it is emphatically *not* the
class the diagnostic identity is forbidden (it may not be used to read business data).

A consequence worth stating plainly, because it is the reason this move is more than a role
flag: **this is the first time "can a diagnostic administrator read the limits resource?" is
answerable at all.** ADR-0026 could only defer that question to "one administrator request to
`GET /services/data/v68.0/limits`". After this ADR the Tool *is* that request, run on that
identity, under the audit pipeline — and the live gate now measures the answer instead of
assuming it.

## Decision

### The Tool moves to the context provider and to the DIAGNOSTIC role

`get_org_limits` leaves `@sfoa/mcp-provider-sfoa-data` and joins
`@sfoa/mcp-provider-sfoa-context`, alongside the other two DIAGNOSTIC Tools. It stays
`ReleaseState.GA`, stays `Toolset.DATA` (a toolset is a grouping, not a role —
`run_diagnostic_tooling_query` is also `Toolset.DATA`), stays default-disabled, and still accepts
no identity, credential or org selector. What changes is one line of the role map:

```ts
export const SFOA_CONTEXT_TOOL_ROLES = Object.freeze({
  …
  get_org_limits: 'DIAGNOSTIC',
} as const);
```

### Three gates are inherited from that map, not re-implemented

The role map is the single source of truth for all three DIAGNOSTIC gates, so the one-line
addition activates all of them with no change to `config.ts`, `http-server.ts` or the policy
snapshot layer:

1. **Per-request routing** — `getRequestedExecutionRole` classifies a `tools/call` by the enabled
   Tool's role, before any Tool sees its input. A forged `connectionRole`/`username` argument
   cannot select the scope.
2. **Startup validation** — a config that enables a diagnostic Tool without a diagnostic identity
   fails at load with `MCP_DIAGNOSTIC_CONFIGURATION_INVALID`, so the misconfiguration is a
   startup failure rather than a per-request one.
3. **Per-request preflight** — `assertDiagnosticSnapshotValid` runs on every `tools/call`; a
   MySQL-mode Control Plane whose diagnostic row is absent, disabled or not verification-passed
   refuses the request before a Tool runs.

The inheritance is genuinely free but it is also genuinely invisible: nothing in `config.ts`
names this Tool, so a reader grepping for the Tool would conclude there is no boot check. It is
therefore pinned by test — the existing boot-check case now iterates
`run_diagnostic_tooling_query`, `get_metadata_component_context` **and** `get_org_limits` —
rather than left to be rediscovered.

### The pure derivation moves into the provider; the executor stays in the host

`org-limits.ts` (the four derivation functions and their helpers) is pure: no Connection, no
role, no budget. It moves into the provider package with its unit suite, so it runs under
`yarn test` in the package that owns it.

The **executor** stays in the host
(`packages/sfoa-mcp-server/src/org-limits-context-executor.ts`), and the reason is the role
guard rather than the response budget. A provider-side executor is handed a connection it cannot
attribute: `RequestScopedOrgService` exposes `getAllowedOrgUsernames()` and `getConnection()` and
carries no connection role, and the provider package does not depend on `@sfoa/identity-runtime`.
An executor there could never *prove* its scope is DIAGNOSTIC — it could only be trusted because
`ContextToolFacade` checked first, which removes the defence-in-depth the other two diagnostic
Tools have. In the host, `assertDiagnosticScope` is available and is the last check before
Salesforce sees a request; all three executors now share that one function, so the diagnostic
error wording cannot drift between them. The byte budget is the second reason: `trimToByteBudget`
and `DATA_MAX_RESPONSE_BYTES` live in the data package, and the host already depends on both
providers, so importing them from there adds no dependency edge.

### The context error surface grows exactly two optional fields

ADR-0026's contract needs `suggestion` and `salesforceErrorCode`, and the context package's
failure surface had neither. `ContextRuntimeError` gains an optional `suggestion?: string`, and
`contextExecutionErrorToolResult` emits `suggestion` and `salesforceErrorCode` **only when they
are set**.

This is safe because it is unobservable to every other Tool: all context output schemas are
`.strict()`, and only `orgLimitsOutputSchema` declares the two keys, so the six pre-existing
Tools' outputs are byte-identical. That claim is pinned by test rather than asserted — a
`ContextRuntimeError` without a suggestion renders exactly `['success', 'errorCode', 'message']`.

### A hint is gated on the session's advertised set, which the host was not passing

`QueryRecordsExecutor` and `SearchRecordsExecutor` name `get_org_limits` in their
exhausted-allowance remedy only when `hasTool(ORG_LIMITS_TOOL_NAME)` — and the set behind that
check was the **Data subset**. After the move `get_org_limits` can never appear in it, so `hasTool`
would have been permanently false and the remedy would have vanished silently: no error, no
failing test, just a hint that stops suggesting the one Tool that answers the question.

`SfoaDataProviderOptions` therefore gains `advertisedToolNames`, supplied by the host from the
session's `enabledTools` (both composition points: the governed runtime and Discovery). This is
also what ADR-0025 and ADR-0026 already *said* the rule was — "only when the session actually
advertises them" — the code had been approximating the session with the Data subset. The fix
makes the code match the ADR rather than changing the ADR.

### The live gate reads the Tool first and the reference second, both on the diagnostic Connection

ADR-0026 read the org's own `limits()` first, over the routed USER Connection, and treated that
as the reference. That order cannot survive the move: the reference read has to come from an
identity allowed to perform it, which is now the diagnostic identity, and the Tool's own call is
what creates that scope.

`orgLimits` therefore calls the Tool, asserts `executionRole === 'DIAGNOSTIC'`, takes the
Connection the call established, checks its username normalises to the snapshot's diagnostic
username — which is itself the proof that routing really produced a diagnostic scope, not just
that a role was labelled — and reads the reference over **that** Connection.

Numbers that move between two live reads are expected. The first live run of this gate proved how
expensive it is to leave that as a sentence: the comparison was written number-for-number, and it
failed a correct Tool because `DailyApiRequests.used` had advanced by 3 between the Tool's read
and the reference read — advanced by the gate's own calls. The rule this ADR states is now the
rule the code implements, and it is split by what may move rather than by how far:

- `max` is a quota ceiling. It is compared strictly and is never waived.
- the Tool's `used` is checked against its own `max - remaining`. That is time-independent, so an
  operand-order bug is still caught on a counter that moves — which a comparison against the org's
  later reading could not do.
- a `remaining`/`used` disagreement is re-read once against a fresh reference read, and waived
  **only** where the org's own value moved between the two readings. A value the org did not move
  is stable and must still match exactly, so the waiver cannot hide a wrong number in a quota that
  is not in flight.
- what was waived is reported as `toleratedMoves` in the gate detail. The tolerance is evidence,
  not silence, which is the same rule the Tools themselves follow when they declare truncation.

`verbose` is exercised last, as before, and the two calls must agree on the key set.

### `describe_sobject`'s truncation declaration, which this gate also found

The run that produced the results below failed a second gate, and it was **not** caused by this
move — the executor, its constants and the comparison were all untouched by it. `describe_sobject`
declares `truncated` at the document level: it is true when the field list was cut, when the child
relationship list was cut, or when a returned field's picklist was cut. The gate read it as a
statement about fields alone, so it required `truncated === false` on an object whose fields fit
while its children did not — `Lead` holds 101 fields under the 200-field default and 72 child
relationships against a cap of 50. Earlier runs recorded `PASS` because none of them described an
object of that shape: the comparison only fails when the fields fit and the children do not, so a
recorded `PASS` is itself the evidence that no earlier run reached it.

The gate now derives the expectation from the org's own counts and also asserts the hint is
present exactly when the declaration is true. The correction is recorded in the CHANGELOG rather
than here because it is a defect in the instrument, with no product decision in it; it is noted
here because this ADR's gate run is what exposed it.

### The outcome matrix, and the one rule that does not move

The gate is enabled **only** when the snapshot carries an enabled, verification-passed diagnostic
row. Appending the Tool unconditionally would have been a live-gate defect, not a stricter test:
`assertDiagnosticSnapshotValid` runs before `getRequestedExecutionRole`, so on a Control Plane
with no diagnostic identity *every* `tools/call` in the run throws
`MCP_DIAGNOSTIC_CONFIGURATION_INVALID` — all nine gates would fail, not this one. The inventory
expectations, the snapshot source and the schema-leak check all use the same conditional list, so
the Tool cannot quietly drop out of the schema checks when it is not enabled.

| Diagnostic row | Tool enabled | Diagnostic identity can read `limits()` | `orgLimits` |
| --- | --- | --- | --- |
| enabled · PASS | yes | yes | **PASS** — the first path on which this is provable |
| enabled · PASS | yes | no | `NOT TESTED`, with the Salesforce code, saying the org refuses it even to the diagnostic identity |
| enabled · not PASS | no | — | `NOT TESTED`, naming the non-PASS status |
| absent / disabled | no | — | `NOT TESTED`, naming the absent diagnostic configuration |
| any | yes | refusal that is not `MCP_LIMITS_ACCESS_DENIED`, or a success that disagrees with the org | **FAIL** |

`NOT TESTED` still never becomes `PASS`: a refusal is not a read. What changes is which
statement each outcome makes. Previously the only reachable outcome was "no identity SFOA routes
is allowed"; now the gate distinguishes "the org refuses its limits resource" from "this
deployment has not configured the identity that could try".

## Facts ADR-0026 recorded that this ADR corrects

- **"Granting the routed user `View Setup and Configuration`, or routing one that has it, turns
  the gate into a real `PASS` with no code change"** (ADR-0026, Negative consequences; repeated
  in the changelog entry). Both halves are now wrong. The code did change — a role, a provider
  and a hint gate — and granting a business integration identity Setup visibility is the specific
  widening this ADR rejects. The remedy that replaced it is "configure and verify a Diagnostic
  identity", which is a Control Plane action, not a widening of a business identity.
- **"no exhaustive switch or saturated map over `SalesforceApiPurpose` other than
  `DATA_TOOL_PURPOSES`"** (ADR-0026, Decision). There are now two: `DATA_TOOL_PURPOSES` over
  `SfoaDataToolName` and `CONTEXT_TOOL_PURPOSES` over `SfoaContextToolName`. The `ORG_LIMITS`
  purpose is unchanged and still produced on the quota path; what moved is which facade emits it.
  `assertContextToolPurposesMatchRoleMap()` keeps the new map total over the role map, so a Tool
  that moves between providers cannot arrive without an audit purpose and be recorded as
  `UNKNOWN`.
- **The `DATA_TOOL_PURPOSES` map is what caught the move.** Its exhaustiveness over
  `SfoaDataToolName` made the removal a compile error rather than a grep-and-hope, which is why
  the migration landed as one commit with no compiling intermediate state.

## Deviations from the P9 plan's wording

Recorded per the P9 execution convention, which requires any deviation from the approved plan to
appear in an ADR and in the changelog:

1. **`advertisedToolNames` is a new option name, not a rename.** The plan left the executor-level
   `enabledToolNames` option untouched and added a provider-level pass-through; that is what was
   built, so the executor contract is unchanged and only the host's supply of it moved.
2. **The discovery composition point is pinned in the existing all-Tools inventory case** rather
   than in a new suite. That case already enables every context and diagnostic Tool against a
   verification-passed diagnostic row and asserts both inventories agree, so adding one name
   covers the composition point *and* the two-inventories invariant at once.
3. **`- Superseded by:` is used for the back-pointer in ADR-0026**, not a new "Revised by" label.
   ADR-0011 and ADR-0014 already establish "only where …" as this repository's idiom for a
   partial supersession, and inventing a second vocabulary for the same relation would make the
   ADR set harder to read.

## Consequences

### Positive

- The quota read runs on the identity class it belongs to, and the business identities are not
  widened into org configuration to make one Tool work.
- "Can a diagnostic administrator read `limits()`?" is now measurable under the audit pipeline
  instead of deferred to an off-platform request.
- The Tool inherits routing, boot validation and per-request preflight from the role map, and the
  inheritance is pinned by test.
- The context package's error surface can carry a remedy without changing any existing Tool's
  output — `.strict()` made that checkable rather than hopeful.
- The hint rule now means what ADR-0025 and ADR-0026 always said it meant.

### Negative

- **T4 must change its plan, not just its wording.** ADR-0026's forward consequence had T4 doing a
  quota pre-flight over the USER Connection before launching a Bulk job. Through a business
  identity that read is refused exactly as before, so the pre-flight as planned cannot work.
  T4's options are (a) make the pre-flight a separate `get_org_limits` call — routing is per
  call, so no session-level change is needed — or (b) drop the claim of a pre-flight and report
  the quota facts the Bulk job response itself carries, naming `get_org_limits` in the remedy for
  an exhausted allowance. **(b) is recommended.** What is *not* available is a DATA Tool opening a
  DIAGNOSTIC Connection internally: `SfoaDataProviderOptions` has no scope and `DataToolFacade`
  pins the route to USER, which is the invariant that keeps a business Tool from borrowing
  diagnostic authority. The "before/after delta" measurement ADR-0026 also described is no longer
  a clean measurement across two identities.
- **Once enabled, any enabled platform user can read whole-org quota numbers.** Tool enablement is
  global, so "operators may call it, business users may not" is not expressible here. This is the
  same property the other two diagnostic Tools already have, and quotas are not business data —
  but it is a real operational fact and it is why the Tool stays default-disabled.
- **A Control Plane can enable the Tool without a diagnostic identity, and then every `tools/call`
  fails.** `tool-catalog.ts`'s `enableAllowed` keys off upstream drift status, not diagnostic
  verification status, so `assertDiagnosticSnapshotValid` will throw for *every* call once such a
  row exists. This is pre-existing behaviour for the other two diagnostic Tools and this ADR adds
  one more entry point to it; it is recorded as a known hazard rather than fixed here, because
  fixing it means a catalog-visibility change with its own regression surface.
- **`diagnosticReady` still names only the original two Tools** (`capabilities.ts`), so a
  deployment that enables `get_org_limits` alone reports the discovery interface as not ready.
  User-visible text, unchanged by this ADR, recorded as follow-up.
- **A context Tool now reads a constant named `DATA_MAX_RESPONSE_BYTES`.** The honest fix is to
  lift `response-budget.ts` into a provider-neutral shared package; that touches four Data
  executors already running on the test server, so it is recorded as follow-up rather than done
  as a side effect of a role change.

## Rejected alternatives

- **Grant the business integration identities `View Setup and Configuration`.** The narrowest
  change on paper, and rejected: it widens every business identity into org configuration to make
  one Tool readable, which inverts the reason the DIAGNOSTIC role and its isolation exist. A
  permission that is correct for a diagnostic administrator is not thereby correct for a business
  integration user.
- **Keep the Tool in the data provider and change only the role value.** It would break the
  "every Data Tool is `READ`/`USER`" invariant that `data-tool-facade.ts`'s saturated purpose map
  and the `MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED` boundary both rest on, require relaxing two
  provider-hardcoded gates, and — worst — turn "a diagnostic Tool is enabled but no diagnostic
  identity is configured", currently a **startup** failure, into a per-request one.
- **Put the executor in the provider package and drop `assertDiagnosticScope`.** Cheaper, and it
  silently deletes the only check that can prove which identity a Connection was opened for. The
  facade's role check would become the sole guard, and a future composition path that bypasses
  the facade would reach Salesforce with a business identity.
- **Add a provider→provider dependency so the context package can reuse the data package's byte
  budget.** The first such edge in the repository, in exchange for one constant and one function.
- **New shared package for `response-budget.ts`.** The correct end state, but it moves four Data
  executors that are already running on the test server. Not as a side effect of a role change.
- **Leave the hint gate on the Data subset.** It compiles, it passes every existing test, and the
  only symptom is a hint that stops naming the Tool that answers the question.

## Gate

Acceptance follows ADR-0024 and ADR-0025. The role decision was verified without hardware first —
`getRequestedExecutionRole` classifies the Tool as `DIAGNOSTIC` including against forged
`connectionRole`/`username` arguments; a USER scope is refused with
`MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED` both at the executor and at the facade, and the executor opens
no Connection while refusing; enabling the Tool without a diagnostic identity fails startup with
`MCP_DIAGNOSTIC_CONFIGURATION_INVALID`; and the Discovery composition point hands the provider a
deny-only executor so an inventory request cannot take the whole tool surface down.

The end-to-end path is covered over the real Streamable HTTP surface: an enabled call runs on the
diagnostic identity, the Connection it opens is the diagnostic one and never the caller's, the
`TOOL_TERMINAL` audit event records `executionRole: DIAGNOSTIC`, and a Control Plane that refuses
the limits read produces a structured `MCP_LIMITS_ACCESS_DENIED` audited as a failure.

The live gate is `orgLimits` in `packages/sfoa-mcp-server/src/validation/p9-live-validation.ts`
(`yarn validate:p9`), and its outcome is the matrix above. It reports `NOT TESTED`, never `PASS`,
unless a diagnostic identity both exists and verification-passed **and** the read actually
succeeds; through a deployment with no such row it reports `NOT TESTED` naming that, and the
run's `overall` is `PARTIAL` for that reason alone.

The run that closed T3 landed on the first matrix row. Eight gates passed, `orgLimits` passed —
the diagnostic identity read all 73 limits from `GET /services/data/v68.0/limits` where every
business identity this deployment can route had been refused — and `queryRecords` was `NOT TESTED`
with its reason, because the configured live object holds 3 rows and cannot exercise the
continuation walk at all. `overall` = `PARTIAL`, for that one reason, and the row was audited
end-to-end with `purpose = ORG_LIMITS` and `execution_role = DIAGNOSTIC`. The two failures the
first attempt produced are the two corrections recorded above; neither is a waiver, and no gate
was made to pass by relaxing what it asserts about the Tool.
