#!/usr/bin/env node
/** Corrected fixture-only browser audit. No production API calls are permitted. */
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { session, rootSession, rootWorkspaceSession, IDS } from "./design-audit/fixtures/session.mjs";
import { conversationFixture } from "./design-audit/fixtures/conversations.mjs";
import { commercialFixture } from "./design-audit/fixtures/commercial.mjs";
import { settingsFixture } from "./design-audit/fixtures/settings.mjs";
import { rootFixture } from "./design-audit/fixtures/root.mjs";
import { publicTripzFixture, meetAccess, MEET_PROVIDER_STUB_SCRIPT } from "./design-audit/fixtures/public-tripz.mjs";
import { panelsV6Fixture } from "./design-audit/fixtures/panels-v6.mjs";
import { CAPABILITY_CATALOG, ENTITLEMENTS, FEATURE_FLAG_KEYS } from "./design-audit/catalog.mjs";
import { loadInventory } from "./design-audit/inventory.mjs";
import { contractFor, ROUTE_CONTRACTS } from "./design-audit/contracts.mjs";
import { benignExternal, validateRecord, summarize } from "./design-audit/validate.mjs";
import { classifyControlReachability } from "./design-audit/geometry.mjs";

const baseURL = process.env.BASE_URL ?? process.env.PANEL_E2E_BASE_URL ?? "http://127.0.0.1:3499";
const root = resolve(process.env.PANEL_APP_ROOT ?? new URL(".", import.meta.url).pathname, "../app");
const output = resolve(process.env.OUTPUT ?? process.env.QA_OUTPUT ?? "/tmp/atendon-frontend-redesign/qa-browser/audit");
const routeFilter = process.env.ROUTE_FILTER;
const viewportFilter = process.env.VIEWPORT_FILTER;
const themeFilter = process.env.THEME_FILTER;
const inventoryPath = process.env.ROUTE_INVENTORY;
const viewports = [{ name: "360x800", width: 360, height: 800 }, { name: "768x1024", width: 768, height: 1024 }, { name: "1440x900", width: 1440, height: 900 }].filter((v) => !viewportFilter || new RegExp(viewportFilter, "i").test(v.name));
const themes = ["dark", "light"].filter((v) => !themeFilter || new RegExp(themeFilter, "i").test(v));
const routeReplacements = { "/invitations/[token]": "/invitations/qa-token", "/convite": "/convite?token=qa-token", "/contatos/[id]": `/contatos/${IDS.lead}`, "/meet/[roomId]": "/meet/qa-room", "/reuniao/[code]": "/reuniao/qa-code", "/fluxos/[id]": "/fluxos/qa-flow-0001", "/configuracoes/[resource]": "/configuracoes/categorias" };
// R1(a): sondas para ESTADOS DE ROTA descobertos no inventário (error/not-found/
// loading). /__not-found navega para uma URL inexistente (boundary 404 real).
// Estados sem gatilho determinístico fixture-only entram como UNAUDITABLE com
// motivo — nunca como registro mascarado.
const ROUTE_STATE_PROBES = {
  "/__not-found": { requested: "/__rota-audit-inexistente" },
  "/__error": { unauditable: "error.tsx sem gatilho determinístico em build congelado fixture-only (D2 investigado, mantido UNAUDITABLE): (1) nenhuma página existente lança erro de render sob fixtures — o guard de sessão trata falha de /me com UI própria, sem lançar; (2) abortar navegação/chunks via context.route NÃO renderiza o boundary error.tsx de forma determinística e contamina o registro com console/page errors (falha artificial); (3) uma rota sonda dedicada exigiria editar app/** — fora do escopo D2. Bloqueio honesto desta fase." }
};
const routePath = (url) => new URL(url).pathname.replace(/^\/(?:api|backend)/, "");
const json = (intercept, body, status = 200) => intercept.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
// Aliases aninhados /configuracoes/* com SettingsDestinationAccess
// requireRootWorkspace (agente, alertas, follow-ups, funcoes, humanizacao, uso)
// só montam conteúdo com sessão root-with-workspace — /me precisa do
// rootWorkspaceSession quando o auditRoute é o alias de configuração.
const ROOT_WORKSPACE_ROUTES = new Set(["/alertas", "/follow-ups", "/agente/figurinhas", "/configuracoes/agente", "/configuracoes/alertas", "/configuracoes/follow-ups", "/configuracoes/funcoes", "/configuracoes/humanizacao", "/configuracoes/uso"]);
const EXPECTED_PROVIDER_FAILURES = new Set(["/meet/rooms/qa-room/token", "/meet/join/qa-code"]);
const publicRelease = { buildNumber: 3501, version: "2.1.0", publicTitle: "Central de mensagens refinada", publicSummary: "Ajustes de densidade, ações agrupadas e correções visuais.", publicChanges: [{ text: "Ações secundárias agrupadas em menus de três pontos", tenant_slugs: [] }], publishedAt: "2026-09-01T12:00:00.000Z", createdAt: "2026-09-01T12:00:00.000Z" };
const rootRelease = { id: "qa-release-0001", buildNumber: 3501, version: "2.1.0", classification: "RELEASE", classificationReason: "release QA", bumpSource: "qa", commitSha: "deadbeef", branch: "main", additions: 120, deletions: 40, filesChanged: [{ path: "apps/panel/app/leads/page.tsx", status: "modified", additions: 28, deletions: 16 }], modulesAffected: ["panel"], scope: "GLOBAL", tenantSlugsDetected: [], commitMessages: ["qa fixture"], diffExcerpt: "", technicalChangelog: "", publicTitle: publicRelease.publicTitle, publicSummary: publicRelease.publicSummary, publicChanges: publicRelease.publicChanges, aiStatus: "generated", aiError: null, aiModelUsed: "openai/gpt-4o-mini", published: true, publishedAt: "2026-09-01T12:00:00.000Z", manualOverride: false, isLegacyImport: false, createdAt: "2026-09-01T12:00:00.000Z" };
const changelogAiSettings = { hasApiKey: false, apiKeyHint: null, primaryModel: "openai/gpt-4o-mini", fallbackModel: null, autoGenerateEnabled: false, autoPublishEnabled: false, updatedAt: "2026-09-01T12:00:00.000Z" };
const channelCapabilities = { channel: "whatsapp", can_send: true, reason: null, window_expires_at: null, text: true, image: true, audio: true, video: true, document: true, reactions: true, edit: true, delete: true, stickers: true };
const instagramStatus = { configured: true, missing: [], graph_version: "v21.0", max_connections: 3 };
// F6a — changelog editorial: fixtures na EXATA shape dos contratos pousados
// (toPublicPost whitelist + read; toAdminPost completo). GET /root/changelog/posts
// cobre a lista com filtro (pathname chega sem query); POST /panel/changelog/read
// é guardado 204 (idempotente) para nunca virar fixture-gap.
const changelogPublicPost = {
  slug: "novidades-qa-setembro",
  versionLabel: null,
  title: "Novidades de setembro no AtendON",
  summary: "Resumo editorial QA do changelog global.",
  category: "melhoria",
  author: "Equipe AtendON",
  publishedAt: "2026-09-01T12:00:00.000Z",
  contentText: "Primeiro parágrafo QA do changelog.\n\nSegundo parágrafo QA do changelog.",
  relatedLinks: [{ label: "Documentação QA", url: "https://docs.atendon.example/novidades" }],
  modulesAffected: ["panel"],
  affectedPlans: [],
  media: [{ id: "qa-changelog-media-0001", alt: "Captura QA do changelog", mime: "image/png" }]
};
const changelogFeed = { posts: [{ ...changelogPublicPost, read: false }, { ...changelogPublicPost, slug: "novidades-qa-agosto", title: "Novidades de agosto no AtendON", read: true }], nextOffset: null };
const changelogAdminPost = {
  id: "qa-changelog-post-0001",
  releaseId: null,
  slug: "lancamento-qa-do-changelog",
  versionLabel: null,
  title: "Lançamento QA do changelog",
  summary: "Resumo editorial QA do changelog global.",
  category: "melhoria",
  author: "Equipe AtendON",
  contentText: "Primeiro parágrafo QA do changelog.\n\nSegundo parágrafo QA do changelog.",
  modulesAffected: ["panel"],
  affectedPlans: [],
  relatedLinks: [],
  publishAt: null,
  published: false,
  publishedAt: null,
  status: "draft",
  createdByUserId: null,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z",
  media: []
};
function payload(path, method, useRoot, auditRoute) {
  if (method === "OPTIONS") return { status: 204 };
  if (method === "PATCH" && (path === "/me/notification-preferences" || path === `/conversations/${IDS.conversation}/read` || path.startsWith("/alerts/") && path.endsWith("/read"))) return { status: 204 };
  // F6a: marcação de leitura é idempotente no backend — 204 direto (o audit
  // não interage, mas a guarda impede fixture-gap se a página marcar ao abrir).
  if (method === "POST" && path === "/panel/changelog/read") return { status: 204 };
  // R5: endpoints do provedor de videochamada — 503 é o estado expected-error
  // (comportamento correto em QA); a variante "#sucesso" recebe o mock do
  // provedor (token 200) e a página funcional é auditada como "passed".
  if (EXPECTED_PROVIDER_FAILURES.has(path)) return auditRoute?.endsWith("#sucesso") ? { body: meetAccess } : { status: 503, body: { error: "provider-unavailable", message: "Provedor de videochamada indisponível no ambiente de QA." } };
  if (method !== "GET" && method !== "HEAD") return null;
  if (path === "/me") return { body: ROOT_WORKSPACE_ROUTES.has(auditRoute) ? rootWorkspaceSession : (useRoot ? rootSession : session) };
  if (path === "/feature-flags") return { body: { flags: Object.fromEntries(FEATURE_FLAG_KEYS.map((key) => [key, false])), featureFlags: CAPABILITY_CATALOG } };
  if (path === "/panel/version") return { body: { version: process.env.AUDIT_BUILD_MARKER ?? "baseline3499", changelog: [] } };
  if (path === "/panel/versions") return { body: { releases: [publicRelease] } };
  if (path.startsWith("/root/versions")) return { body: { releases: [rootRelease] } };
  if (path === "/root/settings/changelog-ai") return { body: { settings: changelogAiSettings } };
  // F6a — changelog editorial (admin + feed autenticado).
  if (path === "/root/changelog/posts") return { body: { posts: [changelogAdminPost], nextOffset: null } };
  if (path === "/panel/changelog/feed") return { body: changelogFeed };
  if (path === "/panel/changelog/unread") return { body: { count: 1, latestPost: { slug: changelogPublicPost.slug, title: changelogPublicPost.title, category: changelogPublicPost.category, publishedAt: changelogPublicPost.publishedAt } } };
  if (/^\/conversations\/[^/]+\/channel-capabilities$/.test(path)) return { body: channelCapabilities };
  if (path === "/instagram/status") return { body: instagramStatus };
  if (path === "/events") return { status: 204 };
  if (path === "/capabilities") return { body: { capabilities: CAPABILITY_CATALOG } };
  if (path === "/billing/my-plan") return { body: ENTITLEMENTS };
  // panels-v6 primeiro: endpoints hidratados pelo Shell em todas as rotas
  // (aparência/sino/preferências) precisam existir antes dos fixtures por domínio.
  for (const fixture of [panelsV6Fixture, conversationFixture, commercialFixture, settingsFixture, rootFixture, publicTripzFixture]) { const value = fixture(path); if (value !== undefined) return { body: value }; }

}
async function boundedFontsReady(page) {
  await Promise.race([page.evaluate(() => document.fonts?.ready), new Promise((resolve) => setTimeout(resolve, 3000))]);
}
async function boundedEntityReady(page, contract) {
  // D2/P3: espera o marker em QUALQUER estado com entitySelector+marker (mesma
  // regra estrita do drift-check — antes só populated/expected-error esperavam).
  if (!contract?.entitySelector || !contract?.marker) return;
  await page.waitForFunction(({ selector, marker }) => {
    const pattern = new RegExp(marker, "i");
    return [...document.querySelectorAll(selector)].some((node) => pattern.test(`${node.textContent ?? ""} ${node.getAttribute("aria-label") ?? ""} ${node.getAttribute("title") ?? ""} ${[...node.querySelectorAll("input,textarea,select")].map((input) => input.value).join(" ")}`));
  }, { selector: contract.entitySelector, marker: contract.marker }, { timeout: 5000 }).catch(() => {});
}
async function measure(page, requestedTheme, contract) {
  const measured = await page.evaluate(async ({ requested, marker }) => {
    const visible = (node) => Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== "hidden");
    const headingPattern = new RegExp(`^(?:${marker.heading})$`, "i");
    const headings = [...document.querySelectorAll("h1,h2,[role=heading]")].filter(visible);
    const heading = headings.find((node) => headingPattern.test((node.textContent ?? "").trim()));
    const entityNodes = marker.entitySelector && marker.marker ? [...document.querySelectorAll(marker.entitySelector)].filter(visible) : [];
    const entity = entityNodes.some((node) => new RegExp(marker.marker, "i").test(`${node.textContent ?? ""} ${node.getAttribute("aria-label") ?? ""} ${node.getAttribute("title") ?? ""} ${[...node.querySelectorAll("input,textarea,select")].map((input) => input.value).join(" ")}`));
    const rootStyle = getComputedStyle(document.documentElement), bodyStyle = getComputedStyle(document.body);
    const buttons = [...document.querySelectorAll("button,[role=button]")].filter(visible);
    const describe = (node) => {
      const r = node.getBoundingClientRect(); if (!r.width || !r.height) return null;
      const points = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 1, r.top + 1], [r.right - 1, r.top + 1], [r.left + 1, r.bottom - 1], [r.right - 1, r.bottom - 1]];
      const hitTests = points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return Boolean(hit && (hit === node || node.contains(hit))); });
      const ancestors = [], ancestorNodes = []; let ancestor = node.parentElement;
      while (ancestor && ancestor !== document.body) {
        const style = getComputedStyle(ancestor);
        if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX) || ["auto", "scroll", "hidden", "clip"].includes(style.overflowY)) {
          const a = ancestor.getBoundingClientRect();
          ancestorNodes.push(ancestor);
          ancestors.push({ left: a.left, top: a.top, right: a.right, bottom: a.bottom, overflowX: style.overflowX, overflowY: style.overflowY, clientWidth: ancestor.clientWidth, clientHeight: ancestor.clientHeight, scrollWidth: ancestor.scrollWidth, scrollHeight: ancestor.scrollHeight, scrollLeft: ancestor.scrollLeft, scrollTop: ancestor.scrollTop, className: String(ancestor.className), establishesFixedContainingBlock: [style.transform, style.perspective, style.filter].some((value) => value && value !== "none") });
        }
        ancestor = ancestor.parentElement;
      }
      return { node, ancestorNodes, text: (node.innerText || node.getAttribute("aria-label") || "").trim(), selector: node.id ? `#${node.id}` : node.className ? `.${String(node.className).split(/\\s+/)[0]}` : node.tagName.toLowerCase(), control: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, position: getComputedStyle(node).position }, ancestors, hitTests };
    };
    const controls = buttons.map(describe).filter(Boolean);
    const root = document.scrollingElement || document.documentElement;
    const rootGeometry = { scrollableX: root.scrollWidth > root.clientWidth + 1, scrollableY: root.scrollHeight > root.clientHeight + 1, scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight, clientWidth: root.clientWidth, clientHeight: root.clientHeight, scrollLeft: root.scrollLeft, scrollTop: root.scrollTop };
    const savedOffsets = [{ node: root, left: root.scrollLeft, top: root.scrollTop }, ...controls.flatMap(({ node }) => { const offsets = []; let current = node.parentElement; while (current) { offsets.push({ node: current, left: current.scrollLeft, top: current.scrollTop }); current = current.parentElement; } return offsets; })];
    const restore = async () => {
      const styles = [document.documentElement, document.body].map((element) => ({ element, value: element.style.scrollBehavior }));
      for (const { element } of styles) element.style.scrollBehavior = "auto";
      for (const entry of [...savedOffsets].reverse()) entry.node.scrollTo?.(entry.left, entry.top);
      window.scrollTo(rootGeometry.scrollLeft, rootGeometry.scrollTop);
      await settledFrame();
      for (const { element, value } of styles) element.style.scrollBehavior = value;
      controls.forEach(refreshAncestors);
    };
    const settledFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const refreshAncestors = (item) => item.ancestorNodes.forEach((ancestor, index) => {
      const rect = ancestor.getBoundingClientRect();
      const current = item.ancestors[index];
      item.ancestors[index] = { ...current, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, clientWidth: ancestor.clientWidth, clientHeight: ancestor.clientHeight, scrollWidth: ancestor.scrollWidth, scrollHeight: ancestor.scrollHeight, scrollLeft: ancestor.scrollLeft, scrollTop: ancestor.scrollTop };
    });
    const prove = async (item) => {
      const initial = item.control;
      const node = item.node;
      const chain = [];
      let current = node.parentElement;
      while (current) {
        const style = getComputedStyle(current);
        const xScrollable = current !== root && ["auto", "scroll"].includes(style.overflowX) && current.scrollWidth > current.clientWidth + 1;
        const yScrollable = current !== root && ["auto", "scroll"].includes(style.overflowY) && current.scrollHeight > current.clientHeight + 1;
        if (xScrollable || yScrollable) chain.push({ node: current, x: xScrollable, y: yScrollable });
        current = current.parentElement;
      }

      const rootScrollStyles = [document.documentElement, document.body].map((element) => ({ element, value: element.style.scrollBehavior }));
      try {
        for (const { element } of rootScrollStyles) element.style.scrollBehavior = "auto";
        for (const scroller of chain) {
          const box = scroller.node.getBoundingClientRect(), rect = node.getBoundingClientRect();
          if (scroller.x) { const delta = rect.left < box.left ? rect.left - box.left : rect.right > box.right ? rect.right - box.right : 0; scroller.node.scrollLeft = Math.max(0, Math.min(scroller.node.scrollWidth - scroller.node.clientWidth, scroller.node.scrollLeft + delta)); }
          if (scroller.y) { const delta = rect.top < box.top ? rect.top - box.top : rect.bottom > box.bottom ? rect.bottom - box.bottom : 0; scroller.node.scrollTop = Math.max(0, Math.min(scroller.node.scrollHeight - scroller.node.clientHeight, scroller.node.scrollTop + delta)); }
          await settledFrame();
          refreshAncestors(item);
        }
        if (rootGeometry.scrollableX || rootGeometry.scrollableY) { const rect = node.getBoundingClientRect(); window.scrollTo(rootGeometry.scrollableX ? Math.max(0, Math.min(root.scrollWidth - root.clientWidth, root.scrollLeft + (rect.left < 0 ? rect.left : rect.right > innerWidth ? rect.right - innerWidth : 0))) : root.scrollLeft, rootGeometry.scrollableY ? Math.max(0, Math.min(root.scrollHeight - root.clientHeight, root.scrollTop + (rect.top < 0 ? rect.top : rect.bottom > innerHeight ? rect.bottom - innerHeight : 0))) : root.scrollTop); await settledFrame(); refreshAncestors(item); }
        const rect = node.getBoundingClientRect();
        const finalHitTests = [[rect.left + rect.width / 2, rect.top + rect.height / 2], [rect.left + 1, rect.top + 1], [rect.right - 1, rect.bottom - 1]].map(([x, y]) => { const target = document.elementFromPoint(x, y); return Boolean(target && (target === node || node.contains(target))); });
        const clippedByNonScroller = item.ancestors.some((ancestor) => { const outsideX = rect.left < ancestor.left - 1 || rect.right > ancestor.right + 1, outsideY = rect.top < ancestor.top - 1 || rect.bottom > ancestor.bottom + 1; return (outsideX && ["hidden", "clip"].includes(ancestor.overflowX)) || (outsideY && ["hidden", "clip"].includes(ancestor.overflowY)); });
        const verified = !clippedByNonScroller && finalHitTests.some(Boolean);
        return { verified, reachable: verified, hitTest: verified, kind: chain.length ? "nested" : "document", reason: verified ? undefined : (initial.right > 0 && initial.left < innerWidth && initial.bottom > 0 && initial.top < innerHeight ? "overflow-hit-test-inconclusive" : "overflow-unreachable"), finalRect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, ancestorRects: item.ancestors.map(({ left, top, right, bottom }) => ({ left, top, right, bottom })), clippedByNonScroller, hitTests: finalHitTests };
      } finally {
        for (const { element, value } of rootScrollStyles) element.style.scrollBehavior = value;
      }
    };
    const proofs = [];
    for (const item of controls) { await restore(); proofs.push(await prove(item)); }
    await restore();
    controls.forEach((item, index) => { item.proof = proofs[index]; delete item.node; delete item.ancestorNodes; });
    const clippedButtonDetails = [];
    const text = document.body?.innerText ?? "";
    return { heading: { matched: Boolean(heading), text: heading?.textContent?.trim() ?? null, count: headings.length }, entity: { matched: !(marker.entitySelector && marker.marker) ? true : entity }, textLength: text.trim().length, loading: Boolean(document.querySelector("[aria-busy=true], .loading-state, [data-loading=true], [role=status][aria-label*='carreg' i]")), theme: { dataset: document.documentElement.dataset.theme ?? null, background: rootStyle.getPropertyValue("--bg").trim() || bodyStyle.backgroundColor, requested }, errorText: /application error|internal server error|fixture-gap/i.test(text) ? text.match(/.{0,40}(application error|internal server error|fixture-gap).{0,80}/i)?.[0] ?? null : null, viewport: { width: innerWidth, height: innerHeight }, controls, rootGeometry, metrics: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, clippedButtons: clippedButtonDetails.length > 0, clippedButtonDetails } };
  }, { requested: requestedTheme, marker: contract });
  const classified = (measured.controls ?? []).map((item) => ({ ...item, result: classifyControlReachability(item.control, measured.viewport, item.ancestors, item.hitTests, item.proof, measured.rootGeometry) })).filter((item) => item.result.clipped);
  return { ...measured, metrics: { ...measured.metrics, clippedButtons: classified.length > 0, clippedButtonDetails: classified.map(({ text, selector, control, result }) => ({ text, selector, rect: [control.left, control.top, control.right, control.bottom], reason: result.reason, ancestor: result.ancestor ?? null })) } };
}
async function provePostSalesDisclosure(page) {
  const target = page.getByRole("button", { name: /Dados, observação e próxima ação/i }).first();
  if (await target.count() === 0) return { attempted: false, reachable: null, reason: "target-not-present" };
  return target.evaluate((node) => {
    const root = document.scrollingElement || document.documentElement;
    const rootOffset = { left: root.scrollLeft, top: root.scrollTop };
    const saved = [{ node: root, left: rootOffset.left, top: rootOffset.top }];
    let ancestor = node.parentElement;
    while (ancestor) { saved.push({ node: ancestor, left: ancestor.scrollLeft, top: ancestor.scrollTop }); const style = getComputedStyle(ancestor); const box = ancestor.getBoundingClientRect(), rect = node.getBoundingClientRect(); if (["auto", "scroll"].includes(style.overflowX)) ancestor.scrollLeft = Math.max(0, Math.min(ancestor.scrollWidth - ancestor.clientWidth, ancestor.scrollLeft + (rect.left < box.left ? rect.left - box.left : rect.right > box.right ? rect.right - box.right : 0))); if (["auto", "scroll"].includes(style.overflowY)) ancestor.scrollTop = Math.max(0, Math.min(ancestor.scrollHeight - ancestor.clientHeight, ancestor.scrollTop + (rect.top < box.top ? rect.top - box.top : rect.bottom > box.bottom ? rect.bottom - box.bottom : 0))); ancestor = ancestor.parentElement; }
    const beforeRoot = node.getBoundingClientRect(); window.scrollTo(root.scrollLeft + (beforeRoot.left < 0 ? beforeRoot.left : beforeRoot.right > innerWidth ? beforeRoot.right - innerWidth : 0), root.scrollTop + (beforeRoot.top < 0 ? beforeRoot.top : beforeRoot.bottom > innerHeight ? beforeRoot.bottom - innerHeight : 0));
    const r = node.getBoundingClientRect();
    const points = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 1, r.top + 1], [r.right - 1, r.bottom - 1]];
    const hitTests = points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return Boolean(hit && (hit === node || node.contains(hit))); });
    const result = { attempted: true, reachable: r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight && hitTests.some(Boolean), rect: [r.left, r.top, r.right, r.bottom], hitTests, scrollContainer: node.closest(".post-sales-detail__scroll")?.className ?? null };
    for (const entry of saved.reverse()) entry.node.scrollTo?.(entry.left, entry.top); window.scrollTo(rootOffset.left, rootOffset.top); return result;
  });
}
// PRECEDÊNCIA DE MESCLA DE CONTRATOS (R5 — gap G6 do investigation, documentado):
// A mescla usa Object.assign em ordem [commercial, settings, root] — cada
// domínio aplicado DEPOIS SOBRESCREVE chaves iguais dos anteriores. Contratos
// de domínio (quando cobrem a rota) vencem SEMPRE o contrato base de
// contracts.mjs, que só entra via contractFor() como fallback final.
// Ordem de precedência efetiva (o de cima vence):
//   1. contracts-root.mjs        (ROOT_ROUTE_CONTRACTS) — aplicado por último
//   2. contracts-settings.mjs OU optionalcontracts-settings.mjs (fallback do
//      mesmo domínio; o primeiro import que existir vence)
//   3. contracts-commercial.mjs  (slot reservado — não existe hoje)
//   4. contracts.mjs             (ROUTE_CONTRACTS — base, fallback final)
const CONTRACT_PRECEDENCE = [
  { priority: 1, module: "scripts/design-audit/contracts-root.mjs", export: "ROOT_ROUTE_CONTRACTS", note: "maior prioridade — aplicado por último na mescla" },
  { priority: 2, module: "scripts/design-audit/contracts-settings.mjs | optionalcontracts-settings.mjs", export: "SETTINGS_OPTIONAL_CONTRACTS", note: "prioridade média — primeiro import existente do domínio settings vence" },
  { priority: 3, module: "scripts/design-audit/contracts-commercial.mjs", export: "ROUTE_CONTRACTS(domain)", note: "menor prioridade entre domains — slot não existente hoje" },
  { priority: 4, module: "scripts/design-audit/contracts.mjs", export: "ROUTE_CONTRACTS", note: "base — fallback final via contractFor() quando nenhum domain cobre a rota" }
];
async function loadDomainContracts() {
  const merged = {};
  for (const domain of ["commercial", "settings", "root"]) {
    try {
      const candidates = domain === "settings" ? ["./design-audit/contracts-settings.mjs", "./design-audit/optionalcontracts-settings.mjs"] : [`./design-audit/contracts-${domain}.mjs`];
      let module;
      for (const candidate of candidates) { try { module = await import(candidate); break; } catch (error) { if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error; } }
      if (!module) continue;
      Object.assign(merged, module.ROUTE_CONTRACTS ?? module.ROOT_ROUTE_CONTRACTS ?? module.SETTINGS_OPTIONAL_CONTRACTS ?? module.contracts ?? module.default ?? {});
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }
  return merged;
}
// Filtro document-404 (D1-r2): em /__not-found o Chromium registra a própria
// navegação do DOCUMENTO (404 do boundary not-found — comportamento esperado,
// já exigido pelo contrato state "not-found" via HTTP 404) como console error.
// Só a mensagem cuja location aponta para o pathname do documento solicitado é
// filtrada; 404/401 de recursos (JS/CSS/API) e pageErrors continuam contando.
const DOCUMENT_404_TEXT = /^Failed to load resource: the server responded with a status of 404\b/;
async function main() {
  if (!viewports.length || !themes.length) throw new Error("VIEWPORT_FILTER/THEME_FILTER matched no values");
  const domainContracts = await loadDomainContracts();
  const inventory = await loadInventory(inventoryPath, root);
  // Contratos efetivos: base (contracts.mjs) sobrescrita pelos domains (precedência
  // documentada em CONTRACT_PRECEDENCE acima). Chaves "#variante" definem estados
  // adicionais de uma mesma rota (ex.: "#sucesso" p/ mock do provedor de meet).
  const allContracts = { ...ROUTE_CONTRACTS, ...domainContracts };
  const routeStateEntries = inventory.filter((entry) => entry.routeState);
  const unauditable = [], baseEntries = [];
  for (const entry of inventory) {
    const probe = ROUTE_STATE_PROBES[entry.route];
    if (entry.routeState && probe?.unauditable) { unauditable.push({ route: entry.route, file: entry.file, reason: probe.unauditable }); continue; }
    if (entry.routeState && !probe?.requested) { unauditable.push({ route: entry.route, file: entry.file, reason: "estado de rota descoberto sem sonda determinística definida em ROUTE_STATE_PROBES — não auditável de forma honesta nesta fase." }); continue; }
    baseEntries.push(entry);
  }
  // R5: expansão de variantes — cada contrato "<rota>#<variante>" gera uma
  // ENTRADA PRÓPRIA na matriz (registro próprio, status próprio).
  const variantEntries = [];
  for (const entry of baseEntries) {
    for (const [key, contract] of Object.entries(allContracts)) {
      if (!key.startsWith(`${entry.route}#`)) continue;
      variantEntries.push({ ...entry, variant: key.slice(entry.route.length + 1), variantState: contract.state ?? "public" });
    }
  }
  const entries = [...baseEntries, ...variantEntries];
  const selected = entries.filter(({ route }) => !routeFilter || new RegExp(routeFilter, "i").test(route));
  if (!selected.length) throw new Error(`ROUTE_FILTER matched no routes: ${routeFilter}`);
  const seen = new Set(), records = [], unknown = new Set();
  await mkdir(resolve(output, "screenshots"), { recursive: true }); await mkdir(resolve(output, "dom"), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const entry of selected) for (const theme of themes) for (const viewport of viewports) {
      const route = entry.route, requested = routeReplacements[route] ?? ROUTE_STATE_PROBES[route]?.requested ?? route;
      const recordRoute = entry.variant ? `${route}#${entry.variant}` : route;
      const contract = allContracts[recordRoute] ?? allContracts[route];
      const context = await browser.newContext({ viewport, locale: "pt-BR" }); const page = await context.newPage();
      const gaps = [], consoleErrors = [], pageErrors = [], failedRequests = [], assets = { js: [], css: [] };
      let document404Filtered = 0;
      await page.addInitScript((value) => { localStorage.setItem("atendon_last_seen_version", value.version); localStorage.setItem("atendon-theme", value.theme); const RealDate = Date; const frozen = new RealDate(value.now).getTime(); class FrozenDate extends RealDate { constructor(...args) { super(args.length ? args[0] : frozen); } static now() { return frozen; } } globalThis.Date = FrozenDate; const applyTheme = () => { document.documentElement.dataset.theme = value.theme; }; if (document.documentElement) applyTheme(); else document.addEventListener("DOMContentLoaded", applyTheme, { once: true }); }, { version: process.env.AUDIT_BUILD_MARKER ?? "baseline3499", theme, now: process.env.AUDIT_FIXTURE_NOW ?? "2026-08-20T12:00:00.000Z" });
      await context.route("**/*", async (intercept) => {
        const req = intercept.request(), url = new URL(req.url()), method = req.method();
        const isApi = url.pathname.startsWith("/api/") || url.pathname.startsWith("/backend/");
        if (isApi) { const path = routePath(req.url()), answer = payload(path, method, requested.startsWith("/root"), recordRoute); if (!answer) { const gap = `${method} ${path}`; gaps.push(gap); unknown.add(gap); return intercept.fulfill({ status: 599, contentType: "application/json", body: JSON.stringify({ error: "fixture-gap", request: gap }) }); } return answer.status === 204 ? intercept.fulfill({ status: 204, body: "" }) : json(intercept, answer.body, answer.status ?? 200); }
        if (url.pathname === "/external_api.js" && recordRoute.endsWith("#sucesso")) return intercept.fulfill({ status: 200, contentType: "text/javascript", body: MEET_PROVIDER_STUB_SCRIPT });
        if (url.origin !== new URL(baseURL).origin) { if (method === "GET" && benignExternal(req.url())) return intercept.continue(); failedRequests.push(`blocked external ${req.url()}`); return intercept.abort(); }
        return intercept.continue();
      });
      page.on("response", (response) => { const u = response.url(); if (response.status() < 400) { if (u.includes("/_next/") && u.endsWith(".js")) assets.js.push(u); if (u.endsWith(".css")) assets.css.push(u); } });
      page.on("console", (msg) => { if (msg.type() !== "error") return; if (route === "/__not-found" && DOCUMENT_404_TEXT.test(msg.text())) { const locUrl = msg.location?.()?.url ?? null; if (locUrl && new URL(locUrl).pathname === requested) { document404Filtered += 1; return; } } if (!(EXPECTED_PROVIDER_FAILURES.has(route === "/meet/[roomId]" ? "/meet/rooms/qa-room/token" : route === "/reuniao/[code]" ? "/meet/join/qa-code" : "") && /503 \(Service Unavailable\)/.test(msg.text()))) consoleErrors.push(msg.text()); }); page.on("pageerror", (error) => pageErrors.push(String(error)));
      page.on("requestfailed", (req) => { if (!benignExternal(req.url())) failedRequests.push(`${req.method()} ${req.url()} ${req.failure()?.errorText ?? "failed"}`); });
      const key = `${recordRoute}|${theme}|${viewport.name}`; if (seen.has(key)) throw new Error(`duplicate audit record key: ${key}`); seen.add(key);
      const record = { version: "design-audit-v2", baseline: process.env.AUDIT_PHASE !== "final", buildMarker: process.env.AUDIT_BUILD_MARKER ?? "baseline3499", route: recordRoute, requested, theme: { requested: theme }, viewport, status: "failed", finalUrl: null, httpStatus: null, screenshot: null, assets, gaps, consoleErrors, pageErrors, failedRequests, axe: null, metrics: null, heading: null, entity: null, loading: false, errorText: null, reason: null };
      try {
        const response = await page.goto(new URL(requested, baseURL).toString(), { waitUntil: "domcontentloaded", timeout: 20_000 });
        await boundedFontsReady(page); if (contract?.entitySelector) await page.locator(contract.entitySelector).first().waitFor({ state: "visible", timeout: 3000 }).catch(() => {}); await boundedEntityReady(page, contract); await page.waitForFunction(() => !document.querySelector("[aria-busy=true], .loading-state, [data-loading=true], [role=status][aria-label*='carreg' i]"), { timeout: 5000 }).catch(() => {});
        record.finalUrl = new URL(page.url()).pathname; record.httpStatus = response?.status() ?? null; const postSalesProof = route === "/pos-venda" ? await provePostSalesDisclosure(page) : null; Object.assign(record, await measure(page, theme, contract)); if (postSalesProof) record.metrics.postSalesDisclosure = postSalesProof;
        record.axe = process.env.AXE === "0" ? { disabled: true, violations: [] } : await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze().then((r) => ({ violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, description: v.description, nodes: v.nodes.map((node) => ({ target: node.target, html: node.html, failureSummary: node.failureSummary ?? null })) })), incomplete: r.incomplete.length })).catch((e) => ({ error: String(e), violations: [] }));
        const validation = validateRecord(record, contract);
        // R5: estado expected-error NUNCA é "passed" — status próprio distinto.
        record.status = validation.valid && contract?.state === "expected-error" ? "expected-error" : validation.valid ? "passed" : (gaps.length ? "fixture-gap" : "failed");
        record.reason = validation.errors.join(";");
        record.screenshot = resolve(output, "screenshots", `${recordRoute.replaceAll("/", "_").replaceAll("[", "").replaceAll("]", "").replaceAll("#", "_") || "home"}--${theme}--${viewport.name}.png`); await page.screenshot({ path: record.screenshot, fullPage: true, animations: "disabled" }); await writeFile(resolve(output, "dom", `${(records.length + 1).toString().padStart(4, "0")}.html`), await page.content());
      } catch (error) { record.status = gaps.length ? "fixture-gap" : "failed"; record.reason = String(error); }
      record.document404Filtered = document404Filtered;
      record.assets.js = [...new Set(record.assets.js)]; record.assets.css = [...new Set(record.assets.css)]; records.push(record); await writeFile(resolve(output, `${records.length.toString().padStart(4, "0")}.json`), JSON.stringify(record, null, 2)); await context.close();
    }
  } finally { await browser.close(); }
  const pageEntryCount = inventory.filter((entry) => !entry.routeState).length;
  const report = { version: "design-audit-v2", baseline: process.env.AUDIT_PHASE === "final" ? "final" : "baseline3499", buildMarker: process.env.AUDIT_BUILD_MARKER ?? "baseline3499", baseURL, generatedAt: new Date().toISOString(), inventory: { requested: selected.length, total: inventory.length, pageRoutes: pageEntryCount, routeStates: { discovered: routeStateEntries.map((entry) => ({ route: entry.route, file: entry.file, state: entry.routeState })), audited: selected.filter((entry) => entry.routeState).map((entry) => entry.route), unauditable }, variants: variantEntries.map((entry) => ({ route: entry.route, variant: entry.variant, state: entry.variantState })), matrixPerRoute: themes.length * viewports.length, expectedRecords: selected.length * themes.length * viewports.length }, counts: summarize(records), contractPrecedence: CONTRACT_PRECEDENCE, unknownApiRequests: [...unknown].sort(), routes: records };
  await writeFile(resolve(output, "audit.json"), JSON.stringify(report, null, 2)); await writeFile(resolve(output, "summary.json"), JSON.stringify({ ...report, routes: undefined }, null, 2));
  const unexpected = records.filter((record) => record.status !== "passed" && record.status !== "expected-error");
  console.log(JSON.stringify({ output, pageRoutes: report.inventory.pageRoutes, entries: selected.length, expectedRecords: report.inventory.expectedRecords, records: records.length, counts: report.counts, variants: report.inventory.variants.length, routeStatesAudited: report.inventory.routeStates.audited, routeStatesUnauditable: report.inventory.routeStates.unauditable.length, unknownApiRequests: report.unknownApiRequests }, null, 2));
  if (records.length !== report.inventory.expectedRecords || report.unknownApiRequests.length || unexpected.length) process.exitCode = 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error); process.exitCode = 1; });
export { measure, payload };
