import { sql } from './client.js';

export async function listMembers(): Promise<Array<{ id: string; name: string; handle: string | null }>> {
  return (await sql`SELECT id, name, handle FROM "user" ORDER BY name ASC`) as Array<{
    id: string;
    name: string;
    handle: string | null;
  }>;
}
