import React from 'react';
import type { KilnRequest } from '@kiln/core';
import { requireUser } from '../lib/session.js';

// Pure SSR — never promote. Per-user content must not be baked into a shared
// cache. NOTE: omitting this export does NOT yield SSR; it inherits the global
// fsr.promoteAfterHits (2). See .memory/bugs-active.md "absent promote_after".
export const promote_after = false;

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
