import type { ContactFieldErrors, ContactFormValues } from "./types.js";

const fields = [
  "firstName",
  "lastName",
  "company",
  "role",
  "email",
  "phone",
  "location",
  "handle",
  "website",
  "avatarUrl",
  "notes",
] as const;

function read(form: FormData, name: (typeof fields)[number]): string {
  return String(form.get(name) ?? "").trim();
}

function isHttpUrl(value: string): boolean {
  if (!value) return true;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
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
    errors.name = "Enter a first or last name.";
  }
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    errors.email = "Enter a valid email address.";
  }
  if (!isHttpUrl(values.website)) {
    errors.website = "Use an http or https URL.";
  }
  if (!isHttpUrl(values.avatarUrl)) {
    errors.avatarUrl = "Use an http or https URL.";
  }
  if (values.notes.length > 2000) {
    errors.notes = "Keep notes under 2,000 characters.";
  }

  return Object.keys(errors).length > 0
    ? { ok: false, values, errors }
    : { ok: true, values };
}
