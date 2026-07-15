import React from 'react';
import { AppError, type KilnRequest } from '@kiln/core';
import { sql } from '../db/client.js';
import { createInvite } from '../db/invites.js';
import type { AppRole } from '../lib/auth.js';
import { isAtLeastAdmin, requireAdmin, requireUser } from '../lib/session.js';
import { validEmail } from '../db/validation.js';

// Pure SSR — shows all members and (for admins) an invite form; not shared-cacheable.
export const promote_after = false;

interface Member {
  id: string;
  name: string;
  email: string;
  handle: string | null;
  role: string | null;
}

export async function load(req: KilnRequest) {
  const me = await requireUser(req);
  const members = (await sql`
    SELECT id, name, email, handle, role FROM "user" ORDER BY "createdAt" ASC`) as Member[];
  return {
    me,
    members,
    invited: req.query.invited ?? null,
    error: req.query.error ?? null,
  };
}

export const actions = {
  async createInvite(req: KilnRequest) {
    const me = await requireAdmin(req);
    const form = await req.formData();
    const email = String(form.get('email') ?? '').trim().toLowerCase();
    // Invites may grant 'admin' or 'user' only — never 'superadmin'.
    const role = form.get('role') === 'admin' ? 'admin' : 'user';
    if (!validEmail(email)) throw AppError.redirect('/team?error=email');
    const invite = await createInvite(email, role, me.id);
    throw AppError.redirect(`/team?invited=${invite.token}`);
  },
};

export default function TeamPage({
  me,
  members,
  invited,
  error,
}: {
  me: { role: AppRole };
  members: Member[];
  invited: string | null;
  error: string | null;
}) {
  return (
    <section>
      <h1>Team</h1>
      {error === 'email' && <p className="error">Enter a valid email address.</p>}
      {invited && (
        <p className="notice">
          Invite created — share this link: <code>{`/invite/${invited}`}</code>
        </p>
      )}
      <ul className="members">
        {members.map((m) => (
          <li key={m.id}>
            <strong>{m.name}</strong> <span className="handle">{`@${m.handle}`}</span> · {m.email} ·{' '}
            {m.role === 'superadmin' ? 'superadmin 👑' : m.role ?? 'user'}
          </li>
        ))}
      </ul>
      {isAtLeastAdmin(me.role) && (
        <form method="post" action="?/createInvite" className="invite-form">
          <h2>Invite someone</h2>
          <label>
            Email
            <input type="email" name="email" required />
          </label>
          <label>
            Role
            <select name="role">
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button type="submit">Create invite</button>
        </form>
      )}
    </section>
  );
}
