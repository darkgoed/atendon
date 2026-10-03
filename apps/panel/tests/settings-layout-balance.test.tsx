// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConfigPage from "@/app/configuracoes/page";

const mocks = vi.hoisted(() => ({ api: vi.fn(), manage: true }));
vi.mock("@/lib/api", () => ({ api: mocks.api }));
vi.mock("@/lib/capabilities", () => ({ useCapabilities: () => ({ isEnabled: () => true, isLoading: false }) }));
vi.mock("@/lib/use-permission", () => ({ usePermission: (key: string) => !key.endsWith(".manage") || mocks.manage }));
const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

afterEach(() => { cleanup(); mocks.manage = true; });

function renderCatalog() {
  window.history.pushState({}, "", "/configuracoes/categorias");
  mocks.api.mockImplementation(async (path: string) => {
    if (path === "/me") return { user: { id: "user", email: "owner@example.com" }, activeWorkspace: { id: "workspace", role: "OWNER" }, permissions: [] };
    if (path === "/scheduling/config/categorias") return { categorias: [{ id: "consulta", nome: "Consulta", ativa: true, ordem_prioridade: 1 }] };
    throw new Error(`Unexpected fixture: ${path}`);
  });
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><ConfigPage /></SWRConfig>);
}

describe("Configurações: distribuição do espaço", () => {
  it("reserva a segunda coluna somente enquanto o editor está aberto", async () => {
    renderCatalog();
    const table = await screen.findByRole("table");
    const layout = table.closest("section")?.parentElement;
    expect(layout?.className).not.toMatch(/catalogLayoutManaged/);
    expect(screen.queryByText(/Selecione um cadastro para editar/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Editar Consulta" }));
    expect(layout?.className).toMatch(/catalogLayoutManaged/);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(layout?.className).not.toMatch(/catalogLayoutManaged/);
    expect(screen.getByRole("table")).toBe(table);
  });

  it("mantém o catálogo de consulta sem editor ou ações de escrita", async () => {
    mocks.manage = false;
    renderCatalog();
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: "Editar Consulta" })).toBeNull();
    expect(document.querySelector('[class*="catalogLayoutManaged"]')).toBeNull();
  });

  it("usa a largura do conteúdo e mantém um teto para não esticar o hub", () => {
    const css = read("styles/domains/shell-rail.css");
    expect(css).toMatch(/\.settings-main\s*\{[^}]*container:\s*settings \/ inline-size/);
    expect(css).toMatch(/\.settings-main\s*\{[^}]*max-width:\s*var\(--settings-content-max\)/);
    expect(css).toMatch(/\.settings-main \.settings-members-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(css).toContain("@container settings (min-width: 48rem)");
    expect(css).toContain(".settings-main .settings-roles-grid");
    expect(css).toContain(".settings-main .settings-humanization-grid");
    expect(css).toContain(".settings-main .pagehead > :first-child { flex: 1 1 auto; }");
    expect(css).toMatch(/\.settings-main \.pagehead\s*\{[^}]*align-items:\s*flex-start/);
    expect(css).toContain('.settings-main .responsive-table :is([data-label="Cor na agenda"], [data-label="Disponibilidade"]) .type-caption { white-space: nowrap; }');
    expect(css).toMatch(/\.settings-main \.responsive-table\s*\{[^}]*min-width:\s*0/);
  });

  it("não força largura mínima na tabela nem divide formulário pela viewport", () => {
    const css = read("components/settings-panels.module.css");
    expect(css).toMatch(/\.catalogTable\s*\{[^}]*min-width:\s*0/);
    expect(css).toContain("@container settings (min-width: 64rem)");
    expect(css).toContain("@container settings (min-width: 52rem)");
    expect(read("app/configuracoes/page.tsx")).toContain("className={styles.integrationGrid}");
  });
});
