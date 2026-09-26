// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { AgendaCalendar } from "@/app/agenda/agenda-calendar";
import { AgendaHeader } from "@/app/agenda/agenda-header";
import { ModeBar } from "@/components/ui";
import { workspaceRoleLabel } from "@/lib/labels";

afterEach(cleanup);

const ws = (id: string, name: string, role = "OWNER") => ({ id, name, slug: id, status: "active", role });

describe("ajuda contextual — seletor de empresa", () => {
  it("traduz a função e explica a ação no nome acessível", () => {
    render(<WorkspaceSwitcher workspaces={[ws("a", "Acme"), ws("b", "Beta", "ADMIN")]} activeWorkspaceId="a" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Empresa atual: Acme \(Proprietário\)\. Trocar de empresa/ });
    expect(trigger).toHaveTextContent("Proprietário");
    expect(trigger).not.toHaveTextContent("OWNER");
  });

  it("navega por teclado, marca a atual e devolve o foco ao fechar com Esc", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<WorkspaceSwitcher workspaces={[ws("a", "Acme"), ws("b", "Beta", "ADMIN")]} activeWorkspaceId="a" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /Trocar de empresa/ });
    await user.click(trigger);
    const [acme, beta] = screen.getAllByRole("option");
    expect(acme).toHaveFocus();
    expect(acme).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}");
    expect(beta).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("não dispara troca ao escolher a empresa atual; troca e mostra progresso para outra", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<WorkspaceSwitcher workspaces={[ws("a", "Acme"), ws("b", "Beta")]} activeWorkspaceId="a" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /Trocar de empresa/ }));
    await user.click(screen.getByRole("option", { name: /Acme/ }));
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Trocar de empresa/ }));
    await user.click(screen.getByRole("option", { name: /Beta/ }));
    expect(onChange).toHaveBeenCalledWith("b");
    rerender(<WorkspaceSwitcher workspaces={[ws("a", "Acme"), ws("b", "Beta")]} activeWorkspaceId="a" disabled onChange={onChange} />);
    const busy = screen.getByRole("button", { name: "Trocando para Beta…" });
    expect(busy).toHaveAttribute("aria-busy", "true");
  });

  it("filtra por nome (sem acento) quando há muitas empresas", async () => {
    const user = userEvent.setup();
    const many = ["Ágil", "Beta", "Cora", "Delta", "Echo", "Foxtrot", "Golf"].map((name, i) => ws(`w${i}`, name));
    render(<WorkspaceSwitcher workspaces={many} activeWorkspaceId="w0" onChange={() => {}} />);
    await user.click(screen.getByRole("button", { name: /Trocar de empresa/ }));
    const search = screen.getByRole("searchbox", { name: "Buscar empresa" });
    expect(search).toHaveFocus();
    await user.type(search, "agil");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.clear(search);
    await user.type(search, "zzz");
    expect(screen.getByText("Nenhuma empresa encontrada.")).toBeInTheDocument();
  });

  it("mantém nomes de funções personalizadas", () => {
    expect(workspaceRoleLabel("OPERADOR")).toBe("Operador");
    expect(workspaceRoleLabel("Closer sênior")).toBe("Closer sênior");
    expect(workspaceRoleLabel(null)).toBe("Sem função");
  });
});

describe("ajuda contextual — agenda", () => {
  const day = new Date("2026-01-01T00:00:00Z");
  const slot = { start: "2026-01-01T09:00:00Z", end: "2026-01-01T10:00:00Z", vagas: 1, capacidade: 1 };
  const base = { days: [day], today: "2026-01-01", timezone: "UTC", failedDays: [], now: 0, dragging: "", reschedulingId: "", pendingActionId: "", canReschedule: false, canCreate: true, timeGrid: { byDay: new Map([["2026-01-01", new Map([["09:00", slot]])]]), appointmentsByDay: new Map(), labels: ["09:00"] }, onDrag: () => undefined, onDrop: () => undefined, onCreate: () => undefined, onOpen: () => undefined };

  it("pré-visualiza o que o clique no horário livre vai fazer", () => {
    const onSelectSlot = vi.fn();
    const { container } = render(<AgendaCalendar {...base} onSelectSlot={onSelectSlot} />);
    const cell = screen.getByRole("button", { name: /Agendar às 09:00/ });
    expect(container.querySelector(".agenda-cell__preview")).toHaveTextContent("Agendar às 09:00");
    fireEvent.click(cell);
    expect(onSelectSlot).toHaveBeenCalledWith(slot);
  });

  it("no modo bloqueio a prévia vira 'Bloquear' e vale mesmo sem permissão de agendar", () => {
    render(<AgendaCalendar {...base} canCreate={false} blockMode onSelectSlot={() => undefined} />);
    expect(screen.getByRole("button", { name: /Bloquear 09:00 – 10:00/ })).toBeInTheDocument();
    expect(document.querySelector(".agenda-grid--blocking")).not.toBeNull();
  });

  it("o botão do cabeçalho alterna entre entrar e sair do modo bloqueio", () => {
    const props = { canCreate: true, canBlock: true, unit: "u", mode: "week" as const, view: "all" as const, pendingCount: 0, onCreate: () => undefined, onBlock: () => undefined, onMode: () => undefined, onView: () => undefined };
    const { rerender } = render(<AgendaHeader {...props} />);
    expect(screen.getByRole("button", { name: "Bloquear horário" })).toHaveAttribute("aria-pressed", "false");
    rerender(<AgendaHeader {...props} blocking />);
    expect(screen.getByRole("button", { name: "Cancelar bloqueio" })).toHaveAttribute("aria-pressed", "true");
  });

  it("indicador de modo anuncia o modo e oferece saída", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<ModeBar live title="Clique em um horário livre para bloquear" description="Dias fechados não podem ser bloqueados." onCancel={onCancel} />);
    expect(screen.getByRole("status")).toHaveTextContent("Clique em um horário livre para bloquear");
    await user.click(screen.getByRole("button", { name: /Cancelar/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
