import { afterAll, describe, expect, it } from 'bun:test';
import { sql } from './client.js';
import { createInvite, findValidInvite, markInviteUsed } from './invites.js';

const CLEANUP_EMAILS = ['invitee-itest@example.com', 'accept-itest@example.com'];

describe.skipIf(!process.env.DATABASE_URL)('invites', () => {
  afterAll(async () => {
    // bun's SQL binds a JS array as a malformed Postgres array literal in
    // ANY(); delete per-email instead.
    for (const email of CLEANUP_EMAILS) {
      await sql`DELETE FROM invites WHERE email = ${email}`;
      await sql`DELETE FROM "user" WHERE email = ${email}`;
    }
    await sql.close();
  });

  it('creates and resolves a valid invite', async () => {
    const invite = await createInvite('invitee-itest@example.com', 'member', 'itest-admin');
    expect(invite.token.length).toBeGreaterThanOrEqual(24);
    const found = await findValidInvite(invite.token);
    expect(found?.email).toBe('invitee-itest@example.com');
    expect(found?.role).toBe('member');
  });

  it('a used invite stops resolving', async () => {
    const invite = await createInvite('invitee-itest@example.com', 'member', 'itest-admin');
    await markInviteUsed(invite.token);
    expect(await findValidInvite(invite.token)).toBeNull();
  });

  it('an expired invite stops resolving', async () => {
    const invite = await createInvite('invitee-itest@example.com', 'member', 'itest-admin');
    await sql`UPDATE invites SET expires_at = NOW() - INTERVAL '1 hour' WHERE token = ${invite.token}`;
    expect(await findValidInvite(invite.token)).toBeNull();
  });

  it('accept action creates the user with the invite role and handle, single-use', async () => {
    const { actions } = await import('../pages/invite/[token].js');
    const invite = await createInvite('accept-itest@example.com', 'admin', 'itest-admin');

    const fakeReq = (form: Record<string, string>): any => ({
      path: `/invite/${invite.token}`,
      method: 'POST',
      params: { token: invite.token },
      query: {},
      headers: new Headers(),
      formData: async () => {
        const f = new FormData();
        for (const [k, v] of Object.entries(form)) f.set(k, v);
        return f;
      },
      json: async () => ({}),
      isEnhanced: false,
      layoutsPresent: [],
      prebakeNext: () => {},
    });

    // happy path redirects to /login?welcome=1
    await expect(
      actions.accept(fakeReq({ name: 'Accept Test', handle: 'accepttest', password: 'password-123' })),
    ).rejects.toMatchObject({ type: 'Redirect', message: '/login?welcome=1' });

    const [user] = await sql`SELECT role, handle FROM "user" WHERE email = 'accept-itest@example.com'`;
    expect(user.role).toBe('admin');
    expect(user.handle).toBe('accepttest');

    // second use: invite is spent → NotFound
    await expect(
      actions.accept(fakeReq({ name: 'X', handle: 'xz', password: 'password-123' })),
    ).rejects.toMatchObject({ type: 'NotFound' });
  });

  it('accept action redirects with error codes for bad input', async () => {
    const invite = await createInvite('invitee-itest@example.com', 'member', 'itest-admin');
    const { actions } = await import('../pages/invite/[token].js');
    const fakeReq = (form: Record<string, string>): any => ({
      path: `/invite/${invite.token}`,
      method: 'POST',
      params: { token: invite.token },
      query: {},
      headers: new Headers(),
      formData: async () => {
        const f = new FormData();
        for (const [k, v] of Object.entries(form)) f.set(k, v);
        return f;
      },
      json: async () => ({}),
      isEnhanced: false,
      layoutsPresent: [],
      prebakeNext: () => {},
    });

    await expect(
      actions.accept(fakeReq({ name: '', handle: 'ok-handle', password: 'password-123' })),
    ).rejects.toMatchObject({ message: `/invite/${invite.token}?error=name` });
    await expect(
      actions.accept(fakeReq({ name: 'N', handle: 'BAD HANDLE', password: 'password-123' })),
    ).rejects.toMatchObject({ message: `/invite/${invite.token}?error=handle` });
    await expect(
      actions.accept(fakeReq({ name: 'N', handle: 'ok-handle', password: 'short' })),
    ).rejects.toMatchObject({ message: `/invite/${invite.token}?error=password` });
  });
});
