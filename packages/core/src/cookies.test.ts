import { describe, expect, it } from 'bun:test';
import { createCookies, serializeCookie } from './cookies.js';

describe('serializeCookie', () => {
  it('defaults Path to / so a cookie set from a nested POST is visible app-wide', () => {
    expect(serializeCookie('sid', 'abc')).toBe('sid=abc; Path=/');
  });

  it('honours an explicit path', () => {
    expect(serializeCookie('sid', 'abc', { path: '/admin' })).toBe('sid=abc; Path=/admin');
  });

  it('url-encodes the value', () => {
    expect(serializeCookie('k', 'a b;c')).toBe('k=a%20b%3Bc; Path=/');
  });

  it('serializes every attribute in a stable order', () => {
    const out = serializeCookie('sid', 'abc', {
      path: '/',
      domain: 'example.com',
      maxAge: 3600,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
    expect(out).toBe(
      'sid=abc; Path=/; Domain=example.com; Max-Age=3600; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('maps sameSite values to their canonical casing', () => {
    expect(serializeCookie('a', '1', { sameSite: 'strict' })).toContain('SameSite=Strict');
    expect(serializeCookie('a', '1', { sameSite: 'none' })).toContain('SameSite=None');
  });

  it('formats expires as a UTC string', () => {
    const out = serializeCookie('a', '1', { expires: new Date(Date.UTC(2030, 0, 1)) });
    expect(out).toContain('Expires=Tue, 01 Jan 2030 00:00:00 GMT');
  });

  it('floors a fractional maxAge', () => {
    expect(serializeCookie('a', '1', { maxAge: 1.9 })).toContain('Max-Age=1');
  });

  it('omits attributes that were not supplied', () => {
    const out = serializeCookie('a', '1');
    expect(out).not.toContain('HttpOnly');
    expect(out).not.toContain('Secure');
    expect(out).not.toContain('SameSite');
    expect(out).not.toContain('Max-Age');
  });
});

describe('createCookies', () => {
  it('appends one Set-Cookie header per set() call', () => {
    const headers = new Headers();
    const cookies = createCookies(headers);

    cookies.set('a', '1', { httpOnly: true });
    cookies.set('b', '2');

    expect(headers.getSetCookie()).toEqual(['a=1; Path=/; HttpOnly', 'b=2; Path=/']);
  });

  it('expires the cookie on delete()', () => {
    const headers = new Headers();
    createCookies(headers).delete('sid');
    expect(headers.getSetCookie()).toEqual(['sid=; Path=/; Max-Age=0']);
  });

  it('carries path and domain through delete(), since a cookie only clears when they match', () => {
    const headers = new Headers();
    createCookies(headers).delete('sid', { path: '/admin', domain: 'example.com' });
    expect(headers.getSetCookie()).toEqual(['sid=; Path=/admin; Domain=example.com; Max-Age=0']);
  });
});
