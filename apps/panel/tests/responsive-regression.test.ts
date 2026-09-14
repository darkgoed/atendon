import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const panel = path.resolve(process.cwd());
const read = (p: string) => fs.readFileSync(path.join(panel, p), "utf8");
const styleFiles = ["tokens.css", "base.css", "components.css", "shell.css", "domains/feedback.css", "domains/agenda.css", "domains/conversations.css", "domains/pipeline.css", "domains/auth.css", "domains/post-sales.css", "domains/agenda-calendar.css", "domains/leads.css"];
const readStyles = () => styleFiles.map((file) => read(`styles/${file}`)).join("\n");

describe("responsive UI regressions", () => {
  // Cobrança foi migrada para o design system: o resumo é um grid tokenizado em CSS
  // de domínio (não utilitários Tailwind progressivos inline). A intenção preservada
  // é a adaptação real em telas pequenas.
  it("keeps billing summary responsive without inline colour utilities", () => {
    const source = read("app/pos-venda/cobranca/page.tsx");
    const css = readStyles();
    expect(source).not.toMatch(/\b(bg|text|border)-(white|black|slate|gray|zinc|neutral)\b/);
    expect(css).toMatch(/@media[^{]*max-width[^{]*\{[\s\S]*post-sales/);
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
