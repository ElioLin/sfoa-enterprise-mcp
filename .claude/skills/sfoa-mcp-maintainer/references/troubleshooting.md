# Troubleshooting workflow

## Business Skill discovery versus invocation

`openclaw skills list --agent main --json` and `systemPromptReport.skills` prove
discovery, not that the model read a Skill. Match a successful `read` Tool result
containing its frontmatter to the same run/session. A refreshed snapshot can
coexist with skipped instructions; compare isolated runs with already configured
models before attributing that to the loader. Never forge a WeCom requester for CLI UAT.

For CREATE field omissions, compare protected P7 `MCP_RESPONSE` / `UI_CONTEXT`
with the Agent Tool text and final question. An untruncated MCP response can still
be truncated in the Agent context or diagnostic export. Distinguish PENDING from
unsupported UNKNOWN conditions; defaults do not make unsupported container rules
evaluable. See `docs/sfoa/SFOA_SKILL_UAT_20260913.md` for evidence and its limits.

## General investigation

Use this evidence order as a recommendation, not a restriction:

```text
SYMPTOM
  -> reproduce or bound the occurrence
  -> collect correlation/public Audit ID and safe timestamps
  -> inspect current code/catalog
  -> inspect runtime health/configured state
  -> inspect current Control Plane route/Tool/DML state
  -> reconstruct P7 Audit evidence
  -> compare Salesforce API/result evidence
  -> state root cause and confidence/gaps
  -> implement the smallest justified fix
  -> regression and live validation as applicable
```

Suggested root-cause labels: `AGENT`, `MCP_RUNTIME`, `IDENTITY`, `TOOL_GOVERNANCE`, `DML_POLICY`, `DATABASE`, `SALESFORCE`, `NETWORK`, `CONFIG`, `ADMIN_API`, `ADMIN_WEB`, `DEPLOYMENT`. Add another label when the evidence demands it.

## Fast decision points

- Tool absent from `tools/list`: inspect code catalog compatibility, `sfoa_tool_control`, dependencies, and upstream drift. Do not start with Salesforce permissions.
- `run_soql_query` present but an object cannot be read: DML policy is irrelevant. Check generated Agent guidance, actual Tool request/Audit, SOQL, routed user, and Salesforce CRUD/FLS/sharing/error response.
- CREATE/UPDATE absent: check exact Tool enabled state and at least one matching enabled object operation.
- CREATE/UPDATE denied for one object: inspect `sfoa_dml_policy`, managed-field rules, then Salesforce rejection. Tool governance and DML policy are separate gates.
- Wrong user or no route: identify credential source, validated `platformUserId`, current enabled route, Audit identity/routing Events, and root Salesforce username.
- Buntu failure: distinguish upstream 401/403/business reject, timeout/network/5xx, invalid response contract, route missing/disabled, and Header conflict.
- Audit missing: confirm it was a definite `tools/call`, queue/writer health, integrity/fallback logs, DB availability, and shutdown flush. Do not fabricate a trace from correlation alone.
- Local or route-only Tool shows Salesforce API/`CONNECTION_INITIALIZATION`: treat this as a request-resource lifecycle regression. Reproduce with a connection-factory call counter, inspect scope/server composition for eager `getConnection()`, and confirm `OrgService` route reads and workspace creation remain Connection-free. Do not hide the Audit row or add Tool-name skip patches.
- Salesforce Tool authenticates more than once in one request: inspect request-scoped Promise memoization and verify no facade/provider constructs a second resource. Never add a process/user Connection cache; cross-request or USER/DIAGNOSTIC sharing is a security defect.
- UNKNOWN mutation: stop; never retry automatically. Use an independent read when possible and preserve the uncertainty.
- Admin page failure: test Admin API health/ready directly, then Vite proxy, exact Origin/cookie/CSRF, API response, and React query state.

When evidence is absent, say what is unavailable and what observation would distinguish the remaining hypotheses.
