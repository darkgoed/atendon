import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("raiz visual de Configurações", () => {
  it("tokens.css declara os tokens novos", () => {
    const css = read("styles/tokens.css");
    expect(css).toMatch(/--weight-title:\s*var\(--weight-semibold\)/);
    expect(css).toMatch(/--weight-metric:\s*var\(--weight-semibold\)/);
    expect(css).toMatch(/--settings-content-max:\s*72rem/);
  });

  it("base.css: h1-h6 usam --weight-title", () => {
    expect(read("styles/base.css")).toMatch(/h1, h2, h3, h4, h5, h6 \{[^}]*font-weight:\s*var\(--weight-title\)/);
  });

  it("shell-rail.css escopa o hub e define a faixa horizontal", () => {
    const css = read("styles/domains/shell-rail.css");
    expect(css).toMatch(/\.settings-layout \{[^}]*--weight-title:\s*var\(--weight-medium\)/);
    expect(css).toMatch(/\.settings-layout \{[^}]*--weight-metric:\s*var\(--weight-medium\)/);
    expect(css).toMatch(/\.settings-main \{[^}]*max-width:\s*var\(--settings-content-max\)/);
    expect(css).toMatch(/@media \(max-width: 1199px\) \{[^@]*overflow-x:\s*auto/);
    expect(css).toContain("@media (min-width: 1200px)");
  });

  it("module define .panelTitle e esconde o placeholder no mobile", () => {
    const css = read("components/settings-panels.module.css");
    expect(css).toMatch(/\.panelTitle \{[^}]*font-weight:\s*var\(--weight-title\)/);
    expect(css).toMatch(/@media \(max-width: 48rem\) \{[^@]*\.editorPlaceholder \{ display: none; \}/);
  });
});
