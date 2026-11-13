import { createHash, randomUUID } from 'node:crypto';
import {
  DSH_SCENARIO_SOURCE_TYPE,
  dshScenarioDownloadPath,
  type DshScenarioAttachmentMeta,
  type DshScenarioFileContentRecord,
  type DshScenarioStatus,
  type DshStandardScenarioRecord,
} from './contracts.js';
import { ControlPlaneError } from './errors.js';
import type { AuditRepository, DshScenarioRepository } from './repositories.js';
import type { TransactionalControlPlaneStore } from './store.js';

/**
 * DSH Standard Scenarios domain service (DSH-01).
 *
 * Everything the DSH client plugin depends on is decided here, once:
 *
 * - **Version ownership.** `version` and `revision` are server state. A client may send them and
 *   they are ignored; every accepted edit derives the next pair from the row read under a lock.
 *   `version` bumps its patch segment (`1.0.2` -> `1.0.3`), `revision` increments by one. The two
 *   always move together on an edit, so the plugin can compare either.
 * - **Standard-scenario markers.** `scenarioPayload.sourceType` is forced to `COMPANY_STANDARD`
 *   and `readonlyForNormalUser` to `true` on create and on every edit. A normal user cannot turn
 *   a published standard into a locally editable one by sending a different payload.
 * - **Soft delete.** `DELETE` writes the `DELETED` tombstone and bumps `revision` (no version
 *   bump: a tombstone is not a new edition), then removes the attachment bytes. The scenario row
 *   stays so `deletedScenarioIds` can tell the plugin what to uninstall.
 * - **Audit.** Every mutation appends one `ADMIN_ACTION` row inside the same transaction as the
 *   data change, so a scenario can never change without a durable record of who changed it.
 */

/** Bounded so a pathological payload cannot turn one scenario row into a multi-megabyte document. */
export const DSH_SCENARIO_PAYLOAD_MAX_BYTES = 262_144;
export const DSH_SCENARIO_MAX_ATTACHMENTS = 20;
export const DSH_SCENARIO_DEFAULT_CATEGORY = '通用场景';
/** MySQL `file_size` is INT UNSIGNED and the HTTP route enforces its own smaller bound first. */
export const DSH_SCENARIO_ATTACHMENT_HARD_MAX_BYTES = 33_554_432;

const VERSION_PATTERN = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/u;

export type DshScenarioActor = Readonly<{
  /** Platform user id that owns the change; `null` only for an Admin Console session. */
  platformUserId: string | null;
  /** CRM (Salesforce) username bound to that platform user, when a route exists. */
  crmUsername: string | null;
  /** Admin Console account name, when the change came from an authenticated Admin session. */
  adminUsername: string | null;
}>;

export type DshScenarioCreateRequest = Readonly<{
  scenarioId: string;
  title: string;
  category?: string;
  description: string;
  scenarioPayload: unknown;
  status?: Extract<DshScenarioStatus, 'PUBLISHED' | 'ARCHIVED'>;
}>;

export type DshScenarioUpdateRequest = Readonly<{
  title?: string;
  category?: string;
  description?: string;
  scenarioPayload?: unknown;
  status?: Extract<DshScenarioStatus, 'PUBLISHED' | 'ARCHIVED'>;
}>;

export type DshScenarioListResult = Readonly<{
  scenarios: readonly DshStandardScenarioRecord[];
  deletedScenarioIds: readonly string[];
}>;

export type DshScenarioAttachmentUpload = Readonly<{
  fileName: string;
  mimeType: string;
  content: Buffer;
  /** Optional client-computed digest; when present it must match the bytes actually received. */
  sha256?: string | null;
}>;

/**
 * `1.0.0` -> `1.0.1`. The patch segment is the only one this service ever moves: minor and major
 * are a human decision expressed once at creation time, and nothing in the plugin contract asks
 * the server to guess when a change is "minor".
 */
export function nextDshScenarioVersion(version: string): string {
  const match = VERSION_PATTERN.exec(version.trim());
  if (!match) {
    throw new ControlPlaneError(
      'MCP_CONTROL_PLANE_CONFIGURATION_INVALID',
      'The stored standard-scenario version is not a three-segment semantic version.',
    );
  }
  const patch = Number(match[3]) + 1;
  if (!Number.isSafeInteger(patch)) {
    throw new ControlPlaneError(
      'MCP_CONTROL_PLANE_CONFIGURATION_INVALID',
      'The stored standard-scenario version patch segment cannot be incremented.',
    );
  }
  return `${match[1]}.${match[2]}.${patch}`;
}

/** One normalized attachment descriptor. The download path is derived, never stored as an absolute URL. */
export function toDshAttachmentMeta(
  scenarioId: string,
  file: Readonly<{
    attachmentId: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    sha256: string;
  }>,
): DshScenarioAttachmentMeta {
  return Object.freeze({
    attachmentId: file.attachmentId,
    fileName: file.fileName,
    mimeType: file.mimeType,
    fileSize: file.fileSize,
    sha256: file.sha256,
    downloadUrl: dshScenarioDownloadPath(scenarioId, file.attachmentId),
  });
}

type StoredPayload = Record<string, unknown>;

/**
 * Re-asserts the two markers that make a scenario a *standard* scenario. The rest of the payload
 * is passed through untouched: its shape belongs to the plugin contract, and the server has no
 * business dropping fields a newer plugin understands.
 */
export function normalizeDshScenarioPayload(payload: unknown): StoredPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new ControlPlaneError('MCP_CONTROL_PLANE_CONFIGURATION_INVALID', 'scenarioPayload must be a JSON object.');
  }
  const normalized: StoredPayload = {
    ...(payload as StoredPayload),
    sourceType: DSH_SCENARIO_SOURCE_TYPE,
    readonlyForNormalUser: true,
  };
  const serializedBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
  if (serializedBytes > DSH_SCENARIO_PAYLOAD_MAX_BYTES) {
    throw new ControlPlaneError(
      'MCP_CONTROL_PLANE_CONFIGURATION_INVALID',
      `scenarioPayload exceeds ${DSH_SCENARIO_PAYLOAD_MAX_BYTES} bytes once normalized.`,
    );
  }
  return Object.freeze(normalized);
}

export class DshScenarioService {
  public constructor(private readonly store: TransactionalControlPlaneStore) {}

  /** Read path shared by the plugin sync and the Admin Console list. */
  public async list(options: Readonly<{ includeArchived: boolean; includeDeleted: boolean }>): Promise<DshScenarioListResult> {
    const [scenarios, deletedScenarioIds] = await Promise.all([
      this.store.repositories.dshScenarios.listVisible(options.includeArchived),
      options.includeDeleted
        ? this.store.repositories.dshScenarios.listDeletedIds()
        : Promise.resolve<readonly string[]>([]),
    ]);
    return Object.freeze({
      scenarios,
      deletedScenarioIds: Object.freeze([...deletedScenarioIds]),
    });
  }

  public async get(scenarioId: string): Promise<DshStandardScenarioRecord | undefined> {
    return this.store.repositories.dshScenarios.getById(scenarioId);
  }

  /**
   * `POST /api/dsh/scenarios`. A first write creates `1.0.0` / revision 1; a second write for an
   * existing `scenarioId` delegates to the edit path, so a retried create can never rewind a
   * scenario that already advanced.
   */
  public async create(input: DshScenarioCreateRequest, actor: DshScenarioActor): Promise<DshStandardScenarioRecord> {
    const payload = normalizeDshScenarioPayload(input.scenarioPayload);
    const ownerUid = actor.platformUserId ?? this.platformUserForAdmin(actor);
    return this.store.transaction(async (repositories) => {
      const existing = await repositories.dshScenarios.getByIdForUpdate(input.scenarioId);
      if (existing) {
        const updated = await this.applyEdit(repositories.dshScenarios, existing, {
          title: input.title,
          category: input.category,
          description: input.description,
          scenarioPayload: payload,
          status: input.status,
        }, ownerUid);
        await appendDshAudit(repositories, actor, 'UPDATE_DSH_SCENARIO', updated, {
          upsertedExisting: true,
        });
        return updated;
      }
      const created = await repositories.dshScenarios.insert({
        scenarioId: input.scenarioId,
        title: input.title,
        category: input.category ?? DSH_SCENARIO_DEFAULT_CATEGORY,
        description: input.description,
        version: '1.0.0',
        revision: 1,
        scenarioPayload: payload,
        presetAttachments: Object.freeze([]),
        status: input.status ?? 'PUBLISHED',
        createdByPlatformUid: ownerUid,
        createdByCrmUser: actor.crmUsername,
        updatedByPlatformUid: ownerUid,
      });
      await appendDshAudit(repositories, actor, 'CREATE_DSH_SCENARIO', created, {});
      return created;
    });
  }

  /**
   * `PUT /api/dsh/scenarios/:scenarioId`. Patch semantics for the mutable fields; the version pair
   * is always advanced by exactly one step, whatever the client sent.
   */
  public async update(
    scenarioId: string,
    input: DshScenarioUpdateRequest,
    actor: DshScenarioActor,
  ): Promise<DshStandardScenarioRecord> {
    const payload = input.scenarioPayload === undefined ? undefined : normalizeDshScenarioPayload(input.scenarioPayload);
    const ownerUid = actor.platformUserId ?? this.platformUserForAdmin(actor);
    return this.store.transaction(async (repositories) => {
      const current = await repositories.dshScenarios.getByIdForUpdate(scenarioId);
      // A tombstone is not editable: an operator who wants it back re-publishes it through POST,
      // which is the documented upsert. Reporting 404 keeps `PUT` from silently resurrecting a
      // scenario every client has already uninstalled.
      if (!current || current.status === 'DELETED') {
        throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', 'Standard scenario was not found.');
      }
      const updated = await this.applyEdit(repositories.dshScenarios, current, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(payload === undefined ? {} : { scenarioPayload: payload }),
        ...(input.status === undefined ? {} : { status: input.status }),
      }, ownerUid);
      await appendDshAudit(repositories, actor, 'UPDATE_DSH_SCENARIO', updated, {});
      return updated;
    });
  }

  /** Admin Console publish/archive toggle. Both directions are a metadata edit, so both bump. */
  public async setStatus(
    scenarioId: string,
    status: Extract<DshScenarioStatus, 'PUBLISHED' | 'ARCHIVED'>,
    actor: DshScenarioActor,
  ): Promise<DshStandardScenarioRecord> {
    return this.update(scenarioId, { status }, actor);
  }

  /**
   * `DELETE /api/dsh/scenarios/:scenarioId`. The row becomes a tombstone (`DELETED`, revision + 1)
   * and the attachment bytes are removed; the version is left at the last published edition
   * because a tombstone is not a new one.
   */
  public async softDelete(scenarioId: string, actor: DshScenarioActor): Promise<DshStandardScenarioRecord> {
    const ownerUid = actor.platformUserId ?? this.platformUserForAdmin(actor);
    return this.store.transaction(async (repositories) => {
      const current = await repositories.dshScenarios.getByIdForUpdate(scenarioId);
      if (!current) throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', 'Standard scenario was not found.');
      const deletedFiles = await repositories.dshScenarios.deleteFilesForScenario(scenarioId);
      const deleted = await repositories.dshScenarios.update(scenarioId, {
        title: current.title,
        category: current.category,
        description: current.description,
        version: current.version,
        revision: current.revision + 1,
        scenarioPayload: current.scenarioPayload,
        presetAttachments: Object.freeze([]),
        status: 'DELETED',
        updatedByPlatformUid: ownerUid,
      });
      await appendDshAudit(repositories, actor, 'DELETE_DSH_SCENARIO', deleted, { deletedFiles });
      return deleted;
    });
  }

  /**
   * Uploads one preset attachment. The digest is computed from the bytes this process received,
   * so the stored `sha256` is evidence about the stored blob rather than a client claim; a
   * supplied digest that disagrees is rejected instead of silently overwritten.
   */
  public async addAttachment(
    scenarioId: string,
    upload: DshScenarioAttachmentUpload,
    actor: DshScenarioActor,
  ): Promise<Readonly<{ scenario: DshStandardScenarioRecord; attachment: DshScenarioAttachmentMeta }>> {
    const sha256 = createHash('sha256').update(upload.content).digest('hex');
    if (upload.sha256 && upload.sha256.toLowerCase() !== sha256) {
      throw new ControlPlaneError(
        'MCP_CONTROL_PLANE_CONFIGURATION_INVALID',
        'The supplied sha256 does not match the received file bytes.',
      );
    }
    if (upload.content.length === 0) {
      throw new ControlPlaneError('MCP_CONTROL_PLANE_CONFIGURATION_INVALID', 'A preset attachment must not be empty.');
    }
    if (upload.content.length > DSH_SCENARIO_ATTACHMENT_HARD_MAX_BYTES) {
      throw new ControlPlaneError(
        'MCP_CONTROL_PLANE_CONFIGURATION_INVALID',
        `A preset attachment must not exceed ${DSH_SCENARIO_ATTACHMENT_HARD_MAX_BYTES} bytes.`,
      );
    }
    const ownerUid = actor.platformUserId ?? this.platformUserForAdmin(actor);
    return this.store.transaction(async (repositories) => {
      const current = await repositories.dshScenarios.getByIdForUpdate(scenarioId);
      if (!current) throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', 'Standard scenario was not found.');
      if (current.status === 'DELETED') {
        throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', 'Standard scenario was deleted and cannot accept attachments.');
      }
      const existingFiles = await repositories.dshScenarios.listFiles(scenarioId);
      if (existingFiles.length >= DSH_SCENARIO_MAX_ATTACHMENTS) {
        throw new ControlPlaneError(
          'MCP_CONTROL_PLANE_CONFIGURATION_INVALID',
          `A standard scenario accepts at most ${DSH_SCENARIO_MAX_ATTACHMENTS} preset attachments.`,
        );
      }
      const stored = await repositories.dshScenarios.insertFile({
        attachmentId: `att_${randomUUID().replaceAll('-', '')}`,
        scenarioId,
        fileName: upload.fileName,
        mimeType: upload.mimeType,
        fileSize: upload.content.length,
        sha256,
        content: upload.content,
      });
      // Rebuilt from the file table rather than appended to the stored array: the table is the
      // authority, so a previously corrupted metadata entry is repaired by the next upload.
      const attachments = (await repositories.dshScenarios.listFiles(scenarioId))
        .map((file) => toDshAttachmentMeta(scenarioId, file));
      const updated = await repositories.dshScenarios.update(scenarioId, {
        title: current.title,
        category: current.category,
        description: current.description,
        version: nextDshScenarioVersion(current.version),
        revision: current.revision + 1,
        scenarioPayload: current.scenarioPayload,
        presetAttachments: Object.freeze(attachments),
        status: current.status,
        updatedByPlatformUid: ownerUid,
      });
      await appendDshAudit(repositories, actor, 'ADD_DSH_SCENARIO_ATTACHMENT', updated, {
        attachmentId: stored.attachmentId,
        fileName: stored.fileName,
        fileSize: stored.fileSize,
        sha256: stored.sha256,
      });
      const attachment = attachments.find((entry) => entry.attachmentId === stored.attachmentId);
      return Object.freeze({ scenario: updated, attachment: attachment as DshScenarioAttachmentMeta });
    });
  }

  public async deleteAttachment(
    scenarioId: string,
    attachmentId: string,
    actor: DshScenarioActor,
  ): Promise<DshStandardScenarioRecord> {
    const ownerUid = actor.platformUserId ?? this.platformUserForAdmin(actor);
    return this.store.transaction(async (repositories) => {
      const current = await repositories.dshScenarios.getByIdForUpdate(scenarioId);
      if (!current) throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', 'Standard scenario was not found.');
      const removed = await repositories.dshScenarios.deleteFile(scenarioId, attachmentId);
      if (!removed) throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', 'Preset attachment was not found.');
      const attachments = (await repositories.dshScenarios.listFiles(scenarioId))
        .map((file) => toDshAttachmentMeta(scenarioId, file));
      const updated = await repositories.dshScenarios.update(scenarioId, {
        title: current.title,
        category: current.category,
        description: current.description,
        version: nextDshScenarioVersion(current.version),
        revision: current.revision + 1,
        scenarioPayload: current.scenarioPayload,
        presetAttachments: Object.freeze(attachments),
        status: current.status,
        updatedByPlatformUid: ownerUid,
      });
      await appendDshAudit(repositories, actor, 'DELETE_DSH_SCENARIO_ATTACHMENT', updated, { attachmentId });
      return updated;
    });
  }

  public async getAttachment(scenarioId: string, attachmentId: string): Promise<DshScenarioFileContentRecord | undefined> {
    return this.store.repositories.dshScenarios.getFile(scenarioId, attachmentId);
  }

  /**
   * An Admin Console session has no platform user of its own, but `created_by_platform_uid` is
   * NOT NULL in the published contract. The change is attributed to the reserved `admin:<account>`
   * marker rather than to a guessed platform identity: it is visibly not a routable platform user
   * and can never be mistaken for the person the Admin account belongs to.
   */
  private platformUserForAdmin(actor: DshScenarioActor): string {
    if (!actor.adminUsername) {
      throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', 'A standard-scenario change requires a platform user or an Admin account.');
    }
    return `admin:${actor.adminUsername}`.slice(0, 128);
  }

  private async applyEdit(
    repository: DshScenarioRepository,
    current: DshStandardScenarioRecord,
    changes: Readonly<{
      title?: string;
      category?: string;
      description?: string;
      scenarioPayload?: unknown;
      status?: Extract<DshScenarioStatus, 'PUBLISHED' | 'ARCHIVED'>;
    }>,
    ownerUid: string,
  ): Promise<DshStandardScenarioRecord> {
    return repository.update(current.scenarioId, {
      title: changes.title ?? current.title,
      category: changes.category ?? current.category,
      description: changes.description ?? current.description,
      version: nextDshScenarioVersion(current.version),
      revision: current.revision + 1,
      scenarioPayload: changes.scenarioPayload ?? current.scenarioPayload,
      presetAttachments: current.presetAttachments,
      // A tombstone only comes back through an explicit re-publish, never through an edit.
      status: current.status === 'DELETED' ? 'PUBLISHED' : changes.status ?? current.status,
      updatedByPlatformUid: ownerUid,
    });
  }
}

async function appendDshAudit(
  repositories: Readonly<{ audits: AuditRepository }>,
  actor: DshScenarioActor,
  operation: string,
  scenario: DshStandardScenarioRecord,
  summary: Readonly<Record<string, unknown>>,
): Promise<void> {
  try {
    await repositories.audits.append({
      occurredAt: new Date(),
      correlationId: randomUUID(),
      channel: 'ADMIN',
      actorAdmin: dshAuditActor(actor),
      ...(actor.platformUserId ? { platformUserId: actor.platformUserId } : {}),
      ...(actor.crmUsername ? { salesforceUsername: actor.crmUsername } : {}),
      operation,
      recordId: scenario.scenarioId,
      result: 'PASS',
      outcome: 'SUCCESS',
      requestSummary: {
        scenarioId: scenario.scenarioId,
        title: scenario.title,
        status: scenario.status,
        version: scenario.version,
        revision: scenario.revision,
        ...summary,
      },
    });
  } catch (error) {
    throw new ControlPlaneError(
      'MCP_ADMIN_AUDIT_FAILED',
      'The standard-scenario change was rolled back because its audit record could not be persisted.',
      { cause: error },
    );
  }
}

/** `actorAdmin` is VARCHAR(128); a plugin actor is recorded as `dsh:<platformUserId>`. */
function dshAuditActor(actor: DshScenarioActor): string {
  return (actor.adminUsername ?? `dsh:${actor.platformUserId ?? 'unknown'}`).slice(0, 128);
}
