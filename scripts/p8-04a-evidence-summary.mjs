// Offline allowlist projection. Never copy a live normalized metadata dump to Git.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const hash = (v) => createHash('sha256').update(v).digest('hex');
const array = (v) => v == null ? [] : Array.isArray(v) ? v : [v];
const read = async (file) => { const bytes = await readFile(file); return { value: JSON.parse(bytes), evidenceHash: hash(bytes) }; };
const seed = await read('.temp/p8-04a-feasibility.json');
const discovery = await read('.temp/p8-04a-candidates.json');
const targeted = await read('.temp/p8-04a-targeted.json');
const boundStop = await read('.temp/p8-04a-candidates-bound-stop.json');
const firstTarget = await read('.temp/p8-04a-hotfix-targeted-before-hygiene.json');
const appJoin = await read('.temp/p8-04a-app-join.json');
const appJoinInitial = await read('.temp/p8-04a-app-join-initial.json');
const key = JSON.parse(await readFile('.temp/p8-04a-capture-key.json', 'utf8'));
const d = discovery.value;
for (const j of appJoin.value.appJoins ?? []) {
  if (!j.namespaceQualifiedMetadataNameMatches) continue;
  const app = d.apps.find((a) => a.fullName === j.fullName);
  if (app) Object.assign(app, { actionOverrides: j.actionOverrides, profileActionOverrides: j.profileActionOverrides, freshness: 'LIVE_REREAD' });
}
if (d.status !== 'COMPLETE_EVIDENCE_ONLY') throw new Error('Incomplete discovery is not a closed evidence summary');
// Alias numbering is frozen in the local key, appended on later projections.
let dictionary = {};
try { dictionary = JSON.parse(await readFile('.temp/p8-04a-aliases.json', 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
function alias(kind, name) {
  if (!name) return null;
  dictionary[kind] ??= {};
  if (kind === 'FIELD') {
    const normalize = (s) => s.replace(/^\{!Record\.(.*)\}$/u, '$1').replace(/^Record\./u, '');
    const existing = Object.entries(dictionary.FIELD).find(([key]) => normalize(key) === normalize(name));
    name = normalize(name);
    if (existing) dictionary.FIELD[name] = existing[1];
  }
  dictionary[kind][name] ??= `${kind}_${Object.keys(dictionary[kind]).length + 1}`;
  return dictionary[kind][name];
}
for (const p of key.profiles) { dictionary.PROFILE ??= {}; dictionary.PROFILE[p.name] = p.alias; }
for (const app of d.apps) alias('APP', app.fullName);
for (const page of seed.value.pages) alias(page.regions.some((r) => r.items.some((i) => i.fieldInstance)) ? 'PAGE_DYNAMIC' : 'PAGE_LAYOUT', page.fullName);
function pageAlias(name) {
  if (name === 'STANDARD_DEFAULT') return name;
  return dictionary.PAGE_DYNAMIC?.[name] ?? dictionary.PAGE_LAYOUT?.[name] ?? alias('PAGE', name);
}
function pick(app, profile, object, rt) {
  if (!app) return { page: null, provenance: 'UNKNOWN_APP_METADATA_JOIN' };
  const matches = app.profileActionOverrides.filter((o) => o.actionName === 'View' && o.formFactor === 'Large'
    && o.profile === profile && o.pageOrSobjectType === object && o.recordType === rt);
  const appDefaults = app.actionOverrides.filter((o) => o.actionName === 'View' && o.formFactor === 'Large' && o.pageOrSobjectType === object);
  const orgDefaults = d.objectOverrides.find((o) => o.object === object)?.overrides.filter((o) => o.actionName === 'View' && o.formFactor === 'Large') ?? [];
  const level = matches.length ? matches : appDefaults.length ? appDefaults : orgDefaults;
  if (level.length !== 1) return { page: null, provenance: 'UNKNOWN' };
  return { page: level[0].type === 'Default' ? 'STANDARD_DEFAULT' : level[0].content,
    provenance: matches.length ? 'APP_PROFILE_RT' : appDefaults.length ? 'APP_DEFAULT' : 'OBJECT_DEFAULT' };
}
const appComparisons = [];
for (const u of d.users) for (const obj of u.objects) for (const rt of obj.recordTypes) {
  const profileName = key.profiles.find((p) => p.alias === u.profile).name;
  const candidates = u.apps.map((a) => {
    const verified = u.alias === 'USER_1' ? appJoin.value.appJoins?.find((j) => j.developerName === a.developerName && j.namespaceQualifiedMetadataNameMatches) : null;
    const app = d.apps.find((m) => m.fullName === (verified?.fullName ?? a.developerName));
    const p = pick(app, profileName, obj.object, rt.fullName);
    return { app: alias('APP', a.developerName), page: pageAlias(p.page), provenance: p.provenance, liveMetadataRead: app?.freshness === 'LIVE_REREAD' };
  });
  const knownPages = new Set(candidates.map((p) => p.page).filter(Boolean));
  appComparisons.push({ user: u.alias, object: alias('OBJECT', obj.object), rt: alias('RT', rt.fullName), candidates,
    status: knownPages.size > 1 ? 'APP_CONTEXT_REQUIRED' : 'UNRESOLVED_NEW_UI_OR_APP_JOIN',
    observedEffectiveNewUi: false });
}
// Two immediately executable manual cases, never truth-labelled from Metadata.
const captureUser = d.users.find((u) => u.alias === 'USER_1');
const captureApp = captureUser.apps.find((a) => d.apps.some((m) => m.fullName === a.developerName));
const cases = ['Quote__c', 'Opportunity'].map((object, i) => {
  const obj = captureUser.objects.find((o) => o.object === object);
  const rt = obj.recordTypes.find((r) => !r.master);
  const p = pick(d.apps.find((a) => a.fullName === captureApp.developerName), key.profiles.find((p) => p.alias === captureUser.profile).name, object, rt.fullName);
  key.cases[i] = { case: i === 0 ? 'A_PL' : 'B_DF', user: captureUser.alias, profile: captureUser.profile,
    appDeveloperName: captureApp.developerName, appLabel: captureApp.label, objectApiName: object,
    recordTypeName: rt.name, recordTypeFullName: rt.fullName, recordTypeId: rt.id, candidatePage: p.page,
    entry: 'Explicit App > Object list > New > select this Record Type', formFactor: 'Large' };
  return { case: key.cases[i].case, user: captureUser.alias, profile: captureUser.profile,
    object: alias('OBJECT', object), rt: alias('RT', rt.fullName), app: alias('APP', captureApp.developerName), formFactor: 'Large',
    candidateFormSource: i === 0 ? 'PAGE_LAYOUT' : 'DYNAMIC_FORMS', candidatePage: pageAlias(p.page),
    assignmentProvenance: p.provenance, status: 'EXPECTED CANDIDATE — NOT YET GROUND TRUTH',
    expectedFormSource: null, expectedPage: null, visibleFieldsHash: null, requiredFieldsHash: null, fieldCount: null, requiredCount: null };
});
const pageSummaries = seed.value.pages.map((p) => {
  const items = p.regions.flatMap((r) => r.items);
  const fields = items.filter((i) => i.fieldInstance).map((i) => i.fieldInstance);
  const behaviors = fields.flatMap((f) => array(f.fieldInstanceProperties).filter((v) => v.name === 'uiBehavior').map((v) => v.value));
  return { page: pageAlias(p.fullName), object: alias('OBJECT', p.sobjectType), type: p.type, regionCount: p.regions.length,
    fieldCount: fields.length, components: [...new Set(items.map((i) => i.componentInstance?.componentName).filter(Boolean))]
      .map((name) => /^(force|flexipage|runtime_sales_pathassistant|runtime_sales_activities|forceChatter|runtime_sales_lead|lst|runtime_sales_merge):/u.test(name) ? name : alias('COMPONENT', name)),
    uiBehaviorCounts: Object.fromEntries([...new Set(behaviors)].map((b) => [b, behaviors.filter((v) => v === b).length])),
    fieldRuleCount: fields.filter((f) => f.visibilityRule).length,
    sectionRuleCount: items.filter((i) => i.componentInstance?.componentName === 'flexipage:fieldSection' && i.componentInstance.visibilityRule).length,
    liveRereadHash: d.pages.find((v) => v.name === p.fullName)?.evidenceHash ?? null };
});
const fieldShapes = [];
for (const p of seed.value.pages.map((p) => targeted.value.pages.find((fresh) => fresh.fullName === p.fullName) ?? p)) for (const r of p.regions) for (const item of r.items) {
  const f = item.fieldInstance;
  if (!f?.visibilityRule) continue;
  fieldShapes.push({ page: pageAlias(p.fullName), field: alias('FIELD', f.fieldItem),
    uiBehavior: array(f.fieldInstanceProperties).find((v) => v.name === 'uiBehavior')?.value ?? null,
    criteriaShape: Array.isArray(f.visibilityRule.criteria) ? 'array' : 'object',
    booleanFilter: f.visibilityRule.booleanFilter ?? null,
    criteria: array(f.visibilityRule.criteria).map((c, index) => ({ criterionType: 'RECORD_FIELD',
      leftValue: alias('FIELD', c.leftValue), operator: c.operator, rightValueKind: item.criterionLiteralKinds?.[index] ?? 'UNAVAILABLE' })) });
}
function cost(value) { return { logicalOperations: value.operations.length,
  httpAttempts: value.operations.reduce((n, o) => n + o.httpAttemptCount, 0),
  decodedJsonBytes: value.operations.reduce((n, o) => n + (o.decodedJsonBytes ?? 0), 0),
  operationElapsedMs: value.operations.reduce((n, o) => n + o.elapsedMs, 0),
  pass: value.operations.filter((o) => o.status === 'PASS').length,
  blocked: value.operations.filter((o) => o.status === 'BLOCKED').length }; }
const costSamples = targeted.value.operations.filter((o) => o.label.startsWith('COST_')).map((o) => ({
  type: o.label.split(':')[1], target: o.label.includes(':FlexiPage:') ? pageAlias(o.evidence.fullName) : alias('APP', o.evidence.fullName),
  elapsedMs: o.elapsedMs, decodedJsonBytes: o.decodedJsonBytes, httpAttempts: o.httpAttemptCount,
  responseBodyBytes: o.responsePayloads?.map((p) => p.originalSizeBytes), status: o.status }));
const summary = {
  schema: 'P8_04A_01_HOTFIX01_DEV_SUMMARY_V1', status: 'COMPLETE — BLOCKED', sourceSha: '8279d21',
  branch: 'feature/p8-04-effective-ui-context', apiVersion: '67.0',
  policy: 'Minimal allowlisted aliased evidence; configuration candidates are not observed New UI; no business record values.',
  sources: [seed, discovery, targeted, boundStop, firstTarget, appJoin, appJoinInitial].map((s, i) => ({
    localPath: ['.temp/p8-04a-feasibility.json', '.temp/p8-04a-candidates.json', '.temp/p8-04a-targeted.json',
      '.temp/p8-04a-candidates-bound-stop.json', '.temp/p8-04a-hotfix-targeted-before-hygiene.json',
      '.temp/p8-04a-app-join.json', '.temp/p8-04a-app-join-initial.json'][i],
    evidenceHash: s.evidenceHash, generatedAt: s.value.generatedAt })),
  inventory: d.inventory,
  candidateDiscovery: { assignmentCandidateCount: d.assignmentCandidates.length, comparedProfilePairs: d.pairs.length,
    sameAvailableRtCount: d.pairs.filter((p) => p.sameAvailableRt).length,
    sameAccessibleAppCount: d.pairs.filter((p) => p.sameAccessibleApp).length,
    golden: d.golden, recordTypeIdMappingComplete: d.recordTypeMappingComplete,
    scope: 'All enabled routes mapped; one USER per Profile verified. Other same-Profile USER app/RT access remains unverified.' },
  users: d.users.map((u) => ({ user: u.alias, profile: u.profile, identityMatches: u.identityMatches,
    apps: u.apps.map((a) => alias('APP', a.developerName)), objects: u.objects.map((o) => ({ object: alias('OBJECT', o.object), createable: o.createable,
      fieldCount: o.fieldCount, availableRecordTypes: o.recordTypes.map((r) => ({ rt: alias('RT', r.fullName), master: r.master })),
      createDefaultsReadCount: o.defaults.length })) })),
  goldenCases: cases, appComparisons: appComparisons.filter((a) => a.status === 'APP_CONTEXT_REQUIRED'),
  appIdJoin: (appJoin.value.appJoins ?? []).map((j) => ({ user: 'USER_1', uiApp: alias('APP', j.developerName),
    metadataApp: alias('APP', j.fullName), durableIdMatches: j.durableIdMatches, developerNameMatches: j.developerNameMatches,
    namespaceQualifiedMetadataNameMatches: j.namespaceQualifiedMetadataNameMatches })),
  appUnknownCaseCount: appComparisons.filter((a) => a.status !== 'APP_CONTEXT_REQUIRED').length,
  pages: pageSummaries, fieldShapes,
  assignmentShape: { actionName: 'View', content: cases[1].candidatePage, formFactor: 'Large',
    pageOrSobjectType: cases[1].object, recordType: cases[1].rt, type: 'Flexipage', profile: cases[1].profile, app: cases[1].app },
  newOverrides: d.objectOverrides.map((o) => ({ object: alias('OBJECT', o.object),
    overrides: o.overrides.filter((v) => v.actionName === 'New').map((v) => ({ actionName: v.actionName, type: v.type, formFactor: v.formFactor ?? 'UNSPECIFIED' })) })),
  gates: { activeNewPrecedence: 'BLOCKED', newPageLayout: 'NOT TESTED', newDynamicForms: 'NOT TESTED',
    mandatoryGolden: 'GOLDEN_CASE_NOT_AVAILABLE', mixedDesktop: 'NOT TESTED', sectionVisibility: 'NOT TESTED', customNewPositive: 'NOT AVAILABLE' },
  costs: { priorDiscovery: cost(seed.value), inventoryBoundStop: cost(boundStop.value), discovery: { ...cost(d), elapsedMs: d.elapsedMs },
    firstTargeted: cost(firstTarget.value), finalTargeted: cost(targeted.value), finalTargetedSamples: costSamples,
    appJoinInitial: { ...cost(appJoinInitial.value), elapsedMs: appJoinInitial.value.elapsedMs },
    appJoinFinal: { ...cost(appJoin.value), elapsedMs: appJoin.value.elapsedMs } },
  storage: 'LIGHTWEIGHT_SNAPSHOT_RECOMMENDED; no implementation; A-03 correctness before B-04 storage decision',
  invariants: { productionPackageDiff: 0, newDbMigrations: 0, newMcpTools: 0, salesforceSaves: 0, a02Started: false },
};
await writeFile('.temp/p8-04a-aliases.json', `${JSON.stringify(dictionary, null, 2)}\n`);
await writeFile('.temp/p8-04a-capture-key.json', `${JSON.stringify(key, null, 2)}\n`);
await writeFile('docs/sfoa/evidence/p8-04a-01-2026-09-06.json', `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ bytes: Buffer.byteLength(JSON.stringify(summary, null, 2)) + 1, goldenCases: cases,
  appContextRequiredCases: summary.appComparisons, costs: summary.costs }));
