import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';

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
