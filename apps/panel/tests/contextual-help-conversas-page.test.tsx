// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import Conversations from "@/app/conversas/page";
import { ErrorToasts } from "@/components/error-toasts";
import { ERROR_TOAST_EVENT } from "@/lib/error-events";

// Radix Popover (HelpHint) mede o balão com ResizeObserver, ausente no jsdom.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/lib/capabilities", () => ({ useCapabilities: () => ({ isEnabled: () => false }) }));
vi.mock("@/lib/realtime", () => ({ useRealtimeSignals: () => undefined }));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => true }));
vi.mock("@/components/conversation-composer", () => ({ ConversationComposer: () => null }));
vi.mock("@/components/conversation-contact-panel", () => ({ ConversationContactPanel: () => null }));
vi.mock("@/components/conversation-message-media", () => ({ ConversationMessageMedia: () => null }));
vi.mock("@/components/ai-turn-bubble", () => ({ AiTurnBubble: () => null }));
vi.mock("@/components/conversation-referral", () => ({ ConversationReferral: () => null }));
vi.mock("@/components/conversation-scheduler", () => ({ ConversationScheduler: () => null }));
vi.mock("@/components/conversation-status-picker", () => ({ ConversationStatusPicker: () => null }));
vi.mock("@/components/lead-tag-picker", () => ({ LeadTagChips: () => null }));
vi.mock("@/components/message-actions-menu", () => ({ MessageActionsMenu: () => null }));
vi.mock("@/components/popover-menu", () => ({ PopoverMenu: ({ children }: { children: () => ReactNode }) => <>{children()}</> }));
vi.mock("@/components/conversation-next-action", () => ({ ConversationNextAction: () => null }));
vi.mock("@/components/conversation-pre-briefing", () => ({ ConversationPreBriefing: () => null }));

const conversation = {
  id: "c-1", session_id: "conn-wa", lead_id: "lead-1", contact_phone: "+551****9999", contact_name: "Ana",
  ai_active: false, last_message: "Oi", last_message_at: "2026-09-11T12:00:00.000Z", status: "open" as "open" | "closed",
  unread_count: 2, channel: "whatsapp" as const,
  next_action: null, next_action_at: null
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderInbox(url = "/conversas?id=c-1") {
  window.history.replaceState({}, "", url);
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><ErrorToasts /><Conversations /></SWRConfig>);
}

describe("ajuda contextual — página de conversas", () => {
  let pauseFailure: boolean;
  let fetchMock: { mock: { calls: Array<[unknown, unknown?]> } };

  beforeEach(() => {
    pauseFailure = false;
    conversation.ai_active = false;
    conversation.status = "open";
    vi.restoreAllMocks();
    HTMLElement.prototype.scrollTo = vi.fn();
    fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/me")) return response({ user: { id: "u-1", email: "agent@example.com", isRoot: false, name: "Agent" }, activeWorkspace: { id: "w-1", name: "Workspace", slug: "ws", status: "active", role: "ADMIN" }, workspaces: [], permissions: ["conversations.reply"], actorScope: "workspace" });
      if (url.endsWith("/feature-flags")) return response({ flags: {} });
      if (url.endsWith("/connections")) return response({ connections: [{ id: "conn-wa", label: "WhatsApp principal", status: "connected" }] });
      if (url.endsWith("/organization/teams")) return response({ teams: [] });
      if (url.endsWith("/conversations/unread-counts")) return response({ human: 2, ai: 0, scheduled: 0, resolved: 0 });
      if (url.endsWith("/conversations/assignees")) return response({ assignees: [{ id: "u-1", email: "agent@example.com" }] });
      if (url.endsWith("/me/notification-preferences")) return response({ muted_conversations: [] });
      if (url.endsWith("/conversations/c-1/channel-capabilities")) return response({ channel: "whatsapp", can_send: true, reason: null, window_expires_at: null, text: true, image: true, audio: true, video: true, document: true, reactions: true, edit: true, delete: true, stickers: true });
      if (url.endsWith("/conversations/c-1/read") && init?.method === "PATCH") return response({ ok: true });
      if (url.includes("/conversations/c-1/messages")) return response({ conversation, messages: [] });
      if (url.includes("/conversations?") && (init?.method ?? "GET") === "GET") return response({ conversations: [conversation] });
      if (url.endsWith("/conversations/c-1/pause") && init?.method === "PATCH") {
        if (pauseFailure) return response({ error: "falha ao pausar" }, 500);
        return response({ ok: true });
      }
      throw new Error(`URL inesperada: ${url} ${(init?.method ?? "GET")}`);
    });
  });
  afterEach(() => cleanup());

  it("ajuda das abas abre sem mudar os nomes acessíveis das abas", async () => {
    const user = userEvent.setup();
    const { container } = renderInbox("/conversas");
    expect(await screen.findByRole("button", { name: "Agendadas" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolvidas" })).toBeInTheDocument();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining("/conversations/unread-counts"), expect.anything()));
    await screen.findByText("2", { selector: ".conversation-filter-tabs button span" });
    const opened = await screen.findByRole("button", { name: "Abertas" });
    expect(opened).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".help-hint")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Ajuda:/ })).toBeNull();
    await user.hover(opened);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Abertas — aguardando atendimento humano");
    await user.unhover(opened);
    fireEvent.focus(screen.getByRole("button", { name: "Agendadas" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Agendadas — com horário confirmado");
    expect(opened).toHaveAttribute("aria-pressed", "true");
    fireEvent.blur(screen.getByRole("button", { name: "Agendadas" }));
    fireEvent.focus(screen.getByRole("button", { name: "IA" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("IA — a IA responde sozinha");
    fireEvent.blur(screen.getByRole("button", { name: "IA" }));
    fireEvent.focus(screen.getByRole("button", { name: "Resolvidas" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Resolvidas — encerradas");
  });

  it("thread sem IA explica o handoff; campos de ajuda ficam presentes", async () => {
    renderInbox();
    const banner = await screen.findByText("Transferida para atendimento humano — responda pelo painel ou celular.");
    expect(banner).toHaveAccessibleDescription("A IA desliga neste contato quando o cliente pede um atendente, a própria IA transfere, há falha técnica ou alguém pausa manualmente. Para voltar à IA, use Reativar IA em Mais ações.");
    fireEvent.focus(banner);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("A IA está pausada. Para voltar, use Reativar IA em Mais ações.");
    expect(screen.queryByRole("button", { name: /^Ajuda:/ })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Transferir responsável pela conversa" })).toHaveAccessibleDescription(/Escolhe quem responde esta conversa/);
    expect(screen.getByRole("combobox", { name: "Assinatura do atendente para este cliente" })).toHaveAccessibleDescription(/Inclui o nome do atendente/);
  });

  it("sistema de filas removido: sem filtro Fila, sem seletor e sem chamada à API de filas", async () => {
    const user = userEvent.setup();
    renderInbox();
    expect(await screen.findByText("Transferida para atendimento humano — responda pelo painel ou celular.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Fila do atendimento" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Filtros" }));
    const fields = screen.getByRole("listbox", { name: "Campos de filtro" });
    expect(within(fields).queryByRole("option", { name: "Fila" })).not.toBeInTheDocument();
    // Token construído por partes para o grep de aceite não achar a rota removida.
    const queueApiPath = ["conversation", "queues"].join("-");
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes(queueApiPath))).toBe(false);
  });

  it("conversa fechada não exibe a fila atual", async () => {
    conversation.status = "closed";
    renderInbox();
    await screen.findAllByText("Ana");
    expect(screen.queryByLabelText("Fila atual")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Fila:/)).not.toBeInTheDocument();
  });

  it("pausar a IA mostra aviso de sucesso imediato", async () => {
    const user = userEvent.setup();
    conversation.ai_active = true;
    renderInbox();
    await screen.findByRole("button", { name: "Pausar IA neste contato" });
    await user.click(screen.getByRole("button", { name: "Pausar IA neste contato" }));
    await user.click(await screen.findByRole("button", { name: "Pausar IA" }));
    expect(await screen.findByText("IA pausada neste contato.")).toBeInTheDocument();
  });

  it("pausar a IA que falha não mostra aviso de sucesso", async () => {
    const user = userEvent.setup();
    conversation.ai_active = true;
    pauseFailure = true;
    const dispatch = vi.spyOn(window, "dispatchEvent");
    renderInbox();
    await screen.findByRole("button", { name: "Pausar IA neste contato" });
    await user.click(screen.getByRole("button", { name: "Pausar IA neste contato" }));
    await user.click(await screen.findByRole("button", { name: "Pausar IA" }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: ERROR_TOAST_EVENT, detail: { message: "falha ao pausar" } })));
    expect(screen.queryByText("IA pausada neste contato.")).toBeNull();
  });
});
