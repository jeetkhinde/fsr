import React from 'react';
import { AppError, type KilnRequest, type KilnResponse } from '@kiln/core';
import { auth } from '../lib/auth.js';

// load() reads query (?error, ?welcome) — classifier keeps this SSR (ADR-016).

export async function load(req: KilnRequest) {
  return {
    error: req.query.error === '1',
    welcome: req.query.welcome === '1',
  };
}

// Login and logout are ordinary Kiln actions: they set cookies through
// res.headers/res.cookies, so they no longer need raw adapter routes in
// src/main.ts.
export const actions = {
  async signin(req: KilnRequest, res: KilnResponse) {
    const form = await req.formData();
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');

    let upstream: Response;
    try {
      upstream = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    } catch {
      throw AppError.redirect('/login?error=1');
    }
    if (!upstream.ok) throw AppError.redirect('/login?error=1');

    // better-auth returns fully-formed Set-Cookie strings; pass them through
    // verbatim rather than re-serializing and risking an attribute mismatch.
    for (const cookie of upstream.headers.getSetCookie()) {
      res.headers.append('set-cookie', cookie);
    }
    throw AppError.redirect('/');
  },

  async signout(req: KilnRequest, res: KilnResponse) {
    try {
      const upstream = await auth.api.signOut({ headers: req.headers, asResponse: true });
      for (const cookie of upstream.headers.getSetCookie()) {
        res.headers.append('set-cookie', cookie);
      }
    } catch {
      // no/invalid session — still land on /login
    }
    throw AppError.redirect('/login');
  },
};

export default function LoginPage({ error, welcome }: { error: boolean; welcome: boolean }) {
  return (
    <section className="auth-card">
      <h1>Sign in</h1>
      {welcome && <p className="notice">Account created — sign in to get started.</p>}
      {error && <p className="error">Wrong email or password.</p>}
      <form method="post" action="/login?/signin">
        <label>
          Email
          <input type="email" name="email" required autoComplete="email" />
        </label>
        <label>
          Password
          <input type="password" name="password" required autoComplete="current-password" />
        </label>
        <button type="submit">Sign in</button>
      </form>
    </section>
  );
}
