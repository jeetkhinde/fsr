CREATE TABLE IF NOT EXISTS contacts (
  id BIGSERIAL PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  handle TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  favorite BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contact_events (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT,
  kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Invalidation trigger: run `kiln sync-triggers` (after this migration) to
-- install/verify it, per fsr.triggerTables in kiln.config.ts. It uses the
-- shared kiln_emit_event() function (packages/engine/src/schema.ts,
-- installed by FsrStore.initialize() at boot) — no hand-written trigger
-- function needed for a table with a plain `id` primary key.
--
-- Drop the old hand-written trigger/function: CREATE OR REPLACE never
-- removes a function, and a stale trigger sharing kiln sync-triggers'
-- naming convention (<table>_kiln_invalidate) would block it from ever
-- installing the real one — sync-triggers only checks whether a trigger by
-- that name exists, not what function it points to.
DROP TRIGGER IF EXISTS contact_events_kiln_invalidate ON contact_events;
DROP FUNCTION IF EXISTS address_book_notify_change();

INSERT INTO contacts (
  first_name,
  last_name,
  company,
  role,
  email,
  phone,
  location,
  handle,
  website,
  avatar_url,
  notes,
  favorite
)
SELECT *
FROM (
  VALUES
    (
      'Sarah',
      'Chen',
      'Linear',
      'Product Designer',
      'sarah@linear.app',
      '+1 415 555 0138',
      'San Francisco',
      '@sarahchen',
      'https://sarahchen.com',
      'https://images.unsplash.com/photo-1494790108377-be9c29b29330',
      'Met at Config. Interested in design systems and collaboration tooling.',
      true
    ),
    (
      'Michael',
      'Reed',
      'Studio North',
      'Engineering Lead',
      'michael@studionorth.dev',
      '+1 212 555 0177',
      'New York',
      '@mreed',
      'https://studionorth.dev',
      'https://images.unsplash.com/photo-1500648767791-00dcc994a43e',
      'Building calm tools for creative teams.',
      true
    ),
    (
      'Maya',
      'Patel',
      '',
      'Independent Strategist',
      'maya@example.com',
      '',
      'London',
      '@mayapatel',
      '',
      '',
      'Works across brand, product, and editorial strategy.',
      false
    ),
    (
      'Daniel',
      'Kim',
      'Common Ground',
      'Founder',
      'daniel@commonground.co',
      '',
      'Seoul',
      '@danielkim',
      'https://commonground.co',
      '',
      '',
      false
    )
) AS seed(
  first_name,
  last_name,
  company,
  role,
  email,
  phone,
  location,
  handle,
  website,
  avatar_url,
  notes,
  favorite
)
WHERE NOT EXISTS (SELECT 1 FROM contacts);
