// @vitest-environment jsdom

// Fundação visual, Configurações/Geral: só o card Geral usa a largura de leitura de
// formulário (token global --content-form-max = 48rem). Catálogos, tabelas e os demais
// painéis seguem em largura cheia. O jsdom não calcula layout, então a largura é provada
// pelo contrato CSS (fonte) somado à classe aplicada no DOM; a medição em pixels fica com
// a auditoria visual. Com CSS Modules, o vitest devolve um proxy (`styles.qualquer` vira
// `_qualquer_<hash>`), por isso o DOM sozinho não prova que a regra existe: o bloco
// "contrato CSS" cobre isso.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConfigPage from "@/app/configuracoes/page";
import styles from "@/components/settings-panels.module.css";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
const permission = vi.hoisted(() => ({ granted: true }));
vi.mock("@/lib/api", () => ({ api: mocks.api }));
vi.mock("@/lib/capabilities", () => ({ useCapabilities: () => ({ isEnabled: () => true, isLoading: false }) }));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => permission.granted }));

const workspace = { id: "w-1", name: "Acme", slug: "acme", status: "active", role: "OWNER", logo_data: null };
const session = {
  user: { id: "u-1", email: "owner@example.com", isRoot: false, name: "Owner" },
  activeWorkspace: workspace,
  workspaces: [workspace],
  permissions: ["workspace.update"],
  actorScope: "workspace"
};
const timezoneResponse = {
  workspace: { id: "w-1", name: "Acme", timezone: "America/Sao_Paulo", business_hours_start: "08:00:00", business_hours_end: "18:00:00" }
};
const patchedResponse = {
  workspace: { id: "w-1", name: "Acme", timezone: "America/Recife", business_hours_start: "09:30:00", business_hours_end: "17:45:00" }
};

function mockApi(timezoneGet: () => Promise<unknown> = async () => timezoneResponse) {
  mocks.api.mockReset();
  mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/me") return session;
    if (path === "/workspaces/current/timezone") return method === "PATCH" ? patchedResponse : timezoneGet();
    if (path === "/scheduling/config/categorias") return { categorias: [{ id: "consulta", nome: "Consulta" }] };
    throw new Error(`URL inesperada: ${path} ${method}`);
  });
}

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ConfigPage />
    </SWRConfig>
  );
}

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const css = read("components/settings-panels.module.css");
const page = read("app/configuracoes/page.tsx");

// Corpo de uma regra de primeiro nível (`.seletor { ... }`); falha com mensagem clara se ausente.
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[\\s}])${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`regra ${selector} ausente em settings-panels.module.css`);
  return match[1];
}

function panelSection(headId: string) {
  return document.querySelector(`section[aria-labelledby="${headId}"]`);
}

afterEach(() => {
  cleanup();
  window.history.pushState({}, "", "/");
  permission.granted = true;
});

describe("Configurações/Geral: largura de formulário só no card Geral (DOM)", () => {
  beforeEach(() => mockApi());

  it("o card Geral carregado opta pela classe de largura de formulário", async () => {
    renderPage();
    await screen.findByText("Fuso horário");
    const panel = panelSection("settings-workspace");
    expect(panel).not.toBeNull();
    // Classes anteriores intactas, na mesma ordem, mais só a de largura.
    expect(panel?.className).toBe(`card ${styles.panel} ${styles.panelForm}`);
  });

  it("o esqueleto de carregamento do Geral tem a mesma largura do card carregado", async () => {
    mockApi(() => new Promise(() => {}));
    renderPage();
    const skeleton = await screen.findByLabelText("Carregando configurações gerais");
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(skeleton.closest("section")?.className).toMatch(/panelForm/);
  });

  it("sem workspace.update o card Geral não renderiza (a classe não contorna a permissão)", async () => {
    permission.granted = false;
    window.history.pushState({}, "", "/configuracoes/workspace");
    renderPage();
    await screen.findByText("Sem acesso a esta configuração.");
    expect(panelSection("settings-workspace")).toBeNull();
    expect(document.querySelector('[class*="panelForm"]')).toBeNull();
  });

  it("o catálogo e sua tabela ficam em largura cheia, sem ancestral com a largura de formulário", async () => {
    window.history.pushState({}, "", "/configuracoes/categorias");
    renderPage();
    const table = await screen.findByRole("table");
    const panel = panelSection("settings-catalog");
    expect(panel).not.toBeNull();
    // Classe idêntica à de antes da mudança: o chassi sem className não ganha nada.
    expect(panel?.className).toBe(`card ${styles.panel}`);
    expect(table.className).toMatch(/catalogTable/);
    expect(table.closest('[class*="panelForm"]')).toBeNull();
  });
});

describe("Configurações/Geral: comportamento preservado (fuso e horário de atendimento)", () => {
  beforeEach(() => mockApi());

  it("carrega os valores, salva via PATCH com os mesmos campos e confirma", async () => {
    renderPage();
    const timezone = await screen.findByLabelText(/Fuso IANA/);
    await waitFor(() => expect(timezone).toHaveValue("America/Sao_Paulo"));
    expect(screen.getByLabelText("Início")).toHaveValue("08:00");
    expect(screen.getByLabelText("Fim")).toHaveValue("18:00");

    fireEvent.change(timezone, { target: { value: " America/Recife " } });
    fireEvent.change(screen.getByLabelText("Início"), { target: { value: "09:30" } });
    fireEvent.change(screen.getByLabelText("Fim"), { target: { value: "17:45" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await screen.findByText("Fuso horário salvo.");
    const patch = mocks.api.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
    expect(patch?.[0]).toBe("/workspaces/current/timezone");
    expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({
      timezone: "America/Recife",
      business_hours_start: "09:30",
      business_hours_end: "17:45"
    });
  });

  it("bloqueia o salvamento com o fuso em branco", async () => {
    renderPage();
    const timezone = await screen.findByLabelText(/Fuso IANA/);
    await waitFor(() => expect(timezone).toHaveValue("America/Sao_Paulo"));
    fireEvent.change(timezone, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
  });
});

describe("Configurações/Geral: escopo no código-fonte", () => {
  it("PanelChassi ganha className opcional e só WorkspaceSettingsPanel opta (skeleton e card)", () => {
    const chassiStart = page.indexOf("function PanelChassi(");
    const chassiEnd = page.indexOf("export default function ConfigPage");
    expect(chassiStart).toBeGreaterThan(-1);
    expect(page.slice(chassiStart, chassiEnd)).toMatch(/className\?: string/);

    const start = page.indexOf("function WorkspaceSettingsPanel(");
    expect(start).toBeGreaterThan(-1);
    const rest = page.slice(start + 1);
    const end = start + 1 + rest.search(/\n(?:export default |export )?(?:function|type|const) /);
    expect(end).toBeGreaterThan(start);

    // Só o JSX conta: o comentário do chassi também cita o nome da classe.
    expect(page.match(/className=\{styles\.panelForm\}/g)).toHaveLength(2);
    expect(page.slice(start, end).match(/<PanelChassi[^>]*className=\{styles\.panelForm\}/g)).toHaveLength(2);
  });

  it("membros e os demais consumidores do CSS compartilhado não optam pela largura de formulário", () => {
    // Membros não importam o módulo compartilhado: a tabela não tem caminho até .panelForm.
    for (const file of ["app/configuracoes/membros/page.tsx", "app/workspace/members/content.tsx"]) {
      expect(read(file), file).not.toMatch(/settings-panels\.module\.css|panelForm|content-form-max/);
    }
    for (const file of [
      "app/perfil/page.tsx",
      "app/humanizacao/settings-content.tsx",
      "components/web-push-settings.tsx",
      "components/pipeline-settings.tsx",
      "components/tag-catalog-settings.tsx"
    ]) {
      expect(read(file), file).not.toMatch(/panelForm|content-form-max/);
    }
  });
});

describe("Configurações/Geral: contrato CSS", () => {
  it(".panelForm limita só a largura com o token global e não o redefine", () => {
    const declarations = rule(".panelForm").split(";").map((item) => item.trim()).filter(Boolean);
    expect(declarations).toContain("max-width: var(--content-form-max)");
    for (const declaration of declarations) {
      expect(["max-width: var(--content-form-max)", "width: 100%"]).toContain(declaration);
    }
    expect(css).not.toMatch(/--content-form-max\s*:/);
  });

  it.each([".form", ".soundGrid"])("%s usa o token no lugar do 48rem fixo", (selector) => {
    expect(rule(selector)).toMatch(/max-width:\s*var\(--content-form-max\)\s*;/);
  });

  it("não sobra max-width: 48rem fixo; o breakpoint @media continua igual", () => {
    expect(css).not.toMatch(/max-width:\s*48rem\s*;/);
    expect(css).toMatch(/@media \(max-width: 48rem\) \{/);
  });

  it("chassi base, catálogos e tabelas não ganham teto de largura", () => {
    for (const selector of [".panel", ".catalogLayout", ".catalogLayoutManaged", ".catalogTable", ".editorPlaceholder"]) {
      expect(rule(selector), selector).not.toMatch(/max-width/);
    }
  });
});

// Dependência do worker de tokens: sem o token, `var(--content-form-max)` é inválido em
// tempo de computação e o max-width vira `none` (forms e Geral sem limite). Falha aqui
// significa token ainda não entregue em styles/tokens.css, não defeito do painel.
describe("Dependência: token global --content-form-max (dono: worker de tokens)", () => {
  it("algum CSS em styles/ ou app/globals.css declara --content-form-max: 48rem", () => {
    const files = (readdirSync(resolve(process.cwd(), "styles"), { recursive: true }) as string[])
      .filter((file) => file.endsWith(".css"))
      .map((file) => join("styles", file))
      .concat("app/globals.css");
    const declaring = files.filter((file) => /--content-form-max:\s*48rem\s*;/.test(read(file)));
    expect(declaring.length).toBeGreaterThan(0);
  });
});
