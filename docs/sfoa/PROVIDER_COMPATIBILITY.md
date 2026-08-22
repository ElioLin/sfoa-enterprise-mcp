# Official Provider Compatibility Baseline

Baseline date: 2026-08-22

Audited Upstream commit: `670234dbdca4d3fcdebd9d58b231e311fd34aeec`

This baseline records the versions actually present in the P0/P0-Closure checkout. P0-Closure does not upgrade Node, Yarn, Salesforce SDKs, Providers, or the MCP SDK.

`PASS` in this matrix means version resolution, build/linkage, Provider registration, applicable local transport regression, and the completed live SFoA Closure path pass. Optional second-user and additional Metadata-type coverage remain outside the P0 Gate.

## Compatibility matrix

| Component | Workspace / declared version | Runtime resolved version | Tested version and path | Compatibility status | Notes |
| --- | --- | --- | --- | --- | --- |
| `@salesforce/mcp` | 0.30.15 | 0.30.15 | 0.30.15 packaged stdio host | PASS | Official host remains the stdio regression target; it is not reused unchanged as the multi-user HTTP host. |
| `@salesforce/mcp-provider-api` | 0.6.0 | 0.6.0 in official host, HTTP POC, and Closure Harness | 0.6.0 | PASS | Public `Services`/`McpTool` seam used by both SFoA workspaces. |
| `@salesforce/mcp-provider-dx-core` | Workspace 0.10.0; official host declares exact 0.9.8 | Official host: 0.9.8; HTTP POC and Closure Harness: workspace 0.10.0 | 0.9.8 stdio baseline and 0.10.0 extension baseline | PASS — DUAL BASELINE | The difference is deliberate release drift, not proof of interchangeability. Both paths require independent regression evidence. |
| `@salesforce/core` | Root override / package ranges resolve to 8.29.0 | 8.29.0 in official host, HTTP POC, and Closure Harness | 8.29.0 | PASS — LIVE CLOSURE | Closure JWT, Connection, identity, and SOQL path use this package directly; it never spawns `sf`. |
| `@modelcontextprotocol/sdk` | Provider/host ranges `^1.18.0`; Closure Harness pins 1.18.2 | 1.18.2 | 1.18.2 | PASS | Covers stdio/Inspector evidence, in-memory official Tool calls, and Streamable HTTP POC. |
| Node.js | Upstream requires current LTS / `>=20` | v24.13.0 | v24.13.0 | PASS | No Node major change in Closure. |
| Yarn | Upstream Yarn Classic workspaces / lockfile v1 | 1.22.22 | 1.22.22 | PASS | No package-manager migration in Closure. |

## Verified provider-version rule

Future SFoA production packages must declare the exact Provider/API/SDK versions they have passed against. They must not rely on an accidental Yarn workspace link, transitive range, or host-side dependency to select a Provider version.

The current verified extension set is:

```text
@salesforce/mcp-provider-api       0.6.0
@salesforce/mcp-provider-dx-core   0.10.0
@salesforce/core                   8.29.0
@modelcontextprotocol/sdk          1.18.2
Node.js                            24.13.0
Yarn                               1.22.22
```

The current packaged stdio comparison set is:

```text
@salesforce/mcp                    0.30.15
@salesforce/mcp-provider-api       0.6.0
@salesforce/mcp-provider-dx-core   0.9.8
@salesforce/core                   8.29.0
@modelcontextprotocol/sdk          1.18.2
```

Any version change requires install/build/test/lint, stdio initialize/list/call, Streamable HTTP initialize/list/call, and live SFoA read/metadata regression before this baseline is updated.
