import type { Contact, ContactSummary } from "./types.js";

type SearchableContact = Pick<
  Contact,
  "firstName" | "lastName" | "company" | "role" | "email" | "handle"
>;

const contactNameCollator = new Intl.Collator("en", {
  sensitivity: "base",
});

function compareContactIds(left: string, right: string): number {
  const leftId = BigInt(left);
  const rightId = BigInt(right);

  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

export function getContactName(
  contact: Pick<Contact, "firstName" | "lastName">,
): string {
  return (
    [contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
    "Unnamed contact"
  );
}

export function getContactInitials(
  contact: Pick<Contact, "firstName" | "lastName">,
): string {
  const initials = [contact.firstName, contact.lastName]
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase())
    .join("");

  return initials || "??";
}

export function getContactSearchText(contact: SearchableContact): string {
  return [
    contact.firstName,
    contact.lastName,
    contact.company,
    contact.role,
    contact.email,
    contact.handle,
  ]
    .join(" ")
    .toLowerCase();
}

export function sortContacts<T extends ContactSummary>(contacts: T[]): T[] {
  return [...contacts].sort(
    (left, right) =>
      Number(right.favorite) - Number(left.favorite) ||
      contactNameCollator.compare(left.lastName, right.lastName) ||
      contactNameCollator.compare(left.firstName, right.firstName) ||
      compareContactIds(left.id, right.id),
  );
}

export function filterContacts<T extends SearchableContact>(
  contacts: T[],
  query: string,
): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return contacts;

  return contacts.filter((contact) =>
    getContactSearchText(contact).includes(normalized),
  );
}
