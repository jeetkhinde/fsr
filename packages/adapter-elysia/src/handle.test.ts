import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ElysiaAdapter } from './adapter.js';

// A hooks.ts fixture exporting `handle`: gates /protected unless an x-user
// header is present, and otherwise populates req.locals.user. Written to a
// temp dir so applyServerHooks loads it through the real code path.
const HOOKS = `
import type { KilnRequest, KilnResponse } from '@kiln/core';
export function handle(req: KilnRequest, res: KilnResponse) {
  if (req.path === '/protected' && !req.headers.get('x-user')) {
    res.redirect('/login', 302);
    return;
  }
  req.locals.user = { id: 'u1', name: 'Ada' };
}
`;

describe('ElysiaAdapter app handle hook', () => {
  let dir: string;
  let adapter: ElysiaAdapter;
  let pageRan = false;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-handle-'));
    await fs.writeFile(path.join(dir, 'hooks.ts'), HOOKS);

    adapter = new ElysiaAdapter();
    await adapter.applyServerHooks!(dir);

    adapter.registerPage('/protected', [], async (req, res) => {
      pageRan = true;
      res.json({ user: req.locals.user });
    });
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('populates req.locals for the page handler when handle allows the request', async () => {
    pageRan = false;
    const res = await adapter.app.handle(
      new Request('http://localhost/protected', { headers: { 'x-user': '1' } })
    );
    expect(res.status).toBe(200);
    expect(pageRan).toBe(true);
    const body = (await res.json()) as { user?: { id: string } };
    expect(body.user?.id).toBe('u1');
  });

  it('short-circuits (redirect) without running the page handler when handle denies', async () => {
    pageRan = false;
    const res = await adapter.app.handle(
      new Request('http://localhost/protected', { redirect: 'manual' })
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
    expect(pageRan).toBe(false);
  });

  it('gates an SSE route via handle (short-circuits before streaming)', async () => {
    // Reuse the same gating fixture: /protected is denied without x-user.
    // Register it as SSE this time to prove registerSSE also runs handle.
    adapter.registerSSE('/sse', async (_req, res) => {
      res.sse(
        (async function* () {
          yield { data: 'should-not-emit' };
        })()
      );
    });
    // Fixture only gates '/protected'; use a handle that denies '/sse'.
    const denyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-sse-'));
    await fs.writeFile(
      path.join(denyDir, 'hooks.ts'),
      `export function handle(req, res) {
        if (!req.headers.get('x-user')) { res.redirect('/login', 302); return; }
        req.locals.user = { id: 'u1' };
      }`
    );
    const sseAdapter = new ElysiaAdapter();
    await sseAdapter.applyServerHooks!(denyDir);
    let streamed = false;
    sseAdapter.registerSSE('/sse', async (_req, res) => {
      streamed = true;
      res.sse(
        (async function* () {
          yield { data: 'hello' };
        })()
      );
    });
    const denied = await sseAdapter.app.handle(
      new Request('http://localhost/sse', { redirect: 'manual' })
    );
    expect(denied.status).toBe(302);
    expect(denied.headers.get('location')).toBe('/login');
    expect(streamed).toBe(false);
    await fs.rm(denyDir, { recursive: true, force: true });
  });

  it('initializes locals to an object even with no handle set', async () => {
    const bare = new ElysiaAdapter();
    let seen: unknown = 'unset';
    bare.registerPage('/x', [], async (req, res) => {
      seen = req.locals;
      res.json({ ok: true });
    });
    await bare.app.handle(new Request('http://localhost/x'));
    expect(seen).toEqual({});
  });
});
