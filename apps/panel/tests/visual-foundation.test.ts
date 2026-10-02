/**
 * Fundação visual dos controles de texto, medida em Chromium real.
 *
 * CSS: as folhas de app/globals.css na ordem da cascata, mais o preflight do
 * Tailwind na camada base. Markup: os primitives reais de @/components/ui.
 * Nada aqui inventa estilo.
 *
 * Contrato (alturas de uma linha vêm dos tokens, não do padding):
 *   padrão 34 · .input--sm 34 · compact 30 / sm 28 · ≤700px 44.
 * Textarea: o piso multiline (2 × --control-height-lg) vale dentro de .field;
 * fora dele a geometria de baseline fica como está, porque o composer de
 * /conversas usa o primitive Textarea fora de .field.
 *
 * Variáveis de ambiente, só para gerar evidência:
 *   VF_CSS_FILE      mede um CSS compilado (ex.: baseline do build) no lugar das
 *                    fontes. As asserções são puladas; sobra a matriz de medidas.
 *   VF_EVIDENCE_OUT  caminho do JSON com a matriz viewport × densidade.
 *
 * Limite conhecido: utilitários Tailwind (resize-none, min-h-20...) não entram
 * no harness de fontes, só o preflight.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { readStyleSources } from "./style-sources";

const panelRoot = resolve(__dirname, "..");
const read = (file: string) => readFileSync(resolve(panelRoot, file), "utf8");
const CSS_FILE = process.env.VF_CSS_FILE;
const spec = it.skipIf(Boolean(CSS_FILE));

// ---------------------------------------------------------------- markup real
const render = (node: ReactElement) => renderToStaticMarkup(node);
const option = h("option", { value: "a" }, "Opção");
const field = (children: ReactElement, error?: string) => render(h(Field, { label: "Rótulo", error, children }));
const EXCLUDED = ["checkbox", "radio", "file", "range"] as const;
const NATIVE = [["date", "date"], ["dt", "datetime-local"]] as const;

const rows: string[] = [
  render(h(Input, { id: "in", defaultValue: "Texto" })),
  render(h(Input, { id: "in-sm", className: "input--sm", defaultValue: "Texto" })),
  render(h(Select, { id: "sel" }, option)),
  render(h(Select, { id: "sel-sm", className: "input--sm" }, option)),
  render(h(Textarea, { id: "ta2", rows: 2 })),
  render(h(Textarea, { id: "ta6", rows: 6 })),
  render(h(Textarea, { id: "ta2-sm", rows: 2, className: "input--sm" })),
  render(h(Button, { id: "btn" }, "Salvar")),
  render(h(Button, { id: "btn-sm", size: "sm" }, "Salvar")),
  render(h(Button, { id: "btn-lg", size: "lg" }, "Salvar")),
  field(h(Input, { id: "f-in" })),
  field(h(Input, { id: "f-in-sm", className: "input--sm" })),
  field(h(Select, { id: "f-sel" }, option)),
  field(h(Textarea, { id: "f-ta2", rows: 2 })),
  field(h(Textarea, { id: "f-ta6", rows: 6 })),
  field(h("textarea", { id: "f-ta-raw", rows: 2 })),
  field(h(Input, { id: "f-err" }), "Obrigatório"),
  render(h(Input, { id: "in-dis", disabled: true })),
  render(h(Input, { id: "in-sm-dis", className: "input--sm", disabled: true })),
  render(h(Input, { id: "in-inv", "aria-invalid": true })),
  render(h(Input, { id: "in-sm-inv", className: "input--sm", "aria-invalid": true })),
  `<div class="conversation-list__search">${render(h(Input, { id: "dom-search" }))}</div>`,
  // Mesmo markup do composer de /conversas: Textarea fora de .field, com a classe de domínio.
  `<div class="conversation-composer"><label class="conversation-composer__field">${render(h(Textarea, { id: "composer", className: "conversation-composer__textarea input max-h-32" }))}</label></div>`,
  render(h(Select, { id: "sel-multi", multiple: true }, option, option, option)),
  // O consumidor real passa h-10 (utilitário Tailwind, ausente do harness de fontes): emulado inline.
  render(h(Input, { id: "color", type: "color", style: { height: 40 } })),
  ...NATIVE.flatMap(([id, type]) => [
    render(h(Input, { id, type })),
    render(h(Input, { id: `${id}-sm`, type, className: "input--sm" })),
  ]),
  ...EXCLUDED.flatMap((type) => [
    render(h("input", { id: `${type}-plain`, type })),
    render(h(Input, { id: type, type })),
    render(h(Input, { id: `${type}-sm`, type, className: "input--sm" })),
  ]),
  render(h(Input, { id: "hidden-sm", type: "hidden", className: "input--sm" })),
];

// ------------------------------------------------------------------ CSS real
const stripImports = (css: string) => css.replace(/@import\s+url\([^)]*\)\s*;?/g, "");
function pageCss(): string {
  if (CSS_FILE) return stripImports(readFileSync(CSS_FILE, "utf8"));
  const preflightPath = resolve(panelRoot, "../../node_modules/tailwindcss/preflight.css");
  const preflight = existsSync(preflightPath) ? `@layer base {\n${readFileSync(preflightPath, "utf8")}\n}` : "";
  return stripImports(`${preflight}\n${readStyleSources()}`);
}

// ------------------------------------------------------------------ medição
type Box = { h: number; w: number; minH: string; padT: number; padB: number; padL: number; padR: number; bT: number; bB: number; line: number; resize: string; display: string };
type Density = "compact" | null;

let browser: Browser;
let page: Page;

async function measure(): Promise<Record<string, Box>> {
  return page.evaluate(() => {
    const out: Record<string, Box> = {};
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("input[id], select[id], textarea[id], button[id]"))) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      out[el.id] = {
        h: r.height, w: r.width, minH: cs.minHeight,
        padT: parseFloat(cs.paddingTop), padB: parseFloat(cs.paddingBottom), padL: parseFloat(cs.paddingLeft), padR: parseFloat(cs.paddingRight),
        bT: parseFloat(cs.borderTopWidth), bB: parseFloat(cs.borderBottomWidth),
        line: parseFloat(cs.lineHeight), resize: cs.resize, display: cs.display,
      };
    }
    return out;
  });
}

async function scenario(width: number, density: Density) {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate((d) => {
    if (d) document.documentElement.setAttribute("data-density", d);
    else document.documentElement.removeAttribute("data-density");
  }, density);
  return measure();
}

const probe = (css: string, prop: string) => page.evaluate(([style, p]) => {
  const el = document.createElement("i");
  el.style.cssText = style;
  document.body.append(el);
  const value = getComputedStyle(el).getPropertyValue(p);
  el.remove();
  return value;
}, [css, prop] as const);

const computed = (id: string, props: string[]) => page.evaluate(([target, names]) => {
  const cs = getComputedStyle(document.getElementById(target)!);
  return names.map((name) => cs.getPropertyValue(name));
}, [id, props] as const);

async function focusByKeyboard(id: string) {
  await page.focus(`#${id}`);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
}

const innerHeight = (b: Box) => b.h - b.padT - b.padB - b.bT - b.bB;
// select e botão têm line-height normal (NaN): só vale a checagem para controles com linha definida.
const fits = (b: Box) => !Number.isFinite(b.line) || innerHeight(b) >= b.line - 0.01;
const ONE_LINE = ["in", "sel", "f-in", "f-sel", "date", "dt"] as const;
const ONE_LINE_SM = ["in-sm", "sel-sm", "f-in-sm", "date-sm", "dt-sm"] as const;

describe("fundação visual — controles de texto (Chromium real)", () => {
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    const doc = `<!doctype html><html lang="pt-BR" data-theme="dark"><head><meta charset="utf-8"><style>${pageCss()}</style><style>*,*::before,*::after{transition:none!important}</style></head><body><main>${rows.map((row) => `<div>${row}</div>`).join("\n")}</main></body></html>`;
    await page.setContent(doc, { waitUntil: "load" });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  spec("padrão: campo de uma linha mede o token --control-height-md, igual ao Button", async () => {
    const m = await scenario(1440, null);
    for (const id of [...ONE_LINE, "dom-search"]) expect(m[id].h, id).toBeCloseTo(34, 1);
    expect([m.btn.h, m["btn-sm"].h, m["btn-lg"].h]).toEqual([34, 34, 38]);
    for (const id of ONE_LINE) expect(fits(m[id]), id).toBe(true);
  });

  spec(".input--sm vence o seletor-base sem !important: 34px em input, select e nativos de data", async () => {
    const m = await scenario(1440, null);
    for (const id of ONE_LINE_SM) expect(m[id].h, id).toBeCloseTo(34, 1);
    expect(m["in-sm"].minH).toBe("34px");
    expect(m["ta2-sm"].minH).toBe("34px");
    // textarea fora de .field continua ditado por rows, não pelo min-height da variante
    expect(m["ta2-sm"].h).toBeCloseTo(m.ta2.h, 1);
    for (const id of ONE_LINE_SM) expect(fits(m[id]), id).toBe(true);
  });

  spec("compact: uma linha segue os tokens (30px; sm 28px) sem cortar texto", async () => {
    const m = await scenario(1440, "compact");
    for (const id of ONE_LINE) expect(m[id].h, id).toBeCloseTo(30, 1);
    for (const id of ONE_LINE_SM) expect(m[id].h, id).toBeCloseTo(28, 1);
    expect([m.btn.h, m["btn-sm"].h, m["btn-lg"].h]).toEqual([30, 28, 32]);
    for (const id of [...ONE_LINE, ...ONE_LINE_SM]) expect(fits(m[id]), id).toBe(true);
  });

  spec("≤700px: alvo de toque de 44px governa padrão, sm e compact", async () => {
    for (const density of [null, "compact"] as const) {
      const m = await scenario(360, density);
      for (const id of [...ONE_LINE, ...ONE_LINE_SM]) expect(m[id].h, `${id} ${density}`).toBeCloseTo(44, 1);
    }
  });

  spec("checkbox, radio, file e range ignoram .input e .input--sm; hidden segue oculto", async () => {
    for (const density of [null, "compact"] as const) {
      const m = await scenario(1440, density);
      for (const type of EXCLUDED) {
        const plain = m[`${type}-plain`];
        for (const id of [type, `${type}-sm`]) {
          expect([m[id].w, m[id].h, m[id].minH], `${id} ${density}`).toEqual([plain.w, plain.h, plain.minH]);
        }
      }
      expect(m["hidden-sm"].display).toBe("none");
    }
  });

  spec("textarea multiline: rows e resize preservados; piso 2 × --control-height-lg só dentro de .field", async () => {
    for (const density of [null, "compact"] as const) {
      const m = await scenario(1440, density);
      const floor = density ? 64 : 76;
      expect(m.ta6.h - m.ta2.h, `rows ${density}`).toBeCloseTo(4 * m.ta2.line, 1);
      expect(m["f-ta6"].h - m["f-ta2"].h, `rows em Field ${density}`).toBeGreaterThan(0);
      for (const id of ["ta2", "ta6", "f-ta2", "f-ta6", "f-ta-raw"]) expect(m[id].resize, `${id} ${density}`).toBe("vertical");
      // O composer de /conversas é Textarea fora de .field: o resize vem do domínio e não é reativado.
      expect(m.composer.resize, `composer ${density}`).toBe("none");
      // Controles multiline (textarea, select[multiple]) e o seletor de cor nativo mantêm o padding vertical de 8px do baseline.
      for (const id of ["ta2", "ta6", "f-ta2", "sel-multi", "color"]) expect(m[id].padT, `${id} ${density}`).toBe(8);
      // Dentro de .field: Textarea (classe input) e <textarea> cru passam a ter o mesmo piso multiline.
      expect(m["f-ta2"].h, `f-ta2 ${density}`).toBeCloseTo(floor, 1);
      expect(m["f-ta6"].h, `f-ta6 ${density}`).toBeCloseTo(135, 1); // rows acima do piso seguem mandando
      expect(m["f-ta2"].h).toBeGreaterThanOrEqual(m["f-ta-raw"].h - 1);
      // Fora de .field a geometria de baseline fica: o composer de /conversas não cresce.
      expect(m.ta2.h, `ta2 ${density}`).toBeCloseTo(57, 1);
      expect(m.composer.h, `composer ${density}`).toBeCloseTo(57, 1);
    }
  });

  spec("foco-visível mantém o anel nas variantes; sm herda o estado disabled/invalid do padrão", async () => {
    for (const density of [null, "compact"] as const) {
      await scenario(1440, density);
      const ring = await probe("box-shadow: var(--focus-ring)", "box-shadow");
      expect(ring).not.toBe("none");
      for (const id of ["in", "in-sm", "sel-sm", "ta2-sm"]) {
        await focusByKeyboard(id);
        expect((await computed(id, ["box-shadow"]))[0], `${id} ${density}`).toBe(ring);
      }
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const state = ["background-color", "color", "border-top-color"];
      expect(await computed("in-sm-dis", state), `disabled ${density}`).toEqual(await computed("in-dis", state));
      expect(await computed("in-sm-inv", state), `invalid ${density}`).toEqual(await computed("in-inv", state));
    }
  });

  it("grava a matriz de medidas (viewport × densidade)", async () => {
    const matrix: Record<string, Record<string, Box>> = {};
    for (const width of [1440, 768, 360]) {
      for (const density of [null, "compact"] as const) matrix[`${width}/${density ?? "default"}`] = await scenario(width, density);
    }
    if (process.env.VF_EVIDENCE_OUT) writeFileSync(process.env.VF_EVIDENCE_OUT, JSON.stringify({ css: CSS_FILE ?? "sources", matrix }, null, 1));
    expect(Object.keys(matrix)).toHaveLength(6);
  }, 30_000);
});

describe("fundação visual — contrato das fontes (tokens, cascade, docs)", () => {
  const tokens = read("styles/tokens.css");
  const css = read("styles/components.css");

  spec("tokens: ganchos de campo e largura de formulário têm fonte única", () => {
    expect(tokens).toMatch(/--input-min-height:\s*var\(--control-height-md\)/);
    expect(tokens).toMatch(/--input-pad-y:\s*var\(--space-1\)/);
    expect(tokens).toMatch(/--input-pad-x:\s*var\(--space-3\)/);
    // o compact troca só --control-height-*; os ganchos não ganham cópia por densidade
    for (const name of ["--input-min-height", "--input-pad-y", "--input-pad-x"]) expect(tokens.match(new RegExp(`${name}:`, "g")), name).toHaveLength(1);
    expect(tokens.match(/--content-form-max:/g)).toHaveLength(1);
    expect(tokens).toMatch(/--content-form-max:\s*48rem/);
    // larguras já existentes são reutilizadas, não redefinidas
    expect(tokens).toMatch(/--content-max:\s*1160px/);
    expect(tokens).toMatch(/--prose-max:\s*68ch/);
  });

  spec("components: seletor-base consome os ganchos; variantes só trocam ganchos, sem !important", () => {
    const base = css.match(/^\.select,\n\.textarea \{([\s\S]*?)\n\}/m)?.[1] ?? "";
    expect(base).toContain("min-height: var(--input-min-height)");
    expect(base).toContain("padding: var(--input-pad-y) var(--input-pad-x)");
    const hooksOnly = [...css.matchAll(/^[^{}\n]*(?:\.input--sm|textarea\.input|select\[multiple\]\.input)[^{}\n]*\{([^}]*)\}/gm)];
    expect(hooksOnly.length).toBeGreaterThanOrEqual(3);
    for (const match of hooksOnly) {
      for (const decl of match[1].split(";").map((d) => d.trim()).filter((d) => d && !d.startsWith("/*"))) expect(decl).toMatch(/^--input-/);
    }
    expect(css).not.toMatch(/\.input--sm:not\(/);
    const forms = css.slice(css.indexOf("4. FORMULÁRIOS"), css.indexOf(".search-field {"));
    expect(forms.length).toBeGreaterThan(500);
    expect(forms).not.toContain("!important");
  });

  spec("docs: autoridade visual atual (tokens, ganchos, largura, fontes, ícones)", () => {
    const ds = read("docs/design-system.md");
    for (const needle of ["--content-form-max", "--input-min-height", "--input-pad-y", "input--sm", "Geist", "components/icons"]) {
      expect(ds, needle).toContain(needle);
    }
    expect(ds).not.toContain("@phosphor-icons/react");
    const design = read("docs/design-system/DESIGN.md");
    const front = design.split("---")[1] ?? "";
    const upperTokens = tokens.toUpperCase();
    for (const hex of front.match(/#[0-9A-Fa-f]{6}\b/g) ?? []) expect(upperTokens, `${hex} fora de tokens.css`).toContain(hex.toUpperCase());
    expect(front).toContain(`contentMax: ${tokens.match(/--content-max:\s*([^;]+);/)?.[1]}`);
    expect(front).toContain(`contentFormMax: ${tokens.match(/--content-form-max:\s*([^;]+);/)?.[1]}`);
    expect(design).toContain("Geist");
  });
});
