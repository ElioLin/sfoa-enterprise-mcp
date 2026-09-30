# ADR-0031: The P10 permission-attribution Tool — the `targetUserId` boundary, the third state, and what a live run may write

- Status: Accepted for P10
- Date: 2026-09-30
- Extends: ADR-0029 (the diagnostic identity's prerequisites, the degradation contract, §0.3's role/data
  red line and §4a's per-Tool query whitelist), ADR-0027 (`get_org_limits` on the DIAGNOSTIC identity),
  ADR-0024/ADR-0025/ADR-0026 (bounded completeness, explicit truncation, structured errors), ADR-0009 (the
  server-owned DIAGNOSTIC request scope), ADR-0030 (the T2 Toolset this one is shaped after)
- Evidence: [`P10_T0_LIVE_PROBE_FINDINGS.md`](../P10_T0_LIVE_PROBE_FINDINGS.md) §6 (describe answers for the
  *calling* identity), §1 (localized stored labels), plus the T3 live milestone recorded in §8 below

## Context

T3 delivers **GAP-M2**: `explain_field_access`, a Tool that answers "why can this user see or edit that
field" from the org's own permission configuration rather than from a prediction. It exists because the
question an administrator actually gets is about *another person*, and the identity that runs SFoA's
diagnostic Tools is a fixed service account whose own field-level security is not that person's.

That framing produces the whole design, and it produces the two ways the Tool could be worse than useless:

- **It could be a permission simulator.** Re-implementing Salesforce's adjudication means shipping a
  second, subtly different decision procedure, and a wrong "yes" from it would be acted on. The prompt's
  non-goal 1 forbids it. The unit of this Tool's answer is therefore *a grant read from the permission
  tables*, and the conclusion is a reading of that set — never a prediction of what the platform will do.
- **It could be an account-access reconnaissance surface.** Unbounded, `targetUserId` lets a caller
  enumerate an org's users and read back each one's permission sets and profile. The prompt's prohibition
  2 forbids accepting arbitrary Ids, and ADR-0029 §1 makes the boundary a **design choice rather than a
  permission wall**: T1 measured that the diagnostic identity *can* read another named user's
  `PermissionSetAssignment`, so nothing in Salesforce stops this Tool from answering about anyone. The
  bound is the deployment's own policy.

`P10_EXECUTION_PROMPTS.md` left the aggregate's output shape, the off-sandbox behaviour and the boundary's
implementation to be decided during implementation. This ADR records those decisions, the four places the
implementation departs from the prompt's draft, and the reading of `INDETERMINATE` that the whole Tool
turns on. The prompt text is left intact in the plan; the departures are also recorded as a revision note
before the T3 section, per §0.3.

## Decision

### 1. The subject-scoped facts are carried once at the top level, not inside each field

The prompt's draft output puts `userContext` and `recordTypeContext` inside every `fields[]` entry. They
are top-level keys in `explainFieldAccessOutputSchema` instead: one object and one subject per call, so
neither can differ between the ten fields, and a per-field copy would multiply a fixed block — the
subject's permission-set list, which is the largest thing in the response — by the field count. That is
precisely the shape the truncation contract exists to avoid: a response that spends its budget restating
facts and then truncates the facts that vary.

`includeRecordTypeContext: false` **omits the whole key** rather than returning an empty array. A caller
has to be able to distinguish "I switched this off" from "I asked for it and the layer could not be read";
the second is `availableToSubject: 'INDETERMINATE'`, and it is the only value that key can take (§5).

### 2. `INDETERMINATE` is a third state, and it is a string

`conclusion.visible` / `conclusion.editable` are `true | false | 'INDETERMINATE'`
(`FIELD_ACCESS_INDETERMINATE`). Not `null`, not a sentinel boolean: "the layer that would have decided
this was never read" is not a value of the same type as an answer, and ADR-0029 §3 forbids collapsing it
into `false`. The cost of the shape is that the string is truthy, so a consumer writing
`if (conclusion.visible)` reads a gap as a grant; the renderer and the builder are both asserted against
`=== true` / `=== false`, and that is the one trap this shape carries.

### 3. The object layer decides everything beneath it, and an unread object row is the common case

`ObjectPermissions` is aggregated three ways, not two — `aggregateFlag` returns `null` when **no row was
read at all**, because Salesforce materialises object rows for profiles but not for every permission set.
A `null` object read makes **every** field on that object `INDETERMINATE`, named in the `sourceChain` as
`object-visibility: unreadable` and in `hint` via `indeterminateLayerName()`.

This is not an edge case, it is the ordinary state of a quiet org, and it is the single behaviour most
likely to be mistaken for a defect: a caller runs the Tool, sees ten `INDETERMINATE` fields and concludes
the Tool is broken. It is the Tool being right — the object row genuinely was not there — and this ADR
records it because the alternative reading ("no grant ⇒ no access") is the exact failure ADR-0029 §3 and
prompt prohibition 4 forbid.

Related, and corrected twice — once during implementation and once by the live run: `profileBaselineReadable`
is a property of the **parent list**, not of the grant rows. It is true when a profile-owned parent appears
among the permission sets that were read (`parents.some(parent => parent.isOwnedByProfile)`), whether or not
that parent carries a row for this field.

The first correction was the direction the unit suite pins: it must not be "any parent carries a row", which
would render a standalone permission set's grant as a readable profile baseline. The second correction is
the one the sandbox taught. `P10_T3_LIVE_EVIDENCE.md` §4.1 measured that a `FieldPermissions` row **cannot
exist** with `PermissionsRead=false`, and that clearing Read on an existing row makes the platform **remove**
it — so on a real org the ordinary shape of "the profile denies this field" is *no row at all*. Had the flag
been derived from the rows, the single most common real configuration would have had to answer
`INDETERMINATE`; because it is derived from the parent list, the run got the answer the task is about —
`visible: false` with `field-grants: 0 row(s)` and `profileBaselineReadable=true`, definite rather than
unknown.

### 4. The `targetUserId` boundary is the subject query's scope, not a check before it

`selectFieldAccessSubject()` is pure and never compares an Id against the route set. Membership is
enforced by the subject query itself — `Id = :id AND Username IN (:configured)` — so an Id that is not a
configured route and an Id that exists nowhere **both produce an empty result set**, and the refusal
`MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED` is *structurally* identical in the two cases rather than identical
by convention. There is no branch that could drift, and no way to ask the Tool which Ids exist. The
refusal carries no `prerequisite` (nothing in ADR-0029 §2's deployment list is missing — this is the
Tool's own boundary answering a request outside it) and names no Id.

The set is the deployment's **enabled identity routes**, read through
`IdentityRouteRepository.listActiveSalesforceUsernames()` — an existing read-only control-plane query, not
something added for this Tool. Routes are the host's model, so the boundary is host-side: the provider
package knows the contract and nothing about a MySQL route table, and a provider-side implementation
would have to either accept any Id or answer about nobody. The environment-configured runtime passes the
list `buildIdentityRoutes()` built, so the set this Tool bounds to is literally the set the runtime
resolves calls through. Above `FIELD_ACCESS_MAX_ROUTE_USERNAMES` (500) the Tool refuses with
`MCP_DIAGNOSTIC_PREREQUISITE_MISSING` rather than narrowing to the first N, because a narrowed set makes
some configured users unaskable for no reason the caller can see.

Omitting `targetUserId` means "explain the requesting user's own access", which requires knowing which
Salesforce user the requester is — the *business* route, not the DIAGNOSTIC connection this Tool runs on.
When no such route resolved, the Tool refuses; it does not fall back to the diagnostic account and it does
not answer a table of gaps, because a conclusion is a claim *about a user*.

### 5. `describe` is returned but can never decide a conclusion

`describeFacts` carries `executionIdentityView: z.literal(true)` and is never passed to the conclusion
builder: `FieldAccessConclusionFacts` has no field for it, which makes the mistake unrepresentable rather
than merely discouraged. T0 §6 measured `Account`'s describe reporting 252 fields, 199 createable, *for
the calling identity* — the administrator-grade diagnostic account. Mixed into a named user's answer it
would report the administrator's field-level security as that user's, which is the specific correctness
trap T1 named. The facts are returned because the caller asked about the field, and for no other reason.

`RecordType` availability to the subject is always `'INDETERMINATE'` for the same class of reason:
per-user record-type availability is a Profile/Layout fact and the diagnostic whitelist carries
`RecordType`, not the profile metadata that decides it.

### 6. The query surface is a whitelist constant, asserted over the module's own source

`FIELD_ACCESS_STANDARD_OBJECTS` — `User`, `PermissionSetAssignment`, `PermissionSet`,
`ObjectPermissions`, `FieldPermissions`, `RecordType` — names every object any query in the executor may
read. The caller's object is reached through `describe` and nothing else, so no path in the file can read
a business row. This is not a claim in a comment: a unit test asserts that every `FROM` clause in the
module's source is drawn from the whitelist and that the caller's object appears in no query, and the live
milestone independently asserts it over the *recorded wire* for each Tool call (§8). ADR-0029 §4a requires
the whitelist because the same identity was measured reading 955 `Lead` rows through the standard API —
the API does not stop a mistake, the Tool's code has to.

`fieldApiNames` is used only as a key into the permission configuration, never to read a field value, and
the Tool's own descriptions say so. It is also sent in **both stored spellings** (`Name` and
`Account.Name`): the org was observed storing one or the other, and querying one spelling silently drops
the other half of the rows. Results are normalised back to the bare name.

### 7. What the live milestone is allowed to write, and what it does instead of assuming

The prompt's live scenario asks for a sandbox configuration where a field's FLS is closed for a user, and
a positive conclusion for a fully-open field. Implementing it produced a rule that now governs the
harness: **a milestone may not assert a control it has not measured.**

- The closed field is built by **taking away** an existing grant on the subject's **profile-owned** set, and
  only when no other layer grants the field read. A deny row cannot be created: the platform refuses a
  `FieldPermissions` create with `PermissionsRead=false` (`FIELD_INTEGRITY_EXCEPTION`, "Read permission is
  required for: Account.TickerSymbol"), and clearing Read on an existing row makes the platform **remove**
  it. Both were measured, not assumed — §4.1 of the evidence page is that measurement and it is the reason
  the rule now reads "take the row away" rather than "write `PermissionsRead=false`". The revert has to
  follow the platform: the run re-reads the row after the edit and, when it is gone, puts it back by
  creating it again rather than by updating an id that no longer exists.
- The open control is taken from an explicit `read=true && edit=true` row, preferring `Name`. Naming
  `Account.Name` in advance would have been the trap: an org may simply have no row for it, in which case
  the Tool reports `visible: false` and is **correct** — so a harness that hard-coded the assertion would
  report its own assumption as a defect in the Tool. This is not hypothetical: the sandbox has no row for
  `Account.Name`, and the run fell through to a field the org demonstrably grants. When no granting row
  exists anywhere, the run creates a temporary permission set for the control.
- The object-level read row is established first, because without one every field is `INDETERMINATE`
  (§3). It is a precondition of measuring anything, not a convenience.
- **Writes happen only when the org is a sandbox** (`Organization.IsSandbox`), per ADR-0029. Off a
  sandbox the run writes nothing, degrades the two controls to `NOT TESTED` naming ADR-0029, and reports
  `overall: 'PARTIAL'` — which is the outcome ADR-0029 asks for, not a failure to retry. It also reports
  `controls.profileWideWindow`, because a write on a profile-owned set changes field access for every user
  of that profile until the revert lands, and an operator reading the evidence is entitled to know that
  before reading any conclusion.
- Cleanup is verified by **snapshot equality**, not by bookkeeping: the subject's `ObjectPermissions`,
  `FieldPermissions` and assignment rows are read before the first write and again after the last one,
  canonicalised and sorted, and the two lists must match. Checking that "the things I remember creating
  are gone" can only find the losses the run already knows about; the snapshot finds the ones it does not.
  The comparison must look in **both** directions — the third run removed a row the run had not created,
  the snapshot went from 207 lines to 206, and a comparison that only asked "what is here now that was not
  here before?" reported no drift at all. Snapshot equality means set equality, not containment.

The prompt's prohibition on writing anything in a production org therefore holds without exception: the
harness has no code path that writes when `IsSandbox` is not `true`.

## Consequences

- **The Tool is only as good as the permission tables it read.** Every conclusion names its layers in
  `sourceChain`, so "I read the profile and it denies" is distinguishable from "I read nothing". A reader
  who only looks at `visible` is reading a three-valued field as if it were two-valued, and that is
  documented on the schema rather than left to be discovered.
- **Muting permission sets are a known blind spot, reported on every conclusion.** The union is computed
  over `PermissionSetAssignment`, and a muting set inside a permission set group is itself an assignment
  whose rows are read and included; what is *not* on this read surface is the group membership that makes
  those rows subtractive. So a listed grant can be one a group mutes. `MUTING_CAVEAT` is in the `caveats`
  of **every** conclusion rather than only the positive ones — a caveat a reader has to know to look for
  is not doing its job.
- **The hint may only name a Tool this session advertises** (§0.3), so a deployment that has `READ` Tools
  but not the metadata ones gets a hint that composes from what it has. Non-permission causes — a
  validation rule, a field dependency, a read-only layout — are reported as *presence hints*, never as
  part of the conclusion, which is what "not a permission simulator" means in practice.
- **The Tool is `DIAGNOSTIC`, default-disabled, and audited.** `SFOA_CONTEXT_TOOL_ROLES` maps it to
  `'DIAGNOSTIC'`, `assertDiagnosticScope` refuses it outside that scope, and enabling it is an Admin grant
  in the console. The live milestone enables it through `AdditiveToolPolicySnapshotSource` rather than by
  writing the Control Plane, so a run cannot pass by having granted itself the Tool it is proving can be
  granted.
- **Deliberately not decided here.** Whether to expand the target set beyond enabled routes (it would need
  an authorization model, not a list), whether to read permission-set-group membership to close the muting
  gap, and whether record-type availability can be answered per user without the profile metadata the
  diagnostic whitelist excludes. All three are recorded as open, not as unfinished.

## 8. Live evidence

See [`P10_T3_LIVE_EVIDENCE.md`](../P10_T3_LIVE_EVIDENCE.md) for the run, its per-gate measurements, the
audit rows and the list of things the run does not prove.

Recorded **2026-09-30** on the test server `192.168.156.203`: sandbox (CHN5S, `IsSandbox = true`), API
v68.0, on the fixed DIAGNOSTIC identity. **Five runs, in `CONSTRUCTED`/`OBSERVED` mode; the last two are
`overall = PASS` with all fifteen gates green**, and all five are still in the audit trail
(`7833`–`7861`) — twenty-eight rows, sixteen `PASS` and twelve `ERROR`, with every one of the twelve being
the `MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED` the boundary is *supposed* to produce (§4).

What the run settled, and what it corrected in this ADR:

- **Every decision above is measured, not asserted.** The subject boundary refuses an out-of-route Id and a
  nonexistent Id with byte-identical text after the same one subject lookup (§4); the union flips a closed
  field to `visible: true` and lists the standalone grant (§1, §5); the data-plane whitelist is checked
  against the **recorded wire** — 25 statements over 5 windows, zero off-whitelist targets, zero
  business-object reads (§6).
- **§3's `profileBaselineReadable` and §7's closed-field rule were both wrong as first written, and the
  live run is what showed it.** §4.1 measured that the platform cannot store a deny row and removes one
  when its Read is cleared, so a closed field on a real org is an **absent row** — which is exactly the case
  §3 had to be right about for the answer to be definite rather than `INDETERMINATE`.
- **§7's snapshot rule needed its missing half.** The third run altered the org and the comparison reported
  no drift, because it looked only for lines that had been added (§4.4).
- **One defect was found by the run, and it was in the milestone harness rather than in the Tool**:
  `AdditiveToolPolicySnapshotSource`, the decorator the harness wraps the real snapshot source in, did not
  forward the optional `listConfiguredSalesforceUsernames`, so through it the deployment appeared to
  configure no routes and `explain_field_access` correctly refused **every** named target (§4). The product
  code was right on both sides — the MySQL source implements the member, and defaulting an absent one to the
  empty set is the fail-closed direction — and every unit test passed, because the decorator existed only in
  the composition the deployment uses. It is recorded here because §4's boundary is only as good as the
  route set that reaches it, and an optional member on a policy interface is a silent way to lose one.
- **Audit verification (P7)**: twenty rows, every one `executionRole = DIAGNOSTIC`, `identitySource =
  INTERNAL_SERVICE_HEADER`, and the Tool's Salesforce calls carrying `purpose = PERMISSION_EXPLAIN` beside
  the identity layer's own `IDENTITY_*` calls. The two refusals are recorded as `ERROR`/`FAILED` with the
  code the caller saw. `auditIntegrityStatus = PARTIAL` and the `ScratchOrgInfo` warm-up `firstFailure` are
  the deployment's norms, the same two T2 recorded.
- **Not proved, and recorded as such**: the prompt's human Setup-page cross-check has not been performed
  (the harness's is an independent machine read of the same tables); `INDETERMINATE` is covered by unit
  tests only, with no live leg making a layer unreadable; and this org has no `FieldPermissions` row for
  `Account.Name`, so the Tool reads it as `visible: false` — see §3 and the evidence page's §3.
