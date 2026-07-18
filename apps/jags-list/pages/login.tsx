import React from 'react';
import type { KilnRequest } from '@kiln/core';

// load() reads query (?error, ?welcome) — classifier keeps this SSR (ADR-016).

export async function load(req: KilnRequest) {
  return {
    error: req.query.error === '1',
    welcome: req.query.welcome === '1',
  };
}

export default function LoginPage({ error, welcome }: { error: boolean; welcome: boolean }) {
  return (
    <section className="auth-card">
      <h1>Sign in</h1>
      {welcome && <p className="notice">Account created — sign in to get started.</p>}
      {error && <p className="error">Wrong email or password.</p>}
      <form method="post" action="/auth/login">
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
