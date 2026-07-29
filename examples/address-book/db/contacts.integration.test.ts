import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import {
  createContact,
  deleteContact,
  getContact,
  listContacts,
  toggleFavorite,
  updateContact,
} from "./contacts.js";

// Needs a database carrying THIS example's schema (contacts, contact_events
// from migrations/0000_init.sql) — not the test-app database the rest of
// test:integration points at. Skip cleanly rather than crash when either the
// URL or the schema is absent, so the suite stays runnable for everyone; set
// DATABASE_URL to a migrated address-book DB to actually exercise it.
const databaseUrl = process.env.DATABASE_URL;
const db = databaseUrl ? new SQL(databaseUrl) : null;

async function schemaPresent(): Promise<boolean> {
  if (!db) return false;
  try {
    // BOTH tables — a database can carry `contacts` from another fixture
    // while lacking `contact_events`, which is exactly what the test-app
    // database does.
    const rows = await db`
      SELECT to_regclass('public.contacts') IS NOT NULL
         AND to_regclass('public.contact_events') IS NOT NULL AS ok`;
    return Boolean(rows[0]?.ok);
  } catch {
    return false;
  }
}

const runnable = await schemaPresent();
if (!runnable) {
  console.warn(
    "[test] skipping contacts integration: " +
      (databaseUrl
        ? "DATABASE_URL points at a database without the address-book schema (run examples/address-book/migrations/0000_init.sql)"
        : "DATABASE_URL is not set"),
  );
}

beforeEach(async () => {
  if (!runnable) return;
  await db!`DELETE FROM contact_events`;
  await db!`DELETE FROM contacts`;
});

afterAll(async () => {
  if (!runnable) return;
  await db!`DELETE FROM contact_events`;
  await db!`DELETE FROM contacts`;
  await db!.close();
});

const input = {
  firstName: "Sarah",
  lastName: "Chen",
  company: "Linear",
  role: "Product Designer",
  email: "sarah@linear.app",
  phone: "",
  location: "San Francisco",
  handle: "@sarahchen",
  website: "https://sarahchen.com",
  avatarUrl: "",
  notes: "",
};

describe.skipIf(!runnable)("contact persistence", () => {
  it("creates, updates, favorites, and deletes with matching events", async () => {
    const created = await createContact(db, input);
    expect((await listContacts(db)).map((contact) => contact.id)).toEqual([
      created.id,
    ]);

    const updated = await updateContact(db, created.id, {
      ...input,
      role: "Design Lead",
    });
    expect(updated?.role).toBe("Design Lead");

    const favorited = await toggleFavorite(db, created.id, true);
    expect(favorited?.favorite).toBe(true);

    expect(await deleteContact(db, created.id)).toBe(true);
    expect(await getContact(db, created.id)).toBeNull();

    const events = await db<{ kind: string }[]>`
      SELECT kind FROM contact_events ORDER BY id
    `;
    expect(events.map((event) => event.kind)).toEqual([
      "create",
      "update",
      "favorite",
      "delete",
    ]);
  });

  it("rolls back the contact mutation when event insertion fails", async () => {
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
      await expect(createContact(db, input)).rejects.toThrow("event failure");
      expect(await listContacts(db)).toEqual([]);
    } finally {
      await db.unsafe(`
        DROP TRIGGER IF EXISTS address_book_fail_event_trigger ON contact_events;
        DROP FUNCTION IF EXISTS address_book_fail_event();
      `);
    }
  });
});
