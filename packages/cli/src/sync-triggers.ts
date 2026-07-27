import type { SQL } from 'bun';
import type { TriggerTableConfig } from '@kiln/core';

export const triggerName = (table: string) => `${table}_kiln_invalidate`;

export interface SyncResult { table: string; action: 'created' | 'exists' | 'missing' | 'updated' | 'outdated'; }

const VALID_EVENTS = new Set(['insert', 'update', 'delete']);

/** Idempotently attach the kiln_invalidate trigger to each configured table.
 * check:true never writes — it reports which tables lack the trigger, or have
 * one whose definition has drifted from config (CI).
 *
 * Presence alone is NOT enough to call a trigger correct: changing a table's
 * `ownerColumn`, `depKey`, or `events` in kiln.config.ts leaves the old
 * trigger in place under the same name. Treating that as "exists" would make
 * the config edit a silent no-op — and for `ownerColumn` in particular that
 * means owner-scoped invalidation appears configured while every notification
 * still fires route-wide. So the live definition is compared against the one
 * config asks for, and a mismatch is recreated (or reported by --check). */
export async function syncTriggers(
  sql: SQL,
  tables: TriggerTableConfig[],
  opts: { check: boolean },
): Promise<SyncResult[]> {
  const out: SyncResult[] = [];
  for (const t of tables) {
    // Trigger args are string literals: depKey, then the optional owner column.
    // Identifiers (table/trigger name) are validated here, never interpolated raw.
    assertIdent(t.table);
    // Fold to the identifier Postgres actually resolves. An unquoted
    // `CREATE TABLE SyncTrigMixed` is stored as `synctrigmixed`, and auto-deps'
    // extractTables folds what it captures the same way — so a verbatim
    // `SyncTrigMixed` depKey could never match a captured dep (silent
    // under-invalidation), and the verbatim trigger name could never match the
    // folded one Postgres stored, making the existence probe miss and every run
    // re-CREATE. Quoted, case-preserving table names are not supported (see
    // assertIdent, which rejects the quotes outright).
    const table = t.table.toLowerCase();
    const name = triggerName(table);
    assertIdent(name);
    if (t.ownerColumn) assertIdent(t.ownerColumn);
    // Only the DEFAULT depKey folds. An explicit depKey is an arbitrary
    // user-chosen string matched verbatim against hand-written dependsOn
    // lists, not an identifier, so folding it would break those lists.
    const depKey = t.depKey ?? table;
    const eventList = t.events ?? ['insert', 'update', 'delete'];
    for (const e of eventList) {
      // `events` reaches the CREATE TRIGGER text uninterpolated-by-parameter,
      // so it gets the same whitelist treatment as the identifiers above
      // rather than trusting the TS union to hold at runtime.
      if (!VALID_EVENTS.has(String(e).toLowerCase())) {
        throw new Error(`[kiln] unsupported trigger event: ${JSON.stringify(e)} (table "${t.table}")`);
      }
    }
    const events = eventList.map((e) => e.toUpperCase()).join(' OR ');
    const args = t.ownerColumn
      ? `'${depKey.replace(/'/g, "''")}', '${t.ownerColumn}'`
      : `'${depKey.replace(/'/g, "''")}'`;

    // Scoped by tgrelid, not tgname alone: trigger names are unique per table,
    // not per database, so a same-named trigger on some other table must not
    // read as this one already existing.
    const existing = await sql`
      SELECT pg_get_triggerdef(tg.oid) AS def
      FROM pg_trigger tg
      WHERE tg.tgname = ${name}
        AND tg.tgrelid = ${table}::regclass
        AND NOT tg.tgisinternal`;
    if (existing.length > 0) {
      const def = String(existing[0].def ?? '');
      if (triggerDefMatches(def, events, args)) { out.push({ table: t.table, action: 'exists' }); continue; }
      if (opts.check) { out.push({ table: t.table, action: 'outdated' }); continue; }
      // One transaction, not two statements: a failure or disconnect between
      // the DROP and the CREATE would otherwise leave the table with NO
      // trigger, and writes would silently stop invalidating until someone
      // happened to run --check. Postgres makes trigger DDL transactional, so
      // a failed recreate rolls back to the trigger that was already there.
      await sql.begin(async (tx: any) => {
        await tx.unsafe(`DROP TRIGGER ${name} ON ${table}`);
        await tx.unsafe(
          `CREATE TRIGGER ${name} AFTER ${events} ON ${table} ` +
          `FOR EACH ROW EXECUTE FUNCTION kiln_emit_event(${args})`);
      });
      out.push({ table: t.table, action: 'updated' });
      continue;
    }
    if (opts.check) { out.push({ table: t.table, action: 'missing' }); continue; }

    await sql.unsafe(
      `CREATE TRIGGER ${name} AFTER ${events} ON ${table} ` +
      `FOR EACH ROW EXECUTE FUNCTION kiln_emit_event(${args})`);
    out.push({ table: t.table, action: 'created' });
  }
  return out;
}

/** Compares an installed trigger against what config asks for.
 *
 * Postgres re-renders `pg_get_triggerdef` in ITS canonical form, not the text
 * we submitted: events come back in a fixed order (INSERT OR DELETE OR UPDATE)
 * regardless of how they were written, and the table is schema-qualified. So
 * the event clause is compared as an unordered SET, and only the
 * kiln_emit_event argument list — the part that actually determines the
 * emitted payload — is compared literally. */
function triggerDefMatches(def: string, events: string, args: string): boolean {
  const normalized = def.replace(/\s+/g, ' ');
  const eventClause = /\bAFTER\s+(.+?)\s+ON\s/i.exec(normalized);
  if (!eventClause) return false;
  const asSet = (s: string) =>
    [...new Set(s.split(/\s+OR\s+/i).map((e) => e.trim().toUpperCase()))].sort().join(',');
  if (asSet(eventClause[1]) !== asSet(events)) return false;
  const argClause = /kiln_emit_event\(([^)]*)\)/i.exec(normalized);
  return !!argClause && argClause[1].trim() === args.trim();
}

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function assertIdent(s: string): void {
  if (!IDENT.test(s)) throw new Error(`[kiln] unsafe SQL identifier: ${JSON.stringify(s)}`);
}
