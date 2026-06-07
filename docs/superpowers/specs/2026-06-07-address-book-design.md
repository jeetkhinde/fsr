# Kiln Address Book Example Design

**Date:** 2026-06-07
**Status:** Approved for implementation planning

## Goal

Build a standalone, production-quality address book example at
`examples/address-book`. The app borrows the workflow of the React Router
address-book tutorial but uses Kiln's route, action, navigation, PostgreSQL,
and live-revalidation patterns.

The example must not replace or modify `test-app`.

## Product Scope

The app supports:

- Browsing a searchable contact directory
- Viewing a contact by stable URL
- Creating, editing, favoriting, and deleting contacts
- Inline validation and visible pending states
- Responsive desktop and mobile navigation
- Cross-tab contact insertion, update, reorder, and deletion through
  `Live.list`
- Remote portrait URLs with deterministic initials as the fallback

Authentication, contact groups, importing, exporting, file uploads, and
multi-user ownership are out of scope.

## Visual Direction

The approved direction is a modern workspace:

- Dark, compact directory rail
- Light neutral detail surface
- Blue primary accent
- Strong selected-row treatment
- Circular portraits
- Crisp product controls with restrained borders and shadows
- Dense enough for efficient scanning without becoming table-like

### Design Tokens

- Rail background: `#18232d`
- Rail elevated surface: `#202d38`
- Detail background: `#f5f7f9`
- Main text: `#17212b`
- Muted text: `#77828d`
- Border: `#dfe5ea`
- Accent: `#4f7cff`
- Destructive text: muted red near `#b44b4b`
- Favorite: warm amber near `#f4bd4c`
- Control radius: `8px` to `10px`
- Panel radius: `12px`
- Typeface: Inter-style system sans stack

### Desktop Layout

The desktop shell uses a fixed-width contact rail and a flexible detail pane.
The rail contains the product title, create button, search control, favorites,
the remaining contacts, and a live-status footer.

Contact routes use enhanced full-page HTML navigation. The shell is
re-rendered identically, so the rail remains visually stable even though its
DOM node is replaced. The selected contact has a blue left edge and an
elevated dark surface.

The detail pane includes:

- Edit and delete controls
- Portrait, name, favorite control, role, company, and location
- Website and social links
- Email and phone fields
- Notes

The `/contacts` route renders an intentional empty detail state rather than
selecting a contact automatically.

### Mobile Layout

At the mobile breakpoint, the directory and detail views become focused
screens:

- `/contacts` shows the searchable directory.
- `/contacts/new` shows the create form.
- `/contacts/:id` shows a contact with a clear back link to `/contacts`.
- `/contacts/:id/edit` shows the edit form.

The detail screen keeps compact edit, favorite, and delete controls in the top
bar. Contact methods become touch-friendly actions. No horizontal split pane
is retained on narrow screens.

## Package Structure

The app is an independent workspace package:

```text
examples/address-book/
  api/
  components/
  db/
  migrations/
  pages/
    _layout.tsx
    index.tsx
    contacts/
      index.tsx
      new.tsx
      [id]/
        index.tsx
        edit.tsx
  src/
    main.ts
  styles/
    app.css
  kiln.config.ts
  package.json
  tsconfig.json
```

Shared contact queries, mutation helpers, validation, sorting, and model types
belong under `db/` or a focused feature module. Reusable visual components
belong under `components/`. Page modules remain route composition units rather
than accumulating database and presentation logic.

## Routes

| Route | Responsibility |
| --- | --- |
| `/` | Redirect to `/contacts` |
| `/contacts` | Directory and empty detail state |
| `/contacts/new` | Directory and create form |
| `/contacts/:id` | Directory and contact details |
| `/contacts/:id/edit` | Directory and edit form |

Each contacts page owns the same contact `Live.list` loader. This duplication
is intentional: Kiln currently materializes and registers live lists from page
loaders, not layout loaders.

The shared layout owns the HTML document, metadata, stylesheet, Silcrow
runtime, and outer application frame. It does not own the live contact query.

## Required Kiln Runtime Adjustment

The implementation includes one narrow framework fix for HTML navigation.

Silcrow already sends `Accept: text/html` when a navigation trigger has the
`s-html` attribute. Kiln's current page negotiation still forces enhanced
requests to JSON whenever all layouts are already present. The page handler
must instead treat an explicit HTML accept header as authoritative:

1. `Accept: text/html` returns HTML.
2. `Accept: application/json` returns JSON.
3. Enhanced layout-aware navigation may use the JSON shortcut only when HTML
   was not explicitly requested.

The fix is covered by focused routekit tests. It does not introduce targeted
fragment history or preserve the directory DOM node.

## Data Model

### `contacts`

```sql
CREATE TABLE contacts (
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
```

Names are stored separately so sorting and initials remain deterministic.
Blank optional fields use empty strings to keep rendered and live-patch data
stable.

### `contact_events`

```sql
CREATE TABLE contact_events (
  id BIGSERIAL PRIMARY KEY,
  contact_id BIGINT,
  kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Inserting an event triggers `pg_notify` with the dependency key
`contact_events`. `contact_id` intentionally has no foreign key so a deletion
event can retain the removed contact ID.

## Live List

All contacts routes return:

```ts
contacts: Live.list({
  key: (contact) => contact.id,
  dependsOn: "contact_events",
  query: queryAllContacts,
})
```

The query returns the complete contact set, ordered by:

1. Favorites first
2. Case-insensitive last name
3. Case-insensitive first name
4. Stable ID tie-breaker

The rendered directory uses a semantic `ul` with one direct `li` per contact
so Kiln can apply keyed list markers and patch rows reliably.

Search never changes the server-side `Live.list` query. Filtering happens in
the browser against the complete live list, and the search term is mirrored to
`?q=`. This prevents tabs with different search terms from competing over one
route's watcher registration.

## Mutations And Invalidation

Create, update, favorite, and delete are named Kiln actions colocated with the
route that renders the relevant UI.

Every mutation uses a PostgreSQL transaction:

1. Validate and normalize input.
2. Mutate `contacts`.
3. Insert a `contact_events` row with the mutation kind.
4. Commit.

The event insertion notifies Kiln. The embedded watcher re-runs the contact
list query and emits keyed list patches to subscribed tabs.

Mutation outcomes:

- Create redirects to `/contacts/:id`.
- Edit redirects to `/contacts/:id`.
- Delete redirects to `/contacts`.
- Favorite returns success immediately and reconciles through `Live.list`.

Favorite toggling uses an optimistic client update. The server result and live
list remain authoritative.

## Search And Navigation

The search control filters by:

- First name
- Last name
- Company
- Role
- Email
- Handle

Matching is case-insensitive and trims surrounding whitespace.

The browser updates `?q=` with history replacement rather than adding one
history entry per keystroke. The initial query parameter seeds the search
control on page load.

Desktop contact links use `s-html` enhanced navigation with normal URL history.
The response replaces the page body with full HTML, and the shared shell keeps
the rail visually stable across routes. Direct route requests and server
rendering remain valid without enhanced navigation. Mobile uses the same route
navigation and provides an explicit back link.

## Forms And Validation

Create and edit forms share one contact form component and one validation
contract.

Validation rules:

- First name or last name must contain a non-whitespace value.
- Email is optional but must be structurally valid when present.
- Website is optional but must use `http` or `https` when present.
- Avatar URL is optional but must use `http` or `https` when present.
- Phone, company, role, location, handle, and notes are normalized strings.
- Notes have a conservative maximum length.

Server validation is authoritative. Field errors render beside their controls.
A page-level error is used for database or unexpected failures.

Pending submissions:

- Disable duplicate-submit controls.
- Change the primary button label.
- Preserve entered values.
- Keep destructive and navigation actions available only when safe.

Delete requires explicit confirmation before submission.

## Portraits

The app accepts remote portrait URLs. The portrait component:

- Uses the contact's name for accessible alt text.
- Uses a consistent crop with `object-fit: cover`.
- Falls back to deterministic initials when no URL is present.
- Falls back to initials when the image fails.
- Derives the fallback color from the stable contact ID or normalized name.

No image proxy, upload pipeline, or generated portrait bundle is included.

## Empty, Missing, And Error States

- Empty directory: explains that no contacts exist and offers the create
  action.
- Empty search: shows no matches without hiding the create action.
- Empty detail pane: prompts the user to select or create a contact.
- Missing contact: renders a dedicated not-found state with a link back to the
  directory.
- Action validation failure: keeps the form and renders field errors.
- Action infrastructure failure: renders a page-level message and preserves
  recoverable input.
- Failed portrait: silently switches to initials.

## Accessibility

- Use semantic landmarks, headings, lists, forms, labels, and buttons.
- Keep a visible focus indicator on both light and dark surfaces.
- Ensure selected contact state is not color-only.
- Preserve keyboard access for search, create, contact links, favorite, edit,
  and delete.
- Use `aria-current` for the selected contact.
- Announce search result counts and action feedback through polite live
  regions.
- Honor `prefers-reduced-motion`.

## Testing

### Unit Tests

- Input validation and normalization
- Initials and fallback color derivation
- Contact sorting
- Search filtering
- URL query normalization

### Database Tests

- Contact creation
- Contact update
- Favorite toggle
- Contact deletion
- Atomic `contact_events` insertion for every mutation
- Rollback when event insertion fails

### Route And Action Tests

- Root redirect
- Contacts list loader
- Detail loader
- Missing-contact behavior
- Create and edit validation errors
- Successful redirects
- Delete behavior

### Browser Tests

- Search filtering and `?q=` synchronization
- Create, edit, favorite, and delete flow
- Pending and validation states
- Delete confirmation
- Enhanced `s-html` route navigation and URL history
- Mobile directory/detail navigation
- Portrait fallback
- Cross-tab insert, update, reorder, and delete patches

### Repository Verification

- Example type check and build
- Focused example tests
- Existing repository unit tests
- Existing integration tests
- `graphify update .`

## Visual Verification

The implementation must be compared against the approved modern-workspace
mockup at desktop and mobile sizes.

Review at minimum:

- Rail/detail proportions
- Selected row treatment
- Typography hierarchy
- Palette and control styling
- Portrait sizing and crop
- Form density and validation placement
- Desktop full-page route transition
- Visually stable desktop shell across enhanced full-page swaps
- Mobile focused-screen transition
- Empty and pending states

## Acceptance Criteria

The feature is complete when:

1. `examples/address-book` runs independently without changing `test-app`.
2. All five routes render directly and through enhanced `s-html` navigation.
3. PostgreSQL-backed CRUD and favorite actions work with validation.
4. Search is shareable through `?q=` and does not alter live query
   registration.
5. Two open tabs reconcile contact inserts, updates, moves, and deletions.
6. Desktop and mobile behavior match the approved modern-workspace design.
7. The focused test suites, build, existing repo tests, browser flow, and
   Graphify update pass.
