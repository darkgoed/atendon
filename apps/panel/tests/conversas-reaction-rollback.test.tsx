// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import Conversations from "@/app/conversas/page";
import { ErrorToasts } from "@/components/error-toasts";

// Radix Popover (HelpHint) mede o balão com ResizeObserver, ausente no jsdom.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/lib/capabilities", () => ({ useCapabilities: () => ({ isEnabled: () => false }) }));
type RealtimeOptions = { onSignal?: (signal: { type: string; conversationId?: string }) => void };
const realtime = vi.hoisted(() => ({ options: null as RealtimeOptions | null }));
vi.mock("@/lib/realtime", () => ({ useRealtimeSignals: (options: RealtimeOptions) => { realtime.options = options; } }));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => true }));
vi.mock("@/components/conversation-composer", () => ({ ConversationComposer: () => null }));
vi.mock("@/components/conversation-contact-panel", () => ({ ConversationContactPanel: () => null }));
vi.mock("@/components/conversation-message-media", () => ({ ConversationMessageMedia: () => null }));
vi.mock("@/components/ai-turn-bubble", () => ({ AiTurnBubble: () => null }));
vi.mock("@/components/conversation-referral", () => ({ ConversationReferral: () => null }));
vi.mock("@/components/conversation-scheduler", () => ({ ConversationScheduler: () => null }));
vi.mock("@/components/conversation-status-picker", () => ({ ConversationStatusPicker: () => null }));
vi.mock("@/components/lead-tag-picker", () => ({ LeadTagChips: () => null }));
vi.mock("@/components/message-actions-menu", () => ({
  MessageActionsMenu: ({ onReact }: { onReact: (emoji: string) => void }) => <button type="button" onClick={() => onReact("👍")}>Reagir</button>
}));
vi.mock("@/components/popover-menu", () => ({ PopoverMenu: ({ children }: { children: () => ReactNode }) => <>{children()}</> }));
vi.mock("@/components/conversation-next-action", () => ({ ConversationNextAction: () => null }));
vi.mock("@/components/conversation-pre-briefing", () => ({ ConversationPreBriefing: () => null }));


// PAINEL C14: reação que falha desfazia com o snapshot do clique e apagava
// mensagens que chegaram enquanto a requisição voava.
const conversation = {
  id: "c-1", session_id: "conn-wa", lead_id: "lead-1", contact_phone: "+551****9999", contact_name: "Ana",
  ai_active: false, last_message: "Oi", last_message_at: "2026-09-11T12:00:00.000Z", status: "open" as const,
  unread_count: 0, channel: "whatsapp" as const, next_action: null, next_action_at: null
};
const first = { id: "m-1", sender: "contact", content: "primeira", status: "received", created_at: "2026-09-11T12:00:00.000Z", reaction_emoji: null };
const arrived = { id: "m-2", sender: "contact", content: "chegou no meio", status: "received", created_at: "2026-09-11T12:01:00.000Z", reaction_emoji: null };

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("conversas — rollback de reação (PAINEL C14)", () => {
  let thread = [first];
  let rejectReaction: (() => void) | null = null;

  beforeEach(() => {
    thread = [first];
    rejectReaction = null;
    vi.restoreAllMocks();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/me")) return response({ user: { id: "u-1", email: "agent@example.com", isRoot: false, name: "Agent" }, activeWorkspace: { id: "w-1", name: "Workspace", slug: "ws", status: "active", role: "ADMIN" }, workspaces: [], permissions: ["conversations.reply"], actorScope: "workspace" });
      if (url.endsWith("/feature-flags")) return response({ flags: {} });
      if (url.endsWith("/connections")) return response({ connections: [{ id: "conn-wa", label: "WhatsApp principal", status: "connected" }] });
      if (url.endsWith("/conversations/unread-counts")) return response({ human: 0, ai: 0, scheduled: 0, resolved: 0 });
      if (url.endsWith("/conversations/assignees")) return response({ assignees: [] });
      if (url.endsWith("/me/notification-preferences")) return response({ muted_conversations: [] });
      if (url.endsWith("/conversations/c-1/read") && method === "PATCH") return response({ ok: true });
      if (url.includes("/conversations/c-1/messages/m-1/react")) {
        return new Promise<Response>((resolve) => { rejectReaction = () => resolve(response({ error: "falhou" }, 500)); });
      }
      if (url.includes("/conversations/c-1/messages")) return response({ conversation, messages: thread });
      if (url.includes("/conversations?") && method === "GET") return response({ conversations: [conversation] });
      throw new Error(`URL inesperada: ${url} ${method}`);
    });
  });
  afterEach(() => cleanup());

  it("a falha desfaz só a reação e mantém a mensagem que chegou no meio", async () => {
    window.history.replaceState({}, "", "/conversas?id=c-1");
    render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><ErrorToasts /><Conversations /></SWRConfig>);
    await screen.findByText("primeira");
    fireEvent.click(screen.getAllByRole("button", { name: "Reagir" })[0]);
    // Chega mensagem nova enquanto a reação ainda está em voo.
    thread = [first, arrived];
    await act(async () => { realtime.options?.onSignal?.({ type: "conversation.messages.changed", conversationId: "c-1" }); });
    await screen.findByText("chegou no meio");
    await act(async () => { rejectReaction?.(); });
    expect(await screen.findByRole("alert")).toHaveTextContent("falhou");
    expect(document.querySelectorAll(".error-toast")).toHaveLength(1);
    expect(screen.queryByLabelText("Reação 👍")).toBeNull();
    expect(screen.getByText("chegou no meio")).toBeInTheDocument();
  });
});
