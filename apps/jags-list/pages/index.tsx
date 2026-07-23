import React from 'react';
import type { KilnRequest } from '@kiln/core';
import { requireUser } from '../lib/session.js';

// Per-user content: load() reads the session, so the bake classifier keeps
// this pure SSR automatically (ADR-016) — no export needed.
export async function load(req: KilnRequest) {
  const user = requireUser(req);
  return { user };
}

export default function HomePage({
  user,
}: {
  user: { name: string; handle: string };
}) {
  return (
    <section>
      <h1>
        Welcome, {user.name} <span className="handle">{`@${user.handle}`}</span>
      </h1>
      <p>
        <a href="/projects">Go to your projects</a>. My Tasks lands here in a later milestone.
      </p>
    </section>
  );
}
