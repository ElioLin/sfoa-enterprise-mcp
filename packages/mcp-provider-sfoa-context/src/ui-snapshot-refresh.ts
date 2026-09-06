import type { Connection } from '@salesforce/core';
import { UI_PARSER_VERSION, uiSnapshotSchema, type UiAssignment, type UiSnapshot } from './effective-ui-contracts.js';
import { asArray, asObject, parseFlexiPage, textValue } from './flexipage-parser.js';

/** Admin-only configuration read, using a dedicated DIAGNOSTIC connection. */
export async function collectUiSnapshot(connection: Connection, objectApiName: string, signal?: AbortSignal): Promise<UiSnapshot> {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(objectApiName)) throw new Error('INVALID_OBJECT');
  const check = (): void => { signal?.throwIfAborted(); };
  const query = async (soql: string, limit: number): Promise<Record<string, unknown>[]> => {
    check();
    const result = await connection.query(soql);
    if (!result.done || result.records.length > limit) throw new Error('SNAPSHOT_INVENTORY_BOUND');
    return result.records.map(asObject);
  };
  check();
  const [userInfo, object, directory, definitions, profiles, profileDirectory, types] = await Promise.all([
    connection.soap.getUserInfo(), connection.metadata.read('CustomObject', objectApiName),
    connection.metadata.list([{ type: 'CustomApplication' }]),
    query('SELECT DurableId, DeveloperName, NamespacePrefix FROM AppDefinition LIMIT 101', 100),
    query('SELECT Id, Name FROM Profile LIMIT 501', 500),
    connection.metadata.list([{ type: 'Profile' }]),
    query(`SELECT Id, DeveloperName, NamespacePrefix FROM RecordType WHERE SobjectType = '${objectApiName}' LIMIT 201`, 200),
  ]);
  check();
  if (asObject(object).fullName !== objectApiName) throw new Error('SNAPSHOT_OBJECT_MISMATCH');
  const appDirectory = asArray(directory).map(asObject);
  if (appDirectory.length > 100) throw new Error('SNAPSHOT_APP_BOUND');
  const apps = definitions.map((definition) => {
    const name = textValue(definition.DeveloperName);
    const namespace = textValue(definition.NamespacePrefix);
    const fullName = namespace ? `${namespace}__${name}` : name;
    if (!name || !fullName || appDirectory.filter((entry) => entry.fullName === fullName).length !== 1) return undefined;
    return { appId: String(definition.DurableId), developerName: name, fullName };
  }).filter((app): app is NonNullable<typeof app> => app !== undefined);
  const assignments: UiAssignment[] = [];
  const metadataProfiles = asArray(profileDirectory).map(asObject);
  if (metadataProfiles.length > 500) throw new Error('SNAPSHOT_PROFILE_BOUND');
  function add(raw: unknown, app: string | null, source: UiAssignment['source']): void {
    for (const row of asArray(raw).map(asObject)) {
      if (!['New', 'View'].includes(String(row.actionName))) continue;
      if (app && row.pageOrSobjectType !== objectApiName) continue;
      const formFactor = row.formFactor == null ? null : row.formFactor;
      if (formFactor !== null && !['Large', 'Medium', 'Small'].includes(String(formFactor))) throw new Error('SNAPSHOT_FORM_FACTOR');
      assignments.push({ app, profile: textValue(row.profile) ?? null, recordType: textValue(row.recordType) ?? null,
        formFactor: formFactor as UiAssignment['formFactor'], action: row.actionName as 'New' | 'View',
        type: String(row.type), page: textValue(row.content) ?? null, source });
    }
  }
  add(asObject(object).actionOverrides, null, 'ORG_DEFAULT');
  for (let index = 0; index < apps.length; index += 20) {
    check();
    const batch = apps.slice(index, index + 20);
    // At most two official SDK reads, ten components each; preserve the input order.
    const values = (await Promise.all([batch.slice(0, 10), batch.slice(10)].filter((group) => group.length)
      .map(async (group) => asArray(await connection.metadata.read('CustomApplication', group.map((app) => app.fullName)))))).flat().map(asObject);
    check();
    for (const app of batch) {
      const matches = values.filter((value) => value.fullName === app.fullName);
      if (matches.length !== 1) throw new Error('SNAPSHOT_APP_READ_INCOMPLETE');
      add(matches[0]?.actionOverrides, app.fullName, 'APP_DEFAULT');
      add(matches[0]?.profileActionOverrides, app.fullName, 'APP_PROFILE_RECORD_TYPE');
    }
  }
  const names = [...new Set(assignments.filter((row) => row.type === 'Flexipage' && row.page).map((row) => row.page as string))];
  if (names.length > 100) throw new Error('SNAPSHOT_PAGE_BOUND');
  const pages: UiSnapshot['pages'] = [];
  for (let index = 0; index < names.length; index += 10) {
    check();
    const batch = names.slice(index, index + 10);
    const values = asArray(await connection.metadata.read('FlexiPage', batch)).map(asObject);
    for (const name of batch) {
      const matches = values.filter((value) => value.fullName === name);
      if (matches.length !== 1) throw new Error('SNAPSHOT_PAGE_READ_INCOMPLETE');
      pages.push(parseFlexiPage(matches[0], objectApiName));
    }
  }
  check();
  return uiSnapshotSchema.parse({ organizationId: userInfo.organizationId, objectApiName,
    parserVersion: UI_PARSER_VERSION, apps, assignments, pages, complete: true,
    profiles: profiles.map((profile) => {
      const matches = metadataProfiles.filter((entry) => String(entry.id).slice(0, 15) === String(profile.Id).slice(0, 15));
      if (matches.length !== 1 || !textValue(matches[0]?.fullName)) throw new Error('SNAPSHOT_PROFILE_MAPPING_INCOMPLETE');
      return { id: profile.Id, name: profile.Name, fullName: matches[0]!.fullName };
    }),
    recordTypes: types.map((type) => ({ id: type.Id,
      fullName: `${objectApiName}.${type.NamespacePrefix ? `${String(type.NamespacePrefix)}__` : ''}${String(type.DeveloperName)}` })),
  });
}
