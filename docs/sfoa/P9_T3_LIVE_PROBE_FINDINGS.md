# P9-T3 live probe findings (recorded 2026-09-28)

Throwaway probe run against the live org through the harness's own request-scoped Connection
(one identity route selected from inside the Control Plane; four routes tested for `limits()`).
The probe code was deleted after the run; these are its recorded facts, the same way ADR-0024
records its findings.

## 1. The limits resource is refused to every identity SFOA can currently route

`Connection.limits()` fails with:

```
API_DISABLED_FOR_ORG  "limits resource is not enabled"
```

Established by measurement:

- Identical for 4 distinct enabled identity routes.
- Identical for the raw REST path `/services/data/<version>/limits` at `v68.0`, `v62.0`,
  `v58.0`, `v50.0`.
- `GET /services/data/v68.0/` lists ~50 root resources — `metadata`, `query`, `search`,
  `tooling`, `sobjects`, … — and **`limits` is absent**.

**What this does not establish.** All four routes are integration identities of this one
deployment sharing a profile shape, and **no administrator identity was ever tested**. So "the
org does not expose the resource" is an inference, not a measurement; what is measured is that
no identity SFOA can currently route is allowed to read it. An earlier draft of this document
and of ADR-0026 called it org-wide, which claimed more than the probe showed.

**The likely cause is a missing permission, not an org-wide switch.** Two facts point the same
way. `API Enabled` is provably present — the same identities run `query`, `describeGlobal` and
`search` successfully, and a missing `API Enabled` reports a different code
(`API_CURRENTLY_DISABLED`, "API is disabled for this User"). And `limits resource is not
enabled` is the code Salesforce returns when the connecting user lacks **View Setup and
Configuration**, a read-only permission about org setup that grants no change. It would also
explain the uniformity across four identities, since they share a profile.

A second candidate is the identity's **user licence type**: some restricted licences cannot be
granted `View Setup and Configuration` at all, which would make it unfixable without
reprovisioning the user. Our own result is weak evidence that something here is non-standard,
since several sources state that current API versions no longer produce this error and we
reproduce it on `v68.0`.

**Settled by one request — and `get_org_limits` is now that request.** As an administrator,
`GET /services/data/v68.0/limits` settles it: a JSON body means the permission is the whole story,
the same 403 means it is not. **The Tool now runs on exactly that identity class.** After this
finding was recorded, `get_org_limits` was moved to the server-owned DIAGNOSTIC identity (the
deployment's fixed administrator identity) and to the context Provider, so the administrator
request this section asks for is the Tool's own execution path, under the P7 audit pipeline — see
[ADR-0027](adr/ADR-0027-p9-org-limits-diagnostic-identity.md). The answer is therefore no longer
deferred to an off-platform check: the `orgLimits` live gate measures it. It still cannot assume
it, and the gate still refuses to report `PASS` unless the read actually succeeds.

Consequence: `get_org_limits` is correctly implemented but cannot return data through any identity
SFOA routed at the time of this probe. Its live gate reported `NOT TESTED` with the Salesforce code
rather than `PASS`, because a refusal is not a successful read. With the Tool on the diagnostic
identity the gate is enabled whenever the Control Plane carries an enabled, verification-passed
diagnostic row, and it becomes a real `PASS` only if that identity can read the resource. Until
then the P9-3 → P9-4 dependency recorded in the gap analysis (Bulk pre-flight reads the quota)
cannot be satisfied here, so T4 must treat a quota pre-flight as best-effort — and, per ADR-0027,
cannot implement it as a USER-side `limits()` call at all.

## 2. `Connection.search()` returns records and nothing else

The resolved payload has exactly one key, `searchRecords`. There is **no** `totalSize`, no `done`,
no cursor, and no matched-count field. `search()` is a `StreamPromise<SearchResult>` but `await`
yields the `SearchResult` directly.

Consequence: completeness cannot be read off the response; it has to be derived from whichever
explicit cap the statement carried. This is what `limitSource` / `effectiveLimit` exist for.

## 3. A returned record is identified by `attributes.type`

Each record carries `attributes: { type, url }`, where `type` is the object API name
(`"Account"`, `"Lead"`, `"Value_Bill__c"`) and `url` is
`/services/data/v68.0/sobjects/<Type>/<Id>`. **`attributes.sobjectType` is absent** in this
org's responses, so grouping reads `type` (with a fallback chain for key-case differences).

Multi-object results are real: `FIND {test} IN ALL FIELDS` returned 56 records spanning
`Value_Bill__c`, `Material_Master__c`, `Product__c`, `Account_ITEM_Product_Relation__c`,
`Contact` and `User`.

## 4. A bare `RETURNING <Object>` returns only `Id` — it is a locator, not a search

| statement | keys on the first returned record |
| --- | --- |
| `… RETURNING Account` | `attributes`, `Id` |
| `… RETURNING Account LIMIT 5` | `attributes`, `Id` |
| `… IN ALL FIELDS` (no RETURNING) | `attributes`, `Id` |
| `… RETURNING Account(Id, Name)` | `attributes`, `Id`, `Name` |

So the parenthesised field list is optional in the grammar but **not** "all fields": omitting it
yields exactly `Id`. This overturned the plan's assumption that the bare form returns the object's
fields. The consequence is designed around, not worked around (see ADR-0026): the Tool names a
field list, defaulting to `Id, Name`, so a keyword search returns readable rows rather than opaque
ids the caller must chase with a second query.

## 5. A default `Id, Name` field list fails on objects that have no `Name`

```
FIND {co} IN ALL FIELDS RETURNING Case(Id, Name) LIMIT 5
→ INVALID_FIELD  "No such column 'Name' on entity 'Case'. … reference your WSDL or the describe call"
```

Same for `Task`. The error is clean and names the column and the remedy, so it maps to the
existing `MCP_SEARCH_FIELD_INVALID` shape and points at `describe_sobject`. This is the accepted
cost of the readable default: objects without a `Name` need an explicit field list.

## 6. SOSL rejects a one-character search term

```
FIND {a} IN ALL FIELDS → INVALID_SEARCH  "search term must be longer than one character: a"
```

Therefore `INVALID_SEARCH` maps to `MCP_SEARCH_MALFORMED`, and its suggestion names the minimum
term length alongside the syntax example. No length rule is invented in the schema, because the
platform's exact rule for multi-word terms was not established.

## 7. SOSL fails transiently

`FIND {co} IN ALL FIELDS` returned `SERVER_UNAVAILABLE  "Search unavailable"` on one attempt
while a structurally identical statement succeeded on another. A transient platform fault must map
to an actionable "retry" suggestion rather than to a malformed-input verdict, and the live gate
must distinguish it from a real failure.

## 8. Duplicate clauses are syntax errors

`… RETURNING Account RETURNING Contact` → `MALFORMED_SEARCH  "Malformed search token: RETURNING"`,
and `… LIMIT 2 LIMIT 3` → `MALFORMED_SEARCH  "Malformed search token: LIMIT"`. So a well-formed
statement carries at most one of each, which is why reading the outermost `LIMIT` as the
whole-result cap is sound.

## 9. Not settled by the probe

- The platform's default cap for a statement with **no** `LIMIT` (a no-LIMIT query returned 56
  records, so the cap is above that and was not reached). It does not need settling: keyword mode
  always appends a `LIMIT`, and for a pass-through clause the Tool reports
  `limitSource: 'UNSPECIFIED'` rather than asserting a cap it cannot see.
- The audit shape of a `/search` call (endpoint path, API category, whether a capture failure is
  recorded). The probe's searches ran outside a Tool request, so they are not representative. This
  is settled by the `search_records` live gate's own audit evidence instead.
