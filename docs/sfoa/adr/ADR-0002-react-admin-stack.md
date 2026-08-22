# ADR-0002: React Admin Console Stack

- Status: Accepted for P5
- Date: 2026-08-22

## Context

The future Admin Console must manage Salesforce account routes, object CREATE/UPDATE allowlists, MCP Tool governance, call audit, and system configuration. P0 must choose and document the stack without creating the application.

## Decision

Use:

- React for component-based UI composition;
- TypeScript in strict mode for shared contracts and safe refactoring;
- Vite for a small, fast development/build toolchain;
- Ant Design for enterprise forms, tables, navigation, feedback, and accessibility foundations;
- TanStack Query for server-state fetching, caching, invalidation, and mutation state;
- React Router for route/layout composition.

All dependencies will be project dependencies managed by Yarn. None is a machine-level prerequisite.

Recommended future location: `apps/admin-web`. Add `apps/*` to the root Yarn workspace configuration only in P5 and record that Upstream-owned manifest change.

## Consequences

- The Admin UI remains a deployable app, separate from provider packages.
- API/server state is not duplicated into a speculative global client store.
- Ant Design reduces custom enterprise-widget code.
- The stack adds a browser build/test pipeline in P5, not P0.

## Alternatives

- Create React App: rejected because it is not the selected modern build baseline.
- Next.js: rejected because P5 currently needs an internal SPA, not SSR/server components.
- A custom component library: rejected as unnecessary scope.
- Creating the workspace now: rejected because P0 explicitly prohibits formal Admin UI development.
