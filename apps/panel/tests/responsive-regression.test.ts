import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readStyleSources } from "./style-sources";

const panel = path.resolve(process.cwd());
const read = (p: string) => fs.readFileSync(path.join(panel, p), "utf8");
const readStyles = () => readStyleSources();

describe("responsive UI regressions", () => {
  it("keeps progressive billing grids", () => {
    const source = read("app/pos-venda/cobranca/page.tsx");
    expect(source).toContain("sm:grid-cols-2 md:grid-cols-4");
    expect(source).toContain("sm:grid-cols-2 md:grid-cols-3");
  });
  it("contains post-sales summary overflow in a wrapper", () => {
    const css = readStyles();
    const component = read("components/post-sales-summary.tsx");
    expect(css).toContain(".post-sales-summary-wrap");
    expect(css).toMatch(/\.post-sales-summary-wrap\{[^}]*overflow-x:auto/);
    expect(component).toContain("post-sales-summary-wrap");
  });
  it("does not force the agenda assignee select wider than its dialog", () => {
    const source = read("app/agenda/agenda-detail-dialog.tsx");
    expect(source).toContain('className="input min-w-0 flex-1"');
    expect(source).not.toContain('className="input min-w-56 flex-1"');
  });
  it("configures browsers Playwright outside the Hermes environment", () => {
    const script = read("scripts/ui-responsive-audit.mjs");
    expect(script).toContain('process.env.PLAYWRIGHT_BROWSERS_PATH = "/home/deploy/.cache/ms-playwright"');
    expect(script).toContain("document.documentElement.scrollWidth>document.documentElement.clientWidth+1");
  });
  it("audits nested routes and records inaccessible routes", () => {
    const script = read("scripts/ui-responsive-audit.mjs");
    expect(script).toContain("function discover(dir, segments = [])");
    expect(script).toContain("report.inaccessibleRoutes.push");
  });
});
