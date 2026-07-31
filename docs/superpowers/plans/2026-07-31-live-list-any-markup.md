# Live.list on Any Markup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `Live.list` mark rows in any markup — divs, tables, definition lists — not only `<li>` inside `<ul>`/`<ol>`.

**Architecture:** An app opts in by putting `data-kiln-row={key}` on each row element. The server reads those markers, adds the `data-kiln-key` the client already expects, and marks the rows' enclosing element as the container. When no markers are present the existing `<li>` scan runs unchanged, so nothing breaks.

**Tech Stack:** TypeScript, Bun (`bun:test`).

**Item**: 2 of `docs/superpowers/plans/2026-07-31-framework-fix-sequencing.md`
**Branch/worktree:** `feat/live-list-any-markup` at `.worktrees/feat-live-list-markup/`, from `main` @ `f5fa13a`.

## Global Constraints

- Work inside the worktree — `cd /Users/jagjeet/Development/workspaces/Kiln/.worktrees/feat-live-list-markup` at the start of every task; the shell resets between turns.
- First run needs `bun install`, `cp ../../test-app/.env test-app/.env`, then `bun run build`.
- Rebuild `@kiln/core` before running `routekit` tests if core changed — routekit consumes core through `dist/`.
- `bun run build` before any completion claim, alongside `bun run test:unit`.
- **No `apps/jags-list` changes.** It is a test vehicle; it adopts what the framework provides.
- Never commit to `main`.

## Findings

1. **The client already works with any tag.** `_patchList` queries `[data-kiln-list]` and `[data-kiln-key]`, and on insert takes `box.firstElementChild` — whatever element that is (`packages/routekit/src/live-client-script.ts`). The constraint is entirely server-side.
2. **Two hardcoded assumptions**, both in `packages/routekit/src/live-list-render.ts`: `findMatchingRow` scans for the next `<li>`, and `markList` marks the nearest enclosing `<ul>`/`<ol>`.
3. **Rows are currently located by content matching** — the next `<li>` whose HTML contains every one of the row's text values. That heuristic is why `rowTag: 'div'` config would not have worked: in a div board the first div containing a row's text is the *wrapper*, not the row. Explicit markers remove the guess entirely for opted-in lists.
4. **Tables need a client change.** `box.innerHTML = '<tr>…'` inside a `<div>` is dropped by the HTML parser, so inserts and row replacements would silently no-op in a `<tbody>`. A `<template>` element parses table fragments correctly. Task 3.

---

### Task 1: A tag-agnostic enclosing-element finder

`findNearestOpenTag` needs a tag name. Marking the container around explicitly-marked rows means finding whatever element encloses them, so this needs a version that tracks nesting instead.

**Files:**
- Modify: `packages/routekit/src/live-list-render.ts`
- Create: `packages/routekit/src/live-list-enclosing.test.ts`

**Interfaces:**
- Produces: `export function findEnclosingOpenTag(html: string, index: number): Range | null` — the innermost element whose open tag ends before `index` and whose close tag starts after it. `Range` is the existing `{ start, openEnd, end }` shape (`end` is the end of the open tag, matching how `markList` slices).

- [ ] **Step 1: Set up the worktree**

```bash
cd /Users/jagjeet/Development/workspaces/Kiln/.worktrees/feat-live-list-markup
bun install && cp ../../test-app/.env test-app/.env && bun run build
```

- [ ] **Step 2: Write the failing tests**

Create `packages/routekit/src/live-list-enclosing.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { findEnclosingOpenTag } from './live-list-render.js';

function openTagOf(html: string, needle: string): string {
  const found = findEnclosingOpenTag(html, html.indexOf(needle));
  if (!found) return '';
  return html.slice(found.start, found.openEnd);
}

describe('findEnclosingOpenTag', () => {
  it('finds the immediate parent', () => {
    expect(openTagOf('<div class="board"><article>row</article></div>', '<article>')).toBe(
      '<div class="board">',
    );
  });

  it('finds the innermost enclosing element, not an outer one', () => {
    const html = '<section><div class="col"><article>row</article></div></section>';
    expect(openTagOf(html, '<article>')).toBe('<div class="col">');
  });

  it('skips a sibling that has already closed', () => {
    const html = '<div class="board"><div class="head">x</div><article>row</article></div>';
    expect(openTagOf(html, '<article>')).toBe('<div class="board">');
  });

  it('ignores void elements', () => {
    const html = '<div class="board"><br><img src="a.png"><article>row</article></div>';
    expect(openTagOf(html, '<article>')).toBe('<div class="board">');
  });

  it('ignores self-closing tags', () => {
    const html = '<div class="board"><input value="x" /><article>row</article></div>';
    expect(openTagOf(html, '<article>')).toBe('<div class="board">');
  });

  it('works for a table body', () => {
    const html = '<table><tbody><tr data-kiln-row="1"><td>a</td></tr></tbody></table>';
    expect(openTagOf(html, 'data-kiln-row')).toBe('<tbody>');
  });

  it('returns null when nothing encloses the index', () => {
    expect(findEnclosingOpenTag('<div>a</div>', 0)).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
bun test packages/routekit/src/live-list-enclosing.test.ts
```

Expected: FAIL — `findEnclosingOpenTag` is not exported.

- [ ] **Step 4: Implement**

Add to `packages/routekit/src/live-list-render.ts`, next to the other tag helpers:

```ts
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'source', 'track', 'wbr',
]);

/** The innermost element enclosing `index`. Unlike findNearestOpenTag this
 * takes no tag name — an explicitly-marked row can sit inside any container,
 * so the container has to be discovered rather than assumed. Scans forward
 * keeping a stack, which is what makes "innermost still-open" correct. */
export function findEnclosingOpenTag(html: string, index: number): Range | null {
  if (index <= 0) return null;
  const tagPattern = /<(\/?)([A-Za-z][A-Za-z0-9:-]*)\b[^>]*?(\/?)>/g;
  const stack: Range[] = [];
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html)) !== null) {
    const openEnd = match.index + match[0].length;
    if (match.index >= index) break;

    const isClosing = match[1] === '/';
    const tagName = match[2]!.toLowerCase();
    const selfClosing = match[3] === '/' || VOID_ELEMENTS.has(tagName);

    if (selfClosing) continue;
    if (isClosing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.tagName === tagName) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    stack.push({ start: match.index, openEnd, end: openEnd, tagName });
  }

  const top = stack[stack.length - 1];
  return top ? { start: top.start, openEnd: top.openEnd, end: top.end } : null;
}
```

`Range` has no `tagName`, so widen the local stack type — declare it as
`Array<Range & { tagName: string }>` and keep the returned object a plain `Range`.

- [ ] **Step 5: Run to verify it passes**

```bash
bun test packages/routekit/src/live-list-enclosing.test.ts
```

Expected: PASS, all 7 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/routekit/src/live-list-render.ts packages/routekit/src/live-list-enclosing.test.ts
git commit -m "feat(routekit): add a tag-agnostic enclosing-element finder"
```

---

### Task 2: Mark explicitly-marked rows in any markup

**Files:**
- Modify: `packages/routekit/src/live-list-render.ts` (`markList`)
- Create: `packages/routekit/src/live-list-any-markup.test.ts`

**Interfaces:**
- Consumes: `findEnclosingOpenTag` (Task 1), the existing `findElementByAttribute`, `readAttribute`, `addAttribute`.
- Produces: no new exports. `applyLiveListMarkers` gains the explicit-marker path.

Contract: the app writes `data-kiln-row={key}` on each row element, where the value equals `String(keyOf(row))`. The server adds `data-kiln-key` (what the client queries) and marks the enclosing element `data-kiln-list`.

- [ ] **Step 1: Write the failing tests**

Create `packages/routekit/src/live-list-any-markup.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { Live } from '@kiln/core';
import { applyLiveListMarkers, extractLiveListRowHtml } from './live-list-render.js';

function listOf(rows: { id: number; title: string }[]) {
  return {
    cards: Live.list<{ id: number; title: string }>({
      key: (r) => r.id,
      initial: rows,
      query: () => rows,
    }),
  };
}

const ROWS = [
  { id: 1, title: 'Alpha' },
  { id: 2, title: 'Beta' },
];

describe('applyLiveListMarkers with explicit data-kiln-row', () => {
  it('marks div rows and their enclosing container', () => {
    const html =
      '<div class="board">' +
      '<article data-kiln-row="1"><h3>Alpha</h3></article>' +
      '<article data-kiln-row="2"><h3>Beta</h3></article>' +
      '</div>';

    const out = applyLiveListMarkers(html, listOf(ROWS), '/board');

    expect(out).toContain('data-kiln-list="cards"');
    expect(out).toContain('data-kiln-key="1"');
    expect(out).toContain('data-kiln-key="2"');
    // The container is the div, not one of the articles.
    expect(/<div class="board"[^>]*data-kiln-list="cards"/.test(out)).toBe(true);
  });

  it('makes rows extractable by the render callback', () => {
    const html =
      '<div class="board">' +
      '<article data-kiln-row="1"><h3>Alpha</h3></article>' +
      '<article data-kiln-row="2"><h3>Beta</h3></article>' +
      '</div>';

    const out = applyLiveListMarkers(html, listOf(ROWS), '/board');
    const extracted = extractLiveListRowHtml(out, 'cards');

    expect([...extracted.keys()].sort()).toEqual(['1', '2']);
    expect(extracted.get('1')).toContain('Alpha');
  });

  it('marks table rows with tbody as the container', () => {
    const html =
      '<table><tbody>' +
      '<tr data-kiln-row="1"><td>Alpha</td></tr>' +
      '<tr data-kiln-row="2"><td>Beta</td></tr>' +
      '</tbody></table>';

    const out = applyLiveListMarkers(html, listOf(ROWS), '/board');

    expect(/<tbody[^>]*data-kiln-list="cards"/.test(out)).toBe(true);
    expect(out).toContain('data-kiln-key="1"');
  });

  it('still marks a plain ul/li list with no explicit markers', () => {
    const html = '<ul><li>Alpha</li><li>Beta</li></ul>';

    const out = applyLiveListMarkers(html, listOf(ROWS), '/board');

    expect(/<ul[^>]*data-kiln-list="cards"/.test(out)).toBe(true);
    expect(out).toContain('data-kiln-key="1"');
  });

  it('ignores a marker whose key matches no row, and warns', () => {
    const html =
      '<div class="board">' +
      '<article data-kiln-row="1"><h3>Alpha</h3></article>' +
      '<article data-kiln-row="99"><h3>Ghost</h3></article>' +
      '</div>';

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warnings.push(String(m));
    let out = '';
    try {
      out = applyLiveListMarkers(html, listOf(ROWS), '/board');
    } finally {
      console.warn = original;
    }

    expect(out).toContain('data-kiln-key="1"');
    expect(out).not.toContain('data-kiln-key="99"');
    expect(warnings.some((w) => w.includes('data-kiln-row'))).toBe(true);
  });

  it('does not double-mark a container that is already marked', () => {
    const html =
      '<div class="board" data-kiln-list="cards">' +
      '<article data-kiln-row="1"><h3>Alpha</h3></article>' +
      '</div>';

    const out = applyLiveListMarkers(html, { cards: listOf(ROWS).cards }, '/board');

    expect(out.match(/data-kiln-list="cards"/g)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/routekit/src/live-list-any-markup.test.ts
```

Expected: the div, table, mismatch and already-marked tests FAIL (rows are found only by `<li>` today). The `ul/li` test passes already — that is the regression guard.

- [ ] **Step 3: Implement the explicit path**

In `packages/routekit/src/live-list-render.ts`, add the import for `warnOnce`:

```ts
import { warnOnce } from './dedup.js';
```

Add a function that collects explicitly-marked rows:

```ts
/** Rows the app marked itself with data-kiln-row={key}. Returns null when the
 * page uses no markers at all, so the caller falls back to the <li> scan. */
function findMarkedRows(
  html: string,
  target: ListRenderTarget,
): { row: unknown; range: Range }[] | null {
  const byKey = new Map<string, unknown>();
  for (const row of target.rows) byKey.set(target.keyOf(row), row);

  const matches: { row: unknown; range: Range }[] = [];
  let sawMarker = false;
  let offset = 0;

  while (offset < html.length) {
    const found = findElementByAttribute(html, 'data-kiln-row', undefined, offset);
    if (!found) break;
    sawMarker = true;
    const key = readAttribute(html.slice(found.start, found.openEnd), 'data-kiln-row');
    const row = key === null ? undefined : byKey.get(key);
    if (row !== undefined) {
      matches.push({ row, range: { start: found.start, openEnd: found.openEnd, end: found.end } });
    } else if (key !== null) {
      warnOnce(
        `live-list-row-key:${target.name}:${key}`,
        `[kiln] Live.list "${target.name}" has an element with data-kiln-row="${key}" that matches ` +
          `no row key. The value must equal the list's key(row) — that element will not update.`,
      );
    }
    offset = found.end;
  }

  return sawMarker ? matches : null;
}
```

Then rewrite `markList` to try the explicit path first, keeping the existing behaviour as the fallback:

```ts
function markList(html: string, target: ListRenderTarget, route?: string): string {
  const marked = findMarkedRows(html, target);

  let rowMatches: { row: unknown; range: Range }[];
  if (marked !== null) {
    if (marked.length === 0) return html;
    rowMatches = marked;
  } else {
    rowMatches = [];
    let searchFrom = 0;
    for (const row of target.rows) {
      const range = findMatchingRow(html, row, searchFrom);
      if (!range) return html;
      rowMatches.push({ row, range });
      searchFrom = range.end;
    }
  }

  let result = html;
  for (const match of [...rowMatches].reverse()) {
    const markedRow = markRowFields(
      addAttribute(result.slice(match.range.start, match.range.end), "data-kiln-key", target.keyOf(match.row)),
      match.row,
    );
    result = result.slice(0, match.range.start) + markedRow + result.slice(match.range.end);
  }

  // Explicitly-marked rows can sit in any container, so discover it; the <li>
  // path keeps looking for the ul/ol it has always assumed.
  const firstRowStart = rowMatches[0]!.range.start;
  const listOpen =
    marked !== null
      ? findEnclosingOpenTag(result, firstRowStart)
      : findNearestOpenTag(result, "ul", firstRowStart) ?? findNearestOpenTag(result, "ol", firstRowStart);
  if (!listOpen || result.slice(listOpen.start, listOpen.openEnd).includes("data-kiln-list=")) {
    return result;
  }

  let markedOpen = addAttribute(result.slice(listOpen.start, listOpen.openEnd), "data-kiln-list", target.name);
  if (route) {
    markedOpen = addAttribute(markedOpen, "data-kiln-live", route);
  }
  return result.slice(0, listOpen.start) + markedOpen + result.slice(listOpen.openEnd);
}
```

Note `addAttribute` is applied to the row's full element slice (`start`..`end`), which is how the existing code already marks `<li>` rows — it edits the open tag inside that slice.

- [ ] **Step 4: Run to verify it passes**

```bash
bun test packages/routekit/src/live-list-any-markup.test.ts
```

Expected: PASS, all 6 tests.

- [ ] **Step 5: Full suite**

```bash
bun run test:unit && bun run build
```

Expected: green, including the existing `live-list-render.test.ts` — the `<li>` path must be untouched.

- [ ] **Step 6: Commit**

```bash
git add packages/routekit/src/live-list-render.ts packages/routekit/src/live-list-any-markup.test.ts
git commit -m "feat(routekit): mark Live.list rows in any markup via data-kiln-row"
```

---

### Task 3: Make table inserts survive the client parser

`_patchList` builds new rows with `document.createElement('div')` + `innerHTML`. A `<tr>` parsed inside a `<div>` is **discarded** by the HTML parser, so inserts and replacements into a `<tbody>` would silently no-op. `<template>` parses table fragments correctly.

**Files:**
- Modify: `packages/routekit/src/live-client-script.ts` (the `insert` and `replace-row` branches)
- Modify: `packages/routekit/src/live-client.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `packages/routekit/src/live-client.test.ts`, following the file's existing pattern for exercising the script:

```ts
describe('list row parsing', () => {
  it('parses a <tr> fragment, which a div wrapper would discard', () => {
    // Documents why the client uses <template>: a div drops table-context
    // elements outright, so table-backed Live.lists would silently never
    // insert or replace rows.
    const div = document.createElement('div');
    div.innerHTML = '<tr data-kiln-key="1"><td>Alpha</td></tr>';
    expect(div.firstElementChild).toBeNull();

    const tpl = document.createElement('template');
    tpl.innerHTML = '<tr data-kiln-key="1"><td>Alpha</td></tr>';
    expect(tpl.content.firstElementChild?.tagName).toBe('TR');
  });
});
```

If `live-client.test.ts` has no DOM available, put this in whichever test file in `packages/routekit/src` already sets up a DOM; check the top of `live-client.test.ts` first and follow what it does rather than introducing a new DOM setup.

- [ ] **Step 2: Run it**

```bash
bun test packages/routekit/src/live-client.test.ts
```

Expected: PASS — this test documents browser behaviour rather than framework behaviour, and is the justification for Step 3.

- [ ] **Step 3: Switch both branches to `<template>`**

In `packages/routekit/src/live-client-script.ts`, in the `insert` branch replace:

```js
    var box=document.createElement('div');
    box.innerHTML=data.html;
    var node=box.firstElementChild;
```

with:

```js
    var box=document.createElement('template');
    box.innerHTML=data.html;
    var node=box.content.firstElementChild;
```

and in the `replace-row` branch replace:

```js
    var replaceBox=document.createElement('div');
    replaceBox.innerHTML=data.html;
    var replaceNode=replaceBox.firstElementChild;
```

with:

```js
    var replaceBox=document.createElement('template');
    replaceBox.innerHTML=data.html;
    var replaceNode=replaceBox.content.firstElementChild;
```

Add a comment above the first one:

```js
  // <template> not <div>: a div drops table-context elements (<tr>, <td>)
  // during parsing, so a table-backed Live.list would silently never insert.
```

- [ ] **Step 4: Full suite and build**

```bash
bun run test:unit && bun run build
```

- [ ] **Step 5: Commit**

```bash
git add packages/routekit/src/live-client-script.ts packages/routekit/src/live-client.test.ts
git commit -m "fix(routekit): parse live list rows with <template> so table rows survive"
```

---

### Task 4: Documentation and memory

**Files:**
- Modify: `docs/agents/live-and-islands.md` (or whichever agent doc documents `Live.list`)
- Modify: `.memory/bugs-active.md`, `.memory/bugs-resolved.md`, `.memory/active-work.md`
- Modify: `.codebase-memory/adr.md`

- [ ] **Step 1: Find the docs that state the constraint**

```bash
grep -rn "ul\|li>\|Live.list" docs/agents/*.md | grep -i "list" | head -20
```

Document the opt-in: put `data-kiln-row={row.id}` on each row element, where the value matches the list's `key(row)`; Kiln marks the enclosing element as the list container and adds the keys the client patches against. Without markers the existing `<ul>`/`<li>` convention still applies. Include a div-board and a table example.

- [ ] **Step 2: Update the bug records**

Move the "`Live.list` cannot mark non-`<ul>/<li>` markup" entry from `.memory/bugs-active.md` §1 to `.memory/bugs-resolved.md`, noting the `data-kiln-row` opt-in, the retained `<li>` fallback, and the `<template>` client fix that makes tables work.

- [ ] **Step 3: Amend the ADR**

Add to the `Live.list` ADR (ADR-018's list section, or wherever list markers are specified) that rows may be located either by an explicit `data-kiln-row` marker or by the legacy `<li>` scan, and that the container is discovered from the marked rows rather than assumed to be `<ul>`/`<ol>`.

- [ ] **Step 4: Update the sequence**

In `.memory/active-work.md`, strike the markup constraint from the `Live.list` cluster and name the next item. Note that `docs/superpowers/plans/2026-07-31-framework-fix-sequencing.md` lives on the `docs/framework-fix-sequencing` branch and must be updated there, not here.

- [ ] **Step 5: Verify and commit**

```bash
bun run test:unit && bun run test:integration && bun run build
```

```bash
git add -A .memory .codebase-memory docs
git commit -m "docs: record Live.list any-markup support"
```

---

## Finishing

Push and open a PR against `main` — no menu, per standing preference.

**Conflicts:** `live-list-render.ts` and `live-client-script.ts` are touched by none of the four open PRs (#31, #32, #33, #34). The `.memory` files are touched by all of them, so expect a docs-only conflict there.
