# SFoA Attachment Capability Probe

**Probe type:** capability probe — **not** a production implementation.
**Date:** 2026-09-15
**Probe artifact:** `scripts/sfoa-attachment-capability-probe.mjs` (untracked workspace script; not wired into startup, no MCP Tool, no OpenClaw Skill, no Runtime change)
**Probe artifact sha256:** `6558c99daf88f82088f2da733081f9faf2b2377bf0f0406f123f4c86a862aaac`

---

## 0. Baseline

| Item | Value |
| --- | --- |
| Repository | `D:\GitProject\sfoa-enterprise-mcp` |
| Working branch | `feature/openclaw-sfoa-record-change-02b` @ `ce800c20fc59a77f11778728073c1af2bf2cefa1` |
| `main` | `3adae7b6abcdf53d12d2878aa4f79d055bebf2a1` |
| Working tree | clean except the untracked probe script |
| Test server | `crm-ex-test02` / `192.168.156.203`, deployed tree at `4b3b2ff` |
| Control plane mode | `mysql` (live MySQL control plane, not env-route mode) |
| SFoA instance | `https://runnergroup--uat.sandbox.my.sfcrmproducts.cn` |
| Salesforce API version | **67.0** — discovered live per Connection via `connection.getApiVersion()`; never hardcoded |
| Probe runs | `run1` (original), `run2` (corrected error probe), `run3` (final, + residue sweep) |

`main` (`3adae7b`) is an ancestor of the working branch, which is 6 commits ahead. Neither branch was modified and no commit was made.

---

## 1. What was probed, and what was deliberately not built

Built: one workspace probe script and this report.

**Not built, per the task boundary:** `upload_files_to_record`, any Attachment Bridge, Skill-02C, `attachmentEnabled`, any Admin UI, any file-type allowlist, any file-size matrix, any second authentication mechanism.

**Not modified:** the Generic DML Strategy (`sfoa_dml_policy` / `MCP_DML_ALLOWLIST_JSON`), `sfoa-record-change` (Skill-02), OpenClaw, the WeCom Plugin, any runtime package under `packages/`.

The probe adds nothing to Runtime: it imports the project's existing compiled packages and calls the same request-scoped identity path the production server uses.

---

## 2. Identity chain actually used

The probe reuses the project's existing request-scoped identity path unchanged — it does **not** introduce a second authentication mechanism:

```
authenticated principal → platformUserId
  → MySQL sfoa_identity_route
  → JWT (@salesforce/core AuthInfo + Connection.create, sfoa-shared-jwt, connectionRole USER)
  → real Salesforce User
```

Same construction as `packages/sfoa-mcp-server/src/runtime.ts` in `mysql` mode: `loadRemoteRuntimeConfig` → `createControlPlaneDatabase` → `createIdentityRuntime(config.identity, { identityRepository: new MySqlIdentityRepository(database) })` → `scopeFactory.create({ platformUserId, correlationId })` → `scope.getConnection()`. The raw REST calls take their bearer token from **that** Connection.

**No administrator token and no fixed integration user was used.** The probe refuses to run unless the control plane is in `mysql` mode, i.e. unless identity really comes from `sfoa_identity_route`.

| Field | Observed value |
| --- | --- |
| Mapped Platform User | `08548` (route `user_name` 黄玉卿) |
| Mapped Salesforce User | `candy.zheng@runner-corp.com.cn.uat` — `005C8000003yL1eIAE`, 郑秋婷 |
| UserType | `Standard` |
| IsActive | `true` |
| Organization Id | `00DC5000000lGFpMAM` |
| Connection role / credential profile | `USER` / `sfoa-shared-jwt` |
| Profile name | **NOT READABLE** — SOQL on `User.Profile.Name` returns `INVALID_FIELD` for this standard user. Recorded as itself evidence rather than worked around. |

Active identity routes at probe time: 8. Every one maps a distinct WeCom-scale `platform_user_id` onto a distinct named Salesforce user; none is a shared integration identity.

---

## 3. Object capability — actual SFoA describe evidence

Obtained by live `describe()` through the requester-scoped Connection at API `v67.0`. No global-Salesforce documentation was substituted.

| Object | keyPrefix | Queryable | Createable | Updateable | Deletable | Fields |
| --- | --- | --- | --- | --- | --- | --- |
| `ContentVersion` | `068` | yes | **yes** | yes | **NO** | 48 |
| `ContentDocument` | `069` | yes | **NO** | yes | yes | 29 |
| `ContentDocumentLink` | `06A` | yes | yes | yes | yes | 7 |

Two facts drive the whole design:

1. **`ContentVersion.deletable = false`.** A client cannot delete a version. `ContentDocument` is therefore the only cascade root available for cleanup (see §9).
2. **`ContentDocument.createable = false`.** The client **must not** INSERT `ContentDocument`; Salesforce creates it as a side effect of the `ContentVersion` insert. Confirmed behaviorally: `ContentDocumentId` was auto-populated (`069C5000000wSyPIAU`) with `LatestPublishedVersionId` pointing back at the created version.

---

## 4. Field capability — actual SFoA describe evidence

### `ContentVersion`

| Field | Type | Createable | Updateable | Nillable | defaultedOnCreate | Length |
| --- | --- | --- | --- | --- | --- | --- |
| `Title` | string | yes | yes | no | no | 255 |
| `PathOnClient` | string | yes | **no** | yes | no | 500 |
| `VersionData` | base64 | yes | yes\* | yes | no | — |
| `ContentDocumentId` | reference | yes | no | no | no | 18 |
| `FirstPublishLocationId` | reference | yes | no | yes | no | 18 |
| `ContentSize` | int | **no** | no | yes | no | — |
| `FileType` | string | **no** | no | no | no | 20 |
| `FileExtension` | string | **no** | no | yes | no | 40 |
| `IsLatest` | boolean | no | no | no | yes | — |
| `VersionNumber` | string | no | no | yes | no | 20 |
| `OwnerId` | reference | yes | yes | no | yes | 18 |
| `CreatedById` | reference | no | no | no | yes | — |
| `CreatedDate` | datetime | no | no | no | yes | — |

\* `describe` reports `VersionData.updateable = true`, but a real `PATCH` is **rejected** — see §7. This is the single clearest case in the whole probe where `describe` and live behavior disagree, and it is why the probe records an observed fact instead of trusting the describe flag.

`ContentSize`, `FileType`, `FileExtension`, `IsLatest` and `VersionNumber` are all **not client-writable**: the client supplies bytes and a filename, and Salesforce derives the rest. That is the mechanism that makes a client-side file-type allowlist unnecessary (§12).

### `ContentDocument`

`Title` is `updateable` but **not createable**; `OwnerId` is updateable but not createable; `ContentSize` / `FileType` / `FileExtension` are not createable. This is a derived object, not a client target.

### `ContentDocumentLink`

| Field | Type | Createable | Updateable | Nillable |
| --- | --- | --- | --- | --- |
| `ContentDocumentId` | reference | yes | no | no |
| `LinkedEntityId` | reference | yes | no | no |
| `ShareType` | picklist | yes | yes | yes |
| `Visibility` | picklist | yes | yes | yes |

Live picklist values (active, no default):

- `ShareType`: `V`, `C`, `I`
- `Visibility`: `AllUsers`, `InternalUsers`, `SharedUsers`

---

## 5. The 17 questions

| # | Question | Answer | Evidence |
| --- | --- | --- | --- |
| 1 | Does SFoA support `ContentVersion` / `ContentDocument` / `ContentDocumentLink`? | **YES** for all three | live describe, §3 |
| 2 | Does the requester-scoped user have the permissions? | **YES** — create on `ContentVersion` and `ContentDocumentLink`, query on all three | describe + live HTTP 201 |
| 3 | Can the user create a `ContentVersion`? | **YES** | `POST` → HTTP 201 |
| 4 | Does `FirstPublishLocationId` work? | **YES**, createable; but link creation is not validated — see Q11/Q18 | §6, §8 |
| 5 | Is a `ContentDocumentLink` auto-created? | **YES** — Salesforce linked the file without any explicit link insert | §8 |
| 6 | Does REST multipart binary upload work? | **YES — this is the recommended path** | §6 |
| 7 | Is Base64 required? | **NO** for the multipart path | §6 |
| 8 | Is `ContentDocumentId` auto-returned? | **YES**, auto-populated on the created version | §7 |
| 9 | Can the file be associated to a business record? | **PENDING — SAFE TARGET RECORD REQUIRED** | §10 |
| 10 | What are the real `ShareType` / `Visibility` values? | Observed `ShareType=I`, `Visibility=AllUsers` on the auto-link; picklists `V/C/I` and `AllUsers/InternalUsers/SharedUsers` | §8 |
| 11 | Is the uploaded file queryable afterwards? | **YES** — version, document and link all read back through the same scoped Connection | §7, §8 |
| 12 | `ContentVersion` UPDATE vs new Version? | **Metadata updates in place; bytes require a new Version** | §9 |
| 13 | SFoA vs global Salesforce API differences? | Recorded differences listed in §11 | §11 |
| 14 | Best API for a future `upload_files_to_record`? | **Option A** — REST multipart + `FirstPublishLocationId` | §13 |
| 15 | Any blockers? | One: no safe pre-existing business target record was identified | §10 |
| 16 | Cleanup feasible with the current permissions? | **YES** via `ContentDocument` delete, which cascades | §9 |
| 17 | Does the target record's Files relationship show the file? | **PENDING** with Q9 | §10 |

---

## 6. Multipart binary upload — the primary probe

This was the single most important test. The body was built by hand from the current Salesforce REST contract and the org's own `v67.0` version, **not** from an old example.

```
POST /services/data/v67.0/sobjects/ContentVersion
Content-Type: multipart/form-data; boundary=----sfoaAttachmentProbe<random>

part 1  name="entity_content"   Content-Type: application/json
        {"Title":"<probe title>","PathOnClient":"sfoa-attachment-probe.txt"}
part 2  name="VersionData"      filename="sfoa-attachment-probe.txt"  Content-Type: text/plain
        <123 raw bytes>
```

| Observation | Value |
| --- | --- |
| HTTP status | **201** |
| Response | `{"id":"068C5000000yBlNIAU","success":true,"errors":[]}` |
| `Location` header | `/services/data/v67.0/sobjects/ContentVersion/068C5000000yBlNIAU` |
| Redirected | **false** |
| Request host | `runnergroup--uat.sandbox.my.sfcrmproducts.cn` |
| Base64 required | **NO** |

→ **`MULTIPART_SUPPORTED = true`.** Binary bytes travel `file bytes → HTTP multipart → Salesforce REST` with no encoding step.

**Probe file** (tiny, non-sensitive, no real data):

| Field | Value |
| --- | --- |
| Filename | `sfoa-attachment-probe.txt` |
| Byte size | 123 |
| sha256 | `9e50b6a78c47282ac1d5710b8dfd051f2f99650b8b2a2044cac995d89de9299c` |
| Content | `SFOA Attachment Capability Probe` / ISO timestamp / random probe id |

No maximum file size was tested. Salesforce/SFoA is the size authority; the probe deliberately does not duplicate that policy.

---

## 7. Automatic `ContentDocument`, and the `describe`/behavior divergence

Salesforce created the document as a side effect of the version insert — the client never INSERTed `ContentDocument` (and cannot: `createable=false`).

| Object | Field | Value |
| --- | --- | --- |
| `ContentVersion` | `Id` | `068C5000000yBlNIAU` |
| `ContentVersion` | `ContentDocumentId` | `069C5000000wSyPIAU` |
| `ContentVersion` | `FileExtension` / `FileType` | `txt` / `TEXT` (both derived, not supplied) |
| `ContentVersion` | `ContentSize` | `123` (derived, matches the byte count) |
| `ContentVersion` | `VersionNumber` / `IsLatest` | `1` / `true` |
| `ContentVersion` | `OwnerId` / `CreatedById` | `005C8000003yL1eIAE` (the requester-scoped user) |
| `ContentDocument` | `LatestPublishedVersionId` | `068C5000000yBlNIAU` |

→ **Client need not INSERT `ContentDocument`. `ContentDocumentId` is NOT NULL after creation.**

### ContentVersion update semantics

| Probe | Result |
| --- | --- |
| `PATCH ContentVersion.Title` | **HTTP 204**, title changed, `VersionNumber` still `1` → metadata updates **in place** |
| `PATCH ContentVersion.VersionData` (base64) | **HTTP 400 `INVALID_STATUS`** — `IsMajorVersion 为真时，您无法设置 VersionData。` |
| `POST` multipart with `ContentDocumentId` | **HTTP 201**, produced `VersionNumber 2`, `IsLatest: true`, while v1 became `IsLatest: false` |

→ **Describing `VersionData` as `updateable` is misleading on this Org.** Bytes cannot be replaced; a new Version is inserted against the existing `ContentDocumentId`. A future Tool must model "re-upload" as *a new version*, never as a mutation of the original.

---

## 8. `ContentDocumentLink` behavior

With **no** `FirstPublishLocationId` supplied, Salesforce still created a link — to the **creating user**:

| Field | Value |
| --- | --- |
| `Id` | `06AC50000019jADMAY` |
| `ContentDocumentId` | `069C5000000wSyPIAU` |
| `LinkedEntityId` | `005C8000003yL1eIAE` (the requester's own User record) |
| `ShareType` | `I` |
| `Visibility` | `AllUsers` |

Two consequences for the future Tool design:

- A file is **never unlinked** at creation. The user's own record is the default publish location.
- `ShareType=I` with `Visibility=AllUsers` is the observed default for a self-published file; the exact values that result from publishing to a *business* record are among the PENDING items in §10.

---

## 9. Error-return probe (§22) and UNKNOWN-outcome reconciliation (§29)

Two scenarios, neither touching business data. Both were run after an earlier version of this probe silently returned HTTP 201 for a non-existent target and left an orphan file; that orphan was reconciled and the probe was corrected to track every artifact it creates.

| Scenario | HTTP | errorCode | Message | Side effects |
| --- | --- | --- | --- | --- |
| Malformed `FirstPublishLocationId` (`SFOA-PROBE-NOT-AN-ID`) | **400** | `MALFORMED_ID` | `首次发布位置 ID: ID 值类型错误: SFOA-PROBE-NOT-AN-ID` | **0 rows** — verified by a follow-up query on the probe title |
| Well-formed but non-existent `FirstPublishLocationId` (`000000000000000AAA`) | **201** | — | — | **1 file created anyway**, tracked and deleted by the same run |

→ **`preservesSalesforceFirstCause = true`.** Salesforce's own `errorCode` and localized `message` survive to the caller intact, so a future MCP Tool can return the real first cause rather than a paraphrase.

→ **SFoA does not validate that `FirstPublishLocationId` exists.** A well-formed but wrong id produces a silently unlinked private file, not an error. This is a genuine SFoA behavior finding and a real design hazard: the future Tool must reconcile the created file against the intended record rather than trusting a 201.

**UNKNOWN outcome reconciliation (read-only, no retry implemented).** If the connection dies after dispatch, success can be determined without writing anything by correlating, in order: the target record's `ContentDocumentLink` rows → `ContentVersion.Title` / `PathOnClient` → `ContentSize` (compare against the exact byte count) → `CreatedById` (must be the requester-scoped user) → `CreatedDate` (must fall inside the request window) → `sha256` of the intended payload versus the file actually fetched back. The probe records `ContentSize = 123` matching the submitted bytes, so a size-and-owner-and-time match is sufficient to conclude "this request created this file" without a checksum column. **No automatic retry was implemented.**

### Cleanup (§30)

The cascade was researched rather than assumed. `ContentVersion` is not deletable, so cleanup deletes **`ContentDocument`** and lets Salesforce cascade:

| Step | Result |
| --- | --- |
| `DELETE /sobjects/ContentDocument/069C5000000wStZIAU` | HTTP **204** |
| `DELETE /sobjects/ContentDocument/069C5000000wRZKIA2` (error-probe file) | HTTP **204** |
| `ContentVersion` remaining | **0** |
| `ContentDocumentLink` remaining | **0** |
| `ContentDocument` remaining | **0** |
| Residue sweep `ContentVersion WHERE Title LIKE 'SFOA%Probe%'` | **0 rows** |

Every probe run ended with the Org clean. **No business record was deleted, and none was modified.** The only records the probe ever deleted were files it had created seconds earlier in the same run.

---

## 10. PENDING — the one blocking unknown

**`FirstPublishLocationId` against a real business record was NOT tested.**

`PROBE_TARGET_RECORD_ID` was not supplied, and **no pre-existing safe target record was identified**. All five objects in the live DML allowlist hold what is plainly production-shaped CRM data:

| Object | Rows | CREATE / UPDATE allowed |
| --- | --- | --- |
| `Account_Visit__c` | 90 | yes / yes |
| `Contact` | 37 009 | yes / yes |
| `Lead` | 3 | yes / yes |
| `Visit_Participants__c` | 225 | yes / yes |
| `Visitors_Account__c` | 4 518 | yes / yes |

No `TEST_RECORD_ID` constant exists anywhere in this repository, and `TEST_OBJECT` identifies an *object*, not a record. Picking a record from any of the tables above would mean pointing a file at real customer, contact or visit data.

Per the task rule, the probe does **not** improvise a target and does **not** report a fabricated pass. Recorded state:

```
businessRecordTarget = { targetRecordId: null, source: 'NONE',
                         state: 'PENDING — SAFE TARGET RECORD REQUIRED' }
```

Consequently these remain open, and only these:

- whether `FirstPublishLocationId=<businessRecordId>` creates the link automatically;
- the `ShareType` / `Visibility` that result when publishing to a business record rather than to the user;
- whether the target record's own Files relationship surfaces the file (i.e. whether a future Tool can avoid having the Agent operate `ContentDocumentLink` at all).

**Closing it takes one command**, once an operator names a record they own and are content to have a small text file attached to:

```bash
cd /data/sfoa-enterprise-mcp/app
PROBE_TARGET_RECORD_ID=<18-char record id> node scripts/sfoa-attachment-capability-probe.mjs
```

The probe already implements the target path, including the auto-link assertion, the target-record Files query, and a manual `ContentDocumentLink` insert fallback if the automatic link does not appear.

---

## 11. Observed SFoA-specific differences

Everything below was observed on this Org at `v67.0`; nothing here is inferred from global-Salesforce documentation.

1. **Chinese-localized Salesforce error messages.** `MALFORMED_ID` arrives with a Chinese `message` (`首次发布位置 ID: ID 值类型错误: …`). A future Tool that pattern-matches English message text will break; it must key on `errorCode`.
2. **`FirstPublishLocationId` is not existence-validated.** A well-formed but non-existent id yields HTTP 201 and an unlinked file rather than an error.
3. **`VersionData` describes as `updateable` but is not.** `PATCH` returns `INVALID_STATUS`. The describe flag alone is not a safe basis for a client contract.
4. **`User.Profile.Name` is not SOQL-readable** by this standard business user (`INVALID_FIELD`). The requester's permission profile can be asserted only behaviorally, by attempting operations.
5. **Content domain is `my.sfcrmproducts.cn`**, not `salesforce.com` / `force.com`. No redirect was observed on the upload path.

Not observed to differ: the multipart contract, the auto-`ContentDocument` behavior, the link cascade on `ContentDocument` delete, and the picklist value sets all matched the documented global behavior.

**`NONE OBSERVED IN PROBED CAPABILITIES`** would be wrong to write here — the five differences above were observed directly. It would equally be wrong to write *"SFoA 与全球版完全相同"*.

---

## 12. Attachment policy: no client-side allowlist

The task's expectation holds, and the probe supports it with evidence:

- **No MIME/extension allowlist in the MCP.** `FileType` and `FileExtension` are **not createable** — the client cannot even assert them. Salesforce derives both from the bytes and the filename, and rejects what it rejects.
- **No duplicated max-file-size config.** No size limit was discovered or needed in the client; the multipart body streams bytes and Salesforce is the size authority.
- **No hard-coded size or type rules in any Skill.**

**`Salesforce / SFoA = file acceptance authority` — YES.**

The one nuance: the Tool must return Salesforce's real `errorCode` and `message` verbatim. The `MALFORMED_ID` probe shows that contract is available and localized, which is precisely why the client must not try to pre-empt it with its own rules.

---

## 13. Recommended production API

**Option A — REST multipart `ContentVersion` + `FirstPublishLocationId`. RECOMMENDED.**

Evidence: HTTP 201 with raw binary, no base64, no redirect, `ContentDocumentId` auto-returned, `ContentDocument` auto-created, link auto-created, and a clean documented cascade for cleanup. It is also the only option that never requires the client to encode or reason about file size.

Option B (REST `ContentVersion` with base64 `VersionData`) is **not required** — it was therefore not proven, exactly as the task specified. It remains a fallback if multipart is ever unavailable.

Option C (any other API) is not needed.

---

## 14. Should the Files objects be exposed through Generic DML?

| Object | Through Generic DML? | Why |
| --- | --- | --- |
| `ContentVersion` | **NO** | Files are an internal attachment-runtime concern with derived fields (`ContentSize`, `FileType`, `FileExtension`) that the Agent must never author, a non-obvious version model, and no delete permission. Exposing it would hand the Agent a raw DML surface for an object whose whole contract is "send bytes". |
| `ContentDocumentLink` | **NO** | The link is created by `FirstPublishLocationId`; the Agent never needs to operate it. Exposing it would add sharing-surface risk for zero capability. |

Both answers match the expected `NO / NO`, and the evidence — derived non-createable fields, `deletable=false`, and an auto-created link — supports them independently of the expectation.

---

## 15. Tool feasibility

**`FEASIBLE WITH LIMITATIONS`.**

The mechanism is fully proven on the target Org with the target identity: multipart upload works, the document is created, the link exists, the file is queryable, errors preserve Salesforce's first cause, and cleanup cascades. What is *not* yet proven is the business-record association itself — the PENDING item in §10. If that probe passes with a real target record, feasibility becomes plain `FEASIBLE` with no change to the design below.

---

## 16. Design suggestion (not implemented)

Offered only; nothing in this section exists in code.

**Tool contract**

```
upload_files_to_record
  recordId   : 18-char Salesforce id     (required — never inferred)
  filename   : string                    (required — becomes PathOnClient)
  content    : bytes                     (required — streamed, never base64 at the Tool boundary)
  title      : string                    (optional — defaults to filename)
→ { contentVersionId, contentDocumentId, contentDocumentLinkId, filename, byteSize }
```

**Required Runtime components:** one attachment executor that builds the multipart body and posts to `/services/data/v<connection.getApiVersion()>/sobjects/ContentVersion`, using the request's **existing** scoped Connection. No new authentication, no new Connection, no integration user.

**Attachment Bridge:** not needed for v1. The bridge would only be justified if uploads had to survive the request lifecycle or be resumed; with a direct multipart call inside the request scope, there is nothing to bridge.

**Audit fields:** `probeId`-style correlation id, filename, byte size, sha256, endpoint path, HTTP status, `errorCode`, `contentVersionId`, `contentDocumentId`. **Never** the bearer token, the JWT or private key, file bytes, base64 content, full cookies, or any secret.

**Error model:** surface Salesforce's `errorCode` and `message` verbatim (they are localized — see §11); never synthesize a replacement message; never auto-retry on an unknown outcome (§9 gives the read-only reconciliation path instead).

**Skill-02C delta:** a description of when an upload is appropriate and how to report a failure — **no** type allowlist, **no** size policy, **no** version-management instructions beyond "a re-upload creates a new version".

**Cleanup:** delete the `ContentDocument`, never the version, never the business record.

---

## 17. Final decision

### `PARTIALLY VERIFIED`

Blocking unknown: `FirstPublishLocationId` against a real business record, and therefore the target record's Files relationship.

**Everything else verified live:** requester-scoped identity, permissions, the three objects' real capability, multipart binary upload, automatic `ContentDocument`, automatic `ContentDocumentLink`, post-upload queryability, the version model, Salesforce first-cause preservation, and the full cleanup cascade.

### `MORE PROBE REQUIRED`

One command closes it: supply `PROBE_TARGET_RECORD_ID` and re-run. Until then this probe does **not** claim `READY FOR ATTACHMENT TOOL DESIGN`, and it does not report a fabricated pass for the business-record association.
