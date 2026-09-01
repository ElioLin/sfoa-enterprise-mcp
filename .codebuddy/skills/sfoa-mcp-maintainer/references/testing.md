# Testing and gates

Select gates from the changed boundary and record actual output. Never claim an unrun or credential-blocked gate passed.

## Maintainer Skill

```text
yarn skill:sync
yarn skill:check
yarn skill:delivery
yarn skill:test
yarn skill:smoke
yarn skill:package
```

The tests cover canonical structure, sync/drift, portable ZIP, secret masking, SQL read-only guard, missing `.env.local`, DB unavailable, Audit not found/reconstruction, checked-in platform consistency, and Git delivery trackability. `skill:delivery` fails when a required Skill file is missing, Git-ignored, or untracked; `skill:smoke` rebuilds a clean checkout from committed `HEAD` bytes via `git archive` and reruns the Skill gates there, so the evidence comes from committed Git bytes rather than a possibly dirty working tree.

## Focused workspaces

```text
yarn workspace @sfoa/control-plane lint
yarn workspace @sfoa/control-plane test
yarn workspace @sfoa/control-plane test:mysql
yarn workspace @sfoa/identity-runtime lint
yarn workspace @sfoa/identity-runtime test
yarn workspace @sfoa/mcp-server lint
yarn workspace @sfoa/mcp-server test:p7
yarn workspace @sfoa/admin-api lint
yarn workspace @sfoa/admin-api test
yarn workspace @sfoa/admin-web test
yarn workspace @sfoa/admin-web build
```

## Aggregate and integration

```text
yarn lint
yarn test
yarn build
yarn p5:test
yarn p5:test:runtime:mysql
yarn p5:e2e
yarn p5:e2e:fullstack
yarn validate:p5
yarn workspace @sfoa/mcp-server validate:upstream
```

Root lint is known to reproduce unchanged upstream Code Analyzer debt. `SFOA_CHANGED_CODE_LINT` must still pass; never use upstream debt to waive a new SFoA finding. Windows Yarn Classic and the upstream POSIX `cp` build step have recorded environment debt; report the exact failing command rather than broadly declaring the repository broken.

Live Salesforce, Inspector, stdio, HTTP, A/B identity, Diagnostic, and mutation gates are required when their boundary changes and credentials are available. Missing external conditions are `NOT TESTED`.
