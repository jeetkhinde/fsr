# Kiln Address Book Example Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone PostgreSQL-backed address book at `examples/address-book` with polished responsive UI, route-native Kiln CRUD actions, URL-synchronized search, and cross-tab `Live.list` reconciliation.

**Architecture:** Add one focused routekit content-negotiation fix so explicit `Accept: text/html` wins over the enhanced JSON shortcut. Build the example as an independent workspace package with a custom Elysia startup entrypoint that serves CSS and browser behavior assets, a small PostgreSQL repository that writes `contact_events` atomically with every mutation, and route pages that each own the same complete contacts `Live.list`.

**Tech Stack:** Bun, TypeScript, React 19 server rendering, Kiln routekit/core/engine/adapter packages, Silcrow browser runtime, PostgreSQL, Redis, Bun test, Playwright.

**Design spec:** `docs/superpowers/specs/2026-06-07-address-book-design.md`

---

## File Map

### Framework change

- Modify `packages/routekit/src/boot.ts`: make explicit HTML accepts override enhanced JSON negotiation.
- Modify `packages/routekit/src/boot.test.ts`: prove the `s-html` request shape returns HTML with layouts already present.

### Example package and runtime

- Modify `package.json`: include `examples/*` in Bun workspaces.
- Modify `bun.lock`: record the new workspace and Playwright development dependency.
- Create `examples/address-book/package.json`: scripts and workspace dependencies.
- Create `examples/address-book/tsconfig.json`: strict NodeNext/React compilation.
- Create `examples/address-book/types/react.d.ts`: type the declarative `s-html` attribute.
- Create `examples/address-book/.env.example`: local PostgreSQL, Redis, and port defaults.
- Create `examples/address-book/kiln.config.ts`: port and embedded FSR configuration.
- Create `examples/address-book/src/main.ts`: initialize SQL, watcher, notification pipeline, assets, and routes.
- Create `examples/address-book/scripts/migrate.ts`: apply the example migration.
- Create `examples/address-book/migrations/0000_init.sql`: FSR tables, contact tables, trigger, and seed rows.
- Create `examples/address-book/client/address-book.js`: search, URL sync, image fallback, pending forms, optimistic favorite, and delete confirmation.
- Create `examples/address-book/styles/app.css`: approved desktop/mobile workspace design.

### Contact domain and persistence

- Create `examples/address-book/db/types.ts`: `Contact`, `ContactSummary`, `ContactInput`, and action result types.
- Create `examples/address-book/db/client.ts`: shared Bun `SQL` instance.
- Create `examples/address-book/db/validation.ts`: form normalization and validation.
- Create `examples/address-book/db/presentation.ts`: name, initials, search text, and sorting helpers.
- Create `examples/address-book/db/contacts.ts`: query and transactional mutation functions.
- Create `examples/address-book/db/validation.test.ts`: domain helper unit tests.
- Create `examples/address-book/db/contacts.integration.test.ts`: PostgreSQL mutation/event tests.

### Shared rendering

- Create `examples/address-book/features/contacts/live.ts`: complete contacts `Live.list` factory.
- Create `examples/address-book/components/Avatar.tsx`: remote image plus deterministic initials fallback markup.
- Create `examples/address-book/components/Directory.tsx`: search and semantic keyed contact list.
- Create `examples/address-book/components/AppShell.tsx`: responsive rail/detail composition.
- Create `examples/address-book/components/ContactForm.tsx`: shared create/edit form and error regions.
- Create `examples/address-book/components/ContactDetail.tsx`: detail, favorite, edit, and delete controls.
- Create `examples/address-book/components/EmptyDetail.tsx`: empty and missing states.

### Routes

- Create `examples/address-book/pages/_layout.tsx`: document metadata and asset links.
- Create `examples/address-book/pages/index.tsx`: redirect `/` to `/contacts`.
- Create `examples/address-book/pages/contacts/index.tsx`: directory plus empty detail state.
- Create `examples/address-book/pages/contacts/new.tsx`: directory plus create form/action.
- Create `examples/address-book/pages/contacts/[id]/index.tsx`: directory plus detail/favorite/delete actions.
- Create `examples/address-book/pages/contacts/[id]/edit.tsx`: directory plus edit form/action.
- Create `examples/address-book/tests/routes.test.ts`: loader and action tests kept outside `pages/` so route discovery cannot import them.

### Browser verification

- Create `examples/address-book/playwright.config.ts`: app server and browser projects.
- Create `examples/address-book/tests/address-book.spec.ts`: CRUD, search, favorite, delete, responsive, fallback, and cross-tab flows.

---

### Task 1: Make Explicit HTML Negotiation Authoritative

**Files:**
- Modify: `packages/routekit/src/boot.ts:76`
- Modify: `packages/routekit/src/boot.test.ts`

- [ ] **Step 1: Write the failing routekit test**

Add this test inside `describe('buildPageHandler')`:

```ts
it('returns HTML when an enhanced request explicitly accepts text/html', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiln-boot-'));
  const layoutPath = path.join(tmpDir, 'layout.mjs');
  await fs.writeFile(
    layoutPath,
    'export default function Layout({ children }) { return children; }',
  );

  try {
    const { createElement } = await import('react');
    const pageModule = {
      load: async () => ({ title: 'Address Book' }),
      default: ({ title }: any) => createElement('h1', null, title),
    };
    const pageMeta = {
      pattern: '/contacts',
      layouts: [layoutPath],
      liveFields: [],
      hasEntries: false,
      filePath: '',
      relativePath: '',
    };
    const layouts = [{
      pattern: '/',
      filePath: layoutPath,
      relativePath: '_layout.tsx',
      hasLoad: false,
    }];
    const handler = buildPageHandler(
      pageModule,
      pageMeta,
      layouts,
      { cacheDir: tmpDir, ttlSecs: 0, redis: null },
    );
    const req = makeReq({
      headers: new Headers({ accept: 'text/html' }),
      isEnhanced: true,
      layoutsPresent: ['/'],
    });
    const res = makeRes();

    await handler(req, res);

    expect(res.captured.type).toBe('html');
    expect(res.captured.body).toContain('Address Book');
  } finally {
    await fs.rm(tmpDir, { recursive: true });
  }
});
```

- [ ] **Step 2: Run the focused test and verify the old behavior fails**

Run:

```bash
bun test packages/routekit/src/boot.test.ts
```

Expected: FAIL because `wantsJson()` returns JSON for the enhanced request.

- [ ] **Step 3: Implement the minimal negotiation change**

Replace `wantsJson()` with:

```ts
function wantsJson(req: KilnRequest, layoutPatterns: string[]): boolean {
  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('text/html')) return false;
  if (accept.includes('application/json')) return true;
  return req.isEnhanced && layoutPatterns.every((pattern) =>
    req.layoutsPresent.includes(pattern)
  );
}
```

- [ ] **Step 4: Run routekit tests**

Run:

```bash
bun test packages/routekit/src/boot.test.ts
```

Expected: all `buildPageHandler` tests PASS.

- [ ] **Step 5: Commit the framework fix**

```bash
git add packages/routekit/src/boot.ts packages/routekit/src/boot.test.ts
git commit -m "fix(routekit): honor explicit HTML navigation"
```

---

### Task 2: Scaffold the Independent Example Package

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Create: `examples/address-book/package.json`
- Create: `examples/address-book/tsconfig.json`
- Create: `examples/address-book/kiln.config.ts`
- Create: `examples/address-book/src/main.ts`
- Create: `examples/address-book/scripts/migrate.ts`

- [ ] **Step 1: Add the workspace**

Change the root workspace list to:

```json
"workspaces": ["packages/*", "examples/*", "test-app"]
```

- [ ] **Step 2: Create the example package manifest**

Create `examples/address-book/package.json`:

```json
{
  "name": "@kiln-example/address-book",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/main.ts",
    "build": "tsc --noEmit",
    "db:migrate": "bun scripts/migrate.ts",
    "test": "bun test db/validation.test.ts tests/routes.test.ts",
    "test:db": "bun --env-file=.env db/contacts.integration.test.ts",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@kiln/adapter-elysia": "workspace:*",
    "@kiln/core": "workspace:*",
    "@kiln/engine": "workspace:*",
    "@kiln/routekit": "workspace:*",
    "elysia": "^1.0.12",
    "ioredis": "^5.4.1",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.52.0",
    "@types/bun": "^1.3.14",
    "@types/node": "^20.12.7",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.4.5"
  }
}
```

- [ ] **Step 3: Create strict TypeScript configuration**

Create `examples/address-book/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  },
  "include": [
    "client/**/*",
    "components/**/*",
    "db/**/*",
    "features/**/*",
    "pages/**/*",
    "scripts/**/*",
    "src/**/*",
    "kiln.config.ts",
    "playwright.config.ts",
    "tests/**/*",
    "types/**/*"
  ]
}
```

- [ ] **Step 4: Type the declarative HTML-navigation attribute**

Create `examples/address-book/types/react.d.ts`:

```ts
import 'react';

declare module 'react' {
  interface HTMLAttributes<T> {
    's-html'?: string;
  }
}
```

- [ ] **Step 5: Create app configuration**

Create `examples/address-book/kiln.config.ts`:

```ts
import { defineConfig } from '@kiln/core';

export default defineConfig({
  port: Number(process.env.PORT ?? 3100),
  pagesDir: './pages',
  fsr: {
    watcher: 'embedded',
    promoteAfterHits: 1,
    maxSseConnections: 1000,
    connectionTtlSecs: 3600,
    keepaliveSecs: 30,
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    postgresUrl:
      process.env.DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5432/postgres',
  },
});
```

- [ ] **Step 6: Create the environment template**

Create `examples/address-book/.env.example`:

```dotenv
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
REDIS_URL=redis://localhost:6379
PORT=3100
```

Create the ignored local environment file:

```bash
cp examples/address-book/.env.example examples/address-book/.env
```

- [ ] **Step 7: Create the shared SQL client**

Create `examples/address-book/db/client.ts`:

```ts
import { SQL } from 'bun';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/postgres';

export const sql = new SQL(databaseUrl);
```

- [ ] **Step 8: Create the migration runner**

Create `examples/address-book/scripts/migrate.ts`:

```ts
import { sql } from '../db/client.js';

const migration = await Bun.file(
  new URL('../migrations/0000_init.sql', import.meta.url),
).text();

try {
  await sql.unsafe(migration);
  console.log('address-book migration: ok');
} finally {
  await sql.close();
}
```

- [ ] **Step 9: Create the app startup entrypoint**

Create `examples/address-book/src/main.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { ElysiaAdapter } from '@kiln/adapter-elysia';
import {
  FsrStore,
  FsrWatcher,
  RedisCache,
  startDbNotificationPipeline,
} from '@kiln/engine';
import { startKiln } from '@kiln/routekit';
import config from '../kiln.config.js';
import { sql } from '../db/client.js';

async function main() {
  const adapter = new ElysiaAdapter();
  const store = new FsrStore(sql);
  const redis = config.fsr?.redisUrl
    ? new RedisCache(config.fsr.redisUrl)
    : null;
  const watcher = new FsrWatcher(store, redis, {
    pollIntervalMs: 1000,
    promoteAfterHits: config.fsr?.promoteAfterHits ?? 1,
    patchDebounceSecs: 0,
    purgeAfterSeconds: 3600,
    scheduledInvalidations: [],
    idleEvictSecs: 1800,
    idleThresholdSecs: 3600,
  });

  await watcher.start();
  await startDbNotificationPipeline(config.fsr!.postgresUrl!, store, watcher);

  adapter.registerAsset(
    '/assets/address-book.css',
    fileURLToPath(new URL('../styles/app.css', import.meta.url)),
  );
  adapter.registerAsset(
    '/assets/address-book.js',
    fileURLToPath(new URL('../client/address-book.js', import.meta.url)),
  );

  await startKiln(adapter, config, './pages', { fsr: true, store, watcher });
  await adapter.listen(config.port ?? 3100, (address) => {
    console.log(`Address book running at ${address}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 10: Install workspace dependencies**

Run:

```bash
bun install
```

Expected: `bun.lock` updates and the address-book workspace resolves all local `@kiln/*` packages.

- [ ] **Step 11: Run the initial type check**

Run:

```bash
bun --cwd examples/address-book run build
```

Expected: PASS. The initial package has valid startup and migration entrypoints before route modules are added.

- [ ] **Step 12: Commit the workspace scaffold**

```bash
git add package.json bun.lock examples/address-book/package.json examples/address-book/tsconfig.json examples/address-book/types/react.d.ts examples/address-book/.env.example examples/address-book/kiln.config.ts examples/address-book/db/client.ts examples/address-book/scripts/migrate.ts examples/address-book/src/main.ts
git commit -m "feat(example): scaffold address book workspace"
```

---

### Task 3: Add the Database Schema and Seed Data

**Files:**
- Create: `examples/address-book/migrations/0000_init.sql`

- [ ] **Step 1: Create the migration**

Create `examples/address-book/migrations/0000_init.sql` with the existing Kiln FSR tables followed by the contact schema:

```sql
CREATE TABLE IF NOT EXISTS kiln_fsr (
  route TEXT NOT NULL,
  slot TEXT NOT NULL DEFAULT '',
  query TEXT,
  query_params JSONB,
  depends_on TEXT[] NOT NULL DEFAULT '{}',
  stale BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 0,
  promoted BOOLEAN NOT NULL DEFAULT false,
  tombstoned BOOLEAN NOT NULL DEFAULT false,
  promote_after INTEGER,
  debounce_secs INTEGER,
  html_path TEXT,
  json_path TEXT,
  column_name TEXT,
  last_hit TIMESTAMP,
  last_patched_at TIMESTAMP,
  PRIMARY KEY (route, slot)
);

CREATE TABLE IF NOT EXISTS kiln_fsr_lists (
  route TEXT NOT NULL,
  name TEXT NOT NULL,
  depends_on TEXT[] NOT NULL DEFAULT '{}',
  rows JSONB NOT NULL DEFAULT '[]',
  stale BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 0,
  html_path TEXT,
  json_path TEXT,
  last_patched_at TIMESTAMP,
  PRIMARY KEY (route, name)
);

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
```

- [ ] **Step 2: Apply the migration**

Run:

```bash
bun --env-file=examples/address-book/.env examples/address-book/scripts/migrate.ts
```

Expected: `address-book migration: ok`.

- [ ] **Step 3: Verify seeded contacts**

Run:

```bash
zsh -lc 'set -a; source examples/address-book/.env; set +a; psql "$DATABASE_URL" -Atc "select count(*) >= 4, count(*) filter (where favorite) >= 2 from contacts"'
```

Expected: `t|t`.

- [ ] **Step 4: Commit the schema**

```bash
git add examples/address-book/migrations/0000_init.sql
git commit -m "feat(example): add address book schema"
```

---

### Task 4: Implement and Test Contact Domain Helpers

**Files:**
- Create: `examples/address-book/db/types.ts`
- Create: `examples/address-book/db/validation.ts`
- Create: `examples/address-book/db/presentation.ts`
- Create: `examples/address-book/db/validation.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Create `examples/address-book/db/validation.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import {
  filterContacts,
  getContactInitials,
  getContactSearchText,
  sortContacts,
} from './presentation.js';
import { validateContactForm } from './validation.js';
import type { Contact, ContactSummary } from './types.js';

type SearchableContact = Pick<
  Contact,
  'firstName' | 'lastName' | 'company' | 'role' | 'email' | 'handle'
>;

const contact = (overrides: Partial<Contact> = {}): Contact => ({
  id: '1',
  firstName: 'Sarah',
  lastName: 'Chen',
  company: 'Linear',
  role: 'Product Designer',
  email: 'sarah@linear.app',
  phone: '',
  location: 'San Francisco',
  handle: '@sarahchen',
  website: 'https://sarahchen.com',
  avatarUrl: '',
  notes: '',
  favorite: false,
  createdAt: '2026-06-07T00:00:00.000Z',
  updatedAt: '2026-06-07T00:00:00.000Z',
  ...overrides,
});

describe('contact validation', () => {
  it('requires at least one name and normalizes optional fields', () => {
    const form = new FormData();
    form.set('firstName', '   ');
    form.set('lastName', '');
    form.set('company', '  Linear  ');

    const result = validateContactForm(form);

    expect(result.ok).toBe(false);
    expect(result.errors.name).toBe('Enter a first or last name.');
    expect(result.values.company).toBe('Linear');
  });

  it('rejects malformed email and non-http URLs', () => {
    const form = new FormData();
    form.set('firstName', 'Sarah');
    form.set('email', 'not-an-email');
    form.set('website', 'ftp://example.com');
    form.set('avatarUrl', 'javascript:alert(1)');

    const result = validateContactForm(form);

    expect(result.ok).toBe(false);
    expect(result.errors.email).toBe('Enter a valid email address.');
    expect(result.errors.website).toBe('Use an http or https URL.');
    expect(result.errors.avatarUrl).toBe('Use an http or https URL.');
  });
});

describe('contact presentation', () => {
  it('derives stable initials and searchable text', () => {
    expect(getContactInitials(contact())).toBe('SC');
    expect(getContactSearchText(contact())).toContain('product designer');
    expect(getContactSearchText(contact())).toContain('@sarahchen');
  });

  it('filters case-insensitively and sorts favorites first', () => {
    const contacts = [
      contact({ id: '2', firstName: 'Maya', lastName: 'Patel' }),
      contact({ id: '1', favorite: true }),
    ];

    expect(filterContacts(contacts, 'LINEAR').map((item) => item.id)).toEqual(['1']);
    expect(sortContacts(contacts).map((item) => item.id)).toEqual(['1', '2']);
  });
});
```

- [ ] **Step 2: Run the unit tests and verify they fail**

Run:

```bash
bun test examples/address-book/db/validation.test.ts
```

Expected: FAIL because the domain modules do not exist.

- [ ] **Step 3: Define the domain types**

Create `examples/address-book/db/types.ts`:

```ts
export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  company: string;
  role: string;
  email: string;
  phone: string;
  location: string;
  handle: string;
  website: string;
  avatarUrl: string;
  notes: string;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ContactSummary = Pick<
  Contact,
  | 'id'
  | 'firstName'
  | 'lastName'
  | 'company'
  | 'role'
  | 'email'
  | 'handle'
  | 'avatarUrl'
  | 'favorite'
>;

export type ContactInput = Omit<
  Contact,
  'id' | 'favorite' | 'createdAt' | 'updatedAt'
>;

export type ContactFieldErrors = Partial<Record<
  keyof ContactInput | 'name',
  string
>>;

export type ContactFormValues = ContactInput;

export type ContactActionResult =
  | { ok: true; redirect?: string; contact?: Contact }
  | {
      ok: false;
      message: string;
      errors: ContactFieldErrors;
      values: ContactFormValues;
    };
```

- [ ] **Step 4: Implement validation**

Create `examples/address-book/db/validation.ts`:

```ts
import type {
  ContactFieldErrors,
  ContactFormValues,
} from './types.js';

const fields = [
  'firstName',
  'lastName',
  'company',
  'role',
  'email',
  'phone',
  'location',
  'handle',
  'website',
  'avatarUrl',
  'notes',
] as const;

function read(form: FormData, name: typeof fields[number]): string {
  return String(form.get(name) ?? '').trim();
}

function isHttpUrl(value: string): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateContactForm(form: FormData):
  | { ok: true; values: ContactFormValues }
  | {
      ok: false;
      values: ContactFormValues;
      errors: ContactFieldErrors;
    } {
  const values = Object.fromEntries(
    fields.map((field) => [field, read(form, field)]),
  ) as ContactFormValues;
  const errors: ContactFieldErrors = {};

  if (!values.firstName && !values.lastName) {
    errors.name = 'Enter a first or last name.';
  }
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    errors.email = 'Enter a valid email address.';
  }
  if (!isHttpUrl(values.website)) {
    errors.website = 'Use an http or https URL.';
  }
  if (!isHttpUrl(values.avatarUrl)) {
    errors.avatarUrl = 'Use an http or https URL.';
  }
  if (values.notes.length > 2000) {
    errors.notes = 'Keep notes under 2,000 characters.';
  }

  return Object.keys(errors).length > 0
    ? { ok: false, values, errors }
    : { ok: true, values };
}
```

- [ ] **Step 5: Implement presentation helpers**

Create `examples/address-book/db/presentation.ts`:

```ts
import type { Contact } from './types.js';

export function getContactName(contact: Pick<Contact, 'firstName' | 'lastName'>): string {
  return [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Unnamed contact';
}

export function getContactInitials(
  contact: Pick<Contact, 'firstName' | 'lastName'>,
): string {
  const initials = [contact.firstName, contact.lastName]
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase())
    .join('');
  return initials || '??';
}

export function getContactSearchText(contact: SearchableContact): string {
  return [
    contact.firstName,
    contact.lastName,
    contact.company,
    contact.role,
    contact.email,
    contact.handle,
  ].join(' ').toLocaleLowerCase();
}

export function sortContacts<T extends ContactSummary>(contacts: T[]): T[] {
  return [...contacts].sort((left, right) =>
    Number(right.favorite) - Number(left.favorite) ||
    left.lastName.localeCompare(right.lastName, undefined, { sensitivity: 'base' }) ||
    left.firstName.localeCompare(right.firstName, undefined, { sensitivity: 'base' }) ||
    Number(left.id) - Number(right.id)
  );
}

export function filterContacts<T extends SearchableContact>(
  contacts: T[],
  query: string,
): T[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return contacts;
  return contacts.filter((contact) =>
    getContactSearchText(contact).includes(normalized)
  );
}
```

- [ ] **Step 6: Run the unit tests**

Run:

```bash
bun test examples/address-book/db/validation.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 7: Commit the domain helpers**

```bash
git add examples/address-book/db/types.ts examples/address-book/db/validation.ts examples/address-book/db/presentation.ts examples/address-book/db/validation.test.ts
git commit -m "feat(example): add contact domain helpers"
```

---

### Task 5: Implement Transactional Contact Persistence

**Files:**
- Create: `examples/address-book/db/contacts.ts`
- Create: `examples/address-book/db/contacts.integration.test.ts`

- [ ] **Step 1: Write the failing database tests**

Create `examples/address-book/db/contacts.integration.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { SQL } from 'bun';
import {
  createContact,
  deleteContact,
  getContact,
  listContacts,
  toggleFavorite,
  updateContact,
} from './contacts.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const db = new SQL(databaseUrl);

beforeEach(async () => {
  await db`DELETE FROM contact_events`;
  await db`DELETE FROM contacts`;
});

afterAll(async () => {
  await db`DELETE FROM contact_events`;
  await db`DELETE FROM contacts`;
  await db.close();
});

const input = {
  firstName: 'Sarah',
  lastName: 'Chen',
  company: 'Linear',
  role: 'Product Designer',
  email: 'sarah@linear.app',
  phone: '',
  location: 'San Francisco',
  handle: '@sarahchen',
  website: 'https://sarahchen.com',
  avatarUrl: '',
  notes: '',
};

describe('contact persistence', () => {
  it('creates, updates, favorites, and deletes with matching events', async () => {
    const created = await createContact(db, input);
    expect((await listContacts(db)).map((contact) => contact.id)).toEqual([created.id]);

    const updated = await updateContact(db, created.id, {
      ...input,
      role: 'Design Lead',
    });
    expect(updated?.role).toBe('Design Lead');

    const favorited = await toggleFavorite(db, created.id, true);
    expect(favorited?.favorite).toBe(true);

    expect(await deleteContact(db, created.id)).toBe(true);
    expect(await getContact(db, created.id)).toBeNull();

    const events = await db<{ kind: string }[]>`
      SELECT kind FROM contact_events ORDER BY id
    `;
    expect(events.map((event) => event.kind)).toEqual([
      'create',
      'update',
      'favorite',
      'delete',
    ]);
  });

  it('rolls back the contact mutation when event insertion fails', async () => {
    await db.unsafe(`
      CREATE OR REPLACE FUNCTION address_book_fail_event() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'event failure';
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS address_book_fail_event_trigger ON contact_events;
      CREATE TRIGGER address_book_fail_event_trigger
      BEFORE INSERT ON contact_events
      FOR EACH ROW EXECUTE FUNCTION address_book_fail_event();
    `);

    try {
      await expect(createContact(db, input)).rejects.toThrow('event failure');
      expect(await listContacts(db)).toEqual([]);
    } finally {
      await db.unsafe(`
        DROP TRIGGER IF EXISTS address_book_fail_event_trigger ON contact_events;
        DROP FUNCTION IF EXISTS address_book_fail_event();
      `);
    }
  });
});
```

- [ ] **Step 2: Run the database test and verify it fails**

Run:

```bash
bun --env-file=examples/address-book/.env examples/address-book/db/contacts.integration.test.ts
```

Expected: FAIL because `db/contacts.ts` does not exist.

- [ ] **Step 3: Implement row mapping, queries, and transactions**

Create `examples/address-book/db/contacts.ts`:

```ts
import type { SQL } from 'bun';
import type { Contact, ContactInput, ContactSummary } from './types.js';

interface ContactRow {
  id: string;
  first_name: string;
  last_name: string;
  company: string;
  role: string;
  email: string;
  phone: string;
  location: string;
  handle: string;
  website: string;
  avatar_url: string;
  notes: string;
  favorite: boolean;
  created_at: string;
  updated_at: string;
}

const columns = `
  id::text,
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
  favorite,
  created_at::text,
  updated_at::text
`;

function mapContact(row: ContactRow): Contact {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    company: row.company,
    role: row.role,
    email: row.email,
    phone: row.phone,
    location: row.location,
    handle: row.handle,
    website: row.website,
    avatarUrl: row.avatar_url,
    notes: row.notes,
    favorite: row.favorite,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listContacts(db: SQL): Promise<Contact[]> {
  const rows = await db.unsafe(`
    SELECT ${columns}
    FROM contacts
    ORDER BY
      favorite DESC,
      lower(last_name),
      lower(first_name),
      id
  `) as ContactRow[];
  return rows.map(mapContact);
}

export async function listContactSummaries(db: SQL): Promise<ContactSummary[]> {
  return (await listContacts(db)).map((contact) => ({
    id: contact.id,
    firstName: contact.firstName,
    lastName: contact.lastName,
    company: contact.company,
    role: contact.role,
    email: contact.email,
    handle: contact.handle,
    avatarUrl: contact.avatarUrl,
    favorite: contact.favorite,
  }));
}

export async function getContact(db: SQL, id: string): Promise<Contact | null> {
  const rows = await db.unsafe(
    `SELECT ${columns} FROM contacts WHERE id = $1`,
    [id],
  ) as ContactRow[];
  return rows[0] ? mapContact(rows[0]) : null;
}

export async function createContact(db: SQL, input: ContactInput): Promise<Contact> {
  return db.begin(async (tx) => {
    const rows = await tx.unsafe(
      `INSERT INTO contacts (
        first_name, last_name, company, role, email, phone,
        location, handle, website, avatar_url, notes
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
      ) RETURNING ${columns}`,
      [
        input.firstName,
        input.lastName,
        input.company,
        input.role,
        input.email,
        input.phone,
        input.location,
        input.handle,
        input.website,
        input.avatarUrl,
        input.notes,
      ],
    ) as ContactRow[];
    const contact = mapContact(rows[0]!);
    await tx`INSERT INTO contact_events (contact_id, kind) VALUES (${contact.id}, 'create')`;
    return contact;
  });
}

export async function updateContact(
  db: SQL,
  id: string,
  input: ContactInput,
): Promise<Contact | null> {
  return db.begin(async (tx) => {
    const rows = await tx.unsafe(
      `UPDATE contacts SET
        first_name = $2,
        last_name = $3,
        company = $4,
        role = $5,
        email = $6,
        phone = $7,
        location = $8,
        handle = $9,
        website = $10,
        avatar_url = $11,
        notes = $12,
        updated_at = NOW()
      WHERE id = $1
      RETURNING ${columns}`,
      [
        id,
        input.firstName,
        input.lastName,
        input.company,
        input.role,
        input.email,
        input.phone,
        input.location,
        input.handle,
        input.website,
        input.avatarUrl,
        input.notes,
      ],
    ) as ContactRow[];
    if (!rows[0]) return null;
    await tx`INSERT INTO contact_events (contact_id, kind) VALUES (${id}, 'update')`;
    return mapContact(rows[0]);
  });
}

export async function toggleFavorite(
  db: SQL,
  id: string,
  favorite: boolean,
): Promise<Contact | null> {
  return db.begin(async (tx) => {
    const rows = await tx.unsafe(
      `UPDATE contacts
       SET favorite = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING ${columns}`,
      [id, favorite],
    ) as ContactRow[];
    if (!rows[0]) return null;
    await tx`INSERT INTO contact_events (contact_id, kind) VALUES (${id}, 'favorite')`;
    return mapContact(rows[0]);
  });
}

export async function deleteContact(db: SQL, id: string): Promise<boolean> {
  return db.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      DELETE FROM contacts WHERE id = ${id} RETURNING id::text
    `;
    if (!rows[0]) return false;
    await tx`INSERT INTO contact_events (contact_id, kind) VALUES (${id}, 'delete')`;
    return true;
  });
}
```

- [ ] **Step 4: Run database tests**

Run:

```bash
bun --env-file=examples/address-book/.env examples/address-book/db/contacts.integration.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 5: Commit persistence**

```bash
git add examples/address-book/db/contacts.ts examples/address-book/db/contacts.integration.test.ts
git commit -m "feat(example): add transactional contact store"
```

---

### Task 6: Build the Live Directory and Shared Shell

**Files:**
- Create: `examples/address-book/features/contacts/live.ts`
- Create: `examples/address-book/components/Avatar.tsx`
- Create: `examples/address-book/components/Directory.tsx`
- Create: `examples/address-book/components/AppShell.tsx`
- Create: `examples/address-book/components/EmptyDetail.tsx`
- Create: `examples/address-book/pages/_layout.tsx`

- [ ] **Step 1: Create the complete contacts Live.list**

Create `examples/address-book/features/contacts/live.ts`:

```ts
import type { SQL } from 'bun';
import { Live } from '@kiln/core';
import { listContactSummaries } from '../../db/contacts.js';
import type { ContactSummary } from '../../db/types.js';

export function contactsLiveList() {
  return Live.list<ContactSummary>({
    key: (contact) => contact.id,
    dependsOn: 'contact_events',
    query: async ({ sql }) => listContactSummaries(sql as SQL),
  });
}
```

- [ ] **Step 2: Create portrait markup**

Create `examples/address-book/components/Avatar.tsx`:

```tsx
import React from 'react';
import { getContactInitials, getContactName } from '../db/presentation.js';
import type { ContactSummary } from '../db/types.js';

type AvatarContact = Pick<
  Contact,
  'id' | 'firstName' | 'lastName' | 'avatarUrl'
>;

export function Avatar({
  contact,
  size = 'row',
}: {
  contact: AvatarContact;
  size?: 'row' | 'hero';
}) {
  const initials = getContactInitials(contact);
  const hue = Number(contact.id) * 47 % 360;

  return (
    <span
      className={`avatar avatar--${size}`}
      data-avatar
      style={{ '--avatar-hue': hue } as React.CSSProperties}
    >
      <span className="avatar__fallback" aria-hidden="true">{initials}</span>
      {contact.avatarUrl ? (
        <img
          className="avatar__image"
          src={contact.avatarUrl}
          alt={`${getContactName(contact)} portrait`}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : null}
    </span>
  );
}
```

- [ ] **Step 3: Create the semantic live directory**

Create `examples/address-book/components/Directory.tsx`:

```tsx
import React from 'react';
import type { ContactSummary } from '../db/types.js';
import {
  getContactName,
  getContactSearchText,
} from '../db/presentation.js';
import { Avatar } from './Avatar.js';

export function Directory({
  contacts,
  selectedId,
  query,
}: {
  contacts: ContactSummary[];
  selectedId?: string;
  query: string;
}) {
  let previousFavorite: boolean | undefined;

  return (
    <aside className="directory" aria-label="Contact directory">
      <div className="directory__header">
        <a className="directory__brand" href="/contacts" s-html="">Directory</a>
        <a className="icon-button icon-button--primary" href="/contacts/new" s-html="" data-preserve-query aria-label="Create contact">+</a>
      </div>
      <label className="search">
        <span className="sr-only">Search people</span>
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search people"
          autoComplete="off"
          data-contact-search-input
        />
      </label>
      <p className="sr-only" aria-live="polite" data-search-status />
      <ul className="directory__list" data-contact-list>
        {contacts.map((contact) => {
          const showSection = previousFavorite !== contact.favorite;
          previousFavorite = contact.favorite;
          return (
            <li
              key={contact.id}
              className="directory__item"
              data-contact-row
              data-search={getContactSearchText(contact)}
            >
              <span
                className="directory__section"
                data-section-label
                data-section={contact.favorite ? 'favorites' : 'all'}
                hidden={!showSection}
              >
                {contact.favorite ? 'Favorites' : 'All contacts'}
              </span>
              <a
                className="contact-row"
                href={`/contacts/${contact.id}`}
                s-html=""
                data-preserve-query
                aria-current={selectedId === contact.id ? 'page' : undefined}
              >
                <Avatar contact={contact} />
                <span className="contact-row__copy">
                  <strong>{getContactName(contact)}</strong>
                  <small>{[contact.role, contact.company].filter(Boolean).join(' · ')}</small>
                </span>
                {contact.favorite ? <span className="contact-row__favorite" aria-label="Favorite">★</span> : null}
              </a>
              <span hidden>{contact.email} {contact.handle}</span>
            </li>
          );
        })}
      </ul>
      <div className="directory__empty" hidden data-search-empty>
        No contacts match this search.
      </div>
      <footer className="directory__footer">
        <span>{contacts.length} people</span>
        <span>Live updates enabled</span>
      </footer>
    </aside>
  );
}
```

- [ ] **Step 4: Create shell and empty states**

Create `examples/address-book/components/AppShell.tsx`:

```tsx
import React from 'react';
import type { Contact } from '../db/types.js';
import { Directory } from './Directory.js';

export function AppShell({
  contacts,
  selectedId,
  query,
  focusDetail = false,
  children,
}: {
  contacts: ContactSummary[];
  selectedId?: string;
  query: string;
  focusDetail?: boolean;
  children: React.ReactNode;
}) {
  return (
    <main className={`app-shell${focusDetail ? ' app-shell--detail' : ''}`}>
      <Directory contacts={contacts} selectedId={selectedId} query={query} />
      <section className="detail-pane" id="detail">
        {children}
      </section>
    </main>
  );
}
```

Create `examples/address-book/components/EmptyDetail.tsx`:

```tsx
import React from 'react';

export function EmptyDetail({ missing = false }: { missing?: boolean }) {
  return (
    <div className="empty-detail">
      <p className="empty-detail__mark" aria-hidden="true">{missing ? '404' : '＋'}</p>
      <h1>{missing ? 'Contact not found' : 'Select a contact'}</h1>
      <p>
        {missing
          ? 'This contact may have been deleted in another session.'
          : 'Choose someone from the directory or create a new contact.'}
      </p>
      <a className="button button--primary" href={missing ? '/contacts' : '/contacts/new'} s-html="" data-preserve-query>
        {missing ? 'Back to directory' : 'Create contact'}
      </a>
    </div>
  );
}
```

- [ ] **Step 5: Create the document layout**

Create `examples/address-book/pages/_layout.tsx`:

```tsx
import React from 'react';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="theme-color" content="#18232d" />
        <title>Directory · Kiln Address Book</title>
        <link rel="stylesheet" href="/assets/address-book.css" />
        <script src="/_silcrow/silcrow.js" defer />
        <script src="/_kiln/live.js" defer />
        <script src="/assets/address-book.js" defer />
      </head>
      <body>
        <div id="app" data-ps-layout="/">{children}</div>
      </body>
    </html>
  );
}
```

- [ ] **Step 6: Type-check the shared rendering**

Run:

```bash
bun --cwd examples/address-book run build
```

Expected: remaining failures only reference route modules, CSS, and client assets that are created in later tasks.

- [ ] **Step 7: Commit shared rendering**

```bash
git add examples/address-book/features/contacts/live.ts examples/address-book/components/Avatar.tsx examples/address-book/components/Directory.tsx examples/address-book/components/AppShell.tsx examples/address-book/components/EmptyDetail.tsx examples/address-book/pages/_layout.tsx
git commit -m "feat(example): add live contact directory shell"
```

---

### Task 7: Add Root and Directory Routes

**Files:**
- Create: `examples/address-book/pages/index.tsx`
- Create: `examples/address-book/pages/contacts/index.tsx`
- Create: `examples/address-book/tests/routes.test.ts`

- [ ] **Step 1: Write failing route-loader tests**

Create `examples/address-book/tests/routes.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { load as loadContacts } from '../pages/contacts/index.js';
import { load as loadRoot } from '../pages/index.js';

const request = (query: Record<string, string> = {}) => ({
  path: '/contacts',
  method: 'GET',
  params: {},
  query,
  headers: new Headers(),
  formData: async () => new FormData(),
  json: async () => ({}),
  isEnhanced: false,
  layoutsPresent: [],
  prebakeNext: () => {},
});

describe('address book routes', () => {
  it('redirects the root route to contacts', () => {
    expect(() => loadRoot()).toThrow('/contacts');
  });

  it('keeps q as page state while the live query remains complete', async () => {
    const result = await loadContacts(request({ q: 'Sarah' }) as any);
    expect(result.query).toBe('Sarah');
    expect(Array.isArray(result.contacts)).toBe(true);
    expect(result.contacts).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the route tests and verify they fail**

Run:

```bash
bun test examples/address-book/tests/routes.test.ts
```

Expected: FAIL because the route modules do not exist.

- [ ] **Step 3: Implement the root redirect**

Create `examples/address-book/pages/index.tsx`:

```tsx
import React from 'react';
import { AppError } from '@kiln/core';

export function load(): never {
  throw AppError.redirect('/contacts');
}

export default function RootPage() {
  return <></>;
}
```

- [ ] **Step 4: Implement the directory route**

Create `examples/address-book/pages/contacts/index.tsx`:

```tsx
import React from 'react';
import type { KilnRequest } from '@kiln/core';
import { AppShell } from '../../components/AppShell.js';
import { EmptyDetail } from '../../components/EmptyDetail.js';
import { contactsLiveList } from '../../features/contacts/live.js';

export function load(req: KilnRequest) {
  return {
    contacts: contactsLiveList(),
    query: req.query.q ?? '',
  };
}

export default function ContactsPage({
  contacts,
  query,
}: Awaited<ReturnType<typeof load>>) {
  return (
    <AppShell contacts={contacts} query={query}>
      <EmptyDetail />
    </AppShell>
  );
}
```

- [ ] **Step 5: Run route tests**

Run:

```bash
bun test examples/address-book/tests/routes.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 6: Commit the base routes**

```bash
git add examples/address-book/pages/index.tsx examples/address-book/pages/contacts/index.tsx examples/address-book/tests/routes.test.ts
git commit -m "feat(example): add address book directory routes"
```

---

### Task 8: Add Shared Contact Form and Create Route

**Files:**
- Create: `examples/address-book/components/ContactForm.tsx`
- Create: `examples/address-book/pages/contacts/new.tsx`
- Modify: `examples/address-book/tests/routes.test.ts`

- [ ] **Step 1: Add the failing create-action test**

Append:

```ts
import { actions as newContactActions } from '../pages/contacts/new.js';

it('returns field errors for an invalid create action', async () => {
  const form = new FormData();
  form.set('email', 'broken');
  const result = await newContactActions.create({
    ...request(),
    method: 'POST',
    isEnhanced: true,
    formData: async () => form,
  } as any);

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors.name).toBe('Enter a first or last name.');
    expect(result.errors.email).toBe('Enter a valid email address.');
  }
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
bun test examples/address-book/tests/routes.test.ts
```

Expected: FAIL because `contacts/new.tsx` does not exist.

- [ ] **Step 3: Create the shared contact form**

Create `examples/address-book/components/ContactForm.tsx`:

```tsx
import React from 'react';
import type {
  ContactFieldErrors,
  ContactFormValues,
} from '../db/types.js';

const emptyValues: ContactFormValues = {
  firstName: '',
  lastName: '',
  company: '',
  role: '',
  email: '',
  phone: '',
  location: '',
  handle: '',
  website: '',
  avatarUrl: '',
  notes: '',
};

export function ContactForm({
  action,
  values = emptyValues,
  errors = {},
  submitLabel,
}: {
  action: string;
  values?: ContactFormValues;
  errors?: ContactFieldErrors;
  submitLabel: string;
}) {
  const field = (
    name: keyof ContactFormValues,
    label: string,
    type = 'text',
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        name={name}
        type={type}
        defaultValue={values[name]}
        aria-invalid={Boolean(errors[name])}
        aria-describedby={errors[name] ? `${name}-error` : undefined}
      />
      {errors[name] ? <small id={`${name}-error`} className="field__error">{errors[name]}</small> : null}
    </label>
  );

  return (
    <form className="contact-form" method="post" action={action} data-contact-form>
      <div className="contact-form__heading">
        <a href="/contacts" s-html="" data-preserve-query className="mobile-back">‹ People</a>
        <h1>{submitLabel}</h1>
      </div>
      {errors.name ? <p className="form-error">{errors.name}</p> : null}
      <div className="form-grid">
        {field('firstName', 'First name')}
        {field('lastName', 'Last name')}
        {field('company', 'Company')}
        {field('role', 'Role')}
        {field('email', 'Email', 'email')}
        {field('phone', 'Phone', 'tel')}
        {field('location', 'Location')}
        {field('handle', 'Handle')}
        {field('website', 'Website', 'url')}
        {field('avatarUrl', 'Portrait URL', 'url')}
        <label className="field field--wide">
          <span>Notes</span>
          <textarea name="notes" defaultValue={values.notes} maxLength={2000} rows={6} />
          {errors.notes ? <small className="field__error">{errors.notes}</small> : null}
        </label>
      </div>
      <p className="form-error" hidden data-form-message />
      <div className="form-actions">
        <a className="button" href="/contacts" s-html="" data-preserve-query>Cancel</a>
        <button className="button button--primary" type="submit" data-submit-label={submitLabel}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 4: Implement the create route and action**

Create `examples/address-book/pages/contacts/new.tsx`:

```tsx
import React from 'react';
import { AppError, type KilnRequest } from '@kiln/core';
import { AppShell } from '../../components/AppShell.js';
import { ContactForm } from '../../components/ContactForm.js';
import { sql } from '../../db/client.js';
import { createContact } from '../../db/contacts.js';
import { validateContactForm } from '../../db/validation.js';
import { contactsLiveList } from '../../features/contacts/live.js';

export function load(req: KilnRequest) {
  return {
    contacts: contactsLiveList(),
    query: req.query.q ?? '',
  };
}

export const actions = {
  async create(req: KilnRequest) {
    const parsed = validateContactForm(await req.formData());
    if (!parsed.ok) {
      return {
        ok: false as const,
        message: 'Check the highlighted fields.',
        errors: parsed.errors,
        values: parsed.values,
      };
    }
    const contact = await createContact(sql, parsed.values);
    const redirect = `/contacts/${contact.id}`;
    if (!req.isEnhanced) throw AppError.redirect(redirect);
    return { ok: true as const, redirect, contact };
  },
};

export default function NewContactPage({
  contacts,
  query,
}: Awaited<ReturnType<typeof load>>) {
  return (
    <AppShell contacts={contacts} query={query} focusDetail>
      <ContactForm action="?/create" submitLabel="Create contact" />
    </AppShell>
  );
}
```

- [ ] **Step 5: Run route tests**

Run:

```bash
bun test examples/address-book/tests/routes.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 6: Commit create flow**

```bash
git add examples/address-book/components/ContactForm.tsx examples/address-book/pages/contacts/new.tsx examples/address-book/tests/routes.test.ts
git commit -m "feat(example): add contact creation flow"
```

---

### Task 9: Add Contact Detail, Favorite, Delete, and Edit Routes

**Files:**
- Create: `examples/address-book/components/ContactDetail.tsx`
- Create: `examples/address-book/pages/contacts/[id]/index.tsx`
- Create: `examples/address-book/pages/contacts/[id]/edit.tsx`
- Modify: `examples/address-book/tests/routes.test.ts`

- [ ] **Step 1: Add failing action and missing-contact tests**

Append tests using a unique nonexistent ID:

```ts
import { load as loadDetail } from '../pages/contacts/[id]/index.js';

it('returns a missing contact state for an unknown id', async () => {
  const result = await loadDetail({
    ...request(),
    path: '/contacts/999999999',
    params: { id: '999999999' },
  } as any);
  expect(result.contact).toBeNull();
  expect(result.selectedId).toBe('999999999');
});
```

- [ ] **Step 2: Run the route test and verify it fails**

Run:

```bash
bun --env-file=examples/address-book/.env test examples/address-book/tests/routes.test.ts
```

Expected: FAIL because the detail route does not exist.

- [ ] **Step 3: Create contact detail rendering**

Create `examples/address-book/components/ContactDetail.tsx`:

```tsx
import React from 'react';
import { getContactName } from '../db/presentation.js';
import type { Contact } from '../db/types.js';
import { Avatar } from './Avatar.js';

export function ContactDetail({ contact }: { contact: Contact }) {
  return (
    <article className="contact-detail">
      <header className="detail-toolbar">
        <a className="mobile-back" href="/contacts" s-html="" data-preserve-query>‹ People</a>
        <div className="detail-toolbar__actions">
          <a className="button" href={`/contacts/${contact.id}/edit`} s-html="" data-preserve-query>Edit contact</a>
          <form method="post" action="?/delete" data-delete-form>
            <button className="button button--danger" type="submit">Delete</button>
          </form>
        </div>
      </header>
      <section className="profile">
        <Avatar contact={contact} size="hero" />
        <div className="profile__copy">
          <div className="profile__name">
            <h1>{getContactName(contact)}</h1>
            <form method="post" action="?/favorite" data-favorite-form>
              <input type="hidden" name="favorite" value={contact.favorite ? 'false' : 'true'} />
              <button
                className="favorite-button"
                type="submit"
                aria-label={contact.favorite ? 'Remove from favorites' : 'Add to favorites'}
                aria-pressed={contact.favorite}
              >
                {contact.favorite ? '★' : '☆'}
              </button>
            </form>
          </div>
          <p>{[contact.role, contact.company, contact.location].filter(Boolean).join(' · ')}</p>
          <div className="profile__links">
            {contact.website ? <a href={contact.website} target="_blank" rel="noreferrer">Website</a> : null}
            {contact.handle ? <span>{contact.handle}</span> : null}
          </div>
        </div>
      </section>
      <dl className="contact-info">
        <div><dt>Email</dt><dd>{contact.email || 'Not provided'}</dd></div>
        <div><dt>Phone</dt><dd>{contact.phone || 'Not provided'}</dd></div>
        <div className="contact-info__notes"><dt>Notes</dt><dd>{contact.notes || 'No notes yet.'}</dd></div>
      </dl>
    </article>
  );
}
```

- [ ] **Step 4: Implement detail loading and actions**

Create `examples/address-book/pages/contacts/[id]/index.tsx`:

```tsx
import React from 'react';
import { AppError, type KilnRequest } from '@kiln/core';
import { AppShell } from '../../../components/AppShell.js';
import { ContactDetail } from '../../../components/ContactDetail.js';
import { EmptyDetail } from '../../../components/EmptyDetail.js';
import { sql } from '../../../db/client.js';
import {
  deleteContact,
  getContact,
  toggleFavorite,
} from '../../../db/contacts.js';
import { contactsLiveList } from '../../../features/contacts/live.js';

export async function load(req: KilnRequest) {
  return {
    contacts: contactsLiveList(),
    contact: await getContact(sql, req.params.id),
    selectedId: req.params.id,
    query: req.query.q ?? '',
  };
}

export const actions = {
  async favorite(req: KilnRequest) {
    const form = await req.formData();
    const favorite = form.get('favorite') === 'true';
    const contact = await toggleFavorite(sql, req.params.id, favorite);
    if (!contact) return { ok: false as const, message: 'Contact not found.' };
    return { ok: true as const, contact };
  },

  async delete(req: KilnRequest) {
    const deleted = await deleteContact(sql, req.params.id);
    if (!deleted) return { ok: false as const, message: 'Contact not found.' };
    if (!req.isEnhanced) throw AppError.redirect('/contacts');
    return { ok: true as const, redirect: '/contacts' };
  },
};

export default function ContactPage({
  contacts,
  contact,
  selectedId,
  query,
}: Awaited<ReturnType<typeof load>>) {
  return (
    <AppShell contacts={contacts} selectedId={selectedId} query={query} focusDetail>
      {contact ? <ContactDetail contact={contact} /> : <EmptyDetail missing />}
    </AppShell>
  );
}
```

- [ ] **Step 5: Implement the edit route**

Create `examples/address-book/pages/contacts/[id]/edit.tsx`:

```tsx
import React from 'react';
import { AppError, type KilnRequest } from '@kiln/core';
import { AppShell } from '../../../components/AppShell.js';
import { ContactForm } from '../../../components/ContactForm.js';
import { EmptyDetail } from '../../../components/EmptyDetail.js';
import { sql } from '../../../db/client.js';
import { getContact, updateContact } from '../../../db/contacts.js';
import { validateContactForm } from '../../../db/validation.js';
import { contactsLiveList } from '../../../features/contacts/live.js';

export async function load(req: KilnRequest) {
  return {
    contacts: contactsLiveList(),
    contact: await getContact(sql, req.params.id),
    selectedId: req.params.id,
    query: req.query.q ?? '',
  };
}

export const actions = {
  async update(req: KilnRequest) {
    const parsed = validateContactForm(await req.formData());
    if (!parsed.ok) {
      return {
        ok: false as const,
        message: 'Check the highlighted fields.',
        errors: parsed.errors,
        values: parsed.values,
      };
    }
    const contact = await updateContact(sql, req.params.id, parsed.values);
    if (!contact) return { ok: false as const, message: 'Contact not found.' };
    const redirect = `/contacts/${contact.id}`;
    if (!req.isEnhanced) throw AppError.redirect(redirect);
    return { ok: true as const, redirect, contact };
  },
};

export default function EditContactPage({
  contacts,
  contact,
  selectedId,
  query,
}: Awaited<ReturnType<typeof load>>) {
  return (
    <AppShell contacts={contacts} selectedId={selectedId} query={query} focusDetail>
      {contact ? (
        <ContactForm
          action="?/update"
          submitLabel="Save changes"
          values={contact}
        />
      ) : (
        <EmptyDetail missing />
      )}
    </AppShell>
  );
}
```

- [ ] **Step 6: Run route and database tests**

Run:

```bash
bun --env-file=examples/address-book/.env test examples/address-book/tests/routes.test.ts
bun --env-file=examples/address-book/.env examples/address-book/db/contacts.integration.test.ts
```

Expected: all route tests and both database tests PASS.

- [ ] **Step 7: Commit detail and edit flows**

```bash
git add examples/address-book/components/ContactDetail.tsx examples/address-book/pages/contacts/'[id]'/index.tsx examples/address-book/pages/contacts/'[id]'/edit.tsx examples/address-book/tests/routes.test.ts
git commit -m "feat(example): add contact detail and editing"
```

---

### Task 10: Add Browser Behavior for Search and Mutations

**Files:**
- Create: `examples/address-book/client/address-book.js`

- [ ] **Step 1: Create the browser controller**

Create `examples/address-book/client/address-book.js`:

```js
function initAvatars(root = document) {
  root.querySelectorAll('[data-avatar] img').forEach((image) => {
    if (image.dataset.fallbackBound === 'true') return;
    image.dataset.fallbackBound = 'true';
    image.addEventListener('error', () => image.remove(), { once: true });
  });
}

function applySearch() {
  const input = document.querySelector('[data-contact-search-input]');
  if (!input) return;
  const query = input.value.trim().toLocaleLowerCase();
  const rows = [...document.querySelectorAll('[data-contact-row]')];
  let visible = 0;

  rows.forEach((row) => {
    const matches = !query || (row.dataset.search || '').includes(query);
    row.hidden = !matches;
    if (matches) visible += 1;
  });

  const url = new URL(location.href);
  if (query) url.searchParams.set('q', input.value.trim());
  else url.searchParams.delete('q');
  history.replaceState(history.state, '', url);
  document.querySelectorAll('[data-preserve-query]').forEach((link) => {
    const target = new URL(link.getAttribute('href'), location.origin);
    if (query) target.searchParams.set('q', input.value.trim());
    else target.searchParams.delete('q');
    link.setAttribute('href', `${target.pathname}${target.search}`);
  });

  const status = document.querySelector('[data-search-status]');
  if (status) status.textContent = `${visible} contact${visible === 1 ? '' : 's'} shown`;
  const empty = document.querySelector('[data-search-empty]');
  if (empty) empty.hidden = visible !== 0;

  let favoriteLabelShown = false;
  let allLabelShown = false;
  rows.forEach((row) => {
    const label = row.querySelector('[data-section-label]');
    if (!label || row.hidden) {
      if (label) label.hidden = true;
      return;
    }
    const favorite = label.dataset.section === 'favorites';
    const alreadyShown = favorite ? favoriteLabelShown : allLabelShown;
    label.hidden = alreadyShown;
    if (favorite) favoriteLabelShown = true;
    else allLabelShown = true;
  });
}

function initSearch() {
  const input = document.querySelector('[data-contact-search-input]');
  if (!input || input.dataset.searchBound === 'true') return;
  input.dataset.searchBound = 'true';
  input.addEventListener('input', applySearch);
  applySearch();
}

function setPending(form, pending) {
  form.classList.toggle('is-pending', pending);
  form.setAttribute('aria-busy', String(pending));
  form.querySelectorAll('button, input, textarea').forEach((control) => {
    control.disabled = pending;
  });
  const submit = form.querySelector('[data-submit-label]');
  if (submit) {
    submit.textContent = pending ? 'Saving…' : submit.dataset.submitLabel;
  }
}

function clearErrors(form) {
  form.querySelectorAll('.field__error, .form-error').forEach((error) => {
    if (error.hasAttribute('data-form-message')) {
      error.hidden = true;
      error.textContent = '';
    } else {
      error.remove();
    }
  });
  form.querySelectorAll('[aria-invalid="true"]').forEach((field) => {
    field.removeAttribute('aria-invalid');
  });
}

function renderErrors(form, result) {
  const message = form.querySelector('[data-form-message]');
  if (message) {
    message.hidden = false;
    message.textContent = result.message || 'Check the highlighted fields.';
  }
  Object.entries(result.errors || {}).forEach(([name, text]) => {
    if (name === 'name') return;
    const field = form.elements.namedItem(name);
    if (!(field instanceof HTMLElement)) return;
    field.setAttribute('aria-invalid', 'true');
    const error = document.createElement('small');
    error.className = 'field__error';
    error.textContent = text;
    field.closest('.field')?.append(error);
  });
}

function followRedirect(path) {
  const target = new URL(path, location.origin);
  const query = new URL(location.href).searchParams.get('q');
  if (query) target.searchParams.set('q', query);
  location.assign(target);
}

async function submitForm(form) {
  clearErrors(form);
  const formData = new FormData(form);
  setPending(form, true);
  try {
    const response = await window.Silcrow.submit(form.action, formData, {
      method: 'POST',
    });
    const result = response.data;
    if (result?.ok && result.redirect) {
      followRedirect(result.redirect);
      return;
    }
    if (!result?.ok) renderErrors(form, result || {});
  } finally {
    setPending(form, false);
  }
}

async function submitFavorite(form) {
  const button = form.querySelector('button');
  const input = form.querySelector('input[name="favorite"]');
  const next = input.value === 'true';
  const formData = new FormData(form);
  button.textContent = next ? '★' : '☆';
  button.setAttribute('aria-pressed', String(next));
  input.value = String(!next);

  const response = await window.Silcrow.submit(form.action, formData, {
    method: 'POST',
  });
  if (!response.ok || !response.data?.ok) {
    button.textContent = next ? '☆' : '★';
    button.setAttribute('aria-pressed', String(!next));
    input.value = String(next);
  }
}

function initForms() {
  document.querySelectorAll('[data-contact-form]').forEach((form) => {
    if (form.dataset.formBound === 'true') return;
    form.dataset.formBound = 'true';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void submitForm(form);
    });
  });

  document.querySelectorAll('[data-favorite-form]').forEach((form) => {
    if (form.dataset.formBound === 'true') return;
    form.dataset.formBound = 'true';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void submitFavorite(form);
    });
  });

  document.querySelectorAll('[data-delete-form]').forEach((form) => {
    if (form.dataset.formBound === 'true') return;
    form.dataset.formBound = 'true';
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!window.confirm('Delete this contact? This cannot be undone.')) return;
      setPending(form, true);
      try {
        const response = await window.Silcrow.submit(form.action, new FormData(form), {
          method: 'POST',
        });
        if (response.data?.ok && response.data.redirect) {
          followRedirect(response.data.redirect);
        }
      } finally {
        setPending(form, false);
      }
    });
  });
}

function init() {
  initAvatars();
  initSearch();
  initForms();
}

document.addEventListener('DOMContentLoaded', init);
document.addEventListener('silcrow:load', init);

new MutationObserver(() => {
  initAvatars();
  applySearch();
  initForms();
}).observe(document.documentElement, { childList: true, subtree: true });
```

- [ ] **Step 2: Run JavaScript syntax validation**

Run:

```bash
node --check examples/address-book/client/address-book.js
```

Expected: exit 0.

- [ ] **Step 3: Commit browser behavior**

```bash
git add examples/address-book/client/address-book.js
git commit -m "feat(example): add address book browser behavior"
```

---

### Task 11: Implement the Approved Responsive Visual System

**Files:**
- Create: `examples/address-book/styles/app.css`

- [ ] **Step 1: Create the design tokens and desktop shell**

Create `examples/address-book/styles/app.css` with these required rules:

```css
:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --rail: #18232d;
  --rail-elevated: #202d38;
  --paper: #f5f7f9;
  --ink: #17212b;
  --muted: #77828d;
  --line: #dfe5ea;
  --accent: #4f7cff;
  --danger: #b44b4b;
  --favorite: #f4bd4c;
  --control-radius: 9px;
  --panel-radius: 12px;
}

* { box-sizing: border-box; }
html, body, #app { min-height: 100%; margin: 0; }
body { background: var(--paper); color: var(--ink); }
a { color: inherit; }
button, input, textarea { font: inherit; }
button, a { -webkit-tap-highlight-color: transparent; }
:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent), white 25%); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

.app-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 21rem minmax(0, 1fr);
}

.directory {
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 1.5rem 1.1rem 1rem;
  overflow: hidden;
  background: var(--rail);
  color: white;
}

.directory__header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1.15rem; }
.directory__brand { font-size: 1.25rem; font-weight: 760; letter-spacing: -.04em; text-decoration: none; }
.icon-button { width: 2.15rem; height: 2.15rem; display: grid; place-items: center; border: 0; border-radius: var(--control-radius); text-decoration: none; font-size: 1.35rem; }
.icon-button--primary { background: var(--accent); color: white; }

.search input {
  width: 100%;
  height: 2.65rem;
  border: 1px solid rgb(255 255 255 / 8%);
  border-radius: 10px;
  padding: 0 .85rem;
  background: var(--rail-elevated);
  color: white;
}
.search input::placeholder { color: #85929d; }

.directory__list { flex: 1; min-height: 0; margin: 1rem 0 0; padding: 0; list-style: none; overflow-y: auto; }
.directory__item { margin: 0 0 .2rem; }
.directory__section { display: block; margin: .9rem .6rem .55rem; color: #7f8d98; font-size: .62rem; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
.contact-row {
  min-height: 3.55rem;
  display: grid;
  grid-template-columns: 2.35rem minmax(0, 1fr) auto;
  align-items: center;
  gap: .7rem;
  padding: .55rem .65rem;
  border-radius: 11px;
  color: #c8d1d8;
  text-decoration: none;
}
.contact-row:hover { background: rgb(255 255 255 / 5%); }
.contact-row[aria-current="page"] { background: #2a3946; color: white; box-shadow: inset 3px 0 var(--accent); }
.contact-row__copy { min-width: 0; }
.contact-row__copy strong, .contact-row__copy small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.contact-row__copy strong { font-size: .8rem; }
.contact-row__copy small { margin-top: .2rem; color: #82919c; font-size: .66rem; }
.contact-row__favorite { color: var(--favorite); }
.directory__empty { margin: 2rem .75rem; color: #94a0aa; font-size: .82rem; }
.directory__footer { display: flex; justify-content: space-between; gap: 1rem; padding: .85rem .55rem 0; border-top: 1px solid rgb(255 255 255 / 8%); color: #70808b; font-size: .65rem; }

.avatar { position: relative; display: inline-grid; place-items: center; flex: none; overflow: hidden; border-radius: 999px; background: hsl(var(--avatar-hue) 32% 42%); color: white; font-weight: 760; }
.avatar--row { width: 2.35rem; height: 2.35rem; font-size: .72rem; }
.avatar--hero { width: 7rem; height: 7rem; font-size: 1.6rem; box-shadow: 0 16px 35px rgb(23 33 43 / 18%); }
.avatar__image { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }

.detail-pane { min-width: 0; min-height: 100vh; padding: 1.7rem 2.2rem 2.2rem; background: var(--paper); }
.detail-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.detail-toolbar__actions, .form-actions { display: flex; align-items: center; justify-content: flex-end; gap: .6rem; }
.button { min-height: 2.2rem; display: inline-flex; align-items: center; justify-content: center; border: 1px solid #d7dee4; border-radius: var(--control-radius); padding: 0 .9rem; background: white; color: var(--ink); text-decoration: none; font-size: .75rem; font-weight: 680; cursor: pointer; }
.button--primary { border-color: var(--accent); background: var(--accent); color: white; }
.button--danger { color: var(--danger); }
.button:disabled, .is-pending { opacity: .62; cursor: wait; }

.profile { max-width: 54rem; display: grid; grid-template-columns: 7rem minmax(0, 1fr); align-items: center; gap: 1.7rem; margin: 4.5rem auto 2.7rem; }
.profile__name { display: flex; align-items: center; gap: .7rem; }
.profile h1 { margin: 0; font-size: clamp(2rem, 4vw, 3rem); letter-spacing: -.055em; }
.profile__copy > p { margin: .55rem 0 1rem; color: var(--muted); }
.profile__links { display: flex; flex-wrap: wrap; gap: 1rem; color: #456bd7; font-size: .82rem; }
.favorite-button { width: 2.1rem; height: 2.1rem; border: 1px solid var(--line); border-radius: 999px; background: white; color: var(--favorite); font-size: 1.15rem; cursor: pointer; }

.contact-info { max-width: 54rem; display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; margin: 0 auto; }
.contact-info > div { min-height: 5.2rem; padding: 1rem; border: 1px solid var(--line); border-radius: var(--panel-radius); background: white; }
.contact-info__notes { grid-column: 1 / -1; }
.contact-info dt { color: #8a949d; font-size: .62rem; font-weight: 760; letter-spacing: .09em; text-transform: uppercase; }
.contact-info dd { margin: .55rem 0 0; line-height: 1.6; }

.empty-detail { min-height: calc(100vh - 4rem); display: grid; align-content: center; justify-items: center; text-align: center; }
.empty-detail__mark { margin: 0; color: #c5ccd2; font-size: 3rem; font-weight: 800; }
.empty-detail h1 { margin: .5rem 0; letter-spacing: -.04em; }
.empty-detail p { max-width: 28rem; margin: 0 0 1.4rem; color: var(--muted); line-height: 1.6; }

.contact-form { max-width: 54rem; margin: 2rem auto; }
.contact-form__heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
.contact-form h1 { margin: 0; letter-spacing: -.045em; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.field { display: grid; gap: .45rem; color: #596570; font-size: .75rem; font-weight: 650; }
.field--wide { grid-column: 1 / -1; }
.field input, .field textarea { width: 100%; border: 1px solid var(--line); border-radius: var(--control-radius); padding: .78rem .85rem; background: white; color: var(--ink); }
.field textarea { resize: vertical; }
.field [aria-invalid="true"] { border-color: var(--danger); }
.field__error, .form-error { color: var(--danger); font-size: .72rem; }
.form-actions { margin-top: 1.4rem; }
.mobile-back { display: none; color: #456bd7; text-decoration: none; font-size: .8rem; font-weight: 700; }

@media (max-width: 760px) {
  .app-shell { display: block; }
  .directory { position: static; width: 100%; height: 100vh; }
  .detail-pane { min-height: 100vh; padding: 1rem; }
  .app-shell:not(.app-shell--detail) .detail-pane { display: none; }
  .app-shell--detail .directory { display: none; }
  .mobile-back { display: inline-flex; }
  .profile { grid-template-columns: 1fr; justify-items: center; margin: 2rem auto; text-align: center; }
  .profile__name, .profile__links { justify-content: center; }
  .contact-info, .form-grid { grid-template-columns: 1fr; }
  .contact-info__notes, .field--wide { grid-column: auto; }
  .detail-toolbar { position: sticky; top: 0; z-index: 2; padding: .4rem 0 1rem; background: var(--paper); }
  .contact-form { margin: 0; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; }
}
```

- [ ] **Step 2: Run the example build**

Run:

```bash
bun --cwd examples/address-book run build
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Run focused tests**

Run:

```bash
bun test examples/address-book/db/validation.test.ts examples/address-book/tests/routes.test.ts
bun --env-file=examples/address-book/.env examples/address-book/db/contacts.integration.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 4: Commit the visual system**

```bash
git add examples/address-book/styles/app.css
git commit -m "feat(example): style address book workspace"
```

---

### Task 12: Add End-to-End Browser Coverage

**Files:**
- Create: `examples/address-book/playwright.config.ts`
- Create: `examples/address-book/tests/address-book.spec.ts`

- [ ] **Step 1: Create Playwright configuration**

Create `examples/address-book/playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bun run db:migrate && bun run dev',
    url: 'http://127.0.0.1:3100/contacts',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'] } },
  ],
});
```

- [ ] **Step 2: Write the browser tests**

Create `examples/address-book/tests/address-book.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('search synchronizes q and filters rows', async ({ page }) => {
  await page.goto('/contacts');
  const search = page.getByPlaceholder('Search people');
  await search.fill('Sarah');
  await expect(page).toHaveURL(/\?q=Sarah$/);
  await expect(page.getByRole('link', { name: /Sarah Chen/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Maya Patel/ })).toBeHidden();
});

test('creates, edits, favorites, and deletes a contact', async ({ page }) => {
  await page.goto('/contacts/new');
  await page.getByLabel('First name').fill('Avery');
  await page.getByLabel('Last name').fill('Stone');
  await page.getByLabel('Role').fill('Editor');
  await page.getByRole('button', { name: 'Create contact' }).click();
  await expect(page).toHaveURL(/\/contacts\/\d+$/);
  await expect(page.getByRole('heading', { name: 'Avery Stone' })).toBeVisible();

  await page.getByRole('link', { name: 'Edit contact' }).click();
  await page.getByLabel('Role').fill('Editorial Director');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Editorial Director', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Add to favorites' }).click();
  await expect(page.getByRole('button', { name: 'Remove from favorites' })).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL('/contacts');
  await expect(page.getByRole('link', { name: /Avery Stone/ })).toHaveCount(0);
});

test('shows validation errors and portrait fallback', async ({ page }) => {
  await page.goto('/contacts/new');
  await page.getByLabel('Email').fill('broken');
  await page.getByRole('button', { name: 'Create contact' }).click();
  await expect(page.getByText('Enter a first or last name.')).toBeVisible();
  await expect(page.getByText('Enter a valid email address.')).toBeVisible();

  await page.goto('/contacts');
  await expect(page.locator('[data-avatar] .avatar__fallback').first()).toBeVisible();
});

test('reconciles insert, update, reorder, and delete across tabs', async ({ browser }) => {
  const context = await browser.newContext();
  const left = await context.newPage();
  const right = await context.newPage();
  await Promise.all([left.goto('/contacts'), right.goto('/contacts')]);

  await left.goto('/contacts/new');
  await left.getByLabel('First name').fill('Cross');
  await left.getByLabel('Last name').fill('Aaron');
  await left.getByRole('button', { name: 'Create contact' }).click();

  await expect(right.getByRole('link', { name: /Cross Aaron/ })).toBeVisible({
    timeout: 10_000,
  });

  await left.getByRole('link', { name: 'Edit contact' }).click();
  await left.getByLabel('Role').fill('Cross-tab Director');
  await left.getByRole('button', { name: 'Save changes' }).click();
  await expect(right.getByRole('link', { name: /Cross Aaron/ })).toContainText(
    'Cross-tab Director',
  );

  await left.getByRole('button', { name: 'Add to favorites' }).click();
  await expect(right.locator('[data-contact-row]').first()).toContainText('Cross Aaron');

  left.once('dialog', (dialog) => dialog.accept());
  await left.getByRole('button', { name: 'Delete' }).click();
  await expect(right.getByRole('link', { name: /Cross Aaron/ })).toHaveCount(0);

  await context.close();
});

test('mobile detail route hides the directory and exposes back navigation', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile');
  await page.goto('/contacts');
  await page.getByRole('link', { name: /Sarah Chen/ }).click();
  await expect(page.getByRole('link', { name: '‹ People' })).toBeVisible();
  await expect(page.locator('.directory')).toBeHidden();
});
```

- [ ] **Step 3: Install the browser binary**

Run:

```bash
bunx playwright install chromium
```

Expected: Chromium installs successfully.

- [ ] **Step 4: Run end-to-end tests**

Run:

```bash
bun --cwd examples/address-book run test:e2e
```

Expected: desktop and mobile projects PASS.

- [ ] **Step 5: Commit browser coverage**

```bash
git add examples/address-book/playwright.config.ts examples/address-book/tests/address-book.spec.ts
git commit -m "test(example): cover address book workflows"
```

---

### Task 13: Visual QA and Final Repository Verification

**Files:**
- Verify: `examples/address-book/styles/app.css`
- Verify: `examples/address-book/components/Avatar.tsx`
- Verify: `examples/address-book/components/Directory.tsx`
- Verify: `examples/address-book/components/AppShell.tsx`
- Verify: `examples/address-book/components/ContactForm.tsx`
- Verify: `examples/address-book/components/ContactDetail.tsx`
- Verify: `examples/address-book/client/address-book.js`
- Modify: `graphify-out/*` through `graphify update .` only

- [ ] **Step 1: Start the example**

Run:

```bash
bun --env-file=examples/address-book/.env --cwd examples/address-book run dev
```

Expected: `Address book running at http://localhost:3100`.

- [ ] **Step 2: Verify the approved desktop design in the Browser plugin**

Open `http://localhost:3100/contacts/1` and capture a desktop screenshot.

Check:

- 21rem dark rail and flexible light detail surface
- selected row blue edge and elevated background
- 112px circular portrait
- profile and contact cards centered within the detail pane
- visible focus states
- no horizontal overflow

- [ ] **Step 3: Verify mobile in the Browser plugin**

Use an iPhone-sized viewport and verify:

- `/contacts` shows only the directory
- `/contacts/1` hides the directory
- the `‹ People` link is visible
- contact methods and toolbar controls remain touch-friendly
- the form is one column without clipping

- [ ] **Step 4: Reopen and capture the approved concept**

The approved companion source is:

```text
/Users/jagjeet/Development/workspaces/Kiln/.superpowers/brainstorm/37045-1780795702/content/workspace-design.html
```

Start the visual companion against the main workspace:

```bash
/Users/jagjeet/.codex/plugins/cache/openai-curated/superpowers/e2d08a2e/skills/brainstorming/scripts/start-server.sh --project-dir /Users/jagjeet/Development/workspaces/Kiln
```

Read the `screen_dir` from the startup JSON. Copy the approved fragment into
that exact directory as `workspace-design-reference.html`, then open the
returned localhost URL. The companion frame supplies the styles used during
approval.

Capture the approved concept and save it as `/tmp/address-book-concept.png`.

- [ ] **Step 5: Compare concept and implementation screenshots**

Use `view_image` on:

- `/tmp/address-book-concept.png`
- the latest desktop implementation screenshot
- the latest mobile implementation screenshot

Compare palette, rail width, selected state, typography, portrait sizing,
spacing, control treatment, and responsive collapse. For each mismatch, edit
the owning CSS or component file, reload the browser, and recapture the
implementation. Repeat until no material mismatch remains.

- [ ] **Step 6: Run all focused checks**

Run:

```bash
bun test packages/routekit/src/boot.test.ts
bun test examples/address-book/db/validation.test.ts examples/address-book/tests/routes.test.ts
bun --env-file=examples/address-book/.env examples/address-book/db/contacts.integration.test.ts
bun --cwd examples/address-book run build
bun --cwd examples/address-book run test:e2e
```

Expected: every command exits 0.

- [ ] **Step 7: Run repository-wide checks**

Run:

```bash
bun run test:unit
bun run test:integration
bun run build
git diff --check
```

Expected: all tests and builds PASS; diff check produces no output.

- [ ] **Step 8: Update the knowledge graph**

Run:

```bash
graphify update .
```

Expected: Graphify completes and indexes the address-book files.

- [ ] **Step 9: Inspect final scope**

Run:

```bash
git status --short
git diff --stat HEAD
```

Expected: only address-book implementation, routekit negotiation, lockfile, and generated graph updates are present. Preserve unrelated `.codebase-memory/adr.md` and `.codex/config.toml` edits without staging them.

- [ ] **Step 10: Commit final visual and verification fixes**

```bash
git add examples/address-book packages/routekit/src/boot.ts packages/routekit/src/boot.test.ts package.json bun.lock
git commit -m "feat(example): complete Kiln address book"
```
