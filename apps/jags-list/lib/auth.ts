import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { Pool } from 'pg';

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3200',
  secret: process.env.BETTER_AUTH_SECRET ?? 'dev-secret-change-me',
  database: new Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgresql://localhost:5432/jagslist',
  }),
  emailAndPassword: {
    enabled: true,
    // Invite-only: users are created server-side via auth.api.createUser
    // (bootstrap script + invite acceptance). Public sign-up stays closed.
    disableSignUp: true,
  },
  session: {
    // hooks.ts checks the session on every request; the signed cookie cache
    // avoids a DB round-trip per request.
    cookieCache: { enabled: true, maxAge: 300 },
  },
  user: {
    additionalFields: {
      role: { type: 'string', defaultValue: 'user', input: false },
      handle: { type: 'string', required: false, input: false },
    },
  },
  plugins: [admin()],
});

/** App role hierarchy: superadmin > admin > user. `superadmin` is the first
 * user and is immutable; `admin` manages admins and users but never a
 * superadmin; `user` is a regular member. */
export type AppRole = 'superadmin' | 'admin' | 'user';

/**
 * Server-side user creation for bootstrap + invite acceptance (public sign-up
 * is disabled). The better-auth admin plugin types `role` as its own enum
 * ('admin' | 'user'), which doesn't include the app's 'superadmin'/'user'
 * vocabulary; the role column is TEXT and better-auth stores the string
 * verbatim at runtime, so the cast only reconciles compile-time types.
 * See .memory/bugs-active.md.
 */
export function createAppUser(input: {
  email: string;
  password: string;
  name: string;
  role: AppRole;
  handle: string;
}) {
  return auth.api.createUser({
    body: {
      email: input.email,
      password: input.password,
      name: input.name,
      role: input.role as 'admin' | 'user',
      data: { handle: input.handle },
    },
  });
}
