// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { ContactChatLink } from "../components/contact-chat-link";
import { ListFiltersBar, type ListFilterDef } from "../components/ui/filters";

type Filters = { status: string; origem: string; period_start: string };

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) => <a {...props}>{children}</a> }));
vi.mock("@phosphor-icons/react", () => ({
  Funnel: () => null,
  MagnifyingGlass: () => null,
  WhatsappLogo: () => null,
  X: () => null
}));

afterEach(cleanup);

describe("ContactChatLink (ícone de WhatsApp dos contatos)", () => {
  it("abre a conversa do contato e não renderiza nada sem conversa", () => {
    const { container: empty } = render(<ContactChatLink conversationId={null} name="Ana" />);
    expect(empty).toBeEmptyDOMElement();
    render(<ContactChatLink conversationId="conv-1" name="Ana" />);
    const link = screen.getByRole("link", { name: "Conversar com Ana pelo WhatsApp" });
    expect(link).toHaveAttribute("href", "/conversas?id=conv-1");
  });
});

describe("ListFiltersBar (padrão único de filtro)", () => {
  const defs: Array<ListFilterDef<Filters>> = [
    { key: "status", label: "Status", kind: "option", options: [{ id: "novo", nome: "Novo" }] },
    { key: "origem", label: "Origem", kind: "text", operator: "contém" },
    { key: "period_start", label: "Período inicial", kind: "date", operator: "depois de" }
  ];

  it("renders chips with label, operator and value for active filters, plus Limpar", () => {
    const onSet = vi.fn();
    const onClearAll = vi.fn();
    render(
      <ListFiltersBar<Filters>
        filters={{ status: "novo", origem: "Instagram", period_start: "" }}
        defs={defs}
        onSet={onSet}
        onClearAll={onClearAll}
      />
    );
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Novo")).toBeInTheDocument();
    expect(screen.getByText("Origem")).toBeInTheDocument();
    expect(screen.getByText("contém")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remover filtro Status" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Limpar" }));
    expect(onClearAll).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remover filtro Status" }));
    expect(onSet).toHaveBeenCalledWith("status", "");
  });

  it("does not render Limpar when no filter is active", () => {
    render(
      <ListFiltersBar<Filters>
        filters={{ status: "", origem: "", period_start: "" }}
        defs={defs}
        onSet={vi.fn()}
        onClearAll={vi.fn()}
      />
    );
    expect(screen.queryByRole("button", { name: "Limpar" })).not.toBeInTheDocument();
  });
});
