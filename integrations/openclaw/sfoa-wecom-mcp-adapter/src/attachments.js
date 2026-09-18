/**
 * Inbound attachment bridge decisions for the SFOA Attachment Ingress.
 *
 * This is the inbound half of the Attachment Bridge. OpenClaw has already
 * received and locally staged the files a WeCom user sent; this module decides
 * which of those staged facts may be forwarded to the SFOA runtime, builds the
 * request that carries them, and remembers the opaque `att_…` references the
 * runtime returns so the *next* prompt build for that conversation can hand
 * them to the model.
 *
 * What it deliberately never does:
 *   - It never reads file bytes into a string, a buffer, or a base64 blob. The
 *     body is a stream handed straight to `fetch`; the model never sees a file.
 *   - It never derives a path from anything the user, the model, or a tool
 *     argument said. The only accepted paths are the ones OpenClaw itself
 *     stamped into the media facts, and they must sit below a configured
 *     staging root.
 *   - It never fetches a URL. A media fact that carries only a `url` describes
 *     bytes that are not on this host, and forwarding that URL would both turn
 *     the runtime into an SSRF client and violate the "no arbitrary URL" rule.
 *   - It never applies a file-type, extension, or size policy. Salesforce is
 *     the final authority on what it accepts; the only local ceiling is the
 *     runtime's own staging ceiling, which the runtime enforces itself.
 *
 * The module is free of OpenClaw imports so the decisions can be unit-tested
 * without a running Gateway, mirroring `resolver.js`.
 */

import path from "node:path";
import { normalizeRequesterId } from "./resolver.js";

/** Source channel label recorded by the ingress for audit. */
export const SFOA_ATTACHMENT_SOURCE_CHANNEL = "WECOM";

/** Ingress endpoint path, relative to the origin the MCP endpoint already uses. */
export const ATTACHMENT_INGRESS_PATH = "/attachments";

/** OpenClaw's inbound media staging root, below the workspace. */
export const DEFAULT_WORKSPACE_ROOT = "/data/openclaw/workspace";
export const DEFAULT_STAGED_MEDIA_ROOT = "/data/openclaw/workspace/media/inbound";

/**
 * The channel's own inbound media directory, outside the workspace.
 *
 * There are two ways a file reaches the host, and they stage to different
 * places. Media the host fetched from a provider URL is copied below the
 * workspace (that is `DEFAULT_STAGED_MEDIA_ROOT`, and its files carry the
 * `input-` prefix). A channel that has already downloaded the file itself —
 * WeCom agent mode does, for every file and image the robot receives — reports
 * the fact with the path in the channel's own media directory instead. The
 * sandbox may still make its own workspace copy for the model to read; that copy
 * is a different file at a different path, and it is not the one the
 * `message_received` hook reports.
 *
 * Both are directories only OpenClaw writes to, and a fact path is still
 * accepted only when it is strictly below one of them.
 */
export const DEFAULT_CHANNEL_MEDIA_ROOT = "/data/openclaw/state/media/inbound";

/** Every directory a staged inbound media fact may sit below. */
export const DEFAULT_STAGED_MEDIA_ROOTS = Object.freeze([
  DEFAULT_STAGED_MEDIA_ROOT,
  DEFAULT_CHANNEL_MEDIA_ROOT,
]);

/**
 * Matches `MAX_ATTACHMENTS_PER_CALL` in the SFOA runtime: staging more files
 * than one Tool call can carry would produce references the model cannot use.
 */
export const MAX_INBOUND_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * How long a staged reference stays deliverable. This is an infrastructure
 * lifetime, not a Salesforce rule: the runtime owns the real `att_…` TTL and
 * answers with a stable expired-reference error when it has passed. The value
 * is deliberately short because a reference is only meaningful for the turn
 * that received the file.
 */
export const ATTACHMENT_REF_TTL_MS = 300_000;

/** Upper bound on conversations holding undelivered references. */
const MAX_TRACKED_SESSIONS = 512;

/** Ingress header names; mirrored from the runtime's ingress route. */
const FILE_NAME_HEADER = "x-sfoa-file-name";
const FILE_MIME_HEADER = "x-sfoa-file-mime";
const SOURCE_CHANNEL_HEADER = "x-sfoa-source-channel";
const EXTERNAL_RUN_ID_HEADER = "x-external-run-id";

/**
 * The ingress rejects a percent-encoded name longer than 512 characters, and
 * percent-encoding can triple a name's length, so the encoded form is kept
 * comfortably below that.
 */
const MAX_ENCODED_FILE_NAME_LENGTH = 480;

/**
 * A syntactically well-formed media type. This mirrors the ingress' own safety
 * check because a malformed value would corrupt the Salesforce multipart part
 * header; it is not an acceptance rule. An absent or unrecognised type is
 * simply omitted and Salesforce decides from the file itself.
 */
const MIME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/u;

/**
 * A path with an explicit scheme (`file:`, `http://`, …) is never a local path.
 * A Windows drive prefix is not matched: a single letter followed by `:` is a
 * path, and containment below the staging root is what actually decides.
 */
const SCHEME_PATTERN = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|file:)/iu;

/**
 * The staging identity OpenClaw appends to a file it saved, as `---<identity>`.
 *
 * `staged-inputs` uses either a sha256 hex digest or a v4 UUID, lower-case, and
 * always immediately before the extension (or at the end of the name). It names
 * the staging slot, not the user's file, so it is dropped from the label the
 * ingress records — otherwise every file in the CRM carries a UUID.
 */
const STAGED_IDENTITY_SUFFIX_PATTERN =
  /---(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})(?=\.[A-Za-z0-9]{1,16}$|$)/u;

/** Longest rejected-path directory echoed into a log line. */
const MAX_LOGGED_DIRECTORY_LENGTH = 200;

/**
 * Derives the Attachment Ingress URL from the MCP endpoint the adapter already
 * trusts, so there is no second host to configure and no way for a deployment
 * to point uploads at an attacker-chosen origin.
 *
 * @param {unknown} mcpUrl Loopback MCP endpoint, e.g. `http://127.0.0.1:8080/mcp`.
 * @param {unknown} ingressPath Endpoint path, e.g. `/attachments`.
 * @returns {string | undefined} Absolute ingress URL, or `undefined` to disable.
 */
export function resolveIngressUrl(mcpUrl, ingressPath = ATTACHMENT_INGRESS_PATH) {
  if (typeof mcpUrl !== "string" || mcpUrl.trim().length === 0) return undefined;
  if (typeof ingressPath !== "string" || !ingressPath.startsWith("/")) return undefined;

  let base;
  try {
    base = new URL(mcpUrl.trim());
  } catch {
    return undefined;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return undefined;

  return new URL(ingressPath, base.origin).toString();
}

/**
 * Resolves one staged media fact's path to an absolute path below the staging
 * root, or `undefined` when the path is unusable.
 *
 * An absolute path is accepted only when it sits below one of the configured
 * media roots. A relative path is resolved against `workspaceRoot` first, which
 * is how OpenClaw itself interprets a relative media path. `..` segments are
 * normalized away before the containment check, so a traversal attempt lands
 * outside the roots and is refused rather than read.
 *
 * @param {unknown} rawPath
 * @param {{ workspaceRoot?: unknown, mediaRoot?: unknown, mediaRoots?: unknown }} [options]
 * @returns {string | undefined}
 */
export function resolveStagedMediaPath(rawPath, options = {}) {
  if (typeof rawPath !== "string") return undefined;
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) return undefined;
  // A URL — `file://`, `http://`, or anything else with a scheme — names bytes
  // this host may not own, and following it is exactly the SSRF shape the
  // Attachment Tool refuses. Only a filesystem path is accepted.
  if (SCHEME_PATTERN.test(trimmed)) return undefined;

  const workspaceRoot = normalizeRoot(options.workspaceRoot, DEFAULT_WORKSPACE_ROOT);
  if (workspaceRoot === undefined) return undefined;
  const mediaRoots = normalizeStagedMediaRoots(options);
  if (mediaRoots.length === 0) return undefined;

  const candidate = path.resolve(workspaceRoot, trimmed);
  return mediaRoots.some((mediaRoot) => isBelow(candidate, mediaRoot)) ? candidate : undefined;
}

/**
 * Normalizes the configured staging roots into a deduplicated list of absolute
 * directories.
 *
 * An explicit configuration replaces the defaults entirely — a deployment that
 * names its own roots gets exactly those, so widening the defaults can never
 * quietly widen a locked-down deployment. A configured entry that is not an
 * absolute path (or names `/`) is dropped rather than silently replaced by a
 * default: with every entry dropped the list is empty and nothing is forwarded,
 * which is the fail-closed direction, and the adapter logs that state.
 *
 * "Configured" means the key was present, even when it contributed no usable
 * root. Falling back to the defaults in that case would turn a deployment that
 * locked its roots down to nothing into one that accepts the standard paths.
 *
 * @param {{ mediaRoot?: unknown, mediaRoots?: unknown }} [options]
 *        `mediaRoot` is the pre-roots single-root spelling; it is still honored.
 * @returns {ReadonlyArray<string>}
 */
export function normalizeStagedMediaRoots(options = {}) {
  const configured = [];
  let isConfigured = false;
  if (options.mediaRoots !== undefined) {
    isConfigured = true;
    if (Array.isArray(options.mediaRoots)) configured.push(...options.mediaRoots);
    else configured.push(options.mediaRoots);
  }
  if (options.mediaRoot !== undefined) {
    isConfigured = true;
    configured.push(options.mediaRoot);
  }

  const source = isConfigured ? configured : DEFAULT_STAGED_MEDIA_ROOTS;

  const roots = [];
  for (const value of source) {
    const root = normalizeRoot(value, undefined);
    if (root !== undefined && !roots.includes(root)) roots.push(root);
  }
  return Object.freeze(roots);
}

/**
 * Selects the media facts that may be forwarded to the ingress.
 *
 * Fail-closed at every step: while local staging is pending the facts describe
 * provider-side attachments that are not readable here, and a fact carrying
 * only a `url` is not local at all. Neither is forwarded, because forwarding
 * would mean guessing at bytes this host does not have.
 *
 * @param {{ media?: unknown, mediaStagingPending?: unknown }} event
 * @param {{ workspaceRoot?: unknown, mediaRoot?: unknown, mediaRoots?: unknown, maxFiles?: number }} [options]
 * @returns {{ files: ReadonlyArray<{ filePath: string, fileName: string, mimeType?: string }>, withheld?: string, withheldDirectory?: string }}
 */
export function selectInboundMedia(event, options = {}) {
  if (!event || typeof event !== "object") return { files: [] };
  if (event.mediaStagingPending === true) return { files: [], withheld: "MEDIA_STAGING_PENDING" };

  const facts = Array.isArray(event.media) ? event.media : [];
  if (facts.length === 0) return { files: [] };

  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0
    ? options.maxFiles
    : MAX_INBOUND_ATTACHMENTS_PER_MESSAGE;

  // Resolved once for the whole message so every fact is judged against the
  // same roots, and so a misconfigured root list is visible to the caller.
  const mediaRoots = normalizeStagedMediaRoots(options);

  const files = [];
  let withheld;
  let withheldDirectory;
  for (const fact of facts) {
    if (files.length >= maxFiles) {
      withheld = withheld ?? "MEDIA_LIMIT_EXCEEDED";
      break;
    }
    const filePath = resolveStagedMediaPath(fact?.path, { ...options, mediaRoots });
    if (filePath === undefined) {
      // Distinguish "not local" from "unusable path" for the operator, but treat
      // both the same way: the fact is not forwarded.
      withheld = withheld ?? (typeof fact?.path === "string" ? "MEDIA_PATH_REJECTED" : "MEDIA_NOT_LOCAL");
      // Where the rejected path pointed, so an operator can see which staging
      // root produced it. A directory is host infrastructure; the file name —
      // the user's own document title — is deliberately not included.
      if (withheldDirectory === undefined && typeof fact?.path === "string") {
        const directory = path.dirname(fact.path.trim());
        if (directory.length > 0 && directory !== ".") {
          withheldDirectory = directory.slice(0, MAX_LOGGED_DIRECTORY_LENGTH);
        }
      }
      continue;
    }
    const fileName = stagedFileName(filePath);
    if (fileName === undefined) {
      withheld = withheld ?? "MEDIA_PATH_REJECTED";
      continue;
    }
    const mimeType = normalizeMimeType(fact?.contentType);
    files.push(mimeType === undefined ? { filePath, fileName } : { filePath, fileName, mimeType });
  }

  if (withheld === undefined) return { files };
  return withheldDirectory === undefined
    ? { files, withheld }
    : { files, withheld, withheldDirectory };
}

/**
 * Recovers a display file name from a staged path.
 *
 * OpenClaw may stage an inbound file as `input-<name>` inside a per-message
 * directory (the workspace convention) or save it under the channel's own media
 * directory as `<name>---<identity>`; both the prefix and the identity suffix
 * are staging artifacts, so both are removed. Nothing here is trusted for
 * safety — the result is a label in a header, never a path component.
 *
 * @param {string} filePath
 * @returns {string | undefined}
 */
export function stagedFileName(filePath) {
  const base = path.basename(filePath);
  if (base.length === 0 || base === "." || base === "..") return undefined;
  let name = base.startsWith("input-") ? base.slice("input-".length).trim() : base;
  if (name.length === 0) name = base;
  const withoutIdentity = name.replace(STAGED_IDENTITY_SUFFIX_PATTERN, "").trim();
  if (withoutIdentity.length > 0) name = withoutIdentity;
  return name.length > 0 ? name : undefined;
}

/**
 * Keeps a media type only when it is well-formed, so the value can be carried
 * through a header into a multipart part without injecting anything.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeMimeType(value) {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().slice(0, 128);
  return MIME_PATTERN.test(candidate) ? candidate : undefined;
}

/**
 * Builds the ingress request for one staged file, or `null` to withhold it.
 *
 * The body is a stream produced by the caller, so no path and no byte ever
 * reaches this decision. Fail-closed: every missing precondition yields `null`
 * and the file is simply not sent.
 *
 * @param {object} params
 * @param {string | undefined} params.url Ingress URL from {@link resolveIngressUrl}.
 * @param {string | undefined} params.token Resolved SFOA WeCom channel credential.
 * @param {unknown} params.requesterId Trusted WeCom sender id for this run.
 * @param {string | undefined} [params.runId] OpenClaw run id, for correlation.
 * @param {string} [params.sourceChannel]
 * @param {{ filePath: string, fileName: string, mimeType?: string }} params.file
 * @param {number | undefined} [params.byteSize] Exact size, when the caller knows it.
 * @returns {{ url: string, headers: Record<string, string> } | null}
 */
export function buildIngressRequest(params) {
  const file = params?.file;
  if (!file || typeof file !== "object") return null;

  const url = typeof params.url === "string" ? params.url.trim() : "";
  if (url.length === 0) return null;

  const token = typeof params.token === "string" ? params.token.trim() : "";
  if (token.length === 0) return null;

  const requesterId = normalizeRequesterId(params.requesterId);
  if (requesterId === undefined) return null;

  if (typeof file.filePath !== "string" || file.filePath.length === 0) return null;
  if (typeof file.fileName !== "string" || file.fileName.trim().length === 0) return null;

  const headers = {
    // Channel credential: identifies the client, never the end user.
    Authorization: `Bearer ${token}`,
    // Identity context: the same trusted WeCom sender the MCP connection is
    // bound to, so the staged file is attributed to the requester who sent it
    // and to nobody else.
    "X-WeCom-User-Id": requesterId,
    "Content-Type": "application/octet-stream",
    [FILE_NAME_HEADER]: encodeFileName(file.fileName),
    [SOURCE_CHANNEL_HEADER]: normalizeSourceChannel(params.sourceChannel),
  };

  const mimeType = normalizeMimeType(file.mimeType);
  if (mimeType !== undefined) headers[FILE_MIME_HEADER] = mimeType;

  if (Number.isInteger(params.byteSize) && params.byteSize > 0) {
    headers["Content-Length"] = String(params.byteSize);
  }

  const runId = normalizeRunId(params.runId);
  if (runId !== undefined) headers[EXTERNAL_RUN_ID_HEADER] = runId;

  return { url, headers };
}

/**
 * Percent-encodes a file name for the metadata header, shrinking an over-long
 * name until the encoded form fits the ingress limit. The extension is kept
 * where possible so the logged label stays readable.
 *
 * @param {string} name
 * @returns {string}
 */
function encodeFileName(name) {
  let candidate = name;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const encoded = encodeURIComponent(candidate);
    if (encoded.length <= MAX_ENCODED_FILE_NAME_LENGTH) return encoded;

    const dot = candidate.lastIndexOf(".");
    const extension = dot > 0 ? candidate.slice(dot) : "";
    const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
    const keep = Math.max(1, Math.floor(stem.length * (MAX_ENCODED_FILE_NAME_LENGTH / encoded.length)) - 1);
    const next = stem.slice(0, keep) + extension;
    if (next === candidate) break;
    candidate = next;
  }
  return encodeURIComponent(candidate.slice(0, 64));
}

/** @param {unknown} value */
function normalizeSourceChannel(value) {
  if (typeof value !== "string") return SFOA_ATTACHMENT_SOURCE_CHANNEL;
  const candidate = value.trim().slice(0, 64);
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(candidate) ? candidate : SFOA_ATTACHMENT_SOURCE_CHANNEL;
}

/** @param {unknown} value */
function normalizeRunId(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, 128);
  if (trimmed.length === 0) return undefined;
  for (let index = 0; index < trimmed.length; index += 1) {
    if (trimmed.charCodeAt(index) <= 0x20 || trimmed.charCodeAt(index) === 0x7f) return undefined;
  }
  return trimmed;
}

/**
 * @param {unknown} value
 * @param {unknown} fallback
 * @returns {string | undefined} Absolute, normalized root, or `undefined`.
 */
function normalizeRoot(value, fallback) {
  const raw = usableRootText(value) ?? usableRootText(fallback);
  if (raw === undefined) return undefined;
  if (!path.isAbsolute(raw)) return undefined;
  const normalized = path.resolve(raw);
  return normalized === path.parse(normalized).root ? undefined : normalized;
}

/**
 * The root's own text, or `undefined` when the value is not a non-blank string.
 * Kept separate so a malformed entry is dropped rather than reaching
 * `path.isAbsolute`, which throws on anything that is not a string.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function usableRootText(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * @param {string} candidate Absolute, normalized path.
 * @param {string} root Absolute, normalized root.
 */
function isBelow(candidate, root) {
  return candidate.startsWith(root + path.sep);
}

/**
 * Remembers the `att_…` references staged for a conversation until the prompt
 * for that conversation is built.
 *
 * Keyed by the canonical session key, not by run: OpenClaw may build a prompt
 * more than once for one turn (retry, compaction, multi-payload reply), and a
 * reference that vanished after the first build would silently drop the file.
 * A new inbound message for the same conversation replaces the previous batch,
 * because those references belonged to the message the user has moved on from,
 * and every entry expires on its own.
 *
 * Read is non-consuming on purpose: the runtime already consumes a reference
 * exactly once, so re-offering the same reference cannot upload a file twice —
 * the second attempt is refused by the runtime, not by this cache.
 *
 * @param {{ ttlMs?: number, maxSessions?: number, now?: () => number }} [options]
 */
export function createStagedAttachmentRegistry(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : ATTACHMENT_REF_TTL_MS;
  const maxSessions = Number.isInteger(options.maxSessions) && options.maxSessions > 0
    ? options.maxSessions
    : MAX_TRACKED_SESSIONS;
  const now = typeof options.now === "function" ? options.now : Date.now;

  /** @type {Map<string, { refs: ReadonlyArray<object>, stagedAt: number, expiresAt: number }>} */
  const entries = new Map();

  /**
   * Why the last media-bearing message for a conversation produced no
   * reference. Kept beside the references so the prompt that would have carried
   * them can say what happened instead of staying silent — silence is what makes
   * the model guess, and a guess is what the model must never act on.
   *
   * Only the stable code is stored. Where a rejected path pointed belongs in the
   * gateway log, which the operator reads; the model is told the code and
   * nothing about this host's filesystem.
   *
   * @type {Map<string, { code: string, expiresAt: number }>}
   */
  const failures = new Map();

  function prune(current) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(key);
    }
    for (const [key, entry] of failures) {
      if (entry.expiresAt <= current) failures.delete(key);
    }
  }

  return {
    /**
     * Records the references produced for one conversation. An empty list
     * clears any earlier batch, so a message with no usable file never leaves a
     * stale reference behind.
     *
     * @param {string} key Canonical session key.
     * @param {ReadonlyArray<{ attachmentRef: string, fileName?: string, mimeType?: string, byteSize?: number }>} refs
     */
    remember(key, refs) {
      if (typeof key !== "string" || key.length === 0) return;
      const current = now();
      prune(current);
      // Any decision about this conversation's files replaces the previous one,
      // including its failure: a reference must never outlive the message it
      // came from, and neither must an explanation of why one is missing.
      failures.delete(key);
      const usable = (Array.isArray(refs) ? refs : []).filter(
        (ref) => ref && typeof ref.attachmentRef === "string" && ref.attachmentRef.length > 0,
      );
      if (usable.length === 0) {
        entries.delete(key);
        return;
      }
      if (!entries.has(key) && entries.size >= maxSessions) {
        // Bounded memory: drop the oldest conversation rather than grow without
        // limit. Its references expire on their own in the runtime.
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      entries.set(key, {
        refs: Object.freeze(usable.map((ref) => Object.freeze({ ...ref }))),
        stagedAt: current,
        expiresAt: current + ttlMs,
      });
    },

    /**
     * Records that this conversation's message carried a file the bridge could
     * not stage, dropping any references from an earlier message.
     *
     * @param {string} key Canonical session key.
     * @param {string} code Stable failure code from {@link selectInboundMedia} or the stager.
     */
    rememberFailure(key, code) {
      if (typeof key !== "string" || key.length === 0) return;
      if (typeof code !== "string" || code.length === 0) return;
      const current = now();
      prune(current);
      entries.delete(key);
      if (!failures.has(key) && failures.size >= maxSessions) {
        const oldest = failures.keys().next();
        if (!oldest.done) failures.delete(oldest.value);
      }
      failures.set(key, { code, expiresAt: current + ttlMs });
    },

    /**
     * @param {string} key Canonical session key.
     * @returns {string | undefined} The failure code, or `undefined`.
     */
    readFailure(key) {
      if (typeof key !== "string" || key.length === 0) return undefined;
      prune(now());
      return failures.get(key)?.code;
    },

    /**
     * @param {string} key Canonical session key.
     * @returns {ReadonlyArray<object>} The references, or an empty list.
     */
    read(key) {
      if (typeof key !== "string" || key.length === 0) return Object.freeze([]);
      const current = now();
      prune(current);
      const entry = entries.get(key);
      return entry === undefined ? Object.freeze([]) : entry.refs;
    },

    /** Drops every entry; used on plugin teardown and in tests. */
    clear() {
      entries.clear();
      failures.clear();
    },

    /** Number of conversations currently holding references. */
    get size() {
      prune(now());
      return entries.size;
    },
  };
}

/**
 * Renders the prompt context that explains a file the bridge could not stage.
 *
 * Without this the model sees a message that plainly carried a file, no
 * reference, and no reason — which is exactly the state that invites it to
 * guess, improvise a reference, or tell the user something untrue about the
 * platform. The wording therefore gives it the fact and the prohibition, and
 * nothing it could act on.
 *
 * @param {string | undefined} code Stable failure code.
 * @returns {string} Context text, or an empty string when there is nothing to report.
 */
export function renderAttachmentFailureContext(code) {
  const trimmed = typeof code === "string" ? code.trim() : "";
  if (trimmed.length === 0) return "";

  return [
    `SFOA attachment bridge: this message carried a file, but the platform could not register it, so no \`att_…\` reference exists for it. Reason code: ${trimmed}.`,
    "Do not call `upload_files_to_record` for this file, do not invent or reuse a reference, and do not read or fetch the file to work around it. Tell the user the file could not be staged and quote the reason code so the platform side can be checked.",
  ].join("\n");
}

/**
 * Renders the prompt context that hands staged references to the model.
 *
 * The model receives opaque references and a name — never a path, a byte, or a
 * URL — which is what lets it attach a file without reading it. The wording
 * restates the two rules the model is most likely to get wrong: the reference
 * belongs to this user in this conversation, and the Tool takes no content.
 *
 * @param {ReadonlyArray<{ attachmentRef: string, fileName?: string, mimeType?: string, byteSize?: number }>} refs
 * @returns {string} Context text, or an empty string when nothing is staged.
 */
export function renderAttachmentContext(refs) {
  const usable = (Array.isArray(refs) ? refs : []).filter(
    (ref) => ref && typeof ref.attachmentRef === "string" && ref.attachmentRef.length > 0,
  );
  if (usable.length === 0) return "";

  const lines = usable.map((ref) => {
    const name = typeof ref.fileName === "string" && ref.fileName.length > 0 ? ref.fileName : "(unnamed file)";
    const details = [typeof ref.mimeType === "string" ? ref.mimeType : "unknown type"];
    if (Number.isInteger(ref.byteSize) && ref.byteSize > 0) details.push(`${ref.byteSize} bytes`);
    return `- ${ref.attachmentRef} — ${name} (${details.join(", ")})`;
  });

  return [
    "SFOA attachments received with this message (already stored by the platform; the file contents are not in this conversation):",
    ...lines,
    "To attach these to one record, call `upload_files_to_record` with `objectApiName`, `recordId`, and these `attachmentRefs`. The Tool takes references only — never file content, base64, a byte array, a filesystem path, or a URL — so do not try to read or fetch a file in order to upload it.",
    "These references belong to this user in this conversation. Never invent, guess, transform, or reuse another reference, and never retry a rejected one under a modified value.",
  ].join("\n");
}
