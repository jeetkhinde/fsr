import { describe, expect, it } from "bun:test";
import { load as loadContacts } from "../pages/contacts/index.js";
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
});
