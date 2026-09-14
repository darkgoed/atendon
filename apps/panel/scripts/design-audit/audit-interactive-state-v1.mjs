#!/usr/bin/env node
/**
 * Small, strict interactive-state audit. Cases are derived from production
 * labels and contracts; a missing fixture or state assertion fails the case.
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { session, rootSession } from "./fixtures/session.mjs";
import { conversationFixture } from "./fixtures/conversations.mjs";
import { commercialFixture } from "./fixtures/commercial.mjs";
import { settingsFixture } from "./fixtures/settings.mjs";
import { rootFixture } from "./fixtures/root.mjs";
import { publicTripzFixture } from "./fixtures/public-tripz.mjs";
import { CAPABILITY_CATALOG, FEATURE_FLAG_KEYS, OPERATOR_PERMISSIONS, PERMISSION_KEYS } from "./catalog.mjs";
import { contractFor } from "./contracts.mjs";

const baseURL = process.env.BASE_URL ?? process.env.PANEL_E2E_BASE_URL ?? "http://127.0.0.1:3499";
const output = resolve(process.env.OUTPUT ?? "/home/deploy/.cache/atendon-frontend-audit");
const viewports = [{ name: "mobile", width: 360, height: 800 }, { name: "desktop", width: 1440, height: 900 }];
const FIXTURE_VERSION = process.env.AUDIT_BUILD_MARKER ?? "interactive-state-v1";
const FIXTURE_NOW = "2026-08-20T12:00:00.000Z";
const operatorPermissions = [...OPERATOR_PERMISSIONS];
if (operatorPermissions.some((key) => !PERMISSION_KEYS.includes(key))) throw new Error("OPERATOR_PERMISSIONS is not a subset of source permissions");
const scenarios = [
  { name: "owner", session },
  { name: "operator", session: { ...session, user: { ...session.user, name: "QA Operador" }, activeWorkspace: { ...session.activeWorkspace, role: "OPERADOR" }, permissions: operatorPermissions } },
  { name: "root", session: rootSession }
];

const cases = [
  { id: "mobile-menu", route: "/", scenarios: ["owner", "operator"], viewports: ["mobile"], run: async (page) => {
    const open = page.getByRole("button", { name: "Abrir menu", exact: true }); await one(open, "open menu"); await open.dispatchEvent("click");
    const close = page.locator("button.mobile-nav-toggle[aria-label='Fechar menu']"); await one(close, "close menu");
    await expectAttr(page.locator(".shell"), "data-mobile-nav", "open", "menu open state"); await close.dispatchEvent("click");
    await one(page.getByRole("button", { name: "Abrir menu", exact: true }), "menu closed");
    await expectAttr(page.locator(".shell"), "data-mobile-nav", "closed", "menu closed state");
  }},
  { id: "config-tabs", route: "/configuracoes", scenarios: ["owner", "operator"], viewports: ["desktop"], run: async (page) => {
    for (const label of ["Categorias", "Parceiros", "Unidades"]) {
      const tab = page.getByRole("button", { name: label, exact: true }); await one(tab, `config ${label}`); await tab.click();
      await expectAttr(tab, "aria-pressed", "true", `config ${label} selected`);
      await one(page.getByRole("region", { name: label, exact: true }), `config ${label} region`);
    }
  }},
  { id: "conversation-drawer", route: "/conversas", scenarios: ["owner", "operator"], viewports: ["desktop"], run: async (page) => {
    const conversation = page.getByText("Marina QA", { exact: true }).first(); await one(conversation, "seeded conversation"); await conversation.click();
    const trigger = page.getByRole("button", { name: "Abrir dados do contato", exact: true }); await one(trigger, "contact drawer trigger"); await trigger.click();
    const drawer = page.getByRole("complementary", { name: "Dados do contato", exact: true }); await one(drawer, "contact drawer complementary");
    await page.keyboard.press("Escape"); await expectHidden(drawer, "contact drawer close");
  }},
  { id: "pipeline-preferences", route: "/leads/pipeline", scenarios: ["owner"], viewports: ["desktop"], run: async (page) => {
    const button = page.getByRole("button", { name: "Exibição", exact: true }); await one(button, "pipeline preferences trigger"); await button.click();
    await one(page.getByText("Exibição do quadro", { exact: true }), "pipeline preferences panel");
    const compact = page.getByRole("button", { name: "Compacta", exact: true }); await one(compact, "pipeline compact density"); await compact.click();
    await expectAttr(compact, "aria-pressed", "true", "pipeline compact selected");
  }},
  { id: "member-dialog", route: "/workspace/members", scenarios: ["owner"], viewports: ["desktop"], run: async (page) => {
    const edit = page.getByRole("row").filter({ hasText: "Ana QA" }).getByRole("button", { name: "Perfil", exact: true }); await one(edit, "member edit"); await edit.click();
    const dialog = page.getByRole("dialog", { name: "Editar perfil", exact: true }); await one(dialog, "member dialog open"); await page.keyboard.press("Escape"); await expectHidden(dialog, "member dialog close");
  }},
  { id: "post-sales-create", route: "/pos-venda", scenarios: ["owner"], viewports: ["desktop"], run: async (page) => {
    const create = page.getByRole("button", { name: "Novo cliente", exact: true }); await one(create, "post-sales create"); await create.click();
    const dialog = page.getByRole("dialog", { name: "Adicionar à carteira", exact: true }); await one(dialog, "post-sales create dialog"); await page.keyboard.press("Escape"); await expectHidden(dialog, "post-sales create close");
  }}
];
const deniedRoutes = [
  { scenario: "owner", route: "/root/workspaces" },
  { scenario: "operator", route: "/root/workspaces" },
];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const routePath = (url) => { const path = new URL(url).pathname; return path.replace(/^\/(?:api|backend)/, ""); };
function fixture(path, method, actor) {
  if (method === "OPTIONS") return { status: 204 };
  if (method === "PATCH" && path.endsWith("/read")) return { status: 204 };
  if (method !== "GET" && method !== "HEAD") return { status: 599, body: { error: "mutation-blocked-by-interactive-audit", path, method } };
  if (path === "/me") return { body: actor };
  if (path === "/feature-flags") return { body: { flags: Object.fromEntries(FEATURE_FLAG_KEYS.map((key) => [key, false])), featureFlags: CAPABILITY_CATALOG } };
  if (path === "/capabilities") return { body: { capabilities: CAPABILITY_CATALOG } };
  if (path === "/panel/version") return { body: { version: FIXTURE_VERSION, changelog: [] } };
  if (path === "/events") return { status: 204 };
  if (path.endsWith("/media")) return { body: { messages: [], has_more: false, next_cursor: null } };
  for (const domain of [conversationFixture, commercialFixture, settingsFixture, rootFixture, publicTripzFixture]) { const body = domain(path); if (body !== undefined) return { body }; }
  return { status: 599, body: { error: "fixture-gap", path, method } };
}
async function one(locator, label) { await locator.first().waitFor({ state: "visible", timeout: 10000 }); if (await locator.count() !== 1 || !(await locator.isVisible())) throw new Error(`${label}: expected one visible real control`); }
async function expectAttr(locator, attr, value, label) { await one(locator, label); if (await locator.getAttribute(attr) !== value) throw new Error(`${label}: expected ${attr}=${value}`); }
async function expectHidden(locator, label) { if (await locator.isVisible().catch(() => false)) throw new Error(`${label}: still visible`); }
async function awaitHeading(page, route) {
  const contract = contractFor(route); if (!contract) throw new Error(`missing contract for ${route}`);
  const heading = page.getByRole("main").getByRole("heading", { name: new RegExp(contract.heading) }).first(); await heading.waitFor({ state: "visible", timeout: 10000 }); await one(heading, `${route} heading`); return heading;
}
async function installFixture(context, scenario, gaps) {
  await context.addInitScript(({ version, now }) => { localStorage.setItem("atendon_last_seen_version", version); const fixed = Date.parse(now); const RealDate = Date; globalThis.Date = class extends RealDate { constructor(...args) { super(args.length ? args : [now]); } static now() { return fixed; } }; }, { version: FIXTURE_VERSION, now: FIXTURE_NOW });
  await context.route("**/*", async (route) => { const request = route.request(); const url = new URL(request.url()); if (!/^\/(?:api|backend)\//.test(url.pathname)) return url.origin === new URL(baseURL).origin ? route.continue() : route.abort(); const answer = fixture(routePath(request.url()), request.method(), scenario.session); if (answer.status === 599) { gaps.push(`${request.method()} ${routePath(request.url())}`); return json(route, answer.body, 599); } return answer.status === 204 ? route.fulfill({ status: 204, body: "" }) : json(route, answer.body, answer.status ?? 200); });
}
async function runCase(page, item, scenario, screenshot, gaps) {
  await page.goto(new URL(item.route, baseURL).toString(), { waitUntil: "domcontentloaded", timeout: 20000 });
  await awaitHeading(page, item.route); if (gaps.length) throw new Error(`fixture gaps before case: ${gaps.join(", ")}`); await item.run?.(page); if (gaps.length) throw new Error(`fixture gaps: ${gaps.join(", ")}`);
  await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
}
async function main() {
  await mkdir(resolve(output, "screenshots"), { recursive: true }); const browser = await chromium.launch({ headless: true }); const results = []; let index = 0;
  try { for (const scenario of scenarios) for (const viewport of viewports) { const context = await browser.newContext({ viewport, locale: "pt-BR" }); const gaps = []; await installFixture(context, scenario, gaps); const page = await context.newPage();
    for (const item of cases.filter((candidate) => candidate.scenarios.includes(scenario.name) && candidate.viewports?.includes(viewport.name) !== false)) { const record = { scenario: scenario.name, viewport: viewport.name, case: item.id, route: item.route, status: "failed", gaps: [] }; try { await runCase(page, item, scenario, resolve(output, "screenshots", `${index++}-${scenario.name}-${viewport.name}-${item.id}.png`), gaps); record.status = "passed"; } catch (error) { record.error = String(error); } record.gaps = [...gaps]; results.push(record); gaps.length = 0; }
    for (const denied of deniedRoutes.filter((item) => item.scenario === scenario.name)) { const record = { scenario: scenario.name, viewport: viewport.name, case: "denial", route: denied.route, status: "failed", gaps: [] }; try { await page.goto(new URL(denied.route, baseURL).toString(), { waitUntil: "domcontentloaded", timeout: 20000 }); await page.waitForFunction(() => window.location.pathname === "/403", undefined, { timeout: 10000 }); const heading = page.getByRole("heading", { name: /Você não tem permissão para abrir esta área/i }); await one(heading, "denial heading"); if (gaps.length) throw new Error(`fixture gaps: ${gaps.join(", ")}`); record.status = "passed"; } catch (error) { record.error = String(error); } record.gaps = [...gaps]; results.push(record); gaps.length = 0; }
    await context.close(); }
  } finally { await browser.close(); }
  const counts = { exercised: results.length, passed: results.filter((r) => r.status === "passed").length, failed: results.filter((r) => r.status === "failed").length, fixtureGaps: [...new Set(results.flatMap((r) => r.gaps))] }; const report = { version: "audit-interactive-state-v1", baseURL, fixtureVersion: FIXTURE_VERSION, fixtureClock: FIXTURE_NOW, viewports, operatorRole: "OPERADOR", operatorPermissions, cases: cases.map(({ id, route }) => ({ id, route })), deniedRoutes, results, counts }; await writeFile(resolve(output, "interactive-state.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(counts)); if (counts.failed || counts.fixtureGaps.length) process.exitCode = 2;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
