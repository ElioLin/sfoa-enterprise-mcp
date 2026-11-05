# SFoA WeCom MCP Adapter

The transport resolver binds each MCP run to the host-trusted WeCom sender. The
optional attachment bridge streams only host-staged local files to the existing
SFoA ingress. It never changes Salesforce identity, Tool/DML policy or the public
MCP contracts.

## Material workflow

`message_received` accumulates materials instead of clearing them on text replies.
Both staging and reading outcomes are visible, including partial failures and
unprocessed indexes. Ingress `expiresAt`/`contentSha256` are retained. Different
content under the same filename gets a version; repeated content is one material,
not a business-record duplicate key. Up to 64 files are processed per message;
the existing upload Tool still takes 1–10 refs per call. Remaining items are
reported explicitly. References retain their backend expiry without extension.

Native OpenClaw PDF/vision/ASR paths remain in place. Their coverage is UNKNOWN
when this adapter has no direct reading evidence; the Agent must use the actual
native text, transcript or images. A reference, filename or upload never proves
reading. `src/read-office.py` adds basic DOCX body/tables, XLSX stored/cached cells
and basic date formats, and UTF-8 CSV using Python 3's standard library. It does
not evaluate formulas, macros, external relationships or page layout. Limits:
16 MiB input, 32 MiB expanded ZIP, 8 MiB member, 32 sheets, 1,000 rows per sheet,
24,000 text characters. Failed/partial coverage and omitted content are explicit.
Set `officePython` only if the host executable is not `python3`.

### Native reading observations (HOTFIX-01)

The adapter now observes existing OpenClaw 2026.9.5 contracts. It binds each
received original's exact local path and source message to the requester/session
task. `pdf` and `view_image` completion results use the host's resolved
`details.pdf` / `details.pdfs` and `details.image` / `details.images` references,
including an absolute `rewrittenFrom` mapping when supplied. Filenames, tool
arguments, plain assistant claims and an unbound old task never establish a read.
Same-content resend retains the new actual source-path binding.

Successful PDF or fallback image analysis records a completed reading operation
with **PARTIAL** coverage: the result does not prove exhaustive pages/content.
Multi-source analysis text is not assigned separately to each original. Native
`view_image` output records `nativeInput=PROVIDED_TO_MODEL`; semantic reading
remains **UNKNOWN**. This is the host tool's returned input evidence, not inspection
of the eventual provider request. An available image is not proof of analysis.

`message_received.media[].transcribed=true` records the host's transcription
fact without inventing a transcript. The existing optional
`api.registerHook("message:transcribed", ...)` supplies actual ASR text. Since its
transcript is message-level and the event lacks accountId, updating one material
requires exactly one matching prior account/requester/session/message/path
binding and one audio source. ASR remains **PARTIAL**, with unknown timecodes,
speakers, confidence and source extent. Queued transcription stays within the
task's bounds and cannot cross a task switch during ingress staging. These
observations neither create an upload ref nor grant archive consent.
The legacy registrar does not enforce the typed conversation-access switch itself,
so the adapter explicitly requires the already configured
`hooks.allowConversationAccess=true` for this plugin and respects
`hooks.internal.enabled=false`. It never changes either setting. Registration
uses the SDK's required named-hook options; no new manifest contract is invented.

Limitations: automatic PDF preprocessing exposes no per-original completion
contract here; `llm_input.imagesCount` is only a total, so prompt images without
an attributable tool result keep UNKNOWN. Ambiguous multi-audio transcripts,
unmapped sandbox paths, missing source identifiers and denied/absent transcript
hooks keep existing evidence. Supporting these needs a host event carrying the
trusted requester/session, original reference mapping, result and actual coverage;
it does not require a new OCR/ASR service. A host hook denied by policy is not
bypassed. Process restart still requires revalidation of the memory-only ledger.
The inspected SDK [hook registrar](https://github.com/openclaw/openclaw/blob/v2026.9.5/src/plugins/registry-registrars-tools-hooks.ts)
requires no additional manifest contract for these two hook APIs. Reloading a
changed plugin may still require the host's normal capability/consent review;
deployment must follow that process without bypassing it.

Tool results also retain the task captured at `before_tool_call` when available.
After a same-run `new_task`, an old native MCP completion without a start hook
cannot be distinguished from a new one; it is conservatively left unassociated
until a new prompt binding. Calls with their own start snapshot work normally.
This affects optional notes only, never the underlying MCP call or its result.

The contract fixtures in `test-support/openclaw-native-contracts.mjs` cite the
inspected [PDF tool](https://github.com/openclaw/openclaw/blob/v2026.9.5/src/agents/tools/pdf-tool.ts),
[image result](https://github.com/openclaw/openclaw/blob/v2026.9.5/src/agents/tools/image-tool.result.ts),
[message mapper](https://github.com/openclaw/openclaw/blob/v2026.9.5/src/hooks/message-hook-mappers.ts)
and [transcription dispatch](https://github.com/openclaw/openclaw/blob/v2026.9.5/src/auto-reply/reply/message-preprocess-hooks.ts).
Local SDK declaration snapshots independently confirm registration/event shapes.
Tests register the actual adapter and exercise its hooks with these fixtures;
they are contract validation, not an installed Gateway, real channel or model UAT.

Task state is isolated by trusted account + requester + session, with an absolute
two-hour task lifetime, at most 128 session entries, 64 materials and 64,000 stored
text characters per task. On OpenClaw 2026.9.5, `api.runtime.state.openKeyedStore`
persists the bounded state using the host's existing plugin store when the host
grants access. Local-path plugins on 2026.9.5 can expose this API but reject its
use. An absent or rejected store falls back to bounded process memory, keeps the
requester resolver and material hooks registered, and explicitly requires
revalidation after restart. No host trust policy is bypassed.
Session new/reset/delete clears task state; ordinary text and restart do not
renew original refs. Native conversation history retains earlier messages; only
the latest material message's Office body is injected again.

The local `sfoa_material_task` tool records task boundaries, collection phase,
pending questions, selected materials and an optional originals choice. It is
never a prerequisite for MCP DML. The Agent starts a new task when the business
client/event changes, selects relevant material IDs and avoids inheriting old
targets or consent. CREATE/UPDATE/batch results observed through `after_tool_call`
bind actual record IDs; notes cannot invent a confirmed target. OpenClaw's
embedded completion hook omits requester identity. The existing prompt lifecycle
captures the trusted sender against the exact session/run tuple, including native
MCP calls without a generic before-tool hook. These bindings expire, are bounded
to 128 runs, and clear on agent end or session reset. Missing or conflicting
bindings never infer identity from a session name or Tool arguments; the observer
does not change parameters, authorize, or gate a call. Per-file outcomes
remain separate, and SUCCESS/OUTCOME_UNKNOWN must not be replayed. Record and
attachment authorization stay independent. Full business behavior requires
actual model/channel validation, beyond these host contracts.

Task phase and archive selection are Agent notes of existing user intent. Guidance
asks the Agent to leave COLLECTING after the completion signal, mark finished work
COMPLETE, and retain explicit archive acceptance/refusal and selected materials.
The observer does not infer consent from a successful upload. These notes add no
MCP prerequisite, extra confirmation, or permission to replay a file.

## Deployment and verification

Enable the existing `attachmentBridgeEnabled` and backend ingress switches;
retain `hooks.allowConversationAccess: true` for prompt hooks. Deploy this entire
plugin directory, including the Python file, to the **actual configured plugin
load path**. Updating only the app checkout does not update the loaded plugin.
No OpenClaw Core or third-party WeCom source patch is required. A persisted CLI
plugin inventory marked `loaded` does not prove full registration: inspect a
fresh registry and Gateway startup for the resolver and hooks, then verify an
actual WeCom call has request-scoped identity. Task-tool factory
and hook context types were checked against installed OpenClaw 2026.9.5; verify
the Tool is allowed and appears in real model input after deployment.

From the repository root:

```text
node --test integrations/openclaw/sfoa-wecom-mcp-adapter/test/*.test.js
```

The Office tests generate actual archives/CSV. On Windows the default test
interpreter is `python3.12`; `SFOA_MATERIAL_PYTHON` may name another installed
Python 3 executable. Hook tests exercise the shipped entry, real files and
captured ingress bytes, but stub the host and ingress. They are deterministic
contract evidence, not real WeCom, real model or Salesforce acceptance.
