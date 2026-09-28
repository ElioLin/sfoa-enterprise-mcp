# ADR-0025: Bounded, self-declaring SOQL completeness in `query_records`

- Status: Accepted for P9
- Date: 2026-09-28
- Supersedes: none
- Extends: ADR-0024 P9 data provider over the official SDK, ADR-0001 upstream extension boundary, ADR-0005 remote Tool governance, ADR-0015 P7 end-to-end audit data model

## Context

GAP-D1 records that the official `run_soql_query` performs exactly one `connection.query(...)`
and never consumes `nextRecordsUrl`; it has no row budget, and the platform refuses
`OFFSET > 2000`. A result larger than one batch is therefore returned as the first batch with
**nothing in the payload distinguishing it from a complete answer**. The failure is silent by
construction: an Agent that counts 2 000 rows out of 46 000 reports a conclusion about 2 000
rows as though it were a conclusion about the object.

ADR-0024 rejected wrapping or forking the official Tool, because
`run_diagnostic_tooling_query` depends on it, and chose to add a new Tool beside it. T2 adds
that Tool. Placing a second SOQL Tool next to an official one raises three questions the code
cannot answer by itself, and this ADR is where they are settled:

1. **What may the new Tool claim?** A completeness claim is only worth anything if it is
   derived from evidence and is *withheld* when the evidence is missing.
2. **When the answer is short, why?** "Truncated" without a reason is only marginally better
   than silence: the fix for a low `maxRows` is the caller's, the fix for a spent response
   budget is a narrower query, and a platform that stops handing out continuation cursors is
   not the caller's to fix at all.
3. **Which layer enforces the input contract?** ADR-0024 found that
   `McpToolConfig.inputSchema` is a `z.ZodRawShape`, so the registered wire schema is
   `z.object(shape)` and a provider-side object-level refinement never reaches the wire. The
   statement rules T2 needs (SELECT-only, single statement, no `FOR UPDATE`) need
   string-literal-aware scanning, which a JSON Schema `pattern` cannot express.

## Decision

### Coexistence with the official `run_soql_query`

`run_soql_query` stays **byte-identical** and remains the dependency of
`run_diagnostic_tooling_query`. `query_records` is not a rename, an alias, or a
same-name replacement: it is a separate Tool with a separate name, a separate default-disabled
grant, and a separate audit classification.

Both Tools are advertised together once an Admin enables `query_records`; when it is not
enabled, nothing about the official Tool changes. The tie-break an Agent needs lives in the
**new** Tool's description, because it is the new Tool that must justify itself: prefer
`query_records` when the result may exceed one batch or when completeness must be stated;
`run_soql_query` remains correct for a quick look at a small result. The official description
is left alone, so no upstream file is edited to make the pair coherent.

The audit classification follows ADR-0024's compile-enforced map: `query_records` is `USER`
and its `SalesforceApiPurpose` is `USER_QUERY`, the same purpose the official SOQL path uses —
the two Tools are audited as the same kind of Salesforce access. The statement itself is
recorded **once**, by the request's Salesforce-call query semantic
(`DATA_SOQL` / `TOOLING_SOQL`, bound by the host facade around the whole Tool call so a
multi-page continuation is one audited query rather than unattributed API traffic). The
request summary therefore carries only the facts that record cannot show — `useToolingApi`
and `maxRows` — instead of a second, differently-bounded copy of the statement text. The
response summary carries `totalSize`, `fetched`, `pages`, `complete`, `truncated` and
`truncatedReason`.

### Completeness is derived, and withheld when it cannot be established

```text
complete = done && !budgetCut && (scalarAggregate || (totalSize !== null && fetched === totalSize))
```

The first clause is the ordinary one; `scalarAggregate` is the exception the live run forced,
and it is described under "A scalar aggregate's value arrives in `totalSize`" below.

A result that cannot establish this says so instead of implying it. Two cases matter:

- A platform that reports `done: true` while handing back fewer rows than its own `totalSize`,
  with no continuation cursor, has declared the result incomplete. That is
  `PAGINATION_UNAVAILABLE`, and the Tool must not report `complete`.
- A `totalSize` the platform never reported leaves completeness unconfirmable. The hint says
  so and suggests re-running as `COUNT()`.

`truncated` and `truncatedReason` separate two different shortenings. `truncated` is true when
**any** constraint shortened the answer. `truncatedReason` names exactly one: the constraint
that bound the **returned slice**, because that is what the reader has to work around. When a
response-budget cut follows a row-budget or time-budget stop, `truncatedReason` is
`RESPONSE_BUDGET` while the hint names every binding
(`Truncated by MAX_ROWS + RESPONSE_BUDGET`), so nothing about why fetching stopped is lost.
This is not a hypothetical ordering: measured live on `IntermediateTable__c`, whose rows are
wide enough that the character budget admits about 392 of them, a 500-row request fetches 500
and returns 392, and `RESPONSE_BUDGET` is the honest reason to report — raising `maxRows` would
not return a single row more.

### The truncation reason is a closed enum

| Reason | Meaning | Whose to fix |
| --- | --- | --- |
| `MAX_ROWS` | The caller's row budget was reached | The caller: re-query with a higher `maxRows`, or aggregate |
| `TIME_BUDGET` | The continuation loop's wall-clock budget (60 s) expired | Narrow the query; the budget is not the caller's to raise |
| `RESPONSE_BUDGET` | The byte or character budget cut the returned slice | Narrow the query or drop unneeded fields |
| `PAGINATION_UNAVAILABLE` | The platform stopped handing out continuation cursors | Nobody: the org's API surface, reportable but not fixable |

`TIME_BUDGET` bounds the **continuation loop**, not the first batch. The first batch is already
bound by the host's Tool deadline, and re-deciding it here would only duplicate it; what the
continuation budget stops is a long tail of small batches consuming the whole request.

### Aggregates are a different problem, so they get a different hint

`GROUP BY`, `HAVING` and `COUNT|SUM|AVG|MIN|MAX(` are detected against the statement with its
string literals blanked out, and reported as `aggregate: true`. The result of an aggregate is
bounded by its grouping, not by the size of the org, so a truncation there means `maxRows` was
set below the number of groups — a different fix from the one a detail query needs. The
remaining branch, for a bounded aggregate, is that `COUNT()` or `GROUP BY` is the *cheaper*
answer whenever a total or a breakdown answers the question, and that a large detail set is
paged with a `WHERE` clause on an indexed field, because `OFFSET` does not scale.

### A scalar aggregate's value arrives in `totalSize`, and is not a row count

The aggregate branch above is about **grouped** aggregates, which return one row per group and
whose `totalSize` therefore really does count rows. A **scalar** aggregate — an aggregate with
no `GROUP BY`, whose whole result is one number — is a different shape, and it is the shape
`COUNT()` takes, which is exactly what this ADR recommends to an Agent as the cheap bounded
answer.

Salesforce answers a bare `COUNT()` with the value in `totalSize` and **no records at all**.
Verified live: `SELECT COUNT() FROM Account` returned `totalSize: 797, records: []`, and the
same shape came back for `COUNT()` on two other objects (4449, 349), so it is the response
shape rather than a property of a particular count. Reading `totalSize` as a row count there
made `fetched (0)` disagree with `totalSize (4449)`, and the Tool reported a **correct** count
as `complete: false, truncated: true, truncatedReason: PAGINATION_UNAVAILABLE` — telling the
Agent that the one query this ADR recommends as the fix for truncation was itself truncated.
That contradiction is what the live gate caught and what these two fields exist to remove:

- `aggregateValue` carries the scalar aggregate's value, and is `null` for every other shape.
- `totalSize` is `null` whenever the platform's number was a value rather than a row set, and
  is never asked to be both. The two fields cannot both be row counts, so the schema says so.

The distinction is `aggregate && !grouped && fetched === 0 && totalSize !== null`. Requiring
`fetched === 0` is what keeps the carve-out off the sibling shape `SELECT COUNT(Id) total FROM
X`, which returns one `AggregateResult` row and a `totalSize` of 1 — there the value really is
in the record and `totalSize` really is the row count. Requiring `!grouped` keeps it off a
grouped aggregate, which does have a row set and keeps the ordinary declared-short reading; a
grouped aggregate that stops short of its own `totalSize` is still `PAGINATION_UNAVAILABLE`.

`complete` for a scalar aggregate is therefore `done && !budgetCut` alone: there is no row set
to page through, and the value the platform reported is the whole answer. The hint states the
value explicitly, because `records` is legitimately empty and an Agent reading only the text
would otherwise see neither records nor a total and conclude the answer had been lost.

### Two budgets, each measured in the unit it is consumed in

The structured payload is bounded in **bytes** (262 144) because that is what the transport
carries; the text the Agent reads is bounded in **characters** (60 000) because that is what
the context window consumes. Both measure the **fully composed** output — including the hint
and the truncation flags that make the result honest — so a payload can never be pushed over
budget by its own explanation of why it is short. Composing is pure, so measuring a candidate
prefix and returning the final prefix are the same operation applied twice, and the
character-budget pass is applied to the byte-budget result, which is sound because both
measurements grow with the prefix.

Both passes bound the **same** `records` array, so the tighter one wins and the effective
payload limit is the smaller of the two for the rows in question. That is deliberate: the text
is a mirror of `records`, and a client that renders `structuredContent` into a context window
pays the character cost whether or not it reads the text, so bounding the array by characters
is what actually protects the consumer. The consequence is measured rather than theoretical —
`SELECT Id FROM IntermediateTable__c` carries a per-row `attributes` block, so the character
budget admits about 392 rows and the 262 144-byte budget is never reached on that object. An
Agent is told which budget bound it (`RESPONSE_BUDGET`) and what to do instead, which is the
guarantee this ADR is about; the byte budget remains the binding one for narrower rows.

### A hint may only name a Tool the session advertises

The Provider passes the session's enabled Tool names into the executor. A truncation hint
recommends `submit_bulk_query` (P9-T4) only when it is actually advertised; otherwise it says
to ask an administrator to enable the bulk capability. The same rule governs
`get_org_limits` (P9-T3) in the quota error message. Naming a Tool that `tools/list` does not
contain costs the Agent a turn to discover that, which is worse than a hint that names no Tool
at all.

### The continuation cursor is consumed inside the Tool, not handed out

`MCP_ENGINEERING_RULES.md` asks a list/query Tool to "return count plus `has_more` and a next
cursor/offset". This Tool deliberately does not return a cursor, and the reason is the ADR's
subject: the cursor is what the official Tool failed to consume. Returning it would move the
paging problem back to the caller, and the caller is an Agent that cannot be relied on to
notice, unprompted, that most of its result is missing. `query_records` absorbs the paging, and
what it returns instead
is the *completeness* of what it absorbed: `totalSize` (count), `fetched`, `returnedCount`,
`pages`, `done` and `complete`, plus a hint that states how to continue when the answer is not
complete. The rule's two goals — bound the response, and make truncation visible and
continuable — are met; its suggested mechanism is not, because here it would defeat the
purpose.

### The org object-usage guard is shared with the official SOQL path

`packages/sfoa-mcp-server/src/soql-usage-guard.ts` already refuses a USER SOQL query against a
standard object the org declares unused, because such an object commonly returns zero rows and
an Agent misreports that as "none exists". `query_records` runs the **same** guard, so the two
SOQL Tools cannot disagree about which objects are in use. It is decided from the statement
alone, before any Salesforce call: a blocked query opens no Connection and spends no round
trip, and it is audited as a `GOVERNANCE`-sourced `BLOCKED`/`DENIED` event.

### The statement rules, and where they are enforced

`stripSoqlStringLiterals` blanks single-quoted literals (treating `''` as SOQL's escaped quote)
before any rule is applied, preserving length so the resulting text still describes the
statement rather than the data inside it. A row filter such as `WHERE Name = 'a;b'` is a
legitimate query whose literal happens to contain a semicolon, and reading the raw text would
reject it for the wrong reason.

The rules are then: no unterminated literal, no semicolon outside a literal, must begin with
`SELECT`, and no `FOR UPDATE` (it locks the matched rows, which a read Tool must not do).
Violations are refused with `MCP_DATA_INVALID_INPUT` and a message naming the rule.

## Findings recorded from this task

**The enforcement split is real and is asserted from both sides** (extends ADR-0024's finding).
`queryRecordsInputShape` is the raw `.shape` of a non-strict Zod object, so:

- **Field-level bounds do hold at the wire.** `query`, `maxRows` and `useToolingApi` carry
  `min`/`max`/`int` constraints that reach the registered JSON Schema, so `maxRows: 0`,
  `maxRows: 50001`, a non-integer `maxRows` and an empty `query` are refused as invalid
  arguments and **no Connection is opened**. This is asserted by protocol test.
- **The statement rules cannot be a wire contract.** They need literal-aware scanning, so they
  are expressed as `queryRecordsInputSchema.superRefine(...)` and enforced in the Tool's own
  parse. The executor re-inspects the statement anyway, so a caller that reaches the executor
  without going through the Tool still cannot spend a Salesforce round trip on a statement the
  Tool refuses.
- **Unknown keys are inert.** As in ADR-0024, no identity parameter exists in the schema, and
  credentials cannot select an identity.

The default row budget is applied by the **executor**, not by the schema, so `maxRows` omitted
and `maxRows: 2000` are the same request by construction rather than by coincidence.

**`INVALID_TYPE` is a data/Tooling split more often than a typo.** The `INVALID_TYPE` /
`INVALID_FIELD` mapping therefore names the *opposite* API in its suggestion
(`useToolingApi=true` for a Tooling object, `false` for a business object), so a second attempt
is informed rather than a repeat of the first.

**The scalar-aggregate defect was found by the live gate, not by the unit tests** (see "A
scalar aggregate's value arrives in `totalSize`"). The stub Connection in the unit suite
returned the shape the code assumed — an aggregate with a row and a matching `totalSize` — so
every unit assertion held while the Tool contradicted its own advice against the real org. The
unit suite now pins the live shape (`queryBatch([], { totalSize: 4449 })`), and the live gate
cross-checks the scalar aggregate against the org's own bare `COUNT()` as well as against
`COUNT(Id) total`. The general lesson is the one the P9 plan already states: a stub can only
confirm that the code agrees with itself, so a claim about *Salesforce's* response shape has to
come from Salesforce.

**A gate must assert the contract, not a measured number.** The first version of the live gate
required the 500-row cap to return exactly 500 rows, which is true only for records narrow
enough to fit the character budget. On `IntermediateTable__c` it fetches 500 and returns 392,
which is the Tool behaving correctly. The gate now asserts what the contract actually
guarantees — the cap bound fetching, the returned slice is declared, and the declared reason
matches whether the payload cut it — because a gate that hard-codes a measurement becomes a
false negative the moment the input object changes.

## Consequences

### Positive

- An Agent can no longer mistake one batch for an answer: `complete` is either backed by
  `done && fetched === totalSize` or explicitly withheld, and every short answer names the
  constraint that shortened it.
- The official Tool is untouched, so the diagnostic route's contract and `validate:upstream`
  are unaffected.
- The two SOQL Tools agree about unused objects, so the org-usage guard cannot be side-stepped
  by switching Tools.
- Hints stay actionable: they name only Tools the session advertises.

### Negative

- SFoA owns the completeness, truncation and budget policy for a query Tool, because upstream
  supplies none of it. A change in how Salesforce reports `totalSize` or issues continuation
  cursors would be an SFoA defect, not an upstream one.
- The registered wire schema cannot carry the statement rules, so the input contract is
  enforced at two layers and both must be kept in sync; the tests assert both, but the split
  is a standing maintenance obligation rather than a solved problem.
- A `query_records` call may make many Salesforce round trips where `run_soql_query` made one,
  which is the point, but it also means a single Tool call can consume more of the org's API
  allowance.

## Rejected alternatives

1. **Wrap or fork `run_soql_query` to add paging.** Rejected for the same reason as ADR-0024:
   `run_diagnostic_tooling_query` depends on it, so changing its behaviour changes the
   diagnostic route's contract as a side effect.
2. **Register `query_records` under the name `run_soql_query`.** Explicitly forbidden by the
   task, and it would silently change the meaning of every existing grant: an Admin who
   enabled "SOQL" would get paging, budgets and a different error contract without opting in.
3. **Page with `OFFSET`.** The platform refuses `OFFSET > 2000`, and it rescans from the start
   on every page, so it is both unavailable past the first batch and the more expensive page
   mechanism where it does work.
4. **Treat `maxRows` as a performance hint and clamp it silently.** `maxRows` is a
   *completeness boundary*: the result states how many rows matched and whether all of them
   are present, and a silent clamp would make that statement false.
5. **Report `complete: true` whenever `done: true`.** This is precisely the GAP-D1 defect being
   fixed, one level down: Salesforce reports `done` for a result it also reports as larger than
   what it handed back.
6. **Return the whole result set and let the client truncate.** Unbounded output is forbidden by
   the task and by `MCP_ENGINEERING_RULES.md`, and a client that silently truncates recreates
   the original problem at a different layer.
7. **Enforce the statement rules only in the Tool, or only in the executor.** The Tool's parse
   cannot reach a caller that bypasses it; the executor's check cannot produce a protocol
   refusal. Both are needed for the guarantee actually claimed.
8. **Patch the official Tool's description to explain the coexistence.** Rejected: it makes the
   new Tool's justification an edit to an upstream file, which ADR-0001 and the P9 task both
   forbid.
9. **Read `totalSize` as a row count for every query, aggregate or not.** This is what the first
   implementation did, and the live run showed it reports a correct `COUNT()` as an incomplete
   result — the Tool contradicting the very advice it gives. Detecting "the number in `totalSize`
   is a value, not a count" needs the statement, so the inspection carries `grouped` alongside
   `aggregate` and the completeness rule branches on it.
10. **Withhold a scalar aggregate's value and tell the Agent to read `records`.** `records` is
    empty by the platform's design there, so this reports a successful query as a missing answer.
    The value is reported where it actually is, and named in the text as well.
11. **Relax the live gate's row-cap assertion to "fewer than 500 rows".** Rejected: it would pass
    for a Tool that returned one row, which is not a weaker claim but a different one. The gate
    asserts the contract — the cap bound fetching, the cut is declared, and the declared reason
    matches the measured cut — so it stays meaningful whatever the record width turns out to be.

## Gate

Acceptance follows ADR-0024: unit tests over a stub Connection, protocol tests for
disabled / enabled / refused-input / allowed, a live SFoA read whose facts match the org, a P7
audit evidence chain carrying no token or key material, and the P0–P8 regression set. Missing
live conditions stay `NOT TESTED`; they cannot be simulated into PASS.

The live gate is the `queryRecords` gate in
`packages/sfoa-mcp-server/src/validation/p9-live-validation.ts` (`yarn validate:p9`). Because
the Tool's whole purpose is a completeness claim the official Tool cannot make, the count it
is checked against is **the org's own `COUNT()`**, read over the same request-scoped
Connection and never produced by the Tool:

- a walk with the row budget set above the org's size must report `totalSize` equal to
  `COUNT()`, `fetched` equal to that total, `done: true`, and `complete` consistent with whether
  the response budget shortened the returned slice;
- a 500-row cap must report `fetched: 500`, `complete: false`, `truncated: true`, a
  `truncatedReason` of `MAX_ROWS` or — when the payload budget also cut the slice —
  `RESPONSE_BUDGET` with a hint naming both, a non-empty hint, and a hint that names no
  unadvertised Tool;
- `SELECT COUNT()` must come back `aggregate: true`, complete and untruncated, with its value in
  `aggregateValue`, `totalSize: null`, no records, and the same value the org's own bare
  `COUNT()` reports independently.

The gate requires an object holding more than one 2000-row batch and no more than the Tool's
50 000-row ceiling; outside that range it reports `NOT TESTED` with the reason, because a
one-batch object would exercise no continuation at all. A result that cannot be cross-checked —
an object the org will not `COUNT()` at all — is `NOT TESTED` with the org's error code rather
than a failed gate, because the alternative is to score a missing input as a defect in the Tool.
