import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ElysiaAdapter } from './adapter.js';

// Guards the assumption applyHeaders() is built on: Elysia accepts a string[]
// at set.headers['set-cookie'] and expands it into one header per entry. If a
// future Elysia upgrade breaks this, this test fails loudly rather than
// silently collapsing two cookies into one.
describe('Elysia multi-value Set-Cookie', () => {
  it('emits one Set-Cookie header per array entry', async () => {
    const app = new Elysia().get('/two', (ctx: any) => {
      ctx.set.headers['set-cookie'] = ['a=1; Path=/', 'b=2; Path=/'];
      return { ok: true };
    });

    const res = await app.handle(new Request('http://localhost/two'));
    const cookies = res.headers.getSetCookie();

    expect(cookies).toHaveLength(2);
    expect(cookies).toContain('a=1; Path=/');
    expect(cookies).toContain('b=2; Path=/');
  });

  it('still emits a single Set-Cookie when given a plain string', async () => {
    const app = new Elysia().get('/one', (ctx: any) => {
      ctx.set.headers['set-cookie'] = 'a=1; Path=/';
      return { ok: true };
    });

    const res = await app.handle(new Request('http://localhost/one'));
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/']);
  });
});

describe('ElysiaAdapter response cookies', () => {
  it('emits every cookie an action set, through the real adapter path', async () => {
    const adapter = new ElysiaAdapter();
    adapter.registerPage('/set', [], async (_req, res) => {
      res.cookies.set('sid', 'abc', { httpOnly: true, path: '/' });
      res.cookies.set('theme', 'dark');
      res.headers.set('x-custom', 'yes');
      res.json({ ok: true });
    });

    const res = await adapter.app.handle(new Request('http://localhost/set'));
    const cookies = res.headers.getSetCookie();

    expect(cookies).toHaveLength(2);
    expect(cookies).toContain('sid=abc; Path=/; HttpOnly');
    expect(cookies).toContain('theme=dark; Path=/');
    expect(res.headers.get('x-custom')).toBe('yes');
  });

  it('keeps cookies on a redirect response', async () => {
    const adapter = new ElysiaAdapter();
    adapter.registerPage('/bye', [], async (_req, res) => {
      res.cookies.delete('sid');
      res.redirect('/login');
    });

    const res = await adapter.app.handle(
      new Request('http://localhost/bye', { redirect: 'manual' }),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login');
    expect(res.headers.getSetCookie()).toEqual(['sid=; Path=/; Max-Age=0']);
  });
});
