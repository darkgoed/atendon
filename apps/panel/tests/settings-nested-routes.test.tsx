// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { type ComponentProps, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConfiguracoesLayout from "@/app/configuracoes/layout";
import ConfigPage from "@/app/configuracoes/page";

// Teste real de DOM (não teatro): renderiza o layout + SettingsSidebar
// de verdade; mocks só nas fronteiras de plataforma e de sessão —
// Shell (fornecedor de contexto/efeitos globais), roteador, Link, e
// permissões/capabilities/sessão /me (root) via SWR.

const { capabilitiesState, pathnameMock, rootSession } = vi.hoisted(() => ({
  capabilitiesState: { isLoading: false, enabled: true },
  pathnameMock: { current: "/configuracoes" },
  rootSession: {
    user: { id: "u1", email: "root@atendon.local", isRoot: true, name: "Root" },
    activeWorkspace: { id: "w1", name: "Matriz", slug: "matriz", status: "active", role: "ROOT" },
    workspaces: [],
    permissions: [],
    actorScope: "root" as const,
    rootWorkspaceAccess: true
  }
}));

vi.mock("@/components/shell", () => ({
  Shell: ({ children }: { children: ReactNode }) => <div data-testid="shell">{children}</div>
}));
vi.mock("next/navigation", () => ({ usePathname: () => pathnameMock.current }));
vi.mock("next/link", () => ({
  default: ({ href, className, children, ...rest }: ComponentProps<"a">) => (
    <a href={href} className={className} {...rest}>{children}</a>
  )
}));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => true }));
vi.mock("@/lib/capabilities", () => ({
  useCapabilities: () => ({ isEnabled: () => capabilitiesState.enabled, isLoading: capabilitiesState.isLoading })
}));
vi.mock("swr", () => ({
  default: (key: unknown) => (key === "/me" ? { data: rootSession } : { data: undefined })
}));

const FilhoA = () => <p>Filho A</p>;
const FilhoB = () => <p>Filho B</p>;
// Painel real não é o sujeito do teste: boundary mock (o gate de negação é da página).
vi.mock("@/components/google-calendar-settings", () => ({
  GoogleCalendarSettings: () => <p>Painel Google Agenda</p>
}));

afterEach(() => {
  cleanup();
});

describe("layout de Configurações: sidebar persistente nas sub-rotas", () => {
  it("a MESMA sidebar sobrevive à troca de rota/filho: mesmo nó de DOM, scrollTop e aria-current atualizado", () => {
    pathnameMock.current = "/configuracoes/categorias";
    const view = render(
      <ConfiguracoesLayout>
        <FilhoA />
      </ConfiguracoesLayout>
    );

    const navBefore = screen.getByRole("navigation", { name: "Configurações" });
    expect(screen.getByRole("link", { name: "Categorias" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Filho A")).toBeInTheDocument();

    navBefore.scrollTop = 42;

    // "Navegação" para /configuracoes/membros: filho B + pathname novo
    pathnameMock.current = "/configuracoes/membros";
    view.rerender(
      <ConfiguracoesLayout>
        <FilhoB />
      </ConfiguracoesLayout>
    );

    const navAfter = screen.getByRole("navigation", { name: "Configurações" });
    expect(navAfter).toBe(navBefore); // mesmo elemento DOM — sem remontagem
    expect(navAfter.scrollTop).toBe(42); // scroll preservado no mesmo nó
    expect(screen.getByText("Filho B")).toBeInTheDocument();
    expect(screen.queryByText("Filho A")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Membros" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Categorias" })).not.toHaveAttribute("aria-current");
  });

  it("hrefs apontam para as sub-rotas /configuracoes/* e aria-current volta à aba ativa", () => {
    pathnameMock.current = "/configuracoes/membros";
    const view = render(
      <ConfiguracoesLayout>
        <FilhoB />
      </ConfiguracoesLayout>
    );

    const membros = screen.getByRole("link", { name: "Membros" });
    expect(membros).toHaveAttribute("aria-current", "page");
    expect(membros).toHaveAttribute("href", "/configuracoes/membros");
    expect(screen.getByRole("link", { name: "Funções" })).toHaveAttribute("href", "/configuracoes/funcoes");
    expect(screen.getByRole("link", { name: "Auditoria" })).toHaveAttribute("href", "/configuracoes/auditoria");
    const categorias = screen.getByRole("link", { name: "Categorias" });
    expect(categorias).toHaveAttribute("href", "/configuracoes/categorias");
    expect(categorias).not.toHaveAttribute("aria-current");

    // de volta à aba de catálogo: Categorias é a rota ativa novamente
    pathnameMock.current = "/configuracoes/categorias";
    view.rerender(
      <ConfiguracoesLayout>
        <FilhoA />
      </ConfiguracoesLayout>
    );
    expect(screen.getByRole("link", { name: "Categorias" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Membros" })).not.toHaveAttribute("aria-current");
  });
});

describe("deep-link de configuração: negação só depois de capabilities carregarem", () => {
  it("bookmark /configuracoes/google-calendar sem capabilities: nada de 'Sem acesso'; após carregar, painel; negação definitiva continua", () => {
    // Estado do bug: /me já veio (permissões via usePermission), capabilities do
    // tenant em voo → isEnabled falha-fechado (false) disparava a negação falsa.
    pathnameMock.current = "/configuracoes/google-calendar";
    capabilitiesState.isLoading = true;
    capabilitiesState.enabled = false;

    const view = render(<ConfigPage />);
    expect(screen.queryByText("Sem acesso a esta configuração.")).not.toBeInTheDocument();

    // Query do tenant resolveu: agendamento habilitado → painel aparece.
    capabilitiesState.isLoading = false;
    capabilitiesState.enabled = true;
    view.rerender(<ConfigPage />);
    expect(screen.getByText("Painel Google Agenda")).toBeInTheDocument();
    expect(screen.queryByText("Sem acesso a esta configuração.")).not.toBeInTheDocument();

    // Negação DEFINITIVA (dado carregado, capability off) segue bloqueada.
    capabilitiesState.enabled = false;
    view.rerender(<ConfigPage />);
    expect(screen.getByText("Sem acesso a esta configuração.")).toBeInTheDocument();
    expect(screen.queryByText("Painel Google Agenda")).not.toBeInTheDocument();
  });
});
