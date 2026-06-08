import type { Contact, ContactSummary } from "./types.js";

type SearchableContact = Pick<
  Contact,
  "firstName" | "lastName" | "company" | "role" | "email" | "handle"
>;

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
    .toLocaleLowerCase();
}

export function sortContacts<T extends ContactSummary>(contacts: T[]): T[] {
  return [...contacts].sort(
    (left, right) =>
      Number(right.favorite) - Number(left.favorite) ||
      left.lastName.localeCompare(right.lastName, undefined, {
        sensitivity: "base",
      }) ||
      left.firstName.localeCompare(right.firstName, undefined, {
        sensitivity: "base",
      }) ||
      Number(left.id) - Number(right.id),
  );
}

export function filterContacts<T extends SearchableContact>(
  contacts: T[],
  query: string,
): T[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return contacts;

  return contacts.filter((contact) =>
    getContactSearchText(contact).includes(normalized),
  );
}
