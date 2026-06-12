# Active Work Context

This file details the active task, branch checkpoints, and developer status.

## Current Objective

*   **Establish Git-Based Context Portability (Completed)**:
    *   [x] Create a canonical, version-controlled repository memory directory (`.memory/`) containing decisions, system architecture details, known issues, and roadmap goals.
    *   [x] Port all local AI configurations to use relative repository roots, enabling full multi-agent portability on clean checkouts.
    *   [x] Standardise code-review-graph updates by registering standard Git `post-commit` and `post-merge` hooks.
    *   [x] Consolidate root rule files (CLAUDE.md, GEMINI.md, .codex/AGENTS.md) into a single Agents.md entrypoint redirecting to .memory/agent-rules.md.

---

## Workspace Checkpoints

### 1. Version Control Status

*   **Active Branch**: `main`
*   **Dirty State**:
    *   `AGENTS.md`: Modified (retains command patterns and MCP usage details).
    *   `.codex/AGENTS.md`: Modified.
    *   `.codex/hooks.json`: Modified.
    *   `.opencode/plugins/graphify.js`: Modified.

### 2. Validation Suite

The workspace validation relies on the following shell commands:

*   **Unit Tests**: `bun run test:unit`
*   **Integration Tests**: `bun run test:integration` (requires local PostgreSQL and Redis servers configured in `test-app/.env`).
*   **Build Pipeline**: `bun run build`

> **Note**: Clean builds are currently blocked by TypeScript compiler errors (documented in `.memory/bugs.md`).
