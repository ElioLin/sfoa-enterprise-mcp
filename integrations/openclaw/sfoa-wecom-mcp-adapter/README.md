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
embedded completion hook omits requester identity, so `before_tool_call` captures
the trusted scope against the exact session/run/call/tool tuple. Completion
consumes that bounded, expiring binding; missing or conflicting bindings do not
infer identity from a session name or Tool arguments. This hook does not change
parameters, authorize, or gate the call. Per-file outcomes
remain separate, and SUCCESS/OUTCOME_UNKNOWN must not be replayed. Record and
attachment authorization stay independent. Full business behavior requires
actual model/channel validation, beyond these host contracts.

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
