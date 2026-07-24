import type { SQL } from 'bun';
import type { TriggerTableConfig } from '@kiln/core';

export const triggerName = (table: string) => `${table}_kiln_invalidate`;

export interface SyncResult { table: string; action: 'created' | 'exists' | 'missing'; }

/** Idempotently attach the kiln_invalidate trigger to each configured table.
 * check:true never writes — it reports which tables lack the trigger (CI). */
export async function syncTriggers(
  sql: SQL,
  tables: TriggerTableConfig[],
  opts: { check: boolean },
): Promise<SyncResult[]> {
  const out: SyncResult[] = [];
  for (const t of tables) {
    const name = triggerName(t.table);
    const existing = await sql`
      SELECT 1 FROM pg_trigger WHERE tgname = ${name} AND NOT tgisinternal`;
    if (existing.length > 0) { out.push({ table: t.table, action: 'exists' }); continue; }
    if (opts.check) { out.push({ table: t.table, action: 'missing' }); continue; }

    const depKey = t.depKey ?? t.table;
    const events = (t.events ?? ['insert', 'update', 'delete'])
      .map((e) => e.toUpperCase()).join(' OR ');
    // Trigger args are string literals: depKey, then the optional owner column.
    // Identifiers (table/trigger name) are validated below, never interpolated raw.
    assertIdent(t.table); assertIdent(name);
    if (t.ownerColumn) assertIdent(t.ownerColumn);
    const args = t.ownerColumn
      ? `'${depKey.replace(/'/g, "''")}', '${t.ownerColumn}'`
      : `'${depKey.replace(/'/g, "''")}'`;
    await sql.unsafe(
      `CREATE TRIGGER ${name} AFTER ${events} ON ${t.table} ` +
      `FOR EACH ROW EXECUTE FUNCTION kiln_emit_event(${args})`);
    out.push({ table: t.table, action: 'created' });
  }
  return out;
}

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function assertIdent(s: string): void {
  if (!IDENT.test(s)) throw new Error(`[kiln] unsafe SQL identifier: ${JSON.stringify(s)}`);
}
