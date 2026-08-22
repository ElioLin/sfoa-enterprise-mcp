import { readFile } from 'node:fs/promises';
import type { Connection } from '@salesforce/core';
import { DxCoreMcpProvider } from '@salesforce/mcp-provider-dx-core';
import {
  type ConfigService,
  type McpTool,
  type McpToolConfig,
  type OrgConfigInfo,
  type OrgService,
  ReleaseState,
  type SanitizedOrgAuthorization,
  type Services,
  type TelemetryEvent,
  type TelemetryService,
} from '@salesforce/mcp-provider-api';
import type { RequestToolSource } from '@sfoa/identity-runtime';
import { z } from 'zod';
import { RemoteRuntimeError } from './errors.js';
import {
  DX_CORE_PROVIDER_BASELINE,
  DX_CORE_TOOL_CATALOG,
  type AuditedReleaseState,
  type OfficialToolPolicyRecord,
} from './official-tool-catalog.js';

const packageManifestSchema = z.object({
  name: z.literal(DX_CORE_PROVIDER_BASELINE.packageName),
  version: z.string().min(1),
});

export const UPSTREAM_INVENTORY_DRIFT_KINDS = [
  'PROVIDER_CHANGED',
  'PROVIDER_API_VERSION_CHANGED',
  'PACKAGE_CHANGED',
  'PACKAGE_VERSION_CHANGED',
  'ADDED',
  'REMOVED',
  'RELEASE_STATE_CHANGED',
  'SCHEMA_CHANGED',
] as const;

export type UpstreamInventoryDriftKind = (typeof UPSTREAM_INVENTORY_DRIFT_KINDS)[number];

export type OfficialToolInventoryEntry = Readonly<{
  name: string;
  releaseState: AuditedReleaseState;
  inputFields: readonly string[];
  requiredInputFields: readonly string[];
  hasOutputSchema: boolean;
  outputFields: readonly string[];
}>;

export type OfficialProviderInventory = Readonly<{
  providerName: string;
  providerApiVersion: string;
  packageName: string;
  packageVersion: string;
  tools: readonly OfficialToolInventoryEntry[];
}>;

export type UpstreamInventoryDrift = Readonly<{
  kind: UpstreamInventoryDriftKind;
  toolName?: string;
  expected: string;
  actual: string;
}>;

export type UpstreamInventoryComparison = Readonly<{
  status: 'PASS' | 'UPSTREAM_REVIEW_REQUIRED';
  drift: readonly UpstreamInventoryDrift[];
}>;

export async function inspectOfficialDxCoreInventory(
  toolSource?: RequestToolSource,
): Promise<OfficialProviderInventory> {
  const provider = new DxCoreMcpProvider();
  const tools = toolSource
    ? await toolSource.provideTools(createInventoryServices())
    : await provider.provideTools(createInventoryServices());
  const packageManifest = await readResolvedDxCorePackageManifest();
  const seen = new Set<string>();
  const contracts = tools.map((tool) => {
    const name = tool.getName();
    if (seen.has(name)) {
      throw new RemoteRuntimeError(
        'MCP_UPSTREAM_TOOL_CONTRACT_DRIFT',
        `The official ${provider.getName()} inventory contains duplicate Tool ${name}.`,
      );
    }
    seen.add(name);
    return inspectToolContract(tool);
  });

  return Object.freeze({
    providerName: provider.getName(),
    providerApiVersion: provider.getVersion().version,
    packageName: packageManifest.name,
    packageVersion: packageManifest.version,
    tools: Object.freeze(contracts),
  });
}

export function getAuditedDxCoreInventory(): OfficialProviderInventory {
  const tools = DX_CORE_TOOL_CATALOG.map((record) => {
    if (!record.upstreamContract) {
      throw new RemoteRuntimeError(
        'MCP_PROVIDER_INITIALIZATION_FAILED',
        `The executable dx-core catalog is missing an audited contract for ${record.name}.`,
      );
    }
    return Object.freeze({ name: record.name, ...record.upstreamContract });
  });

  return Object.freeze({
    providerName: DX_CORE_PROVIDER_BASELINE.providerName,
    providerApiVersion: DX_CORE_PROVIDER_BASELINE.providerApiVersion,
    packageName: DX_CORE_PROVIDER_BASELINE.packageName,
    packageVersion: DX_CORE_PROVIDER_BASELINE.packageVersion,
    tools: Object.freeze(tools),
  });
}

export function compareOfficialProviderInventory(
  actual: OfficialProviderInventory,
  audited: OfficialProviderInventory = getAuditedDxCoreInventory(),
): UpstreamInventoryComparison {
  const drift: UpstreamInventoryDrift[] = [];
  compareProviderValue(drift, 'PROVIDER_CHANGED', audited.providerName, actual.providerName);
  compareProviderValue(
    drift,
    'PROVIDER_API_VERSION_CHANGED',
    audited.providerApiVersion,
    actual.providerApiVersion,
  );
  compareProviderValue(drift, 'PACKAGE_CHANGED', audited.packageName, actual.packageName);
  compareProviderValue(drift, 'PACKAGE_VERSION_CHANGED', audited.packageVersion, actual.packageVersion);

  const expectedByName = new Map(audited.tools.map((tool) => [tool.name, tool]));
  const actualByName = new Map(actual.tools.map((tool) => [tool.name, tool]));
  const names = [...new Set([...expectedByName.keys(), ...actualByName.keys()])].sort();

  for (const name of names) {
    const expected = expectedByName.get(name);
    const found = actualByName.get(name);
    if (!expected && found) {
      drift.push({ kind: 'ADDED', toolName: name, expected: 'absent', actual: toolSummary(found) });
      continue;
    }
    if (expected && !found) {
      drift.push({ kind: 'REMOVED', toolName: name, expected: toolSummary(expected), actual: 'absent' });
      continue;
    }
    if (!expected || !found) continue;

    if (expected.releaseState !== found.releaseState) {
      drift.push({
        kind: 'RELEASE_STATE_CHANGED',
        toolName: name,
        expected: expected.releaseState,
        actual: found.releaseState,
      });
    }
    if (!sameSchemaSurface(expected, found)) {
      drift.push({
        kind: 'SCHEMA_CHANGED',
        toolName: name,
        expected: schemaSummary(expected),
        actual: schemaSummary(found),
      });
    }
  }

  return Object.freeze({
    status: drift.length === 0 ? 'PASS' : 'UPSTREAM_REVIEW_REQUIRED',
    drift: Object.freeze(drift),
  });
}

export function assertEnabledRemoteContractsCompatible(
  comparison: UpstreamInventoryComparison,
  enabledTools: readonly string[],
  actual: OfficialProviderInventory,
): void {
  const enabled = new Set(enabledTools);
  const relevant = comparison.drift.filter(
    (item) => item.toolName === undefined || enabled.has(item.toolName),
  );
  const [first] = relevant;
  if (!first) return;
  const tool = first.toolName ? ` Tool ${first.toolName}` : '';
  throw new RemoteRuntimeError(
    'MCP_UPSTREAM_TOOL_CONTRACT_DRIFT',
    `Official Provider contract drift affects an enabled P2 remote${tool}. ` +
      `${first.kind}: expected ${first.expected}; actual ${first.actual}. ` +
      `Supported ${DX_CORE_PROVIDER_BASELINE.providerName} ` +
      `${DX_CORE_PROVIDER_BASELINE.packageName}@${DX_CORE_PROVIDER_BASELINE.packageVersion}; ` +
      `actual ${actual.providerName} ${actual.packageName}@${actual.packageVersion}.`,
  );
}

export function validateRemoteToolContract(
  tool: McpTool,
  record: OfficialToolPolicyRecord,
): McpToolConfig<z.ZodRawShape, z.ZodRawShape> {
  const upstream = record.upstreamContract;
  const remote = record.remoteContract;
  const config = tool.getConfig();
  const actual = inspectToolConfig(tool, config);
  if (
    !record.p2RemoteCompatible ||
    !upstream ||
    !remote ||
    record.provider !== DX_CORE_PROVIDER_BASELINE.providerName ||
    tool.getName() !== record.name ||
    actual.releaseState !== upstream.releaseState ||
    !sameSchemaSurface({ name: record.name, ...upstream }, actual) ||
    !sameFields(upstream.inputFields, [...remote.hostOwnedArguments, ...remote.allowedAgentArguments]) ||
    hasDuplicates(remote.hostOwnedArguments) ||
    hasDuplicates(remote.allowedAgentArguments) ||
    remote.hostOwnedArguments.some((name) => remote.allowedAgentArguments.includes(name))
  ) {
    throw remoteToolContractDrift(record, actual);
  }
  return config;
}

function inspectToolContract(tool: McpTool): OfficialToolInventoryEntry {
  return inspectToolConfig(tool, tool.getConfig());
}

function inspectToolConfig(
  tool: McpTool,
  config: McpToolConfig<z.ZodRawShape, z.ZodRawShape>,
): OfficialToolInventoryEntry {
  const input = Object.entries(config.inputSchema ?? {});
  const releaseState = tool.getReleaseState();
  if (releaseState !== ReleaseState.GA && releaseState !== ReleaseState.NON_GA) {
    throw new RemoteRuntimeError(
      'MCP_UPSTREAM_TOOL_CONTRACT_DRIFT',
      `Official Tool ${tool.getName()} returned an unsupported ReleaseState.`,
    );
  }
  return Object.freeze({
    name: tool.getName(),
    releaseState,
    inputFields: Object.freeze(input.map(([name]) => name)),
    requiredInputFields: Object.freeze(
      input.filter(([, schema]) => !schema.safeParse(undefined).success).map(([name]) => name),
    ),
    hasOutputSchema: config.outputSchema !== undefined,
    outputFields: Object.freeze(Object.keys(config.outputSchema ?? {})),
  });
}

async function readResolvedDxCorePackageManifest(): Promise<z.infer<typeof packageManifestSchema>> {
  try {
    const packageUrl = new URL('../package.json', import.meta.resolve(DX_CORE_PROVIDER_BASELINE.packageName));
    const text = await readFile(packageUrl, 'utf8');
    const parsed: unknown = JSON.parse(text);
    return packageManifestSchema.parse(parsed);
  } catch (error) {
    throw new RemoteRuntimeError(
      'MCP_PROVIDER_INITIALIZATION_FAILED',
      `Could not resolve the installed ${DX_CORE_PROVIDER_BASELINE.packageName} package identity.`,
      { cause: error },
    );
  }
}

function compareProviderValue(
  drift: UpstreamInventoryDrift[],
  kind: UpstreamInventoryDriftKind,
  expected: string,
  actual: string,
): void {
  if (expected !== actual) drift.push({ kind, expected, actual });
}

function sameSchemaSurface(
  expected: OfficialToolInventoryEntry,
  actual: OfficialToolInventoryEntry,
): boolean {
  return (
    sameFields(expected.inputFields, actual.inputFields) &&
    sameFields(expected.requiredInputFields, actual.requiredInputFields) &&
    expected.hasOutputSchema === actual.hasOutputSchema &&
    sameFields(expected.outputFields, actual.outputFields)
  );
}

function sameFields(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((value, index) => value === sortedRight[index]);
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function toolSummary(tool: OfficialToolInventoryEntry): string {
  return `${tool.releaseState}; ${schemaSummary(tool)}`;
}

function schemaSummary(tool: OfficialToolInventoryEntry): string {
  return (
    `input=[${[...tool.inputFields].sort().join(',')}]; ` +
    `required=[${[...tool.requiredInputFields].sort().join(',')}]; ` +
    `outputSchema=${tool.hasOutputSchema}; output=[${[...tool.outputFields].sort().join(',')}]`
  );
}

function remoteToolContractDrift(
  record: OfficialToolPolicyRecord,
  actual: OfficialToolInventoryEntry,
): RemoteRuntimeError {
  const expected = record.upstreamContract;
  return new RemoteRuntimeError(
    'MCP_UPSTREAM_TOOL_CONTRACT_DRIFT',
    `Official Tool contract drift for ${record.name}. ` +
      `Expected ${expected ? schemaSummary({ name: record.name, ...expected }) : 'no audited contract'}; ` +
      `actual ${schemaSummary(actual)}; expected ReleaseState ${expected?.releaseState ?? 'none'}; ` +
      `actual ${actual.releaseState}. Supported ${record.provider} ` +
      `${DX_CORE_PROVIDER_BASELINE.packageName}@${DX_CORE_PROVIDER_BASELINE.packageVersion} ` +
      `(Provider API ${DX_CORE_PROVIDER_BASELINE.providerApiVersion}).`,
  );
}

class InventoryTelemetryService implements TelemetryService {
  public sendEvent(_eventName: string, _event: TelemetryEvent): void {
    // Inventory construction must not emit telemetry.
  }
}

class InventoryOrgService implements OrgService {
  public getAllowedOrgUsernames(): Promise<Set<string>> {
    return Promise.resolve(new Set());
  }

  public getAllowedOrgs(): Promise<SanitizedOrgAuthorization[]> {
    return Promise.resolve([]);
  }

  public getConnection(_username: string): Promise<Connection> {
    return Promise.reject(providerExecutionDuringInventory());
  }

  public getDefaultTargetOrg(): Promise<OrgConfigInfo | undefined> {
    return Promise.resolve(undefined);
  }

  public getDefaultTargetDevHub(): Promise<OrgConfigInfo | undefined> {
    return Promise.resolve(undefined);
  }

  public findOrgByUsernameOrAlias(
    _allOrgs: SanitizedOrgAuthorization[],
    _usernameOrAlias: string,
  ): SanitizedOrgAuthorization | undefined {
    return undefined;
  }
}

class InventoryConfigService implements ConfigService {
  public getDataDir(): string {
    return process.cwd();
  }

  public getStartupFlags(): { 'allow-non-ga-tools': boolean; debug: boolean } {
    return { 'allow-non-ga-tools': false, debug: false };
  }
}

function createInventoryServices(): Services {
  const telemetry = new InventoryTelemetryService();
  const org = new InventoryOrgService();
  const config = new InventoryConfigService();
  return {
    getTelemetryService: () => telemetry,
    getOrgService: () => org,
    getConfigService: () => config,
  };
}

function providerExecutionDuringInventory(): RemoteRuntimeError {
  return new RemoteRuntimeError(
    'MCP_PROVIDER_INITIALIZATION_FAILED',
    'The official Provider attempted Salesforce execution during inventory inspection.',
  );
}
