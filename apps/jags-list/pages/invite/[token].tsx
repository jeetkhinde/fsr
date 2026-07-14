import React from 'react';
import { AppError, type KilnRequest } from '@kiln/core';
import { sql } from '../../db/client.js';
import { createAppUser } from '../../lib/auth.js';
import { findValidInvite, markInviteUsed } from '../../db/invites.js';
import { validHandle, validPassword } from '../../db/validation.js';

// Pure SSR — per-invite content and query-dependent error states.
export const promote_after = false;

export async function load(req: KilnRequest) {
  const invite = await findValidInvite(req.params.token ?? '');
  if (!invite) throw AppError.notFound('This invite link is invalid or has expired.');
  return { token: invite.token, email: invite.email, error: req.query.error ?? null };
}

export const actions = {
  async accept(req: KilnRequest) {
    const token = req.params.token ?? '';
    const invite = await findValidInvite(token);
    if (!invite) throw AppError.notFound('This invite link is invalid or has expired.');

    const form = await req.formData();
    const name = String(form.get('name') ?? '').trim();
    const handle = String(form.get('handle') ?? '').trim().toLowerCase();
    const password = String(form.get('password') ?? '');

    if (!name) throw AppError.redirect(`/invite/${token}?error=name`);
    if (!validHandle(handle)) throw AppError.redirect(`/invite/${token}?error=handle`);
    if (!validPassword(password)) throw AppError.redirect(`/invite/${token}?error=password`);
    const [taken] = await sql`SELECT 1 AS x FROM "user" WHERE lower(handle) = ${handle}`;
    if (taken) throw AppError.redirect(`/invite/${token}?error=handle-taken`);

    // The invite targets a specific email. If an account already exists for
    // it, show a friendly "sign in instead" message rather than letting
    // better-auth's unique-email violation surface as a raw 500 (#4).
    const [emailExists] = await sql`SELECT 1 AS x FROM "user" WHERE lower(email) = ${invite.email.toLowerCase()}`;
    if (emailExists) throw AppError.redirect(`/invite/${token}?error=email-exists`);

    try {
      await createAppUser({ email: invite.email, password, name, role: invite.role, handle });
    } catch (err) {
      // Lost a race (concurrent accept, or the email/handle was claimed
      // between the checks above and here) — stay graceful, never a 500.
      if (err instanceof AppError) throw err;
      throw AppError.redirect(`/invite/${token}?error=email-exists`);
    }
    await markInviteUsed(token);
    throw AppError.redirect('/login?welcome=1');
  },
};

const ERRORS: Record<string, string> = {
  name: 'Enter your name.',
  handle: 'Handle must be 2–32 characters: a–z, 0–9, dashes.',
  'handle-taken': 'That handle is taken.',
  'email-exists': 'An account already exists for this email — sign in instead.',
  password: 'Password must be at least 8 characters.',
};

export default function InvitePage({
  email,
  error,
}: {
  token: string;
  email: string;
  error: string | null;
}) {
  return (
    <section className="auth-card">
      <h1>Join Jag's List</h1>
      <p>
        Creating an account for <strong>{email}</strong>.
      </p>
      {error && <p className="error">{ERRORS[error] ?? 'Something went wrong.'}</p>}
      <form method="post" action="?/accept">
        <label>
          Name
          <input name="name" required />
        </label>
        <label>
          Handle
          <input name="handle" required pattern="[a-z0-9-]{2,32}" />
        </label>
        <label>
          Password
          <input type="password" name="password" required minLength={8} />
        </label>
        <button type="submit">Create account</button>
      </form>
    </section>
  );
}
