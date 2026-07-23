// Guards the bake classifier: a session-reading page must never serve one
// user's render to another, no matter how many hits the route takes.
// Regression test for the framework bug "absent promote_after is not pure
// SSR" (resolved by ADR-016 bake classes): under promote-after-2, hit 3+ of
// "/" served whichever user's render got baked to every subsequent viewer.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import { RedisClient } from 'bun';
import { sql } from '../db/client.js';
import { createAppUser } from '../lib/auth.js';
import { auth } from '../lib/auth.js';

const PORT = 3297;
const BASE = `http://localhost:${PORT}`;
const TOM = { email: 'purity-tom@example.com', password: 'password-123', handle: 'puritytom' };
const ADAM = { email: 'purity-adam@example.com', password: 'password-123', handle: 'purityadam' };
const run = process.env.RUN_APP_TESTS === '1';
let proc: ReturnType<typeof Bun.spawn> | null = null;
let tomCookie = '';
let adamCookie = '';

async function cookieFor(email: string, password: string): Promise<string> {
  const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

describe.skipIf(!run)('cross-user render isolation', () => {
  beforeAll(async () => {
    // Hermetic cache state: artifacts baked by a previous app generation
    // (including pre-ADR-016 promote-after-2 bakes) must not leak into this
    // run — the framework trusts artifact presence, so stale-generation
    // artifacts in Redis/disk would be served as-is. Real deploys of a
    // breaking cache change need the same flush (see rendering-and-caching
    // docs); this app runs on a dedicated Redis logical DB (.env: /3).
    await rm(new URL('../.kiln-cache', import.meta.url).pathname, { recursive: true, force: true });
    const redis = new RedisClient(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
    const keys = (await redis.send('KEYS', ['kiln:*'])) as string[];
    if (Array.isArray(keys) && keys.length > 0) await redis.send('DEL', keys);
    redis.close();

    for (const u of [TOM, ADAM]) await sql`DELETE FROM "user" WHERE email = ${u.email}`;
    await createAppUser({ ...TOM, name: 'Purity Tom', role: 'user' });
    await createAppUser({ ...ADAM, name: 'Purity Adam', role: 'user' });
    proc = Bun.spawn(['bun', 'src/main.ts'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, PORT: String(PORT), BETTER_AUTH_URL: BASE },
      stdout: 'inherit', stderr: 'inherit',
    });
    for (let i = 0; i < 75; i++) {
      try { if ((await fetch(`${BASE}/login`)).ok) break; } catch {}
      await Bun.sleep(200);
    }
    tomCookie = await cookieFor(TOM.email, TOM.password);
    adamCookie = await cookieFor(ADAM.email, ADAM.password);
  }, 30_000);

  afterAll(async () => {
    proc?.kill();
    for (const u of [TOM, ADAM]) await sql`DELETE FROM "user" WHERE email = ${u.email}`;
    await sql.close();
  });

  it("never serves one user's home render to the other, on any hit", async () => {
    // 4 alternating hits per user. Since ADR-017 the home page is bake='user':
    // hit 1 bakes each user's own artifact, hits 2+ serve it from cache — this
    // loop now proves per-user CACHE isolation, not just SSR isolation.
    for (let hit = 0; hit < 4; hit++) {
      const tomHtml = await (await fetch(BASE + '/', { headers: { cookie: tomCookie } })).text();
      const adamHtml = await (await fetch(BASE + '/', { headers: { cookie: adamCookie } })).text();
      expect(tomHtml).toContain('Purity Tom');
      expect(tomHtml).not.toContain('Purity Adam');
      expect(adamHtml).toContain('Purity Adam');
      expect(adamHtml).not.toContain('Purity Tom');
    }
  });

  it("bakes one artifact per user under the variant cache dir, never a shared one", async () => {
    const { readdir } = await import('node:fs/promises');
    const variantDir = new URL('../.kiln-cache/index/_v', import.meta.url).pathname;
    const variants = await readdir(variantDir);
    expect(variants.length).toBe(2); // exactly tom's and adam's u:<id> variants
    // the shared (non-variant) artifact must NOT exist — that would be the old leak
    const sharedHtml = Bun.file(new URL('../.kiln-cache/index/index.html', import.meta.url).pathname);
    expect(await sharedHtml.exists()).toBe(false);
  });
});
