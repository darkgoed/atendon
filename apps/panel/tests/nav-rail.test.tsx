// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NavRail,
  railPrimaryHrefs,
  splitRailItems,
  type RailMenuItem
} from "@/components/nav-rail";

afterEach(cleanup);

const StubIcon = (props: { size?: number; "aria-hidden"?: boolean }) => (
  <span data-testid="rail-icon" aria-hidden={props["aria-hidden"]} />
);

const item = (href: string, group: string): RailMenuItem => ({
  href,
  label: `Label ${href}`,
  group,
  Icon: StubIcon
});

describe("splitRailItems", () => {
  it("ordena os primários na ordem da SPEC e ignora hrefs ausentes", () => {
    const menu: RailMenuItem[] = [
      item("/agenda", "Atendimento"),
      item("/conversas", "Atendimento"),
      item("/", "Atendimento")
    ];
    const result = splitRailItems(menu);
    expect(result.primary.map((entry) => entry.href)).toEqual([
      "/",
      "/conversas",
      "/agenda"
    ]);
  });

  it("agrupa o resto no popover seguindo a ordem dos grupos do manifest, sem duplicar primários", () => {
    const menu: RailMenuItem[] = [
      item("/conversas", "Atendimento"),
      item("/pipeline", "Atendimento"),
      item("/contatos", "Atendimento"),
      item("/pos-venda", "Pós-venda"),
      item("/pos-venda/configurar", "Pós-venda"),
      item("/tripz-ai", "Copiloto"),
      item("/uso", "Administração"),
      item("/root/workspaces", "ROOT")
    ];
    const result = splitRailItems(menu);
    expect(result.primary.map((entry) => entry.href)).toEqual([
      "/conversas",
      "/contatos",
      "/pipeline"
    ]);
    const groupLabels = result.more.map((group) => group.label);
    expect(groupLabels).toEqual(["Pós-venda", "Copiloto", "Administração", "ROOT"]);
    const moreHrefs = result.more.flatMap((group) => group.items.map((entry) => entry.href));
    expect(moreHrefs).toEqual(["/pos-venda", "/pos-venda/configurar", "/tripz-ai", "/uso", "/root/workspaces"]);
    expect(moreHrefs.some((href) => (railPrimaryHrefs as readonly string[]).includes(href))).toBe(false);
    expect(result.more.some((group) => group.label === "Atendimento")).toBe(false);
  });

  it("descarta grupos vazios do popover", () => {
    const result = splitRailItems([item("/conversas", "Atendimento")]);
    expect(result.primary.map((entry) => entry.href)).toEqual(["/conversas"]);
    expect(result.more).toEqual([]);
  });
});

describe("NavRail", () => {
  const baseProps = {
    items: [
      { href: "/", label: "Visão geral", active: false },
      { href: "/conversas", label: "Conversas", active: true, count: 3 }
    ],
    moreGroups: [
      {
        label: "Pós-venda",
        items: [{ href: "/pos-venda", label: "Carteira", Icon: StubIcon, active: false }]
      }
    ],
    onOpenPalette: vi.fn(),
    onLogout: vi.fn(),
    availability: { available: true, pending: false, onToggle: vi.fn() }
  };

  it("veste os primários com aria-label/aria-current e contador de handoff", () => {
    render(<NavRail {...baseProps} />);
    const overview = screen.getByRole("link", { name: "Visão geral" });
    expect(overview.getAttribute("aria-current")).toBeNull();
    const conversations = screen.getByRole("link", { name: "Conversas" });
    expect(conversations.getAttribute("aria-current")).toBe("page");
    expect(within(conversations).getByText("3")).toBeTruthy();
  });

  it("expõe o trigger 'mais' e abre o popover com os grupos do manifest", async () => {
    const user = userEvent.setup();
    render(<NavRail {...baseProps} />);
    await user.click(screen.getByRole("button", { name: "Mais itens do menu" }));
    const panel = await screen.findByText("Pós-venda");
    expect(panel).toBeTruthy();
    expect(screen.getByRole("link", { name: "Carteira" })).toBeTruthy();
  });

  it("mantém o rodapé de sessão (tema, perfil, sair) e dispara logout", async () => {
    const user = userEvent.setup();
    render(<NavRail {...baseProps} />);
    expect(screen.getByRole("button", { name: "Sair" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Buscar página (Ctrl+K)" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Sair" }));
    expect(baseProps.onLogout).toHaveBeenCalledTimes(1);
  });

  it("não renderiza o popover quando não há grupos restantes", () => {
    render(<NavRail {...baseProps} moreGroups={[]} />);
    expect(screen.queryByRole("button", { name: "Mais itens do menu" })).toBeNull();
  });
});
