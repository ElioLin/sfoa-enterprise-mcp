# ADR-0026: Quota pre-flight and cross-object keyword search in the P9 data provider

- Status: Accepted for P9
- Date: 2026-09-28
- Supersedes: none
- Superseded by: ADR-0027 only where it fixed `get_org_limits` to `READ`/`USER` in the data provider, where it named the remedies available when the org refuses the limits resource, and where it fixed the `orgLimits` live gate's reading order and its inference about what the org refuses. `search_records` and the SOSL decisions below stand unchanged.
- Extends: ADR-0024 P9 data provider over the official SDK, ADR-0025 bounded query completeness, ADR-0001 upstream extension boundary, ADR-0005 remote Tool governance, ADR-0015 P7 end-to-end audit data model

## Context

Two P1 gaps in the P9 gap analysis remain after T1 and T2, and they are the last read
capabilities the official `@salesforce/mcp-provider-dx-core` does not supply:

- **GAP-D7 — no `get_org_limits`.** A large data job cannot be sized before it is launched: an
  Agent has no way to see the daily API and Bulk allowances it is about to spend. **P9-3 (Bulk
  API 2.0) explicitly depends on P9-4 (limits visible)**, so this Tool is T4's prerequisite.
- **GAP-D5 — no SOSL.** `query_records` needs an object and a field list up front, so "which
  record anywhere mentions this term" has no SOQL equivalent at all.

T3 adds `get_org_limits` and `search_records` beside the shipped tools, under the same rules:
`READ`/`USER`, default-disabled, no identity parameter, no official file touched.

Both tools were built **after** a throwaway probe against the live org, because ADR-0025's
central lesson is that a claim about *Salesforce's* response shape can only come from
Salesforce: a stub Connection returns the shape the code assumes, so a unit suite can be
entirely green while the Tool is wrong against a real org. The probe's findings are recorded in
`docs/sfoa/P9_T3_LIVE_PROBE_FINDINGS.md` and are the basis for several decisions below; one of
them (the bare `RETURNING <Object>` shape) **overturned** the plan's assumption.

Three questions the code cannot answer by itself are settled here:

1. **What does `get_org_limits` do when the org does not report a limit this Tool documents?**
   Omitting the slot and reporting a zero allowance are indistinguishable to a reader of the
   other one, and both are wrong in a different way.
2. **What may `search_records` claim about completeness** when SOSL reports no total, no
   `done` and no cursor?
3. **How is a cross-object search audited** in a model whose query semantics channel is built
   around SOQL's `FROM` shape?

## Decision

### Two new audit purposes, and not the query channel

`SalesforceApiPurpose` gains `ORG_LIMITS` and `SOSL_SEARCH`. The union is free-form at the
storage layer (`sfoa_salesforce_api_call.purpose` is `VARCHAR(256)`, and the audit purpose
schema is a bounded string), and the whole repository has **no exhaustive switch or saturated
map** over it other than `DATA_TOOL_PURPOSES`, which is saturated over `SfoaDataToolName` by
design. Adding two members is therefore additive with no migration and no Control Plane change.

`USER_QUERY` was rejected for both. It is the purpose the official SOQL path and
`query_records` share, and reusing it would file a quota read and a keyword search as SOQL
queries. For SOSL the failure is concrete: the row would carry `query_type = NULL`, which the
Admin audit trace reads as a failed semantic capture (`audit-trace.ts` counts a row as a SOQL
query by its `queryType`), so a correctly classified search would look like a broken query.
`SOSL_SEARCH` makes the row self-describing. The naming follows the existing capability style
(`OBJECT_SCHEMA`, `DIAGNOSTIC_TOOLING`, `METADATA_RETRIEVE`) rather than naming a Tool.

### The SOSL text is recorded in SFoA's own request summary

`search_records` records its bounded search term, object scope, field list and limit in
`request_summary_json` through the same `safeDataRequestSummary` hook `query_records` uses,
with the existing 64-character summary token bound. The shared `jsforce-audit-adapter` is
**not** touched.

This was checked rather than assumed. The adapter recognises `/query` and `/tooling/query`
only; `/search` falls to `emptySemanticEvidence()`, which returns **before**
`recordSalesforceApiCaptureFailure()`, so an unattributed SOSL call is a clean, complete audit
row rather than a degraded one. Editing the adapter to consume a `/search` response — whose
payload has no `totalSize`, no `done` and no cursor to read (findings §2), and whose
`enrichQueryResult` observer never fires because `installQueryResultObserver` patches
`Query.prototype.execute` only — would mean rewriting a shared component that P3, P4, P5 and
P7 all depend on, in exchange for weaker evidence than the request summary already carries. If
SOSL ever has to enter the query semantic channel, that is an identity-runtime change with its
own ADR and its own regression surface; this ADR records the decision and the exact blast
radius that was avoided.

`GET /services/data/<v>/search` classifies as `REST_API` through the existing
`salesforce-api-classifier`, and `migrations/006` already allows that category, so no schema
change is needed either.

### A highlight slot is always present, and an absent slot is a reportable fact

`get_org_limits` returns the org's own key/value map as `limits`, plus a `highlights` object
with exactly five slots: `dailyApiRequests`, `dailyBulkApiRequests`, `dailyAsyncApexExecutions`,
`dataStorageMB`, `fileStorageMB`. All five are always present. A slot the org does not meter is
`present: false` with `key: null` and null numbers — **never omitted and never zeroed**.

"That this org does not meter that resource" is itself the answer an Agent needs before sizing a
job, and a missing slot cannot be told apart from a zero allowance. The slot's `key` names the
org key that actually filled it, because **the Bulk allowance was renamed between API versions**
(`DailyBulkApiRequests` in Bulk API 1.0, `DailyBulkV2QueryJobs` in 2.0) and which one an org
reports is a fact a caller comparing against Setup needs. One org key can fill at most one slot,
so the alias table is a lookup rather than a set of independent lists. The complete `limits`
map is returned verbatim regardless, because T4's pre-flight has to read the whole table rather
than the five highlights.

The five slots are written out in full in the schema rather than generated from
`ORG_LIMIT_HIGHLIGHT_SLOTS`: a generated `Record<string, …>` would lose exactly the guarantee
that matters, namely that every slot is present. Dropping one is a compile error, and a unit
test pins the key set to the slot list so the two cannot drift.

`ORG_LIMIT_HIGHLIGHT_ALIASES` is **not verified against a live org**: the limits resource was
refused at every API version and for all four identities this deployment could route (findings
§1), so the non-Bulk names come from Salesforce's documentation rather than from an observed
payload. A miss is not a failure — the slot reports `present: false`, which is the answer to
whether this org meters the resource.

### A number is reported, coerced or invented — and the Tool picks "reported"

`readLimitNumber` accepts only a finite, non-negative `number`. A numeric string is deliberately
**not** coerced: the limits resource reports numbers, so a string means the payload is not the
shape this Tool was written against, and guessing at it would put an invented quota in front of
an Agent that is about to launch a bulk job. Such an entry keeps its key with `max: null`,
`remaining: null`, `measured: false` and is counted in `unreadableLimits`.

`used` is computed only when both ends are known **and consistent** (`max >= remaining`), and
`measured` is exactly `max !== null || remaining !== null`. A limit that reports only a maximum
(a concurrency limit is the common case) keeps `remaining: null, used: null, measured: true`
rather than being given a `used: 0`; an inconsistent pair keeps `used: null` rather than a
negative number, which is how a subtraction with the operands the wrong way round would read.

A payload with **no readable entry at all** throws `MCP_LIMITS_READ_FAILED` instead of returning
`{limits: {}}`. An empty success invites the conclusion "this org has no quota", which is the
opposite of what the Tool exists to prevent. A refusal — `API_DISABLED_FOR_ORG`,
`INSUFFICIENT_ACCESS*`, `NOT_FOUND`, `INVALID_TYPE` — is one `MCP_LIMITS_ACCESS_DENIED`, because
"the identity may not read the limits resource" and "this org does not expose it" arrive as the
same Salesforce code; the message states both possibilities and the suggestion says the failure
is confined to quota visibility, so an Agent does not conclude its other Tools are broken.

`verbose` changes **the text only**. `structuredContent.limits` is identical either way,
because a field called `limits` must not become a subset under a switch. The switch exists
because the alternative to it is a binary choice between flooding an Agent's context with a
hundred-plus limits and never showing them at all, which is the pattern
`describe_sobject.includeFields` already establishes.

### `search_records` has two modes, and refuses rather than rewriting

A bare keyword is composed by the server; a complete `FIND` clause is sent unchanged. In keyword
mode:

- `{` and `}` are **refused**, not escaped. They are the only characters that could terminate
  the brace group this Tool writes, so a bare term carrying one is overwhelmingly an attempt to
  escape it.
- Everything else in the reserved set is escaped with a backslash from a frozen table, and a
  trailing backslash becomes `\\` so it cannot escape the closing brace.
- `objects` becomes the `RETURNING` list and `limit` becomes the global `LIMIT` — always, so
  keyword mode always carries a stated cap and truncation is decidable.

A **field list is always written**: the caller's, or `Id, Name`. The probe overturned the plan's
assumption here — `RETURNING Account` is legal and accepted, but returns each record with
nothing but `attributes` and `Id` (findings §4). A search that answers with opaque ids is a
locator, not the "which record is called something like this" lookup this Tool exists for. The
cost is real and is designed around rather than hidden: an object with no `Name` (Case, Task)
needs an explicit list, which fails loudly as `INVALID_FIELD` → `MCP_SEARCH_FIELD_INVALID`
pointing at `describe_sobject`, instead of quietly returning a shape the caller did not ask for
(findings §5).

`objects`, `fields` and `limit` alongside a complete clause are **refused, not ignored**. The
clause is the caller's own text: applying `objects` to it means rewriting the caller's
`RETURNING`, and `fields`/`limit` are inert when the clause carries its own. A recognised
parameter that does nothing is worse than a refusal, because the caller cannot tell which
parameters applied.

**A bare keyword whose first word is `find` is read as a clause and refused.** The two modes
cannot be told apart lexically — `find` is a legal first word of a search term and also the
clause keyword — so the rule is the conservative one, and the refusal names the way out
("remove the leading FIND so the term can be escaped and wrapped for you"). Refusing a search
that would have worked is recoverable in one turn; guessing wrong means sending Salesforce a
statement the caller did not write.

`limit` is one cap on the **whole** result, not a per-object cap, and the description and the
text both say so: SOSL has a single global `LIMIT`, and an Agent that reads an empty group as
"no matches" would be wrong whenever the global cap filled first.

### Completeness is withheld when it cannot be shown

The payload is `{ searchRecords }` and nothing else — no `totalSize`, no `done`, no cursor
(findings §2) — so completeness is derived from whichever explicit cap the statement carried,
never inferred from the response:

```text
truncatedReason = budgetCut ? RESPONSE_BUDGET : limitReached ? LIMIT_REACHED : anyObjectAtLimit ? PER_OBJECT_LIMIT : null
complete        = !truncated && unreadable === 0 && effectiveLimit !== null && totalReturned < effectiveLimit
```

The reason names the constraint that bound the **returned slice**, because that is what the
caller holding these records has to work around; the hint still names every binding. `atLimit`
is true only when a per-object cap could be read out of the clause **and** the count reached it
— a cap this Tool cannot see is never guessed at. `complete` is claimed only against an explicit
cap that was not reached, so `limitSource: 'UNSPECIFIED'` (a caller's clause with no global
`LIMIT`) always reports `complete: false` with the reason and the fix, following ADR-0025's rule
that a completeness claim without evidence is withheld rather than assumed.

The result is `resultsByObject`, an object of **groups** — `{objectApiName, count,
returnedCount, atLimit, records}` — rather than the plan's literal `Record<string, records[]>`.
Truncation has to be actionable per object, and a bare array cannot say how many of an object's
matches were returned or whether a per-object cap bound it. The byte budget is applied to the
flat record list in group order and the prefix re-grouped afterwards, so a group is kept whole,
kept partly, or dropped — never left with a hole in the middle — and a group cut away entirely
still reports its count.

A record's object comes from `attributes.type`, with `attributes.sobjectType` as the only
fallback. A record-level `Type` or `type` field is deliberately **not** consulted: on Case and
Account those are ordinary picklist fields holding a business value, so reading one as an object
name would invent an object and file the record under it. A record whose type cannot be read is
counted in `unreadableRecords`, never guessed at, and its presence makes `complete` false
because it is not in `resultsByObject`.

No per-object `label` is returned. A label would need an extra `describe`/`describeGlobal` round
trip whose only justification is the label itself, and every object is one `describe_sobject`
away. This is recorded as follow-up work rather than silently dropped.

### Hints may only name a Tool the session advertises

Both Tools follow ADR-0025's rule. `get_org_limits` needs no option for it — none of its hints
name a Tool. `search_records` takes `SearchRecordsExecutorOptions.enabledToolNames`, and names
`query_records` for the ids-only case and `get_org_limits` in the exhausted-allowance failure
only when the session actually advertises them. A Tool named in a hint that `tools/list` does
not contain costs the Agent a turn to discover it is not there.

## Deviations from the P9 plan's wording

Recorded per the P9 execution convention, which requires any deviation from the approved plan to
appear in an ADR and in the changelog:

1. **`search_records` takes a `fields` input.** Not in the spec. The probe showed a bare
   `RETURNING <Object>` returns only `Id` (findings §4), so the spec's own goal — readable
   grouped records — requires naming fields; the default is `Id, Name`.
2. **`mode` and `statement` are output fields.** SOSL completeness is only meaningful relative
   to the statement actually sent, and `mode` tells the caller whether their text was passed
   through or composed around.
3. **`get_org_limits` takes no `enabledToolNames` option** because none of its hints name a Tool.
4. **`fields` is recorded in the audit request summary** alongside `search`, `objects` and
   `limit`.
5. **`SOSL_MAX_STATEMENT_LENGTH` (20 000) bounds the composed statement.** The `RETURNING` list
   repeats the field list per object, so 20 objects × 25 fields × 128 characters is a hundred
   kilobytes of SOSL that no response budget could then bound. The bound is stated where the
   statement is composed, so the size the Tool promises and the size it sends are one fact.
6. **`ORG_LIMIT_HIGHLIGHT_ALIASES` is unverified against a live org** (see above).
7. **`MCP_ENGINEERING_RULES.md` §Pagination cannot be met by SOSL.** It asks for a `has_more`
   flag and a continuation cursor; SOSL has neither. The contract is satisfied the way
   `list_sobjects` satisfies it: an explicit cap, per-object counts, and a `truncated`
   declaration with a reason.
8. **`resultsByObject` holds object groups**, not the spec's literal `Record<string, records[]>`.
9. **The spec's optional `label` is omitted** for the round-trip reason above.
10. **Two new `SalesforceApiPurpose` values**, with the reasoning for not binding SOSL to the
    query semantic channel recorded above.
11. **`measured` is exactly `max !== null || remaining !== null`**, kept as a field so a quota
    pre-flight can branch on it without re-deriving it from two nulls.
12. **A bare keyword beginning with `find` is read as a clause and refused** (see above).

## Findings recorded from this task

**The limits resource is refused to every identity SFOA can currently route.** `Connection.limits()`
fails with `API_DISABLED_FOR_ORG "limits resource is not enabled"`, identically for four enabled
identity routes and for the raw REST path at API v68.0/v62.0/v58.0/v50.0, with `limits` absent
from the ~50 root resources the org advertises. All four are integration identities of this one
deployment sharing a profile shape, and **no administrator identity was tested**, so this is a
statement about the identities SFOA can route rather than about the org: an earlier draft called
it org-wide and claimed more than the probe showed.

The leading cause is a **missing permission, not an org-wide switch**. `API Enabled` is provably
present, since the same identities run `query`, `describeGlobal` and `search`, and a missing
`API Enabled` reports a different code (`API_CURRENTLY_DISABLED`); `limits resource is not
enabled` is what Salesforce returns when the connecting user lacks **View Setup and
Configuration**, a read-only permission over org setup that grants no change — which also
explains the uniformity across four identities, since they share a profile. A second candidate is
the identity's **user licence type**, some of which cannot be granted that permission at all; our
reproduction of the error on v68.0, where several sources say it no longer occurs, is weak
evidence that something here is non-standard. **One administrator request to
`GET /services/data/v68.0/limits` settles which**, and nothing else in this ADR depends on the
answer.

`get_org_limits` is correct and cannot return data through any identity SFOA can currently route.
Its live gate is therefore `NOT TESTED` and **must never be `PASS`** — calling a refusal a pass
would claim a successful read that never happened. It becomes a real `PASS` as soon as an identity
permitted to read the resource is routed, with no code change. Until then the P9-3 → P9-4
dependency recorded in the gap analysis cannot be satisfied here, so T4 must treat a quota
pre-flight as best-effort.

**The live gate still exercises the refusal path.** When the org refuses, the gate calls the
Tool once anyway and requires `isError: true` with `MCP_LIMITS_ACCESS_DENIED` and a suggestion
— a denial that proves nothing about the read it could not perform, but which is what the org
actually does, and which is the only way the `ORG_LIMITS` audit row is produced live. The gate
fails if the Tool answers anything else.

**The gate enables the attachment ingress to start at all.** A Control Plane that enables an
attachment Tool and a runtime whose config has the ingress switched off cannot complete any
request: the server refuses with `MCP_ATTACHMENT_CONFIGURATION_INVALID` before any Tool runs.
The harness starts its own in-process server, so it binds the same ingress the deployed runtime
binds, and the run supplies the staging root a deployment granting that Tool would have.

**The `search_records` live gate cross-checks against the org, not against itself.** Since the
payload carries no total, the only independent reference is the org's own record list for the
exact statement the Tool reported sending — read over the same request-scoped Connection through
`connection.search()`, never taken from the Tool. Two probes run: an unscoped keyword search at
the Tool's maximum limit, and the same term scoped to one object with a field list taken from
that object's own record (so `Case`/`Task`, which have no `Name`, are exercised too). Each is
judged on the org's count, and the truncation declaration and the `complete` claim are
re-derived from that count rather than read back. The search term itself never reaches the
report: only its length and the field it came from are recorded, because the term is a real
customer value from the org.

**The gate reads a term as a single alphanumeric token.** The longest run of letters and digits
in a real record's own text field is a term that can never need escaping, so a difference
between the statement the Tool reported and the statement predicted by the gate is a defect
rather than a disagreement about SOSL's reserved characters. The escape table itself is pinned
byte for byte by the unit layer, which is where it belongs.

**The two new purposes are in the live audit, and neither writes `query_type`.** The live run
produced an `ORG_LIMITS` row (`REST_API`, `FAILED`, `API_DISABLED_FOR_ORG`) and four
`SOSL_SEARCH` rows (`REST_API`, `SUCCESS`), all with `query_type: NULL` — so the Admin audit
trace's SOQL count is unaffected, which was decision 1's whole point.

## Consequences

### Positive

- An Agent can size a job before launching it, and can tell "this org does not meter that
  resource" from "the allowance is zero".
- Cross-object keyword lookup exists, with a completeness claim that is either backed by a
  stated cap or explicitly withheld — the same discipline ADR-0025 applies to SOQL.
- Neither Tool can be made to leak an identity, and neither can hand Salesforce a statement the
  Tool refuses to send: the executor re-plans rather than trusting its caller.
- The official `run_soql_query` and every `mcp-provider-dx-core` file are unchanged, so
  `validate:upstream` and the P3/P4/P5/P7 suites are untouched by construction.

### Negative

- `search_records` cannot report a total match count, so "are there more matches than this?" is
  answerable only in terms of the cap that was hit. That is a property of SOSL, not of the Tool,
  and the hint says so rather than approximating.
- A default `Id, Name` field list means an object without a `Name` needs an explicit list. The
  failure is loud and actionable, but it is a second call.
- `get_org_limits` is untestable for its own success path through the identities this deployment
  currently routes. Its contract is pinned by the unit and protocol layers, and the live gate
  reports `NOT TESTED` with the Salesforce code — but that is a statement about the identities,
  not about the org: granting the routed user `View Setup and Configuration`, or routing one that
  has it, turns the gate into a real `PASS` with no code change.
- The alias table for the non-Bulk slots is documentation-derived, not observed.

## Rejected alternatives

- **Reusing `USER_QUERY` for either Tool.** See the decision above: it would file a quota read
  and a keyword search as SOQL queries, and the SOSL row would carry `query_type = NULL`, which
  the audit trace reads as a failed capture.
- **Teaching `jsforce-audit-adapter` about `/search`.** A shared component on which P3, P4, P5
  and P7 all depend, edited to consume a payload that contains no totals to consume. The
  request summary already records more, at no shared risk.
- **Omitting an unmetered highlight slot.** A missing slot and a zero allowance are
  indistinguishable to a reader of the other.
- **Coercing a numeric string into a number.** The limits resource reports numbers; a string
  means the payload is not the shape this Tool was written against, and the coercion would put
  an invented quota in front of a job-sizing decision.
- **Ignoring `objects`/`fields`/`limit` when a complete clause is supplied.** A recognised
  parameter that does nothing is worse than a refusal: the caller cannot tell which applied.
- **Escaping `{` and `}` in a bare keyword rather than refusing them.** They are the only
  characters that could terminate the brace group the Tool writes; escaping them would be
  guessing at an intent the caller can state directly as a clause.
- **A per-object `label` on each group.** An extra describe round trip justified only by itself.
- **Wrapping or forking `run_soql_query`.** ADR-0024 settled this: `run_diagnostic_tooling_query`
  depends on it, so a second Tool is added beside it and the official one stays byte-identical.

## Gate

Acceptance follows ADR-0024 and ADR-0025: unit tests over a stub Connection, protocol tests for
disabled / enabled / refused-input / allowed, a live SFoA read whose facts match the org, a P7
audit chain carrying no token or key material, and the P0–P8 regression set. Missing live
conditions stay `NOT TESTED`; they cannot be simulated into PASS.

The live gates are `orgLimits` and `searchRecords` in
`packages/sfoa-mcp-server/src/validation/p9-live-validation.ts` (`yarn validate:p9`):

- **`orgLimits`** reads the org's own `limits()` over the same request-scoped Connection first.
  A refusal is `NOT TESTED` naming the Salesforce code, after checking that the Tool answers
  with a structured `MCP_LIMITS_ACCESS_DENIED`; anything else is a `FAIL`. When the connection
  does answer, every key, `max`, `remaining` and re-derived `used` is compared against the org's
  own numbers, `unreadableLimits` against the entries the org reported no number for, and each
  highlight slot against the org's key set — a slot reported absent fails unless no key this
  Tool would have read is present, because `present: false` is a claim about the org. A second
  call with `verbose: true` must return the same key set, value movement between two live reads
  being expected.
- **`searchRecords`** derives a term from a real record of the routed object, then runs an
  unscoped probe at the Tool's maximum limit and the same term scoped to one object. For each,
  the org's own count for **the statement the Tool reported sending** is the reference:
  `totalReturned`, `returnedCount`, the group sums, `objectsReturned`, `limitSource`,
  `effectiveLimit`, the truncation declaration and the `complete` claim are all re-derived, and
  a scoped search must return exactly one group. A transient `SERVER_UNAVAILABLE` (findings §7)
  makes the probe `NOT TESTED` rather than failed, and an object with no usable text field makes
  it `NOT TESTED` with the reason. No term text reaches the report.

The `orgLimits` gate requires an identity permitted to read the limits resource; through the four
integration identities this deployment routes it reports `NOT TESTED` with
`API_DISABLED_FOR_ORG`, and the report's `overall` is `PARTIAL` for that reason alone. The
`searchRecords` gate requires an object with at least one record carrying a searchable text
value; it is `NOT TESTED` with the reason otherwise.
