# P6-Agent-01 Final Report

- Date: 2026-08-26
- Branch: `feature/p6-agent-playbook`
- Baseline: `482316d4` (`fix: align Buntu validator with real response contract`)
- Canonical Playbook version: `1.0.0`
- Result: **PASS / COMPLETE — AWAITING MAINTAINER REVIEW**

## Required conclusions

| Question | Result | Evidence |
| --- | --- | --- |
| Canonical Agent Playbook | PASS | Pure strict-TypeScript `@sfoa/agent-playbook` with ten required sections |
| Playbook Version | `1.0.0` | Independent `AGENT_PLAYBOOK_VERSION` |
| Single Source of Truth | PASS | One definition plus deterministic MCP/Dify/WorkBuddy renderers |
| Server Instructions | PASS | Returned by MCP initialize; concise core, identity, context-first, links, UNKNOWN, discovery rules |
| MCP Prompt | PASS | `sfoa_salesforce_assistant`, optional `CORE/READ/CREATE/UPDATE/DIAGNOSIS/ALL` workflow |
| MCP Resource | PASS | `sfoa://agent-playbook/current` full Markdown |
| Capability Resource | PASS | `sfoa://agent-capabilities/current`; safe request-scoped A/B-isolated facts |
| `get_agent_playbook` fallback | PASS | Governed, read-only, stable structured content and text compatibility output |
| WorkBuddy Skill generated from Playbook | PASS | `SKILL.md` plus workflow/safety references generated and drift-checked |
| Dify/Xiaoben instruction generated from Playbook | PASS | Canonical static rules plus current safe Admin Tool/DML/Diagnostic facts |
| USER_BOUND guidance current | PASS | WorkBuddy uses only `Bearer <USER_BOUND_TOKEN>` in normal setup |
| BUNTU guidance current | PASS | 小犇/Dify uses only current-user bearer; Buntu `data.userId` supplies platform identity |
| Legacy stale `X-Platform-User-Id` guidance removed | PASS | Removed from normal WorkBuddy and 小犇/Dify setup; retained only for Internal/Inspector |
| CREATE workflow | PASS | Context-first, required/recommended/optional split, 3–8 recommendations, defaults, Picklist/dependency/Lookup, one mutation, link result |
| UPDATE workflow | PASS | Unique target, relevant context, minimal requested fields, no CREATE-form replay, one mutation, actual changes/link |
| READ workflow | PASS | Bounded current evidence, user-field priority, display/name hyperlink, concise table/single-record formats |
| DIAGNOSIS workflow | PASS | Verified complete Diagnostic chain required; USER and DIAGNOSTIC evidence remain distinct |
| Picklist guidance | PASS | Shows current active-Record-Type choices when asking; never invents API values |
| Dependent Picklist guidance | PASS | Confirms controller first and shows only dependency-valid values |
| Lookup guidance | PASS | Bounded candidates; no guessed ID; user resolves zero/multiple candidates |
| Record hyperlinks | PASS | `get_record_links`, trusted request Connection origin, 1–50 records, no host input/API call |
| Dynamic Form Evidence | NOT AVAILABLE | Current action context does not evaluate Lightning Dynamic Forms |
| Runtime Form Engine created | NO | Explicit non-goal preserved |
| Business object hardcoding | `0` | No Quote/Lead/Opportunity or customer-object workflow/field branch in new production source |
| Agent Prompt DB tables added | `0` | No migration/table/editor/history/publisher |
| Official Salesforce TypeScript modified | `0` | Only SFoA-owned packages/composition plus audited root/docs files changed |
| USER_BOUND regression | PASS | Identity/MCP tests cover headerless USER_BOUND, route lifecycle, forgery denial, and isolation |
| BUNTU regression | PASS | Full MCP suite covers real response envelope, failures, audit safety, concurrency, and route isolation |
| Internal auth regression | PASS | Shared token plus trusted platform Header remains accepted and mutually exclusive with bound providers |
| Build | PASS | Agent, MCP, Admin API, and Admin Web production build/type gates |
| Focused Tests | PASS | Protocol, record-link, capability isolation, renderer, Skill, catalog, identity-copy, and Admin page contracts |
| P6-Agent-01 | **PASS** | All eleven acceptance conditions satisfied |

## Delivered protocol contract

| Surface | Identifier | Authority |
| --- | --- | --- |
| Instructions | initialize `instructions` | Guidance only |
| Full Resource | `sfoa://agent-playbook/current` | Guidance only |
| Capability Resource | `sfoa://agent-capabilities/current` | Request-scoped safe facts only |
| Prompt | `sfoa_salesforce_assistant` | Guidance only |
| Tool fallback | `get_agent_playbook` | Existing Tool governance plus read-only annotations |
| Record links | `get_record_links` | Existing Tool governance plus trusted request Connection origin |

Instructions, Resources, Prompts, and annotations do not grant authorization. Effective Tool state, object-operation allowlists, authenticated identity routing, and Salesforce CRUD/FLS/Sharing/Validation/Flow/Trigger remain the execution authorities.

## Verification evidence

| Command / check | Result |
| --- | --- |
| `yarn workspace @sfoa/agent-playbook test` | PASS — 6/6, including intentional drift rejection |
| `yarn agent:sync` then `yarn agent:check` | PASS — five exact generated artifacts |
| MCP native focused SDK Client test | PASS — 2/2 |
| `yarn workspace @sfoa/mcp-server test` | PASS — 50/50 |
| `yarn workspace @sfoa/identity-runtime test` | PASS — 27/27 |
| `yarn workspace @sfoa/mcp-server test:p3` | PASS — 20/20 |
| `yarn workspace @sfoa/mcp-server test:p4` | PASS — 7/7 |
| `yarn workspace @sfoa/mcp-server test:p5` | PASS — 5/5, real MySQL-backed integration included |
| `yarn workspace @sfoa/admin-api test` | PASS — 14/14 |
| Admin Web P6 focused tests | PASS — 5 files / 20 tests |
| Admin Web complete suite with 60-second diagnostic window | PASS — 7 files / 33 tests |
| Agent/MCP/Admin API/Admin Web lint | PASS |
| Admin API + Admin Web production builds | PASS; existing Vite chunk-size advisory only |
| `yarn workspace @sfoa/mcp-server validate:upstream` | PASS — exact Provider versions, nine GA Tools, no drift |
| `yarn.lock` comparison | PASS — zero content delta |

One standard 30-second Admin Web full-suite run expired in three existing interaction-heavy `GovernancePages` cases on the active Windows development stack. The P6-focused suite passed under the repository default, the previously expiring case passed in isolation, and the unmodified full 33-test suite passed with a 60-second diagnostic timeout. No assertion failure was hidden and the repository timeout setting was not loosened.

The pinned Yarn Classic root reinstall also reproduced known Windows nested-link/locked-file debt while the user's P5 dev stack was running: the retry reached an `EBUSY` lock in an installed ESLint dependency. No dependency was added or upgraded, `yarn.lock` is unchanged, every required local workspace link resolves, and all package build/test/lint Gates above passed. This environment issue is not promoted to an SFoA source waiver.

## Safety and scope result

- Secret scan: no real bearer, USER_BOUND credential, MCP client secret, Admin/database password, encryption key, Salesforce token, JWT private key, or local secret file is included; documentation contains placeholders only.
- `get_record_links` exposes no host/origin/base-URL argument and performs zero Salesforce/external API calls.
- Capability facts contain no route, username, host, token, database detail, Diagnostic error, or other user's policy.
- No official Tool was duplicated or renamed into a business-flavored Tool.
- No DELETE, UPSERT, MERGE, Bulk, arbitrary REST, Apex workaround, permission replica, business-rule engine, Dynamic Forms evaluator, Runtime Form Engine, prompt database, cache, or new external service was added.
- MCP SDK remains exact `1.18.2`; no v1-to-v2 migration was attempted.

## Remaining boundary

P6-Agent-01 completion means the Agent guidance infrastructure is ready. It does **not** complete the whole P6 phase. Real business-scenario evaluation through both 小犇 and WorkBuddy remains `READY / NOT STARTED` and requires a later Maintainer-authorized Gate. This branch must not be merged to `main` by Codex.
