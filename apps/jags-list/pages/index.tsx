import React from 'react';
import type { KilnRequest } from '@kiln/core';
import { requireUser } from '../lib/session.js';

// Per-user content, cached per user (ADR-017): each user's first hit bakes
// their own artifact; the identity hook (hooks.ts) supplies the cache key.
// NOTE: safe for 'user' baking because load() reads NO query params — pages
// with ?error/?invited banners must stay SSR until query joins the key.
export const bake = 'user';
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
