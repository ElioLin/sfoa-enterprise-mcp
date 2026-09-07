# SFoA P4 Context Provider

Private Provider API extension for deterministic Salesforce facts:

- `get_record_action_context` uses the request USER Connection and REST UI API.
- `run_diagnostic_tooling_query` delegates through a Host-supplied official Tooling-query adapter.
- `get_metadata_component_context` delegates through a Host-supplied official metadata-retrieve adapter.

The Provider contains no identity selector, business reasoning, DML, arbitrary REST URL or client filesystem path. Tool visibility remains controlled by the remote Host's explicit configuration.

P8-04 adds an optional `EffectiveRecordUiContextResolver` to ready CREATE context.
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
