import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ControlPlaneError } from '../errors.js';
import {
  DshScenarioService,
  nextDshScenarioVersion,
  normalizeDshScenarioPayload,
  type DshScenarioActor,
} from '../dsh-scenario-service.js';
import { InMemoryControlPlaneStore } from './in-memory-store.js';

/**
 * DSH-01 domain tests.
 *
 * These exercise the one rule the whole plugin contract rests on — the server owns `version` and
 * `revision` — plus the tombstone lifecycle and the audit coupling, without an HTTP server or
 * MySQL. The HTTP surface is covered separately in the Admin API suite.
 */

const ACTOR: DshScenarioActor = Object.freeze({
  platformUserId: 'platform-1',
  crmUsername: 'crm@example.invalid',
  adminUsername: null,
});

function newService(): Readonly<{ service: DshScenarioService; store: InMemoryControlPlaneStore }> {
  const store = new InMemoryControlPlaneStore();
  return Object.freeze({ service: new DshScenarioService(store), store });
}

function createInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    scenarioId: 'lead-follow-up',
    title: '商机跟进',
    description: '标准商机跟进场景',
    scenarioPayload: { pinnedSkills: ['crm-lead-follow-up'] },
    ...overrides,
  } as Parameters<DshScenarioService['create']>[0];
}

test('DSH-01 semantic version increments only the patch segment', () => {
  assert.equal(nextDshScenarioVersion('1.0.0'), '1.0.1');
  assert.equal(nextDshScenarioVersion('1.0.9'), '1.0.10');
  assert.equal(nextDshScenarioVersion('2.3.99'), '2.3.100');
  for (const invalid of ['1.0', 'v1.0.0', '1.0.0-beta', '', '1.0.x']) {
    assert.throws(
      () => nextDshScenarioVersion(invalid),
      (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_CONTROL_PLANE_CONFIGURATION_INVALID',
      `${invalid} must be rejected`,
    );
  }
});

test('DSH-01 payload normalization forces the standard-scenario markers', () => {
  const normalized = normalizeDshScenarioPayload({
    pinnedSkills: ['a'],
    sourceType: 'LOCAL',
    readonlyForNormalUser: false,
    customField: { nested: true },
  });
  assert.equal(normalized.sourceType, 'COMPANY_STANDARD');
  assert.equal(normalized.readonlyForNormalUser, true);
  assert.deepEqual(normalized.customField, { nested: true }, 'unknown plugin fields survive');
  assert.throws(() => normalizeDshScenarioPayload([]), ControlPlaneError);
  assert.throws(() => normalizeDshScenarioPayload(null), ControlPlaneError);
  assert.throws(() => normalizeDshScenarioPayload({ blob: 'x'.repeat(300_000) }), ControlPlaneError);
});

test('DSH-01 create assigns 1.0.0 / revision 1 and every edit advances both', async () => {
  const { service, store } = newService();
  const created = await service.create(createInput(), ACTOR);
  assert.equal(created.version, '1.0.0');
  assert.equal(created.revision, 1);
  assert.equal(created.status, 'PUBLISHED');
  assert.equal(created.createdByPlatformUid, 'platform-1');
  assert.equal(created.createdByCrmUser, 'crm@example.invalid');

  // A client-supplied version/revision cannot reach the service through the create request type,
  // and even a hand-built call is overridden because the columns come from the row, not the input.
  const edited = await service.update('lead-follow-up', { description: '更新后的说明' }, ACTOR);
  assert.equal(edited.version, '1.0.1');
  assert.equal(edited.revision, 2);
  assert.equal(edited.description, '更新后的说明');
  assert.equal(edited.updatedByPlatformUid, 'platform-1');

  const editedTwice = await service.update('lead-follow-up', { title: '商机跟进（标准）' }, ACTOR);
  assert.equal(editedTwice.version, '1.0.2');
  assert.equal(editedTwice.revision, 3);

  // Re-posting an existing id is the documented upsert: it edits, it never rewinds to 1.0.0.
  const upserted = await service.create(createInput({ description: '再次提交' }), ACTOR);
  assert.equal(upserted.version, '1.0.3');
  assert.equal(upserted.revision, 4);

  const auditOperations = store.repositories.audits.search
    ? (await store.repositories.audits.search({ limit: 20, offset: 0 })).items.map((row) => row.operation)
    : [];
  assert.deepEqual(auditOperations, [
    'UPDATE_DSH_SCENARIO', 'UPDATE_DSH_SCENARIO', 'UPDATE_DSH_SCENARIO', 'CREATE_DSH_SCENARIO',
  ]);
});

test('DSH-01 attachments rebuild the metadata array and bump the version', async () => {
  const { service } = newService();
  await service.create(createInput(), ACTOR);
  const content = Buffer.from('attachment-bytes', 'utf8');
  const first = await service.addAttachment('lead-follow-up', {
    fileName: '模板.txt',
    mimeType: 'text/plain',
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
  }, ACTOR);
  assert.equal(first.scenario.version, '1.0.1');
  assert.equal(first.scenario.revision, 2);
  assert.equal(first.scenario.presetAttachments.length, 1);
  assert.equal(first.attachment.fileSize, content.length);
  assert.equal(first.attachment.downloadUrl, `/api/dsh/scenarios/lead-follow-up/attachments/${first.attachment.attachmentId}`);

  const stored = await service.getAttachment('lead-follow-up', first.attachment.attachmentId);
  assert.equal(stored?.content.toString('utf8'), 'attachment-bytes');

  // A digest that disagrees with the bytes is refused rather than silently overwritten.
  await assert.rejects(
    service.addAttachment('lead-follow-up', {
      fileName: 'other.txt', mimeType: 'text/plain', content, sha256: 'f'.repeat(64),
    }, ACTOR),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_CONTROL_PLANE_CONFIGURATION_INVALID',
  );

  const removed = await service.deleteAttachment('lead-follow-up', first.attachment.attachmentId, ACTOR);
  assert.equal(removed.version, '1.0.2');
  assert.equal(removed.revision, 3);
  assert.deepEqual(removed.presetAttachments, []);
  await assert.rejects(
    service.deleteAttachment('lead-follow-up', first.attachment.attachmentId, ACTOR),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_CONTROL_PLANE_NOT_FOUND',
  );
});

test('DSH-01 soft delete leaves a tombstone with its bytes removed and its version untouched', async () => {
  const { service } = newService();
  await service.create(createInput(), ACTOR);
  const upload = await service.addAttachment('lead-follow-up', {
    fileName: 'a.txt', mimeType: 'text/plain', content: Buffer.from('abc'),
  }, ACTOR);
  assert.equal(upload.scenario.revision, 2);

  const deleted = await service.softDelete('lead-follow-up', ACTOR);
  assert.equal(deleted.status, 'DELETED');
  assert.equal(deleted.revision, 3, 'the tombstone is a revision, not a new edition');
  assert.equal(deleted.version, '1.0.1');
  assert.deepEqual(deleted.presetAttachments, []);
  assert.equal(await service.getAttachment('lead-follow-up', upload.attachment.attachmentId), undefined);

  const published = await service.list({ includeArchived: true, includeDeleted: true });
  assert.deepEqual(published.scenarios, []);
  assert.deepEqual(published.deletedScenarioIds, ['lead-follow-up']);

  const withoutDeleted = await service.list({ includeArchived: true, includeDeleted: false });
  assert.deepEqual(withoutDeleted.deletedScenarioIds, []);

  // A tombstone is not editable: the edit path reports 404 and only an explicit POST revives it.
  await assert.rejects(
    service.update('lead-follow-up', { title: '不应生效' }, ACTOR),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_CONTROL_PLANE_NOT_FOUND',
  );

  // Re-creating a tombstoned id revives it as a published scenario with a fresh revision step.
  const revived = await service.create(createInput({ title: '重新上架' }), ACTOR);
  assert.equal(revived.status, 'PUBLISHED');
  assert.equal(revived.version, '1.0.2');
  assert.equal(revived.revision, 4);
});

test('DSH-01 archived scenarios are listed only when asked for', async () => {
  const { service } = newService();
  await service.create(createInput(), ACTOR);
  const archived = await service.setStatus('lead-follow-up', 'ARCHIVED', ACTOR);
  assert.equal(archived.status, 'ARCHIVED');
  assert.equal(archived.version, '1.0.1');

  assert.deepEqual((await service.list({ includeArchived: false, includeDeleted: true })).scenarios, []);
  assert.equal((await service.list({ includeArchived: true, includeDeleted: true })).scenarios.length, 1);
});

test('DSH-01 an Admin Console change records a reserved platform marker', async () => {
  const { service, store } = newService();
  const created = await service.create(createInput(), {
    platformUserId: null, crmUsername: null, adminUsername: 'bootstrap-admin',
  });
  assert.equal(created.createdByPlatformUid, 'admin:bootstrap-admin');
  assert.equal(created.createdByCrmUser, null);
  const audits = await store.repositories.audits.search({ limit: 5, offset: 0 });
  assert.equal(audits.items[0]?.actorAdmin, 'bootstrap-admin');
  assert.equal(audits.items[0]?.channel, 'ADMIN');
  assert.equal(audits.items[0]?.recordId, 'lead-follow-up');
});
