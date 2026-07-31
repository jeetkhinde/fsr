import { describe, expect, it } from 'bun:test';
import { AppError } from './errors.js';

describe('AppError.conflict', () => {
  it('carries a 409 and the Conflict type', () => {
    const err = AppError.conflict('already claimed');
    expect(err.status).toBe(409);
    expect(err.type).toBe('Conflict');
    expect(err.message).toBe('already claimed');
    expect(err).toBeInstanceOf(AppError);
  });

  it('has a default message', () => {
    expect(AppError.conflict().message).toBe('Conflict');
  });
});
