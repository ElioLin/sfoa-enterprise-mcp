export const TOOL_CLASSIFICATIONS = [
  'READ',
  'METADATA_READ',
  'MUTATION',
  'ADMIN',
  'LOCAL_DEV',
  'UNKNOWN',
] as const;

export type ToolClassification = (typeof TOOL_CLASSIFICATIONS)[number];

export type OfficialToolPolicyRecord = Readonly<{
  name: string;
  provider: string;
  classification: ToolClassification;
  p2RemoteCompatible: boolean;
  needsFilesystem: boolean;
  needsLocalProject: boolean;
  needsAdditionalService: boolean;
}>;

type RecordDefaults = Omit<OfficialToolPolicyRecord, 'name'>;

function records(defaults: RecordDefaults, names: readonly string[]): OfficialToolPolicyRecord[] {
  return names.map((name) => Object.freeze({ name, ...defaults }));
}

const dxCoreRead = records(
  {
    provider: 'DxCoreMcpProvider',
    classification: 'READ',
    p2RemoteCompatible: true,
    needsFilesystem: false,
    needsLocalProject: false,
    needsAdditionalService: false,
  },
  ['get_username', 'run_soql_query'],
);

const dxCoreMetadataRead = records(
  {
    provider: 'DxCoreMcpProvider',
    classification: 'METADATA_READ',
    p2RemoteCompatible: true,
    needsFilesystem: true,
    needsLocalProject: true,
    needsAdditionalService: false,
  },
  ['retrieve_metadata'],
);

const dxCoreMutations = records(
  {
    provider: 'DxCoreMcpProvider',
    classification: 'MUTATION',
    p2RemoteCompatible: false,
    needsFilesystem: true,
    needsLocalProject: true,
    needsAdditionalService: false,
  },
  ['deploy_metadata'],
);

const dxCoreAdmin = records(
  {
    provider: 'DxCoreMcpProvider',
    classification: 'ADMIN',
    p2RemoteCompatible: false,
    needsFilesystem: false,
    needsLocalProject: false,
    needsAdditionalService: false,
  },
  [
    'assign_permission_set',
    'create_org_snapshot',
    'create_scratch_org',
    'delete_org',
    'resume_tool_operation',
    'run_agent_test',
    'run_apex_test',
  ],
);

const dxCoreLocal = records(
  {
    provider: 'DxCoreMcpProvider',
    classification: 'LOCAL_DEV',
    p2RemoteCompatible: false,
    needsFilesystem: true,
    needsLocalProject: true,
    needsAdditionalService: false,
  },
  ['list_all_orgs', 'open_org'],
);

const codeAnalyzerLocal = records(
  {
    provider: 'CodeAnalyzerMcpProvider',
    classification: 'LOCAL_DEV',
    p2RemoteCompatible: false,
    needsFilesystem: true,
    needsLocalProject: true,
    needsAdditionalService: true,
  },
  [
    'create_custom_rule',
    'describe_code_analyzer_rule',
    'get_ast_nodes_to_generate_xpath',
    'list_code_analyzer_rules',
    'query_code_analyzer_results',
    'run_code_analyzer',
  ],
);

const devOpsRead = records(
  {
    provider: 'DevOpsMcpProvider',
    classification: 'READ',
    p2RemoteCompatible: false,
    needsFilesystem: false,
    needsLocalProject: false,
    needsAdditionalService: true,
  },
  ['check_devops_center_commit_status', 'list_devops_center_projects', 'list_devops_center_work_items'],
);

const devOpsMutation = records(
  {
    provider: 'DevOpsMcpProvider',
    classification: 'MUTATION',
    p2RemoteCompatible: false,
    needsFilesystem: true,
    needsLocalProject: true,
    needsAdditionalService: true,
  },
  [
    'checkout_devops_center_work_item',
    'commit_devops_center_work_item',
    'create_devops_center_pull_request',
    'create_devops_center_work_item',
    'detect_devops_center_merge_conflict',
    'promote_devops_center_work_item',
    'resolve_devops_center_deployment_failure',
    'resolve_devops_center_merge_conflict',
    'update_devops_center_work_item_status',
  ],
);

const auraLocal = records(
  {
    provider: 'AuraExpertsMcpProvider',
    classification: 'LOCAL_DEV',
    p2RemoteCompatible: false,
    needsFilesystem: true,
    needsLocalProject: true,
    needsAdditionalService: false,
  },
  [
    'create_aura_blueprint_draft',
    'enhance_aura_blueprint_draft',
    'orchestrate_aura_migration',
    'transition_prd_to_lwc',
  ],
);

const lwcLocal = records(
  {
    provider: 'LwcExpertsMcpProvider',
    classification: 'LOCAL_DEV',
    p2RemoteCompatible: false,
    needsFilesystem: true,
    needsLocalProject: true,
    needsAdditionalService: false,
  },
  [
    'create_lwc_component_from_prd',
    'create_lwc_jest_tests',
    'review_lwc_jest_tests',
    'create_lightning_type',
    'explore_slds_blueprints',
    'guide_design_general',
    'guide_component_accessibility',
    'guide_lwc_best_practices',
    'guide_lwc_development',
    'guide_lwc_rtl_support',
    'guide_lws_security',
    'guide_slds_blueprints',
    'guide_utam_generation',
    'reference_lwc_compilation_error',
    'guide_slds_styling',
    'explore_slds_styling',
    'guide_lbc_usage',
    'explore_lbc_components',
    'create_lds_graphql_mutation_query',
    'create_lds_graphql_read_query',
    'explore_lds_uiapi',
    'fetch_lds_graphql_schema',
    'guide_lds_data_consistency',
    'guide_lds_development',
    'guide_lds_graphql',
    'guide_lds_referential_integrity',
    'orchestrate_lds_data_requirements',
    'test_lds_graphql_query',
    'guide_figma_to_lwc_conversion',
    'guide_lo_migration',
    'run_lwc_accessibility_jest_tests',
    'verify_aura_migration_completeness',
    'orchestrate_lwc_component_creation',
    'orchestrate_lwc_component_optimization',
    'orchestrate_lwc_component_testing',
    'orchestrate_lwc_slds2_uplift',
    'validate_and_optimize',
    'score_issues',
  ],
);

const mobileLocal = records(
  {
    provider: 'MobileWebMcpProvider',
    classification: 'LOCAL_DEV',
    p2RemoteCompatible: false,
    needsFilesystem: true,
    needsLocalProject: true,
    needsAdditionalService: false,
  },
  [
    'create_mobile_lwc_app_review',
    'create_mobile_lwc_ar_space_capture',
    'create_mobile_lwc_barcode_scanner',
    'create_mobile_lwc_biometrics',
    'create_mobile_lwc_calendar',
    'create_mobile_lwc_contacts',
    'create_mobile_lwc_document_scanner',
    'create_mobile_lwc_geofencing',
    'create_mobile_lwc_location',
    'create_mobile_lwc_nfc',
    'create_mobile_lwc_payments',
    'get_mobile_lwc_offline_analysis',
    'get_mobile_lwc_offline_guidance',
  ],
);

const otherLocal = [
  ...records(
    {
      provider: 'EnrichMetadataMcpProvider',
      classification: 'LOCAL_DEV',
      p2RemoteCompatible: false,
      needsFilesystem: true,
      needsLocalProject: true,
      needsAdditionalService: true,
    },
    ['enrich_metadata'],
  ),
  ...records(
    {
      provider: 'ScaleProductsMcpProvider',
      classification: 'LOCAL_DEV',
      p2RemoteCompatible: false,
      needsFilesystem: true,
      needsLocalProject: true,
      needsAdditionalService: true,
    },
    ['scan_apex_class_for_antipatterns'],
  ),
];

export const OFFICIAL_TOOL_CATALOG: readonly OfficialToolPolicyRecord[] = Object.freeze([
  ...dxCoreRead,
  ...dxCoreMetadataRead,
  ...dxCoreMutations,
  ...dxCoreAdmin,
  ...dxCoreLocal,
  ...codeAnalyzerLocal,
  ...devOpsRead,
  ...devOpsMutation,
  ...auraLocal,
  ...lwcLocal,
  ...mobileLocal,
  ...otherLocal,
]);

export function findOfficialToolPolicy(name: string): OfficialToolPolicyRecord | undefined {
  return OFFICIAL_TOOL_CATALOG.find((record) => record.name === name);
}
