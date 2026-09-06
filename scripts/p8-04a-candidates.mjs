// A-01 dev-only discovery. SELECT/read APIs only; no runtime registration or writes.
// Detailed evidence and the private capture key stay in ignored .temp/.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadProjectEnvironment } from '../skills/sfoa-mcp-maintainer/scripts/shared/project.mjs';
import { withReadOnlyDatabase } from '../skills/sfoa-mcp-maintainer/scripts/shared/db.mjs';
import {
  JwtConnectionFactory, loadIdentityRuntimeConfig, createSalesforceIdentityRoute,
  installJsforceAuditAdapter, RequestAuditContextController, runWithRequestAuditContext,
} from '../packages/sfoa-identity-runtime/dist/index.js';

const root = process.cwd();
const array = (v) => v == null ? [] : Array.isArray(v) ? v : [v];
const hash = (v) => createHash('sha256').update(v).digest('hex');
const objects = ['Quote__c', 'Lead', 'Opportunity'];
const started = performance.now();
const report = { generatedAt: new Date().toISOString(), status: 'PARTIAL', bounds: {
  routes: 500, queryBatch: 100, userConnections: 6, appReads: 8, pageReads: 8,
  objects: 3, createDefaultsPerUserObject: 2, timeoutMs: 600000,
}, operations: [], inventory: {}, apps: [], objectOverrides: [], users: [], pairs: [], pages: [] };
const key = { users: [], profiles: [], apps: [], cases: [] };
const timer = setTimeout(() => { console.error('CANDIDATE_DISCOVERY_TIMEOUT'); process.exit(1); }, 600000);
async function measured(label, role, operation, project = () => ({})) {
  const audit = RequestAuditContextController.create({ channel: 'MCP_STDIO', toolName: 'p8_04a_candidate_probe' });
  const begin = performance.now();
  const entry = { label, role };
  let value;
  try {
    value = await runWithRequestAuditContext(audit, async () => await operation());
    entry.status = 'PASS';
    if (!label.startsWith('AUTH')) entry.decodedJsonBytes = Buffer.byteLength(JSON.stringify(value));
    entry.evidence = project(value);
  } catch (error) {
    entry.status = 'BLOCKED';
    const code = error?.errorCode ?? error?.code ?? error?.name;
    entry.errorCode = typeof code === 'string' && /^[A-Za-z0-9_]{1,100}$/u.test(code) ? code : 'READ_FAILED';
  }
  entry.elapsedMs = Math.round(performance.now() - begin);
  const snapshot = audit.finalizeAudit();
  entry.httpAttemptCount = snapshot?.salesforceApiCalls?.length ?? 0;
  entry.responseBodyBytes = (snapshot?.payloadEvidence ?? []).filter((p) => p.payloadType === 'SALESFORCE_RESPONSE')
    .reduce((sum, p) => sum + (p.originalSizeBytes ?? 0), 0);
  report.operations.push(entry);
  console.log(JSON.stringify({ label, status: entry.status, elapsedMs: entry.elapsedMs, httpAttemptCount: entry.httpAttemptCount }));
  return value;
}
function candidate(app, profile, object, rt) {
  const specific = app.profileActionOverrides.filter((o) => o.actionName === 'View' && o.formFactor === 'Large'
    && o.profile === profile && o.pageOrSobjectType === object && o.recordType === rt);
  const appDefault = app.actionOverrides.filter((o) => o.actionName === 'View' && o.formFactor === 'Large' && o.pageOrSobjectType === object);
  const org = report.objectOverrides.find((o) => o.object === object)?.overrides.filter((o) => o.actionName === 'View' && o.formFactor === 'Large') ?? [];
  const level = specific.length ? specific : appDefault.length ? appDefault : org;
  if (level.length !== 1) return { page: null, provenance: 'UNKNOWN' };
  return { page: level[0].type === 'Default' ? 'STANDARD_DEFAULT' : level[0].content,
    type: level[0].type, provenance: specific.length ? 'APP_PROFILE_RT' : appDefault.length ? 'APP_DEFAULT' : 'OBJECT_DEFAULT' };
}
try {
  const environment = await loadProjectEnvironment(root);
  const config = await loadIdentityRuntimeConfig(root, environment.values, { routesFromDatabase: true });
  const rows = await withReadOnlyDatabase(root, environment, async (db) => ({
    users: await db.execute('SELECT id, platform_user_id, salesforce_username FROM sfoa_identity_route WHERE enabled = TRUE ORDER BY id LIMIT 501'),
    diagnostic: await db.execute('SELECT salesforce_username FROM sfoa_diagnostic_config WHERE id = 1 AND enabled = TRUE'),
  }));
  report.inventory.enabledRouteCount = rows.users.length;
  report.inventory.truncated = rows.users.length > 500;
  if (report.inventory.truncated || !rows.diagnostic[0]) throw new Error('BOUND_OR_DIAGNOSTIC');
  const unique = [...new Map(rows.users.map((r) => [r.salesforce_username, r])).values()];
  report.inventory.distinctSalesforceUsers = unique.length;
  installJsforceAuditAdapter();
  const factory = new JwtConnectionFactory({ instanceUrl: config.instanceUrl, clientId: config.clientId, privateKeyPath: config.privateKeyPath });
  async function connect(row, role, alias) {
    return measured(`AUTH_${alias}`, role, () => factory.create(createSalesforceIdentityRoute({
      platformUserId: row.platform_user_id ?? 'p8-04a-diagnostic', salesforceUsername: row.salesforce_username,
      connectionRole: role, credentialProfile: 'sfoa-shared-jwt', aliases: [],
    })));
  }
  const diagnostic = await connect(rows.diagnostic[0], 'DIAGNOSTIC', 'DIAGNOSTIC');
  if (!diagnostic) throw new Error('NO_DIAGNOSTIC');
  const mapped = [];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100);
    const literals = batch.map((r) => `'${r.salesforce_username.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`).join(',');
    const result = await measured(`PROFILE_BATCH_${offset / 100 + 1}`, 'DIAGNOSTIC',
      () => diagnostic.query(`SELECT Id, Username, IsActive, ProfileId, Profile.Name FROM User WHERE Username IN (${literals}) LIMIT 101`),
      (v) => ({ count: v.records.length, done: v.done }));
    if (!result?.done || result.records.length > 100) throw new Error('INCOMPLETE_MAPPING');
    mapped.push(...result.records);
  }
  report.inventory.mappedUsers = mapped.length;
  report.inventory.unmappedUsers = unique.filter((r) => !mapped.some((u) => u.Username === r.salesforce_username)).length;
  const profiles = [...new Map(mapped.map((u) => [u.ProfileId, u.Profile.Name])).entries()].sort((a, b) => a[0].localeCompare(b[0]));
  key.profiles = profiles.map(([id, name], i) => ({ alias: `PROFILE_${i + 1}`, id, name }));
  report.inventory.profiles = key.profiles.map((p) => ({ alias: p.alias, routeUserCount: mapped.filter((u) => u.ProfileId === p.id).length }));
  key.users = unique.map((r, i) => ({ alias: `USER_${i + 1}`, routeId: r.id, platformUserId: r.platform_user_id,
    username: r.salesforce_username, profile: key.profiles.find((p) => p.id === mapped.find((u) => u.Username === r.salesforce_username)?.ProfileId)?.alias }));

  const seedBytes = await readFile('.temp/p8-04a-feasibility.json');
  const seed = JSON.parse(seedBytes);
  report.seed = { path: '.temp/p8-04a-feasibility.json', evidenceHash: hash(seedBytes), generatedAt: seed.generatedAt,
    appCount: seed.apps.length, complete: seed.appDiscoveryTruncated === false };
  if (!report.seed.complete) throw new Error('INCOMPLETE_SEED');
  const relevantApps = seed.apps.filter((app) => app.profileActionOverrides.some((o) => profiles.some((p) => p[1] === o.profile)));
  report.inventory.relevantAppCount = relevantApps.length;
  for (const object of objects) {
    const metadata = await measured(`OBJECT_${objects.indexOf(object) + 1}`, 'DIAGNOSTIC', () => diagnostic.metadata.read('CustomObject', object));
    if (metadata) report.objectOverrides.push({ object, overrides: array(metadata.actionOverrides).filter((o) => ['New', 'View'].includes(o.actionName)),
      recordTypes: array(metadata.recordTypes).map((t) => ({ name: t.fullName, active: t.active })) });
  }
  // Reuse the bounded, hash-bound prior inventory for candidate discovery only.
  report.apps = seed.apps.map((a) => ({ ...a, freshness: 'PRIOR_DISCOVERY_ONLY' }));
  report.assignmentCandidates = [];
  for (const app of report.apps) for (const object of objects) {
    const rts = [...new Set(app.profileActionOverrides.filter((o) => o.pageOrSobjectType === object).map((o) => o.recordType))];
    for (const rt of rts) for (let a = 0; a < profiles.length; a++) for (let b = a + 1; b < profiles.length; b++) {
      const pageA = candidate(app, profiles[a][1], object, rt);
      const pageB = candidate(app, profiles[b][1], object, rt);
      if (pageA.page && pageB.page && pageA.page !== pageB.page) report.assignmentCandidates.push({ app: app.fullName, object, rt,
        profileA: key.profiles[a].alias, profileB: key.profiles[b].alias, pageA, pageB, status: 'CONFIGURATION_CANDIDATE' });
    }
  }
  // One active route representative per Profile; prefer profiles participating in differing assignments.
  const preferred = new Set(report.assignmentCandidates.flatMap((p) => [p.profileA, p.profileB]));
  const ordered = [...key.profiles].sort((a, b) => Number(preferred.has(b.alias)) - Number(preferred.has(a.alias)));
  const selected = ordered.map((p) => key.users.find((u) => u.profile === p.alias && mapped.find((m) => m.Username === u.username)?.IsActive)).filter(Boolean).slice(0, 6);
  report.inventory.selectedUsers = selected.map((u) => u.alias);
  report.inventory.profileSelectionTruncated = selected.length < profiles.length;
  report.inventory.userConnectionsAttempted = 0;
  report.inventory.userConnectionsOpened = 0;
  for (const user of selected) {
    report.inventory.userConnectionsAttempted++;
    const conn = await connect(unique.find((r) => r.salesforce_username === user.username), 'USER', user.alias);
    if (!conn) continue;
    report.inventory.userConnectionsOpened++;
    const expected = mapped.find((u) => u.Username === user.username);
    const soap = await measured(`${user.alias}:GET_USER_INFO`, 'USER', () => conn.soap.getUserInfo(),
      (v) => ({ userIdMatchesDiagnostic: v.userId === expected.Id, profileIdMatchesDiagnostic: v.profileId === expected.ProfileId }));
    const identityMatches = soap?.userId === expected.Id && soap?.profileId === expected.ProfileId;
    const api = `/services/data/v${conn.getApiVersion()}`;
    const apps = await measured(`${user.alias}:APPS`, 'USER', () => conn.request({ method: 'GET', url: `${api}/ui-api/apps?formFactor=Large` }));
    const facts = { alias: user.alias, profile: user.profile, identityMatches, apps: array(apps?.apps).map((a) => ({ developerName: a.developerName, label: a.label })), objects: [] };
    report.users.push(facts);
    for (const object of objects) {
      const info = await measured(`${user.alias}:OBJECT_INFO_${objects.indexOf(object) + 1}`, 'USER', () => conn.request({ method: 'GET', url: `${api}/ui-api/object-info/${object}` }));
      if (!info) continue;
      const available = Object.values(info.recordTypeInfos ?? {}).filter((t) => t.available);
      const objectFact = { object, createable: info.createable, fieldCount: Object.keys(info.fields ?? {}).length,
        recordTypes: available.map((t) => ({ id: t.recordTypeId, name: t.name, master: t.master, default: t.defaultRecordTypeMapping })), defaults: [] };
      facts.objects.push(objectFact);
      for (const rt of available.slice(0, 2)) {
        const defaults = await measured(`${user.alias}:CREATE_DEFAULTS_${objects.indexOf(object) + 1}_${objectFact.defaults.length + 1}`, 'USER',
          () => conn.request({ method: 'GET', url: `${api}/ui-api/record-defaults/create/${object}?recordTypeId=${encodeURIComponent(rt.recordTypeId)}&formFactor=Large` }));
        if (defaults) objectFact.defaults.push({ rt: rt.recordTypeId, layoutId: defaults.layout?.id, sectionCount: defaults.layout?.sections?.length });
      }
    }
  }
  // RecordType API IDs join USER availability to configuration DeveloperName, never labels.
  const rts = await measured('RECORD_TYPE_MAPPING', 'DIAGNOSTIC',
    () => diagnostic.query("SELECT Id, DeveloperName, SobjectType, IsActive FROM RecordType WHERE SobjectType IN ('Quote__c','Lead','Opportunity') LIMIT 201"),
    (v) => ({ count: v.records.length, done: v.done }));
  report.recordTypeMappingComplete = rts?.done === true && rts.records.length <= 200;
  for (const user of report.users) for (const obj of user.objects) for (const rt of obj.recordTypes) {
    const mappedRt = rts?.records.find((r) => r.Id === rt.id && r.SobjectType === obj.object);
    rt.fullName = rt.master ? `${obj.object}.Master` : mappedRt ? `${obj.object}.${mappedRt.DeveloperName}` : null;
  }
  for (const p of report.assignmentCandidates) {
    const a = report.users.find((u) => u.profile === p.profileA), b = report.users.find((u) => u.profile === p.profileB);
    if (!a || !b) continue;
    const rtA = a.objects.find((o) => o.object === p.object)?.recordTypes.find((t) => t.fullName === p.rt);
    const rtB = b.objects.find((o) => o.object === p.object)?.recordTypes.find((t) => t.fullName === p.rt);
    report.pairs.push({ ...p, userA: a.alias, userB: b.alias, sameAvailableRt: Boolean(rtA && rtB && rtA.id === rtB.id),
      sameAccessibleApp: [a, b].every((u) => u.apps.some((app) => app.developerName === p.app)),
      userIdentityMatches: a.identityMatches && b.identityMatches });
  }
  const appTargets = [...new Set([
    ...report.pairs.filter((p) => p.sameAccessibleApp && p.sameAvailableRt).map((p) => p.app),
    ...report.users.flatMap((u) => u.apps.map((a) => a.developerName)).filter((name) => report.apps.some((a) => a.fullName === name)),
  ])];
  report.inventory.appRefreshTruncated = appTargets.length > 8;
  for (const [index, name] of appTargets.slice(0, 8).entries()) {
    const value = await measured(`APP_READ_${index + 1}`, 'DIAGNOSTIC', () => diagnostic.metadata.read('CustomApplication', name));
    if (!value) continue;
    const app = report.apps.find((a) => a.fullName === name);
    app.actionOverrides = array(value.actionOverrides).filter((o) => objects.includes(o.pageOrSobjectType));
    app.profileActionOverrides = array(value.profileActionOverrides).filter((o) => objects.includes(o.pageOrSobjectType));
    app.freshness = 'LIVE_REREAD';
  }
  for (const p of report.pairs) {
    const app = report.apps.find((a) => a.fullName === p.app);
    p.freshness = app.freshness;
    p.pageA = candidate(app, key.profiles.find((x) => x.alias === p.profileA).name, p.object, p.rt);
    p.pageB = candidate(app, key.profiles.find((x) => x.alias === p.profileB).name, p.object, p.rt);
    p.differentCandidatePages = Boolean(p.pageA.page && p.pageB.page && p.pageA.page !== p.pageB.page);
  }
  const pages = [...new Set(report.assignmentCandidates.flatMap((p) => [p.pageA.page, p.pageB.page]).filter((p) => p !== 'STANDARD_DEFAULT'))];
  report.inventory.pageSelectionTruncated = pages.length > 8;
  for (const name of pages.slice(0, 8)) {
    const page = await measured(`PAGE_READ_${report.pages.length + 1}`, 'DIAGNOSTIC', () => diagnostic.metadata.read('FlexiPage', name));
    if (!page) continue;
    const items = array(page.flexiPageRegions).flatMap((r) => array(r.itemInstances));
    report.pages.push({ name, object: page.sobjectType, type: page.type, evidenceHash: hash(JSON.stringify(page)),
      fieldCount: items.filter((i) => i.fieldInstance).length,
      components: [...new Set(items.map((i) => i.componentInstance?.componentName).filter(Boolean))],
      sectionRuleCount: items.filter((i) => i.componentInstance?.componentName === 'flexipage:fieldSection' && i.componentInstance.visibilityRule).length });
  }
  report.golden = report.pairs.some((p) => p.sameAvailableRt && p.sameAccessibleApp && p.userIdentityMatches && p.differentCandidatePages && p.freshness === 'LIVE_REREAD')
    ? 'USER_VERIFIED_CONFIGURATION_CANDIDATE_NOT_UI_GROUND_TRUTH' : 'GOLDEN_CASE_NOT_AVAILABLE';
  report.status = 'COMPLETE_EVIDENCE_ONLY';
} catch {
  report.status = 'BLOCKED_DISCOVERY_INCOMPLETE';
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  report.elapsedMs = Math.round(performance.now() - started);
  report.cost = { logicalOperations: report.operations.length, httpAttempts: report.operations.reduce((n, o) => n + o.httpAttemptCount, 0),
    decodedJsonBytes: report.operations.reduce((n, o) => n + (o.decodedJsonBytes ?? 0), 0),
    operationElapsedMs: report.operations.reduce((n, o) => n + o.elapsedMs, 0) };
  await mkdir('.temp', { recursive: true });
  await writeFile('.temp/p8-04a-candidates.json', `${JSON.stringify(report, null, 2)}\n`);
  // Private routing references are intentionally separate from evidence; never publish this file.
  await writeFile('.temp/p8-04a-capture-key.json', `${JSON.stringify(key, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, inventory: report.inventory, golden: report.golden, cost: report.cost, elapsedMs: report.elapsedMs }));
}
