import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { AttachmentStagingRecord, AttachmentStagingRepository } from '@sfoa/control-plane';
import { RemoteRuntimeError } from './errors.js';

/**
 * SFOA Attachment Ingress.
 *
 * A channel (WeCom behind OpenClaw, or any future channel) hands the ingress a byte
 * stream plus the platform user it belongs to. The ingress stores the bytes under a
 * controlled root it owns, records the file facts in `sfoa_attachment_staging`, and
 * returns an opaque `att_…` reference. The Agent only ever sees that reference.
 *
 * Two boundaries are deliberate and must not be blurred:
 *
 *   - The ingress decides nothing about *acceptability*. It does not read an
 *     extension, a MIME type, or a size limit from configuration and reject on it.
 *     Salesforce is the final acceptance authority for file type and size; a mirror
 *     here would drift from it and start refusing files Salesforce would have taken.
 *   - The ingress is not a business surface. Nothing it records is a business record,
 *     and the Files objects (`ContentVersion`, `ContentDocument`,
 *     `ContentDocumentLink`) are never exposed as DML objects by anything in here.
 */
export type AttachmentIngressConfig = Readonly<{
  /** Absolute path of the controlled staging root. Every staged path lives beneath it. */
  root: string;
  /** How long a staged file stays resolvable before the reaper may delete it. */
  ttlMs: number;
  /** Hard ceiling on one staged file. Enforced while streaming, never after buffering. */
  maxFileBytes: number;
  /** How many staged files one platform user may hold at once; the oldest are evicted. */
  maxFilesPerOwner: number;
}>;

export type StagedAttachment = Readonly<{
  attachmentRef: string;
  fileName: string;
  mimeType: string | null;
  byteSize: number;
  contentSha256: string;
  expiresAt: string;
}>;

/**
 * A staged file opened for upload. The caller must close `stream`; `byteSize` and
 * `contentSha256` are re-read from the file on disk at open time, so they still
 * describe the bytes being sent even if the staging row were tampered with.
 */
export type OpenedAttachment = Readonly<{
  stream: Readable;
  fileName: string;
  mimeType: string | null;
  byteSize: number;
  contentSha256: string;
}>;

const ATTACHMENT_REF_PATTERN = /^att_[A-Za-z0-9_-]{24}$/u;
const STAGING_DIRECTORY_NAME = 'staged';
const INCOMING_PREFIX = '.incoming-';

export class AttachmentIngress {
  public constructor(
    private readonly store: AttachmentStagingRepository,
    private readonly config: AttachmentIngressConfig,
  ) {}

  public get root(): string {
    return path.resolve(this.config.root);
  }

  /**
   * Streams `body` into the controlled root and returns the opaque reference.
   *
   * The body is metered while it is written, so an oversized upload is rejected
   * without ever being held in memory, and the partially written file is removed
   * before the error escapes. The digest is computed over exactly the bytes that
   * were persisted, so `contentSha256` can never describe a different file than the
   * one on disk.
   */
  public async stage(input: {
    platformUserId: string;
    sourceChannel: string;
    runId: string | null;
    fileName: string;
    mimeType: string | null;
    body: Readable;
  }): Promise<StagedAttachment> {
    const fileName = safeFileName(input.fileName);
    await this.evictOwnerOverflow(input.platformUserId);
    const stagingRoot = path.join(this.root, STAGING_DIRECTORY_NAME);
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });

    const attachmentRef = mintAttachmentRef();
    const finalPath = this.containedPath(stagingRoot, attachmentRef);
    const incomingPath = this.containedPath(stagingRoot, `${INCOMING_PREFIX}${randomBytes(16).toString('hex')}`);
    const digest = createHash('sha256');
    let byteSize = 0;

    try {
      const meter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          byteSize += chunk.length;
          if (byteSize > this.config.maxFileBytes) {
            callback(new RemoteRuntimeError(
              'MCP_ATTACHMENT_TOO_LARGE',
              `Attachment ${fileName} exceeds the staging ceiling of ${this.config.maxFileBytes} bytes.`,
            ));
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(input.body, meter, createWriteStream(incomingPath, { flags: 'wx', mode: 0o600 }));
      if (byteSize === 0) {
        throw new RemoteRuntimeError('MCP_ATTACHMENT_INPUT_INVALID', `Attachment ${fileName} is empty.`);
      }
      // Same directory, so this rename is atomic and the final path is never a
      // partially written file, even if a reader races the writer.
      await rename(incomingPath, finalPath);
    } catch (error) {
      await rm(incomingPath, { force: true }).catch(() => undefined);
      await rm(finalPath, { force: true }).catch(() => undefined);
      if (error instanceof RemoteRuntimeError) throw error;
      throw new RemoteRuntimeError('MCP_ATTACHMENT_STAGING_FAILED', 'The attachment could not be staged.', { cause: error });
    }

    const now = Date.now();
    const expiresAt = new Date(now + this.config.ttlMs);
    const contentSha256 = digest.digest('hex');
    try {
      await this.store.create({
        attachmentRef,
        platformUserId: input.platformUserId,
        sourceChannel: input.sourceChannel,
        runId: input.runId,
        fileName,
        mimeType: input.mimeType,
        byteSize,
        contentSha256,
        stagedPath: finalPath,
        createdAt: new Date(now),
        expiresAt,
      });
    } catch (error) {
      // The row is the only way to find the file again, so a row that was never
      // written must not leave an orphan behind.
      await rm(finalPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return Object.freeze({
      attachmentRef,
      fileName,
      mimeType: input.mimeType,
      byteSize,
      contentSha256,
      expiresAt: expiresAt.toISOString(),
    });
  }

  /**
   * Resolves a reference for one requester.
   *
   * An unknown reference and another requester's reference raise the *same* error.
   * Distinguishing them would turn the ingress into an existence oracle: a caller
   * could probe references and learn which ones are real without ever owning one.
   */
  public async resolveForOwner(attachmentRef: string, platformUserId: string): Promise<AttachmentStagingRecord> {
    if (!ATTACHMENT_REF_PATTERN.test(attachmentRef)) throw notOwned();
    const record = await this.store.getByRef(attachmentRef);
    if (!record || !constantTimeEquals(record.platformUserId, platformUserId)) throw notOwned();
    if (record.state !== 'STAGED') {
      throw new RemoteRuntimeError(
        'MCP_ATTACHMENT_EXPIRED',
        `Attachment ${attachmentRef} is no longer available for upload.`,
      );
    }
    if (Date.parse(record.expiresAt) <= Date.now()) {
      throw new RemoteRuntimeError(
        'MCP_ATTACHMENT_EXPIRED',
        `Attachment ${attachmentRef} has expired and must be sent again.`,
      );
    }
    return record;
  }

  /**
   * Opens a resolved record for upload.
   *
   * Every fact is re-derived from the file on disk instead of trusting the row: the
   * row could have been edited by anyone with database access, and the path in it
   * could point anywhere on the host. Containment is therefore re-checked here, the
   * entry must be a regular file and not a symbolic link, and the size and digest
   * are recomputed from the bytes that will actually be sent.
   */
  public async openForUpload(record: AttachmentStagingRecord): Promise<OpenedAttachment> {
    const resolved = this.containedPath(path.join(this.root, STAGING_DIRECTORY_NAME), path.basename(record.stagedPath));
    const stats = await lstat(resolved).catch(() => undefined);
    if (!stats?.isFile()) {
      throw new RemoteRuntimeError(
        'MCP_ATTACHMENT_PATH_INVALID',
        `Staged attachment ${record.attachmentRef} is no longer present in the staging area.`,
      );
    }
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(resolved)) digest.update(chunk as Buffer);
    const contentSha256 = digest.digest('hex');
    if (contentSha256 !== record.contentSha256 || stats.size !== record.byteSize) {
      throw new RemoteRuntimeError(
        'MCP_ATTACHMENT_PATH_INVALID',
        `Staged attachment ${record.attachmentRef} does not match its recorded content.`,
      );
    }
    return Object.freeze({
      stream: createReadStream(resolved),
      fileName: record.fileName,
      mimeType: record.mimeType,
      byteSize: stats.size,
      contentSha256,
    });
  }

  /** Terminal success: the bytes have been published, so the staged copy is removed. */
  public async complete(record: AttachmentStagingRecord): Promise<void> {
    await this.store.markConsumed(record.id, new Date());
    await this.removeStagedFile(record);
  }

  /**
   * A known, proven failure. The staged copy is kept for a short retention so a
   * caller can retry the same reference, and the reaper removes it at `expiresAt`.
   */
  public async fail(record: AttachmentStagingRecord, failureCode: string): Promise<void> {
    await this.store.markFailed(record.id, failureCode);
  }

  /** Deletes expired staged files and marks their rows EXPIRED. Bounded by `limit`. */
  public async reapExpired(now: Date, limit: number): Promise<number> {
    const rows = await this.store.listExpired(now, limit);
    let reaped = 0;
    for (const row of rows) {
      await this.removeStagedFile(row);
      await this.store.markExpired(row.id);
      reaped += 1;
    }
    return reaped;
  }

  /**
   * Bounds one requester's footprint without waiting for the TTL. Oldest first, so a
   * user who keeps sending files never loses the newest one.
   */
  private async evictOwnerOverflow(platformUserId: string): Promise<void> {
    const staged = await this.store.listStagedByOwner(platformUserId);
    const overflow = staged.length - this.config.maxFilesPerOwner + 1;
    for (const record of staged.slice(0, Math.max(0, overflow))) {
      await this.removeStagedFile(record);
      await this.store.markExpired(record.id);
    }
  }

  private async removeStagedFile(record: AttachmentStagingRecord): Promise<void> {
    let resolved: string;
    try {
      resolved = this.containedPath(path.join(this.root, STAGING_DIRECTORY_NAME), path.basename(record.stagedPath));
    } catch {
      // A poisoned row must not let cleanup delete outside the staging root. The row
      // still transitions state; the file is simply left for an operator to inspect.
      return;
    }
    await unlink(resolved).catch(() => undefined);
  }

  /** Resolves `candidate` and refuses anything that escapes `parent`. */
  private containedPath(parent: string, candidate: string): string {
    const resolvedParent = path.resolve(parent);
    const resolved = path.resolve(resolvedParent, candidate);
    if (!resolved.startsWith(resolvedParent + path.sep)) {
      throw new RemoteRuntimeError(
        'MCP_ATTACHMENT_PATH_INVALID',
        'A staged attachment path escaped the controlled staging root.',
      );
    }
    return resolved;
  }
}

/**
 * The reference an Agent passes back. 144 random bits, URL-safe, with no structure a
 * caller could decode into a path, an owner, or a Salesforce id.
 */
function mintAttachmentRef(): string {
  return `att_${randomBytes(18).toString('base64url')}`;
}

/**
 * Reduces a channel-supplied name to a display label. The name is never used to build
 * a path — the staged path is derived from the minted reference — so this only has to
 * be safe to store and to echo back into audit and into the Salesforce multipart body.
 */
function safeFileName(value: string): string {
  const trimmed = value.trim().replace(/[\u0000-\u001f\u007f]/gu, '');
  const base = path.basename(trimmed.replace(/\\/gu, '/')).slice(0, 255).trim();
  return base.length > 0 ? base : 'attachment';
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

function notOwned(): RemoteRuntimeError {
  return new RemoteRuntimeError(
    'MCP_ATTACHMENT_NOT_OWNED',
    'The attachment reference is not available to this requester.',
  );
}

/** Re-exported so callers can validate a reference before a round trip to storage. */
export function isAttachmentRef(value: string): boolean {
  return ATTACHMENT_REF_PATTERN.test(value);
}
