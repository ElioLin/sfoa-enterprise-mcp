import type { ToolControlRecord } from '@sfoa/control-plane';
import { AGENT_INFRASTRUCTURE_TOOL_NAMES } from '@sfoa/agent-playbook';
import { SFOA_CONTEXT_TOOL_NAMES, SFOA_CONTEXT_TOOL_ROLES, type SfoaContextToolName } from '@sfoa/mcp-provider-sfoa-context';
import { SFOA_DATA_TOOL_NAMES } from '@sfoa/mcp-provider-sfoa-data';
import { SFOA_DML_TOOL_NAMES } from '@sfoa/mcp-provider-sfoa-dml';
import {
  OFFICIAL_TOOL_CATALOG,
  SFOA_ATTACHMENT_TOOL_NAMES,
  type ToolClassification,
  type UpstreamInventoryComparison,
} from '@sfoa/mcp-server';

export type AdminToolRecord = Readonly<{
  toolName: string;
  classification: ToolClassification;
  executionRole: 'USER' | 'DIAGNOSTIC';
  remoteCompatible: boolean;
  releaseState: 'GA' | 'NON_GA' | 'UNKNOWN';
  enabled: boolean;
  rowVersion: string | null;
  remark: string | null;
  dependencies: readonly string[];
  status: 'AVAILABLE' | 'DISABLED' | 'UNSUPPORTED' | 'REVIEW_REQUIRED' | 'UNKNOWN';
  enableAllowed: boolean;
  disabledReason: string | null;
}>;

/**
 * 将已经审计过的 Salesforce Provider releaseState 映射为管理端状态。
 *
 * OFFICIAL_TOOL_CATALOG 中存在大量“已知工具名称，但尚未在 SFoA 远程运行时完成
 * upstream contract 审计”的条目。缺少 upstreamContract 不代表 Salesforce 将该工具标记为 NON-GA，
 * 因此必须显示 UNKNOWN，避免管理员把“尚未审计”误解为“官方非 GA”。
 */
function resolveReleaseState(
  policy: (typeof OFFICIAL_TOOL_CATALOG)[number],
): AdminToolRecord['releaseState'] {
  if (!policy.upstreamContract) return 'UNKNOWN';
  return policy.upstreamContract.releaseState === 'ga' ? 'GA' : 'NON_GA';
}

/**
 * The classification an Admin surface shows for a Context Tool.
 *
 * `set_trace_flag` is the one Context Tool that **writes**, so it must not be listed as a read: this
 * classification is what the Console's enablement declaration is built from (ADR-0029 §4c), and a
 * write shown as a read is the specific misreading that declaration exists to prevent.
 *
 * Its own classification rather than `MUTATION`, because `MUTATION` in this catalog means an official
 * DML Tool writing business records — that is what an Administrator who sees `MUTATION` has learned to
 * expect, and it is false here. `DIAGNOSTIC_WRITE` says what is actually licensed: a write to
 * Setup-layer diagnostic configuration, exactly `TraceFlag` and `DebugLevel`, with no delete path and
 * no business sObject (ADR-0030 §1).
 */
function contextToolClassification(toolName: SfoaContextToolName): ToolClassification {
  if (toolName === 'get_metadata_component_context') return 'METADATA_READ';
  if (toolName === 'set_trace_flag') return 'DIAGNOSTIC_WRITE';
  return 'READ';
}

/**
 * What has to be true before a Context Tool works — the Console's declaration, per Tool.
 *
 * The debug-log entries name ADR-0029 §2's deployment prerequisites rather than a generic dependency,
 * because for these three the prerequisite *is* the capability: a missing `A-1` or `A-3` does not make
 * the Tool error out helpfully at enablement, it decides whether the Tool can answer at all. Naming the
 * identifier here is what gives the Admin one thing to look up, which is the same reason the Tool's own
 * errors carry it.
 */
function contextToolDependencies(toolName: SfoaContextToolName, diagnostic: boolean): readonly string[] {
  if (toolName === 'set_trace_flag') {
    return ['enabled Diagnostic configuration', 'trace administration on the diagnostic account (A-3)'];
  }
  if (toolName === 'get_apex_logs') {
    return ['enabled Diagnostic configuration', 'ApexLog visibility on the diagnostic account (A-1)'];
  }
  if (toolName === 'get_debug_log_body') {
    return [
      'enabled Diagnostic configuration',
      'ApexLog visibility on the diagnostic account (A-1)',
      'Apex log retention long enough for the incident (A-2)',
    ];
  }
  if (toolName === 'explain_field_access') {
    // Named as the measured constraint rather than an ADR-0029 §2 letter, because §2's `A-1`…`A-4` are the
    // places P10 had already identified as unmeasured and this Tool reads a surface none of them covers. The
    // second entry is the boundary: without a route table the Tool can explain nobody's access but an
    // explicit target's, and on a runtime with no routes at all it refuses rather than guessing.
    return [
      'enabled Diagnostic configuration',
      'permission-table readability on the diagnostic account',
      'enabled identity routes, for the targetUserId boundary',
    ];
  }
  return diagnostic ? ['enabled Diagnostic configuration', 'audited official Tool contract'] : ['USER identity route'];
}

export function buildAdminToolCatalog(
  controls: readonly ToolControlRecord[],
  upstream: UpstreamInventoryComparison,
): readonly AdminToolRecord[] {
  const byName = new Map(controls.map((control) => [control.toolName, control]));
  const records: AdminToolRecord[] = [];

  for (const policy of OFFICIAL_TOOL_CATALOG) {
    const control = byName.get(policy.name);
    byName.delete(policy.name);
    const safeClassification = policy.classification === 'READ' || policy.classification === 'METADATA_READ';
    const releaseState = resolveReleaseState(policy);
    const enableAllowed = upstream.status === 'PASS'
      && releaseState === 'GA'
      && safeClassification
      && policy.p2RemoteCompatible
      && Boolean(policy.remoteContract);

    records.push(toolRecord({
      toolName: policy.name,
      classification: policy.classification,
      executionRole: 'USER',
      remoteCompatible: policy.p2RemoteCompatible,
      releaseState,
      control,
      dependencies: policy.needsFilesystem ? ['request workspace', 'CWD guard'] : [],
      enableAllowed,
      disabledReason: upstream.status !== 'PASS'
        ? 'Upstream contract drift requires Maintainer review.'
        : !safeClassification
          ? `Official classification ${policy.classification} is not Agent-safe in this runtime.`
          : !policy.p2RemoteCompatible || !policy.remoteContract
            ? 'The audited Tool is not remote compatible.'
            : releaseState === 'NON_GA'
              ? 'The audited Tool is NON-GA and is not enabled in this runtime.'
              : releaseState === 'UNKNOWN'
                ? 'The Tool has no audited upstream release contract.'
                : null,
    }));
  }

  for (const toolName of SFOA_DML_TOOL_NAMES) {
    const control = byName.get(toolName);
    byName.delete(toolName);
    records.push(toolRecord({
      toolName,
      classification: 'MUTATION',
      executionRole: 'USER',
      remoteCompatible: true,
      releaseState: 'GA',
      control,
      dependencies: ['Object × CREATE/UPDATE policy'],
      enableAllowed: true,
      disabledReason: null,
    }));
  }

  for (const toolName of SFOA_ATTACHMENT_TOOL_NAMES) {
    const control = byName.get(toolName);
    byName.delete(toolName);
    records.push(toolRecord({
      toolName,
      // A file upload mutates the org, so it is a mutation Tool like any other. It is
      // deliberately NOT part of SFOA_DML_TOOL_NAMES: ContentVersion is an internal
      // technical object, and listing it beside the business DML Tools would advertise
      // it as one.
      classification: 'MUTATION',
      executionRole: 'USER',
      remoteCompatible: true,
      releaseState: 'GA',
      control,
      dependencies: ['Object × attachment policy', 'SFOA Attachment Ingress'],
      enableAllowed: true,
      disabledReason: null,
    }));
  }

  for (const toolName of SFOA_CONTEXT_TOOL_NAMES) {
    const control = byName.get(toolName);
    byName.delete(toolName);
    const diagnostic = SFOA_CONTEXT_TOOL_ROLES[toolName] === 'DIAGNOSTIC';
    const enableAllowed = !diagnostic || upstream.status === 'PASS';

    records.push(toolRecord({
      toolName,
      classification: contextToolClassification(toolName),
      executionRole: diagnostic ? 'DIAGNOSTIC' : 'USER',
      remoteCompatible: true,
      releaseState: 'GA',
      control,
      dependencies: contextToolDependencies(toolName, diagnostic),
      enableAllowed,
      disabledReason: enableAllowed ? null : 'Upstream contract drift requires Maintainer review.',
    }));
  }

  for (const toolName of SFOA_DATA_TOOL_NAMES) {
    const control = byName.get(toolName);
    byName.delete(toolName);
    records.push(toolRecord({
      toolName,
      // Every P9 Data Tool reads Salesforce schema through the request USER identity and
      // never mutates business data. They ship default-disabled, so an Admin has to find
      // them here to turn them on — a Data Tool missing from this catalog would be
      // advertised nowhere and permanently unenableable.
      classification: 'READ',
      executionRole: 'USER',
      remoteCompatible: true,
      releaseState: 'GA',
      control,
      dependencies: ['USER identity route'],
      enableAllowed: true,
      disabledReason: null,
    }));
  }

  for (const toolName of AGENT_INFRASTRUCTURE_TOOL_NAMES) {
    const control = byName.get(toolName);
    byName.delete(toolName);
    records.push(toolRecord({
      toolName,
      classification: 'READ',
      executionRole: 'USER',
      remoteCompatible: true,
      releaseState: 'GA',
      control,
      dependencies: toolName === 'get_record_links'
        ? ['request-scoped Salesforce Connection instance origin']
        : ['canonical Agent Playbook'],
      enableAllowed: true,
      disabledReason: null,
    }));
  }

  for (const control of byName.values()) {
    records.push(Object.freeze({
      toolName: control.toolName,
      classification: 'UNKNOWN',
      executionRole: 'USER',
      remoteCompatible: false,
      releaseState: 'UNKNOWN',
      enabled: control.enabled,
      rowVersion: control.rowVersion,
      remark: control.remark,
      dependencies: Object.freeze([]),
      status: 'UNKNOWN',
      enableAllowed: false,
      disabledReason: 'Database Tool name is absent from the audited executable catalog.',
    }));
  }

  return Object.freeze(records.sort((left, right) => left.toolName.localeCompare(right.toolName)));
}

export function canEnableAdminTool(
  toolName: string,
  upstream: UpstreamInventoryComparison,
): Readonly<{ allowed: boolean; reason?: string }> {
  const record = buildAdminToolCatalog([], upstream).find((tool) => tool.toolName === toolName);
  return record?.enableAllowed
    ? Object.freeze({ allowed: true })
    : Object.freeze({ allowed: false, reason: record?.disabledReason ?? 'Unknown Tool cannot be enabled.' });
}

function toolRecord(input: Readonly<{
  toolName: string;
  classification: ToolClassification;
  executionRole: 'USER' | 'DIAGNOSTIC';
  remoteCompatible: boolean;
  releaseState: AdminToolRecord['releaseState'];
  control?: ToolControlRecord;
  dependencies: readonly string[];
  enableAllowed: boolean;
  disabledReason: string | null;
}>): AdminToolRecord {
  const invalidEnabled = input.control?.enabled === true && !input.enableAllowed;

  return Object.freeze({
    toolName: input.toolName,
    classification: input.classification,
    executionRole: input.executionRole,
    remoteCompatible: input.remoteCompatible,
    releaseState: input.releaseState,
    enabled: input.control?.enabled === true,
    rowVersion: input.control?.rowVersion ?? null,
    remark: input.control?.remark ?? null,
    dependencies: Object.freeze([...input.dependencies]),
    status: invalidEnabled
      ? input.disabledReason?.includes('drift') ? 'REVIEW_REQUIRED' : 'UNSUPPORTED'
      : input.control?.enabled ? 'AVAILABLE' : 'DISABLED',
    enableAllowed: input.enableAllowed,
    disabledReason: input.disabledReason,
  });
}
