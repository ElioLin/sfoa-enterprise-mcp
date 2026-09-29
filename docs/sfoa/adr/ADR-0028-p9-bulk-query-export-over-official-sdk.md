# ADR-0028: the P9 Bulk API 2.0 export reads query jobs through the official SDK's `Connection.request`

- Status: Accepted for P9
- Date: 2026-09-29
- Extends: ADR-0024 the P9 data provider over the official SDK, ADR-0025 bounded completeness and the hint rule, ADR-0026 quotas and streaming limits, ADR-0027 `get_org_limits` on the DIAGNOSTIC identity (whose option (b) this ADR takes), ADR-0009 the server-owned DIAGNOSTIC request scope, ADR-0005 remote Tool governance

## Context

P9-3 / GAP-D2 is the one gap the first three P9 tasks leave open: **a detail export of a large
object has no bounded path through a REST SOQL query at all.** `query_records` exists to make
`run_soql_query`'s single-request answer honest, and it does that by following
`nextRecordsUrl` — but a REST query is capped at 2000 rows per batch, its continuation cursor
eventually stops, and the caller's row budget ends the walk early. "Every row of this object,
and I can tell you how many" is therefore not a question any existing Tool can answer.

The Salesforce surface for it is Bulk API 2.0 query jobs: Salesforce runs the statement
server-side and the caller reads the result set page by page afterwards. What that costs, in
this repository, is set by two pre-existing constraints rather than by preference:

- **The runtime is stateless HTTP** (`sessionIdGenerator: undefined`). A two-call export
  (submit, then read) cannot keep the job on the server. The job lives in Salesforce, the
  caller holds the `jobId`, and every later call re-states it.
- **P7 audits every Salesforce wire attempt** through `jsforce-audit-adapter`, which patches
  `Transport.prototype.httpRequest`. Any read path that does not go through a jsforce transport
  is invisible to the audit trail, and the tool contract forbids that.

## Decision

### Two Tools, both `READ`/`USER`, both default-disabled

`submit_bulk_query` creates a query job and returns its `jobId`; `get_bulk_query_results` polls
the job's state and, once it is `JobComplete`, reads one page of rows. Both are
`ReleaseState.GA`, `Toolset.DATA`, absent from `DEFAULT_ENABLED_TOOLS`, and registered as
`'USER'` in `SFOA_DATA_TOOL_ROLES` — a Bulk query job belongs to the identity that created it,
so the request's USER identity is the only scope that can read an export it started, and a
non-USER route is refused by `DataToolFacade` before either Tool runs. Neither accepts a
username, token, instance URL, org selector or API version.

### `operation` is fixed to `query` inside the provider, so the DML Bulk operations are structurally absent

`submit_bulk_query`'s input schema is `{ query }` and `.strict()`. `operation` is **not an
input**: the provider always sends `operation: 'query'`. A Bulk ingest, upsert, update or delete
is therefore not merely rejected — there is no input through which it can be expressed, which is
what makes `readOnlyHint: true` a claim about the code rather than about the review.

The statement is the same SOQL the rest of the package accepts: it must begin with SELECT, must
contain no `;` outside a string literal, and must not use `FOR UPDATE`, checked by
`inspectSoqlQuery` in the executor as well as in the schema (ADR-0024). `submit_bulk_query` is
also covered by the org object-usage guard, for the reason `query_records` is: a Bulk job over
an org-declared-unused standard object returns zero rows just as quietly, and an export is the
answer an Agent is least likely to re-check.

### The job state is never stored, and no result set is ever returned in one response

Three properties follow from the stateless runtime, and each is a contract the caller can rely
on rather than an implementation note:

1. **No server-side job state.** Nothing about an export survives a request — no table, no
   in-memory cache, no session. `jobId` and `locator` are the caller's to hold.
2. **One page per response.** Every answer carries exactly one page plus the cursor that reaches
   the next one, so the size of an export is bounded by the caller's loop rather than by a
   single response.
3. **A page is never returned partially.** See below — this is the decision with the most
   consequence.

### A cut page is re-read from the same cursor, never handed back shortened

The byte budget bounds a slice, and the obvious implementation — return the rows that fit and
the cursor — is **wrong**, in a way specific to this API: the `Sforce-Locator` cursor Salesforce
returns points *past the page it served*, not past the rows that fit. Returning a cut page with
that cursor would silently skip every dropped row, which is precisely the failure a
completeness-oriented export must not have.

So when the budget cuts a page, the Tool re-requests a **smaller page from the same cursor**,
asking for exactly the number of rows that fit. A smaller page is a prefix of the larger one, so
each attempt's fitting count strictly decreases; the loop is bounded at `PAGE_FIT_ATTEMPTS = 5`
so a pathological row shape cannot spin, and a single row that cannot fit produces
`MCP_BULK_SLICE_TOO_LARGE` with a suggestion to narrow the projection rather than a truncated
answer. `maxRecords` is therefore documented as an **upper bound, not a promise**.

Because the retry is another wire call, this decision has a quota cost — recorded under
Negative consequences, not hidden.

### The read goes through `Connection.request`, because the two facts the Tools need exist only in headers

The `Sforce-Locator` cursor and the `Sforce-Limit-Info` API-usage counter are **response
headers and nothing else**. The SDK's public `bulk2` surface cannot reach either:

- `QueryJobV2.result()` streams *every* page of a result set into one stream and keeps the paging
  cursor in a private field — it has no bounded page read at all;
- `createJob()` is ingest-only, so it cannot create a query job and return just its Id;
- `HttpApi` reads the response headers and never exposes them: the parsed body is all a caller
  receives.

`connection.request(request, { transport })` is the SDK's own lower-level entry point and the
one place a header is observable: `HttpApi` does `this._transport = options.transport || conn._transport`
and then `this._transport.httpRequest(...)`. The provider passes a wrapper that **delegates the
request unchanged** and copies the headers out of the pending stream's `'response'` event. That
keeps the call inside the official client:

- jsforce injects the `Authorization` header **before** the transport is reached, so this code
  path never sees, holds or logs a credential;
- the URL is version-relative (`/jobs/query…`) and is expanded by the SDK, so no instance URL
  or API version is assembled here;
- the P7 adapter still intercepts the request, and `classifySalesforceApiUrl` already maps
  `/jobs/…` to `BULK_API`.

The wrapper is typed against a **structural** shape (`ObservableTransport`,
`ObservablePending`, `ObservableResponse`) declared in the provider rather than imported from
`salesforce-core` or a jsforce internal module path, so the package keeps its single declared SDK
dependency and no deep import. The one cast in the path is
`{ transport: observing } as unknown as RequestOptions`, because `Connection.request` publishes
its options as `JsonMap` — a JSON value type that cannot name a function, and therefore cannot
describe an option the SDK's own code reads. `RequestOptions` is `Parameters<Connection['request']>[1]`,
so the cast names the SDK's published contract rather than `any`.

### The audit purpose is `BULK_QUERY`, on both halves, with the statement on the submission only

A new `SalesforceApiPurpose` value names the surface rather than folding the export into
`USER_QUERY`: the transport classifier already assigns these calls `BULK_API`, and a purpose of
`USER_QUERY` would leave rows whose purpose and category name different surfaces. Both Tools
share it, because a submission audited under one category and a result read under another would
leave the trail unable to answer "what did this export cost and what did it read".

The **submission** carries a statement, so it is bound to `DATA_SOQL` through
`SOQL_STATEMENT_TOOLS` and records `soqlStatement`/`objectApiName` exactly as `query_records`
does. The **result read** names a job Id rather than a statement, so it is deliberately absent
from that map: recording a query that never reached Salesforce would be worse than recording
none. What the request summary adds is the shape the semantic cannot show — `jobId`, `locator`
and `maxRecords` for a page read, `useToolingApi`/`maxRows` for the submission — and the
response summary adds the export's own facts (`state`, `jobId`, the two counters, `totalRecords`,
`hasMore`). The platform's free-text `stateMessage` and the Tool's `hint` are deliberately **not**
recorded: the failure a trail has to name is already in `errorCode`, and both are prose the Tool
is the right place to read.

### Quota: ADR-0027 option (b), taken literally

ADR-0027 established that the DATA Tools cannot open a DIAGNOSTIC Connection internally, and
that no business identity this deployment routes may read the `limits` resource — so the
pre-flight ADR-0026 had planned for T4 **cannot work as written**. This ADR takes option (b):

- there is **no pre-flight check**;
- the quota fact reported is the one the Bulk response itself carries — `Sforce-Limit-Info`,
  parsed into `apiUsage { used, limit, remaining }` on the response the Tool just made;
- a refusal that *is* about the allowance maps to `MCP_BULK_LIMIT_EXCEEDED` and names
  `get_org_limits` **only when the session advertises it**, through the same
  `advertisedToolNames` gate ADR-0027 introduced.

### A failed job is an error, not an empty result

`get_bulk_query_results` reports the platform's state machine
(`UploadComplete` | `InProgress` | `JobComplete` | `Failed` | `Aborted`) and withholds any
completeness claim while the job is still running: `locator`, `hasMore` and `complete` are
**omitted** rather than reported as `false`, because "there is no next page" and "there are no
rows yet" are the same shape to a caller that reads only the fields, and only one of them is
true. A job that ended `Failed` or `Aborted` is returned as an `isError` result carrying the
platform's own `errorMessage` (query jobs report their reason there; ingest jobs use
`stateMessage`; both are read), because "the job failed" and "the job matched nothing" are
opposite facts. A job belonging to another identity is refused by Salesforce and that refusal is
mapped to `MCP_BULK_ACCESS_DENIED` with the instruction to report it — there is no cross-identity
penetration and no attempt to work around the refusal.

## Deviations from the P9 plan's wording

Recorded per the P9 execution convention, which requires any deviation from the approved plan to
appear in an ADR and in the changelog:

1. **`fetchedCumulative` is omitted.** The plan listed it as an output field "if obtainable".
   With no server-side job state it is not obtainable *honestly*: the Tool cannot know how many
   rows earlier calls returned, and inventing a cumulative count from `numberRecordsProcessed`
   would be a completeness claim the export cannot support. What is reported instead is
   `totalRecords` (the platform's `numberRecordsProcessed`) and `returnedCount` for this page, so
   the caller sums its own calls and can state the total itself. A field that is always wrong is
   worse than a field that is absent.
2. **All three calls are REST calls through `Connection.request`**, not a mix of
   `bulk2.job(...).check()` for the state and REST for the rest. `check()` cannot inject a
   transport, so it would capture neither header — and mixing two clients for one job would mean
   the audit row set depends on which half of the pair is running.
3. **No `get_org_limits` pre-flight**, per ADR-0027 option (b) above. The plan's step 3 is
   rewritten rather than deferred.
4. **`get_bulk_query_results` is not a `HINT_TOOL_CANDIDATES` entry** in the live validation: the
   gate reaches it through the `jobId` the submission returned, so a hint-driven candidate list
   is not what exercises it.
5. **The export gate's 100 000-row floor is overridable**, because the deployment this ADR was
   first run against **cannot supply an object that large**. Every one of the org's 523 queryable
   objects was counted over the live Connection: the largest is `ContactShare` at 74 660 rows, the
   largest business object is `Contact` at 37 496, and 12 objects exceed 10 000. The floor's stated
   purpose is to make the walk a walk — to distinguish a loop that paged to the real end from one
   that stopped early by luck — and 37 496 rows at the default 2 000-row page is 19 pages and 19
   cursor advances, which meets that purpose while the literal number does not. So
   `P9_LIVE_BULK_MIN_ROWS` may lower it, bounded below at 10 000 (five pages) so the override
   cannot manufacture a green run, and the run reports `minimumRows`, `minimumRowsSource` and
   `plannedMinimumRows` together so a PASS at a reduced scale is never mistakable for a PASS at the
   planned one. This is the P9 convention applied honestly: a deviation recorded rather than
   silently taken, and the acceptance requirement of 100 000 rows remains **unmet** until an org
   with such an object runs the gate.

## Consequences

### Positive

- GAP-D2 closes with the invariant that mattered: the caller can export a result set of any size
  and **state** how many rows it holds, because every page says how many rows it carried and
  whether another page exists.
- The export works over the stateless HTTP runtime with nothing stored server-side, so it needs
  no session affinity and no cleanup.
- Both halves stay inside the official SDK and inside the P7 audit pipeline, and the Bulk surface
  gets its own audit purpose rather than being filed as a SOQL query.
- Deleting `operation` from the input makes the DML Bulk operations unreachable, which is
  stronger than validating them away.
- The quota answer needs no identity widening: the response the Tool already made carries it.

### Negative

- **A budget-cut page costs a second wire call.** The never-partial rule is correct and it is not
  free: when the response budget cannot fit what Salesforce served, the page is read twice. In
  the ordinary narrow-projection case this never happens (2000 rows of a few fields fit well
  inside 256 KiB); a wide row shape pays one extra call per cut page.
- **`maxRecords` cannot be honoured as a promise.** It is an upper bound, because the binding
  constraint is the byte budget rather than the count. A caller that sizes its calls against the
  API allowance will over-estimate slightly in the cut case.
- **A row wider than the response budget is unexportable.** `MCP_BULK_SLICE_TOO_LARGE` is a real
  refusal, not a truncated answer, and the remedy is to narrow the projection — the Tool cannot
  stream a single row across calls.
- **Bulk query jobs consume a separate org allowance.** `DailyBulkV2QueryJobs` sizes how many
  jobs may run; a caller that submits a job per question rather than reading the first one to
  completion can exhaust it. The Tool's hints say not to resubmit, but nothing enforces it.
- **The transport wrapper depends on one internal behaviour of the SDK**: `HttpApi` preferring a
  caller-supplied `transport` over the Connection's own. It is pinned by the upstream
  compatibility gate (`validate:upstream`), and a drift would be a test failure rather than a
  silent loss of the cursor — but it *is* a coupling to an implementation detail of a
  third-party library, and it is why the wrapper is documented at the call site.
- **`get_org_limits` remains a context Tool**, so the quota remedy a Bulk refusal names is a
  Tool that may not be enabled; the hint handles that by re-wording rather than by naming a Tool
  the session cannot call.

## Rejected alternatives

- **Return the rows that fit and the platform's cursor.** One line shorter, and it silently drops
  rows: the cursor points past the page Salesforce served, not past the rows that fit. Rejected
  on correctness — this is the defect the Tool exists to avoid.
- **Follow the cursor internally and return everything in one response.** Violates the tool
  contract's response budget, and it would make the export's size a function of one response
  rather than of the caller's loop.
- **Keep server-side job state (a table or an in-memory map) so `fetchedCumulative` becomes
  computable and the caller only holds a session id.** Forbidden by this task, and correctly so:
  it would make an export survive a request in the one runtime designed not to, and would need
  expiry, ownership and multi-process consistency — all to avoid the caller keeping a string it
  already has.
- **Use `connection.bulk2` and accept whole-result streaming.** `QueryJobV2.result()` streams all
  pages and hides the cursor, so the Tool could neither bound a response nor report where the
  next page starts; `createJob()` cannot create a query job at all.
- **Reach the transport by importing `@jsforce/jsforce-node/lib/transport.js`** (as the P7
  adapter's own test does) to call `httpRequest` directly. It would add a second declared SDK
  dependency and a deep import into a package whose contract is `@salesforce/core` only, to
  avoid one documented cast.
- **Expose `operation` and validate it to `query`.** Rejection is weaker than absence: a
  validator with a bug becomes data loss, and the schema would advertise a capability the
  deployment does not want to have.
- **Do the quota pre-flight over the USER Connection anyway** (ADR-0026's original wording).
  Measured to fail: `Connection.limits()` answers `API_DISABLED_FOR_ORG` for every business
  identity this deployment routes. ADR-0027 option (a) — a separate `get_org_limits` call — is
  available to a *caller*, and the hint says so, but it is not something the Bulk Tools can do
  internally without opening a scope they are forbidden to open.

## Gate

Acceptance follows ADR-0024/0025. Without a live org: the submission's exact request body, the
four statement rules, the state machine (`UploadComplete`/`InProgress` → no rows and no
completeness claim; `JobComplete` → a page and a cursor; `Failed`/`Aborted` → a structured
failure; an unknown state → `unknown`), cursor continuation, the two budgets and the
same-cursor re-request (asserted to be exactly two result reads with the retry between 0 and
100), the failure-reason mapping, the access refusal on a foreign job, the `advertisedToolNames`
gating of every hint, and the strict-input refusals — all in the provider's unit suite; plus the
protocol surface (`tools/list` absence while disabled, a submit → fetch closed loop through the
real Streamable HTTP runtime, the governance block, the `TOOL_TERMINAL` summaries) and the
audit purpose/category pinning in the classifier suite.

With a live org: the export gate in `packages/sfoa-mcp-server/src/validation/p9-live-validation.ts`
runs a locator loop to exhaustion against an object at or above the run's row floor, cross-checks the
summed `returnedCount` against a `COUNT()` read independently, and records the elapsed time and
the `apiUsage` the responses reported — the row-count cross-check being the only evidence that
the paging really delivered every row. The floor is 100 000 rows unless `P9_LIVE_BULK_MIN_ROWS`
lowers it (deviation 5), and the run states both the applied floor and its source. Until the run
is executed on a deployment with a routeable identity, the gate reports `NOT TESTED` and the run's
`overall` is `PARTIAL`; no part of it is asserted from the unit suite.
