/**
 * Plan 3b: the board page must BAKE, which means its load() reads neither
 * identity (req.locals) nor req.query. Both mark the render impure, and under
 * ADR-016 'auto' the demotion LATCHES for the whole process lifetime — one
 * impure read and the route never bakes again until restart.
 *
 * Also covers optimistic concurrency on ?/moveTask and the store-target
 * boardState field the island reads.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SPAWN_APP } from './spawn-app.js';
import { auth, createAppUser } from '../lib/auth.js';
import { sql } from '../db/client.js';

// 3294-3299 are claimed by gate/live/freshness/purity/crud/app.
const PORT = 3292;
const BASE = `http://localhost:${PORT}`;
const MEMBER = {
  email: 'board-member@example.com',
  password: 'password-123',
  handle: 'boardmember',
};
const run = process.env.RUN_APP_TESTS === '1';
let proc: ReturnType<typeof Bun.spawn> | null = null;
let projectId = 0;
let columnId = 0;
let doneColumnId = 0;
let taskId = 0;
let memberId = '';
let cookie = '';

async function cookieFor(email: string, password: string): Promise<string> {
  const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

/** Reads SSE frames until `match` is satisfied or the deadline passes. */
async function waitForSseFrame(
  url: string,
  match: (chunk: string) => boolean,
  timeoutMs = 20_000,
): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { cookie, accept: 'text/event-stream' },
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      if (match(buffer)) return buffer;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function postMove(body: Record<string, string>): Promise<Response> {
  return fetch(`${BASE}/projects/${projectId}/board?/moveTask`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      origin: BASE,
      cookie,
    },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
}

describe.skipIf(!run)('board page — bakeable, versioned moves, live state', () => {
  beforeAll(async () => {
    await sql`DELETE FROM "user" WHERE email = ${MEMBER.email}`;
    await createAppUser({
      email: MEMBER.email,
      password: MEMBER.password,
      name: 'Board Member',
      role: 'user',
      handle: MEMBER.handle,
    });
    const [u] = await sql`SELECT id FROM "user" WHERE email = ${MEMBER.email}`;
    memberId = u.id;

    const [p] = await sql`INSERT INTO projects (name, description, created_by)
      VALUES ('Board Island Project', '', ${memberId}) RETURNING id::int`;
    projectId = p.id;
    const [c] = await sql`INSERT INTO columns (project_id, name, position)
      VALUES (${projectId}, 'Todo', 1000) RETURNING id::int`;
    columnId = c.id;
    const [d] = await sql`INSERT INTO columns (project_id, name, position)
      VALUES (${projectId}, 'Doing', 2000) RETURNING id::int`;
    doneColumnId = d.id;
    const [t] = await sql`INSERT INTO tasks (project_id, column_id, title, position, created_by)
      VALUES (${projectId}, ${columnId}, 'Drag me', 1000, ${memberId}) RETURNING id::int`;
    taskId = t.id;

    proc = Bun.spawn(SPAWN_APP, {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, PORT: String(PORT), BETTER_AUTH_URL: BASE } as Record<string, string>,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${BASE}/login`)).ok) break; } catch {}
      await Bun.sleep(100);
    }
    cookie = await cookieFor(MEMBER.email, MEMBER.password);
  }, 30_000);

  afterAll(async () => {
    proc?.kill();
    await proc?.exited;
    await sql`DELETE FROM projects WHERE id = ${projectId}`;
    await sql`DELETE FROM "user" WHERE email = ${MEMBER.email}`;
    await sql.close();
  });

  it('still gates anonymous access to the board', async () => {
    const res = await fetch(`${BASE}/projects/${projectId}/board`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('serves an identical artifact with and without ?error', async () => {
    // Warm the route first. On a cold route the bake is written AFTER the
    // response goes out, so back-to-back requests each render live and would
    // differ on any per-render value (dnd-kit's aria id counter, here) —
    // comparing them would race the bake rather than test load() purity.
    await fetch(`${BASE}/projects/${projectId}/board`, { headers: { cookie } });
    await Bun.sleep(300);

    const plain = await (await fetch(`${BASE}/projects/${projectId}/board`,
      { headers: { cookie } })).text();
    const withErr = await (await fetch(`${BASE}/projects/${projectId}/board?error=title`,
      { headers: { cookie } })).text();
    expect(withErr).toBe(plain);
    // The banner ships hidden and empty in the shared artifact; the inline
    // script fills it from location.search on the client. (Its message
    // strings appear in that script's source, so assert on the element.)
    expect(plain).toMatch(/<p class="error" data-form-error="true" hidden=""><\/p>/);
  });

  it('rejects a move carrying a stale expected version', async () => {
    const [before] = await sql`SELECT version FROM tasks WHERE id = ${taskId}`;
    const stale = Number(before.version) - 1;
    const res = await postMove({
      task_id: String(taskId),
      column_id: String(doneColumnId),
      expected_version: String(stale),
    });
    expect(res.status).toBe(409);
  });

  it('accepts a move carrying the current version', async () => {
    const [cur] = await sql`SELECT version FROM tasks WHERE id = ${taskId}`;
    const res = await postMove({
      task_id: String(taskId),
      column_id: String(doneColumnId),
      expected_version: String(cur.version),
    });
    expect(res.status).toBeLessThan(400);
    const [after] = await sql`SELECT column_id::int, version FROM tasks WHERE id = ${taskId}`;
    expect(after.column_id).toBe(doneColumnId);
    expect(Number(after.version)).toBe(Number(cur.version) + 1);
  });

  it('still moves a task when no expected version is supplied (JS-free path)', async () => {
    const res = await postMove({
      task_id: String(taskId),
      column_id: String(columnId),
    });
    expect(res.status).toBeLessThan(400);
    const [after] = await sql`SELECT column_id::int FROM tasks WHERE id = ${taskId}`;
    expect(after.column_id).toBe(columnId);
  });

  it('declares board state as a store-target field with no DOM slot', async () => {
    const html = await (await fetch(`${BASE}/projects/${projectId}/board`,
      { headers: { cookie } })).text();
    // Store-target fields deliberately get NO s-live slot — their names ride
    // on the page wrapper so the SSE subscription still covers them.
    expect(html).not.toContain('s-live="boardState"');
    expect(html).toContain('data-kiln-live-store');
    expect(html).toContain('boardState');
  });

  it('mounts the board island with its bake-time state', async () => {
    const html = await (await fetch(`${BASE}/projects/${projectId}/board`,
      { headers: { cookie } })).text();
    expect(html).toContain('data-kiln-island="BoardIsland"');
    // SSR'd inside the island, so the JS-free baseline still shows the board.
    expect(html).toContain('Drag me');
    // The bake-time props the island hydrates against.
    expect(html).toContain('data-kiln-props');
    // Bootstrap script that finds islands and hydrates them.
    expect(html).toContain('/_silcrow/islands.js');
  });

  it('resolves the island to a chunk the browser can actually fetch', async () => {
    // The full pipeline: `kiln build` bundles islands/BoardIsland.tsx, the
    // manifest maps the NAME to a hashed chunk (so week-old baked HTML
    // hydrates against today's build), and `kiln start` serves it.
    const manifestRes = await fetch(`${BASE}/_kiln/islands.json`);
    expect(manifestRes.status).toBe(200);
    const manifest = await manifestRes.json() as { islands: Record<string, string> };
    const chunkUrl = manifest.islands?.BoardIsland;
    expect(chunkUrl).toBeTruthy();

    const chunkRes = await fetch(BASE + chunkUrl);
    expect(chunkRes.status).toBe(200);
    const chunk = await chunkRes.text();
    // preserveEntrySignatures:'exports-only' must keep the wrapper's export —
    // without it the chunk is a hollow react-only bundle at runtime.
    expect(chunk).toContain('hydrate');
  });

  it('pushes new board state to a subscriber when someone else moves a task', async () => {
    // The whole point of the store-target field: a second member watching
    // this board gets the move without reloading. Bake + register first, then
    // subscribe, THEN write — so the patch cannot land before we listen.
    const route = `/projects/${projectId}/board`;
    await fetch(BASE + route, { headers: { cookie } });

    const sseUrl = `${BASE}/__kiln/fsr?route=${encodeURIComponent(route)}&slots=boardState`;
    const framePromise = waitForSseFrame(sseUrl, (buf) => buf.includes('Moved by someone else'));

    await Bun.sleep(500); // let the subscription establish
    await sql`UPDATE tasks SET title = 'Moved by someone else', column_id = ${doneColumnId},
      version = version + 1 WHERE id = ${taskId}`;

    // patchDebounceSecs is 5 in kiln.config.ts — do not shorten this timeout.
    const frame = await framePromise;
    expect(frame).not.toBeNull();
  }, 45_000);
});
