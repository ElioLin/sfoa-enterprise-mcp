import type { Connection } from '@salesforce/core';
import { resolveActivePage } from './active-page.js';
import { boundedRead } from './create-initial-state.js';
import { UI_PARSER_VERSION, uiSnapshotSchema, type UiAssignment, type UiSnapshot } from './effective-ui-contracts.js';
import { asArray, asObject, parseFlexiPage, textValue } from './flexipage-parser.js';
import { sameSalesforceId } from './ui-api.js';
import { PrecisionComponentCache, precisionComponentRevision, sameComponentRevision,
  type PrecisionComponentType } from './precision-component-cache.js';

export type PrecisionMetadataRequest = Readonly<{
  organizationId: string;
  profileId: string;
  objectApiName: string;
  recordTypeId: string;
  action: 'CREATE' | 'UPDATE';
  phase?: 'START' | 'REFINE' | 'SUBMIT';
  structuralContextRef?: string;
  appDeveloperName?: string;
  accessibleApps: readonly { appId: string; developerName: string }[];
}>;

export type PrecisionMetadata = Readonly<{
  snapshot: UiSnapshot;
  appDeveloperName: string;
  appSource: 'TASK_CONTEXT' | 'PROFILE_DEFAULT';
  verifiedAt: string;
  apiCallCount: number;
  structuralContextRef?: string;
  cache?: 'FRESH' | 'TASK_REUSE';
  evidence: Readonly<Record<string, unknown>>;
}>;

/** Host-owned, lazy DIAGNOSTIC access. The caller supplies USER facts, never credentials. */
export type PrecisionMetadataLoader = (request: PrecisionMetadataRequest, deadline: number) => Promise<PrecisionMetadata>;

const identifier = /^[A-Za-z][A-Za-z0-9_]{0,254}$/u;
const salesforceId = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u;

/**
 * Read current identifiers and only the selected configuration components. No
 * business records, permission replica, or persisted draft. The optional host
 * cache contains only config verified against current component revisions.
 * Directory reads establish exact API names; display labels are never guessed.
 */
export async function collectPrecisionMetadata(connection: Connection, request: PrecisionMetadataRequest,
  deadline = performance.now() + 45_000, componentCache?: PrecisionComponentCache): Promise<PrecisionMetadata> {
  if (!identifier.test(request.objectApiName) || !salesforceId.test(request.organizationId)
    || !salesforceId.test(request.profileId) || !salesforceId.test(request.recordTypeId)
    || (request.appDeveloperName !== undefined && !identifier.test(request.appDeveloperName))) {
    throw new Error('FORM_METADATA_INPUT_INVALID');
  }
  if (request.accessibleApps.length > 100) throw new Error('FORM_APP_DIRECTORY_BOUND');
  let apiCallCount = 0;
  const sources: string[] = [];
  const componentEvidence: Readonly<Record<string, unknown>>[] = [];
  async function read<T>(source: string, operation: () => PromiseLike<T>): Promise<T> {
    const result = await boundedRead(() => { apiCallCount++; return operation(); }, deadline);
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 2_097_152) throw new Error('FORM_METADATA_RESPONSE_BOUND');
    sources.push(source);
    return result;
  }
  async function query(soql: string, maximum: number): Promise<Record<string, unknown>[]> {
    const result = await read('CONFIGURATION_DIRECTORY', () => connection.query(soql));
    if (!result.done || result.records.length > maximum) throw new Error('FORM_METADATA_DIRECTORY_BOUND');
    return result.records.map(asObject);
  }
  // Verify the separate configuration identity before reading any org metadata.
  const diagnostic = await read('DIAGNOSTIC_ORG', () => connection.soap.getUserInfo());
  if (!sameSalesforceId(diagnostic.organizationId, request.organizationId)) throw new Error('FORM_METADATA_ORG_MISMATCH');
  const directoryPromise = read('COMPONENT_REVISION_DIRECTORY', () => connection.metadata.list(componentCache
    ? [{ type: 'Profile' }, { type: 'CustomApplication' }, { type: 'FlexiPage' }] : [{ type: 'Profile' }]))
    .then((value) => {
      const rows = asArray(value).map(asObject);
      if (rows.length > 1500) throw new Error('FORM_METADATA_DIRECTORY_BOUND');
      return rows;
    });
  async function structural(type: PrecisionComponentType, fullName: string,
    project: (value: Record<string, unknown>) => Record<string, unknown>): Promise<Record<string, unknown>> {
    const directory = await directoryPromise;
    const matches = directory.filter((row) => row.type === type && row.fullName === fullName);
    const before = matches.length === 1 ? precisionComponentRevision(matches[0]!) : undefined;
    const key = { organizationId: request.organizationId, apiVersion: connection.getApiVersion(), parserVersion: UI_PARSER_VERSION, type, fullName };
    if (componentCache && before) {
      const cached = componentCache.get(key, before);
      if (cached) { componentEvidence.push({ type, fullName, status: 'REVISION_VERIFIED_HIT', revision: before }); return cached; }
    }
    const value = project(component(await read(type.toUpperCase(), () => connection.metadata.read(type, fullName)),
      fullName, 'FORM_COMPONENT_MAPPING_UNRESOLVED'));
    if (componentCache && before) {
      const checked = asArray(await read('COMPONENT_REVISION_VERIFY', () => connection.metadata.list([{ type }]))).map(asObject);
      if (checked.length > 1500) throw new Error('FORM_METADATA_DIRECTORY_BOUND');
      const latest = checked.filter((row) => row.type === type && row.fullName === fullName);
      const after = latest.length === 1 ? precisionComponentRevision(latest[0]!) : undefined;
      if (!after) throw new Error('FORM_METADATA_REVISION_UNRESOLVED');
      if (!sameComponentRevision(before, after)) throw new Error('FORM_METADATA_CHANGED_DURING_READ');
      componentCache.set(key, after, value);
      componentEvidence.push({ type, fullName, status: 'FRESH_READ_CACHED', revision: after });
      return value;
    }
    componentEvidence.push({ type, fullName, status: 'FRESH_READ_UNVERSIONED' });
    return value;
  }
  // The exact metadata identity directory and Profile row are small, independent
  // reads. Tooling FullName/Metadata proved slower and applicationVisibilities
  // incomplete on the live org; never replace the authoritative Profile read.
  const profilePromise = (async () => {
    const [directory, rows] = await Promise.all([
      directoryPromise,
      query(`SELECT Id, Name FROM Profile WHERE Id = '${request.profileId}' LIMIT 2`, 1),
    ]);
    const matches = directory.filter((row) => sameSalesforceId(textValue(row.id), request.profileId));
    if (matches.length !== 1 || rows.length !== 1 || !sameSalesforceId(textValue(rows[0]?.Id), request.profileId)
      || !textValue(matches[0]?.fullName) || !textValue(rows[0]?.Name)) throw new Error('FORM_PROFILE_MAPPING_UNRESOLVED');
    const fullName = String(matches[0]!.fullName);
    const profile = request.appDeveloperName ? {} : await structural('Profile', fullName, (raw) => ({
      fullName, applicationVisibilities: asArray(raw.applicationVisibilities).map(asObject).map((row) => ({
        application: row.application, default: row.default, visible: row.visible })),
    }));
    return { fullName, name: String(rows[0]!.Name), profile };
  })();
  const appDefinitionsPromise = query('SELECT DurableId, DeveloperName, NamespacePrefix FROM AppDefinition LIMIT 101', 100);
  const applicationPromise = (async () => {
    const [profileData, definitions] = await Promise.all([profilePromise, appDefinitionsPromise]);
    const defaults = asArray(profileData.profile.applicationVisibilities).map(asObject)
      .filter((row) => row.default === true || row.default === 'true');
    const requestedApp = request.appDeveloperName ?? (defaults.length === 1 ? textValue(defaults[0]?.application) : undefined);
    if (!requestedApp) throw new Error('FORM_PROFILE_DEFAULT_APP_UNRESOLVED');
    if (!identifier.test(requestedApp)) throw new Error('FORM_APP_MAPPING_UNRESOLVED');
    const apps = definitions.flatMap((definition): UiSnapshot['apps'] => {
      const developerName = textValue(definition.DeveloperName);
      const namespace = textValue(definition.NamespacePrefix);
      const appId = textValue(definition.DurableId);
      if (!developerName || !appId) return [];
      return [{ appId, developerName, fullName: namespace ? `${namespace}__${developerName}` : developerName }];
    });
    const selected = apps.filter((app) => (app.fullName === requestedApp || app.developerName === requestedApp)
      && request.accessibleApps.some((accessible) => accessible.appId === app.appId && accessible.developerName === app.developerName));
    if (selected.length !== 1) throw new Error(selected.length > 1 ? 'FORM_APP_AMBIGUOUS' : 'FORM_APP_NOT_ACCESSIBLE_OR_UNMAPPED');
    const app = selected[0]!;
    // The selected metadata component confirms the namespaced directory mapping;
    // listing every CustomApplication adds no authority and is unnecessary.
    const application = await structural('CustomApplication', app.fullName, (raw) => ({ fullName: app.fullName,
      actionOverrides: projectAssignments(raw.actionOverrides), profileActionOverrides: projectAssignments(raw.profileActionOverrides) }));
    return { app, application };
  })();
  const [profileData, applicationData, objectRaw, recordTypeRows] = await Promise.all([
    profilePromise, applicationPromise,
    read('CUSTOM_OBJECT', () => connection.metadata.read('CustomObject', request.objectApiName)),
    request.recordTypeId.slice(0, 15) === '012000000000000' ? Promise.resolve([])
      : query(`SELECT Id, DeveloperName, NamespacePrefix FROM RecordType WHERE Id = '${request.recordTypeId}' AND SobjectType = '${request.objectApiName}' LIMIT 2`, 1),
  ]);
  const profileFullName = profileData.fullName;
  const { app, application } = applicationData;
  const object = component(objectRaw, request.objectApiName, 'FORM_OBJECT_MAPPING_UNRESOLVED');
  const assignments: UiAssignment[] = [];
  function add(raw: unknown, applicationName: string | null, source: UiAssignment['source']): void {
    for (const row of asArray(raw).map(asObject)) {
      if (!['New', 'Edit', 'View'].includes(String(row.actionName))) continue;
      if (applicationName && row.pageOrSobjectType !== request.objectApiName) continue;
      const formFactor = row.formFactor == null ? null : row.formFactor;
      if (formFactor !== null && !['Large', 'Medium', 'Small'].includes(String(formFactor))) {
        throw new Error('FORM_ASSIGNMENT_FORM_FACTOR_UNSUPPORTED');
      }
      assignments.push({ app: applicationName, profile: textValue(row.profile) ?? null,
        recordType: textValue(row.recordType) ?? null, formFactor: formFactor as UiAssignment['formFactor'],
        action: row.actionName as UiAssignment['action'], type: String(row.type), page: textValue(row.content) ?? null, source });
    }
  }
  add(object.actionOverrides, null, 'ORG_DEFAULT');
  add(application.actionOverrides, app.fullName, 'APP_DEFAULT');
  add(application.profileActionOverrides, app.fullName, 'APP_PROFILE_RECORD_TYPE');
  const recordTypes = recordTypeRows.map((row) => {
    if (!sameSalesforceId(textValue(row.Id), request.recordTypeId) || !textValue(row.DeveloperName)) {
      throw new Error('FORM_RECORD_TYPE_MAPPING_UNRESOLVED');
    }
    return { id: String(row.Id), fullName: `${request.objectApiName}.${row.NamespacePrefix ? `${String(row.NamespacePrefix)}__` : ''}${String(row.DeveloperName)}` };
  });
  if (request.recordTypeId.slice(0, 15) !== '012000000000000' && recordTypes.length !== 1) {
    throw new Error('FORM_RECORD_TYPE_MAPPING_UNRESOLVED');
  }
  const pageNames = [...new Set(assignments.filter((row) => row.type === 'Flexipage' && row.page).map((row) => row.page!))];
  // Placeholders are used solely to choose the winning assignment, never returned
  // as evaluated form facts. Only that winning page is fetched and parsed.
  const snapshot = uiSnapshotSchema.parse({ organizationId: request.organizationId, objectApiName: request.objectApiName,
    parserVersion: UI_PARSER_VERSION, complete: true, apps: [app], recordTypes, assignments,
    profiles: [{ id: request.profileId, name: profileData.name, fullName: profileFullName }],
    pages: pageNames.map((fullName) => ({ fullName, objectApiName: request.objectApiName, type: 'RecordPage',
      formSource: 'DYNAMIC_FORMS', fields: [], unsupported: [] })),
  });
  const active = resolveActivePage(snapshot, { profileId: request.profileId, recordTypeId: request.recordTypeId,
    formFactor: 'Large', action: request.action, apps: request.accessibleApps, appDeveloperName: app.fullName });
  snapshot.pages = [];
  if (active.page && !active.fallbackReason) {
    const page = await structural('FlexiPage', active.page,
      (raw) => ({ ...parseFlexiPage(raw, request.objectApiName) }));
    const parsed = uiSnapshotSchema.shape.pages.element.parse(page);
    if (parsed.objectApiName !== request.objectApiName || parsed.type !== 'RecordPage') throw new Error('FORM_PAGE_OBJECT_MISMATCH');
    snapshot.pages.push(parsed);
  }
  return { snapshot: uiSnapshotSchema.parse(snapshot), appDeveloperName: app.fullName,
    appSource: request.appDeveloperName ? 'TASK_CONTEXT' : 'PROFILE_DEFAULT', verifiedAt: new Date().toISOString(), apiCallCount, cache: 'FRESH',
    evidence: { authority: 'SALESFORCE_METADATA', components: sources, profileFullName, appFullName: app.fullName,
      selectedRecordType: recordTypes[0]?.fullName ?? `${request.objectApiName}.Master`,
      selectedPage: active.page, assignmentSource: active.assignmentSource,
      freshness: 'FRESH_READ_OR_COMPONENT_REVISION_VERIFIED', componentCache: componentEvidence,
      cache: componentCache ? 'REVISION_VERIFIED_COMPONENTS' : 'BYPASS' } };
}

function projectAssignments(raw: unknown): Record<string, unknown>[] {
  return asArray(raw).map(asObject).map((row) => Object.fromEntries([
    'actionName', 'content', 'type', 'formFactor', 'pageOrSobjectType', 'profile', 'recordType',
  ].filter((name) => row[name] !== undefined).map((name) => [name, row[name]])));
}

function component(raw: unknown, fullName: string, reason: string): Record<string, unknown> {
  const values = asArray(raw).map(asObject).filter((row) => row.fullName === fullName);
  if (values.length !== 1) throw new Error(reason);
  return values[0]!;
}
