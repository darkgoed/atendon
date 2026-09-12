// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import Conversations from "@/app/conversas/page";

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
vi.mock("@/components/conversation-queue-manager", () => ({ ConversationQueueManager: () => null }));

const queues = [
  { id: "q-new", name: "Novo contato", color: "#22c55e", is_resolved: false, conversation_count: 1, archived_at: null },
  { id: "q-instagram", name: "Instagram", color: "#db2777", is_resolved: false, conversation_count: 1, archived_at: null },
  { id: "q-done", name: "Resolvido", color: "#64748b", is_resolved: true, conversation_count: 0, archived_at: null }
];
type FixtureConversation = {
  id: string; session_id: string; lead_id: string; contact_phone: string; contact_name: string; ai_active: boolean;
  last_message: string; last_message_at: string; status: "open" | "closed"; unread_count: number;
  queue_id: string; queue_name: string; channel: "whatsapp" | "instagram"; next_action: string | null; next_action_at: string | null;
};

const baseConversation: FixtureConversation = {
  id: "c-1", session_id: "conn-wa", lead_id: "lead-1", contact_phone: "+5511999999999", contact_name: "Ana", ai_active: false,
  last_message: "Oi", last_message_at: "2026-09-11T12:00:00.000Z", status: "open", unread_count: 2,
  queue_id: "q-new", queue_name: "Novo contato", channel: "whatsapp", next_action: null, next_action_at: null
};

const secondConversation: FixtureConversation = {
  ...baseConversation,
  id: "c-2",
  lead_id: "lead-2",
  contact_name: "Bruno",
  unread_count: 0,
  queue_id: "q-instagram",
  queue_name: "Instagram"
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderInbox(url = "/conversas") {
  window.history.replaceState({}, "", url);
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><Conversations /></SWRConfig>);
}

describe("inbox de filas e canais", () => {
  let calls: Array<[string, RequestInit | undefined]>;
  let conversation = { ...baseConversation };
  let queueFailure = false;
  let sessionRole = "ADMIN";

  beforeEach(() => {
    calls = [];
    conversation = { ...baseConversation };
    queueFailure = false;
    sessionRole = "ADMIN";
    vi.restoreAllMocks();
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push([url, init]);
      if (url.endsWith("/me")) return response({ user: { id: "u-1", email: "agent@example.com", isRoot: false, name: "Agent" }, activeWorkspace: { id: "w-1", name: "Workspace", slug: "ws", status: "active", role: sessionRole }, workspaces: [], permissions: ["conversations.reply"], actorScope: "workspace" });
      if (url.endsWith("/feature-flags")) return response({ flags: {} });
      if (url.endsWith("/connections")) return response({ connections: [{ id: "conn-wa", label: "WhatsApp principal", status: "connected" }] });
      if (url.endsWith("/conversation-queues")) return response({ queues });
      if (url.endsWith("/conversations/unread-counts")) return response({ human: 2, ai: 0, scheduled: 0, resolved: 0 });
      if (url.includes("/conversations/c-1/messages")) return response({ conversation, messages: [] });
      if (url.includes("/conversations?") && (init?.method ?? "GET") === "GET") return response({ conversations: [conversation, secondConversation] });
      if (url.endsWith("/conversations/c-1/queue") && init?.method === "PATCH") { const body = JSON.parse(String(init.body)); if (queueFailure) return response({ error: "falha" }, 500); conversation = { ...conversation, queue_id: body.queue_id, queue_name: queues.find((q) => q.id === body.queue_id)?.name ?? conversation.queue_name, status: body.queue_id === "q-done" ? "closed" : "open" }; return response({ ok: true, queue_id: body.queue_id, status: conversation.status }); }
      if (url.endsWith("/conversations/c-1/resolve") && init?.method === "PATCH") { conversation = { ...conversation, status: "closed" }; return response({ ok: true }); }
      throw new Error(`URL inesperada: ${url} ${(init?.method ?? "GET")}`);
    });
  });
  afterEach(() => cleanup());

  it("renderiza WhatsApp na lista e Instagram na lista e thread", async () => {
    await renderInbox();
    expect(await screen.findByText("Ana")).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "Canal WhatsApp" })).toHaveLength(2);

    cleanup();
    conversation = { ...conversation, channel: "instagram" };
    await renderInbox("/conversas?id=c-1");
    expect((await screen.findAllByText("Ana")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("img", { name: "Canal Instagram" })).toHaveLength(2);
  });

  it("compõe chips de fila e filtros na query server-side", async () => {
    await renderInbox();
    await screen.findByText("Ana");
    await userEvent.setup().click(screen.getByRole("button", { name: /Filtros/ }));
    const queueBar = screen.getByLabelText("Filas de atendimento");
    await userEvent.setup().click(within(queueBar).getByRole("button", { name: /Instagram/ }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Não lidas" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Pendências" }));
    await waitFor(() => {
      const urls = calls.map(([url]) => url);
      expect(urls.some((url) => url.includes("queue_id=q-instagram") && url.includes("unread=true") && url.includes("pending_action=true"))).toBe(true);
    });
    expect(screen.getByRole("button", { name: "Não lidas" })).toHaveClass("primary");
    expect(screen.getByRole("button", { name: "Pendências" })).toHaveClass("primary");
  });

  it("mantém as quatro abas visíveis, fecha filtros avançados inicialmente e expõe contador e estados aria", async () => {
    await renderInbox();
    await screen.findByText("Ana");

    expect(screen.getByRole("button", { name: /^Abertas/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "IA" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Agendadas" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Resolvidas" })).toBeVisible();
    const filters = screen.getByRole("button", { name: /Filtros/ });
    expect(filters).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Filtros avançados")).not.toBeInTheDocument();

    await userEvent.setup().click(filters);
    expect(filters).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Filtros avançados")).toBeVisible();
    expect(screen.getByRole("button", { name: /^Abertas/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Não lidas" })).toHaveAttribute("aria-pressed", "false");
  });

  it("preserva a composição server-side ao abrir, selecionar e limpar filtros", async () => {
    await renderInbox();
    await screen.findByText("Ana");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Filtros/ }));
    await user.click(screen.getByRole("button", { name: /Instagram/ }));
    await user.click(screen.getByRole("button", { name: "Não lidas" }));
    await user.click(screen.getByRole("button", { name: "Pendências" }));
    await waitFor(() => expect(calls.map(([url]) => url).some((url) => url.includes("filter=human") && url.includes("queue_id=q-instagram") && url.includes("unread=true") && url.includes("pending_action=true"))).toBe(true));
    expect(screen.getByRole("button", { name: /Filtros \(3\)/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Limpar filtros" }));
    await waitFor(() => expect(calls.map(([url]) => url).some((url) => url.endsWith("/conversations?filter=human"))).toBe(true));
    expect(screen.getByRole("button", { name: /Filtros$/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("aplica resolve otimista somente à conversa selecionada", async () => {
    await renderInbox("/conversas?id=c-1");
    await screen.findByText("Bruno");
    await userEvent.setup().click(screen.getByRole("button", { name: "Resolver" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Resolver conversa" }));
    await waitFor(() => expect(screen.getByText("Bruno")).toBeInTheDocument());
    expect(screen.getByText("Bruno").closest("button")).toHaveAttribute("aria-pressed", "false");
  });

  it("aplica mover de fila otimista somente à conversa selecionada", async () => {
    await renderInbox("/conversas?id=c-1");
    const selector = await screen.findByRole("combobox", { name: "Fila do atendimento" });
    await userEvent.setup().selectOptions(selector, "q-instagram");
    await waitFor(() => expect(selector).toHaveValue("q-instagram"));
    expect(screen.getByText("Bruno").closest("button")).toHaveAttribute("aria-pressed", "false");
  });

  it("usa human quando filtro da query é inválido", async () => {
    await renderInbox("/conversas?filtro=nao-suportado");
    await screen.findByText("Ana");

    await waitFor(() => expect(calls.map(([url]) => url).some((url) => url.endsWith("/conversations?filter=human"))).toBe(true));
    expect(calls.map(([url]) => url).some((url) => url.includes("filter=nao-suportado"))).toBe(false);
  });

  it("exibe a fila atual e bloqueia movimento em conversa fechada", async () => {
    conversation = { ...conversation, status: "closed", queue_id: "q-done", queue_name: "Resolvido" };
    await renderInbox("/conversas?id=c-1");
    await screen.findAllByText("Ana");

    expect(screen.getByText("Fila: Resolvido")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Fila do atendimento" })).not.toBeInTheDocument();
  });

  it("mantém a fila Resolvido fora dos chips e destinos e mostra a próxima ação na lista", async () => {
    conversation = {
      ...conversation,
      next_action: "Ligar para Ana",
      next_action_at: "2026-09-12T15:30:00.000Z"
    };
    await renderInbox("/conversas?id=c-1");

    await screen.findAllByText("Ana");
    expect(screen.getByText(/Próxima ação: Ligar para Ana/)).toHaveTextContent(/Próxima ação: Ligar para Ana/);
    expect(screen.getByText(/Próxima ação: Ligar para Ana/)).toHaveTextContent(/\d{2}\/\d{2}/);

    await userEvent.setup().click(screen.getByRole("button", { name: /Filtros/ }));
    const queueBar = screen.getByLabelText("Filas de atendimento");
    expect(within(queueBar).queryByRole("button", { name: /Resolvido/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Resolvido" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Filas de atendimento" })).not.toBeInTheDocument();
    expect(screen.queryByText("Nova conversa")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Filtros/ })).toBeInTheDocument();
  });

  it("mantém os filtros próprios para operador mine e oculta somente sem responsável", async () => {
    sessionRole = "OPERADOR";
    await renderInbox();
    await screen.findByText("Ana");
    const filters = screen.getByRole("button", { name: "Filtros" });
    expect(filters).not.toHaveTextContent("(1)");
    expect(screen.queryByRole("button", { name: /^Abertas/ })).not.toBeInTheDocument();
    expect(screen.getByText("Minhas conversas abertas")).toBeInTheDocument();
    await userEvent.setup().click(filters);

    expect(screen.getByRole("button", { name: "Minhas conversas" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Sem responsável" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Filas de atendimento" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Não lidas" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pendências" })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(screen.getByLabelText("Filas de atendimento")).getByRole("button", { name: /Instagram/ }));
    await user.click(screen.getByRole("button", { name: "Não lidas" }));
    await user.click(screen.getByRole("button", { name: "Pendências" }));
    await waitFor(() => {
      expect(calls.map(([url]) => url).some((url) => url.includes("filter=mine") && url.includes("queue_id=q-instagram") && url.includes("unread=true") && url.includes("pending_action=true"))).toBe(true);
    });
  });

  it("marca não lida, move por uma chamada e reverte no erro", async () => {
    await renderInbox();
    const unreadName = await screen.findByText("Ana");
    expect(unreadName).toHaveAttribute("data-unread", "true");
    expect(unreadName).toHaveClass("font-semibold");

    cleanup();
    await renderInbox("/conversas?id=c-1");
    const selector = await screen.findByRole("combobox", { name: "Fila do atendimento" });
    queueFailure = true;
    await userEvent.setup().selectOptions(selector, "q-instagram");
    await waitFor(() => expect(selector).toHaveValue("q-new"));
    expect(screen.getByRole("alert")).toHaveTextContent("falha");

    queueFailure = false;
    await userEvent.setup().selectOptions(selector, "q-instagram");
    await waitFor(() => expect(calls.filter(([url, init]) => url.endsWith("/conversations/c-1/queue") && init?.method === "PATCH")).toHaveLength(2));
    expect(selector).toHaveValue("q-instagram");
  });

  it("resolve pela ação única após confirmação", async () => {
    await renderInbox("/conversas?id=c-1");
    await screen.findByRole("button", { name: "Resolver" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Resolver" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Resolver conversa" }));
    await waitFor(() => expect(calls.filter(([url, init]) => url.endsWith("/conversations/c-1/resolve") && init?.method === "PATCH")).toHaveLength(1));
  });
});
