# SFoA P4 Context Provider

Private Provider API extension for deterministic Salesforce facts:

- `get_record_action_context` uses the request USER Connection and REST UI API.
- `resolve_field_display_values` resolves current Record Type-aware Picklist and
  MultiPicklist labels separately from raw SOQL/DML/Audit evidence (200 values,
  25 metadata groups, 5 seconds; explicit unresolved raw fallback).
- `get_record_relationship_context` returns at most 20 current USER child
  relationships filtered by existing CREATE governance and Salesforce createability.
- `run_diagnostic_tooling_query` delegates through a Host-supplied official Tooling-query adapter.
- `get_metadata_component_context` delegates through a Host-supplied official metadata-retrieve adapter.
- `get_org_limits` reads the org's own governor-limit map and its five fixed highlight slots
  through a Host-supplied executor on the fixed server-owned DIAGNOSTIC identity. It arrived in
  P9-T3 from the data Provider, because the `limits` resource is org configuration that no
  business identity this deployment routes is granted — the same class of read as the two
  Tooling/Metadata Tools above, and the reason that role is siloed from the business roles. It
  returns quota counters only, never a business record. See
  [ADR-0027](../../docs/sfoa/adr/ADR-0027-p9-org-limits-diagnostic-identity.md).

The Provider contains no identity selector, business reasoning, DML, arbitrary REST URL or client filesystem path. Tool visibility remains controlled by the remote Host's explicit configuration.

CREATE uses current USER `available=true` Record Types and excludes Master if any
available non-Master type exists. The returned candidates, automatic selection and
explicit `recordTypeId` validation use this same list. One candidate loads its full
CREATE facts without a question; several require selection before defaults/layout/
picklist reads. Master is recognized by UI API `master=true` or its fixed ID
`012000000000000AAA` (15/18 characters), never its localized name. When only Master
is available, including objects without custom Record Types, it remains usable.
Unavailable business types do not remove that fallback; no available types still
fails closed. UPDATE and display context retain their existing Record Type behavior.

P8-04 adds an optional `EffectiveRecordUiContextResolver` to ready CREATE context.
P8-07 adds explicit fact provenance and bounded dependency-driven `$User` reads:
25 fields, 32 KiB, existing 3-second extra-read budget. Missing/FLS-denied/timed-out
facts remain UNKNOWN. Server DML defaults do not prove Lightning initial values;
unproven record-dependent container visibility remains UNKNOWN.
It preserves the existing Page Layout executor and supports object-level OFF
(default), SHADOW and ENFORCE. `draftFields` is optional and validated against
current USER ObjectInfo; `refinement` is bounded 0–3. Supported DF fields add
visibility/required-source/dependency/order/effective editability facts. An optional
opaque `uiContextResolutionId` is supplied only for enforced Dynamic Forms/MIXED
without fallback, and is audit provenance only. OFF/SHADOW/Page Layout/fallback
return the complete legacy response unchanged; correlation IDs remain internal. UPDATE/READ stay unchanged.

Configuration is loaded through an injected org/object snapshot reader. This
package's Admin-only `collectUiSnapshot` uses the official SDK and returns bounded
normalized facts; runtime metadata never comes from Git JSON. No evaluated USER or
draft cache exists. Unknown/unsupported resolution falls back to legacy fields.
See [ADR-0019](../../docs/sfoa/adr/ADR-0019-effective-create-ui-context.md) and
[UAT](../../docs/sfoa/P8-04-UAT.md) for supported scope and limitations.

## Task evidence delivery (1.12.0 guidance)

Action context includes objectLabel and real field inlineHelpText, length,
precision and scale from the existing ObjectInfo response; absent facts stay null,
help is bounded to 2000 characters with inlineHelpTextTruncated. Page Layout,
selection-only and Dynamic Forms paths retain these facts. No per-field API read.
Help is descriptive data and cannot change identity or permissions.

Native clients can impose a smaller tool-message limit than the server. Optional
`fieldApiNames` projects an already evaluated context onto up to 50 task fields,
plus API/layout/effective/conditional required fields and known controlling
dependencies. `coverage.fieldProjection` records requested names, omitted count
and unresolved names; returned counts describe the projection, not a full form.
No extra Salesforce read, identity change or DML-scope enforcement is introduced.
When projection omits fields, `coverage.fieldProjection.omittedFieldCatalog`
returns up to 100 omitted `apiName`/`label`/`dataType`/`section`/required-flag
entries (metadata only, never Picklist values) so an omitted task-relevant field
is still discoverable.

Optional `includeRequiredness=true` adds `coverage.requirednessSource` and a
bounded `requiredChecklist` without changing the default legacy response. The
source follows the current USER's resolved active Lightning page for the action
and Record Type: `EFFECTIVE_REQUIRED` for Dynamic Forms/MIXED (checklist from
`effectiveRequired`/`requiredSource`), `PAGE_LAYOUT_REQUIRED` for a pure Page
Layout action (checklist from `apiRequired`/`layoutRequired`), and
`PAGE_LAYOUT_FALLBACK` when dynamic resolution falls back. The projection is
additive and never changes permissions, visibility or DML scope.

For incomplete Picklists, pass picklistValueOffsets: { FieldApiName: nextValueOffset }
on the same object/action/Record Type. Requested pages are prioritized within the
existing 100-per-field/500-total bounds. Combine pages; a final page is still a
partial slice. dependenciesTruncated must not be treated as complete dependency
evidence. No arbitrary name-to-region resolver or DML enrichment is introduced.

Successful JSON text is the full SDK-style pretty mirror of structuredContent.
Text-only clients keep all evidence; the source-traced native OpenClaw projector
can suppress that exact duplicate. Actual deployed projector/context limits need
Run evidence. Field-access text prefers available labels, while structured APIs,
grants and executionIdentityView are retained. DIAGNOSTIC Describe never decides
the target user's permissions.
