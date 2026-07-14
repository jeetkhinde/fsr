import { auth } from '../lib/auth.js';

const [email, password, name, handle] = process.argv.slice(2);
if (!email || !password || !name || !handle) {
  console.error('usage: bun scripts/bootstrap-admin.ts <email> <password> <name> <handle>');
  process.exit(1);
}
if (!/^[a-z0-9-]{2,32}$/.test(handle)) {
  console.error('handle must match ^[a-z0-9-]{2,32}$');
  process.exit(1);
}

const created = await auth.api.createUser({
  body: { email, password, name, role: 'admin', data: { handle } },
});
console.log(`admin created: ${created.user.email} (@${handle})`);
process.exit(0);
