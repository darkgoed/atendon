// The audit harness is intentionally ESM JavaScript; runtime tests are the contract.
// Runtime ESM modules are covered by a local declaration in scripts/design-audit/fixtures.d.ts.
import { describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { CAPABILITY_CATALOG, CAPABILITY_KEYS, PERMISSION_KEYS, sessionFor } from "../scripts/design-audit/catalog.mjs";
import { ROUTE_CONTRACTS } from "../scripts/design-audit/contracts.mjs";
import { fontFixture, mergeRecords, validateRecord } from "../scripts/design-audit/validate.mjs";
import { classifyControlReachability, geometrySelfTestVectors } from "../scripts/design-audit/geometry.mjs";
// @ts-expect-error The audit entrypoint is runtime-only ESM.
import { measure } from "../scripts/design-audit.mjs";

describe("corrected browser audit contracts", () => {
  it("serves only integrity-checked font cache entries and fails closed", () => {
    const directory = mkdtempSync(join(tmpdir(), "audit-font-test-"));
    const url = "https://fonts.googleapis.com/css2?family=Geist";
    const body = Buffer.from("@font-face { font-family: Geist; }");
    const manifest = join(directory, "manifest.json");
    try {
      writeFileSync(join(directory, "font.css"), body);
      writeFileSync(manifest, JSON.stringify({ [url]: { path: "font.css", contentType: "text/css", sha256: createHash("sha256").update(body).digest("hex") } }));
      expect(fontFixture(url, manifest)?.body).toEqual(body);
      expect(fontFixture("https://production.example/api", manifest)).toBeNull();
      expect(() => fontFixture("https://fonts.gstatic.com/missing.woff2", manifest)).toThrow("font cache missing");
      writeFileSync(join(directory, "font.css"), "corrupted");
      expect(() => fontFixture(url, manifest)).toThrow("integrity mismatch");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("validates the current semantic theme backgrounds without hiding errors", () => {
    const contract = ROUTE_CONTRACTS["/login"];
    const record = { route: "/login", requested: "/login", finalUrl: "/login", theme: { requested: "dark", dataset: "dark", background: "rgb(14, 15, 17)" }, heading: { matched: true }, entity: { matched: true }, loading: false, gaps: [], consoleErrors: [] as string[], pageErrors: [], axe: { violations: [] }, metrics: { horizontalOverflow: false, clippedButtons: false }, httpStatus: 200, assets: { js: ["x"], css: ["y"] } };
    expect(validateRecord(record, contract).valid).toBe(true);
    expect(validateRecord({ ...record, theme: { requested: "light", dataset: "light", background: "#f4f5f7" } }, contract).valid).toBe(true);
    expect(validateRecord({ ...record, theme: { ...record.theme, background: "#123456" } }, contract).errors).toContain("missing computed theme background");
    expect(validateRecord({ ...record, theme: { ...record.theme, background: "#f4f5f7" } }, contract).errors).toContain("missing computed theme background");
    expect(validateRecord({ ...record, consoleErrors: ["Failed to load resource: net::ERR_INTERNET_DISCONNECTED"] }, contract).errors).toContain("console/page errors");
  });
  it("matches only the seeded trash count and its own help suffix", () => {
    const pattern = new RegExp(`^(?:${ROUTE_CONTRACTS["/contatos/lixeira"].heading})$`, "i");
    for (const text of ["Lixeira 1", "Lixeira 1?", "Lixeira 1 Ajuda: Lixeira"]) expect(pattern.test(text), text).toBe(true);
    for (const text of ["Lixeira", "Lixeira 2", "Lixeira 1+", "Lixeira 10", "Lixeira 1 Ajuda: Contatos"]) expect(pattern.test(text), text).toBe(false);
  });
  it("uses only catalogued permissions and capabilities", () => {
    const session = sessionFor(false);
    expect(session.permissions).toEqual(PERMISSION_KEYS);
    expect(session.permissions).not.toContain("*");
    expect(CAPABILITY_KEYS).not.toContain("all");
    expect(CAPABILITY_CATALOG.every((capability) => capability.enabled && capability.supported)).toBe(true);
  });
  it("rejects wrong landing path, theme, empty entity, loading, errors and axe", () => {
    const contract = ROUTE_CONTRACTS["/agenda"];
    const record = { route: "/agenda", requested: "/agenda", finalUrl: "/403", theme: { requested: "dark", dataset: "light", background: "rgb(0, 0, 0)" }, heading: { matched: true }, entity: { matched: false }, loading: true, gaps: [], consoleErrors: ["boom"], pageErrors: [], axe: { violations: [{ id: "color-contrast" }] }, errorText: null };
    const result = validateRecord(record, contract);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining(["theme dataset mismatch", "missing seeded entity marker", "loading state", "console/page errors", "axe violations"]));
    expect(result.errors.some((error) => error.includes("landed URL"))).toBe(true);
  });
  it("rejects duplicate route/theme/viewport keys while merging", () => {
    const record = { route: "/", theme: { requested: "dark" }, viewport: "360x800" };
    expect(() => mergeRecords([{ routes: [record] }, { routes: [record] }])).toThrow(/duplicate audit record key/);
  });
  it("rejects instrumentation failures instead of treating them as passes", () => {
    const contract = ROUTE_CONTRACTS["/login"];
    const record = { route: "/login", requested: "/login", finalUrl: "/login", theme: { requested: "dark", dataset: "dark", background: "#101719" }, heading: { matched: true }, entity: { matched: true }, loading: false, gaps: [], consoleErrors: [], pageErrors: [], axe: { error: "runner failed", violations: [] }, metrics: { horizontalOverflow: true, clippedButtons: true }, httpStatus: 403, assets: { js: ["x"], css: ["y"] } };
    const result = validateRecord(record, contract);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining(["axe error", "horizontal overflow", "clipped buttons", "HTTP status 403"]));
  });
  it("classifies fixed controls by containing block and hit testing", () => {
    for (const vector of geometrySelfTestVectors) {
      expect(classifyControlReachability(vector.control, vector.viewport, vector.ancestors, vector.hitTests, vector.proof, vector.root).reason).toBe(vector.expected);
    }
  });
  it("proves nested, partial, and smooth root reachability in a real browser", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
    await page.setContent(`
      <style>
        :root { scroll-behavior: smooth; }
        * { box-sizing: border-box; }
        body { margin: 0; overflow-x: hidden; }
        .agenda-scroll { width: 360px; overflow-x: auto; }
        .track { width: 904px; padding-left: 500px; }
        .cell { position: relative; width: 120px; height: 60px; overflow: hidden; }
        .cell button { width: 100px; height: 40px; }
        #hidden { position: absolute; left: 150px; top: 0; }
        .tabs { width: 360px; overflow-x: auto; }
        .tabs-track { width: 904px; padding-left: 300px; white-space: nowrap; }
        .tabs button { width: 100px; height: 40px; }
        .root-spacer { height: 1200px; }
      </style>
      <h1>Fixture</h1>
      <div class="agenda-scroll"><div class="track"><div class="cell"><button id="nested">Nested cell action</button><button id="hidden">Hidden cell action</button></div></div></div>
      <div class="tabs"><div class="tabs-track"><button id="partial">Partially visible tab</button><button>Other tab</button><button>Third tab</button><button>Fourth tab</button></div></div>
      <div class="root-spacer"></div><button id="root-below-fold">Root below fold</button>
    `);
    try {
      const result = await measure(page, "dark", { heading: "Fixture", state: "empty" });
      const byId = (id: string) => result.controls.find((control: { selector: string }) => control.selector === `#${id}`);
      const nested = byId("nested"), hidden = byId("hidden"), partial = byId("partial"), root = byId("root-below-fold");
      expect(nested?.proof).toEqual(expect.objectContaining({ verified: true, kind: "nested", clippedByNonScroller: false }));
      expect(hidden?.proof).toEqual(expect.objectContaining({ verified: false, clippedByNonScroller: true, reason: "overflow-unreachable" }));
      expect(partial?.proof).toEqual(expect.objectContaining({ verified: true, kind: "nested" }));
      expect(root?.proof).toEqual(expect.objectContaining({ verified: true, kind: "document", clippedByNonScroller: false }));
      expect(nested?.proof?.finalRect?.left).toBeGreaterThanOrEqual(0);
      expect(root?.proof?.finalRect?.top).toBeLessThan(800);
      expect(root?.proof?.hitTests?.some(Boolean)).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
