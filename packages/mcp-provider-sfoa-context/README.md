# SFoA P4 Context Provider

Private Provider API extension for deterministic Salesforce facts:

- `get_record_action_context` uses the request USER Connection and REST UI API.
- `run_diagnostic_tooling_query` delegates through a Host-supplied official Tooling-query adapter.
- `get_metadata_component_context` delegates through a Host-supplied official metadata-retrieve adapter.

The Provider contains no identity selector, business reasoning, DML, arbitrary REST URL, client filesystem path, metadata cache, evidence graph, or runtime form engine. Tool visibility remains controlled by the remote Host's explicit `MCP_ENABLED_TOOLS` configuration.
