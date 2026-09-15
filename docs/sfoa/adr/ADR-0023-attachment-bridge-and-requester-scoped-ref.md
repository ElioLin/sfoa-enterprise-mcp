# ADR-0023 — Attachment upload: SFoA-side bridge and the requester-scoped `attachmentRef`

- Status: Accepted (Skill-02C)
- Date: 2026-09-15
- Supersedes: nothing. Amends the v1 boundary recorded in
  `SFOA_ATTACHMENT_CAPABILITY_PROBE.md` §16 ("Attachment Bridge: not needed for v1").
- Related: ADR-0003 (no token cache / no Redis), ADR-0015 (P7 audit data model),
  ADR-0020 (WeCom channel discovery), ADR-0022 (OpenClaw skill foundation)

## 1. Why this record exists

Skill-02C requires the OpenClaw inbound-attachment chain to be **actually
completed**, not just the second half (the MCP Tool):

```
企业微信用户发送文件 → Official WeCom Plugin → OpenClaw → SFOA Attachment Ingress
                     → attachmentRef → Agent 调用 upload_files_to_record
```

The same brief forbids modifying the official WeCom plugin, and forbids
assuming that `media://` / `AttachmentPath` / `AttachmentUrl` is the current
production contract. So the contract had to be read out of the installed
OpenClaw build rather than assumed. This ADR records what that review found, and
the design that follows from it.

## 2. The review (§二十一 requirement) — what was actually inspected

All paths below are on the OpenClaw host, against the running installation:

| Item | Value |
| --- | --- |
| OpenClaw version | `2026.9.3` |
| Install root | `/data/openclaw/runtime/tools/node-v24.19.0/lib/node_modules/openclaw` |
| Gateway unit | `/etc/systemd/system/openclaw-gateway.service` |
| Gateway config | `/data/openclaw/state/openclaw.json` |
| In-repo adapter | `integrations/openclaw/sfoa-wecom-mcp-adapter/` |
| Official WeCom plugin | `@wecom/wecom-openclaw-plugin@2026.7.2` (unmodified) |

### 2.1 The inbound media contract is `media: MediaFact[]`, not `media://`

`dist/plugin-sdk/media-facts.d.ts` is authoritative:

```ts
type MediaFact = {
  path?: string; url?: string; contentType?: string; kind?: MediaKind;
  fileName?: string; sizeBytes?: number; durationMs?: number;
  width?: number; height?: number; transcribed?: boolean;
  messageId?: string; workspaceDir?: string; staged?: boolean;
  hydrationSuppressed?: boolean;
};
```

and it declares exactly which keys are dead:

```ts
declare const LEGACY_MEDIA_CONTEXT_KEYS: readonly [
  "MediaPath","MediaPaths","MediaUrl","MediaUrls","MediaType","MediaTypes",
  "MediaDir","MediaTranscribedIndexes","MediaStaged","MediaWorkspaceDir"];
```

The plugin-hooks documentation states the rule in prose:

> Inbound claim and message-received events expose `media?:
> PluginHookMediaFact[]` as the canonical attachment API. … When a remote
> attachment has not been staged locally yet, `media` is omitted,
> `mediaStagingPending: true`, and `originalMedia` contains the provider-side
> facts. **Do not treat `originalMedia.path` as locally readable until a later
> staged event supplies `media`.** The singular/plural `mediaPath`, `mediaUrl`,
> … properties are deprecated compatibility aliases.
> — `docs/plugins/hooks.md`, "Message hooks"

**Verdict: the assumption the brief warned about is confirmed wrong.**
`media://`, `AttachmentPath` and `AttachmentUrl` are legacy aliases. Any bridge
built on them would be built on a deprecated projection.

### 2.2 A per-message hook exists and carries the staged path

`dist/agent-harness-runtime-DaJ4mxKg.d.ts` / `dist/hook-runner-global-DZetem8r.d.ts`:

```ts
type PluginHookName = … | "message_received" | "before_prompt_build" | "before_tool_call" | …;

type PluginHookMessageReceivedEvent = {
  from: string; content: string; sessionKey?: string; runId?: string;
  messageId?: string; senderId?: string;
  /** Staged, locally usable attachments in stable source order. */
  media?: PluginHookMediaFact[];
  /** Original attachment facts when local staging has not completed yet. */
  originalMedia?: PluginHookMediaFact[];
  mediaStagingPending?: boolean;
  …
};

type PluginHookMessageContext = {
  channelId: string; accountId?: string; conversationId?: string;
  sessionKey?: string; runId?: string; messageId?: string; senderId?: string; …
};
```

with `PluginHookMediaFact = MessageHookMediaFact`:

```ts
type MessageHookMediaFact = {
  path?: string; url?: string; contentType?: string; kind?: MediaKind;
  transcribed?: boolean; messageId?: string; workspaceDir?: string;
};
```

The registration surface is `api.on(hookName, handler, opts)` :

```ts
on: <K extends PluginHookName>(hookName: K, handler: PluginHookHandlerMap[K],
      opts?: PluginHookRegistrationOptions<K>) => void;
…
message_received: (event: PluginHookMessageReceivedEvent, ctx: PluginHookMessageContext) => Promise<void> | void;
before_prompt_build: (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext)
      => Promise<PluginHookBeforePromptBuildResult | void> | PluginHookBeforePromptBuildResult | void;
```

`api.on` — **not** `api.registerHook` — is the typed API; the docs are explicit
that registering an underscore name through `registerHook` produces a warning
and is never invoked by the typed runner.

`inbound_claim` is **not** usable here: it is a *claim* hook invoked only for
the plugin that owns the conversation binding, and this adapter does not own the
WeCom binding. `message_received` is the correct seam.

### 2.3 Staging is real, and its layout is observable

`dist/staged-inputs-CevqeK7q.mjs` owns the staging directory:

```js
const STAGED_INPUT_DIRECTORY_PREFIX = "media/inbound/openclaw-staged-";
function stagedInputDirectory(identity) { return `${STAGED_INPUT_DIRECTORY_PREFIX}${identity}`; }
function stagedInputFileName(name) { return sanitizeUntrustedFileName(`input-${name}`, "input-attachment"); }
function resolveStagedInputMediaPaths(media) { … }   // "Maps producer-stamped upload handles to exact private paths for the current turn."
```

and the running host matches it:

```
/data/openclaw/state/media/inbound/企业微信截图_17891201471804---f7d600f0-….png
/data/openclaw/workspace/media/inbound/openclaw-staged-<uuid>/input-企业微信截图_….png
/data/openclaw/workspace/media/inbound/openclaw-staged-<uuid>/.gitignore
```

So a WeCom file attachment **does** become a real, locally readable file inside
the agent workspace, per message. The bytes reach the host without any change on
our side.

### 2.4 Permission gates that apply

From `docs/plugins/hooks.md`, "Permissions and scope":

- Non-bundled plugins need `plugins.entries.<id>.hooks.allowConversationAccess: true`
  for `before_model_resolve`, `agent_turn_prepare`, `before_prompt_build`,
  `before_agent_reply`, `llm_input`, `llm_output`, `before_agent_finalize`,
  `agent_end`, `before_agent_run`. **`message_received` is not on that list** —
  it needs no extra grant.
- `allowPromptInjection: false` blocks `before_prompt_build` (defaults to allowed).

The SFOA adapter is a non-bundled plugin, so `before_prompt_build` requires an
explicit operator grant. This is a deployment requirement, not a code change.

## 3. Decision

**The bridge is built entirely on the SFOA side, inside our own already-installed
adapter plugin. The official WeCom plugin is not modified, and OpenClaw core is
not patched.**

| Question | Answer |
| --- | --- |
| Modify the Official WeCom Plugin? | **NO** |
| Patch OpenClaw core or `node_modules`? | **NO** |
| Add an OpenClaw-side component? | Yes — hooks inside our own `sfoa-wecom-mcp-adapter` |
| Depend on `media://` / `AttachmentPath` / `AttachmentUrl`? | **NO** (deprecated) |
| Depend on `media: MediaFact[]` + `runId`/`sessionKey`? | Yes |

### 3.1 Shape

```
WeCom file
  → Official WeCom plugin (unmodified) stages media into the agent workspace
  → OpenClaw emits "message_received" with media[] {path, contentType, kind}, runId, senderId
  → sfoa-wecom-mcp-adapter hook (our plugin, in-process with the run)
       ├─ 1. ingress: POST the staged path to the SFOA runtime over loopback
       └─ 2. "before_prompt_build": append the opaque attachmentRef(s) to the run context
  → Agent calls upload_files_to_record(recordId, objectApiName, attachmentRefs: ["att_…"])
  → SFOA resolves the ref requester-scoped, then uploads to Salesforce
```

Two properties fall out of this shape and are the reason it was chosen:

- **The model never handles a path.** It sees an opaque `att_…` token and no
  filesystem location, no bytes, no base64. This is what §六十's "不要让 LLM
  读取文件内容才能上传" and §三十一's "不要接受任意 filesystem path" require,
  and it is why the ref is minted by the *hook* rather than parsed from a model
  argument.
- **The ref is bound to a person, not to a tool call.** It is minted from
  `event.senderId` (host-trusted requester) and `event.runId`, so a ref cannot be
  replayed by a different WeCom user, and expiry is enforced server-side.

### 3.2 What the adapter is allowed to be

The adapter stays a *transport and context* plugin. It does not read file bytes
into its own memory beyond what the ingress call requires, does not decide
file-type or size policy, and does not talk to Salesforce. It mints nothing
itself: the `attachmentRef` is issued by the SFOA runtime, so there is exactly
one place that can create or validate one.

### 3.3 Failure posture

Fail-closed, matching `resolver.js`:

- No trusted `senderId`, no `runId`, wrong channel, or `mediaStagingPending` →
  no ingress call, no ref injected. The run proceeds with no attachment; the
  Tool call then simply has nothing to upload.
- Ingress unreachable or refusing → no ref injected. The agent is not told a
  file exists, so it cannot claim to have uploaded one.
- `originalMedia` is **never** treated as locally readable (per the host's own
  warning); only a `media[]` entry with a resolvable staged `path` is eligible.

## 4. Consequences

- The still-open question in `SFOA_ATTACHMENT_CAPABILITY_PROBE.md` §16 is
  closed in favour of the Skill-02C mandate. The probe's own reasoning — "the
  bridge would only be justified if uploads had to survive the request
  lifecycle" — described the *multipart call*, not the *inbound* half; the
  inbound half cannot be skipped without the agent having to name a file, which
  is exactly what must not happen.
- Deployment must add `hooks.allowConversationAccess: true` for
  `sfoa-wecom-mcp-adapter`, or the ref is never delivered and attachments will
  silently never appear. This is asserted in the deployment checklist, because
  the failure is otherwise silent.
- The adapter gains its first hook registrations; its "exactly one job" module
  comment must be revised to name both jobs.
- `sfoa-attachment-capability-probe.mjs` remains the API-capability probe. It is
  not the bridge and is not imported by production code.
