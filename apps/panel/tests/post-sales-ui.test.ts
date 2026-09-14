import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

let page = "";
const styleFiles = ["tokens.css", "base.css", "components.css", "shell.css", "domains/feedback.css", "domains/agenda.css", "domains/conversations.css", "domains/pipeline.css", "domains/auth.css", "domains/post-sales.css", "domains/agenda-calendar.css", "domains/leads.css"];
const readStyleSource = () => Promise.all(styleFiles.map((file) => readFile(new URL(`../styles/${file}`, import.meta.url), "utf8"))).then((sources) => sources.join("\n"));

let settings = "";
let shell = "";
let manifest = "";
let rootWorkspaces = "";
let styles = "";

beforeAll(async () => {
  [page, settings, shell, manifest, rootWorkspaces, styles] = await Promise.all([
    readFile(new URL("../app/pos-venda/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/pos-venda/configurar/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/shell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/panel-manifest.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/root/workspaces/page.tsx", import.meta.url), "utf8"),
    readStyleSource()
  ]);
});

describe("post-sales UI contracts", () => {
  it("keeps the module independent, flag-gated and permission-gated", () => {
    expect(manifest).toContain('group: "Pós-venda"');
    expect(manifest).toContain('href: "/pos-venda", label: "Carteira"');
    expect(manifest).toContain('requiredPermissions: ["post_sales.use"]');
    expect(manifest).toContain('requiredPermissions: ["post_sales.manage"]');
    expect(shell).toContain("panelManifest");
    expect(manifest).toContain('capability: "post_sales_v1"');
    expect(shell).toContain("canExposeManifestItem(");
    expect(shell).toContain("capabilities.isEnabled");
    expect(page).not.toContain("/crm");
  });

  it("exposes the portfolio states, pagination and optimistic conflict recovery", () => {
    expect(page).toContain('"/post-sales/options"');
    expect(page).toContain("cursor=${encodeURIComponent(nextCursor)}");
    expect(page).toContain("PortfolioSkeleton");
    expect(page).toContain("InlineFailure");
    expect(page).toContain("Nenhum cliente nesta visão");
    expect(page).toContain("isPostSaleVersionConflict");
    expect(page).toContain("Abrir cadastro existente");
    expect(page).toContain("instantFromLocalMinute");
  });

  it("supports mobile master-detail switching, keyboard controls and both themes", () => {
    expect(page).toContain("data-mobile-view={mobileView}");
    expect(page).toContain("Voltar à carteira");
    expect(settings).toContain("Mover ${item.description} para cima");
    expect(settings).toContain("Mover ${item.description} para baixo");
    expect(styles).toContain('@media(max-width:820px)');
    expect(styles).toContain('.post-sales-layout[data-mobile-view="list"]');
    expect(styles).toContain(':root[data-theme="light"]');
    expect(styles).toContain('@media(prefers-reduced-motion:reduce)');
  });

  it("lets ROOT control every supported capability through the generic catalog", () => {
    expect(rootWorkspaces).toContain("`/root/workspaces/${editing.id}/capabilities`");
    expect(rootWorkspaces).toContain("Herdar");
    expect(rootWorkspaces).toContain("CAPABILITY_CASCADE_CONFIRMATION_REQUIRED");
    expect(rootWorkspaces).not.toContain("postSalesFlag");
  });
});
