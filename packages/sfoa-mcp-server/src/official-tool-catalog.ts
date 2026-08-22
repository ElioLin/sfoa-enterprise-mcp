export const TOOL_CLASSIFICATIONS = [
  'READ',
  'METADATA_READ',
  'MUTATION',
  'ADMIN',
  'LOCAL_DEV',
  'UNKNOWN',
] as const;

export type ToolClassification = (typeof TOOL_CLASSIFICATIONS)[number];
export type AuditedReleaseState = 'ga' | 'non-ga';

export const DX_CORE_PROVIDER_BASELINE = Object.freeze({
  providerName: 'DxCoreMcpProvider',
  providerApiVersion: '0.6.0',
  packageName: '@salesforce/mcp-provider-dx-core',
  packageVersion: '0.10.0',
});

export type AuditedOfficialToolContract = Readonly<{
  releaseState: AuditedReleaseState;
  inputFields: readonly string[];
  requiredInputFields: readonly string[];
  hasOutputSchema: boolean;
  outputFields: readonly string[];
}>;

export type RemoteToolContract = Readonly<{
  hostOwnedArguments: readonly string[];
  allowedAgentArguments: readonly string[];
}>;

export type OfficialToolPolicyRecord = Readonly<{
  name: string;
  provider: string;
  classification: ToolClassification;
  p2RemoteCompatible: boolean;
  needsFilesystem: boolean;
  needsLocalProject: boolean;
  needsAdditionalService: boolean;
  upstreamContract?: AuditedOfficialToolContract;
  remoteContract?: RemoteToolContract;
}>;

type RecordDefaults = Omit<OfficialToolPolicyRecord, 'name'>;
type DxCoreRecord = Omit<OfficialToolPolicyRecord, 'provider' | 'upstreamContract'> &
  Readonly<{ upstreamContract: AuditedOfficialToolContract }>;

function records(defaults: RecordDefaults, names: readonly string[]): OfficialToolPolicyRecord[] {
  return names.map((name) => Object.freeze({ name, ...defaults }));
}

function dxCoreRecord(record: DxCoreRecord): OfficialToolPolicyRecord {
  return Object.freeze({
    ...record,
    provider: DX_CORE_PROVIDER_BASELINE.providerName,
    upstreamContract: freezeUpstreamContract(record.upstreamContract),
    ...(record.remoteContract ? { remoteContract: freezeRemoteContract(record.remoteContract) } : {}),
  });
}

function freezeUpstreamContract(contract: AuditedOfficialToolContract): AuditedOfficialToolContract {
  return Object.freeze({
    ...contract,
    inputFields: Object.freeze([...contract.inputFields]),
    requiredInputFields: Object.freeze([...contract.requiredInputFields]),
    outputFields: Object.freeze([...contract.outputFields]),
  });
}

function freezeRemoteContract(contract: RemoteToolContract): RemoteToolContract {
  return Object.freeze({
    hostOwnedArguments: Object.freeze([...contract.hostOwnedArguments]),
    allowedAgentArguments: Object.freeze([...contract.allowedAgentArguments]),
  });
}

const noOutputSchema = Object.freeze({ hasOutputSchema: false, outputFields: Object.freeze([]) });

export const DX_CORE_TOOL_CATALOG: readonly OfficialToolPolicyRecord[] = Object.freeze([
  dxCoreRecord({
    name: 'get_username',
    classification: 'READ',
    p2RemoteCompatible: true,
    needsFilesystem: false,
    needsLocalProject: false,
    needsAdditionalService: false,
    upstreamContract: {
      releaseState: 'ga',
      inputFields: ['defaultTargetOrg', 'defaultDevHub', 'directory'],
      requiredInputFields: ['directory'],
      ...noOutputSchema,
    },
    remoteContract: {
      hostOwnedArguments: ['directory'],
      allowedAgentArguments: ['defaultTargetOrg', 'defaultDevHub'],
    },
  }),
  dxCoreRecord({
    name: 'run_soql_query',
    classification: 'READ',
    p2RemoteCompatible: true,
    needsFilesystem: false,
    needsLocalProject: false,
    needsAdditionalService: false,
    upstreamContract: {
      releaseState: 'ga',
      inputFields: ['query', 'usernameOrAlias', 'directory', 'useToolingApi'],
      requiredInputFields: ['query', 'usernameOrAlias', 'directory'],
      ...noOutputSchema,
    },
    remoteContract: {
      hostOwnedArguments: ['usernameOrAlias', 'directory'],
      allowedAgentArguments: ['query', 'useToolingApi'],
    },
  }),
  dxCoreRecord({
    name: 'retrieve_metadata',
    classification: 'METADATA_READ',
    p2RemoteCompatible: true,
    needsFilesystem: true,
    needsLocalProject: true,
    needsAdditionalService: false,
    upstreamContract: {
      releaseState: 'ga',
      inputFields: ['ignoreConflicts', 'sourceDir', 'manifest', 'usernameOrAlias', 'directory'],
      requiredInputFields: ['usernameOrAlias', 'directory'],
      ...noOutputSchema,
    },
    remoteContract: {
      hostOwnedArguments: ['usernameOrAlias', 'directory'],
      allowedAgentArguments: ['ignoreConflicts', 'sourceDir', 'manifest'],
    },
  }),
  dxCoreRecord({
    name: 'deploy_metadata',
    classification: 'MUTATION',
    p2RemoteCompatible: false,
    needsFilesystem: true,
    needsLocalProject: true,
    needsAdditionalService: false,
    upstreamContract: {
      releaseState: 'ga',
      inputFields: [
        'ignoreConflicts',
        'sourceDir',
        'manifest',
        'apexTestLevel',
        'apexTests',
        'usernameOrAlias',
        'directory',
      ],
      requiredInputFields: ['usernameOrAlias', 'directory'],
      ...noOutputSchema,
    },
  }),
  dxCoreRecord({
    name: 'assign_permission_set',
    classification: 'ADMIN',
    p2RemoteCompatible: false,
    needsFilesystem: false,
    needsLocalProject: false,
    needsAdditionalService: false,
    upstreamContract: {
      releaseState: 'ga',
      inputFields: ['permissionSetName', 'usernameOrAlias', 'onBehalfOf', 'directory'],
      requiredInputFields: ['permissionSetName', 'usernameOrAlias', 'directory'],
      ...noOutputSchema,
    },
  }),
  dxCoreRecord({
    name: 'create_org_snapshot',
    classification: 'ADMIN',
    p2RemoteCompatible: false,
    needsFilesystem: false,
    needsLocalProject: false,
    needsAdditionalService: false,
    upstreamContract: {
      releaseState: 'non-ga',
      inputFields: ['directory', 'devHub', 'sourceOrg', 'description', 'name'],
      requiredInputFields: ['directory', 'devHub', 'sourceOrg'],
      ...noOutputSchema,
    },
  }),
  dxCoreRecord({
    name: 'create_scratch_org',
    classification: 'ADMIN',
    p2RemoteCompatible: false,
    needsFilesystem: false,
    needsLocalProject: false,
    needsAdditionalService: false,
    upstreamContract: {
      releaseState: 'non-ga',
      inputFields: [
        'directory',
        'devHub',
        'duration',
        'edition',
        'definitionFile',
        'alias',
        'async',
        'setDefault',
        'snapshot',
        'sourceOrg',
        'username',
        'description',
        'orgName',
        'adminEmail',
      ],
      requiredInputFields: ['directory', 'devHub'],
      ...noOutputSchema,
    },
  }),
  dxCoreRecord({
    name: 'delete_org',
    classification: 'ADMIN',
    p2RemoteCompatible: false,
    needsFilesystem: false,
    needsLocalProject: false,
    needsAdditionalService: false,
    upstreamContract: {
      releaseState: 'non-ga',
      inputFields: ['directory', 'usernameOrAlias'],
      requiredInputFields: ['directory', 'usernameOrAlias'],
      ...noOutputSchema,
    },
  }),
  dxCoreRecord({
    name: 'resume_tool_operation',
    classification: 'ADMIN',
    p2RemoteCompatible: false,
    needsFilesystem: false,
    needsLocalProject: false,
    needsAdditionalService: false,
    upstreamContract: {
      releaseState: 'ga',
      inputFields: ['jobId', 'wait', 'usernameOrAlias', 'directory'],
      requiredInputFields: ['jobId', 'usernameOrAlias', 'directory'],
      ...noOutputSchema,
    },
  }),
  dxCoreRecord({
    name: 'run_agent_test',
    classification: 'ADMIN',
    p2RemoteCompatible: false,
    needsFilesystem: false,
    needsLocalProject: false,
    needsAdditionalService: false,
    upstreamContract: {
      releaseState: 'ga',
      inputFields: ['agentApiName', 'usernameOrAlias', 'directory', 'async'],
      requiredInputFields: ['agentApiName', 'usernameOrAlias', 'directory'],
      ...noOutputSchema,
    },
  }),
  dxCoreRecord({
    name: 'run_apex_test',
    classification: 'ADMIN',
    p2RemoteCompatible: false,
    needsFilesystem: false,
    needsLocalProject: false,
    needsAdditionalService: false,
    upstreamContract: {
      releaseState: 'ga',
      inputFields: [
        'testLevel',
        'classNames',
        'methodNames',
        'async',
        'suiteName',
        'testRunId',
        'verbose',
        'codeCoverage',
        'usernameOrAlias',
        'directory',
      ],
      requiredInputFields: ['testLevel', 'usernameOrAlias', 'directory'],
      ...noOutputSchema,
    },
  }),
  dxCoreRecord({
    name: 'list_all_orgs',
    classification: 'LOCAL_DEV',
    p2RemoteCompatible: false,
    needsFilesystem: true,
    needsLocalProject: true,
    needsAdditionalService: false,
    upstreamContract: {
      releaseState: 'ga',
      inputFields: ['directory'],
      requiredInputFields: ['directory'],
      ...noOutputSchema,
    },
  }),
  dxCoreRecord({
    name: 'open_org',
    classification: 'LOCAL_DEV',
    p2RemoteCompatible: false,
    needsFilesystem: true,
    needsLocalProject: true,
    needsAdditionalService: false,
    upstreamContract: {
      releaseState: 'non-ga',
      inputFields: ['filePath', 'usernameOrAlias', 'directory'],
      requiredInputFields: ['usernameOrAlias', 'directory'],
      ...noOutputSchema,
    },
  }),
]);

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
  ...DX_CORE_TOOL_CATALOG,
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
