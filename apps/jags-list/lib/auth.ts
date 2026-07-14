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
      role: { type: 'string', defaultValue: 'member', input: false },
      handle: { type: 'string', required: false, input: false },
    },
  },
  plugins: [admin()],
});
