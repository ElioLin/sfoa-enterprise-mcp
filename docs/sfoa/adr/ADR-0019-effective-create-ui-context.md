# ADR-0019 — Effective CREATE UI context with current configuration snapshots

Date: 2026-09-06. Status: implemented for post-implementation UAT under P8-04-AMEND-006.

## Context

Different Salesforce USER/Profile/App/Record Type assignments can expose different
CREATE forms for the same object. The stable P8 implementation reads USER UI API
Page Layout facts. Live Metadata retrieval measured tens of seconds and cannot
be repeated on the normal CREATE context path. Independent New UI accuracy is a
post-implementation acceptance gate; fixture success does not establish it.

## Decision

Keep the existing Page Layout executor intact. A cohesive resolver runs after
ready CREATE facts have loaded, using current USER ObjectInfo, SOAP user/profile
identity and accessible Apps. It consumes a normalized current configuration
snapshot through an injected read function. No new business MCP Tool is added.
UPDATE, READ, governance, identity routing and the DML executor retain their roles.

OFF is the default and adds no Salesforce or snapshot read. SHADOW evaluates and
audits but returns the existing Page Layout fields. ENFORCE is explicit per object;
unsupported or uncertain resolution returns the existing fields and an audited
fallback. An additive opaque resolution ID links context and CREATE requests
because P7 has no reliable cross-call session/task identity. The client-provided
ID is not authorization or proof of source ownership; inspect the linked source
USER/object/RT and chronology before attributing a create to it.

App priority is explicit request header, object default, integration default,
then convergence across all currently accessible USER Apps. AppDefinition IDs
and namespace-qualified Metadata fullNames must match uniquely. Profile IDs join
both display Names (visibility facts) and Metadata fullNames (assignment facts).
Assignment priority is App/Profile/RT, App default, object default, standard;
conflicts and uncertain Default inheritance fall back. Desktop View assignments
are used for the supported standard New behavior; actual entry-point accuracy
remains a real UAT target. Custom New overrides and non-desktop form factors fall
back without attempting to emulate their UI.

The deterministic parser follows Region/Facet references, sections, columns,
field instances and ancestry in order. The evaluator has VISIBLE/HIDDEN/PENDING/
UNKNOWN states and bounded AND/OR/booleanFilter parsing. Missing supported draft
dependencies are PENDING; unsupported relationships, unavailable permissions and
record-dependent container rules are UNKNOWN. API requiredness survives visibility;
Dynamic Forms requiredness applies only to visible instances. USER FLS/createability
and managed-field policy are independent constraints. No evaluated USER/draft cache
exists. Agent refinements carry an explicit counter bounded to three.

Migration 012 adds one current-only `sfoa_ui_snapshot` table (12 columns, unique
org/object, normalized JSON <= 2 MiB) and extends one existing P7 payload ENUM with
`UI_CONTEXT`. Existing runtime settings hold at most 25 exact object policies and
one integration default App; this is deployment/integration scope, not a new
tenant model. Snapshot identities are additionally org scoped.

Admin refresh uses a verified independent DIAGNOSTIC identity for configuration
only. A database lease bounds duplicate refreshes; 120 seconds bounds the Admin
wait and 180 seconds allows abandoned lease recovery. App reads have concurrency
two and batch size ten. Failed refreshes retain the previous JSON/hash/time.
There is no background scheduler, automatic refresh on cache miss, Git cache,
Metadata history, raw XML, new dependency or additional Tool.

Three-second bounds apply independently to the new USER identity, snapshot and
Apps reads. A valid snapshot older than 24 hours remains usable with Audit warning;
missing, invalid or wrong-scope snapshots fall back. P7 summary events plus bounded
on-demand `UI_CONTEXT` payload evidence carry field/rule decisions without draft
values. `create_record` records provenance and runs its existing USER DML path.

## Consequences and acceptance

This deliberately trades automatic metadata freshness and full Lightning coverage
for predictable CREATE latency, small storage and conservative behavior. Small/
Medium form factors, custom New UI, inherited pages, unsupported criteria and
uncertain container semantics are reported limitations. Configuration changes need
Admin refresh. Real Agent/UI UAT must verify Page Layout 100%, Dynamic Forms >=90%,
RESOLVED >=95%, and extraction/questions/recommendations >=90% before P8-04 COMPLETE.
Rollback is an object policy change from ENFORCE to SHADOW/OFF; migration reversal
or deletion of old configuration is unnecessary.

References: [Salesforce Dynamic Forms considerations](https://help.salesforce.com/s/articleView?id=sf.dynamic_forms_considerations.htm&language=en_US&type=5),
[Metadata API guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_meta.pdf),
[P8-04 baseline](../P8-04-DYNAMIC-FORMS-BASELINE.md).
