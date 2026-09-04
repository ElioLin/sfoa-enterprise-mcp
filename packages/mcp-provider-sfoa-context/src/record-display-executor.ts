import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import { ContextRuntimeError } from './errors.js';
import type { RecordDisplayContextInput, RecordDisplayContextOutput } from './schemas.js';
import {
  collectLayoutFacts,
  layoutSchema,
  listAvailableRecordTypes,
  listRecordTypes,
  objectInfoSchema,
  sameSalesforceId,
  toRecordTypeDescriptor,
  withQuery,
  type Layout,
  type ObjectInfo,
  type RecordTypeInfo,
  type RequestMetrics,
} from './ui-api.js';

const MAX_VIEW_LAYOUT_FIELDS = 200;
const MAX_COMPACT_LAYOUT_FIELDS = 20;
const MAX_OUTPUT_BYTES = 524_288;

type JsonResult = Readonly<{ ok: true; value: unknown } | { ok: false; error: unknown }>;

type ResolvedDisplayRecordType = Readonly<{
  recordType: RecordTypeInfo | null;
  ambiguous: boolean;
}>;

type CompactFieldDescriptor = Readonly<{ apiName: string; label?: string }>;

type NameFieldResolution = Readonly<{
  nameFields: Array<{ apiName: string; label: string; dataType: string }>;
  source: 'NAME_FIELD' | 'NONE_DECLARED';
}>;

type ObjectInfoFieldMeta = Readonly<{
  label: string;
  dataType: string;
  referenceTo: readonly string[];
  relationshipName: string | null;
}>;

/**
 * Returns Salesforce facts that tell an Agent how records of an object should be
 * presented to the request USER: the object label, the Salesforce name/display
 * fields, the Record Type-aware Compact and View (page) Layout field order, and
 * Record Type availability. It does not query business records and it does not
 * evaluate Dynamic Forms or a complete Lightning page.
 *
 * Layout retrieval is best-effort: an object whose View or Compact layout cannot
 * be read is still served with explicit coverage flags and warnings rather than
 * failing the whole MCP request.
 */
export class RecordDisplayContextExecutor {
  public constructor(private readonly orgService: OrgService) {}

  public async execute(input: RecordDisplayContextInput): Promise<RecordDisplayContextOutput> {
    const started = performance.now();
    try {
      const connection = await this.getRequestConnection();
      const apiVersion = connection.getApiVersion();
      const metrics: RequestMetrics = { apiCallCount: 0, responseBytes: 0 };
      const objectInfo = objectInfoSchema.parse(await this.requireJson(connection, this.objectInfoUrl(apiVersion, input.objectApiName), metrics));

      if (objectInfo.apiName.toLocaleLowerCase('en-US') !== input.objectApiName.toLocaleLowerCase('en-US')) {
        throw new ContextRuntimeError(
          'MCP_RECORD_DISPLAY_CONTEXT_UNSUPPORTED',
          'Salesforce UI API returned object display context for a different object.',
        );
      }

      const recordTypes = listRecordTypes(objectInfo);
      const hasRecordTypes = recordTypes.length > 0;
      // Only Record Types the current USER may actually use are exposed to the Agent as
      // `availableRecordTypes`; unavailable (Profile-hidden / create-blocked) Record
      // Types never influence the Agent's display or Record-Type decision.
      const availableRecordTypes = listAvailableRecordTypes(objectInfo);
      const resolved = this.resolveDisplayRecordType(objectInfo, input.recordTypeId);
      const recordType = resolved.recordType;
      const recordTypeId = recordType?.recordTypeId ?? null;
      // Objects that use no Record Type at all still expose a default layout and are
      // fetched without a recordTypeId. An ambiguous multi-Record-Type selection is
      // left explicit (no layout guessed) instead of pinned silently.
      const shouldFetchLayouts = recordTypeId !== null || !hasRecordTypes;

      const nameResolution = resolveNameFields(objectInfo);

      const warnings: string[] = [];
      if (nameResolution.source === 'NONE_DECLARED') {
        warnings.push(
          'Salesforce Object Info declares no name/display fields (`nameFields`) for this object and identity. Do not invent a display field: treat the leading Compact or View layout fields as the display evidence, or ask the user which field to show.',
        );
      }
      if (resolved.ambiguous) {
        warnings.push(
          'Several Record Types are available and Salesforce did not report a current USER default. Pass recordTypeId to read the View/Compact layout facts for a specific Record Type.',
        );
      }

      // View (Full) layout: best-effort, never fatal.
      const viewLayoutResult = shouldFetchLayouts
        ? await this.fetchLayoutJson(connection, apiVersion, input.objectApiName, layoutParams('Full', recordTypeId), metrics)
        : { ok: false as const, error: 'noRecordType' };
      const viewLayout = viewLayoutResult.ok ? parseLayout(viewLayoutResult.value) : null;
      if (!viewLayoutResult.ok && shouldFetchLayouts) {
        warnings.push('Salesforce UI API could not return the View layout for this object.');
      } else if (!viewLayoutResult.ok) {
        warnings.push('View layout facts were not read because no Record Type was selected.');
      } else if (!viewLayout) {
        warnings.push('Salesforce returned a View layout that could not be parsed as a Field layout.');
      }

      // Compact layout: best-effort; some objects expose none and fall back gracefully.
      const compactResult = shouldFetchLayouts
        ? await this.fetchLayoutJson(connection, apiVersion, input.objectApiName, layoutParams('Compact', recordTypeId), metrics)
        : { ok: false as const, error: 'noRecordType' };
      const compactLayout = compactResult.ok ? parseCompactLayout(compactResult.value) : null;
      if (!compactResult.ok && shouldFetchLayouts) {
        warnings.push('Salesforce UI API could not return the Compact layout for this object.');
      } else if (!compactResult.ok) {
        warnings.push('Compact layout facts were not read because no Record Type was selected.');
      } else if (!compactLayout) {
        warnings.push('Salesforce returned no Compact layout fields for this object and Record Type.');
      }

      const viewFields = buildViewFields(objectInfo, viewLayout);
      const compactFields = buildCompactFields(objectInfo, compactLayout);
      const omitted = viewFields.omitted + compactFields.omitted;
      const truncated = viewFields.truncated || compactFields.truncated || omitted > 0;
      if (omitted > 0) {
        warnings.push('Some layout fields were omitted because Salesforce Object Info did not expose their metadata.');
      }

      const sources: Array<'UI_API_OBJECT_INFO' | 'UI_API_LAYOUT' | 'UI_API_COMPACT_LAYOUT'> = ['UI_API_OBJECT_INFO'];
      if (viewLayoutResult.ok) sources.push('UI_API_LAYOUT');
      if (compactResult.ok && compactLayout) sources.push('UI_API_COMPACT_LAYOUT');

      const output: RecordDisplayContextOutput = {
        success: true,
        executionRole: 'USER',
        objectApiName: objectInfo.apiName,
        objectLabel: objectInfo.label,
        objectLabelPlural: objectInfo.labelPlural,
        nameFields: nameResolution.nameFields,
        compactLayoutFields: compactFields.fields,
        viewLayoutFields: viewFields.fields,
        availableRecordTypes: availableRecordTypes.map(toRecordTypeDescriptor),
        selectedRecordType: recordType ? toRecordTypeDescriptor(recordType) : null,
        coverage: {
          sources,
          apiCallCount: metrics.apiCallCount,
          durationMs: Math.round(performance.now() - started),
          responseBytes: metrics.responseBytes,
          nameFieldSource: nameResolution.source,
          recordTypeResolved: recordType !== null,
          viewLayoutEvaluated: viewFields.fields.length > 0,
          compactLayoutEvaluated: compactFields.fields.length > 0,
          truncated,
          dynamicFormsEvaluated: false,
          completeLightningPageEvaluated: false,
          warnings,
        },
      };
      if (Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_OUTPUT_BYTES) {
        throw new ContextRuntimeError(
          'MCP_RECORD_DISPLAY_CONTEXT_UNSUPPORTED',
          'The bounded record display context still exceeded the safe response size.',
        );
      }
      return output;
    } catch (error) {
      if (error instanceof ContextRuntimeError) throw error;
      throw new ContextRuntimeError(
        'MCP_RECORD_DISPLAY_CONTEXT_UNSUPPORTED',
        'Salesforce UI API could not provide a validated record display context for this object.',
        error instanceof Error ? { cause: error } : {},
      );
    }
  }

  private async getRequestConnection(): Promise<Connection> {
    const usernames = [...(await this.orgService.getAllowedOrgUsernames())];
    if (usernames.length !== 1 || !usernames[0]) {
      throw new ContextRuntimeError(
        'MCP_RECORD_DISPLAY_CONTEXT_INVALID',
        'Record display context requires exactly one request-scoped USER Salesforce identity.',
      );
    }
    return this.orgService.getConnection(usernames[0]);
  }

  /**
   * Resolves the Record Type whose View/Compact layout facts are returned.
   * An explicit available Record Type wins; otherwise the USER default is used
   * (READ display has no create-wrong-type risk). When several Record Types are
   * available but no default is reported, the selection is left explicit rather
   * than guessed.
   */
  private resolveDisplayRecordType(objectInfo: ObjectInfo, requested: string | undefined): ResolvedDisplayRecordType {
    const recordTypes = listRecordTypes(objectInfo);
    if (requested) {
      const found = recordTypes.find((entry) => sameSalesforceId(entry.recordTypeId, requested));
      if (!found) {
        throw new ContextRuntimeError(
          'MCP_RECORD_TYPE_NOT_AVAILABLE',
          'The requested Record Type does not exist for this object.',
        );
      }
      if (!found.available) {
        throw new ContextRuntimeError(
          'MCP_RECORD_TYPE_NOT_AVAILABLE',
          'The requested Record Type is not available to the current Salesforce USER.',
        );
      }
      return { recordType: found, ambiguous: false };
    }
    if (recordTypes.length === 0) return { recordType: null, ambiguous: false };
    const defaultEntry = recordTypes.find((entry) => sameSalesforceId(entry.recordTypeId, objectInfo.defaultRecordTypeId));
    if (defaultEntry?.available) return { recordType: defaultEntry, ambiguous: false };
    const available = listAvailableRecordTypes(objectInfo);
    const single = available[0];
    if (available.length === 1 && single) return { recordType: single, ambiguous: false };
    if (available.length === 0) return { recordType: null, ambiguous: false };
    // Multiple available Record Types without a usable USER default: leave the choice explicit.
    return { recordType: null, ambiguous: true };
  }

  private async requireJson(connection: Connection, url: string, metrics: RequestMetrics): Promise<unknown> {
    const result = await this.fetchJson(connection, url, metrics);
    if (result.ok) return result.value;
    throw result.error;
  }

  private async fetchLayoutJson(
    connection: Connection,
    apiVersion: string,
    objectApiName: string,
    params: Readonly<Record<string, string>>,
    metrics: RequestMetrics,
  ): Promise<JsonResult> {
    const url = `/services/data/v${encodeURIComponent(apiVersion)}/ui-api/layout/${encodeURIComponent(objectApiName)}`;
    return await this.fetchJson(connection, withQuery(url, params), metrics);
  }

  /**
   * A layout attempt is still a Salesforce API call and is counted before the
   * request so degraded (unavailable) layouts report an accurate apiCallCount.
   */
  private async fetchJson(connection: Connection, url: string, metrics: RequestMetrics): Promise<JsonResult> {
    metrics.apiCallCount += 1;
    try {
      const value = await connection.request<unknown>({ method: 'GET', url });
      metrics.responseBytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error };
    }
  }

  private objectInfoUrl(apiVersion: string, objectApiName: string): string {
    return `/services/data/v${encodeURIComponent(apiVersion)}/ui-api/object-info/${encodeURIComponent(objectApiName)}`;
  }
}

function layoutParams(layoutType: 'Full' | 'Compact', recordTypeId: string | null): Record<string, string> {
  // The UI API REST contract is singular `layoutType` + `mode`. Verified live on SFoA
  // (runnergroup--uat.sandbox.my.sfcrmproducts.cn, UI API v67.0): the plural spellings
  // are accepted but silently ignored for Compact — `layoutTypes=Compact&modes=View`
  // returns the Full page layout (7 sections, 77 fields) instead of the Compact layout
  // (1 section, 8 fields). Every layout call site therefore uses the singular form.
  const params: Record<string, string> = { formFactor: 'Large', layoutType, mode: 'View' };
  if (recordTypeId) params.recordTypeId = recordTypeId;
  return params;
}

function parseLayout(value: unknown): Layout | null {
  const parsed = layoutSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Salesforce Compact layouts are exposed in different shapes across API forms.
 * Accept a UI API Layout object (sections) or a field-list object such as
 * `{ compactLayoutFields: [...] }` / `{ fields: [...] }`.
 */
function parseCompactLayout(value: unknown): CompactFieldDescriptor[] | null {
  const layout = parseLayout(value);
  if (layout) {
    const ordered = [...collectLayoutFacts(layout).entries()]
      .sort((left, right) => left[1].order - right[1].order)
      .map(([apiName]): CompactFieldDescriptor => ({ apiName }));
    return ordered.length > 0 ? ordered : null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const object = value as Record<string, unknown>;
  const list = Array.isArray(object.compactLayoutFields) ? object.compactLayoutFields : Array.isArray(object.fields) ? object.fields : null;
  if (!list) return null;
  const entries: CompactFieldDescriptor[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const descriptor = entry as Record<string, unknown>;
    const apiName = typeof descriptor.apiName === 'string' ? descriptor.apiName : typeof descriptor.name === 'string' ? descriptor.name : '';
    if (!apiName) continue;
    const label = typeof descriptor.label === 'string' ? descriptor.label : undefined;
    entries.push(label === undefined ? { apiName } : { apiName, label });
  }
  return entries.length > 0 ? entries : null;
}

/**
 * The name/display fields are Salesforce-declared, never guessed: the authoritative
 * source is the top-level `objectInfo.nameFields` array that UI API Object Info
 * returns for the current USER. Each declared API name is looked up in
 * `objectInfo.fields` for its label/dataType. A field is never treated as a display
 * field merely because it is named `Name` or has a `name` dataType, and no
 * object-specific display convention (for example CaseNumber for Case) is hard-coded.
 * When Salesforce declares no name fields (or the API form omits `nameFields`), the
 * result reports NONE_DECLARED so the Agent uses layout evidence or the user question.
 */
function resolveNameFields(objectInfo: ObjectInfo): NameFieldResolution {
  const declared = objectInfo.nameFields ?? [];
  const nameFields: NameFieldResolution['nameFields'] = [];
  const seen = new Set<string>();
  for (const apiName of declared) {
    const field = objectInfo.fields[apiName];
    if (!field || seen.has(apiName)) continue;
    seen.add(apiName);
    nameFields.push({ apiName: field.apiName, label: field.label, dataType: field.dataType });
  }
  return { nameFields, source: nameFields.length > 0 ? 'NAME_FIELD' : 'NONE_DECLARED' };
}

function objectInfoFieldMeta(objectInfo: ObjectInfo, apiName: string): ObjectInfoFieldMeta | null {
  const field = objectInfo.fields[apiName];
  if (!field) return null;
  return {
    label: field.label,
    dataType: field.dataType,
    referenceTo: (field.referenceToInfos ?? []).map((reference) => reference.apiName).slice(0, 25),
    relationshipName: field.relationshipName ?? null,
  };
}

function buildViewFields(
  objectInfo: ObjectInfo,
  layout: Layout | null,
): { fields: NonNullable<RecordDisplayContextOutput['viewLayoutFields']>; omitted: number; truncated: boolean } {
  const fields: NonNullable<RecordDisplayContextOutput['viewLayoutFields']> = [];
  let omitted = 0;
  if (!layout) return { fields, omitted, truncated: false };
  const ordered = [...collectLayoutFacts(layout).entries()].sort((left, right) => left[1].order - right[1].order);
  let truncated = ordered.length > MAX_VIEW_LAYOUT_FIELDS;
  for (const [apiName, fact] of ordered.slice(0, MAX_VIEW_LAYOUT_FIELDS)) {
    const meta = objectInfoFieldMeta(objectInfo, apiName);
    if (!meta) {
      omitted += 1;
      continue;
    }
    fields.push({
      apiName,
      label: meta.label,
      dataType: meta.dataType,
      section: fact.section,
      layoutOrder: fact.order,
      // READ semantics: a field Salesforce exposes to this USER in both Object Info and
      // the View layout is readable. Layout read-only/editable flags describe WRITE
      // behavior, not readability — Formula, Roll-Up, and system-calculated fields are
      // valid READ display fields — so readable is never derived from readOnly/editability.
      readable: true,
      referenceTo: [...meta.referenceTo],
      relationshipName: meta.relationshipName,
    });
  }
  return { fields, omitted, truncated };
}

function buildCompactFields(
  objectInfo: ObjectInfo,
  compact: readonly CompactFieldDescriptor[] | null,
): { fields: NonNullable<RecordDisplayContextOutput['compactLayoutFields']>; omitted: number; truncated: boolean } {
  const fields: NonNullable<RecordDisplayContextOutput['compactLayoutFields']> = [];
  let omitted = 0;
  if (!compact) return { fields, omitted, truncated: false };
  const truncated = compact.length > MAX_COMPACT_LAYOUT_FIELDS;
  compact.slice(0, MAX_COMPACT_LAYOUT_FIELDS).forEach((entry, index) => {
    const meta = objectInfoFieldMeta(objectInfo, entry.apiName);
    if (!meta) {
      omitted += 1;
      return;
    }
    fields.push({
      apiName: entry.apiName,
      label: entry.label ?? meta.label,
      dataType: meta.dataType,
      order: index,
      // Same READ semantics as the View layout: presence in the current-USER Object Info
      // and Compact layout proves readability; editability is not required to read.
      readable: true,
    });
  });
  return { fields, omitted, truncated };
}
