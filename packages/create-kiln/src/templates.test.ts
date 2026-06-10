import { describe, expect, it } from 'bun:test';
import { indexPage, migrationSql } from './templates.js';

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
    expect(migrationSql).toContain("kiln_notify_change('todo_events')");
  });
});
