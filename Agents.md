# Kiln Workspace Entrypoint & Rules

This is the **Kiln framework** workspace. The memory below describes the framework
itself and is meant to be universal. **App-specific** context (e.g. `apps/jags-list`)
lives in that app's own `AGENTS.md` + `.memory/` — do **not** merge the two.

Version-controlled framework memory under [.memory/](.memory/):

*   **[Rules & Guidelines](.memory/agent-rules.md)**: Execution styles, MCP config tools, EchoVault protocols, and workspace workflows.
*   **[Active Work](.memory/active-work.md)**: Current branch state, validation setup, and active goals. Completed-session history → **[Work Log](.memory/work-log.md)**.
*   **[Architecture](.memory/architecture.md)**: Monorepo package structure, storage models, and schemas.
*   **[Features](.memory/features.md)**: Complete source-verified feature inventory — routing, rendering modes, live/FSR, middleware, actions, error handling, cache providers, i18n, image optimisation, service worker, config. Read this before scanning code or answering "does Kiln support X?".
*   **[Decisions](.memory/decisions.md)**: Architectural Decision Records (ADRs) and locked DX rules.
*   **[Active Bugs](.memory/bugs-active.md)**: Open framework issues, blockers, and type errors. Resolved history → **[Resolved Bugs](.memory/bugs-resolved.md)**.
*   **[Roadmap](.memory/roadmap.md)**: Milestones, backlogs, and feature branch isolates.

## Apps built on Kiln

Applications live under `apps/`, each with its own entrypoint and memory (kept
separate from the framework's):

*   **[apps/jags-list/AGENTS.md](apps/jags-list/AGENTS.md)** — flagship dogfood app (small-team project management).
