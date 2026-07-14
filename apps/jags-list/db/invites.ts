import { randomBytes } from 'node:crypto';
import { sql } from './client.js';

export interface Invite {
  id: number;
  token: string;
  email: string;
  role: 'admin' | 'member';
  expires_at: Date;
  used_at: Date | null;
  created_by: string;
}

const INVITE_TTL_DAYS = 7;

export async function createInvite(
  email: string,
  role: 'admin' | 'member',
  createdBy: string,
): Promise<Invite> {
  const token = randomBytes(24).toString('base64url');
  const [invite] = await sql`
    INSERT INTO invites (token, email, role, expires_at, created_by)
    VALUES (${token}, ${email}, ${role}, NOW() + (${INVITE_TTL_DAYS} * INTERVAL '1 day'), ${createdBy})
    RETURNING *`;
  return invite as Invite;
}

export async function findValidInvite(token: string): Promise<Invite | null> {
  if (!token) return null;
  const [invite] = await sql`
    SELECT * FROM invites
    WHERE token = ${token} AND used_at IS NULL AND expires_at > NOW()`;
  return (invite as Invite) ?? null;
}

export async function markInviteUsed(token: string): Promise<void> {
  await sql`UPDATE invites SET used_at = NOW() WHERE token = ${token}`;
}
