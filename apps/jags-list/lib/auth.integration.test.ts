import { afterAll, describe, expect, it } from 'bun:test';
import { auth, createAppUser } from './auth.js';
import { sql } from '../db/client.js';

const EMAIL = 'auth-itest@example.com';

describe.skipIf(!process.env.DATABASE_URL)('better-auth integration', () => {
  afterAll(async () => {
    await sql`DELETE FROM "user" WHERE email = ${EMAIL}`;
    await sql.close();
  });

  it('creates a user with role + handle, signs in, resolves the session', async () => {
    await sql`DELETE FROM "user" WHERE email = ${EMAIL}`;
    await createAppUser({
      email: EMAIL,
      password: 'itest-password-1',
      name: 'ITest',
      role: 'member',
      handle: 'itest',
    });

    const res = await auth.api.signInEmail({
      body: { email: EMAIL, password: 'itest-password-1' },
      asResponse: true,
    });
    expect(res.status).toBe(200);
    const cookies = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    expect(cookies).toContain('better-auth');

    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookies }),
    });
    expect(session?.user.email).toBe(EMAIL);
    expect((session?.user as any).handle).toBe('itest');
    expect((session?.user as any).role).toBe('member');
  });

  it('rejects public sign-up (disableSignUp)', async () => {
    const res = await auth.handler(
      new Request('http://localhost:3200/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'signup-blocked@example.com',
          password: 'whatever-123',
          name: 'Blocked',
        }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
