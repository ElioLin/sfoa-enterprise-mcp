# P0 Evidence Index

This directory stores durable, secret-safe protocol and Gate evidence produced by P0. Raw Salesforce CLI JSON is not committed because it contains local usernames, org IDs, instance URLs, and connected-app identifiers even when access tokens are redacted.

## Evidence policy

- Record command, version, exit result, timestamp, and a sanitized outcome.
- Never store access/refresh tokens, client secrets, private-key content, JWT assertions, or real user identifiers.
- Store `tools/list` schemas because they define the audited MCP contract.
- Distinguish transport success from a Salesforce operation success: a valid MCP `isError` response proves `tools/call`, not SOQL or metadata compatibility.

## Planned/produced artifacts

| Artifact | Purpose | Status |
| --- | --- | --- |
| `dx-mcp-tools-list.json` | Original stdio DX MCP Tool schemas for the enabled `core,data,metadata` set | Complete; 5 Tools |
| `streamable-http-poc.json` | Initialize/list/call POC summary and selected schema names | Complete; PASS |
| `execution-summary.md` | Sanitized command/exit-code evidence for install/build/test/lint/CLI/Inspector | Complete |

The authoritative Gate classification remains `../TEST_MATRIX.md`; this directory is supporting evidence, not a second plan baseline.
