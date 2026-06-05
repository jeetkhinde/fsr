import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const runtime = readFileSync(join(here, "silcrow.js"), "utf8");

describe("@kiln/client live patch runtime", () => {
  it("handles shared scalar and list patch envelopes", () => {
    expect(runtime).toContain("data.kind === 'scalar'");
    expect(runtime).toContain("data.op === 'insert'");
    expect(runtime).toContain("data.op === 'replace-row'");
    expect(runtime).toContain("data-kiln-field");
    expect(runtime).toContain("data-kiln-list");
    expect(runtime).toContain("data-kiln-key");
    expect(runtime).toContain("el.querySelectorAll('[data-kiln-list]')");
    expect(runtime).toContain("data-kiln-live-lists");
    expect(runtime).toContain("location.reload()");
  });
});
