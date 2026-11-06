import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import { collectPrecisionMetadata, type PrecisionMetadataRequest } from '../precision-metadata.js';
import { PrecisionComponentCache } from '../precision-component-cache.js';
import { UI_PARSER_VERSION } from '../effective-ui-contracts.js';
import { fixturePage, ORG, PROFILE, RT } from './effective-ui-fixtures.js';

function fixture() {
  const calls: string[] = [];
  const profile = { fullName: 'Profile_A', applicationVisibilities: [{ application: 'App_A', default: true, visible: true }] };
  const application = { fullName: 'App_A', profileActionOverrides: [{ pageOrSobjectType: 'Sample__c', profile: 'Profile_A',
    recordType: 'Sample__c.Business', formFactor: 'Large', actionName: 'View', type: 'Flexipage', content: 'Create_Page' }] };
  const object = { fullName: 'Sample__c', actionOverrides: [] as unknown[] };
  const connection = {
    getApiVersion: () => '68.0',
    soap: { getUserInfo: async () => { calls.push('USER_INFO'); return { organizationId: ORG }; } },
    tooling: { query: async (soql: string) => { calls.push(soql); return { done: true,
      records: [{ Id: PROFILE, Name: 'Profile display', FullName: 'Profile_A' }] }; } },
    query: async (soql: string) => { calls.push(soql); return { done: true, records: soql.includes('FROM Profile')
      ? [{ Id: PROFILE, Name: 'Profile display' }] : soql.includes('FROM AppDefinition')
      ? [{ DurableId: '06m000000000001AAA', DeveloperName: 'App_A', NamespacePrefix: null }]
      : [{ Id: RT, DeveloperName: 'Business', NamespacePrefix: null }] }; },
    metadata: { list: async (types: { type: string }[]) => { calls.push(`LIST:${types[0]!.type}`);
      return types[0]!.type === 'Profile' ? [{ id: PROFILE, fullName: 'Profile_A' }] : [{ fullName: 'App_A' }]; },
      read: async (type: string, name: string) => { calls.push(`READ:${type}:${name}`);
        return type === 'Profile' ? profile : type === 'CustomObject' ? object : type === 'CustomApplication' ? application : fixturePage(); },
    },
  } as unknown as Connection;
  const request: PrecisionMetadataRequest = { organizationId: ORG, profileId: PROFILE, objectApiName: 'Sample__c',
    recordTypeId: RT, action: 'CREATE', accessibleApps: [{ appId: '06m000000000001AAA', developerName: 'App_A' }] };
  return { connection, request, calls, profile, application, object };
}

test('fresh Profile default chooses a USER-accessible app and reads only the winning page', async () => {
  const f = fixture();
  f.object.actionOverrides.push({ actionName: 'View', formFactor: 'Large', type: 'Flexipage', content: 'Losing_Org_Page' });
  const result = await collectPrecisionMetadata(f.connection, f.request);
  assert.equal(result.appSource, 'PROFILE_DEFAULT'); assert.equal(result.appDeveloperName, 'App_A');
  assert.equal(result.snapshot.pages[0]?.fullName, 'Create_Page');
  assert.equal(result.snapshot.pages.length, 1);
  assert.ok(!f.calls.some((call) => call.includes('READ:FlexiPage:Losing_Org_Page')));
  assert.equal(result.apiCallCount, 9);
  assert.equal(f.calls.filter((call) => call.startsWith('READ:CustomApplication')).length, 1);
  assert.deepEqual(f.calls.filter((call) => call.startsWith('LIST:')), ['LIST:Profile']);
  assert.ok(f.calls.every((call) => !call.includes('FROM Sample__c') && !call.includes('FROM User')));
});

test('explicit task app can bypass absent Profile default, while automatic choice cannot', async () => {
  const f = fixture(); f.profile.applicationVisibilities = [];
  await assert.rejects(collectPrecisionMetadata(f.connection, f.request), /PROFILE_DEFAULT_APP_UNRESOLVED/u);
  const result = await collectPrecisionMetadata(f.connection, { ...f.request, appDeveloperName: 'App_A' });
  assert.equal(result.appSource, 'TASK_CONTEXT');
});

test('inaccessible app and stale cross-org metadata identity fail before any page interpretation', async () => {
  const f = fixture();
  await assert.rejects(collectPrecisionMetadata(f.connection, { ...f.request, accessibleApps: [] }), /APP_NOT_ACCESSIBLE/u);
  const other = fixture();
  await assert.rejects(collectPrecisionMetadata(other.connection, { ...other.request, organizationId: '00D000000000002AAA' }), /ORG_MISMATCH/u);
  assert.deepEqual(other.calls, ['USER_INFO']);
});

test('Edit override is kept and stops Lightning page lookup; New remains independent', async () => {
  const f = fixture();
  f.object.actionOverrides.push({ actionName: 'Edit', type: 'Visualforce', content: 'Custom_Edit', formFactor: 'Large' });
  const result = await collectPrecisionMetadata(f.connection, { ...f.request, action: 'UPDATE' });
  assert.equal(result.snapshot.assignments.some((row) => row.action === 'Edit'), true);
  assert.equal(result.snapshot.pages.length, 0);
  assert.ok(!f.calls.some((call) => call.startsWith('READ:FlexiPage')));
});

test('consecutive calls reread current configuration and never reuse an earlier user result', async () => {
  const f = fixture();
  await collectPrecisionMetadata(f.connection, f.request);
  f.profile.applicationVisibilities = [];
  await assert.rejects(collectPrecisionMetadata(f.connection, f.request), /PROFILE_DEFAULT_APP_UNRESOLVED/u);
  assert.equal(f.calls.filter((call) => call === 'READ:Profile:Profile_A').length, 2);
});

test('invalid identifiers and expired deadlines dispatch no configuration request', async () => {
  const f = fixture();
  await assert.rejects(collectPrecisionMetadata(f.connection, { ...f.request, objectApiName: "Bad' OR Id != null" }), /INPUT_INVALID/u);
  await assert.rejects(collectPrecisionMetadata(f.connection, f.request, performance.now() - 1), /TIMEOUT/u);
  assert.deepEqual(f.calls, []);
});

function versionedFixture() {
  const f = fixture();
  const revisions: Record<string, string> = { Profile: '2026-11-06T01:00:00.000Z', CustomApplication: '2026-11-06T01:00:00.000Z', FlexiPage: '2026-11-06T01:00:00.000Z' };
  const names: Record<string, { id: string; fullName: string }> = { Profile: { id: PROFILE, fullName: 'Profile_A' },
    CustomApplication: { id: '02u000000000001AAA', fullName: 'App_A' }, FlexiPage: { id: '0M0000000000001AAA', fullName: 'Create_Page' } };
  const connection = { ...f.connection, metadata: { ...f.connection.metadata, list: async (types: { type: string }[]) => {
    f.calls.push(`VERSIONS:${types.map((row) => row.type).join(',')}`);
    return types.map(({ type }) => ({ type, ...names[type], lastModifiedDate: revisions[type] }));
  } } } as unknown as Connection;
  return { ...f, connection, revisions, names };
}

test('warm component hits reverify live revisions and retain a fresh object read; profile permissions are never cached', async () => {
  const f = versionedFixture();
  Object.assign(f.profile, { userPermissions: [{ name: 'SensitivePermission', enabled: true }] });
  const cache = new PrecisionComponentCache();
  const first = await collectPrecisionMetadata(f.connection, f.request, performance.now() + 1000, cache);
  assert.equal(first.apiCallCount, 12);
  const second = await collectPrecisionMetadata(f.connection, f.request, performance.now() + 1000, cache);
  assert.equal(second.apiCallCount, 6);
  assert.equal(f.calls.filter((call) => call === 'READ:CustomObject:Sample__c').length, 2);
  assert.equal(f.calls.filter((call) => call === 'READ:Profile:Profile_A').length, 1);
  assert.equal(f.calls.filter((call) => call === 'READ:CustomApplication:App_A').length, 1);
  assert.equal(f.calls.filter((call) => call === 'READ:FlexiPage:Create_Page').length, 1);
  assert.equal(f.calls.filter((call) => call === 'VERSIONS:Profile,CustomApplication,FlexiPage').length, 2);
  const value = cache.get({ organizationId: ORG, apiVersion: '68.0', parserVersion: UI_PARSER_VERSION, type: 'Profile', fullName: 'Profile_A' },
    { id: PROFILE, lastModifiedDate: f.revisions.Profile! });
  assert.equal(value?.userPermissions, undefined);
  assert.equal(second.evidence.freshness, 'FRESH_READ_OR_COMPONENT_REVISION_VERIFIED');
});

test('revision change invalidates cached assignment and reads the changed component', async () => {
  const f = versionedFixture(); const cache = new PrecisionComponentCache();
  await collectPrecisionMetadata(f.connection, f.request, performance.now() + 1000, cache);
  f.revisions.CustomApplication = '2026-11-06T02:00:00.000Z';
  await collectPrecisionMetadata(f.connection, f.request, performance.now() + 1000, cache);
  assert.equal(f.calls.filter((call) => call === 'READ:CustomApplication:App_A').length, 2);
  f.revisions.Profile = '2026-11-06T02:00:00.000Z'; f.profile.applicationVisibilities = [];
  await assert.rejects(collectPrecisionMetadata(f.connection, f.request, performance.now() + 1000, cache), /PROFILE_DEFAULT_APP_UNRESOLVED/u);
});

test('missing or epoch component versions are never accepted as a cache freshness proof', async () => {
  const f = versionedFixture(); const cache = new PrecisionComponentCache();
  f.revisions.CustomApplication = '1970-01-01T00:00:00.000Z';
  await collectPrecisionMetadata(f.connection, f.request, performance.now() + 1000, cache);
  await collectPrecisionMetadata(f.connection, f.request, performance.now() + 1000, cache);
  assert.equal(f.calls.filter((call) => call === 'READ:CustomApplication:App_A').length, 2);
});

test('component revision changes during a cold read cannot populate a falsely verified cache', async () => {
  const f = versionedFixture(); const cache = new PrecisionComponentCache();
  const original = f.connection.metadata.read.bind(f.connection.metadata);
  Object.assign(f.connection.metadata, { read: async (type: 'Profile' | 'CustomApplication' | 'FlexiPage' | 'CustomObject', name: string) => {
    const raw = await original(type, name);
    if (type === 'Profile') f.revisions.Profile = '2026-11-06T02:00:00.000Z';
    return raw;
  } });
  await assert.rejects(collectPrecisionMetadata(f.connection, f.request, performance.now() + 1000, cache), /METADATA_CHANGED_DURING_READ/u);
});

test('loss of a previously valid component revision cannot certify an earlier read', async () => {
  const f = versionedFixture(); const cache = new PrecisionComponentCache();
  const original = f.connection.metadata.read.bind(f.connection.metadata);
  Object.assign(f.connection.metadata, { read: async (type: 'Profile' | 'CustomApplication' | 'FlexiPage' | 'CustomObject', name: string) => {
    const raw = await original(type, name);
    if (type === 'Profile') f.revisions.Profile = '1970-01-01T00:00:00.000Z';
    return raw;
  } });
  await assert.rejects(collectPrecisionMetadata(f.connection, f.request, performance.now() + 1000, cache), /METADATA_REVISION_UNRESOLVED/u);
});

test('Profile-to-App reads proceed while the independent object metadata read is outstanding', async () => {
  const f = fixture();
  let release: () => void = () => {};
  const profileStarted = new Promise<void>((resolve) => { release = resolve; });
  const connection = { ...f.connection, metadata: { ...f.connection.metadata,
    read: async (type: string) => {
      if (type === 'CustomObject') { await profileStarted; return f.object; }
      if (type === 'Profile') { release(); return f.profile; }
      return type === 'CustomApplication' ? f.application : fixturePage();
    } } } as unknown as Connection;
  const result = await collectPrecisionMetadata(connection, f.request, performance.now() + 1000);
  assert.equal(result.snapshot.pages[0]?.fullName, 'Create_Page');
});
