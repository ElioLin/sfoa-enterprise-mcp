/**
 * Unit tests for the inbound attachment bridge decisions.
 *
 * These cover the properties the Attachment Bridge depends on: only files
 * OpenClaw itself staged can be forwarded, only the run's own trusted requester
 * can own them, nothing about a file reaches the model except an opaque
 * reference, and every precondition that cannot be met withholds the upload
 * rather than guessing.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  ATTACHMENT_INGRESS_PATH,
  DEFAULT_CHANNEL_MEDIA_ROOT,
  DEFAULT_STAGED_MEDIA_ROOT,
  DEFAULT_STAGED_MEDIA_ROOTS,
  MAX_INBOUND_ATTACHMENTS_PER_MESSAGE,
  buildIngressRequest,
  createStagedAttachmentRegistry,
  normalizeMimeType,
  normalizeStagedMediaRoots,
  renderAttachmentContext,
  renderAttachmentFailureContext,
  resolveIngressUrl,
  resolveStagedMediaPath,
  selectInboundMedia,
  stagedFileName,
} from "../src/attachments.js";

// Resolved up front so the expectations match the module's own normalization
// on every platform (the bridge runs on Linux; the tests also run on Windows).
const WORKSPACE_ROOT = path.resolve(path.sep, "data", "openclaw", "workspace");
const MEDIA_ROOT = path.join(WORKSPACE_ROOT, "media", "inbound");
const STAGED_FILE = path.join(MEDIA_ROOT, "openclaw-staged-abc", "input-invoice.pdf");
// The channel plugin's own directory: outside the workspace, and the shape the
// `message_received` hook actually reports for a WeCom file.
const CHANNEL_STAGED_FILE = path.join(
  path.resolve(DEFAULT_CHANNEL_MEDIA_ROOT),
  "订单行已抛SAP数量同步接口文档---4163435e-e2ed-4f17-a4da-166b614e07f8.md",
);

test("the ingress URL is derived from the MCP endpoint origin", () => {
  assert.equal(
    resolveIngressUrl("http://127.0.0.1:8080/mcp"),
    `http://127.0.0.1:8080${ATTACHMENT_INGRESS_PATH}`,
  );
  assert.equal(
    resolveIngressUrl("http://127.0.0.1:8080/mcp", "/files/inbound"),
    "http://127.0.0.1:8080/files/inbound",
  );
});

test("an unusable MCP endpoint or ingress path yields no ingress URL", () => {
  for (const value of [undefined, null, "", "   ", "not a url", "ftp://127.0.0.1/mcp"]) {
    assert.equal(resolveIngressUrl(value), undefined, `expected no URL for ${String(value)}`);
  }
  assert.equal(resolveIngressUrl("http://127.0.0.1:8080/mcp", "attachments"), undefined);
  assert.equal(resolveIngressUrl("http://127.0.0.1:8080/mcp", ""), undefined);
});

test("a staged path is accepted only below the staging root", () => {
  assert.equal(resolveStagedMediaPath(STAGED_FILE, { workspaceRoot: WORKSPACE_ROOT, mediaRoot: MEDIA_ROOT }), STAGED_FILE);
});

test("a path outside the staging root is refused, however it is written", () => {
  const options = { workspaceRoot: WORKSPACE_ROOT, mediaRoot: MEDIA_ROOT };
  const refused = [
    path.join(MEDIA_ROOT, "..", "..", "..", "etc", "passwd"),
    path.join(WORKSPACE_ROOT, "secrets.txt"),
    path.join(MEDIA_ROOT, "..", "media", "inbound-evil", "input-x"),
    path.join(path.sep, "etc", "passwd"),
  ];
  for (const candidate of refused) {
    assert.equal(resolveStagedMediaPath(candidate, options), undefined, `expected refusal for ${candidate}`);
  }
});

test("a URL is never treated as a local file", () => {
  const options = { workspaceRoot: WORKSPACE_ROOT, mediaRoot: MEDIA_ROOT };
  const urls = [
    "file:///data/openclaw/workspace/media/inbound/x/input-a.pdf",
    "FILE:///etc/passwd",
    "file:/etc/passwd",
    "http://169.254.169.254/latest/meta-data/",
    "https://localhost/secret",
    "http://127.0.0.1:8080/health",
  ];
  for (const url of urls) {
    assert.equal(resolveStagedMediaPath(url, options), undefined, `expected refusal for ${url}`);
  }
});

test("blank and NUL-bearing paths are refused", () => {
  const options = { workspaceRoot: WORKSPACE_ROOT, mediaRoot: MEDIA_ROOT };
  for (const value of ["", "   ", "a\0b", null, undefined, 42]) {
    assert.equal(resolveStagedMediaPath(value, options), undefined);
  }
});

test("a relative media path resolves below the workspace root", () => {
  const relative = path.join("media", "inbound", "openclaw-staged-abc", "input-invoice.pdf");
  assert.equal(
    resolveStagedMediaPath(relative, { workspaceRoot: WORKSPACE_ROOT, mediaRoot: MEDIA_ROOT }),
    STAGED_FILE,
  );
});

test("media staging pending withholds the files instead of reading provider-side facts", () => {
  const selection = selectInboundMedia(
    {
      mediaStagingPending: true,
      media: [{ path: STAGED_FILE, contentType: "application/pdf" }],
      originalMedia: [{ url: "https://wecom.example/media/1" }],
    },
    { workspaceRoot: WORKSPACE_ROOT, mediaRoot: MEDIA_ROOT },
  );
  assert.deepEqual(selection.files, []);
  assert.equal(selection.withheld, "MEDIA_STAGING_PENDING");
});

test("a fact carrying only a URL is withheld: those bytes are not on this host", () => {
  const selection = selectInboundMedia(
    { media: [{ url: "https://wecom.example/media/1", contentType: "image/png" }] },
    { workspaceRoot: WORKSPACE_ROOT, mediaRoot: MEDIA_ROOT },
  );
  assert.deepEqual(selection.files, []);
  assert.equal(selection.withheld, "MEDIA_NOT_LOCAL");
});

test("selects the local files in order and keeps their reported media types", () => {
  const second = path.join(MEDIA_ROOT, "openclaw-staged-abc", "input-photo.png");
  const selection = selectInboundMedia(
    {
      media: [
        { path: STAGED_FILE, contentType: "application/pdf" },
        { url: "https://wecom.example/media/2" },
        { path: second, contentType: "IMAGE/PNG; charset=binary" },
      ],
    },
    { workspaceRoot: WORKSPACE_ROOT, mediaRoot: MEDIA_ROOT },
  );

  assert.deepEqual(selection.files, [
    { filePath: STAGED_FILE, fileName: "invoice.pdf", mimeType: "application/pdf" },
    { filePath: second, fileName: "photo.png" },
  ]);
  assert.equal(selection.withheld, "MEDIA_NOT_LOCAL");
});

test("staging more files than one Tool call can carry is capped", () => {
  const facts = Array.from({ length: MAX_INBOUND_ATTACHMENTS_PER_MESSAGE + 5 }, (_unused, index) => ({
    path: path.join(MEDIA_ROOT, "openclaw-staged-abc", `input-file-${index}.pdf`),
  }));
  const selection = selectInboundMedia(
    { media: facts },
    { workspaceRoot: WORKSPACE_ROOT, mediaRoot: MEDIA_ROOT },
  );
  assert.equal(selection.files.length, MAX_INBOUND_ATTACHMENTS_PER_MESSAGE);
  assert.equal(selection.withheld, "MEDIA_LIMIT_EXCEEDED");
});

test("a media type is kept only when it is well-formed", () => {
  assert.equal(normalizeMimeType("application/pdf"), "application/pdf");
  assert.equal(normalizeMimeType("  image/png  "), "image/png");
  for (const value of [
    "application/pdf\r\nX-Injected: 1",
    "not-a-type",
    "application/",
    "/pdf",
    "application/pdf; charset=utf-8",
    "",
    42,
    undefined,
  ]) {
    assert.equal(normalizeMimeType(value), undefined, `expected refusal for ${String(value)}`);
  }
});

test("the display name comes from the staged file name, not from user input", () => {
  assert.equal(stagedFileName(STAGED_FILE), "invoice.pdf");
  assert.equal(stagedFileName(path.join(MEDIA_ROOT, "d", "input-报告 2026.xlsx")), "报告 2026.xlsx");
  assert.equal(stagedFileName(path.join(MEDIA_ROOT, "d", "unnamed.bin")), "unnamed.bin");
  // A name that is nothing but the staging prefix keeps the raw basename rather
  // than becoming empty; whether the entry is a readable file at all is decided
  // when the descriptor is opened, not here.
  assert.equal(stagedFileName(path.join(MEDIA_ROOT, "d", "input-")), "input-");
});

test("the ingress request carries the requester identity and never a path", () => {
  const request = buildIngressRequest({
    url: "http://127.0.0.1:8080/attachments",
    token: "channel-credential",
    requesterId: "zheng-runner-corp-01",
    runId: "run-123",
    file: { filePath: STAGED_FILE, fileName: "invoice.pdf", mimeType: "application/pdf" },
    byteSize: 2048,
  });

  assert.equal(request.url, "http://127.0.0.1:8080/attachments");
  assert.deepEqual(request.headers, {
    Authorization: "Bearer channel-credential",
    "X-WeCom-User-Id": "zheng-runner-corp-01",
    "Content-Type": "application/octet-stream",
    "x-sfoa-file-name": "invoice.pdf",
    "x-sfoa-file-mime": "application/pdf",
    "x-sfoa-source-channel": "WECOM",
    "x-external-run-id": "run-123",
    "Content-Length": "2048",
  });
  // The staged path is the body source, never a header value or a URL.
  for (const value of Object.values(request.headers)) {
    assert.equal(value.includes(MEDIA_ROOT), false, `header value leaked a path: ${value}`);
  }
});

test("a non-ASCII file name is percent-encoded for the header", () => {
  const request = buildIngressRequest({
    url: "http://127.0.0.1:8080/attachments",
    token: "channel-credential",
    requesterId: "user-a",
    file: { filePath: `${MEDIA_ROOT}${path.sep}d${path.sep}input-a.pdf`, fileName: "报告 2026.pdf" },
  });
  assert.equal(request.headers["x-sfoa-file-name"], encodeURIComponent("报告 2026.pdf"));
  assert.equal(request.headers["x-sfoa-file-name"].includes(" "), false);
});

test("an over-long file name is shrunk so the encoded header still fits", () => {
  const request = buildIngressRequest({
    url: "http://127.0.0.1:8080/attachments",
    token: "channel-credential",
    requesterId: "user-a",
    file: { filePath: `${MEDIA_ROOT}${path.sep}d${path.sep}input-x.pdf`, fileName: `${"甲".repeat(400)}.pdf` },
  });
  const encoded = request.headers["x-sfoa-file-name"];
  assert.ok(encoded.length <= 480, `encoded name was ${encoded.length} characters`);
  assert.ok(encoded.length > 0);
});

test("an unusable media type is omitted rather than guessed", () => {
  const request = buildIngressRequest({
    url: "http://127.0.0.1:8080/attachments",
    token: "channel-credential",
    requesterId: "user-a",
    file: { filePath: `${MEDIA_ROOT}${path.sep}d${path.sep}input-a.bin`, fileName: "a.bin", mimeType: "nonsense" },
  });
  assert.equal("x-sfoa-file-mime" in request.headers, false);
});

test("an ingress request is withheld whenever a precondition is missing", () => {
  const base = {
    url: "http://127.0.0.1:8080/attachments",
    token: "channel-credential",
    requesterId: "user-a",
    file: { filePath: `${MEDIA_ROOT}${path.sep}d${path.sep}input-a.pdf`, fileName: "a.pdf" },
  };

  assert.equal(buildIngressRequest({ ...base, url: undefined }), null);
  assert.equal(buildIngressRequest({ ...base, token: undefined }), null);
  assert.equal(buildIngressRequest({ ...base, token: "   " }), null);
  assert.equal(buildIngressRequest({ ...base, requesterId: undefined }), null);
  assert.equal(buildIngressRequest({ ...base, requesterId: "bad user id" }), null);
  assert.equal(buildIngressRequest({ ...base, file: undefined }), null);
  assert.equal(buildIngressRequest({ ...base, file: { filePath: "", fileName: "a.pdf" } }), null);
  assert.equal(buildIngressRequest({ ...base, file: { filePath: "x", fileName: "  " } }), null);
});

test("staged references are remembered per conversation and expire", () => {
  let clock = 1_000;
  const registry = createStagedAttachmentRegistry({ ttlMs: 100, now: () => clock });
  const ref = [{ attachmentRef: "att_aaaaaaaaa", fileName: "a.pdf" }];

  registry.remember("session-1", ref);
  assert.deepEqual(registry.read("session-1"), ref);
  assert.deepEqual(registry.read("session-2"), []);

  clock += 101;
  assert.deepEqual(registry.read("session-1"), []);
  assert.equal(registry.size, 0);
});

test("a reference belongs to one conversation only", () => {
  const registry = createStagedAttachmentRegistry();
  registry.remember("session-a", [{ attachmentRef: "att_aaaaaaaaa" }]);
  registry.remember("session-b", [{ attachmentRef: "att_bbbbbbbbb" }]);

  assert.deepEqual(
    registry.read("session-a").map((entry) => entry.attachmentRef),
    ["att_aaaaaaaaa"],
  );
  assert.deepEqual(
    registry.read("session-b").map((entry) => entry.attachmentRef),
    ["att_bbbbbbbbb"],
  );
});

test("a later message replaces the earlier batch and an empty batch clears it", () => {
  const registry = createStagedAttachmentRegistry();
  registry.remember("session-a", [{ attachmentRef: "att_aaaaaaaaa" }]);
  registry.remember("session-a", [{ attachmentRef: "att_bbbbbbbbb" }]);
  assert.deepEqual(
    registry.read("session-a").map((entry) => entry.attachmentRef),
    ["att_bbbbbbbbb"],
  );

  registry.remember("session-a", []);
  assert.deepEqual(registry.read("session-a"), []);
  assert.equal(registry.size, 0);
});

test("the registry is bounded: the oldest conversation is dropped first", () => {
  const registry = createStagedAttachmentRegistry({ maxSessions: 2 });
  registry.remember("session-1", [{ attachmentRef: "att_111111111" }]);
  registry.remember("session-2", [{ attachmentRef: "att_222222222" }]);
  registry.remember("session-3", [{ attachmentRef: "att_333333333" }]);

  assert.equal(registry.size, 2);
  assert.deepEqual(registry.read("session-1"), []);
  assert.equal(registry.read("session-3").length, 1);
});

test("a malformed reference is never remembered", () => {
  const registry = createStagedAttachmentRegistry();
  registry.remember("session-a", [
    { attachmentRef: "" },
    { attachmentRef: 42 },
    null,
    { attachmentRef: "att_ccccccccc" },
  ]);
  assert.deepEqual(
    registry.read("session-a").map((entry) => entry.attachmentRef),
    ["att_ccccccccc"],
  );
});

test("the injected context carries references and rules, never a path or a byte", () => {
  const text = renderAttachmentContext([
    { attachmentRef: "att_aaaaaaaaa", fileName: "invoice.pdf", mimeType: "application/pdf", byteSize: 2048 },
    { attachmentRef: "att_bbbbbbbbb", fileName: "photo.png" },
  ]);

  assert.match(text, /att_aaaaaaaaa — invoice\.pdf \(application\/pdf, 2048 bytes\)/u);
  assert.match(text, /att_bbbbbbbbb — photo\.png \(unknown type\)/u);
  assert.match(text, /upload_files_to_record/u);
  assert.match(text, /never file content, base64, a byte array, a filesystem path, or a URL/u);
  assert.match(text, /do not try to read or fetch a file in order to upload it/u);
  assert.match(text, /Never invent, guess, transform, or reuse another reference/u);
  assert.equal(text.includes(MEDIA_ROOT), false, "the injected context must not carry a path");
  // No base64 payload, no data: URI, no multipart body — only references and rules.
  assert.equal(/[A-Za-z0-9+/]{40,}={0,2}/u.test(text), false, "the injected context must not carry encoded content");
  assert.equal(text.includes("data:"), false);
});

test("no staged reference renders no context at all", () => {
  assert.equal(renderAttachmentContext([]), "");
  assert.equal(renderAttachmentContext(undefined), "");
  assert.equal(renderAttachmentContext([{ attachmentRef: "" }]), "");
});

test("the default roots accept the channel's own media directory", () => {
  // Two independent layers stage the same file: OpenClaw's sandbox copies it
  // below the workspace, and the WeCom channel plugin — which downloads the file
  // itself — writes it below its own state directory. The hook context reports
  // the channel's copy. Accepting only the workspace root refused every WeCom
  // file, and did so before the first log line.
  assert.deepEqual([...DEFAULT_STAGED_MEDIA_ROOTS], [DEFAULT_STAGED_MEDIA_ROOT, DEFAULT_CHANNEL_MEDIA_ROOT]);
  assert.equal(
    resolveStagedMediaPath(CHANNEL_STAGED_FILE, { workspaceRoot: WORKSPACE_ROOT }),
    CHANNEL_STAGED_FILE,
  );
});

test("the channel's saved file is accepted and its staging identity is not its name", () => {
  const selection = selectInboundMedia(
    { media: [{ path: CHANNEL_STAGED_FILE, contentType: "text/markdown" }] },
    { workspaceRoot: WORKSPACE_ROOT },
  );
  assert.deepEqual(selection.files, [
    { filePath: CHANNEL_STAGED_FILE, fileName: "订单行已抛SAP数量同步接口文档.md", mimeType: "text/markdown" },
  ]);
  assert.equal(selection.withheld, undefined);
});

test("an explicit root list replaces the defaults rather than widening them", () => {
  const roots = normalizeStagedMediaRoots({ mediaRoots: [MEDIA_ROOT] });
  assert.deepEqual([...roots], [MEDIA_ROOT]);
  // With the defaults replaced, the channel's directory is no longer accepted.
  assert.equal(resolveStagedMediaPath(CHANNEL_STAGED_FILE, { workspaceRoot: WORKSPACE_ROOT, mediaRoots: roots }), undefined);

  // The pre-roots single-root spelling still narrows to exactly one root.
  assert.deepEqual([...normalizeStagedMediaRoots({ mediaRoot: MEDIA_ROOT })], [MEDIA_ROOT]);
  // A single root alongside a list adds to it.
  const mixed = normalizeStagedMediaRoots({ mediaRoot: MEDIA_ROOT, mediaRoots: [DEFAULT_CHANNEL_MEDIA_ROOT] });
  assert.deepEqual([...mixed], [path.resolve(DEFAULT_CHANNEL_MEDIA_ROOT), MEDIA_ROOT]);
});

test("an unusable root entry is dropped, and dropping all of them fails closed", () => {
  for (const value of ["", "   ", "relative/path", "/", null, 42]) {
    assert.deepEqual([...normalizeStagedMediaRoots({ mediaRoots: [value] })], [], `expected no root for ${String(value)}`);
  }
  // Duplicates collapse, so a repeated root is not judged twice.
  assert.deepEqual([...normalizeStagedMediaRoots({ mediaRoots: [MEDIA_ROOT, MEDIA_ROOT] })], [MEDIA_ROOT]);
  // Nothing usable means nothing is forwarded — never a silent fallback.
  assert.deepEqual(
    selectInboundMedia(
      { media: [{ path: STAGED_FILE, contentType: "application/pdf" }] },
      { workspaceRoot: WORKSPACE_ROOT, mediaRoots: ["not-absolute"] },
    ).files,
    [],
  );
});

test("a rejected path reports the directory it came from, never the file name", () => {
  const selection = selectInboundMedia(
    { media: [{ path: path.join(WORKSPACE_ROOT, "secrets", "merger-agreement.pdf") }] },
    { workspaceRoot: WORKSPACE_ROOT, mediaRoots: [MEDIA_ROOT] },
  );
  assert.deepEqual(selection.files, []);
  assert.equal(selection.withheld, "MEDIA_PATH_REJECTED");
  assert.equal(selection.withheldDirectory, path.join(WORKSPACE_ROOT, "secrets"));
  assert.equal(selection.withheldDirectory.includes("merger-agreement.pdf"), false);
});

test("the staging identity suffix is stripped from the display name", () => {
  const names = [
    ["报告---4163435e-e2ed-4f17-a4da-166b614e07f8.pdf", "报告.pdf"],
    [`photo---${"a".repeat(64)}.png`, "photo.png"],
    ["input-订单行---4163435e-e2ed-4f17-a4da-166b614e07f8.md", "订单行.md"],
    // A suffix that is not the identity shape is part of the name.
    ["report---final.pdf", "report---final.pdf"],
    ["report---4163435E-E2ED-4F17-A4DA-166B614E07F8.pdf", "report---4163435E-E2ED-4F17-A4DA-166B614E07F8.pdf"],
  ];
  for (const [name, expected] of names) {
    assert.equal(stagedFileName(path.join(MEDIA_ROOT, name)), expected, `for ${name}`);
  }
});

test("a failure code is remembered for the conversation that produced it", () => {
  const registry = createStagedAttachmentRegistry();
  assert.equal(registry.readFailure("session-1"), undefined);

  registry.rememberFailure("session-1", "MEDIA_PATH_REJECTED");
  assert.equal(registry.readFailure("session-1"), "MEDIA_PATH_REJECTED");
  assert.equal(registry.readFailure("session-2"), undefined);
  // A failure is not a reference.
  assert.deepEqual(registry.read("session-1"), []);
  // Unusable inputs are ignored rather than recorded.
  registry.rememberFailure("session-1", "");
  assert.equal(registry.readFailure("session-1"), "MEDIA_PATH_REJECTED");
});

test("the newer of a reference and a failure replaces the other", () => {
  const registry = createStagedAttachmentRegistry();
  const ref = [{ attachmentRef: "att_aaaaaaaaa" }];

  // A later message that staged nothing usable must not leave the earlier
  // reference behind — nor must its explanation outlive a successful staging.
  registry.rememberFailure("session-1", "STAGING_FAILED");
  registry.remember("session-1", ref);
  assert.equal(registry.readFailure("session-1"), undefined);
  assert.deepEqual(registry.read("session-1"), ref);

  registry.rememberFailure("session-1", "MEDIA_PATH_REJECTED");
  assert.deepEqual(registry.read("session-1"), []);
  assert.equal(registry.readFailure("session-1"), "MEDIA_PATH_REJECTED");

  registry.remember("session-1", []);
  assert.equal(registry.readFailure("session-1"), undefined);
});

test("a failure code expires like a reference does", () => {
  let clock = 1_000;
  const registry = createStagedAttachmentRegistry({ ttlMs: 100, now: () => clock });
  registry.rememberFailure("session-1", "MEDIA_PATH_REJECTED");
  clock += 101;
  assert.equal(registry.readFailure("session-1"), undefined);
});

test("the failure context states the reason and forbids working around it", () => {
  const text = renderAttachmentFailureContext("MEDIA_PATH_REJECTED");
  assert.match(text, /MEDIA_PATH_REJECTED/u);
  assert.match(text, /Do not call `upload_files_to_record`/u);
  assert.match(text, /do not invent or reuse a reference/u);
  assert.match(text, /do not read or fetch the file to work around it/u);
  assert.equal(text.includes(MEDIA_ROOT), false, "the prompt must not carry a host path");

  assert.equal(renderAttachmentFailureContext(undefined), "");
  assert.equal(renderAttachmentFailureContext(""), "");
  assert.equal(renderAttachmentFailureContext("   "), "");
});

