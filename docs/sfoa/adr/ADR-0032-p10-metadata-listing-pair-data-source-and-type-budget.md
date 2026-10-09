# ADR-0032: The P10 metadata pair — the data source, the per-type budget, and the twenty-one-type allowlist

- Status: Accepted for P10
- Date: 2026-10-09
- Extends: ADR-0029 (§0.3's role/data red line, §2's prerequisite list, §3's degradation contract and §4a's
  per-Tool query whitelist), ADR-0024 (a data-source decision recorded as a decision rather than left in the
  code), ADR-0025/ADR-0026 (bounded completeness, an explicit `truncated`, structured errors), ADR-0009 (the
  server-owned DIAGNOSTIC request scope), ADR-0030/ADR-0031 (the T2 and T3 Toolsets this pair is shaped
  after)
- Evidence: [`P10_T0_LIVE_PROBE_FINDINGS.md`](../P10_T0_LIVE_PROBE_FINDINGS.md) §1 (localized, URL-escaped
  stored names) and §6 (describe answers for the *calling* identity), plus the T4 live milestone recorded in
  §8 below

## Context

T4 delivers **GAP-M1**: the metadata pair. `list_metadata_components` answers *which* components of a type
this org holds; `get_metadata_component_context` — delivered in P10-T1 and widened here — answers *what is
inside one of them*. The pair exists because the question an administrator actually gets is "what is
configured here", and the answer is a Setup-layer fact that the record API cannot state: a validation rule
that never fires, a flow that is switched off, a named credential whose endpoint moved and a profile that
grants a field are all invisible to SOQL and all visible to the Metadata API.

Four constraints shaped the design before any code was written, and each of them is the reason for one of
the decisions below:

- **The T0 probe measured only three types.** `ValidationRule`, `NamedCredential` and `Profile` were probed
  at T0, and the allowlist the pair advertises has to be twenty-two entries wide to answer the question the
  prompt asks. A type's listability is a **per-type authorization fact** (ADR-0029 §2's prerequisite A-4),
  so the three probed types are an argument for *trying* the other nineteen, not for assuming them. The
  revision note before the T4 section of `P10_EXECUTION_PROMPTS.md` says so in as many words: the new types
  must each be measured, never extrapolated. They were, and **two of the twenty-two did not survive the
  measurement** — the allowlist that ships is twenty-one types, corrected by measurement (§8).
- **This org stores component names that are localized and URL-escaped.** T0 §1 recorded `风控负责` and
  `WRN业务员%2F业务主管%2F市场开发`. The pair's whole value is that a caller copies a name out of one Tool
  and into the other, so a normalizing step anywhere between them is a silent wrong answer rather than an
  error.
- **The DIAGNOSTIC identity is administrator-grade, and §0.3 is a red line.** T0 §6 measured that a
  `describe` on this identity reports the *administrator's* field-level security. Nothing in this pair may
  read a business record: a metadata Tool that could also read a `Lead` would be the Setup/data boundary
  ADR-0029 draws being crossed by the Tool that exists to stay on the Setup side of it.
- **A listing can be unbounded in a way a `LIMIT` does not fix.** A `Profile` carries one entry per
  field-level permission and can run to thousands of component entries, each with a caller-visible name of
  unknown length. The prohibition in the T4 prompt is explicit: 禁止超预算回传大文件（Profile 类尤其）.

## Decision

### 1. The data source is the Metadata API `listMetadata`, and the alternative was measured against it

A listing could have come from a `describe`, from a SOQL read of a Tooling object, or from the Metadata API.
It comes from `connection.metadata.list([{ type }])`, for three reasons that are properties of the answer
rather than preferences:

- **Provenance is what the listing is for.** The entry's `lastModifiedByName`/`lastModifiedById`,
  `lastModifiedDate` and `fileName` come from the listing and from nowhere else. "What changed" is the
  question a metadata inventory is normally asked, and a listing without those fields would answer only
  "what exists" — a strictly weaker Tool for the same call cost.
- **`describe` answers for the calling identity.** T0 §6 measured this directly: `Account`'s describe
  reported 252 fields and 199 createable *for the diagnostic account*. A metadata inventory built from
  describes would report the administrator's view of the org as the org's configuration.
- **A Tooling read cannot enumerate configuration uniformly.** There is no one object holding validation
  rules, flows, named credentials and profiles; a per-type Tooling query would be a per-type schema
  dependency, and the twenty-one types would become twenty-one translations with twenty-one failure modes.

The cost of the choice is recorded rather than hidden: the pair is **type-listable only where the org
authorizes the type**, and it makes **one Metadata API round trip per call**, which is why §5's coverage
gate exists and why the live milestone budgets for roughly thirty round trips.

### 2. The listing and the reading are two Tools, and the listing carries no content

`list_metadata_components` returns names and provenance; `get_metadata_component_context` returns file
content. A single Tool returning both would be a listing no budget could bound — the response size would be
the sum of the components' definitions — and it would make the common question ("what exists here") cost the
same as the rare one ("show me that flow's XML"). The split is the one P9 established for `list_sobjects` /
`describe_sobject`, and the Tools are **enabled independently** in the Console, which is why §9's hint
discipline is load-bearing rather than cosmetic.

### 3. `fullName` is carried byte-exact, and the prefix filter was relaxed from a shape check to a safety check

`fullName` is returned exactly as the listing produced it and is never decoded, trimmed, case-folded or
re-encoded. A caller who reads `%2F` as an escape and passes `/` back addresses a **different component, or
none** — and a retrieve of a different component *succeeds*, so nothing downstream would report the mistake.
The reader accepts the name unchanged; the milestone's round-trip gate (§12) is what proves it.

That forced a change to the input validation, and the change is deliberately in the *other* direction from
"loosen it". Until T4 both metadata Tools validated `fullName` against `metadataFullNameSchema`, an ASCII-only
whitelist. **That whitelist refused every name this org actually stores** — `风控负责` is not ASCII — so the
reader as shipped in T1 could only be called with a name no live org would ever produce. ASCII-only was not a
safety property; it was a shape assumption that broke the pair it was meant to protect.

The replacement validates for **safety and never for shape**: no control characters, no `..` traversal
sequence, a length bound. It does not enumerate the characters a legitimate name may contain, because the
set is "whatever the org stored". The value is also only ever a **local filter**: `developerNamePrefix` is
compared with `startsWith` against the already-listed entries and is never interpolated into a manifest, a
path, or a query — so the character set it admits has no route to a boundary. The T4 prohibition
禁止放宽 fullName 安全校验 is satisfied in the sense it was written: nothing that reaches a file system, a
manifest or a query got looser. What got looser is a comparison against a string the org itself returned.

### 4. The entry shape is permissive **by measurement**, not by defensiveness

`manageableState`, `lastModifiedBy`, `lastModifiedDate` and `fileName` are all optional in
`metadataListComponentSchema`, and the reason is a measured fact rather than an abundance of caution: T0
found `ValidationRule` and `NamedCredential` entries carrying `manageableState`, `fileName` and
`lastModifiedByName`, while **`Profile` entries carry no `manageableState` at all**. A schema declaring the
field required would fail on a type the allowlist is required to serve, and a per-type schema would be
twenty-one schemas to drift. The schema is therefore the union of what was observed, and ADR-0032 is where
the per-type differences are recorded.

### 5. `includeInactive` defaults to false, the effective value is echoed, and "inactive" means one thing

The default excludes components the listing marks as inactive, which is the T4 prohibition
禁止默认返回 inactive 组件. Two details make it honest:

- **The effective value is echoed in the response** (`includeInactive` and `developerNamePrefix` are both
  returned), because a listing narrowed by a default the caller did not choose is exactly the
  silent-short-list failure this Toolset exists to avoid. A caller who reads `totalCount` without reading
  `includeInactive` has misread the org.
- **"Inactive" is `manageableState === 'deleted'` and nothing else.** `INACTIVE_MANAGEABLE_STATES` is a
  one-element set. `released`, `installed`, `unmanaged`, `deprecated` and `beta` are all live states — a
  deprecated flow still runs and an unmanaged component is still the org's — so dropping them would be the
  Tool deciding policy the org has not decided. An entry with **no** `manageableState` is treated as
  **active**, which is the only reading that is safe on a type like `Profile` that carries none (§4).

The consequence is stated rather than glossed: for a type that carries no `manageableState`, `includeInactive`
has nothing to filter and is a no-op, and the milestone reports that as a `NOT TESTED` on the org's actual
inventory rather than as a pass (§12). The alternative — inventing an "inactive" signal for those types —
would be a fabricated fact about the org.

### 6. Two budget mechanisms, and `totalCount` is post-filter, pre-slice

`limit` (default 50, maximum 200) caps what is considered; `trimToByteBudget` then decides what fits inside
`MAX_DIAGNOSTIC_RESULT_BYTES`. Both are needed: a limit alone cannot bound a response whose entries carry
names of unknown length, and a byte budget alone cannot give a caller a page size to reason about. The
response reports which one did the cutting, in the sense the hint describes:

- `totalCount` is the matched count **after** the prefix and inactive filters and **before** the limit slice.
  Reporting the type's org-wide size instead would make `truncated` meaningless, since a filtered listing is
  narrowed by the caller's own filter rather than by this Tool.
- `truncated` is `kept.length < matched.length` — a **strict** comparison, so equal counts mean nothing was
  dropped whichever mechanism did the dropping.
- The hint names the remedy that applies: raise `limit` if the limit cut it, narrow `developerNamePrefix` to
  walk past the cap. There is **no offset paging**, and that is a decision (§"deliberately not decided").

### 7. ADR-0029 §3 applies **per type**, and the refusal names A-4

A type the org will not list produces `MCP_METADATA_TYPE_UNAVAILABLE`, carrying `prerequisite: 'A-4'` and
naming the type, and **never an empty `components` array**. This is the single most important behaviour in
the pair and it is the reason the schema has a `prerequisite` field at all. An empty listing reads as "this
org holds no validation rules", which is a claim about the org the Tool has not earned — and the two
readings have opposite operational consequences: "there are none" closes an investigation, while "I could not
look" opens one. The refusal is per type because A-4 is per type; a listing that failed for one type says
nothing about the other twenty-one.

`METADATA_LIST_UNAVAILABLE_CODES` is the set of Salesforce codes that mean "this org will not list this type
to this identity" (`INSUFFICIENT_ACCESS`, `INSUFFICIENT_PRIVILEGES`, `API_DISABLED_FOR_ORG`, `NOT_FOUND`,
`INVALID_TYPE`, `UNKNOWN_EXCEPTION`, …). Anything else is `MCP_METADATA_LIST_FAILED` with a retry suggestion,
so a genuine API problem is not reported as a per-type authorization fact.

**That set was unreachable on the first live run, and the run is what found it.** The Metadata API's codes
arrive namespaced — the error is `errorCode: 'sf:INVALID_TYPE'`, at the top level and again under `data` —
and the shared reader `readSalesforceFailure` drops a colon-bearing code to `null` rather than echoing a
string its identifier-only safety pattern (`ERROR_CODE_PATTERN`) cannot vouch for. Correct behaviour for a
sanitizer four other Tools depend on, and fatal here: every code in the set became `null`, so both refusals
came back as `MCP_METADATA_LIST_FAILED` with **no `prerequisite`** — a per-type authorization fact reported
as a retryable API failure, which is precisely the reading ADR-0029 §3 exists to prevent. The fix strips the
`sf:` namespace **inside `mapMetadataListFailure`**, at the one place that has to classify, rather than
widening a sanitizer whose strictness the other providers rely on. The unit tests had not caught it because
they threw bare codes; they now throw the shape the org actually produced.

The consequence is worth stating plainly, because it is the argument for the live gates existing at all: the
degradation contract was written, reviewed, unit-tested and **dead on arrival**, and only an org that
refuses a type could say so.

### 8. The allowlist is twenty-one types: twenty-two were named, and two were corrected by measurement

`METADATA_CONTEXT_TYPES` grew from eight to twenty-one: code and UI (`CustomObject`, `CustomField`,
`ValidationRule`, `Flow`, `ApexClass`, `ApexTrigger`, `Layout`, `FlexiPage`, `EmailTemplate`), named
configuration and secrets (`NamedCredential`, `CustomMetadata`, `QuickAction`, `RecordType`), rules that fire
without a user (`DuplicateRule`, `AssignmentRule`, `AutoResponseRule`, `EscalationRule`), and access shape
and automation (`SharingRules`, `Workflow`, `PermissionSet`, `Profile`).

The prompt named twenty-two. Two of them did not survive the per-type measurement, and the correction is
recorded here rather than applied silently — which is what the previous revision note asked for, and what
this section was written in anticipation of:

- **`SharingRule` is `SharingRules`.** The singular name answers `INVALID_TYPE: Unknown type:SharingRule`,
  and the org's `describeMetadata` declares `SharingRules`, which lists **210** components
  (`CXG__DataLibrary__c`, `Project_Proposal__c`, `Payment_Plan__c`, …). The Metadata API has also used
  `SharingSet` historically; this org answers `Cannot use: SharingSet in this organization`, so the plural
  is the name that serves the capability and `SharingSet` is not a substitute.
- **`CustomSetting` is not a Metadata API type at all.** It answers `INVALID_TYPE: Unknown type:CustomSetting`
  and appears in none of the **204** types this org declares. The capability it was named to serve —
  a custom-settings inventory — is **already covered by `CustomObject`**, which is on the allowlist:
  measured, this org holds 8 custom settings (`GlobalSetting__c`, `SkipTrigger__c`, `OAToken__c`,
  `File_Import_Max_Row__c`, …) and **8 of 8 appear in the `CustomObject` listing**.
  Substituting a different type to keep the count at twenty-two was rejected: it would widen the allowlist
  past the prompt's own list without a question for the new entry to answer.

Three things make the width a decision rather than a list:

- **Every entry is a promise that the deployment serves it.** A type that always refuses would advertise a
  capability the deployment does not have, which is why the allowlist holds only types measured as
  retrievable — and why a refusal on one of them is recorded as an ADR amendment rather than worked around
  in code (the T4 prompt says so; §12 records what the run found).
- **The probe iterates the Tool's own exported constant.** `probeMetadataSurface` loops
  `for (const type of METADATA_CONTEXT_TYPES)` and records one step per type, plus a
  `METADATA_ALLOWLIST_COVERAGE` step carrying the allowlist and its size. A later widening therefore extends
  the probe coverage with it instead of outrunning it, and a type the org declines appears as its own
  `METADATA_LIST_<TYPE>` step rather than hiding inside a total. One step per type on purpose: a single step
  wrapping all of them could report only the first refusal, and "which type did the org decline" is the whole
  finding.
- **The prompt's own list is an input, not an authority.** Two of its names were wrong about the API, and the
  measurement said so. The allowlist is therefore not "the prompt's twenty-two" but "the prompt's list, minus
  what this org does not have, with the names the API actually uses" — and the unit test writes the resulting
  set out by hand so that re-adding either rejected name is a failing test rather than a quiet edit.

### 9. The hint may only name a Tool `tools/list` advertises, and the builders are pure

`metadataListHint` takes `ReadonlySet<string>` of advertised names and degrades to a sentence naming no Tool
when the reader is switched off — the same rule and the same reason as `debug-log-hints.ts`. The two metadata
Tools are enabled independently, so a hint naming a disabled Tool sends an Agent to a name its own
`tools/list` does not carry, which reads as a broken deployment rather than a Tool that is switched off. The
builder is a pure function of the advertised set and measured counts, so "the hint named a Tool that was not
advertised" is a unit-testable defect rather than one no live run would reliably catch.

The hint also carries the one instruction that exists because of a measurement rather than for style: names
round-trip **verbatim** (§3), so the hint says so instead of leaving a caller to infer it. And the empty case
is split the way `apexLogsHint` splits it — an unfiltered empty listing is a fact about the type, a
prefix-filtered empty listing is usually a fact about the prefix — because only one of those two is about the
org.

### 10. Governance: DIAGNOSTIC, default-disabled, audited, and out of the playbook

`SFOA_CONTEXT_TOOL_ROLES` maps both Tools to `'DIAGNOSTIC'`, `assertDiagnosticScope` refuses either outside
that scope, and enabling them is an Admin grant in the Console — they ship default-disabled. The live
milestone enables them through `AdditiveToolPolicySnapshotSource`, so a run cannot pass by having quietly
granted itself the Tools it is proving can be granted.

Both Tools reach the org through the Metadata API, so `apiCategory` is `METADATA_API` for both and the
**purpose is the only field that distinguishes them**: `SalesforceApiPurpose.METADATA_LIST` for the listing
and `METADATA_RETRIEVE` for the reader. The purpose is not observable from a Tool response, so the protocol
test reads the compiled `context-tool-facade.js` and matches the literal — the precedent set by
`field-access-context-executor.test.ts`.

Following the T2/T3 precedent, neither Tool is added to the playbook. The SFOA context Toolset is filtered out
of the `OFFICIAL_TOOL_CATALOG` lookup by `configureProviderRuntime`, so a deployment enables them by name
without an official-catalog edit; and the Agent-facing instruction generator draws its `availableTools` from
`AGENT_RECOGNIZED_TOOL_NAMES`, which neither Tool is in — so a Dify or WeCom Agent's generated instruction
does not carry them (the read Tools delivered in T1/T2/T3 are in the same position). Whether the pair should
reach the Agent-facing playbook is a separate, deliberate decision that has not been made.

The **Console** catalog is the other half and behaves differently, which is worth stating precisely because
"not in the catalog" would be false there: `buildAdminToolCatalog` emits a record for every
`SFOA_CONTEXT_TOOL_NAMES` entry, so both Tools appear in it structurally — `list_metadata_components` as
`METADATA_READ`, `executionRole: 'DIAGNOSTIC'`, enableable by name — and its dependency line names `A-4`,
which is the one place an Admin is told this Tool's prerequisite is a per-*value* fact (the reader's entry in
the same catalog predates T4). On the deployed test server neither P10 Tool has a `sfoa_tool_control` row, so
the catalog entry is present and the enablement has simply never been made.

### 11. The red line is enforced by an assertion, not by a comment

Neither Tool issues SOQL at all — the pair is a Metadata API Toolset. The live milestone asserts this over
the **recorded wire**: every Tool call is bracketed, and inside each window there must be zero `query`
statements, and every type the Metadata API was asked for must come from the allowlist. The second assertion
is the enforcement point a schema check cannot see: the schema refuses a *caller's* type, while the wire
shows which type the Tool itself sent.

## Consequences

- **The pair's usefulness is bounded by per-type authorization, and it says so.** On an org that lists
  everything, the twenty-one types are a Setup inventory. On an org that refuses some, every refusal is a
  structured `MCP_METADATA_TYPE_UNAVAILABLE` naming the type, and the Tool never answers "none exist" for a
  type it could not look at. A caller who ignores `prerequisite` is reading a gap as a fact.
- **A Profile listing can be large and is bounded by the byte budget rather than by taste.** The T4
  prohibition on returning an over-budget Profile is satisfied by `trimToByteBudget` plus the reader's own
  `METADATA_CONTEXT_LIMITS`; the live gate measures both on a real Profile rather than trusting the constants.
- **The probe's report grows with the allowlist.** Twenty-one recorded steps per probe run, by design. A
  future widening makes the probe slower and more complete in the same step, which is the intended trade.
- **`manageableState` is not a general "is this live" signal.** For the types that carry no such field
  (measured: `Profile`), the listing cannot tell a live component from a recycled one and does not pretend
  to. That is a fact about the Metadata API's per-type responses, not a gap in the Tool.
- **A successful listing with `totalCount: 0` is the pair's least-verifiable answer.** The degradation
  contract covers the refusal; it says nothing about a type that lists and is genuinely empty. `AssignmentRule`
  and `AutoResponseRule` were cross-checked against the Tooling objects of the same name (0 and 1, agreeing
  with the listing), but **`EscalationRule` has no second source on this org** — the Tooling API has no such
  object — so its zero rests on one method. That is recorded in the evidence page as a limit of the run rather
  than smoothed over; a false zero here would be indistinguishable from a true one, and it is the failure mode
  §7 exists to make impossible on the refusal side.
- **Audit distinguishes the two halves and nothing else does.** `apiCategory` is `METADATA_API` for both, so
  a reader of the P7 trail must use `purpose` to tell a listing from a reading.
- **Deliberately not decided here.** Whether the listing should page by offset rather than by prefix walk (a
  prefix walk cannot reach past a prefix with more than `limit` members, which the hint admits and the
  caller works around by narrowing); whether `manageableState` should become a caller-visible filter rather
  than a boolean; and whether the pair should reach the **Agent-facing playbook** (§10: the Console catalog
  carries them structurally already, so the playbook is the half that remains open). All three are
  recorded as open, not as unfinished. (`SharingRule`'s API name was the fourth; §8 is now the answer.)

## 12. Live evidence

See [`P10_T4_LIVE_EVIDENCE.md`](../P10_T4_LIVE_EVIDENCE.md) for the run, its per-gate measurements, the audit
rows, and the list of things the run does not prove.

The evidence has two parts because the first run **failed**, and the failure is the most valuable thing in it.
Run 1 (2026-10-09 01:38:26 UTC, 22 types as the prompt named them) returned `overall: FAIL` with
`allowlistCoverage` as the only failing gate: 20 types served, `CustomSetting` and `SharingRule` refused.
Investigating that refusal produced §8's two corrections and §7's dead classifier. Run 2 (2026-10-09 01:54:53
UTC, 21 corrected types, classifier fixed) is the recorded result: `overall: PARTIAL`, ten of eleven gates
`PASS`, and `inactiveDefault` `NOT TESTED` because this org holds no component in a `deleted` manageable
state. The report of run 1 is kept beside it, unedited, because a corrected allowlist with no record of what
it corrected is exactly the silent rename this section refuses to do.

Both runs executed on the test server **192.168.156.203** under **Node v22.23.1**, against the sandbox CHN5S
(API v68.0) through the fixed DIAGNOSTIC identity (`verificationStatus = PASS`). The archives:

| Artifact | Path on the host | Size |
| --- | --- | ---: |
| Run 1 report (`FAIL`) | `/data/sfoa-enterprise-mcp/p10-t4-milestone-20261009-093817.json` | 13 624 B |
| Run 2 report (`PARTIAL`) | `/data/sfoa-enterprise-mcp/p10-t4-milestone-20261009-095440.json` | 12 992 B |
| P10 probe report | `/data/sfoa-enterprise-mcp/p10-probe-20261009-100148.json` | 58 543 B |
| Audit export, listing | `/data/sfoa-enterprise-mcp/p10-t4-audit-list_metadata_components.json` | 520 041 B |
| Audit export, reader | `/data/sfoa-enterprise-mcp/p10-t4-audit-get_metadata_component_context.json` | 271 472 B |

Run 2 measured §2's subject on a real name the org stores — `APIS管理组%2F业务员`, chosen because it carries
an escaped separator — with `byteExact: true` through listing → reader, and §7's per-type coverage at **21 of
21** served with zero refusals. §6's byte budget was measured on a real `Profile` (`APIS健康管业OP`, 5 763
bytes, `truncated: false`, declared limits equal to reported); the over-budget path itself has no live leg on
this org. The P10 probe confirms the widening from the other direction: 60 steps, `allowlistSize: 21`, all 21
`METADATA_LIST_<TYPE>` steps `AVAILABLE`, and the five `DENIED` steps are the pre-existing boundary probes
(four business-object Tooling reads, one `TraceFlag` field-integrity refusal).

The audit trail carries the pairing §10 requires: `list_metadata_components` rows at `purpose = METADATA_LIST`
and `get_metadata_component_context` rows at `METADATA_RETRIEVE`, both on `/services/Soap/m/68.0` v68.0 with
`apiCategory = METADATA_API` and **zero SOQL**, every row `executionRole = DIAGNOSTIC` /
`identitySource = INTERNAL_SERVICE_HEADER` — which is the measurement behind the Consequences bullet that
`purpose` is the only field distinguishing the two halves. Two reader rows are the missing-component gate's
designed refusals (`MCP_METADATA_CONTEXT_FAILED`), one per run. Neither P10 Tool has a `sfoa_tool_control`
row on this deployment, so both runs prove them by granting them in memory rather than through the Console;
the node version recorded by the T3 page (v24.19.0) is not reproducible on this host and the T4 page carries
the correction.
