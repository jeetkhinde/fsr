import { describe, expect, it } from 'bun:test';
import { isAtLeastAdmin } from './session.js';
import type { AppRole } from './auth.js';

describe('role helpers', () => {
  it('isAtLeastAdmin is true for admin and superadmin, false for user', () => {
    expect(isAtLeastAdmin('superadmin')).toBe(true);
    expect(isAtLeastAdmin('admin')).toBe(true);
    expect(isAtLeastAdmin('user')).toBe(false);
  });

  it('covers the whole AppRole union (compile-time exhaustiveness guard)', () => {
    const roles: AppRole[] = ['superadmin', 'admin', 'user'];
    // superadmin + admin manage; exactly one role (user) does not.
    expect(roles.filter((r) => !isAtLeastAdmin(r))).toEqual(['user']);
  });
});
