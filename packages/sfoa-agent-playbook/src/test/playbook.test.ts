import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_PLAYBOOK_VERSION,
  AGENT_RECOGNIZED_TOOL_NAMES,
  DATA_COMPLETENESS_TOOL_NAMES,
  DIAGNOSTICS_TOOL_NAMES,
  GENERATED_AGENT_ARTIFACT_MARKER,
  PLAYBOOK_SECTION_NAMES,
  createAgentCapabilities,
  renderDifyInstruction,
  renderFullPlaybook,
  renderServerInstructions,
  renderWeComRoleSetting,
  renderWorkflow,
  renderWorkBuddySkill,
  renderWorkBuddySystemPrompt,
  renderWorkflowReference,
} from '../index.js';

describe('canonical SFoA Agent Playbook', () => {
  it('distributes the bounded effective CREATE workflow without asking Agents to parse metadata', () => {
    for (const output of [renderFullPlaybook(), renderDifyInstruction(), renderWorkflowReference(), renderWorkBuddySystemPrompt(), renderWorkflow('CREATE')]) {
      for (const token of ['draftFields', 'PENDING', 'UNKNOWN', 'optionalCandidate', 'uiContextResolutionId', 'effectiveRequired']) assert.ok(output.includes(token), token);
      assert.match(output, /refine at most 3 times/iu);
    }
  });
  it('has the accepted semantic version and all required sections', () => {
    assert.equal(AGENT_PLAYBOOK_VERSION, '1.12.0');
    assert.deepEqual(PLAYBOOK_SECTION_NAMES, [
      'CORE', 'READ', 'DATA_COMPLETENESS', 'ORG_OBJECT_USAGE', 'CREATE', 'UPDATE', 'ATTACHMENT', 'BATCH', 'COMPOUND', 'DIAGNOSIS', 'DIAGNOSTICS', 'LOOKUP', 'PICKLIST',
      'RESPONSE_FORMAT', 'ERROR_HANDLING', 'SAFETY_BOUNDARIES',
    ]);
  });

  it('normalizes only recognized effective capability facts deterministically', () => {
    const capabilities = createAgentCapabilities({
      enabledTools: ['future_tool', 'update_record', 'run_soql_query', 'create_record'],
      createAllowedObjects: ['Lead', 'Account', 'not valid!'],
      updateAllowedObjects: ['Contact', 'Contact'],
      diagnosticReady: true,
      managedDmlFields: [
        { objectApiName: 'Lead', fieldApiName: 'Requested_By__c', operations: ['CREATE'], managedBy: 'MCP', strategy: 'PLATFORM_IDENTITY' },
        { objectApiName: 'Contact', fieldApiName: 'Created_By_AI__c', operations: ['UPDATE'], managedBy: 'MCP', strategy: 'AI_CREATED_MARKER' },
      ],
    });

    assert.deepEqual(capabilities.enabledTools, ['run_soql_query', 'create_record', 'update_record']);
    assert.deepEqual(capabilities.createAllowedObjects, ['Account', 'Lead']);
    assert.deepEqual(capabilities.updateAllowedObjects, ['Contact']);
    assert.equal(capabilities.diagnosticReady, false);
    assert.equal(capabilities.dynamicFormEvidence, 'NOT_AVAILABLE');
    assert.deepEqual(capabilities.managedDmlFields, [{
      objectApiName: 'Lead', fieldApiName: 'Requested_By__c', operations: ['CREATE'], managedBy: 'MCP', strategy: 'PLATFORM_IDENTITY',
    }]);
  });

  it('renders every required safety contract on every distribution surface', () => {
    const capabilities = createAgentCapabilities({
      enabledTools: [
        'run_soql_query', 'create_record', 'update_record', 'get_record_action_context',
        'run_diagnostic_tooling_query', 'get_metadata_component_context',
        'get_agent_playbook', 'get_record_links',
      ],
      createAllowedObjects: ['Account'],
      updateAllowedObjects: ['Contact'],
      diagnosticReady: true,
      managedDmlFields: [{
        objectApiName: 'Account', fieldApiName: 'Requested_By__c', operations: ['CREATE'], managedBy: 'MCP', strategy: 'PLATFORM_IDENTITY',
      }],
    });
    const outputs = [
      renderServerInstructions(capabilities),
      renderFullPlaybook(capabilities),
      renderWorkflow('READ', capabilities),
      renderWorkflow('CREATE', capabilities),
      renderWorkflow('UPDATE', capabilities),
      renderWorkflow('DIAGNOSIS', capabilities),
      renderDifyInstruction(capabilities),
      renderWorkBuddySkill(),
      renderWorkBuddySystemPrompt(capabilities),
    ];

    for (const output of outputs) {
      assert.match(output, new RegExp(AGENT_PLAYBOOK_VERSION.replace(/\./gu, '\\.'), 'u'));
      assert.match(output, /MCP_DML_OUTCOME_UNKNOWN/u);
      assert.match(output, /do not automatically retry|never auto-retry|do not automatically retry/u);
    }
    assert.match(renderFullPlaybook(capabilities), /READ \(SOQL\) scope/u);
    assert.match(renderFullPlaybook(capabilities), /NOT bounded by the CREATE\/UPDATE allowlists/u);
    assert.match(renderFullPlaybook(capabilities), /govern only `create_record`, `update_record`, `create_records` and `update_records`, never reads/u);
    assert.match(renderWorkflow('READ', capabilities), /READ is never bounded by the CREATE\/UPDATE allowlists or DML policy/u);
    assert.match(renderWorkflow('READ', capabilities), /Account, Opportunity, Contact/u);
    assert.match(renderFullPlaybook(capabilities), /Dynamic Forms evidence: `NOT_AVAILABLE`/u);
    assert.match(renderFullPlaybook(capabilities), /actual changes needed to complete this business task/u);
    assert.match(renderFullPlaybook(capabilities), /trusted Lightning record link/u);
    assert.match(renderWorkflow('CREATE', capabilities), /relevant optional fields/u);
    assert.match(renderWorkflow('CREATE', capabilities), /required, recommended, and other optional fields/u);
    assert.match(renderWorkflow('CREATE', capabilities), /show the bounded current valid choices/u);
    assert.match(renderWorkflow('UPDATE', capabilities), /CREATE-required fields are not automatically required/u);
    assert.match(renderWorkflow('READ', capabilities), /roughly 6 to 10 useful columns/u);
    assert.match(renderWorkflow('READ', capabilities), /display\/name field and trusted link/u);
    assert.match(renderFullPlaybook(capabilities), /Do not hardcode object-specific/u);
    assert.match(renderFullPlaybook(capabilities), /Do not create a Runtime Form Engine/u);
    assert.match(renderFullPlaybook(capabilities), /MCP-managed DML fields: `Account\.Requested_By__c`/u);
    assert.match(renderWorkflow('CREATE', capabilities), /Exclude only strict `PLATFORM_IDENTITY` and `AI_CREATED_MARKER` fields from required questions/u);
    assert.match(renderServerInstructions(capabilities), /strict server-owned values: omit them/u);
    assert.match(renderFullPlaybook(capabilities), /## ORG_OBJECT_USAGE/u);
    assert.match(renderFullPlaybook(capabilities), /`Quote`/u);
    assert.match(renderFullPlaybook(capabilities), /`Quote__c`/u);
    assert.match(renderFullPlaybook(capabilities), /MCP_SOBJECT_NOT_IN_USE/u);
    assert.match(renderWorkflow('READ', capabilities), /## ORG_OBJECT_USAGE/u);
    assert.match(renderServerInstructions(capabilities), /declares the standard Salesforce objects/u);
  });

  it('does not claim unavailable capabilities and never includes unknown or secret-shaped facts', () => {
    const secret = 'MCP_CLIENT_TOKEN=<TEST_ONLY_SECRET_SHAPED_VALUE>';
    const output = renderDifyInstruction(createAgentCapabilities({
      enabledTools: ['run_soql_query', 'future_unknown_tool', secret],
      createAllowedObjects: [secret],
      updateAllowedObjects: [secret],
      diagnosticReady: true,
    }));

    assert.match(output, /CREATE.*unavailable/su);
    assert.match(output, /Diagnostic.*not ready|DIAGNOSIS.*unavailable/su);
    assert.doesNotMatch(output, /future_unknown_tool|TEST_ONLY_SECRET_SHAPED_VALUE/u);
    assert.match(output, /Do not configure `X-Platform-User-Id`/u);
  });

  it('keeps static generated guidance capability-neutral', () => {
    const outputs = [renderDifyInstruction(), renderWorkBuddySystemPrompt()];
    for (const output of outputs) {
      assert.match(output, /distribution template/u);
      assert.match(output, /no capability is implied/u);
      assert.doesNotMatch(output, /Status: available for/u);
      assert.match(output, /## ORG_OBJECT_USAGE/u);
    }
    assert.ok(renderWorkBuddySkill().includes(GENERATED_AGENT_ARTIFACT_MARKER), 'generated marker');
  });

  it('encodes the P8-03 presentation-intelligence contract on the workflow surfaces', () => {
    const capabilities = createAgentCapabilities({
      enabledTools: [
        'run_soql_query', 'create_record', 'update_record', 'get_record_action_context',
        'get_record_display_context', 'run_diagnostic_tooling_query', 'get_metadata_component_context',
        'get_agent_playbook', 'get_record_links',
      ],
      createAllowedObjects: ['Quote__c'],
      updateAllowedObjects: ['Quote__c'],
      dynamicFormEvidence: 'NOT_AVAILABLE',
    });

    const create = renderWorkflow('CREATE', capabilities);
    // CREATE must branch on available Record Types instead of silently using the default.
    assert.match(create, /availableRecordTypes/u);
    assert.match(create, /Select from task meaning, candidate labels.descriptions and an applicable default/u);
    assert.match(create, /Multiple candidates alone do not require a question/u);
    assert.match(create, /ask only when business ambiguity remains/u);
    assert.match(create, /no available Record Type, stop and tell the user/u);

    const read = renderWorkflow('READ', capabilities);
    // READ must use display context as evidence, not a whitelist, and separate analytics.
    assert.match(read, /call `get_record_display_context` first when it is enabled/u);
    assert.match(read, /not a fixed field allowlist/u);
    assert.match(read, /analytical queries and do not force record framing on them/u);
    assert.match(read, /do not fabricate an Id, add a per-row record hyperlink/u);

    const full = renderFullPlaybook(capabilities);
    // Normal business answers must suppress raw Salesforce IDs.
    assert.match(full, /Keep raw Salesforce IDs internal in normal business answers/u);
    assert.match(full, /Surface a Record ID only when the user explicitly asks/u);
    assert.match(full, /Answer like a business-aware assistant, not a SOQL JSON dump/u);
    assert.doesNotMatch(full, /include the Salesforce Record ID as supporting detail/u);
    // The distribution surfaces must stay versioned and carry the display-context pointer.
    assert.match(full, /## CORE —/u);
    assert.match(renderDifyInstruction(capabilities), /get_record_display_context/u);
    assert.match(renderServerInstructions(capabilities), /keep raw Salesforce Record IDs internal/u);
  });

  it('distributes the file-attachment contract as its own capability, never as Generic DML', () => {
    const enabled = createAgentCapabilities({
      enabledTools: ['run_soql_query', 'create_record', 'upload_files_to_record'],
      createAllowedObjects: ['Quote__c'],
      updateAllowedObjects: [],
      attachmentEnabledObjects: ['Quote__c', 'Lead'],
    });

    // Attachment enablement is its own list and never derives from CREATE/UPDATE.
    assert.deepEqual(enabled.attachmentEnabledObjects, ['Lead', 'Quote__c']);
    const createOnly = createAgentCapabilities({
      enabledTools: ['create_record'],
      createAllowedObjects: ['Quote__c'],
      attachmentEnabledObjects: ['Quote__c'],
    });
    assert.deepEqual(createOnly.attachmentEnabledObjects, [],
      'a CREATE grant must not imply attachment upload');
    const attachmentOnly = createAgentCapabilities({
      enabledTools: ['upload_files_to_record'],
      createAllowedObjects: ['Quote__c'],
      attachmentEnabledObjects: ['Quote__c'],
    });
    assert.deepEqual(attachmentOnly.createAllowedObjects, [],
      'an attachment grant must not imply CREATE');
    assert.deepEqual(attachmentOnly.attachmentEnabledObjects, ['Quote__c']);

    for (const text of [renderWorkflow('CREATE', enabled), renderFullPlaybook(enabled), renderDifyInstruction(enabled)]) {
      assert.match(text, /Attachment-enabled objects: `Lead`, `Quote__c`/u);
      assert.match(text, /Attachment-enabled objects:[\s\S]*never implied by either/u);
    }
    const attachment = renderWorkflow('CREATE', enabled);
    assert.match(attachment, /## ATTACHMENT —/u);
    // Never a Generic DML object surface.
    assert.match(attachment, /ContentVersion, ContentDocument and ContentDocumentLink are Salesforce internal technical objects/u);
    assert.match(attachment, /Never pass them to `create_record`, `create_records`, `update_record` or `update_records`/u);
    // The model never handles file bytes or a caller-supplied location.
    assert.match(attachment, /It never accepts file content, base64, a byte array, a filesystem path, or a URL/u);
    assert.match(attachment, /never attempt to read a file in order to upload it/u);
    // Reference handling, target resolution, per-file outcomes, and Salesforce's authority.
    assert.match(attachment, /Never invent, guess, transform, or reuse another user's reference/u);
    assert.match(attachment, /never attach to a record whose CREATE ended OUTCOME_UNKNOWN/u);
    assert.match(attachment, /Report each file's own status/u);
    assert.match(attachment, /Salesforce is the final authority on whether a file is accepted/u);
    assert.match(attachment, /An attachment with OUTCOME_UNKNOWN must not be automatically retried/u);
    // UPDATE carries the same section; READ and DIAGNOSIS do not.
    assert.match(renderWorkflow('UPDATE', enabled), /## ATTACHMENT —/u);
    assert.doesNotMatch(renderWorkflow('READ', enabled), /## ATTACHMENT —/u);
    assert.doesNotMatch(renderWorkflow('DIAGNOSIS', enabled), /## ATTACHMENT —/u);
    // Without the Tool the section reports itself unavailable rather than silently vanishing.
    const withoutTool = renderWorkflow('CREATE', createAgentCapabilities({
      enabledTools: ['create_record'], createAllowedObjects: ['Quote__c'],
    }));
    assert.match(withoutTool, /Status: unavailable — `upload_files_to_record` or an effective attachment object policy is absent/u);
    assert.match(renderServerInstructions(enabled), /upload_files_to_record/u);
  });

  it('encodes the CREATE two-stage Record Type dialog so facts load before field questions', () => {
    const create = renderWorkflow('CREATE', createAgentCapabilities({
      enabledTools: ['get_record_action_context', 'create_record'],
      createAllowedObjects: ['Quote__c'],
      updateAllowedObjects: [],
      dynamicFormEvidence: 'NOT_AVAILABLE',
    }));

    // While selection is required the create facts are not loaded: only the available
    // Record Types are shown and no Layout/Picklist/Record-Type field questions start.
    assert.match(create, /recordTypeSelectionRequired=true/u);
    assert.match(create, /resolve the type from task and current candidates\/default/u);
    assert.match(create, /before using its Layout, Create Defaults, Picklist or required\/editable facts/u);
    // The second context call carries the chosen Record Type; field collection and the
    // create_record payload both use that same Record Type.
    assert.match(create, /call get_record_action_context with that recordTypeId/u);
    assert.match(create, /not a mandatory two-turn user dialog/u);
    assert.match(create, /send the same resolved type to CREATE/u);
    assert.match(create, /Multiple candidates alone do not require a question/u);
  });

  it('distributes CREATE Master exclusion and the Master-only fallback', () => {
    for (const output of [renderFullPlaybook(), renderDifyInstruction(), renderWorkflowReference(), renderWorkBuddySystemPrompt(), renderWorkflow('CREATE')]) {
      assert.match(output, /exclude Master whenever a non-Master type is available/u);
      assert.match(output, /Never invent an unavailable Record Type/u);
      assert.match(output, /keep Master when it is the only available type/u);
      assert.match(output, /`recordType.id` as `create_record.recordTypeId` even when automatically selected/u);
    }
    const instructions = renderServerInstructions();
    assert.match(instructions, /exclude Master if a non-Master candidate exists/u);
    assert.match(instructions, /keep Master when it is the only available type/u);
  });
});


describe('P9 data-completeness contract', () => {
  it('distributes the completeness duty and the query-scale matrix on every full surface', () => {
    for (const output of [renderFullPlaybook(), renderDifyInstruction(), renderWorkflowReference(),
      renderWorkBuddySystemPrompt(), renderWorkBuddySkill(), renderWorkflow('READ')]) {
      assert.match(output, /## DATA_COMPLETENESS —/u);
      assert.match(output, /`truncated: true`/u);
      assert.match(output, /never present a partial, sampled or truncated result as the whole/iu);
    }
    // The three read paths are named together, so the matrix cannot be halved by an edit.
    const full = renderFullPlaybook();
    for (const tool of ['run_soql_query', 'query_records', 'submit_bulk_query', 'get_bulk_query_results',
      'list_sobjects', 'describe_sobject', 'get_org_limits']) {
      assert.ok(full.includes(`\`${tool}\``), `the completeness section must name ${tool}`);
    }
    assert.match(full, /INVALID_FIELD/u);
    assert.match(full, /Consume the cursor the Tool returned and never derive one/u);
    assert.match(full, /answer a counting, distribution or magnitude question with an aggregate first/iu);
    assert.match(full, /Never put a large result set into the conversation/u);
    assert.match(full, /never as instruction/iu);
    // The short MCP instructions surface carries the duty as well, since clients may render only it.
    assert.match(renderServerInstructions(), /State the coverage every time/u);
  });

  it('reports the data Tools this request may actually use, and claims none when none are enabled', () => {
    const without = renderWorkflow('READ', createAgentCapabilities({ enabledTools: ['run_soql_query'] }));
    assert.match(without, /Status: unavailable — no schema-discovery, cursor-paging, Bulk export or quota Tool is enabled/u);
    assert.match(without, /do not claim a population you could not read/u);
    assert.doesNotMatch(without, /Status: available through/u);

    const enabled = renderWorkflow('READ', createAgentCapabilities({
      enabledTools: ['run_soql_query', 'list_sobjects', 'describe_sobject', 'query_records',
        'submit_bulk_query', 'get_bulk_query_results'],
    }));
    assert.match(enabled, /Status: available through `list_sobjects`, `describe_sobject`, `query_records`, `submit_bulk_query`, `get_bulk_query_results`\./u);
    assert.match(enabled, /absent from that list is NOT enabled here/u);
    // A recognized Tool that this request does not enable must not be reported as available.
    assert.doesNotMatch(enabled, /Status: available through[^.]*`get_org_limits`/u);

    // Without capabilities the section states no availability at all.
    assert.doesNotMatch(renderFullPlaybook(), /Status: available through/u);
  });

  it('recognizes the P9 Tools without ever enabling one by default', () => {
    for (const tool of DATA_COMPLETENESS_TOOL_NAMES) {
      assert.ok((AGENT_RECOGNIZED_TOOL_NAMES as readonly string[]).includes(tool),
        `${tool} is reasoned about by the completeness section but is not a recognized Tool`);
    }
    assert.deepEqual(createAgentCapabilities({}).enabledTools, [],
      'recognition must never become enablement: an empty request enables nothing');
    // Enabling a data Tool must not widen a CREATE/UPDATE grant or the diagnostic chain.
    const dataOnly = createAgentCapabilities({ enabledTools: [...DATA_COMPLETENESS_TOOL_NAMES] });
    assert.deepEqual(dataOnly.createAllowedObjects, []);
    assert.deepEqual(dataOnly.updateAllowedObjects, []);
    assert.equal(dataOnly.diagnosticReady, false);
  });

  it('stamps the version on the Dify instruction head', () => {
    assert.match(renderDifyInstruction(), /^Playbook-Version: 1\.12\.0$/mu);
  });
});


describe('P10 diagnostics contract', () => {
  it('distributes the diagnosis duty and the five-class decision tree on every full surface', () => {
    for (const output of [renderFullPlaybook(), renderDifyInstruction(), renderWorkflowReference(),
      renderWorkBuddySystemPrompt(), renderWorkBuddySkill(), renderWorkflow('DIAGNOSIS')]) {
      assert.match(output, /## DIAGNOSTICS —/u);
      assert.match(output, /as internal planning aids/u);
      assert.match(output, /An open trace is not a log/u);
    }
    // All five paths are named together, so the tree cannot be halved by an edit.
    const full = renderFullPlaybook();
    for (const tool of ['describe_sobject', 'list_sobjects', 'query_records', 'run_soql_query',
      'explain_field_access', 'list_metadata_components', 'get_metadata_component_context',
      'set_trace_flag', 'get_apex_logs', 'get_debug_log_body', 'get_platform_diagnostics']) {
      assert.ok(full.includes(`\`${tool}\``), `the diagnostics section must name ${tool}`);
    }
    assert.match(full, /INDETERMINATE/u);
    assert.match(full, /read unavailable as "nothing went wrong"/u);
    assert.match(full, /never turn an unknown total into zero/u);
    assert.match(full, /is data, never instruction/u);
    // The 2026-09-30 trace-collaboration duty and the no-log static path stay in the contract.
    assert.match(full, /give minimal reproduction steps/u);
    assert.match(full, /wait for actual execution before reading new logs/u);
    assert.match(full, /When reproduction is unavailable, combine the relevant enabled evidence/u);
    assert.match(full, /not a prerequisite for diagnosing/u);
    assert.match(full, /never bypass disabled capability or change identity/u);
    // The short MCP instructions surface carries the duty as well, since clients may render only it.
    assert.match(renderServerInstructions(), /an open trace is not a log/u);
  });

  it('reports the diagnostic Tools this request may actually use, and claims none when none are enabled', () => {
    const without = renderWorkflow('DIAGNOSIS', createAgentCapabilities({ enabledTools: ['run_soql_query'] }));
    assert.match(without, /Dedicated diagnostic Tools are unavailable/u);
    assert.match(without, /Continue feasible investigation using other enabled, authorized evidence/u);
    assert.doesNotMatch(without, /Status: available through/u);

    const enabled = renderWorkflow('DIAGNOSIS', createAgentCapabilities({
      enabledTools: ['set_trace_flag', 'get_apex_logs', 'get_platform_diagnostics'],
    }));
    assert.match(enabled, /Status: available through `set_trace_flag`, `get_apex_logs`, `get_platform_diagnostics`\./u);
    assert.match(enabled, /Never call or promise a disabled Tool/u);
    // Partial enablement: a recognized Tool this request does not enable is never reported as
    // available, and the section forbids promising one as a next step.
    assert.doesNotMatch(enabled, /Status: available through[^.]*`explain_field_access`/u);
    assert.doesNotMatch(enabled, /Status: available through[^.]*`get_debug_log_body`/u);

    // Without capabilities the section states no availability at all.
    assert.doesNotMatch(renderFullPlaybook(), /Status: available through/u);
  });

  it('recognizes the P10 Tools without ever enabling one by default', () => {
    for (const tool of DIAGNOSTICS_TOOL_NAMES) {
      assert.ok((AGENT_RECOGNIZED_TOOL_NAMES as readonly string[]).includes(tool),
        `${tool} is reasoned about by the diagnostics section but is not a recognized Tool`);
    }
    assert.deepEqual(createAgentCapabilities({}).enabledTools, [],
      'recognition must never become enablement: an empty request enables nothing');
    // Enabling the diagnostic surface must not widen a CREATE/UPDATE grant, and it must not make
    // the legacy Diagnostic chain read as ready on its own.
    const diagnosticsOnly = createAgentCapabilities({ enabledTools: [...DIAGNOSTICS_TOOL_NAMES] });
    assert.deepEqual(diagnosticsOnly.createAllowedObjects, []);
    assert.deepEqual(diagnosticsOnly.updateAllowedObjects, []);
    assert.equal(diagnosticsOnly.diagnosticReady, false);
  });
});


describe('strategy-aware managed fallback behavior contract', () => {
  it('normalizes fallback capabilities independently from strict fields', () => {
    const field = { objectApiName: 'Order__c', fieldApiName: 'Order_Owner__c', operations: ['CREATE'] as const,
      managedBy: 'MCP' as const, strategy: 'PLATFORM_IDENTITY_FALLBACK' as const };
    assert.deepEqual(createAgentCapabilities({ enabledTools: ['create_record', 'update_record'],
      createAllowedObjects: ['Order__c'], updateAllowedObjects: ['Order__c'], managedDmlFields: [field] }).managedDmlFields, [field]);
  });

  it('covers required supplied, required absent/default, optional absent, and explicit lookup on all full surfaces', () => {
    for (const text of [renderWorkflow('CREATE'), renderFullPlaybook(), renderDifyInstruction(), renderWorkBuddySystemPrompt()]) {
      for (const fact of ['managedDmlFields[].fieldApiName', 'fields[].apiName', 'apiRequired', 'layoutRequired', 'fieldCreateable', 'layoutEditableForCreate']) {
        assert.ok(text.includes(fact), fact);
      }
      assert.match(text, /already specified a fallback field, do not ask for it again/u);
      assert.match(text, /omit it and let Runtime apply PLATFORM_IDENTITY_FALLBACK/u);
      assert.match(text, /including when required/u);
      assert.match(text, /optional and absent, omit it without an extra question/u);
      assert.match(text, /default.*current user.*no other person/u);
      assert.match(text, /never query or guess the current platform-user Lookup Id yourself/u);
      assert.match(text, /submit the uniquely proven Salesforce Id, never the name/u);
      assert.match(text, /referenceTo/u);
      assert.match(text, /uniquely proven Lookup ID/u);
      assert.match(text, /With incomplete or multiple candidates/u);
      assert.match(text, /never ask|do not ask/u);
      assert.doesNotMatch(text, /Exclude MCP-managed fields from required questions/u);
    }
    const update = renderWorkflow('UPDATE');
    assert.match(update, /fieldUpdateable.*layoutEditableForUpdate/u);
    assert.match(update, /not an automatic UPDATE default/u);
    assert.match(update, /Do not inject or default the field on unrelated UPDATEs/u);
    assert.match(update, /normal UPDATE \+ LOOKUP workflow/u);
    assert.doesNotMatch(update, /applyOnUpdate/u);
    assert.match(update, /CREATE-required fields are not automatically required/u);
    assert.match(update, /actual changes needed to complete this business task/u);
  });

  it('keeps concise instructions and WorkBuddy entrypoint strategy-aware', () => {
    for (const text of [renderServerInstructions(), renderWorkBuddySkill()]) {
      for (const fact of ['PLATFORM_IDENTITY', 'AI_CREATED_MARKER', 'PLATFORM_IDENTITY_FALLBACK', 'by omission', 'CREATE', 'Lookup', 'UPDATE']) assert.ok(text.includes(fact), fact);
    }
  });
});


describe('WeCom recommended role setting renderer', () => {
  const capabilities = createAgentCapabilities({
    enabledTools: [
      'run_soql_query', 'create_record', 'update_record', 'get_record_action_context',
      'run_diagnostic_tooling_query', 'get_metadata_component_context',
      'get_agent_playbook', 'get_record_links',
    ],
    createAllowedObjects: ['Lead', 'Account'],
    updateAllowedObjects: ['Contact'],
    diagnosticReady: true,
    managedDmlFields: [{
      objectApiName: 'Account', fieldApiName: 'Requested_By__c', operations: ['CREATE'], managedBy: 'MCP', strategy: 'PLATFORM_IDENTITY',
    }],
  });

  it('renders a versioned, Chinese-first WeCom role setting that is deterministic and secret-free', () => {
    const output = renderWeComRoleSetting(capabilities);
    assert.match(output, /推荐角色设定/u);
    assert.match(output, /企业微信 SFoA Salesforce 助手/u);
    assert.match(output, new RegExp(`Playbook-Version: ${AGENT_PLAYBOOK_VERSION}`));
    assert.equal(AGENT_PLAYBOOK_VERSION, '1.12.0');
    assert.equal(renderWeComRoleSetting(capabilities), output);

    // Secret / host-token semantics from other channels must never appear.
    for (const token of ['CURRENT_USER_TOKEN', 'USER_BOUND_TOKEN', 'BUNTU_TOKEN', 'validate-token', 'TEST_ONLY_SECRET', 'Bearer <']) {
      assert.equal(output.includes(token), false, token);
    }
  });

  it('keeps the persona in business semantics and free of identity-implementation or credential detail', () => {
    const output = renderWeComRoleSetting(capabilities);
    // Anchors on the WeCom Smart Bot persona and the current WeCom user's Salesforce permissions.
    assert.match(output, /企业微信智能机器人/u);
    assert.match(output, /当前企业微信用户/u);
    assert.match(output, /Salesforce/u);
    assert.match(output, /MCP 服务/u);
    assert.match(output, /最小授权/u);
    assert.match(output, /不要要求用户提供 Salesforce 用户名/u);
    assert.match(output, /不要向任何工具传身份选择参数/u);
    assert.match(output, /不要尝试切换、指定或冒充其他 Salesforce 用户/u);
    // No identity-implementation or host-token mechanics leak into the AI persona.
    for (const token of [
      'X-WeCom-User-Id', 'WECOM_HEADER', 'MCP_CLIENT_TOKEN', '接入网关', '自建应用',
      'MCP_WECOM_CLIENT_TOKEN', 'initialize', 'tools/list', 'CredentialAuthenticator',
      'CURRENT_USER_TOKEN', 'USER_BOUND_TOKEN', 'BUNTU_TOKEN', 'Bearer <',
    ]) {
      assert.equal(output.includes(token), false, token);
    }
  });

  it('reflects dynamic capability facts and never claims unavailable capabilities', () => {
    const output = renderWeComRoleSetting(capabilities);
    assert.match(output, /启用工具：`run_soql_query`, `create_record`, `update_record`, `get_record_action_context`, `run_diagnostic_tooling_query`, `get_metadata_component_context`, `get_agent_playbook`, `get_record_links`。/u);
    assert.match(output, /新建：可用 — 对象范围 `Account`, `Lead`。/u);
    assert.match(output, /更新：可用 — 对象范围 `Contact`。/u);
    assert.match(output, /诊断链就绪：是。/u);
    assert.ok(output.includes('`Account.Requested_By__c`'), 'managed DML field fact');
    assert.match(output, /MCP_DML_OUTCOME_UNKNOWN/u);
    assert.match(output, /do not automatically retry/u);

    const bare = renderWeComRoleSetting(createAgentCapabilities({
      enabledTools: ['run_soql_query'],
      createAllowedObjects: [],
      updateAllowedObjects: [],
    }));
    assert.match(bare, /新建：不可用/u);
    assert.match(bare, /更新：不可用/u);
    assert.match(bare, /读取：可用/u);

    const template = renderWeComRoleSetting();
    assert.match(template, /推荐角色设定模板/u);
    assert.match(template, /不得据此声称任何工具或对象可用/u);
    assert.doesNotMatch(template, /可用 — 对象范围/u);
    assert.doesNotMatch(template, /Status: available/u);
  });

  it('distributes the CREATE Record Type dialog and managed-field fallback contract', () => {
    const output = renderWeComRoleSetting(capabilities);
    assert.match(output, /availableRecordTypes/u);
    assert.match(output, /存在非 Master 类型时排除 Master/u);
    assert.match(output, /同一 `recordType\.id`/u);
    assert.match(output, /recordTypeSelectionRequired.*技术依赖/u);
    assert.match(output, /PLATFORM_IDENTITY_FALLBACK/u);
    assert.match(output, /不查询当前用户 ID/u);
    assert.match(output, /UPDATE 不重放 CREATE 默认/u);
  });
});

