import { describe, expect, it } from 'bun:test';
import { validEmail, validHandle, validPassword } from './validation.js';
import { validProjectName, validTaskTitle, validColumnName, parsePriority, parseDueDate } from './validation.js';

describe('validation', () => {
  it('accepts valid and rejects invalid emails', () => {
    expect(validEmail('a@b.co')).toBe(true);
    expect(validEmail('not-an-email')).toBe(false);
    expect(validEmail('a b@c.co')).toBe(false);
  });

  it('enforces the handle format ^[a-z0-9-]{2,32}$', () => {
    expect(validHandle('jag')).toBe(true);
    expect(validHandle('a')).toBe(false);
    expect(validHandle('Uppercase')).toBe(false);
    expect(validHandle('has space')).toBe(false);
    expect(validHandle('x'.repeat(33))).toBe(false);
  });

  it('enforces password length 8..128', () => {
    expect(validPassword('12345678')).toBe(true);
    expect(validPassword('1234567')).toBe(false);
    expect(validPassword('x'.repeat(129))).toBe(false);
  });
});

describe('crud validation', () => {
  it('validates project name, task title, column name lengths', () => {
    expect(validProjectName('Roadmap')).toBe(true);
    expect(validProjectName('   ')).toBe(false);
    expect(validProjectName('x'.repeat(121))).toBe(false);
    expect(validTaskTitle('Ship it')).toBe(true);
    expect(validTaskTitle('')).toBe(false);
    expect(validColumnName('In Progress')).toBe(true);
    expect(validColumnName('x'.repeat(61))).toBe(false);
  });

  it('parsePriority clamps to 0..3 and defaults to 0', () => {
    expect(parsePriority('2')).toBe(2);
    expect(parsePriority('9')).toBe(0);
    expect(parsePriority(undefined)).toBe(0);
    expect(parsePriority('-1')).toBe(0);
  });

  it('parseDueDate accepts YYYY-MM-DD or empty', () => {
    expect(parseDueDate('2026-08-01')).toBe('2026-08-01');
    expect(parseDueDate('')).toBeNull();
    expect(parseDueDate('not-a-date')).toBeNull();
    expect(parseDueDate(undefined)).toBeNull();
  });
});
