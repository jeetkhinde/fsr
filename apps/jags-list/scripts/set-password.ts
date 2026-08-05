import { sql } from '../db/client.js';
import { auth } from '../lib/auth.js';

/**
 * Set an existing user's password.
 *
 * Public sign-up is disabled and `bootstrap-superadmin` refuses to run once a
 * superadmin exists, so without this there is no way back into a local
 * database whose bootstrap password has been forgotten — short of deleting
 * the superadmin row, which `projects.created_by` references.
 *
 * Dev tooling. It authenticates nothing: anyone who can run it already has
 * the database credentials.
 */
const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('usage: bun scripts/set-password.ts <email> <new-password>');
  process.exit(1);
}

const [user] = await sql`SELECT id, email, role FROM "user" WHERE email = ${email}`;
if (!user) {
  console.error(`no user with email ${email}`);
  await sql.close();
  process.exit(1);
}

const ctx = await auth.$context;
await ctx.internalAdapter.updatePassword(user.id, await ctx.password.hash(password));

console.log(`password set for ${user.email} (role: ${user.role})`);
await sql.close();
process.exit(0);
