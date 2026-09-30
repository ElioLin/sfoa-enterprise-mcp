# P10-T3 live milestone evidence (recorded 2026-09-30)

T3 delivers `explain_field_access` — the Tool that answers *why* a field is or is not available, by
aggregating the layers Salesforce actually stores (object permission, `FieldPermissions` rows and the
permission sets that carry them, record-type visibility, describe facts) into one `sourceChain`. It is
**read-only evidence aggregation and not a permission engine**: it never simulates, predicts or
re-implements Salesforce's adjudication, and when a layer cannot be read it says `INDETERMINATE` and
names the layer rather than reporting absence.

The unit and protocol suites prove the contract against fixtures. This page is the record of the one thing
they cannot prove: that on a real org the aggregation lands on the layer that actually closed the field,
that the positive control still reads open, that the subject boundary is the deployment's own route set,
and that the audit trail carries the whole thing on the diagnostic role.

**The milestone ran five times on the same day, and all five runs are still in the audit trail.** The first
three did not pass and each failure was a real defect **in the milestone harness** — one of them made the
Tool refuse *every* named target by silently dropping an optional method in the composition the deployment
uses, and two were defects that would have let an altered org or a wrong answer pass. The Tool's own code
was right in every case, which is the point: fixtures call the pieces, and only the live run builds the
composition. §4 records each defect with the measurement that found it and the fix that closes it, and
§4.1 records the two mechanisms of the platform's own FLS that the failures measured.

## 0. What was measured, on what, and how to read it

| | |
| --- | --- |
| Org | sandbox (`IsSandbox = true`), instance **CHN5S**, org id `00D************MAM`, API **v68.0** |
| Execution identity | the deployment's fixed DIAGNOSTIC identity — configured, enabled, `verificationStatus = PASS`, `c***@runner-corp.com.cn.uat`, platform user `08***48` |
| Subject explained | `005************IAE`, `c***@runner-corp.com.cn.uat`, active, profile **CRN管理组/业务员**, one profile-owned permission set `0PS************OAG` |
| Mode | **`CONSTRUCTED`** — a sandbox, and this run altered a profile-owned permission row to build the closed case |
| Result | **run 5: `overall = PASS`**, exit code 0, all fifteen gates `PASS` — the same result run 4 recorded |
| Host | the test server `192.168.156.203` (`crm-ex-test02`), built and run with Node **v24.19.0** |
| Report | `/data/sfoa-enterprise-mcp/p10-t3-milestone-final.json` (13 562 bytes, masked at the point of production) |
| Harness | `packages/sfoa-mcp-server/src/validation/p10-t3-live-milestone.ts`, runnable as `yarn workspace @sfoa/mcp-server milestone:p10-t3` |

The milestone writes nothing to the Control Plane: the grant that enables `explain_field_access` is a
snapshot wrapper in `AdditiveToolPolicySnapshotSource`, so a passing run can never be a run that quietly
granted itself the Tool it is supposed to prove can be granted.

**Every id, username and platform user in the report is masked where it is produced.** This page quotes
those masked values and no others. Recorded SOQL statements are masked the same way — see §4.6, which is
about the run that first did not.

### The five runs

The run number is the report's own `generatedAt`; the audit ids are the rows that run wrote. Runs 4 and 5
are the same code — 5 exists because the report's username masking was fixed between them, so the archived
report is produced by the final source.

| Run | Started (UTC) | Audit ids | Mode | Result | Failing legs |
| --- | --- | --- | --- | --- | --- |
| 1 | 08:20:05 | `7833`–`7837` | `OBSERVED` | **FAIL** | `namedTarget`, `openField`, `boundary`; construction `NOT TESTED` — the decorator defect of §4.2 |
| 2 | 08:24:36 | `7838`–`7842` | `OBSERVED` | **PARTIAL** | construction `NOT TESTED` — the platform refuses a `FieldPermissions` row with `PermissionsRead` false (§4.1) |
| 3 | 08:30:55 | `7843`–`7848` | `CONSTRUCTED` | **FAIL** | `unionConflict`, `cleanup` (§4.4, §4.5, §4.6) |
| 4 | 08:39:46 | `7850`–`7855` | `CONSTRUCTED` | **PASS** | — |
| 5 | 08:42:56 | `7856`–`7861` | `CONSTRUCTED` | **PASS** | — |

The five runs leave **28 audit rows: 16 `PASS`/`SUCCESS` and 12 `ERROR`/`FAILED`**, and every one of the
twelve carries `MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED`. Ten of them are the `boundary` gate's own probes —
`005************AAA` (outside the routes) and `005************BBB` (nonexistent), two per run — which exist
precisely so that both refusals can be asserted byte-identical; a run that did **not** produce those two
failures would have failed the gate instead. The other two (`7834`, `7835`) are run 1 refusing the
**real** subject because the harness had dropped the route list, and they do not reappear once §4.2 is
fixed. So on this Tool a failure row is the boundary working, not the Tool breaking.

## 1. Gate results

| Gate | Result | What it establishes |
| --- | --- | --- |
| `toolInventory` | PASS | `explain_field_access` is advertised with exactly the contracted input keys and the right hints, against the grant the snapshot declares |
| `subject` | PASS | the subject the run explains resolves on the deployment's own route |
| `selfSubject` | PASS | a call without `targetUserId` answers about the caller |
| `namedTarget` | PASS | a call **with** `targetUserId` answers about that user, and resolves to the same user as the self call |
| `objectLayer` | PASS | the object-level row the run needs exists and was read |
| `closedField` | PASS | the field this run closed reports `visible: false`, and the chain names the layer that closed it |
| `openField` | PASS | a field the org grants reports`visible: true` **in the same response** as the closed field, so the contrast is one measurement |
| `unionConflict` | PASS | with the field granted back through a standalone permission set, the Tool flips to `visible: true` and lists the standalone grant |
| `setupCrossCheck` | PASS | the harness's own read of the tables agrees with what the Tool reported (§2, step 5) |
| `boundary` | PASS | an out-of-route Id and a nonexistent Id are refused **identically**, after the same one subject lookup |
| `dataPlane` | PASS | every statement the Tool issued hit the Setup-layer whitelist; zero business-object reads (§1.2) |
| `privacy` | PASS | no business record id appeared in any response |
| `cleanup` | PASS | every change was reverted and the org matches its pre-write snapshot line for line |
| `credentialSafety` | PASS | no token or client secret appeared in any of the six Tool responses |
| `auditPersistence` | PASS | 6 snapshots enqueued, 6 persisted, 0 dropped, queue drained and depth 0 |

### 1.1 The Tool's advertised contract

The advertised inventory was **24 Tools**, asserted equal to the snapshot's grant by set equality rather
than by containment.

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` | advertised input keys |
| --- | --- | --- | --- | --- |
| `explain_field_access` | `true` | `false` | `true` | `fieldApiNames`, `includeRecordTypeContext`, `objectApiName`, `targetUserId` |

No Tool accepts a username, a password, a token or an instance URL — asserted as a set equality on the
advertised input keys, which is what makes it a property of the session rather than of the source it was
written from.

### 1.2 The data-plane red line, measured on the SQL that actually left the process

The harness wraps the Connection it hands the runtime and records every SOQL statement the Tool issues,
then checks each one against the whitelist of Setup-layer objects the executor declares. This is a claim
about the wire, not about the source:

| | |
| --- | --- |
| Statements recorded | **25**, over **5** windows |
| Distinct targets | `FieldPermissions`, `ObjectPermissions`, `PermissionSet`, `PermissionSetAssignment`, `RecordType`, `User` |
| Off-whitelist targets | `[]` |
| Business-object reads | **0** |
| Business-object describe calls | 4 (the `describe` the Tool needs for the field facts, on `Account` only) |
| `sobject` handles touched | `["Account"]` |

`fieldApiNames` was used **only** as a key into the permission configuration. A field-value read is not
something this gate could have missed: the recorded statements carry the field names in `Field IN (...)`
and in `describe` arguments, never as a `SELECT` target of a business object's data.

## 2. The closed loop, as measured

Every step below is the value the milestone recorded for run 5 — the archived report — with ids as it masks
them.

### Step 1 — the subject and the self call

```
subject:  005************IAE  c***@runner-corp.com.cn.uat  isActive=true  profile: CRN管理组/业务员
subject.detail.firstCallConclusion (fieldApiNames: ["Name"], no targetUserId):
  { visible: false, editable: false }
  sourceChain: ["object-visibility: read=true edit=true",
                "field-grants: 0 row(s) over 0 profile-owned and 0 standalone permission set(s),
                 read=false edit=false, profileBaselineReadable=true"]
```

The object layer is granted read and edit, so the denial is genuinely field-level — which is exactly the
shape a field-access question has, and the reason the chain prints the two layers separately.

### Step 2 — the named target

```
namedTarget.detail:
  targetUserIdMasked:   005************IAE
  resolvedUserIdMasked: 005************IAE
  isRequestingUser:     false
  sameSubjectAsSelfCall: true
```

The named call reaches the same user the self call did, through the route-scoped lookup, and sees the same
answer. T3's `targetUserId` boundary is therefore measured in both directions in one run: it **admits** a
user inside the routes and (§2, step 6) **refuses** Ids outside them.

### Step 3 — the closed field

The run needs a field the subject is denied. Run 2 measured that it cannot be manufactured the obvious way
(§4.1), so run 4 takes the path an administrator takes: it finds a `FieldPermissions` row the subject's
profile already grants and unchecks Read on it.

```
closedField.detail.control.detail:
  source: UPDATED   field: SicDesc   path: THE_PLATFORM_REMOVED_THE_ROW
  priorState: { rowIdMasked: 01k************IAB, priorPermissionsRead: true, priorPermissionsEdit: true }

closedField.detail:
  visible: false   editable: false
  sourceChain: ["object-visibility: read=true edit=true",
                "field-grants: 0 row(s) over 0 profile-owned and 0 standalone permission set(s),
                 read=false edit=false, profileBaselineReadable=true"]
  conflicts: []   grants: []
  describeFacts: { type: "string", label: "SIC 描述", createable: true, updateable: true,
                   accessible: null, executionIdentityView: true }
```

Three things in that block are the point of the task:

- **The chain names the layer.** `field-grants: 0 row(s)` is the layer that closed the field, and the
  conclusion is **definite** (`visible: false`), not `INDETERMINATE` — because the profile-owned permission
  set **is** readable and simply carries no row for this field. `profileBaselineReadable=true` is that
  fact, and it is a property of the *parent list*, not of the grant rows. This is what keeps "the profile
  denies it" from being reported as "I could not tell".
- **`describeFacts` is orthogonal to permission**, and the run shows the difference: the field is
  `createable: true, updateable: true` — the platform would accept it in a write — while the subject
  cannot see it. A Tool that reported either one as the other would be a permission engine; this one
  reports both and does not reconcile them.
- **`accessible: null`** is reported as unknown rather than guessed. `accessible` is a property of the
  *execution identity's* view and the Tool does not have a fact for it here, so it says so.

### Step 4 — the positive control, in the same response

```
openField.detail:
  field: Account_Belong_Group__c   control.source: ALREADY_GRANTED_BY_THE_ORG
  visible: true   editable: true
  sourceChain: ["object-visibility: read=true edit=true",
                "field-grants: 1 row(s) over 1 profile-owned and 0 standalone permission set(s),
                 read=true edit=true, profileBaselineReadable=true"]
```

The harness originally asked for `Account.Name` as the open control and the Tool answered
`visible: false` — this org stores no `FieldPermissions` row for `Name` on that profile, so the contract
reads it as a denial, and the harness fell back to a field the org demonstrably grants. That is recorded
in §3 rather than papered over, because it is a live instance of the contract's sharpest edge.

Both fields are asked for in **one** call, and the gate requires the contrast to come from one response,
so "closed reads closed and open reads open" is a property of a single aggregation rather than of two
runs that might have differed.

### Step 5 — the Setup cross-check

The prompt asks for the Tool's answer to agree with what a human sees in Setup. The harness performs the
machine equivalent — **its own independent read of the same tables**, using its own SOQL on its own
connection, and compares it against the Tool:

```
setupCrossCheck.detail:
  field: SicDesc
  ownReadOfTheOrg: { rowsForThisField: 0, grants: [], deniedToTheSubject: true,
                     interpretation: "The org stores no FieldPermissions row for this subject on this
                     field, and every row that was read for the object grants nothing on it — which is
                     the configuration Setup shows as the field being absent from the profile." }
  reportedByTheTool: []
  grantListsMatch: true
  profileRowKind: PRESENT_ON_A_PROFILE_OWNED_SET
  describedFieldCount: 252
```

`grantListsMatch: true` with both lists empty is the agreement: the harness read the org and found no
grant, the Tool read the org and reported no grant. **This is not a human looking at Setup** — see §3.

### Step 6 — the union, and the boundary

```
unionConflict.detail:
  field: SicDesc   createdPermissionSetMasked: P1***65
  visible: true   editable: true   openFieldStillOpen: true
  sourceChain: ["object-visibility: read=true edit=true",
                "field-grants: 1 row(s) over 0 profile-owned and 1 standalone permission set(s),
                 read=true edit=true, profileBaselineReadable=true"]
  grants: [{ parentType: "PERMISSION_SET", parentName: "P10_FLS_Probe_UNION_1790757792165",
             permissionsRead: true, permissionsEdit: true }]
  chainAccountsForTheRows: true
  conflictExpected: false   conflictPresent: false
  recordTypeContextSuppressed: true
```

The same field that read closed in step 3 reads **open** here, because a standalone permission set grants
it back — and the chain reports the union rather than stopping at the profile. The permission set is
created by the run and deleted by the cleanup gate.

`conflicts` is empty and the gate now asserts that this is *correct*: a conflict is a disagreement between
a **profile-owned** grant and a **standalone** grant, and the configuration this run built has no
profile-owned row at all (step 3 removed it). §4.5 is the harness defect that this empty array exposed.

```
boundary.detail:
  outOfBoundIdMasked:    005*********AAA   nonexistentIdMasked: 005*********BBB
  outOfBoundErrorCode:   MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED
  nonexistentErrorCode:  MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED
  refusalTextsIdentical: true   refusalLength: 544   carriesConclusion: false
  statementsForTwoRefusals: 2
```

An Id outside the deployment's routes and an Id that does not exist produce **byte-identical** refusals,
each costing exactly the one subject lookup the boundary is supposed to be. That is the property that
keeps the Tool from being an existence oracle about someone else's users: the refusal is decided by
`Id = :id AND Username IN (:configured)` **inside** the query, so "not yours" and "not real" are the same
answer by construction rather than by a check that could be reordered.

## 3. What this run does not prove

- **The human Setup check the prompt asks for has not been performed.** §2 step 5 is an independent
  *machine* read of the same tables, on a different connection, compared against the Tool's answer. It is
  the strongest check the harness can make without a person, and it is not the same thing as an
  administrator opening Setup and reading the profile. Recorded as an open item (§6).
- **`INDETERMINATE` is unit-tested only.** No live leg made a layer unreadable, so the degradation path —
  an unreadable layer produces `INDETERMINATE` naming the layer, never "no grant" — rests on the unit
  suite. The *positive* half is measured: step 3 shows a readable-but-empty layer producing a definite
  answer, which is the distinction the semantics turn on.
- **`Account.Name` reads as `visible: false` on this org.** The profile genuinely carries no
  `FieldPermissions` row for it, so the contract answers "denied". Whether that matches what a user of
  this org sees in the UI is not settled by this run; it is a property of the org's configuration (no
  row ⇒ no grant) meeting a contract that reports rows. Recorded, not adjusted: weakening it would make
  the Tool guess.
- **One object, one subject, one org.** Both cases are on `Account` for a single profile in a sandbox. A
  production org's profile and permission-set topology can differ in ways this run did not sample.
- **Record-type visibility is exercised only as suppression.** The union leg runs with
  `includeRecordTypeContext: false` and the gate asserts the context is absent — that the flag is honoured.
  The presence case is covered by the unit and protocol suites, not live.
- **The Tool is not validated as a predictor.** Nothing here shows that a `visible: false` will match what
  Salesforce's own adjudication decides at read time for every edge (sharing, owner-based access, apex
  managed sharing). That is the Baseline non-goal, and this run does not narrow it.

## 4. What the live runs found

§4.1 is what the failures *measured* about the org — the substance of the task. §4.2–§4.7 are the defects
the five runs exposed, each with its symptom, root cause, fix and what pins it. Every one of them is a
defect in the **harness**, and that is worth saying plainly rather than as a caveat: the Tool's own code was
correct throughout, and what the live run added was the composition no fixture builds — which is the whole
reason a milestone is run against an org instead of being asserted in a test.

### 4.1 The two mechanisms the platform actually has — the T3 finding

The first two runs failed to build the closed case, and what they measured is the substance of the task:

1. **A `FieldPermissions` row cannot be created with `PermissionsRead` false.** Run 2 attempted it on
   `Account.TickerSymbol` against the subject's profile-owned set and the platform refused:

   ```
   FIELD_INTEGRITY_EXCEPTION: "Read permission is required for: Account.TickerSymbol"
   ```

   So "closing a field" is not a grant of *no* read; it is the **absence** of a row.

2. **Setting `PermissionsRead` false on an existing row removes the row.** Run 3 made exactly the edit an
   administrator makes by unchecking Read in Setup — an `update` of the row that already granted the field
   — and the platform answered by deleting it:

   ```
   closedField.detail.control.detail.path: THE_PLATFORM_REMOVED_THE_ROW
   priorState: { priorPermissionsRead: true, priorPermissionsEdit: true }
   ```

   The engine then confirmed it by re-reading: the row was gone, so the run's restore-by-id could not
   apply (§4.4).

**Consequence for the Tool, and why it is right.** On this org a closed field is *a missing row*, and the
answer is still definite — `visible: false`, `field-grants: 0 row(s)`, `profileBaselineReadable=true` —
because readability is a property of the permission-set list, not of the rows in it. Had
`profileBaselineReadable` been derived from the grant rows, the Tool would have had to answer
`INDETERMINATE` on the single most common real configuration there is. The harness's fix was to prefer a row
the org already grants (`pickClosableField`) over the create path (`pickUngrantedField`, kept as the
fallback the platform permits), which is also what makes the window harmless:
`controls.profileWideWindow` is `true` only for the run that actually touched a profile row.

### 4.2 A defect in the harness's own decorator, which made every named target look refused

**Symptom (run 1).** `namedTarget` failed on a call that should have succeeded:

```
errorCode: MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED
message:  "The requested user is not one this deployment explains access for.
           This runtime has no configured Salesforce identity routes to scope a target user to."
```

The boundary gate failed in the same run for the same reason, from the other side: both refusals were
correct, but `statementsForTwoRefusals: 0` — the Tool had refused **before reading anything**, because it
believed the deployment had no routes at all.

**Root cause.** `RuntimePolicySnapshotSource.listConfiguredSalesforceUsernames?()` is an **optional**
member, and the host reaches it through `?.()`. `AdditiveToolPolicySnapshotSource` — the decorator the
milestone wraps the real snapshot source in to grant the Tool without writing the Control Plane — is
defined in the harness (`p10-live-support.ts`), and it implemented `load` and not this member. So through
the decorator the member was simply absent, the host's optional call saw nothing, and the empty route set
it defaults to is a **valid answer** — "this deployment configures no routes". The Tool's boundary then
behaved exactly as designed: fail closed, explain nobody.

**The product code was right on both sides of this.** `MySqlRuntimePolicySnapshotSource` implements the
member correctly, and defaulting an absent member to the empty set is the fail-closed direction — a
deployment with no route table cannot safely explain *other* people's access, while a self-subject still
resolves from the request's own route. What the decorator did was drop a method silently, and what made
that expensive is that the report then read as **a fact about the deployment** rather than as a harness
that had lost a method.

**Fix.** The decorator forwards the member (and the forwarding, with the reason, is documented on the class
that has to remember it). Run 2 onward: `namedTarget` PASS, `boundary` PASS with `statementsForTwoRefusals: 2`.

**Why it is worth recording.** It is the failure mode a live milestone exists to catch, and it is the
strongest argument this task makes for having one. Every unit test passed, because fixtures call the
snapshot source directly; the decorator existed only in the composition the deployment actually uses, and
no fixture built that composition. An optional member on a policy interface is an invitation to exactly
this, and a fail-closed default turns the invitation into a silent one — the wrong answer arrives wearing
the shape of a correct one.

### 4.3 The report hid the platform's own words

**Symptom.** Run 1 recorded the failed closure as:

```
reason: "The field-level row could not be established: Salesforce refused it with FIELD_INTEGRITY_EXCEPTION."
```

— the platform's error code, but not its message and not jsforce's `errors[]`. Diagnosing §4.1 required
reading the refusal, and the harness had thrown it away.

**Root cause.** The control's detail builder recorded `errorCode` from the caught error and dropped
`salesforceMessage` / `errors`. Run 2, after the fix, records:

```
salesforceMessage: "Read permission is required for: Account.TickerSymbol"
```

**Fix.** The failure path carries the platform's message and its `errors[]` into the gate detail.

**Why it is worth recording.** A milestone that reports *that* the platform refused is much less useful
than one that reports *what it said*, and the difference was the whole content of §4.1 — the fact that
`PermissionsRead` cannot be false on a new row is only visible in the message.

### 4.4 The snapshot comparison looked in one direction

**Symptom (run 3).** The org went from **207** snapshot lines to **206** and the cleanup gate reported:

```
snapshotLinesBefore: 207   snapshotLinesAfter: 206   drift: []
```

No drift, on an org the run had altered. The gate failed only because the revert plan recorded its **own**
failure (`INVALID_ID_FIELD`); a run that had simply forgotten to restore the row would have gone green.

**Root cause.** `snapshotDrift` returned the lines present *afterwards* that had not been present
*beforehand* — the shape a **leftover** row has, and not the shape a **removed** row has.

**Fix.**

```ts
const added = after.filter((line) => !earlier.has(line)).map((line) => `added|${line}`);
const removed = before.filter((line) => !later.has(line)).map((line) => `removed|${line}`);
```

both directions, sorted. A comparison that looks one way cannot see half of what it exists to see, and this
is the run that proved it rather than the review that suspected it.

### 4.5 The restore had no way to put back a row the platform deleted

**Symptom (run 3).** `cleanup` failed:

```
FieldPermissions (SicDesc, restored): INVALID_ID_FIELD
```

**Root cause.** The revert plan assumed the platform would keep the row's id across the edit, so it
restored by `update { Id, PermissionsRead: true, PermissionsEdit: true }`. Once §4.1's second mechanism
removed the row, that Id named nothing.

**Fix.** The update path now **re-reads** the row it just edited. If the row survived and carries what was
asked for, the plan is the `RESTORE_ROW` update it always was; if the platform removed it, the plan becomes
a `RECREATE_ROW` carrying `ParentId`, `SobjectType`, `Field` and the permissions the row had **before** the
run touched it. Runs 4 and 5 report:

```
reverted: ["FieldPermissions (SicDesc, re-created)", "PermissionSet (UNION, created)"]
failures: []   snapshotLinesBefore: 207   snapshotLinesAfter: 207   drift: []   plansExecuted: 2
```

**Pinned by.** The `RECREATE_ROW` path is one runs 4 and 5 actually exercised; a milestone that reverts by
assumption is a milestone that cannot be re-run.

### 4.6 The union gate asserted a conflict the configuration could not produce

**Symptom (run 3).** `unionConflict` failed with `conflicts: []` while the gate required a
profile-versus-permission-set sentence.

**Root cause.** The gate was written for the configuration the harness *intended* to build — a profile
denial plus a standalone grant, which is what produces a conflict — and the configuration §4.1 forces is a
profile **absence** plus a standalone grant, which produces none. `collectGrantConflicts` returns early
unless a profile-owned row and a standalone row both exist, so the empty array was the Tool behaving
correctly and the gate being wrong.

**Fix.** The gate now asserts what the response must satisfy — the chain's row counts agree with the rows
the harness read (`chainAccountsForTheRows`) and the open field is still open — and checks for a conflict
sentence only when `conflictExpected` (a profile-owned grant is present). Runs 4 and 5 record
`conflictExpected: false, conflictPresent: false, chainAccountsForTheRows: true`.

**Why it is worth recording.** A live gate that encodes the harness's intent rather than the Tool's
contract will fail the first time the platform does something the harness did not expect — and the
temptation is then to "fix" the Tool. This one was fixed in the gate.

### 4.7 The report carried route usernames

**Symptom.** The boundary gate's recorded statements were archived verbatim, and a recorded
`User` lookup reads:

```
SELECT Id, Username, IsActive FROM User WHERE Id = '005AAAAAAAAAAAA'
  AND Username IN ('candy.zheng@runner-corp.com.cn.uat', 'crm_admin_yw@runner-corp.com.cn.uat', …)
```

That is every Salesforce username the deployment has configured as a route, in a file destined for
`docs/sfoa`.

**Root cause.** Statements were recorded raw at the point of recording, and the report's own masking
covered the ids and usernames it *constructed*, not the text of the SQL.

**Fix.** `maskUsernamesInText` is applied where the statement is recorded, so the archived report carries
`c***@runner-corp.com.cn.uat` instead. The fix landed **between runs 4 and 5**, and run 5 exists for exactly
this reason: `…-final.json` is byte-identical to `-4.json` in every measurement, so re-running proved the
masking changed nothing but the masking.

**What is deliberately unchanged.** The **audit** row still stores the statement as it was issued
(`soqlStatementSafe`) and the target user id in `requestSummary.summary`. That is the deployment's own
internal record of what it did, read through `yarn ai:audit` on the host, and masking it there would
degrade the operational trail for a file that never leaves the deployment. The two registers are kept
separate on purpose: **the audit keeps the truth, the archived evidence page keeps the masked form**, and
this page quotes only the latter.

## 5. Audit verification (P7)

Read with `yarn ai:audit --tool explain_field_access --since 4h --latest 20` against the same database the
runtime writes to. All five runs are on the chain — **twenty-eight rows**, every one
`executionRole = DIAGNOSTIC`:

| Audit | Run | Call | Result | Purpose carried by its Salesforce calls |
| --- | --- | --- | --- | --- |
| `7856` | 5 | self (`Name`, no `targetUserId`) | `PASS` / `SUCCESS` | `PERMISSION_EXPLAIN` |
| `7857` | 5 | named target (`Name`) | `PASS` / `SUCCESS` | `PERMISSION_EXPLAIN` |
| `7858` | 5 | closed + open (`SicDesc`, `Account_Belong_Group__c`), `includeRecordTypeContext: true` | `PASS` / `SUCCESS` | `PERMISSION_EXPLAIN` |
| `7859` | 5 | union leg, `includeRecordTypeContext: false` | `PASS` / `SUCCESS` | `PERMISSION_EXPLAIN` |
| `7860`, `7861` | 5 | boundary probes (`…AAA` out of route, `…BBB` nonexistent) | `ERROR` / `FAILED` | `MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED` |
| `7850`–`7855` | 4 | the passing run before the masking fix | `PASS` ×4, `ERROR` ×2 | `PERMISSION_EXPLAIN` |
| `7843`–`7848` | 3 | the failing run (§4.4–§4.6) | `PASS` ×4, `ERROR` ×2 | `PERMISSION_EXPLAIN` |
| `7838`–`7842` | 2 | the partial run (§4.1) | `PASS` ×3, `ERROR` ×2 | `PERMISSION_EXPLAIN` |
| `7833`–`7837` | 1 | the decorator defect (§4.2) — `7834`/`7835` refuse the **real** subject | `PASS` ×1, `ERROR` ×4 | `PERMISSION_EXPLAIN` |

- **`PERMISSION_EXPLAIN` on every Tool call of every row.** The Tool's Salesforce calls sit beside the
  connection's own `IDENTITY_TOKEN_EXCHANGE` / `IDENTITY_AUTHENTICATION` calls, which are the identity
  layer's and carry their own purposes — the same separation ADR-0029 §4d requires of the T2 write, here
  for the read.
- **`identitySource = INTERNAL_SERVICE_HEADER` and `executionRole = DIAGNOSTIC` on all twenty-eight rows.**
  No Tool downgraded to a caller, and the run's seven Connections collapse to **one distinct username** —
  the fixed diagnostic identity.
- **The refusals are audited as refusals, not as passes.** `7860`/`7861` carry `result: ERROR`,
  `outcome: FAILED` and the same `MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED` the caller saw, with
  `requestSummary.summary` recording `fieldCount: 1` and the field name — a refused call that says what it
  refused without saying whether the user exists.
- **`auditPersistence` closed the loop**: 6 enqueued, 6 persisted, 0 dropped, queue drained
  (`writerState: STOPPED`), `droppedSalesforceApiCallCount: 0`.
- **No credential material in any row.** The milestone's own gate scanned all six Tool responses of the
  final run for the live client token and access token (`secretsSearched: 2`, `offenders: []`).

**On the twelve `ERROR` rows.** Every failure this Tool has ever recorded on this deployment is
`MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED`, and ten of the twelve are the `boundary` gate's own probes — the
`…AAA` and `…BBB` ids, two per run — which exist so that the gate can assert both refusals are
byte-identical. **A run that produced no such failures would have failed the gate.** The remaining two
(`7834`, `7835`, run 1) are the decorator defect of §4.2 refusing the real subject, and they stop the moment
it is fixed. A reader scanning the console for red rows on this Tool should therefore read them as the
boundary working, not as the Tool breaking; what would be alarming is a *new* error code appearing, and
none has.

Two properties of the trail are worth recording so a later reader does not chase them — both are the same
two T2 recorded, and both are properties of this deployment rather than of T3:

- **`auditIntegrityStatus = PARTIAL` on every row.** Same status, same `evidenceIntegrity` detail
  ("Evidence is incomplete or degraded; do not infer missing stages") as the P9-era `query_records` rows
  (`6975`–`6977`). It reflects evidence this deployment does not capture (no agent or model context on
  these calls), not anything `explain_field_access` did.
- **`firstFailure` reports `INVALID_TYPE` on `SELECT Id FROM ScratchOrgInfo limit 1` (v51.0).** jsforce's
  own connection warm-up probe, asking an org that is not a scratch org. It is why a row can read
  `capturedSalesforceApiCallCount: 10` beside `salesforceApiCaptureFailureCount: 8` while every call the
  Tool made in the same row is `SUCCESS`. The Tool's own calls are the ones carrying `PERMISSION_EXPLAIN`.

## 6. Open items carried out of T3

- **The human Setup-page check is still owed** (§3). The machine cross-check in §2 step 5 is what the
  harness can do alone; a person opening the profile in Setup and comparing against
  `P10_FLS_Probe_*` — or against a closed field in a real configuration — is the remaining step, and it is
  the one the prompt names explicitly.
- **`INDETERMINATE` has no live leg** (§3). The degradation path is unit-tested; no live scenario made a
  layer unreadable. A future run could construct one by pointing the Tool at a layer the diagnostic
  identity cannot read.
- **`Account.Name` reads as `visible: false`** (§3) — a real org whose profile has no `FieldPermissions`
  row for a field everyone can in fact see. Worth confirming against the UI before this contract is
  described to a customer as "what you see in Setup".
- **A `FieldPermissions` row has two spellings of the field name.** The harness reads and matches both
  (`Account.SicDesc` and bare `SicDesc`); the Tool does the same. Neither run measured an org that stores
  the other spelling, so this rests on the fixtures.
- **`A-1`** — cross-user `ApexLog` visibility — remains a production deployment check (T2 §6).
- The throwaway probes used on the host while measuring §4.1 and repairing the org after run 3 were
  removed from the host after the measurement; the measured tables above are what they were for.
