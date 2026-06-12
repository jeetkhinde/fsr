# AI Agent Rules & Guidelines

This document outlines the core instructions, command rules, and context retrieval workflows for all AI coding agents working in the Kiln repository.

---

## 1. Execution Style: Execute Without Questions

*   **Execute Directly**: Execute every user request directly. Do not ask clarifying, confirmation, preference, scope, design, or approval questions.
*   **Infer Intent**: If details are missing or ambiguous, inspect the repository, infer the most reasonable intent from existing patterns, choose a sensible default, and continue. State important assumptions in the final response.
*   **Authorization**: A user request is authorization to perform all necessary repository-local reads, edits, commands, dependency changes, migrations, tests, builds, formatting, and verification required to complete it.
*   **No Checkpoints**: Never initiate brainstorming, design documents, specifications, implementation plans, approval gates, or review checkpoints. Create or discuss a plan only when the user explicitly asks for a plan.
*   **Resolve Blockers**: Complete implementation and verification in the current turn. If genuinely blocked by unavailable credentials or platform restrictions, make all remaining progress and report the blocker without asking a question.
*   **Preserve Working Tree**: Preserve unrelated working-tree changes unless the user explicitly requests their removal.

---

## 2. MCP Tools: code-review-graph

This project has a knowledge graph. **ALWAYS** use the `code-review-graph` MCP tools before using Grep/Glob/Read to explore the codebase. It is faster, cheaper, and provides structural context.

*   **Exploring Code**: Use `semantic_search_nodes` or `query_graph` instead of Grep.
*   **Understanding Impact**: Use `get_impact_radius` instead of manually tracing imports.
*   **Code Review**: Use `detect_changes` + `get_review_context` instead of reading entire files.
*   **Finding Relationships**: Use `query_graph` with callers_of/callees_of/imports_of/tests_for.
*   **Architecture Questions**: Use `get_architecture_overview` + `list_communities`.

---

## 3. Graphify Rules

The knowledge graph is built at `graphify-out/` with god nodes and community structures.

*   **Primary Map**: Always read [GRAPH_REPORT.md](file:///Users/jagjeet/Development/workspaces/Kiln/graphify-out/GRAPH_REPORT.md) before reading source files or running grep/glob searches.
*   **Cross-Module Questions**: Prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep.
*   **Git Hooks**: The repository maintains Git `post-commit` and `post-merge` hooks that automatically execute `graphify update .` to keep the graph current.

---

## 4. EchoVault: Persistent Memory

Every agent session must retrieve previous memory context at start and save discoveries/decisions at end. This ensures decisions are shared across Codex, Claude Code, OpenCode, Antigravity, and Gemini CLI.

### Session Start Checklist
Before writing code or running analysis, retrieve the project context:
1.  Run `memory context --project` in bash, or call the `echovault/memory_context` MCP tool.
2.  Search for related terms using `memory search "<terms>"` or `echovault/memory_search`.
3.  When details are available, load them with `memory details <id>` to understand prior findings, blockers, and bug reports.

### Session End Checklist
Before ending a session where changes, bug fixes, design decisions, or discoveries were made, you **MUST** save a memory:
*   Run the `memory save` CLI command or call the `echovault/memory_save` MCP tool.
*   Specify categories such as `decision`, `bug`, `pattern`, `learning`, or `context`.

---

## 5. Architectural Continuity & ADRs
*   All major architecture decisions are documented in the [decisions.md](file:///Users/jagjeet/Development/workspaces/Kiln/.memory/decisions.md) file and [.codebase-memory/adr.md](file:///Users/jagjeet/Development/workspaces/Kiln/.codebase-memory/adr.md).
*   **Rule**: Before proposing or implementing design changes, read the ADR file to ensure your approach conforms to established patterns (e.g. required Redis caching, 3-layer storage, `promote_after` lifecycles).

---

## 6. Task Continuity & Active Work
*   The current active task context is located in [active-work.md](file:///Users/jagjeet/Development/workspaces/Kiln/.memory/active-work.md).
*   Active project implementation plans are stored in the [docs/superpowers/plans/](file:///Users/jagjeet/Development/workspaces/Kiln/docs/superpowers/plans/) directory.
