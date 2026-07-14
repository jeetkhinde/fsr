import { describe, expect, it } from 'bun:test';
import { validEmail, validHandle, validPassword } from './validation.js';

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
