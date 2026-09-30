# P10-T0 live probe findings (recorded 2026-09-30)

The six P10 Tools all run on the server-owned DIAGNOSTIC identity, and every one of them reads a
surface a business integration identity cannot: ApexLog, TraceFlag, DebugLevel, SetupAuditTrail and
the permission tables. P9 learned the cost of assuming that the expensive way — `get_org_limits` was
designed against a belief about what a routed identity could read, the live probe disproved it, and
the Tool had to be re-homed onto the DIAGNOSTIC scope ([ADR-0027](adr/ADR-0027-p9-org-limits-diagnostic-identity.md)).

So the prerequisites are measured before anything is built on them, and the measurement is recorded
here the same way P9 recorded its own. **Measured fact and inference are in separate columns
throughout.** P9's findings document had to correct an inference that had been written as a fact; the
split is the structural fix for that, so a reader can always tell which half of a row a later run
could overturn.

The probe is not a throwaway this time. It is `packages/sfoa-mcp-server/src/validation/p10-diagnostic-probe.ts`,
kept in the repository and runnable as `yarn workspace @sfoa/mcp-server probe:p10`, so T2–T6 and any
future deployment can re-measure rather than re-trust this page. It opens exactly the Connection the
Tools open — `snapshotDiagnosticRoute` over the runtime's own request-scope factory, the pairing
`http-server.ts` uses for a DIAGNOSTIC `tools/call` — because opening it any other way would measure a
different identity than the Tools run on.

## 0. What was measured, on what, and how to read it

| | |
| --- | --- |
| Org | sandbox (`IsSandbox = true`), `OrganizationType` **Base Edition**, instance **CHN5S**, org id `00D************MAM` |
| API version | **v68.0** for every standard, Tooling, Metadata and REST call unless a row says otherwise |
| Execution identity | the deployment's fixed DIAGNOSTIC identity, `c***@runner-corp.com.cn.uat` — configured, enabled, `verificationStatus = PASS` |
| Probe mode | `SANDBOX_WRITE_ALLOWED` (the org reports `IsSandbox=true`, which is the only thing that turns the write legs on) |
| Outcome | **36 `AVAILABLE` · 5 `DENIED` · 0 `ERROR` · 0 `SKIPPED` · 0 `NOT_PROBED`** |

The five `DENIED` rows are all *expected refusals* and four of them are the boundary evidence the red
line needs; a refusal carrying a Salesforce code is a fact about the org, not a probe failure. The
probe classifies by code, and `ERROR` is reserved for a failure that carries no Salesforce code — that
is, the probe itself being wrong. Exit status follows only `ERROR`, because an `AVAILABLE`/`DENIED` mix
is precisely the measurement.

**Production safety.** The write legs are gated on the org's own answer, not on an operator's
intention: `writeProbesAllowed` returns false whenever `IsSandbox` is not true, and the
`P10_PROBE_WRITE_PROBES` variable can only force *off*, never on. A production org is measured
read-only and every write leg reports `NOT_PROBED` with the reason. This run needed that switch for
real — see §2.

## 1. ApexLog — the execution-log source (T2)

Query, `ApexLog` describe, the `LogUser` relationship, and the log body over
`GET /services/data/v68.0/tooling/sobjects/ApexLog/{id}/Body`.

| Measured fact | Inference |
| --- | --- |
| The Tooling API exposes **13** `ApexLog` fields, all nine the P10-2 query needs present: `Id, LogUserId, LogLength, LastModifiedDate, Request, Operation, Application, Status, DurationMilliseconds, SystemModstamp, StartTime, Location, RequestIdentifier`. | A field list can be written against this org rather than against documentation. The list is fixed per API version, so T2 should still describe-then-select and fail loudly on an `INVALID_FIELD`, the way P9's queries do. |
| **The log body is not a SOQL field** (`bodySelectableThroughSoql: false`). It is reachable only as a separate HTTP call, returning a **string** (1 214 bytes / 25 lines in the sampled row). | `get_debug_log_body` needs its own bounded text budget and its own truncation semantics rather than being a field of `get_apex_logs` — which is independent confirmation of the plan's decision to keep them two Tools. |
| `LogUser` is traversable in the same query (`LogUser.Name`, `LogUser.Username` all resolved). | A log list can attribute each row without an N+1 second query. |
| **The log header carries its own API version, and it is not the org's**: the org answers v68.0 while the sampled log header opened `56.0 …`, and an earlier run of the same probe sampled a log whose header opened `54.0 …`. | A log parser must read the version from the log's own first line and dispatch on it. Hardcoding the org's API version would parse two of the three observed formats wrongly. This is the single most likely silent-corruption bug in T2 and it is why the parser must branch on the header. |
| `ApexLog.Status` is **translated**: of 9 retained rows, `Status = 'Success'` matched **1** and `Status = '成功'` matched **8**. | Filtering logs on the English literal silently drops ~89 % of rows and returns a plausible-looking short list. T2 must not filter on a status literal at all, or must map the localized values from a measured set. See §6. |
| The org retains few logs. Across runs the retained set moved from 5 rows (newest 2026-09-24) to 9 rows (newest the minute of the run). | Retention is short and its size is not a property T2 can rely on. `get_apex_logs` must treat "few rows" and "no rows" as different states and never let an empty list imply "no errors". |
| Log rows appeared **during** the probe, created by the probe's own `TraceFlag` writes. | The probe is not invisible to what it measures. Any T1/T2 evidence taken from `ApexLog` counts has to account for the act of taking it. |

## 2. TraceFlag — P10's only write (T2)

Query first, then four create-then-delete legs, each deleting exactly the row it created **and
re-reading to confirm it is gone**.

| Measured fact | Inference |
| --- | --- |
| `TraceFlag` exposes **23** fields; `TracedEntityId`, `LogType`, `DebugLevelId`, `StartDate`, `ExpirationDate` are all present and all queryable. | The create payload can be built from measurement. |
| **9 pre-existing flags**, tracing four distinct Users and carrying the same `DebugLevelId`. The oldest dates from **2015-08-13**. Every one except the currently-open flag is long expired. | Salesforce does not garbage-collect expired flags, so "the flag list" is cumulative history and a query against it must filter by window rather than assume a small set. T2's lookup must not read "a row exists for this entity" as "a trace is active". |
| Creating a `CLASS_TRACING` flag on an `ApexClass` **succeeds**; cleanup verified by re-read (`cleanupVerifiedAbsent: true`). | Class tracing is available to this identity. |
| Creating a `DEVELOPER_LOG` flag on a **different** user (`005…IAU`) **succeeds**; cleanup verified by re-read. | **The single most load-bearing permission for P10's usefulness is present.** A support engineer's actual need is tracing *someone else's* session, and this identity may do it. Had this been refused, T2's contract would have been undeliverable as designed. |
| Creating a `DEVELOPER_LOG` flag on the identity's **own** user is **refused**: `FIELD_INTEGRITY_EXCEPTION`, *"a trace flag is already tracing this entity, with a start and expiration that overlap this one"*, naming traced entity `005************IAE`. The same entity is the target the probe attempted, and an open flag for it exists (start `2026-09-30T01:56:04Z`, expiry `2026-09-30T04:01:04Z`). | **`set_trace_flag` cannot be create-only.** It must look for an existing flag covering the requested window and extend/replace it, or the Tool's most ordinary call — trace yourself for the next hour — fails the second time it is used. This is a design-changing finding, and it is recorded as a revision note in the T2 section. |
| Creating a `DebugLevel` (developer name `SFOA_P10_PROBE`) **succeeds**; cleanup verified by re-read. | The "no stored level matches, so create one" branch of P10-1 is deliverable. |
| **The probe's own cleanup was insufficient in an earlier run**, and this run is what caught it: a `destroy` returned success while the row survived, and the *next* run then found the leftover flag and was refused by it. The probe now re-reads after every delete and reports `cleanupVerifiedAbsent`. | A successful delete is a claim, not a measurement. This is exactly the class of defect T1 exists to find in itself — the instrument reported `cleanupSucceeded: true` on a row that was still there. |
| The pre-existing open flag's window is 125 minutes longer than the 60-minute window the probe sends (`StartDate`/`ExpirationDate` as sent vs as stored: `01:56:04 → 04:01:04`). | **Not established.** Salesforce may recompute or round the window, or the row is not the probe's. What is *measured* is that an open flag exists for that entity and that an overlapping create is refused. The mechanism is left open rather than guessed; see the note at the end of this section. |

**On the unattributable flag.** The open flag for `005…IAE` is consistent with a previous probe run's
leaked row, but the 125-vs-60-minute window does not match what the probe sends, so this document does
not claim it as the probe's. It was deliberately **not deleted**: deleting a row that cannot be
attributed is the more dangerous act, and the flag expires on its own at `2026-09-30T04:01:04Z` (about
two hours after the run). The instrument defect that allowed a leak is fixed regardless of whose row it
was.

## 3. DebugLevel — one stored level, and it samples (T2)

| Measured fact | Inference |
| --- | --- |
| Exactly **one** `DebugLevel` exists: `SFDC_DevConsole`, with `ApexCode: DEBUG`, `System: DEBUG`, and **`ApexProfiling: INFO`** — the sampling level, not `FINEST`. | The org's only stored level has the one setting P10 cannot use. A diagnostic profile that needs full profiling requires a dedicated level, and §2 shows the identity can create one. T2 should create-or-reuse a level by developer name rather than depend on `SFDC_DevConsole` existing or being configured correctly. |
| The prompt asked for the existing developer-name list and **no creation**. | Honoured for every *pre-existing* level — all of them read-only. The probe creates one level under its own name, `SFOA_P10_PROBE`, and deletes exactly that row, because otherwise the "no matching level, so create one" branch stays unmeasured and it is on the critical path. This is a deliberate deviation, recorded here and in ADR-0029. |

## 4. SetupAuditTrail — change provenance (T5)

| Measured fact | Inference |
| --- | --- |
| Readable by the diagnostic identity, rows returned, newest `2026-09-30T02:03:40Z`. | The change-provenance source P10-6 needs is available. |
| Oldest retained row: **`2026-04-08T07:40:48Z`**. | The honest window for any "what changed" claim is bounded by roughly five and a half months on this org, and the bound is discovered by reading the oldest row rather than by any stated policy. Salesforce exposes no retention setting to SOQL. |
| Filterability is **per field, not per object**: `CreatedDate` **YES**, `Action` **YES**, `CreatedById` **YES**, `Section` **NO**, `Display` **NO**. The refusals are `INVALID_FIELD` — *"field 'Section' can not be filtered in a query call"*. | A timeline that narrows by "just the Apex changes" cannot use `Section`, which is the field whose *name* most suggests it. T5 must filter on `Action` and window on `CreatedDate`, and must not offer `Section` as a filter. |
| `SELECT COUNT(Id) FROM SetupAuditTrail` is **refused** (`MALFORMED_QUERY`: *"field Id does not support aggregate operator COUNT"*). `SELECT COUNT()` is accepted, returns an **empty `records` array**, and reports **`totalSize: 260911`**. | Two traps in one: the obvious aggregate is rejected, and the accepted one puts the count where the record list is not. Code reading `records[0].expr0` gets `undefined` and would report zero. There is no `expr0` and no alias — the count lives in `totalSize`. |
| `Action` values are stable English enums (`changedApexClass`, `suOrgAdminLogin`, `suOrgAdminLogout`) while `Section` values are **translated** (`Apex 类`, `管理用户`). | `Action` is safe to filter and match on; `Section` is not safe even where it *is* readable. Combined with the `ApexLog.Status` finding in §1, this is one consistent rule for P10: **never match on a human-readable Salesforce label; match on the API enum.** |

## 5. AsyncApexJob / CronTrigger — async and schedule sources (T5)

| Measured fact | Inference |
| --- | --- |
| `AsyncApexJob` readable with `Status`, `JobType`, `ApexClass.Name`, `NumberOfErrors`, `ExtendedStatus`; 152 `Completed` rows, **0** `Failed`/`Aborted` in the queried window. | Readable, so P10-6's async-failure section is deliverable. A zero here is a genuine zero, which is why the Tool must still distinguish it from an unreadable source. |
| `CronTrigger` readable with `CronJobDetail.Name`, `State`, `NextFireTime`, `PreviousFireTime`, `TimesTriggered`; **0 rows**. | Readable, but this deployment has **no scheduled jobs at all**. The scheduled-stall section of P10-6 is therefore `AVAILABLE`-but-unexercised on this org: it can never be observed working here, and an empty result is the correct and *expected* answer rather than a signal. This is the case where "never silently return empty" is most tempting to get wrong, because here empty is right. |

## 6. Permissions — the FLS attribution source (T3)

The question this decides is whether `explain_field_access` can answer about a **named other user**
(`targetUserId`) or only about the caller and the org's configuration.

| Measured fact | Inference |
| --- | --- |
| `FieldPermissions` readable; `SobjectType`, `Field`, `PermissionsRead`, `PermissionsEdit` all returned. | The FLS attribution source is available at the row level. |
| The polymorphic parent **traverses in one query**: `SELECT ParentId, Parent.Name FROM FieldPermissions …` resolved with `attributes.type: "PermissionSet"`. | A grant can be attributed to its owning permission set or profile without a second round trip, and the `attributes.type` discriminator says which of the two it is. |
| `ObjectPermissions` readable including `PermissionsViewAllRecords`; 3 of 20 sampled parents carry View All. | Object-level and View-All facts are attributable, so a "this user effectively sees everything via View All Data" explanation is expressible. |
| `PermissionSetAssignment` readable, 20 distinct assignees in a 20-row sample. | The assignment table is readable at all. |
| Reading a **specific other user's** assignments by `AssigneeId` returned **1** row. | **Cross-user reads work.** A non-zero count is proof; zero would have been ambiguous, and the probe records it as ambiguous rather than as a denial. So `targetUserId` is technically available to `explain_field_access` — the boundary it needs is a *design* choice, not a permission wall. |
| `PermissionSet` readable (`IsOwnedByProfile`, `Profile.Name` present); `Profile` readable, **65** rows. | Both grant owners are reachable by name. Profile names are translated (`系统管理员`, `标准用户`), so the same label rule as §1/§4 applies. |
| `describe` on `Account` reports 252 fields, 199 createable, 199 updateable — **for the calling identity**. | `describe` can never stand in for another user's FLS. Any Tool that mixed a `describe` result into a target user's explanation would silently report the diagnostic administrator's own permissions as the user's. This is the specific correctness trap T3 must avoid: **read `FieldPermissions` rows, never `describe`, when the subject is someone else.** |
| `RecordType` readable with `DeveloperName`, `SobjectType`, `IsActive`; the sample includes an **inactive** record type (`Account.WRN`, `isActive: false`). | Record-type visibility is attributable, and the active flag is real data rather than a constant — a record-type fact must carry it. |

## 7. Metadata API — `listMetadata` (T4)

| Measured fact | Inference |
| --- | --- |
| `metadata.list([{ type: 'ValidationRule' }])` returns **245** components; `NamedCredential` **3**; `Profile` **65**. | `listMetadata` is available to this identity for all three probed types, so P10-4's listing surface works. |
| Entries carry `lastModifiedByName`, `fileName` and `manageableState` for `ValidationRule` and `NamedCredential` — but **`Profile` carries no `manageableState`**. | The metadata entry shape is per-type, not uniform. A listing contract that declares a required `manageableState` field would fail on `Profile`; T4 must model it as optional per type rather than assume the union. |
| `fullName` values are **localized and URL-escaped**: `风控负责`, `WRN业务员%2F业务主管%2F市场开发`, `SHRN工程管理总监%2F项目经理`. | Metadata component names round-trip through a screen format the caller will not expect, and any Tool that echoed a `fullName` back for a follow-up retrieve must pass it through unmodified — a decoded `/` would address a different component. |
| A **Tooling** query reaches `ValidationRule` too, returning `LastModifiedDate` and `EntityDefinition.QualifiedApiName`. | Two live routes to the same component class with different provenance: Metadata API gives `lastModifiedByName`/`manageableState` (who and how packaged), Tooling gives a queryable `LastModifiedDate` and an entity join. They are complementary, which is a reason for T4 to keep both rather than replace one with the other. |

## 8. Localization — the cross-cutting trap

Runs through §1 and §4; collected here because it is one rule rather than two incidents.

| Measured fact | Inference |
| --- | --- |
| `ApexLog.Status`: total 9, English literal matched **1**, localized literal matched **8**. | A filter on the English label returns a short, plausible, wrong list. |
| `SetupAuditTrail.Section`: localized (`Apex 类`, `管理用户`). `Action`: English enums. `Profile.Name`: localized. | Machine values are English and safe; presentation labels are translated and unsafe. |
| Every one of these is a **silent** failure — no error, just fewer rows. | This is the same failure mode the ADR-0029 degradation contract exists to prevent for permissions. Its remedy here is different: P10 Tools must match on API enums and must never present a localized label as a filter or a comparison key. |

## 9. Boundary — the §0.3 red line, measured (ADR-0029 input)

The red line's structural half says business record rows are unreachable from the diagnostic Tools
because the Tooling API does not carry them. One standard object is not enough to establish that: the
Tooling API documents support for custom objects, so `Lead` being refused while `Value_Bill__c` was
answered would be exactly the hole that turns `run_diagnostic_tooling_query` into a business-data path.

| Measured fact | Inference |
| --- | --- |
| Tooling `SELECT Id FROM ApexClass LIMIT 1` → **`AVAILABLE`, 1 row**. | The control: a *system* type resolves through the very same call, so the refusals below are about the objects and not about the API being closed to this identity. |
| Tooling `SELECT Id FROM Lead LIMIT 1` → **`DENIED / INVALID_TYPE`**: *"sObject type 'Lead' is not supported."* | — |
| Tooling `SELECT Id FROM Account LIMIT 1` → **`DENIED / INVALID_TYPE`**, same message. | Standard business objects are structurally refused. |
| Tooling `SELECT Id FROM Value_Bill__c LIMIT 1` → **`DENIED / INVALID_TYPE`**, same message. | **A custom business object is refused identically.** The documented custom-object support does not extend to these. |
| Tooling `SELECT Id FROM Order__c LIMIT 1` → **`DENIED / INVALID_TYPE`**, same message. | Two independent custom objects, same answer, so this is not one object's quirk. |
| Standard API `SELECT COUNT(Id) FROM Lead` over the same Connection → **955 rows**. | The *identity* can reach business data; only the *Tooling API* cannot. The red line therefore rests on the API's structural refusal **plus** the Tool-code whitelist — not on the identity being weak. A future code path that reached the standard API from a diagnostic Tool would not be stopped by anything the org does. |
| `GET /services/data/v68.0/limits` → **73 keys**. | ADR-0027's finding reproduces: this identity reads the resource every business identity was refused. |

## 10. Facts the design must be revised around

Four measured facts contradict or extend the plan. Each is carried into ADR-0029 and flagged as a
revision note in the corresponding T2–T5 section of `P10_EXECUTION_PROMPTS.md`; the original prompt text
is left intact.

1. **`set_trace_flag` cannot be create-only** (§2). An overlapping create is refused; the Tool must
   find and extend an existing flag.
2. **The Apex log parser must follow the log's own header version** (§1) — two distinct log format
   versions (54.0, 56.0) were observed against a v68.0 org.
3. **No P10 Tool may match on a human-readable Salesforce label** (§8) — `Status`, `Section` and
   `Profile.Name` are translated in this org.
4. **`SetupAuditTrail` counts live in `totalSize`, and `COUNT(Id)` is refused** (§4).

## 11. Not settled by this probe

- **Why the diagnostic identity's own-user trace is blocked by an open flag whose window does not match
  the probe's** (§2). The refusal behaviour is measured; the window arithmetic is not explained. It is
  recorded as an open item rather than guessed, and it does not change the design conclusion, which only
  needs the overlap to be possible.
- **Whether ApexLog visibility here comes from View All Data or from ownership.** The identity reads 9
  rows whose `LogUser` is the identity itself, so **every log this probe could see was its own**. That is
  consistent with ownership alone and does not demonstrate `View All Data`. ADR-0029 therefore treats
  "can the diagnostic identity read logs written by *another* user" as a **production enablement check to
  perform**, not as an established fact — the same class of self-correction P9 made about `limits()`,
  and the reason the check is written into the deployment list instead of assumed.
- **The platform's log retention policy.** Only its current effect (the oldest retained row) is
  measured; no policy is exposed to SOQL.
- **`get_metadata_component_context`'s allowlist and the P10-5 widening to 22 types.** Only three
  metadata types were probed, as samples. The other 19 are T4's to measure, and ADR-0029's per-type
  prerequisite table is written so a new type is added by measuring it rather than by extending a claim.
