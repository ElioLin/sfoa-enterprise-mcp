// Offline public-fixture gate; --local also verifies ignored source hashes/names/secrets.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const file = 'docs/sfoa/evidence/p8-04a-01-2026-09-06.json';
const bytes = await readFile(file);
const fixture = JSON.parse(bytes);
assert(bytes.length < 25000, 'Public fixture exceeds 25 KB bound');
assert.equal(fixture.status, 'COMPLETE — BLOCKED');
assert.equal(fixture.invariants.productionPackageDiff, 0);
assert.equal(fixture.invariants.a02Started, false);
assert.equal(fixture.inventory.mappedUsers, fixture.inventory.distinctSalesforceUsers);
assert.equal(fixture.inventory.truncated, false);
assert(fixture.inventory.userConnectionsOpened <= 6);
assert.equal(fixture.candidateDiscovery.golden, 'GOLDEN_CASE_NOT_AVAILABLE');
assert(fixture.users.every((u) => u.identityMatches));
assert(fixture.appIdJoin.every((j) => j.durableIdMatches && j.developerNameMatches && j.namespaceQualifiedMetadataNameMatches));
assert(fixture.appComparisons.some((c) => c.status === 'APP_CONTEXT_REQUIRED' && new Set(c.candidates.map((p) => p.page)).size > 1));
for (const c of fixture.goldenCases) {
  assert.equal(c.status, 'EXPECTED CANDIDATE — NOT YET GROUND TRUTH');
  for (const k of ['expectedFormSource', 'expectedPage', 'visibleFieldsHash', 'requiredFieldsHash', 'fieldCount', 'requiredCount']) assert.equal(c[k], null);
}
assert.equal(fixture.gates.activeNewPrecedence, 'BLOCKED');
assert.equal(fixture.gates.mixedDesktop, 'NOT TESTED');
assert(fixture.pages.filter((p) => p.fieldCount > 0).every((p) => p.components.includes('force:recordDetailPanelMobile') && !p.components.includes('force:detailPanel')));
assert(fixture.newOverrides.every((o) => o.overrides.every((a) => a.type === 'Default')));
assert(fixture.fieldShapes.some((f) => f.criteria.some((c) => c.rightValueKind === 'ABSENT')));
assert(fixture.fieldShapes.some((f) => f.criteria.some((c) => c.rightValueKind === 'BOOLEAN_TEXT')));
function checkAliases(v) {
  if (Array.isArray(v)) { v.forEach(checkAliases); return; }
  if (!v || typeof v !== 'object') return;
  for (const [k, child] of Object.entries(v)) {
    if (['user', 'profile', 'object', 'rt', 'field', 'page', 'candidatePage', 'app', 'uiApp', 'metadataApp', 'leftValue', 'content', 'pageOrSobjectType', 'recordType'].includes(k) && child !== null) {
      assert(typeof child === 'string' && /^(USER|PROFILE|OBJECT|RT|FIELD|PAGE(?:_LAYOUT|_DYNAMIC)?|APP)_\d+$/u.test(child), `Non-aliased fixture property: ${k}`);
    }
    checkAliases(child);
  }
}
checkAliases(fixture);
for (const source of fixture.sources) {
  assert(/^\.temp\/p8-04a-[a-z-]+\.json$/u.test(source.localPath));
  assert(/^[a-f0-9]{64}$/u.test(source.evidenceHash));
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(git('diff', '--name-only', '8279d21', '--', 'packages'), '', 'Production packages changed');
const changed = [...new Set([
  ...git('diff', '--name-only', '8279d21').split('\n'),
  ...git('ls-files', '--others', '--exclude-standard').split('\n'),
])].filter(Boolean);
const contents = await Promise.all(changed.map(async (name) => ({ name, text: await readFile(name, 'utf8') })));
for (const { name, text } of contents) {
  assert(!/\b(?:005|00e|00D|012|00h|0PS)[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b/u.test(text), `Salesforce identity ID in ${name}`);
  assert(!/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u.test(text), `JWT-shaped value in ${name}`);
  assert(!/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/u.test(text), `Private key in ${name}`);
}
if (process.argv.includes('--local')) {
  for (const source of fixture.sources) {
    assert.equal(createHash('sha256').update(await readFile(source.localPath)).digest('hex'), source.evidenceHash, 'Local evidence hash mismatch');
    assert(git('check-ignore', source.localPath), 'Live evidence must be ignored');
  }
  const dictionary = JSON.parse(await readFile('.temp/p8-04a-aliases.json', 'utf8'));
  const key = JSON.parse(await readFile('.temp/p8-04a-capture-key.json', 'utf8'));
  const protectedNames = Object.entries(dictionary).filter(([kind]) => kind !== 'OBJECT').flatMap(([, names]) => Object.keys(names))
    .concat(key.users.map((u) => u.username));
  // Short route references can coincide with unrelated words/counts/commit hashes.
  // The public schema must have no raw identity-reference properties instead.
  assert(!/"(?:platformUserId|platform_user_id|salesforce_username|username|routeId|userId|profileId)"\s*:/u.test(bytes.toString('utf8')));
  for (const { name, text } of contents) for (const value of protectedNames.filter((s) => s.length >= 4)) {
    assert(!text.includes(value), `Live name in ${name} (value suppressed)`);
  }
  const { loadProjectEnvironment } = await import('../skills/sfoa-mcp-maintainer/scripts/shared/project.mjs');
  const env = await loadProjectEnvironment(process.cwd());
  const secrets = Object.entries(env.values).filter(([name, value]) => /TOKEN|PASSWORD|SECRET|PRIVATE_KEY|CLIENT_ID|ENCRYPTION/u.test(name) && typeof value === 'string' && value.length >= 8);
  for (const { name, text } of contents) for (const [, value] of secrets) assert(!text.includes(value), `Secret in ${name} (value suppressed)`);
}
console.log(JSON.stringify({ status: 'PASS', fixtureBytes: bytes.length, checkedFiles: contents.length,
  localEvidenceVerified: process.argv.includes('--local'), observedNewGoldenCount: 0, productionPackageDiff: 0 }));
