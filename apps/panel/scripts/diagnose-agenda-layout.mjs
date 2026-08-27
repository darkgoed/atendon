#!/usr/bin/env node
/**
 * Diagnóstico pontual: mede a geometria real do cabeçalho, da toolbar e da
 * grade da agenda em várias larguras. Serve para descobrir a causa do corte e
 * da sobreposição antes de mexer no CSS, e para confirmar depois.
 */
import { chromium } from "playwright";

const BASE = process.env.PANEL_E2E_BASE_URL ?? "http://127.0.0.1:3299";
const EMAIL = process.env.PANEL_E2E_EMAIL ?? "admin@atendon.local";
const PASSWORD = process.env.PANEL_E2E_PASSWORD ?? "atendon-test-only-password";
const widths = process.argv[2] ? process.argv[2].split(",").map(Number) : [320, 360, 414, 768, 1024];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "pt-BR", colorScheme: "dark" });

await page.goto(`${BASE}/login`);
await page.getByLabel("E-mail").fill(EMAIL);
await page.getByLabel("Senha", { exact: true }).fill(PASSWORD);
await Promise.all([
  page.waitForURL((url) => url.pathname !== "/login", { timeout: 30000, waitUntil: "commit" }),
  page.getByRole("button", { name: "Entrar" }).click()
]);
const version = await page.evaluate(async () => {
  const r = await fetch("/backend/panel/version", { credentials: "include" });
  return r.ok ? (await r.json()).version : null;
});
await page.addInitScript((v) => { try { localStorage.setItem("atendon_last_seen_version", v); } catch {} }, version);

for (const width of widths) {
  await page.setViewportSize({ width, height: 780 });
  await page.goto(`${BASE}/agenda`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  const report = await page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {
        sel,
        x: Math.round(r.x), y: Math.round(r.y),
        w: Math.round(r.width), h: Math.round(r.height),
        right: Math.round(r.right), bottom: Math.round(r.bottom),
        scrollW: el.scrollWidth, clientW: el.clientWidth,
        scrollH: el.scrollHeight, clientH: el.clientHeight,
        overflowX: s.overflowX, overflowY: s.overflowY,
        flex: s.flex, position: s.position, zIndex: s.zIndex
      };
    };
    const targets = [
      ".content", ".agenda-head", ".agenda-head__identity", ".agenda-head__actions",
      ".agenda-head__toggle", ".agenda-toolbar", ".agenda-legend",
      ".agenda-scroll", ".agenda-grid", ".agenda-month", ".agenda-block-list"
    ];
    const boxes = targets.map(box).filter(Boolean);

    // Sobreposição entre o h1 e os botões de modo.
    const h1 = document.querySelector(".agenda-head h1");
    const overlaps = [];
    if (h1) {
      const a = h1.getBoundingClientRect();
      for (const btn of document.querySelectorAll(".agenda-head__actions button")) {
        const b = btn.getBoundingClientRect();
        if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) {
          overlaps.push({ button: btn.textContent.trim().slice(0, 24), h1Right: Math.round(a.right), btnLeft: Math.round(b.left) });
        }
      }
    }
    return {
      viewport: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight },
      docScrollW: document.documentElement.scrollWidth,
      boxes, h1OverlapsButtons: overlaps
    };
  });

  console.log(`\n########## ${width}px ##########`);
  console.log(`doc scrollWidth=${report.docScrollW} clientWidth=${report.viewport.w}`);
  for (const b of report.boxes) {
    const cut = b.right > report.viewport.w + 1 ? `  <<< passa da viewport em ${b.right - report.viewport.w}px` : "";
    const scrollable = ["auto", "scroll"].includes(b.overflowX);
    const overflowing = b.scrollW > b.clientW + 1 ? ` [conteúdo ${b.scrollW} > caixa ${b.clientW}${scrollable ? ", rolável" : ", NÃO ROLÁVEL"}]` : "";
    console.log(`  ${b.sel.padEnd(26)} x=${String(b.x).padStart(5)} w=${String(b.w).padStart(5)} h=${String(b.h).padStart(4)} ovf-x=${b.overflowX.padEnd(8)} ovf-y=${b.overflowY.padEnd(8)}${overflowing}${cut}`);
  }
  if (report.h1OverlapsButtons.length) {
    console.log(`  !! h1 "Agenda" SOBREPÕE: ${report.h1OverlapsButtons.map((o) => `${o.button} (h1 termina em ${o.h1Right}, botão começa em ${o.btnLeft})`).join(" | ")}`);
  }
}

await browser.close();
