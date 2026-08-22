# ADR-0004: Add Streamable HTTP by Provider Composition

- Status: Accepted as transport baseline; production hardening deferred to P1/P2
- Date: 2026-08-22

## Context

The official Salesforce DX MCP command exposes stdio and constructs process-scoped Cache, Services, and Tool instances. Remote Dify and WorkBuddy clients require Streamable HTTP, but patching transport into the official command would also inherit its process-scoped identity and global-CWD behavior. The official MCP TypeScript SDK already implements Streamable HTTP, and Salesforce publishes the Provider API plus dx-core Provider as public packages.

## Decision

Retain the official stdio command unchanged. Add an SFoA-owned Streamable HTTP host that registers selected official Provider Tools through public contracts. Start stateless: create an MCP server, transport, Services graph, and Tool instances for each POST; do not add a session store until a concrete feature requires it.

The P0 POC binds only to loopback, enables SDK DNS-rebinding/Host validation, returns JSON responses, rejects unsupported HTTP methods, and closes request-scoped resources after the response closes.

Production request authentication and Salesforce identity routing are not part of this ADR's P0 implementation. They must precede Tool execution in P1/P2.

## Evidence

`@sfoa/streamable-http-poc` passed strict TypeScript build, workspace lint, and an SDK-client integration test covering:

- MCP initialize and initialized notification;
- `tools/list`, including official core/data/metadata Tools;
- `tools/call` for `get_username` with `isError=false`;
- HTTP GET rejection with status 405;
- untrusted HTTP Origin rejection with status 403 while allowing non-browser clients that omit Origin;
- response-close cleanup of server and transport.

The POC imports no private `@salesforce/mcp/lib/*` module and modifies no official Salesforce TypeScript file.

## Consequences

### Positive

- Streamable HTTP is a low-intrusion extension.
- The local stdio experience is preserved.
- Request-scoped Services can be introduced without changing official Tools.
- Upstream merge risk remains low.

### Negative

- SFoA must maintain a thin Tool-selection/registration host.
- Stateless construction cost must be measured in P2.
- Official Tools that mutate process CWD still require serialization or process isolation.
- Production HTTP security, identity, timeouts, limits, and observability remain mandatory later-phase work.

## Alternatives

1. Patch `@salesforce/mcp` to add an HTTP flag. Rejected because it couples transport to process-scoped auth/CWD internals and raises merge risk.
2. Remove stdio and replace the official command. Rejected because local Codex/Cursor development needs stdio.
3. Add legacy standalone HTTP+SSE. Rejected because new remote deployments use Streamable HTTP.
