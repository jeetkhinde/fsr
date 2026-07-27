import { describe, expect, it } from 'bun:test';
import { indexPage, kilnConfig, migrationSql, packageJson } from './templates.js';

describe('create-kiln templates', () => {
  it('shows query-backed Live.list without public marker props or names', () => {
    expect(indexPage).toContain('Live.list<Todo>');
    expect(indexPage).toContain("dependsOn: 'todo_events'");
    expect(indexPage).toContain('todos.map((todo)');
    expect(indexPage).not.toContain("name: 'todos'");
    expect(indexPage).not.toContain('s-live=');
    expect(indexPage).not.toContain('s-key=');
  });

  it('leaves framework-owned FSR tables out of app migrations', () => {
    expect(migrationSql).not.toContain('CREATE TABLE IF NOT EXISTS kiln_fsr');
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS todo_events');
  });

  it('relies on kiln sync-triggers instead of a hand-written invalidation function', () => {
    // No bespoke trigger function — kiln_emit_event (installed via sync-triggers) covers it.
    expect(migrationSql).not.toContain('CREATE OR REPLACE FUNCTION kiln_notify_change');
    expect(migrationSql).not.toContain("EXECUTE FUNCTION kiln_notify_change");
    // Cleanup for DBs migrated from the old hand-written trigger.
    expect(migrationSql).toContain('DROP TRIGGER IF EXISTS todo_events_kiln_invalidate ON todo_events');
    expect(migrationSql).toContain('DROP FUNCTION IF EXISTS kiln_notify_change()');
    // Config + script wiring that installs the real trigger.
    expect(kilnConfig).toContain("triggerTables: [{ table: 'todo_events' }]");
    expect(packageJson('my-app')).toContain('"db:sync-triggers": "kiln sync-triggers"');
  });
});
