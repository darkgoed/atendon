#!/usr/bin/env node
/** D2-r3 diagnostic probe: computed color + matched CSS rules for the audited
 * sidebar span (a[title]>span) at light/768 — same interception contract as
 * scripts/design-audit.mjs, fixture-only, no production API calls. */
import { chromium } from "playwright";
import { session } from "./design-audit/fixtures/session.mjs";
import { conversationFixture } from "./design-audit/fixtures/conversations.mjs";
import { commercialFixture } from "./design-audit/fixtures/commercial.mjs";
import { settingsFixture } from "./design-audit/fixtures/settings.mjs";
import { rootFixture } from "./design-audit/fixtures/root.mjs";
import { panelsV6Fixture } from "./design-audit/fixtures/panels-v6.mjs";
import { CAPABILITY_CATALOG, ENTITLEMENTS, FEATURE_FLAG_KEYS } from "./design-audit/catalog.mjs";

const baseURL = "http://127.0.0.1:3499";
const requested = "/";
const routePath = (url) => new URL(url).pathname.replace(/^\/(?:api|backend)/, "");
const json = (intercept, body, status = 200) => intercept.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function payload(path, method) {
  if (method === "OPTIONS") return { status: 204 };
  if (method !== "GET" && method !== "HEAD") return null;
  if (path === "/me") return { body: session };
  if (path === "/feature-flags") return { body: { flags: Object.fromEntries(FEATURE_FLAG_KEYS.map((key) => [key, false])), featureFlags: CAPABILITY_CATALOG } };
  if (path === "/panel/version") return { body: { version: "d2-final", changelog: [] } };
  if (path === "/panel/versions") return { body: { releases: [] } };
  if (path === "/events") return { status: 204 };
  if (path === "/capabilities") return { body: { capabilities: CAPABILITY_CATALOG } };
  if (path === "/billing/my-plan") return { body: ENTITLEMENTS };
  for (const fixture of [panelsV6Fixture, conversationFixture, commercialFixture, settingsFixture, rootFixture]) { const value = fixture(path); if (value !== undefined) return { body: value }; }
  return null;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 768, height: 1024 }, locale: "pt-BR" });
const page = await context.newPage();
const gaps = [];
await page.addInitScript((value) => {
  localStorage.setItem("atendon_last_seen_version", value.version);
  localStorage.setItem("atendon-theme", value.theme);
  const applyTheme = () => { document.documentElement.dataset.theme = value.theme; };
  if (document.documentElement) applyTheme(); else document.addEventListener("DOMContentLoaded", applyTheme, { once: true });
}, { version: "probe", theme: "light" });
await context.route("**/*", async (intercept) => {
  const req = intercept.request(), url = new URL(req.url()), method = req.method();
  const isApi = url.pathname.startsWith("/api/") || url.pathname.startsWith("/backend/");
  if (isApi) {
    const path = routePath(req.url()), answer = payload(path, method);
    if (!answer) { gaps.push(`${method} ${path}`); return intercept.fulfill({ status: 599, contentType: "application/json", body: JSON.stringify({ error: "fixture-gap" }) }); }
    return answer.status === 204 ? intercept.fulfill({ status: 204, body: "" }) : json(intercept, answer.body, answer.status ?? 200);
  }
  return intercept.continue();
});
await page.goto(new URL(requested, baseURL).toString(), { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForFunction(() => !document.querySelector("[aria-busy=true], .loading-state, [data-loading=true]"), { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(1500);

const probe = await page.evaluate(() => {
  const out = { supportsColorMix: CSS.supports("color", "color-mix(in srgb, red 50%, blue)") };
  const rootStyle = getComputedStyle(document.documentElement);
  out.tokens = {
    "--primary-text": rootStyle.getPropertyValue("--primary-text").trim(),
    "--surface-active": rootStyle.getPropertyValue("--surface-active").trim(),
    "--primary-subtle": rootStyle.getPropertyValue("--primary-subtle").trim(),
    "--surface": rootStyle.getPropertyValue("--surface").trim(),
    "--bg": rootStyle.getPropertyValue("--bg").trim(),
  };
  const describe = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { color: cs.color, backgroundColor: cs.backgroundColor, className: String(el.className), tag: el.tagName };
  };
  const title = document.querySelector('a[title="Visão geral"]');
  out.aTitle = describe(title);
  out.aTitleSpan = describe(title?.querySelector(":scope > span"));
  out.navActive = describe(document.querySelector(".nav a.active"));
  out.navActiveSpan = describe(document.querySelector(".nav a.active > span"));
  out.navCount = document.querySelectorAll(".nav a").length;
  out.sidebarVisible = (() => { const s = document.querySelector(".sidebar"); if (!s) return null; const cs = getComputedStyle(s); return { display: cs.display, bg: cs.backgroundColor }; })();
  return out;
});
console.log("PROBE:", JSON.stringify(probe, null, 2));
console.log("GAPS:", JSON.stringify([...new Set(gaps)].slice(0, 12)));

// CDP: which rules set `color` on the span and its anchor?
const cdp = await context.newCDPSession(page);
const { root: doc } = await cdp.send("DOM.getDocument");
const grab = async (selector) => {
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: doc.nodeId, selector });
  if (!nodeId) return null;
  const { matchedCSSRules, inlineStyle } = await cdp.send("CSS.getMatchedStylesForNode", { nodeId });
  const rules = [];
  for (const m of matchedCSSRules ?? []) {
    const rule = m.rule;
    const sel = (rule.selectorList?.selectors ?? []).map((s) => s.text).join(", ");
    const props = (rule.style?.cssProperties ?? []).filter((p) => !p.parsedOk === false).map((p) => `${p.name}: ${p.value}`);
    if (props.some((p) => p.startsWith("color"))) rules.push({ sel, origin: rule.origin, ruleUrl: (rule.styleSheetId ?? ""), props: props.filter((p) => p.startsWith("color") || p.includes("background")) });
  }
  return { inline: inlineStyle?.cssProperties?.map((p) => `${p.name}: ${p.value}`) ?? [], rules };
};
console.log("SPAN MATCHED:", JSON.stringify(await grab('.nav a.active > span'), null, 2));
console.log("A MATCHED:", JSON.stringify(await grab('.nav a.active'), null, 2));
await page.screenshot({ path: "/tmp/d2r3-probe-light-768.png", fullPage: false });
await browser.close();
