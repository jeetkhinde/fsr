import type { SQL } from "bun";
import type { Contact, ContactInput, ContactSummary } from "./types.js";

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
  const rows = (await db.unsafe(`
    SELECT ${columns}
    FROM contacts
    ORDER BY
      favorite DESC,
      lower(last_name),
      lower(first_name),
      id
  `)) as ContactRow[];
  return rows.map(mapContact);
}

export async function listContactSummaries(
  db: SQL,
): Promise<ContactSummary[]> {
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
  const rows = (await db.unsafe(
    `SELECT ${columns} FROM contacts WHERE id = $1`,
    [id],
  )) as ContactRow[];
  return rows[0] ? mapContact(rows[0]) : null;
}

export async function createContact(
  db: SQL,
  input: ContactInput,
): Promise<Contact> {
  return db.begin(async (tx) => {
    const rows = (await tx.unsafe(
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
    )) as ContactRow[];
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
    const rows = (await tx.unsafe(
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
    )) as ContactRow[];
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
    const rows = (await tx.unsafe(
      `UPDATE contacts
       SET favorite = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING ${columns}`,
      [id, favorite],
    )) as ContactRow[];
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
