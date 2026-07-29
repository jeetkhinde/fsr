import { describe, expect, it } from "bun:test";
import { load as loadDetail } from "../pages/contacts/[id]/index.js";
import { load as loadContacts } from "../pages/contacts/_layout.js";
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
  locals: {},
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
  });
});

describe("contacts layout must never be pattern-cached (ADR-011 / Phase 4.4)", () => {
  // This layout's load() reads req.query.q, a DESCENDANT's req.params.id, and
  // req.path — all per-request. Its own pattern is "/contacts", which has no
  // params, so layoutInstanceToken() yields no key suffix for it: if it were
  // ever cached it would be cached ONCE and shared across /contacts,
  // /contacts?q=…, and every /contacts/:id.
  //
  // It is safe today only because reading req.query trips the purity tracker,
  // which demotes it. That is load-bearing and easy to lose accidentally (a
  // refactor moving the search box would remove the query read and silently
  // make the layout cacheable), so assert the property directly.
  it("touches an identity field, so the classifier demotes it", () => {
    const IDENTITY_FIELDS = ["locals", "headers", "query", "raw", "formData", "json"];
    const touched: string[] = [];
    const proxied = new Proxy(
      { ...request({ q: "sarah" }), path: "/contacts/7", params: { id: "7" } },
      {
        get(target, prop, receiver) {
          if (IDENTITY_FIELDS.includes(String(prop))) touched.push(String(prop));
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      },
    );
    loadContacts(proxied as any);
    expect(touched).toContain("query");
  });

  it("varies its output by request, which is why sharing one bake would be wrong", () => {
    const listing = loadContacts({ ...request(), path: "/contacts", params: {} } as any);
    const detail = loadContacts({
      ...request({ q: "sarah" }),
      path: "/contacts/7",
      params: { id: "7" },
    } as any);

    expect(listing.selectedId).toBeUndefined();
    expect(detail.selectedId).toBe("7");
    expect(listing.focusDetail).toBe(false);
    expect(detail.focusDetail).toBe(true);
    expect(listing.query).toBe("");
    expect(detail.query).toBe("sarah");
  });
});
