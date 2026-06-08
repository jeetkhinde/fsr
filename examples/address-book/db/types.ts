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
  | "id"
  | "firstName"
  | "lastName"
  | "company"
  | "role"
  | "email"
  | "handle"
  | "avatarUrl"
  | "favorite"
>;

export type ContactInput = Omit<
  Contact,
  "id" | "favorite" | "createdAt" | "updatedAt"
>;

export type ContactFieldErrors = Partial<
  Record<keyof ContactInput | "name", string>
>;

export type ContactFormValues = ContactInput;

export type ContactActionResult =
  | { ok: true; redirect?: string; contact?: Contact }
  | {
      ok: false;
      message: string;
      errors: ContactFieldErrors;
      values: ContactFormValues;
    };
