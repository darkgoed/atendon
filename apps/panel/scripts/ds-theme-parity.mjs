/**
 * Paridade geométrica light/dark — AtendON.
 *
 * O brief exige: "Mantenha exatamente layout, spacing, hierarquia, componentes,
 * dimensions, interaction patterns. Apenas semantic tokens devem mudar."
 *
 * Este script prova isso: renderiza a MESMA rota nos dois temas e compara,
 * elemento por elemento (mesma ordem de árvore), a geometria e as propriedades
 * NÃO-cromáticas. Qualquer divergência é um defeito: significa que um tema
 * recebeu tratamento diferente do outro.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright \
 *     node scripts/ds-theme-parity.mjs http://127.0.0.1:3477 [rotas]
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
let chromium;
for (const p of [
  process.env.PLAYWRIGHT_PATH, "playwright",
  "/var/www/apps/atendon/node_modules/playwright",
  "/var/www/apps/atendon/apps/panel/node_modules/playwright"
].filter(Boolean)) {
  try { ({ chromium } = require(p)); break; } catch { /* próximo */ }
}
if (!chromium) { console.error("playwright não encontrado"); process.exit(2); }

const base = (process.argv[2] || "http://127.0.0.1:3477").replace(/\/$/, "");
const routes = (process.argv[3] || "/login,/403,/offline").split(",").map((s) => s.trim()).filter(Boolean);
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 }
];

/* Propriedades que DEVEM ser idênticas entre temas (nada de cor aqui). */
const SNAPSHOT = () => {
  const props = [
    "display", "position", "flexDirection", "justifyContent", "alignItems",
    "gridTemplateColumns", "gridTemplateRows", "gap",
    "marginTop", "marginRight", "marginBottom", "marginLeft",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius",
    "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textTransform",
    "textAlign", "whiteSpace", "overflowX", "overflowY", "zIndex", "opacity",
    "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight",
    "visibility", "textOverflow", "flexGrow", "flexShrink", "flexBasis"
  ];
  const out = [];
  const walk = (el, path) => {
    const s = getComputedStyle(el);
    if (s.display === "none") return;                 // igual nos dois, nada a medir
    const r = el.getBoundingClientRect();
    const snap = { p: path, tag: el.tagName.toLowerCase(), cls: (typeof el.className === "string" ? el.className : "").trim().slice(0, 60) };
    snap.rect = [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10);
    for (const k of props) snap[k] = s[k];
    out.push(snap);
    let i = 0;
    for (const c of el.children) walk(c, `${path}>${i++}`);
  };
  walk(document.body, "body");
  return out;
};

const run = async () => {
  const browser = await chromium.launch();
  const report = {};
  let totalDiff = 0, totalNodes = 0;

  for (const vp of viewports) {
    for (const route of routes) {
      const snaps = {};
      for (const theme of ["dark", "light"]) {
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        await ctx.addInitScript((t) => { try { localStorage.setItem("atendon-theme", t); } catch {} }, theme);
        const page = await ctx.newPage();
        try {
          await page.goto(base + route, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
          await page.waitForTimeout(900);
          snaps[theme] = await page.evaluate(SNAPSHOT);
        } catch (e) {
          snaps[theme] = { error: String(e).slice(0, 160) };
        }
        await ctx.close();
      }
      const key = `${vp.name}|${route}`;
      const [d, l] = [snaps.dark, snaps.light];
      if (!Array.isArray(d) || !Array.isArray(l)) { report[key] = { error: d.error || l.error }; continue; }
      if (d.length !== l.length) {
        report[key] = { structuralMismatch: { dark: d.length, light: l.length } };
        totalDiff += Math.abs(d.length - l.length);
        continue;
      }
      const diffs = [];
      for (let i = 0; i < d.length; i++) {
        const a = d[i], b = l[i];
        const bad = [];
        if (JSON.stringify(a.rect) !== JSON.stringify(b.rect)) bad.push({ prop: "rect", dark: a.rect, light: b.rect });
        for (const k of Object.keys(a)) {
          if (["p", "tag", "cls", "rect"].includes(k)) continue;
          if (a[k] !== b[k]) bad.push({ prop: k, dark: a[k], light: b[k] });
        }
        if (bad.length) diffs.push({ node: `${a.tag}.${a.cls}`, path: a.p, diffs: bad });
      }
      totalNodes += d.length;
      totalDiff += diffs.length;
      report[key] = { nodes: d.length, divergentNodes: diffs.length, detail: diffs.slice(0, 40) };
      console.log(`${key}  nodes=${d.length}  divergentes=${diffs.length}`);
    }
  }
  await browser.close();
  writeFileSync("ds-theme-parity.json", JSON.stringify(report, null, 1));
  console.log(`\nTOTAL: ${totalDiff} nós divergentes em ${totalNodes} comparados`);
  console.log(totalDiff === 0
    ? "PASS — light e dark são geometricamente idênticos (só tokens de cor mudam)"
    : "FAIL — ver ds-theme-parity.json");
};
run().catch((e) => { console.error(e); process.exit(1); });
