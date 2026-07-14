import { sql } from '../db/client.js';
import { createAppUser } from '../lib/auth.js';

const [email, password, name, handle] = process.argv.slice(2);
if (!email || !password || !name || !handle) {
  console.error('usage: bun scripts/bootstrap-superadmin.ts <email> <password> <name> <handle>');
  process.exit(1);
}
if (!/^[a-z0-9-]{2,32}$/.test(handle)) {
  console.error('handle must match ^[a-z0-9-]{2,32}$');
  process.exit(1);
}

// The first user is the superadmin (immutable). Refuse if one already exists
// — a second superadmin must never be created through this path.
const [existing] = await sql`SELECT 1 AS x FROM "user" WHERE role = 'superadmin' LIMIT 1`;
if (existing) {
  console.error('a superadmin already exists; refusing to create another');
  await sql.close();
  process.exit(1);
}

const created = await createAppUser({ email, password, name, role: 'superadmin', handle });
console.log(`superadmin created: ${created.user.email} (@${handle})`);
await sql.close();
process.exit(0);
