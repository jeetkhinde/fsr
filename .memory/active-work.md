# Active Work Context

This file details the active task, branch checkpoints, and developer status.

## Current Objective

*   **Establish Git-Based Context Persistence**:
    *   Create a canonical, version-controlled repository memory directory (`.memory/`) containing decisions, system architecture details, known issues, and roadmap goals.
    *   Eliminate dependency on machine-specific or tool-specific memory folders (e.g. EchoVault caches, untracked local settings, IDE memory states).
    *   Commit `.memory/` to source control so context is shared across AI models (Gemini, Claude, Codex), workspaces, and branches.

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
