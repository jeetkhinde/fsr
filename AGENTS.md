## Execution Style: Execute Without Questions

- Execute every user request directly. Do not ask clarifying, confirmation,
  preference, scope, design, or approval questions.
- If details are missing or ambiguous, inspect the repository, infer the most
  reasonable intent from existing patterns, choose a sensible default, and
  continue. State important assumptions in the final response.
- A user request is authorization to perform all necessary repository-local
  reads, edits, commands, dependency changes, migrations, tests, builds,
  formatting, and verification required to complete it.
- Never initiate brainstorming, design documents, specifications,
  implementation plans, approval gates, or review checkpoints.
- Create or discuss a plan only when the user explicitly asks for a plan.
  Otherwise implement the requested work immediately.
- Complete implementation and verification in the current turn whenever
  technically possible. If genuinely blocked by unavailable credentials,
  external services, or platform restrictions, make all remaining progress and
  report the blocker without asking a question.
- Preserve unrelated working-tree changes unless the user explicitly requests
  their removal.

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- ALWAYS read graphify-out/GRAPH_REPORT.md before reading any source files, running grep/glob searches, or answering codebase questions. The graph is your primary map of the codebase.
- IF graphify-out/wiki/index.md EXISTS, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## EchoVault: Persistent Memory

**IMPORTANT: Every agent session MUST retrieve previous memory context at start and save discoveries/decisions at end. This ensures decisions are shared across Codex, Claude, OpenCode, Antigravity, and Gemini CLI.**

### Session Start Checklist
Before writing code or running analysis, retrieve the project context:
1. Run `memory context --project` in bash, or call the `echovault/memory_context` MCP tool.
2. Search for related terms using `memory search "<terms>"` or `echovault/memory_search`.
3. When details are available, load them with `memory details <id>` to understand prior findings, blockers, and bug reports.

### Session End Checklist
Before ending a session where changes, bug fixes, design decisions, or discoveries were made, you MUST save a memory:
- Run the `memory save` CLI command (using the format in `.codex/skills/echovault/SKILL.md`) or call the `echovault/memory_save` MCP tool.
- Specify categories such as `decision`, `bug`, `pattern`, `learning`, or `context`.

## Architectural Continuity & ADRs
- All major architecture decisions are documented in the [adr.md](file:///Users/jagjeet/Development/workspaces/Kiln/.codebase-memory/adr.md) file.
- **Rule:** Before proposing or implementing design changes, read the ADR file to ensure your approach conforms to established patterns (e.g. required Redis caching, 3-layer storage, `promote_after` lifecycles).

## Task Continuity & Active Work
- The current active task context is located in [now.md](file:///Users/jagjeet/Development/workspaces/Kiln/.remember/now.md).
- Active project implementation plans are stored in the [docs/superpowers/plans/](file:///Users/jagjeet/Development/workspaces/Kiln/docs/superpowers/plans/) directory.
- **Rule:** Keep `.remember/now.md` updated with your active/completed progress before completing the session.

