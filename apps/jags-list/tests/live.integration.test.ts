// The ADR-018 end-to-end proof: a real INSERT, through the real
// kiln_emit_event trigger installed by `kiln sync-triggers`, over real
// LISTEN/NOTIFY to the running app's embedded FsrWatcher, out to a real
// subscribed SSE client — with NO manual dep wiring beyond the list's own
// dependsOn: 'activity'.
//
// Before this suite existed, auto-deps was proven only at the
// capture/trigger/watcher layer; no page in any app declared a live field,
// so nothing exercised the whole chain. See .memory/bugs-active.md.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SPAWN_APP } from './spawn-app.js';
import { fileURLToPath } from 'node:url';
import { auth, createAppUser } from '../lib/auth.js';
import { sql } from '../db/client.js';

const PORT = 3295;
const BASE = `http://localhost:${PORT}`;
const MEMBER = { email: 'live-member@example.com', password: 'password-123', handle: 'livemember' };
const run = process.env.RUN_APP_TESTS === '1';
let proc: ReturnType<typeof Bun.spawn> | null = null;
let projectId = 0;
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

describe.skipIf(!run)('live drill — activity insert reaches an SSE subscriber', () => {
  beforeAll(async () => {
    // sync-triggers is idempotent; run it so this suite is self-contained.
    const cliPath = fileURLToPath(new URL('../../../packages/cli/dist/cli.js', import.meta.url));
    const appDir = fileURLToPath(new URL('..', import.meta.url));
    const sync = Bun.spawnSync(['bun', cliPath, 'sync-triggers'], {
      cwd: appDir,
      env: process.env as Record<string, string>,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (sync.exitCode !== 0) throw new Error(`kiln sync-triggers exited ${sync.exitCode}`);

    await sql`DELETE FROM "user" WHERE email = ${MEMBER.email}`;
    await createAppUser({
      email: MEMBER.email,
      password: MEMBER.password,
      name: 'Live Member',
      role: 'user',
      handle: MEMBER.handle,
    });
    const [u] = await sql`SELECT id FROM "user" WHERE email = ${MEMBER.email}`;
    memberId = u.id;

    const [p] = await sql`
      INSERT INTO projects (name, description, created_by)
      VALUES ('Live Drill Project', '', ${memberId}) RETURNING id::int`;
    projectId = p.id;
    // Seed before boot so the first render bakes a NON-empty, marked list.
    await sql`
      INSERT INTO activity (project_id, actor_id, verb, payload)
      VALUES (${projectId}, ${memberId}, 'plan3a.seed', '{}'::jsonb)`;

    proc = Bun.spawn(SPAWN_APP, {
      cwd: appDir,
      env: { ...process.env, PORT: String(PORT) } as Record<string, string>,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${BASE}/login`)).ok) break; } catch {}
      await Bun.sleep(100);
    }
    cookie = await cookieFor(MEMBER.email, MEMBER.password);
  }, 60_000);

  afterAll(async () => {
    // kill() only signals — await exited, or the port outlives this file.
    proc?.kill();
    await proc?.exited;
    await sql`DELETE FROM projects WHERE id = ${projectId}`;
    await sql`DELETE FROM "user" WHERE email = ${MEMBER.email}`;
    // Deliberately no sql.close() here — see db/client.ts.
  });

  it('delivers a patch for a row inserted after the page was baked', async () => {
    const route = `/projects/${projectId}/activity`;
    // 1. Render once so the route bakes and its Live.list registers.
    const first = await fetch(BASE + route, { headers: { cookie } });
    expect(await first.text()).toContain('data-kiln-list="events"');

    // 2. Subscribe, THEN write — so the patch cannot land before we listen.
    const sseUrl = `${BASE}/__kiln/fsr?route=${encodeURIComponent(route)}&slots=events`;
    const framePromise = waitForSseFrame(sseUrl, (buf) => buf.includes('plan3a.livedrill'));

    await Bun.sleep(500); // let the subscription establish
    await sql`
      INSERT INTO activity (project_id, actor_id, verb, payload)
      VALUES (${projectId}, ${memberId}, 'plan3a.livedrill', '{}'::jsonb)`;

    const frame = await framePromise;
    expect(frame).not.toBeNull();
  }, 45_000);
});
