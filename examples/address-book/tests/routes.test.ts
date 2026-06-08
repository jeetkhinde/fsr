import { describe, expect, it } from "bun:test";
import { load as loadDetail } from "../pages/contacts/[id]/index.js";
import { load as loadContacts } from "../pages/contacts/index.js";
import { actions as newContactActions } from "../pages/contacts/new.js";
import { load as loadRoot } from "../pages/index.js";

const request = (query: Record<string, string> = {}) => ({
  path: "/contacts",
  method: "GET",
  params: {},
  query,
  headers: new Headers(),
  formData: async () => new FormData(),
  json: async () => ({}),
  isEnhanced: false,
  layoutsPresent: [],
  prebakeNext: () => {},
});

describe("address book routes", () => {
  it("redirects the root route to contacts", () => {
    expect(() => loadRoot()).toThrow("/contacts");
  });

  it("keeps q as page state while the live query remains complete", async () => {
    const result = await loadContacts(request({ q: "Sarah" }) as any);
    expect(result.query).toBe("Sarah");
    expect(Array.isArray(result.contacts)).toBe(true);
    expect(result.contacts).toHaveLength(0);
  });

  it("returns field errors for an invalid create action", async () => {
    const form = new FormData();
    form.set("email", "broken");
    const result = await newContactActions.create({
      ...request(),
      method: "POST",
      isEnhanced: true,
      formData: async () => form,
    } as any);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.name).toBe("Enter a first or last name.");
      expect(result.errors.email).toBe("Enter a valid email address.");
    }
  });

  it("returns a missing contact state for an unknown id", async () => {
    const result = await loadDetail({
      ...request(),
      path: "/contacts/999999999",
      params: { id: "999999999" },
    } as any);
    expect(result.contact).toBeNull();
    expect(result.selectedId).toBe("999999999");
  });
});
