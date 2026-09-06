// Dev-only, read-only SFoA evidence. No MCP registration, DML, deploy, or DB writes.
// Run from repository root: node scripts/p8-04a-feasibility.mjs [--targeted]
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectEnvironment, sanitizeForOutput } from '../skills/sfoa-mcp-maintainer/scripts/shared/project.mjs';
import { withReadOnlyDatabase } from '../skills/sfoa-mcp-maintainer/scripts/shared/db.mjs';
import {
  JwtConnectionFactory, loadIdentityRuntimeConfig, createSalesforceIdentityRoute,
  installJsforceAuditAdapter, RequestAuditContextController, runWithRequestAuditContext,
} from '../packages/sfoa-identity-runtime/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targeted = process.argv.includes('--targeted');
const objects = ['Quote__c', 'Lead', 'Opportunity'];
const asArray = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const select = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
const report = { generatedAt: new Date().toISOString(), objects, operations: [], users: [], pages: [], apps: [] };
const watchdog = setTimeout(() => { console.error('P8_04A_PROBE_TIMEOUT'); process.exit(1); }, 600_000);
let environment;
const identifiers = new Set();

async function measured(label, role, operation, project = () => ({})) {
  const controller = RequestAuditContextController.create({ channel: 'MCP_STDIO', toolName: 'p8_04a_dev_probe' });
  const started = performance.now();
  let value;
  const entry = { label, role };
  try {
    value = await runWithRequestAuditContext(controller, async () => await operation());
    // Size of decoded SDK JSON, not the compressed HTTP body or persisted metadata.
    if (!label.startsWith('AUTH')) {
      const json = JSON.stringify(value);
      entry.decodedJsonBytes = Buffer.byteLength(json);
      const parseStart = performance.now();
      for (let index = 0; index < 10; index++) JSON.parse(json);
      entry.jsonParseMeanMs = Number(((performance.now() - parseStart) / 10).toFixed(3));
    }
    entry.status = 'PASS';
    entry.evidence = project(value);
  } catch (error) {
    entry.status = 'BLOCKED';
    // Never serialize SDK errors, messages, causes, Connection/AuthInfo, or headers.
    const code = error?.errorCode ?? error?.code ?? error?.name;
    entry.errorCode = typeof code === 'string' && /^[A-Za-z0-9_]{1,100}$/u.test(code) ? code : 'READ_FAILED';
  }
  entry.elapsedMs = Math.round(performance.now() - started);
  const snapshot = controller.finalizeAudit();
  entry.http = (snapshot?.salesforceApiCalls ?? []).map((call) => select(call,
    ['apiCategory', 'httpMethod', 'httpStatus', 'durationMs', 'requestSizeBytes', 'responseSizeBytes', 'visibility']));
  entry.httpAttemptCount = entry.http.length;
  entry.responsePayloads = (snapshot?.payloadEvidence ?? [])
    .filter((payload) => ['SALESFORCE_RESPONSE', 'ERROR_RESPONSE'].includes(payload.payloadType))
    .map((payload) => select(payload, ['contentType', 'originalSizeBytes', 'truncated']));
  report.operations.push(entry);
  console.log(JSON.stringify({ label, status: entry.status, elapsedMs: entry.elapsedMs, httpAttemptCount: entry.httpAttemptCount }));
  return value;
}

function pageShape(page) {
  return {
    ...select(page, ['fullName', 'type', 'sobjectType', 'parentFlexiPage', 'template']),
    regions: asArray(page.flexiPageRegions).map((region) => ({
      ...select(region, ['name', 'type']),
      items: asArray(region.itemInstances).map((item) => ({
        ...(item.fieldInstance ? { fieldInstance: select(item.fieldInstance,
          ['fieldItem', 'identifier', 'fieldInstanceProperties', 'visibilityRule']),
          criterionLiteralKinds: asArray(item.fieldInstance.visibilityRule?.criteria).map((criterion) =>
            criterion.rightValue === undefined ? 'ABSENT' : ['true', 'false'].includes(criterion.rightValue) ? 'BOOLEAN_TEXT' : 'OTHER_TEXT') } : {}),
        ...(item.componentInstance ? { componentInstance: {
          ...select(item.componentInstance, ['componentName', 'identifier', 'visibilityRule']),
          properties: asArray(item.componentInstance.componentInstanceProperties).filter((property) =>
            ['body', 'columns', 'tabs', 'left', 'right', 'fieldLabel', 'label', 'numColumns'].includes(property.name)),
        } } : {}),
      })),
    })),
  };
}

function sanitizeEvidence(value) {
  const scrub = (item) => {
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, scrub(child)]));
    if (typeof item !== 'string') return item;
    let text = item;
    for (const identity of identifiers) if (identity) text = text.split(identity).join('[IDENTITY]');
    return text.replace(/\b[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?\b/gu, (match) =>
      /^(005|00e|00D|012|00h|0PS)/u.test(match) ? '[SF_ID]' : match);
  };
  return sanitizeForOutput(scrub(value), environment);
}

try {
  environment = await loadProjectEnvironment(root);
  const config = await loadIdentityRuntimeConfig(root, environment.values, { routesFromDatabase: true });
  const routes = await withReadOnlyDatabase(root, environment, async (db) => ({
    users: await db.execute('SELECT platform_user_id, salesforce_username FROM sfoa_identity_route WHERE enabled = TRUE ORDER BY id LIMIT 6'),
    diagnostic: await db.execute('SELECT salesforce_username FROM sfoa_diagnostic_config WHERE id = 1 AND enabled = TRUE'),
  }));
  installJsforceAuditAdapter();
  const factory = new JwtConnectionFactory(select(config, ['instanceUrl', 'clientId', 'privateKeyPath']));
  const seen = new Set();
  const candidates = routes.users.filter((row) => {
    if (seen.has(row.salesforce_username)) return false;
    seen.add(row.salesforce_username);
    return true;
  }).slice(0, 3).map((row, index) => ({ ...row, role: 'USER', label: `USER_${index + 1}` }));
  if (routes.diagnostic[0]) candidates.push({ ...routes.diagnostic[0], platform_user_id: 'p8-04a-diagnostic', role: 'DIAGNOSTIC', label: 'DIAGNOSTIC' });
  const connections = [];
  for (const row of candidates) {
    identifiers.add(row.salesforce_username);
    identifiers.add(row.platform_user_id);
    const connection = await measured(`AUTH_${row.label}`, row.role, () => factory.create(createSalesforceIdentityRoute({
      platformUserId: row.platform_user_id, salesforceUsername: row.salesforce_username,
      connectionRole: row.role, credentialProfile: 'sfoa-shared-jwt', aliases: [],
    })), (conn) => ({ apiVersion: conn.getApiVersion() }));
    if (!connection) continue;
    connections.push({ connection, ...row });
    const identity = await measured(`${row.label}:identity`, row.role, () => connection.identity(), (value) => ({ userIdPresent: Boolean(value.user_id), organizationIdPresent: Boolean(value.organization_id), keys: Object.keys(value) }));
    if (!identity?.user_id || !/^[A-Za-z0-9]{15,18}$/u.test(identity.user_id)) continue;
    identifiers.add(identity.user_id);
    identifiers.add(identity.organization_id);
    const user = await measured(`${row.label}:User.Profile`, row.role,
      () => connection.query(`SELECT Id, ProfileId, Profile.Name FROM User WHERE Id = '${identity.user_id}' LIMIT 1`),
      (value) => ({ count: value.records.length, ...select(value.records[0], ['UserType', 'IsActive']), profileName: value.records[0]?.Profile?.Name }));
    const profile = user?.records?.[0];
    if (profile?.ProfileId) identifiers.add(profile.ProfileId);
    report.users.push({ label: row.label, role: row.role, profileName: profile?.Profile?.Name, sameProfileAsFirst: profile?.ProfileId && connections[0]?.profileId ? profile.ProfileId === connections[0].profileId : null });
    connections[connections.length - 1].profileId = profile?.ProfileId;
    connections[connections.length - 1].userId = identity.user_id;
    const soapUser = await measured(`${row.label}:SOAP.getUserInfo`, row.role, () => connection.soap.getUserInfo(),
      (value) => ({ keys: Object.keys(value), profileIdPresent: Boolean(value.profileId), matchesIdentity: value.userId === identity.user_id }));
    if (soapUser?.profileId) {
      connections[connections.length - 1].profileId = soapUser.profileId;
      identifiers.add(soapUser.profileId);
    }
    if (!profile) {
      const minimal = await measured(`${row.label}:User.ProfileId-only`, row.role,
        () => connection.query(`SELECT Id, ProfileId FROM User WHERE Id = '${identity.user_id}' LIMIT 1`),
        (value) => ({ count: value.records.length, profileIdPresent: Boolean(value.records[0]?.ProfileId) }));
      if (minimal?.records?.[0]?.ProfileId) connections[connections.length - 1].profileId = minimal.records[0].ProfileId;
    }
    await measured(`${row.label}:PermissionSetAssignment`, row.role,
      () => connection.query(`SELECT PermissionSetId, PermissionSet.Name, PermissionSet.IsOwnedByProfile FROM PermissionSetAssignment WHERE AssigneeId = '${identity.user_id}' LIMIT 50`),
      (value) => ({ count: value.records.length, done: value.done, assignments: value.records.map((record) => select(record.PermissionSet, ['Name', 'IsOwnedByProfile'])) }));
    if (row.role !== 'USER') continue;
    if (targeted) await measured(`${row.label}:UI_API.apps`, row.role,
      () => connection.request({ method: 'GET', url: `/services/data/v${connection.getApiVersion()}/ui-api/apps?formFactor=Large` }),
      (value) => ({ keys: Object.keys(value), apps: asArray(value.apps).map((app) => select(app, ['developerName', 'label', 'formFactors', 'navType'])), count: asArray(value.apps).length }));
    for (const object of targeted ? ['Quote__c'] : objects) {
      const prefix = `/services/data/v${connection.getApiVersion()}`;
      const info = await measured(`${row.label}:${object}:object-info`, row.role,
        () => connection.request({ method: 'GET', url: `${prefix}/ui-api/object-info/${object}` }),
        (value) => ({ createable: value.createable, fieldCount: Object.keys(value.fields ?? {}).length,
          recordTypes: Object.values(value.recordTypeInfos ?? {}).map((type) => select(type, ['name', 'available', 'defaultRecordTypeMapping', 'master'])) }));
      const recordTypes = Object.values(info?.recordTypeInfos ?? {}).filter((type) => type.available);
      for (const type of recordTypes.slice(0, 2)) {
        const defaults = await measured(`${row.label}:${object}:create-defaults:${type.name}`, row.role,
          () => connection.request({ method: 'GET', url: `${prefix}/ui-api/record-defaults/create/${object}?recordTypeId=${encodeURIComponent(type.recordTypeId)}` }),
          (value) => ({ topLevelKeys: Object.keys(value), layout: select(value.layout, ['id', 'layoutType', 'mode', 'objectApiName', 'recordTypeId']),
            sectionCount: value.layout?.sections?.length, layoutKeys: Object.keys(value.layout ?? {}) }));
        const current = connections[connections.length - 1];
        current.layouts ??= [];
        if (defaults?.layout?.id) current.layouts.push({ id: defaults.layout.id, object, recordTypeName: type.name });
      }
    }
    // Independently test whether USER can read configuration; never silently substitute DIAGNOSTIC.
    await measured(`${row.label}:FlexiPage.list`, row.role,
      () => connection.metadata.list([{ type: 'FlexiPage' }]),
      (value) => ({ count: asArray(value).length, names: asArray(value).map((item) => item.fullName) }));
  }
  const metadataIdentity = connections.find((item) => item.role === 'DIAGNOSTIC');
  if (!metadataIdentity) report.metadataStatus = 'BLOCKED_NO_DIAGNOSTIC_ROUTE';
  else if (targeted) {
    const { connection: conn, role } = metadataIdentity;
    for (const user of connections.filter((item) => item.role === 'USER')) {
      const result = await measured(`${user.label}:DIAGNOSTIC.User.Profile`, role,
        () => conn.query(`SELECT Id, ProfileId, Profile.Name FROM User WHERE Id = '${user.userId}' LIMIT 1`),
        (value) => ({ profileName: value.records[0]?.Profile?.Name, matchesSoapProfile: value.records[0]?.ProfileId === user.profileId }));
      report.users.find((item) => item.label === user.label).profileName = result?.records?.[0]?.Profile?.Name;
      for (const layout of user.layouts ?? []) {
        if (!/^[A-Za-z0-9]{15,18}$/u.test(layout.id)) continue;
        await measured(`${user.label}:LayoutIdentity:${layout.recordTypeName}`, role,
          () => conn.tooling.query(`SELECT Id, Name, TableEnumOrId FROM Layout WHERE Id = '${layout.id}' LIMIT 1`),
          (value) => ({ count: value.records.length, name: value.records[0]?.Name, exactIdMatches: value.records[0]?.Id?.slice(0, 15) === layout.id.slice(0, 15) }));
      }
    }
    for (let trial = 1; trial <= 3; trial++) {
      for (const [type, name] of [['FlexiPage', 'Quote_Record_Page'], ['FlexiPage', 'FlexiPage151'], ['CustomApplication', 'FRN_CRM_PC']]) {
        await measured(`COST_${trial}:${type}:${name}`, role, () => conn.metadata.read(type, name),
          (value) => ({ fullName: value.fullName, type: value.type, sobjectType: value.sobjectType }));
      }
    }
    for (const name of ['SHRN_Lead_Record_Page', 'WRN_Opportunity_Record_Type']) {
      const page = await measured(`FIELD_RULES:${name}`, role, () => conn.metadata.read('FlexiPage', name),
        (value) => ({ fullName: value.fullName, type: value.type, sobjectType: value.sobjectType }));
      if (page) report.pages.push(pageShape(page));
    }
  } else {
    const { connection: conn, role } = metadataIdentity;
    const relevantPages = new Set();
    for (const user of connections.filter((item) => item.role === 'USER' && item.userId)) {
      const result = await measured(`${user.label}:DIAGNOSTIC.User.Profile`, role,
        () => conn.query(`SELECT Id, ProfileId, Profile.Name FROM User WHERE Id = '${user.userId}' LIMIT 1`),
        (value) => ({ count: value.records.length, profileName: value.records[0]?.Profile?.Name,
          matchesUserProfile: user.profileId ? user.profileId === value.records[0]?.ProfileId : null }));
      user.profileId = result?.records?.[0]?.ProfileId;
      identifiers.add(user.profileId);
      const summary = report.users.find((item) => item.label === user.label);
      summary.profileName = result?.records?.[0]?.Profile?.Name;
      summary.profileEvidenceRole = 'DIAGNOSTIC';
      summary.sameProfileAsFirst = user.profileId && connections[0]?.profileId ? user.profileId === connections[0].profileId : null;
    }
    for (const object of objects) {
      const metadata = await measured(`${object}:CustomObject`, role, () => conn.metadata.read('CustomObject', object),
        (value) => ({ fullName: value.fullName, actionOverrides: asArray(value.actionOverrides).filter((item) => ['New', 'View'].includes(item.actionName)), recordTypes: asArray(value.recordTypes).map((type) => select(type, ['fullName', 'active'])) }));
      for (const override of asArray(metadata?.actionOverrides)) if (override.type === 'Flexipage' && override.content) relevantPages.add(override.content);
      await measured(`${object}:Tooling.Layout`, role,
        () => conn.tooling.query(`SELECT Id, Name, TableEnumOrId FROM Layout WHERE TableEnumOrId = '${object}' LIMIT 30`),
        (value) => ({ count: value.records.length, done: value.done, layouts: value.records.map((item) => select(item, ['Id', 'Name', 'TableEnumOrId'])) }));
    }
    const pages = await measured('FlexiPage.list', role, () => conn.metadata.list([{ type: 'FlexiPage' }]),
      (value) => ({ count: asArray(value).length, names: asArray(value).map((item) => item.fullName) }));
    report.pageInventoryCount = asArray(pages).length;
    const apps = await measured('CustomApplication.list', role, () => conn.metadata.list([{ type: 'CustomApplication' }]),
      (value) => ({ count: asArray(value).length, names: asArray(value).map((item) => item.fullName) }));
    report.appDiscoveryTruncated = asArray(apps).length > 40;
    for (const app of asArray(apps).slice(0, 40)) {
      const data = await measured(`CustomApplication:${app.fullName}`, role, () => conn.metadata.read('CustomApplication', app.fullName),
        (value) => ({ fullName: value.fullName, keys: Object.keys(value) }));
      if (data) {
        const actionOverrides = asArray(data.actionOverrides).filter((item) => objects.includes(item.pageOrSobjectType));
        const profileActionOverrides = asArray(data.profileActionOverrides).filter((item) => objects.includes(item.pageOrSobjectType));
        report.apps.push({ fullName: data.fullName, actionOverrides, profileActionOverrides,
          totalProfileOverrides: asArray(data.profileActionOverrides).length });
        for (const override of [...actionOverrides, ...profileActionOverrides]) if (override.type === 'Flexipage' && override.content) relevantPages.add(override.content);
      }
    }
    report.pageDiscoveryTruncated = relevantPages.size > 20;
    for (const name of [...relevantPages].sort().slice(0, 20)) {
      const page = await measured(`FlexiPage:${name}`, role, () => conn.metadata.read('FlexiPage', name),
        (value) => ({ fullName: value.fullName, type: value.type, sobjectType: value.sobjectType }));
      if (page && objects.includes(page.sobjectType)) report.pages.push(pageShape(page));
    }
    const profiles = await measured('Profile.list', role, () => conn.metadata.list([{ type: 'Profile' }]),
      (value) => ({ count: asArray(value).length }));
    const profileNames = asArray(profiles).filter((profile) => connections.some((user) => user.profileId === profile.id)).map((profile) => profile.fullName);
    for (const profileName of profileNames) {
      await measured(`Profile:${profileName}`, role, () => conn.metadata.read('Profile', profileName),
        (value) => ({ fullName: value.fullName, keys: Object.keys(value),
          layoutAssignments: asArray(value.layoutAssignments).filter((item) => objects.some((object) => item.layout?.startsWith(`${object}-`))),
          applicationVisibilities: value.applicationVisibilities,
          profileActionOverrides: asArray(value.profileActionOverrides).filter((item) => objects.includes(item.pageOrSobjectType)) }));
    }
    await measured('Tooling.FlexiPage', role,
      () => conn.tooling.query('SELECT Id, DeveloperName, Type FROM FlexiPage LIMIT 30'),
      (value) => ({ count: value.records.length, done: value.done, pages: value.records.map((item) => select(item, ['DeveloperName', 'Type'])) }));
  }
  report.status = 'EVIDENCE_COLLECTED_NOT_AN_ACCURACY_GATE';
} catch {
  report.status = 'BLOCKED_SETUP_OR_PROBE';
  console.error('P8_04A_SETUP_OR_PROBE_FAILED (details deliberately suppressed)');
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  if (environment) {
    const output = path.join(root, '.temp', targeted ? 'p8-04a-targeted.json' : 'p8-04a-feasibility.json');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(sanitizeEvidence(report), null, 2)}\n`);
    console.log(`Sanitized evidence: ${path.relative(root, output)}`);
  }
}
