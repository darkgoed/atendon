// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React, { type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import Conversations from "@/app/conversas/page";

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
  ai_active: false, last_message: "Oi", last_message_at: "2026-09-11T12:00:00.000Z", status: "open" as const,
  unread_count: 2, queue_id: "q-new", queue_name: "Novo contato", channel: "whatsapp" as const,
  next_action: null, next_action_at: null
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderInbox(url = "/conversas?id=c-1") {
  window.history.replaceState({}, "", url);
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><Conversations /></SWRConfig>);
}

describe("ajuda contextual — página de conversas", () => {
  let pauseFailure: boolean;

  beforeEach(() => {
    pauseFailure = false;
    conversation.ai_active = false;
    vi.restoreAllMocks();
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/me")) return response({ user: { id: "u-1", email: "agent@example.com", isRoot: false, name: "Agent" }, activeWorkspace: { id: "w-1", name: "Workspace", slug: "ws", status: "active", role: "ADMIN" }, workspaces: [], permissions: ["conversations.reply"], actorScope: "workspace" });
      if (url.endsWith("/feature-flags")) return response({ flags: {} });
      if (url.endsWith("/connections")) return response({ connections: [{ id: "conn-wa", label: "WhatsApp principal", status: "connected" }] });
      if (url.endsWith("/conversation-queues")) return response({ queues: [{ id: "q-new", name: "Novo contato", color: "#22c55e", is_resolved: false, conversation_count: 1, archived_at: null }] });
      if (url.endsWith("/conversations/unread-counts")) return response({ human: 2, ai: 0, scheduled: 0, resolved: 0 });
      if (url.endsWith("/conversations/assignees")) return response({ assignees: [{ id: "u-1", email: "agent@example.com" }] });
      if (url.endsWith("/me/notification-preferences")) return response({ muted_conversations: [] });
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
    renderInbox("/conversas");
    expect(await screen.findByRole("button", { name: "Agendadas" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolvidas" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ajuda: abas da lista de conversas" }));
    expect(await screen.findByText(/Abertas: aguardando atendimento humano/)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText(/Abertas: aguardando atendimento humano/)).toBeNull();
  });

  it("thread sem IA explica o handoff; fila e campos de ajuda ficam presentes", async () => {
    renderInbox();
    expect(await screen.findByRole("combobox", { name: "Fila do atendimento" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ajuda: por que a IA está desligada" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ajuda: fila do atendimento" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ajuda: Novo responsável" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ajuda: Assinatura do atendente" })).toBeInTheDocument();
  });

  it("pausar a IA mostra aviso de sucesso imediato", async () => {
    const user = userEvent.setup();
    conversation.ai_active = true;
    renderInbox();
    await screen.findByRole("combobox", { name: "Fila do atendimento" });
    await user.click(screen.getByRole("button", { name: "Pausar IA neste contato" }));
    await user.click(await screen.findByRole("button", { name: "Pausar IA" }));
    expect(await screen.findByText("IA pausada neste contato.")).toBeInTheDocument();
  });

  it("pausar a IA que falha não mostra aviso de sucesso", async () => {
    const user = userEvent.setup();
    conversation.ai_active = true;
    pauseFailure = true;
    renderInbox();
    await screen.findByRole("combobox", { name: "Fila do atendimento" });
    await user.click(screen.getByRole("button", { name: "Pausar IA neste contato" }));
    await user.click(await screen.findByRole("button", { name: "Pausar IA" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("IA pausada neste contato.")).toBeNull();
  });
});
