import { AppError, type KilnRequest } from '@kiln/core';
import { auth, type AppRole } from './auth.js';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  handle: string;
  role: AppRole;
}

/** True for admin and superadmin — the "can manage the team" tier. */
export function isAtLeastAdmin(role: AppRole): boolean {
  return role === 'admin' || role === 'superadmin';
}

export async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const u = session.user as any;
  // Pass superadmin/admin through; anything else (incl. legacy 'member' or
  // NULL) resolves to 'user'.
  const role: AppRole =
    u.role === 'superadmin' ? 'superadmin' : u.role === 'admin' ? 'admin' : 'user';
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    handle: u.handle ?? '',
    role,
  };
}

export async function requireUser(req: KilnRequest): Promise<SessionUser> {
  const user = await getSessionUser(req.headers);
  if (!user) throw AppError.unauthorized('Sign in required');
  return user;
}

/** Admins and superadmins. Use for team-management actions (invites, etc.). */
export async function requireAdmin(req: KilnRequest): Promise<SessionUser> {
  const user = await requireUser(req);
  if (!isAtLeastAdmin(user.role)) throw AppError.unauthorized('Admin access required');
  return user;
}

/** Superadmin only. Use for actions that touch admins or the superadmin. */
export async function requireSuperadmin(req: KilnRequest): Promise<SessionUser> {
  const user = await requireUser(req);
  if (user.role !== 'superadmin') throw AppError.unauthorized('Superadmin access required');
  return user;
}
