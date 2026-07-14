import { AppError, type KilnRequest } from '@kiln/core';
import { auth } from './auth.js';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  handle: string;
  role: 'admin' | 'member';
}

export async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const u = session.user as any;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    handle: u.handle ?? '',
    role: u.role === 'admin' ? 'admin' : 'member',
  };
}

export async function requireUser(req: KilnRequest): Promise<SessionUser> {
  const user = await getSessionUser(req.headers);
  if (!user) throw AppError.unauthorized('Sign in required');
  return user;
}

export async function requireAdmin(req: KilnRequest): Promise<SessionUser> {
  const user = await requireUser(req);
  if (user.role !== 'admin') throw AppError.unauthorized('Admin access required');
  return user;
}
