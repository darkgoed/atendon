// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { type ReactNode } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
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


// PAINEL C1: com "Não lidas", abrir a conversa A a marca como lida e ela sai da
// lista; a página pulava sozinha para B (marcando B como lida) e assim por
// diante até zerar as não lidas do workspace sem ninguém ler.
const base = {
  session_id: "conn-wa", lead_id: "lead-1", ai_active: false, last_message: "Oi",
  last_message_at: "2026-09-11T12:00:00.000Z", status: "open" as const, unread_count: 1,
  channel: "whatsapp" as const, next_action: null, next_action_at: null
};
const conversationA = { ...base, id: "c-a", contact_phone: "+551****0001", contact_name: "Ana" };
const conversationB = { ...base, id: "c-b", contact_phone: "+551****0002", contact_name: "Bia" };

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("conversas — lista que muda sob a conversa aberta (PAINEL C1)", () => {
  const read = new Set<string>();
  let calls: Array<{ url: string; method: string }> = [];

  beforeEach(() => {
    read.clear();
    calls = [];
    vi.restoreAllMocks();
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.endsWith("/me")) return response({ user: { id: "u-1", email: "agent@example.com", isRoot: false, name: "Agent" }, activeWorkspace: { id: "w-1", name: "Workspace", slug: "ws", status: "active", role: "ADMIN" }, workspaces: [], permissions: ["conversations.reply"], actorScope: "workspace" });
      if (url.endsWith("/feature-flags")) return response({ flags: {} });
      if (url.endsWith("/connections")) return response({ connections: [{ id: "conn-wa", label: "WhatsApp principal", status: "connected" }] });
      if (url.endsWith("/conversations/unread-counts")) return response({ human: 2 - read.size, ai: 0, scheduled: 0, resolved: 0 });
      if (url.endsWith("/conversations/assignees")) return response({ assignees: [] });
      if (url.endsWith("/me/notification-preferences")) return response({ muted_conversations: [] });
      const readMatch = url.match(/\/conversations\/(c-[ab])\/read$/);
      if (readMatch && method === "PATCH") { read.add(readMatch[1]); return response({ ok: true }); }
      if (url.includes("/conversations/c-a/messages")) return response({ conversation: conversationA, messages: [] });
      if (url.includes("/conversations/c-b/messages")) return response({ conversation: conversationB, messages: [] });
      // Filtro de não lidas: conversa lida sai da lista.
      if (url.includes("/conversations?") && method === "GET") {
        return response({ conversations: [conversationA, conversationB].filter((item) => !read.has(item.id)) });
      }
      throw new Error(`URL inesperada: ${url} ${method}`);
    });
  });
  afterEach(() => cleanup());

  it("a conversa aberta que sai da lista continua aberta e nenhuma outra é marcada como lida", async () => {
    window.history.replaceState({}, "", "/conversas");
    render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><Conversations /></SWRConfig>);
    await waitFor(() => expect(read.has("c-a")).toBe(true));
    // A lista já foi recarregada sem A (mutateList após o PATCH de leitura).
    await waitFor(() => expect(calls.filter((call) => call.url.includes("/conversations?")).length).toBeGreaterThan(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(read.has("c-b")).toBe(false);
    expect(calls.some((call) => call.url.includes("/conversations/c-b/messages"))).toBe(false);
  });
});
