# Actions & forms

Mutations are **collocated POST handlers** on the page file. Source: `packages/routekit/src/boot.ts` (`buildActionHandler`, `registerAction`), client hooks in `packages/react/src/hooks.ts`.

## Server: `actions`

```tsx
// pages/contacts.tsx
import { AppError } from '@kiln/core';

export const actions = {
  async create(req) {
    const form = await req.formData();
    await db.contacts.insert({ name: form.get('name') });
    return AppError.redirect('/contacts'); // → 303
  },
  async delete(req) {
    await db.contacts.delete(req.query.id);
    return AppError.redirect('/contacts');
  },
};
```

- Each named action is registered against the page's route; the action name is selected via the request query (the handler dispatches on `req.query`).
- Return `AppError.redirect(path)` for a post-redirect-get (303).
- Return a plain object to send data back to the client hook (see below).
- CSRF protection is **on by default** for POST/PUT/PATCH/DELETE with a form content-type (origin/referer check) — no action needed for same-origin forms.

## Client: progressive-enhancement forms

Plain HTML forms work with zero JS. To enhance a form and read its result reactively, use the hooks from `@kiln/react`.

### `useSilcrowForm` — simplest form binding

```tsx
// pages/index.tsx
import { useSilcrowForm } from '@kiln/react';

export default function IndexPage() {
  const form = useSilcrowForm('submit'); // action name
  return (
    <form action={form.action}>
      <input type="text" name="name" placeholder="Enter your name" />
      <button type="submit">Submit</button>
      {form.message && <p>{form.message}</p>}
    </form>
  );
}

export const actions = {
  async submit(req) {
    const body = await req.formData();
    return { ok: true, message: `Hello, ${body.get('name') || 'stranger'}!` };
  },
};
```

The action's returned object populates the form state (`ok`, `message`, `errors?`).

### `useSilcrowAction` / `useKilnNamedAction` — React 19 action state

For finer control (optimistic updates, custom method/scope), use `useSilcrowAction(url, initialState, options)` or the named variant `useKilnNamedAction(name, initialState, options)`, which resolve to a `[state, dispatch, pending]` tuple via React 19's `useActionState`.

> Inside an **island**, actions still work, but navigation must stay with plain `<a>` links / silcrow — no client router. See [live-and-islands.md](live-and-islands.md).
