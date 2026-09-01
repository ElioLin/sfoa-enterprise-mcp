# Repository map

Use `yarn ai:snapshot` before relying on this maintained map.

## SFoA workspaces

| Directory | Package | Responsibility |
| --- | --- | --- |
| `packages/sfoa-mcp-server` | `@sfoa/mcp-server` | Production Streamable HTTP composition, auth, governance, facades, P7 HTTP evidence |
| `packages/sfoa-identity-runtime` | `@sfoa/identity-runtime` | Request context, identity resolution, JWT/Connection scope, workspaces/CWD guard, P7 collector/JSforce adapter |
| `packages/sfoa-control-plane` | `@sfoa/control-plane` | MySQL migrations, repositories, immutable policy snapshots, Audit queue/writer/read model |
| `packages/sfoa-admin-api` | `@sfoa/admin-api` | Authenticated Admin REST API and P7 trace aggregation |
| `packages/sfoa-admin-web` | `@sfoa/admin-web` | React/Vite/Ant Design Admin Console and Audit Trace Workbench |
| `packages/mcp-provider-sfoa-dml` | `@sfoa/mcp-provider-sfoa-dml` | Generic one-record CREATE/UPDATE Provider |
| `packages/mcp-provider-sfoa-context` | `@sfoa/mcp-provider-sfoa-context` | USER action context and DIAGNOSTIC Tooling/metadata Providers |
| `packages/sfoa-agent-playbook` | `@sfoa/agent-playbook` | Pure canonical Salesforce Agent behavior contract and generated client artifacts |
| `packages/sfoa-runtime-validation` | `@sfoa/runtime-validation` | P0 live JWT/SOQL/metadata/stdio closure harness |
| `packages/sfoa-streamable-http-poc` | `@sfoa/streamable-http-poc` | P0 public-Provider HTTP proof |

## Official workspaces

`packages/mcp`, `mcp-provider-api`, `mcp-provider-dx-core`, `mcp-provider-code-analyzer`, `mcp-provider-devops`, `mcp-provider-metadata-enrichment`, `mcp-provider-mobile-web`, `mcp-provider-scale-products`, `mcp-test-client`, and `EXAMPLE-MCP-PROVIDER` are upstream lineage. Avoid style-only edits.

## High-value source locations

- Runtime composition: `packages/sfoa-mcp-server/src/runtime.ts`, `http-server.ts`, `provider-runtime.ts`.
- Tool catalog/governance: `official-tool-catalog.ts`, `tool-governance.ts`, `dml-tool-governance.ts`.
- Identity: `authenticator.ts`, `buntu-validator.ts`, `packages/sfoa-identity-runtime/src/request-scope.ts`.
- MySQL: `packages/sfoa-control-plane/migrations/`, `schema.ts`, `mysql-repositories.ts`, `mysql-audit-repository.ts`.
- P7: `request-audit-context.ts`, `request-audit-collector.ts`, `jsforce-audit-adapter.ts`, `audit-pipeline.ts`, `mysql-audit-batch-sink.ts`.
- Admin trace: `packages/sfoa-admin-api/src/audit-trace.ts`, `packages/sfoa-admin-web/src/pages/audit/`.
- Agent Playbook: `packages/sfoa-agent-playbook/src/` and `scripts/sync-generated.mjs`.

The root uses Yarn Classic workspaces with `packages/*` and `nohoist: ["**"]`. Use each workspace's project-local toolchain.
