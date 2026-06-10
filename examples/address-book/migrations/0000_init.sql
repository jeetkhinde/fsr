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

CREATE OR REPLACE FUNCTION address_book_notify_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'kiln_invalidate',
    json_build_object('depKey', TG_ARGV[0], 'id', NEW.id)::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS contact_events_kiln_invalidate ON contact_events;
CREATE TRIGGER contact_events_kiln_invalidate
AFTER INSERT ON contact_events
FOR EACH ROW EXECUTE FUNCTION address_book_notify_change('contact_events');

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
