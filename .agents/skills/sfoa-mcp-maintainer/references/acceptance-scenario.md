# Acceptance scenario: “Lead only” customer analysis

Symptom: in 小犇, the Agent says it can only read/write Lead and cannot query Account or Opportunity.

Use this as an evidence exercise; do not assume the business fix.

1. Run `yarn ai:snapshot` and locate the real `run_soql_query` catalog/facade. Confirm it is generic READ and host-injected with the routed username/workspace.
2. Run `yarn ai:doctor` to establish DB/runtime availability without exposing credentials.
3. Identify the authenticated platform user from safe request/Audit evidence. For Buntu, verify that the validated `data.userId`, not `userName` or a client Header, is authoritative.
4. Run `yarn ai:db --report routes --user <platformUserId>` and confirm route/current enabled state.
5. Run `yarn ai:db --report tools --tool run_soql_query`. Tool state controls visibility.
6. Run `yarn ai:db --report dml --object Lead`, then Account and Opportunity. Interpret these rows only as CREATE/UPDATE governance; they do not grant or deny SOQL reads.
7. Find the relevant invocation with `yarn ai:audit --user <platformUserId> --latest 10 --since 24h`, or use its public Audit/correlation ID.
8. Check whether `run_soql_query` was absent, never called, called only for Lead, blocked by governance, routed to the wrong user, or rejected by Salesforce. Inspect exact persisted SOQL/API/result evidence.
9. Compare current generated Agent capability guidance. A DML object allowlist may cause a model to overgeneralize mutation capability into read capability; that is an `AGENT`/guidance hypothesis only if evidence shows the read Tool was available and no Account/Opportunity read was attempted.
10. State the evidence-backed cause and gaps. The current Audit has no `tools/list` evidence and no session/call/span identifiers, so it cannot prove what a client displayed across a conversation unless separate client evidence exists.

Possible evidence-backed outcomes include disabled/absent `run_soql_query` (`TOOL_GOVERNANCE`), no attempted query despite availability (`AGENT`), wrong route (`IDENTITY`), Salesforce object/field/sharing rejection (`SALESFORCE`), or incomplete Audit (`DATABASE`/`MCP_RUNTIME`). DML policy alone is not a valid explanation for missing Account/Opportunity SELECT.
