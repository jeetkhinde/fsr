import { describe, expect, it } from "bun:test";
import {
  filterContacts,
  getContactInitials,
  getContactSearchText,
  sortContacts,
} from "./presentation.js";
import { validateContactForm } from "./validation.js";
import type { Contact } from "./types.js";

const contact = (overrides: Partial<Contact> = {}): Contact => ({
  id: "1",
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
  favorite: false,
  createdAt: "2026-06-07T00:00:00.000Z",
  updatedAt: "2026-06-07T00:00:00.000Z",
  ...overrides,
});

describe("contact validation", () => {
  it("requires at least one name and normalizes optional fields", () => {
    const form = new FormData();
    form.set("firstName", "   ");
    form.set("lastName", "");
    form.set("company", "  Linear  ");

    const result = validateContactForm(form);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected validation to fail.");
    expect(result.errors.name).toBe("Enter a first or last name.");
    expect(result.values.company).toBe("Linear");
  });

  it("rejects malformed email and non-http URLs", () => {
    const form = new FormData();
    form.set("firstName", "Sarah");
    form.set("email", "not-an-email");
    form.set("website", "ftp://example.com");
    form.set("avatarUrl", "javascript:alert(1)");

    const result = validateContactForm(form);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected validation to fail.");
    expect(result.errors.email).toBe("Enter a valid email address.");
    expect(result.errors.website).toBe("Use an http or https URL.");
    expect(result.errors.avatarUrl).toBe("Use an http or https URL.");
  });
});

describe("contact presentation", () => {
  it("derives stable initials and searchable text", () => {
    expect(getContactInitials(contact())).toBe("SC");
    expect(getContactSearchText(contact())).toContain("product designer");
    expect(getContactSearchText(contact())).toContain("@sarahchen");
  });

  it("filters case-insensitively and sorts favorites first", () => {
    const contacts = [
      contact({
        id: "2",
        firstName: "Maya",
        lastName: "Patel",
        company: "Figma",
        email: "maya@figma.com",
      }),
      contact({ id: "1", favorite: true }),
    ];

    expect(filterContacts(contacts, "LINEAR").map((item) => item.id)).toEqual([
      "1",
    ]);
    expect(sortContacts(contacts).map((item) => item.id)).toEqual(["1", "2"]);
  });
});
