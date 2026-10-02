// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { api, push, permission } = vi.hoisted(() => ({ api: vi.fn(), push: vi.fn(), permission: { reply: true } }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/api")>(), api }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/use-permission", () => ({ usePermission: (key: string) => key === "conversations.reply" && permission.reply }));
vi.mock("@/lib/organization", () => ({ useCaseOrganizationEnabled: () => false, applyLeadSavedViewFilters: (current: unknown) => current, leadFiltersForSavedView: (filters: unknown) => filters }));
vi.mock("@/lib/realtime", () => ({ useRealtimeSignals: () => undefined }));
vi.mock("@/lib/capabilities", () => ({ useCapabilities: () => ({ isEnabled: () => false }) }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/saved-views-control", () => ({ SavedViewsControl: () => null }));
vi.mock("@/components/tag-catalog-settings", () => ({ TagCatalogSettings: () => null }));
vi.mock("@/components/bulk-lead-actions", () => ({ BulkLeadActions: () => null }));
vi.mock("@/components/lead-tag-picker", () => ({ LeadTagChips: () => null, LeadTagMenuItems: () => null }));

import LeadsPage from "../app/contatos/page";
import Conversations from "../app/conversas/page";

const leads = [
  { id: "lead-ana", telefone: "5511999990001", nome: "Ana", status: "novo", atualizado_em: "2026-01-01T12:00:00Z" },
  { id: "lead-bia", telefone: "5511999990002", nome: "Bia", status: "novo", atualizado_em: "2026-01-01T12:00:00Z" },
  { id: "lead-linked", telefone: "5511999990003", nome: "Clara", conversation_id: "existing/conv", status: "novo", atualizado_em: "2026-01-01T12:00:00Z" }
];
const session = { user: { id: "user-1", email: "agent@example.com", isRoot: false }, activeWorkspace: { id: "workspace-1", role: "ADMIN" }, permissions: ["conversations.reply"], actorScope: "workspace" };

function renderPage(page: ReactNode) {
  return render(<SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>{page}</SWRConfig>);
}

beforeEach(() => {
  permission.reply = true;
  push.mockReset();
  api.mockReset();
  window.history.replaceState({}, "", "/conversas");
  HTMLElement.prototype.scrollTo = vi.fn();
  api.mockImplementation(async (path: string) => {
    if (path === "/me") return session;
    if (path.startsWith("/scheduling/leads?")) return { leads, total: leads.length };
    if (path === "/scheduling/config/unidades") return { unidades: [] };
    if (path === "/scheduling/config/categorias") return { categorias: [] };
    if (path === "/scheduling/config/parceiros") return { parceiros: [] };
    if (path === "/connections") return { connections: [{ id: "conn-1", label: "Principal", channel: "whatsapp", status: "connected" }] };
    if (path === "/conversations/initiate") return { conversation_id: "created/conv?1" };
    if (path.startsWith("/conversations?")) return { conversations: [] };
    if (path === "/conversations/assignees") return { assignees: [] };
    if (path === "/conversations/unread-counts") return { human: 0, ai: 0, scheduled: 0, resolved: 0 };
    if (path === "/me/notification-preferences") return { muted_conversations: [] };
    if (path === "/feature-flags") return { flags: {} };
    if (path === "/teams") return { teams: [] };
    throw new Error(`Endpoint inesperado: ${path}`);
  });
});
afterEach(cleanup);

describe("início de conversa pelos contatos", () => {
  it("abre um único modal fora da tabela com o destinatário clicado e inicia pelo endpoint existente", async () => {
    renderPage(<LeadsPage />);
    const biaRow = (await screen.findByText("Bia")).closest("tr")!;
    fireEvent.click(within(biaRow).getByRole("button", { name: "Entrar em contato" }));
    const dialog = await screen.findByRole("dialog", { name: "Nova conversa" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(dialog.closest("table")).toBeNull();
    expect(within(dialog).getByRole("status")).toHaveTextContent("Contato selecionado: Bia · 5511999990002");
    expect(within(dialog).getByRole("status")).not.toHaveTextContent("Ana");
    const message = within(dialog).getByRole("textbox", { name: /Primeira mensagem/ });
    fireEvent.change(message, { target: { value: "Olá, Bia!" } });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Iniciar conversa" })).toBeEnabled());
    fireEvent.submit(message.closest("form")!);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/conversas?id=created%2Fconv%3F1"));
    const call = api.mock.calls.find(([path]) => path === "/conversations/initiate")!;
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body)).toEqual({ lead_id: "lead-bia", session_id: "conn-1", text: "Olá, Bia!" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(within(screen.getByText("Ana").closest("tr")!).getByRole("button", { name: "Entrar em contato" }));
    const reopened = await screen.findByRole("dialog", { name: "Nova conversa" });
    expect(within(reopened).getByRole("status")).toHaveTextContent("Contato selecionado: Ana · 5511999990001");
    expect(within(reopened).getByRole("status")).not.toHaveTextContent("Bia");
  });

  it("sem conversations.reply oculta início e modal, preservando a conversa existente", async () => {
    permission.reply = false;
    renderPage(<LeadsPage />);
    await screen.findByText("Ana");
    expect(screen.queryByRole("button", { name: "Entrar em contato" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("link", { name: "Conversar com Clara pelo WhatsApp" })).toHaveAttribute("href", "/conversas?id=existing%2Fconv");
  });
});

describe("ação de composição na lista de conversas", () => {
  it("renderiza só ícone quiet no fim da linha de busca e abre o modal", async () => {
    renderPage(<Conversations />);
    const button = await screen.findByRole("button", { name: "Nova conversa" });
    const row = screen.getByTestId("conversation-list-filters");
    expect(button.parentElement).toBe(row);
    expect(Array.from(row.children).filter((child) => !child.hasAttribute("hidden")).at(-1)).toBe(button);
    expect(button.previousElementSibling).toHaveAttribute("role", "group");
    expect(button).toHaveClass("icon-button", "quiet");
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).toBeTruthy();
    expect(button.closest(".conversation-list__title")).toBeNull();
    fireEvent.click(button);
    expect(await screen.findByRole("dialog", { name: "Nova conversa" })).toBeInTheDocument();
  });

  it("não oferece composição sem conversations.reply", async () => {
    permission.reply = false;
    renderPage(<Conversations />);
    await screen.findByText(/Nenhuma conversa neste filtro/);
    expect(screen.queryByRole("button", { name: "Nova conversa" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
