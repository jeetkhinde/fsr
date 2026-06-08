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

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
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

describe("contact persistence", () => {
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
