/**
 * `registerRaw` — the escape hatch that lets an app keep `kiln dev`/`kiln
 * start` instead of hand-building an entry point just to mount, say, a
 * third-party auth catch-all.
 *
 * The contract that matters: the handler receives the untouched Request and
 * the app's hooks.ts `handle` hook does NOT run for it (a sign-in endpoint
 * has to be reachable without a session).
 */
import { describe, expect, it } from 'bun:test';
import { ElysiaAdapter } from './adapter.js';

describe('ElysiaAdapter.registerRaw', () => {
  it('mounts a handler that gets the raw Request and returns its Response', async () => {
    const adapter = new ElysiaAdapter();
    adapter.registerRaw('/api/auth/*', (request) =>
      Response.json({ path: new URL(request.url).pathname, method: request.method }),
    );

    const res = await adapter.app.handle(
      new Request('http://localhost/api/auth/sign-in', { method: 'POST' }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: '/api/auth/sign-in', method: 'POST' });
  });

  it('answers every method by default', async () => {
    const adapter = new ElysiaAdapter();
    adapter.registerRaw('/hook', (request) => new Response(request.method));

    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await adapter.app.handle(new Request('http://localhost/hook', { method }));
      expect(await res.text()).toBe(method);
    }
  });

  it('restricts to one method when asked', async () => {
    const adapter = new ElysiaAdapter();
    adapter.registerRaw('/webhook', () => new Response('ok'), { method: 'POST' });

    const posted = await adapter.app.handle(
      new Request('http://localhost/webhook', { method: 'POST' }),
    );
    expect(await posted.text()).toBe('ok');

    const got = await adapter.app.handle(new Request('http://localhost/webhook'));
    expect(got.status).toBe(404);
  });

  it('does not run the app handle hook — that is the whole point', async () => {
    const adapter = new ElysiaAdapter();
    let handleRan = false;
    // Same shape applyServerHooks installs.
    (adapter as any).appHandle = async () => {
      handleRan = true;
    };
    adapter.registerRaw('/api/auth/*', () => new Response('public'));

    const res = await adapter.app.handle(new Request('http://localhost/api/auth/session'));

    expect(await res.text()).toBe('public');
    expect(handleRan).toBe(false);
  });
});
