/**
 * Auditoria visual do AtendON — light + dark, várias viewports.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright \
 *     node scripts/ds-audit.mjs http://127.0.0.1:3200 [rota,rota,...]
 *
 * Verifica, por tema e viewport:
 *   - contraste WCAG real (normalizando oklab/color-mix pelo próprio browser)
 *   - texto invisível
 *   - overflow horizontal do documento (checagem comportamental)
 *   - conteúdo clipado SEM ancestral scrollável (inalcançável)
 *   - popovers/dialogs fora da viewport
 *   - alvos de toque pequenos e texto minúsculo
 *   - cor hardcoded restante não é verificada aqui (é grep, ver ds-grep.mjs)
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
let chromium;
for (const p of [
  process.env.PLAYWRIGHT_PATH,
  "playwright",
  "/var/www/apps/atendon/node_modules/playwright",
  "/var/www/apps/atendon/apps/panel/node_modules/playwright"
].filter(Boolean)) {
  try { ({ chromium } = require(p)); break; } catch { /* tenta o próximo */ }
}
if (!chromium) { console.error("playwright não encontrado"); process.exit(2); }

const base = (process.argv[2] || "http://127.0.0.1:3200").replace(/\/$/, "");
const routes = (process.argv[3] || "/,/conversas,/leads,/pipeline,/agenda,/follow-ups,/uso,/configuracoes,/pos-venda,/root/workspaces,/login")
  .split(",").map((r) => r.trim()).filter(Boolean);
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "mobile", width: 390, height: 844 },
  { name: "mobile-xs", width: 320, height: 720 }
];

const PROBE = () => {
  const out = { lowContrast: [], invisible: [], unreachable: [], offViewport: [], tinyText: [], smallTargets: [] };
  const vw = window.innerWidth, vh = window.innerHeight;

  const toRGB = (str) => {
    const d = document.createElement("div");
    d.style.color = str;
    document.body.appendChild(d);
    const out = getComputedStyle(d).color;
    d.remove();
    return /^rgba?\(/.test(out) ? (out.match(/[\d.]+/g) || []).map(Number) : null;
  };
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const bgOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const rgb = toRGB(getComputedStyle(n).backgroundColor);
      if (rgb && (rgb[3] === undefined || rgb[3] > 0.1)) return rgb;
    }
    return [0, 0, 0];
  };
  const label = (el) => {
    const t = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 44);
    return `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/)[0] : ""}: ${t}`;
  };
  const inSrOnly = (el) => el.closest(".sr-only") !== null;

  // ---- contraste + texto invisível --------------------------------------
  for (const el of document.querySelectorAll("*")) {
    if (inSrOnly(el)) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) < 0.1) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!own) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const fg = toRGB(s.color), bg = bgOf(el);
    if (!fg) continue;
    const size = parseFloat(s.fontSize), weight = Number(s.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const cr = ratio(fg, bg);
    if (cr < 1.6) out.invisible.push({ t: label(el), ratio: +cr.toFixed(2), color: s.color });
    else if (cr < (large ? 3 : 4.5)) out.lowContrast.push({ t: label(el), ratio: +cr.toFixed(2), size, weight });
    if (size > 0 && size < 11) out.tinyText.push({ t: label(el), size });
  }

  // ---- conteúdo inalcançável -------------------------------------------
  const reachable = (el, axis) => {
    let cur = el;
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      const ovf = axis === "x" ? s.overflowX : s.overflowY;
      const ss = axis === "x" ? n.scrollWidth : n.scrollHeight;
      const cs = axis === "x" ? n.clientWidth : n.clientHeight;
      if (ovf === "auto" || ovf === "scroll") { if (ss > cs + 1) return true; cur = n; continue; }
      if (ovf === "hidden" || ovf === "clip") {
        const i = cur.getBoundingClientRect(), o = n.getBoundingClientRect();
        const escapes = axis === "x" ? i.right > o.right + 1 || i.left < o.left - 1
                                     : i.bottom > o.bottom + 1 || i.top < o.top - 1;
        if (escapes) return false;
        cur = n; continue;
      }
      cur = n;
    }
    return true;
  };
  for (const el of document.querySelectorAll("table, .table-wrap, .kanban, [class*=board], [class*=grid], [class*=column], td, th, .badge, .btn, input, select")) {
    if (inSrOnly(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (!reachable(el, "x")) out.unreachable.push({ t: label(el), w: Math.round(r.width) });
  }

  // ---- overlays fora da viewport ---------------------------------------
  for (const el of document.querySelectorAll("[role=dialog], [role=menu], [role=listbox], [role=tooltip], .popover, .menu, .tooltip, dialog[open]")) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.right > vw + 1 || r.left < -1 || r.bottom > vh + 1 || r.top < -1) {
      out.offViewport.push({ t: label(el), rect: [r.left, r.top, r.right, r.bottom].map(Math.round) });
    }
  }

  // ---- alvos de toque ---------------------------------------------------
  if (vw <= 700) {
    for (const el of document.querySelectorAll("button, a[href], input:not([type=hidden]), select, [role=button]")) {
      if (inSrOnly(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.height < 40 || r.width < 24) out.smallTargets.push({ t: label(el), w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  return out;
};

const run = async () => {
  const browser = await chromium.launch();
  const report = {};
  for (const theme of ["dark", "light"]) {
    for (const vp of viewports) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      await ctx.addInitScript((t) => {
        try { localStorage.setItem("atendon-theme", t); } catch {}
      }, theme);
      const page = await ctx.newPage();
      const errors = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
      for (const route of routes) {
        const key = `${theme}|${vp.name}|${route}`;
        try {
          // `networkidle` NUNCA resolve em rotas que fazem polling (/403 e
          // /offline revalidam /me em intervalo), e o timeout aparecia como
          // "erro da página" quando o defeito era do instrumento. Esperamos o
          // DOM e damos um tempo fixo para a hidratação pintar.
          await page.goto(base + route, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForLoadState("load").catch(() => undefined);
          await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
          await page.waitForTimeout(500);
          const res = await page.evaluate(PROBE);
          await page.evaluate(() => window.scrollTo(9999, 0));
          res.docScrollX = await page.evaluate(() => window.scrollX);
          res.consoleErrors = errors.splice(0);
          report[key] = res;
        } catch (e) {
          report[key] = { error: String(e).slice(0, 200) };
        }
      }
      await ctx.close();
    }
  }
  await browser.close();
  writeFileSync("ds-audit.json", JSON.stringify(report, null, 1));

  const tot = {};
  for (const [k, v] of Object.entries(report)) {
    if (v.error) { console.log(`ERRO  ${k}  ${v.error}`); continue; }
    const counts = {
      invisible: v.invisible.length, lowContrast: v.lowContrast.length,
      unreachable: v.unreachable.length, offViewport: v.offViewport.length,
      tinyText: v.tinyText.length, smallTargets: v.smallTargets.length,
      scrollX: v.docScrollX, consoleErrors: v.consoleErrors.length
    };
    for (const [n, c] of Object.entries(counts)) tot[n] = (tot[n] || 0) + (typeof c === "number" ? c : 0);
    const bad = Object.entries(counts).filter(([, c]) => c > 0);
    if (bad.length) console.log(`${k}  ${bad.map(([n, c]) => `${n}=${c}`).join(" ")}`);
  }
  console.log("\nTOTAL:", JSON.stringify(tot));
  console.log("detalhes em ds-audit.json");
};
run().catch((e) => { console.error(e); process.exit(1); });
