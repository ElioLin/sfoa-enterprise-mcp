# Official Salesforce Provider Inventory

Date: 2026-08-23

Scope: official Providers registered by `packages/mcp/src/registry.ts` at audited Upstream commit `670234dbdca4d3fcdebd9d58b231e311fd34aeec`, plus the P2-pinned dx-core 0.10.0 composition.

**Authority:** this document is an informational snapshot, not a security or enablement source. `packages/sfoa-mcp-server/src/official-tool-catalog.ts` is the sole executable safety source. The repeatable `yarn workspace @sfoa/mcp-server validate:upstream` Gate initializes the real public dx-core Provider and verifies that executable baseline. A Tool or field appearing only in this Markdown receives no classification and no runtime access.

## Decision summary

- P2 composes only `DxCoreMcpProvider` 0.10.0.
- Default enabled: `get_username`, `run_soql_query`.
- Available but disabled by default: `retrieve_metadata`; it is a developer-oriented metadata read that needs a DX project, manifest/source context, filesystem writes, and global-CWD isolation.
- P2 rejects configuration of every `MUTATION`, `ADMIN`, `LOCAL_DEV`, and `UNKNOWN` classification at startup.
- Other official Providers remain inventoried extension seams. Adding one requires an explicit compatibility review and catalog record; the Host architecture does not change.
- An unreviewed official Tool is never automatically classified or registered. An unrelated added Tool makes the compatibility Gate return `UPSTREAM_REVIEW_REQUIRED`; production may continue only because registration remains default-deny. Drift affecting an enabled remote Tool fails startup with `MCP_UPSTREAM_TOOL_CONTRACT_DRIFT`.
- P4 reuses `run_soql_query` and `retrieve_metadata` only as internal primitives for fixed DIAGNOSTIC facades. Their official remote USER contracts remain unchanged. The live retrieve result did not contain source content, so the P4 wrapper reads bounded files in the same request workspace.
- P4 reinitialized the actual Code Analyzer Provider and found six Tools: four GA and two NON_GA. Its absolute local target/result-file authority and durable/global-temp lifecycle are `NOT REMOTE COMPATIBLE`; no Code Analyzer Tool is exposed or copied.

## Provider matrix

| Provider | Version in official stdio host | Tools | Purpose | Remote compatibility | Needs filesystem/local project | Needs additional service | Read/write nature | P2 decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `DxCoreMcpProvider` | stdio 0.9.8; P2 composition 0.10.0 | `get_username`, `run_soql_query`, `retrieve_metadata`, `deploy_metadata`, `assign_permission_set`, `create_org_snapshot`, `create_scratch_org`, `delete_org`, `list_all_orgs`, `open_org`, `resume_tool_operation`, `run_agent_test`, `run_apex_test` | Core org identity, SOQL, metadata, org administration, tests | Mixed; the first three were composition-reviewed | Metadata/deploy/open/test paths do; username/SOQL do not | No separate service for the two P2 defaults | READ, METADATA_READ, MUTATION, ADMIN, LOCAL_DEV | Enable first two; retain metadata facade but default off; deny all other Tools |
| `CodeAnalyzerMcpProvider` | 0.8.1 | `create_custom_rule` (NON_GA), `get_ast_nodes_to_generate_xpath` (NON_GA), `describe_code_analyzer_rule`, `list_code_analyzer_rules`, `query_code_analyzer_results`, `run_code_analyzer` | Local source-code analysis and result inspection | Not P2/P4-compatible | Yes; Agent-selected absolute targets and durable project/result files | Code Analyzer engines/binaries | Primarily local reads plus local/global-temp file generation | `LOCAL_DEV`; deny |
| `LwcExpertsMcpProvider` | 0.7.0 | LWC creation/testing/review/orchestration; LDS/GraphQL; SLDS/LBC; accessibility/security/migration guidance. Exact GA names are listed below. | Developer guidance and code generation | Not P2-compatible | Yes | Bundled expert/knowledge assets | Local development; some generated-file writes | `LOCAL_DEV`; deny |
| `AuraExpertsMcpProvider` | 0.3.7 | `create_aura_blueprint_draft`, `enhance_aura_blueprint_draft`, `orchestrate_aura_migration`, `transition_prd_to_lwc` | Aura-to-LWC developer workflows | Not P2-compatible | Yes | Bundled expert assets | Local development/write | `LOCAL_DEV`; deny |
| `MobileWebMcpProvider` | 0.3.0 | Eleven `create_mobile_lwc_*` native-capability guides plus `get_mobile_lwc_offline_analysis`, `get_mobile_lwc_offline_guidance` | Mobile LWC development guidance | Not P2-compatible | Yes | Bundled mobile definitions/grounding | Local development | `LOCAL_DEV`; deny |
| `DevOpsMcpProvider` | 0.3.8 | Three list/check Tools and nine checkout/commit/create/promote/resolve/update Tools | DevOps Center projects and work items | Not P2-compatible without a separate service/auth review | Some mutation paths do | Salesforce DevOps Center | Mixed READ and MUTATION | Deny all in P2 |
| `ScaleProductsMcpProvider` | 0.0.6 | `scan_apex_class_for_antipatterns` | Apex scale/anti-pattern analysis | Not P2-compatible | Yes | Scale-product analysis dependencies | Local read/analysis | `LOCAL_DEV`; deny |
| `EnrichMetadataMcpProvider` | 0.1.8 | `enrich_metadata` | Local metadata enrichment | Not P2-compatible | Yes | Metadata-enrichment package/service assets | Local read/write | `LOCAL_DEV`; deny |

## Exact grouped Tool inventory

### Dx Core 0.10.0

| Classification | Tools | Current decision |
| --- | --- | --- |
| READ | `get_username`, `run_soql_query` | Enabled by default |
| METADATA_READ | `retrieve_metadata` | Available, disabled by default |
| MUTATION | `deploy_metadata` | P2 startup rejection |
| ADMIN | `assign_permission_set`, `create_org_snapshot`, `create_scratch_org`, `delete_org`, `resume_tool_operation`, `run_agent_test`, `run_apex_test` | P2 startup rejection |
| LOCAL_DEV | `list_all_orgs`, `open_org` | P2 startup rejection |

`retrieve_metadata` is not deleted: P1 proved unchanged official execution, bounded workspace use, and CWD serialization. It is not a general remote-Agent default because the client must supply meaningful manifest/source context and the operation writes a DX project workspace.

The three P2 remote contracts are also explicit executable data:

| Tool | Host-owned fields | Allowed Agent fields | Default |
| --- | --- | --- | --- |
| `get_username` | `directory` | `defaultTargetOrg`, `defaultDevHub` | Enabled |
| `run_soql_query` | `usernameOrAlias`, `directory` | `query`, `useToolingApi` | Enabled |
| `retrieve_metadata` | `usernameOrAlias`, `directory` | `ignoreConflicts`, `sourceDir`, `manifest` | Disabled |

The facade first requires an exact audited official field/requiredness/ReleaseState/output-schema match, then projects only the allowed Agent fields. An upstream field addition is not inherited.

### Code Analyzer 0.8.1

`create_custom_rule`, `describe_code_analyzer_rule`, `get_ast_nodes_to_generate_xpath`, `list_code_analyzer_rules`, `query_code_analyzer_results`, `run_code_analyzer`.

All are `LOCAL_DEV`. `create_custom_rule` and `get_ast_nodes_to_generate_xpath` are NON_GA in the actual P4 initialization; P2/P4 never opt into non-GA Tools. `run_code_analyzer` needs absolute local targets/workspace and writes results below process-global temp; `query_code_analyzer_results` accepts an absolute result file. These contracts are not adapted into the stateless remote runtime.

### LWC Experts 0.7.0

`verify_aura_migration_completeness`, `guide_figma_to_lwc_conversion`, `create_lwc_component_from_prd`, `create_lwc_jest_tests`, `guide_component_accessibility`, `guide_lwc_best_practices`, `guide_lwc_development`, `guide_lwc_rtl_support`, `review_lwc_jest_tests`, `orchestrate_lwc_component_creation`, `orchestrate_lwc_component_optimization`, `orchestrate_lwc_component_testing`, `explore_lds_uiapi`, `guide_lds_data_consistency`, `guide_lds_development`, `guide_lds_referential_integrity`, `run_lwc_accessibility_jest_tests`, `orchestrate_lwc_slds2_uplift`, `guide_lws_security`, `orchestrate_lds_data_requirements`, `guide_lds_graphql`, `create_lds_graphql_read_query`, `create_lds_graphql_mutation_query`, `fetch_lds_graphql_schema`, `test_lds_graphql_query`, `guide_design_general`, `create_lightning_type`, `guide_utam_generation`, `guide_lbc_usage`, `explore_lbc_components`, `explore_slds_blueprints`, `guide_slds_blueprints`, `explore_slds_styling`, `guide_slds_styling`, `reference_lwc_compilation_error`, `guide_lo_migration`, `validate_and_optimize`, `score_issues`.

All are `LOCAL_DEV` for the P2 remote-runtime decision. Names were enumerated from the installed official 0.7.0 bundle; provider startup also reported that some expert reviewers had no GA reviewers, so future enablement must recheck release state.

### Mobile Web 0.3.0

`create_mobile_lwc_app_review`, `create_mobile_lwc_ar_space_capture`, `create_mobile_lwc_barcode_scanner`, `create_mobile_lwc_biometrics`, `create_mobile_lwc_calendar`, `create_mobile_lwc_contacts`, `create_mobile_lwc_document_scanner`, `create_mobile_lwc_geofencing`, `create_mobile_lwc_location`, `create_mobile_lwc_nfc`, `create_mobile_lwc_payments`, `get_mobile_lwc_offline_analysis`, `get_mobile_lwc_offline_guidance`.

All are `LOCAL_DEV`.

### DevOps Center 0.3.8

- READ inventory: `check_devops_center_commit_status`, `list_devops_center_projects`, `list_devops_center_work_items`.
- MUTATION inventory: `checkout_devops_center_work_item`, `commit_devops_center_work_item`, `create_devops_center_pull_request`, `create_devops_center_work_item`, `detect_devops_center_merge_conflict`, `promote_devops_center_work_item`, `resolve_devops_center_deployment_failure`, `resolve_devops_center_merge_conflict`, `update_devops_center_work_item_status`.

Even the read group is marked not P2-compatible because P2 does not initialize the additional DevOps Center service/auth context. The mutation group is independently forbidden by phase policy.

## Inventory maintenance rule

Provider presence is not permission. A future official Tool remains unclassified until a maintainer explicitly updates the executable catalog with Provider, classification, remote compatibility, filesystem/project/service dependencies, upstream contract, and phase decision. Names, descriptions, and annotations cannot authorize it.

Run `yarn workspace @sfoa/mcp-server validate:upstream` during every upstream sync. `PASS` means actual Provider/package/API identity, Tool names, ReleaseState, input field names/requiredness, and output-schema capability exactly match the executable baseline. `UPSTREAM_REVIEW_REQUIRED` blocks compatibility acceptance until the executable policy is reviewed. Update this informational snapshot after that review; documentation differences alone never change runtime behavior.
