// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { InternalNotifications } from "@/components/internal-notifications";
import {
  formatRelativeNotificationTime,
  internalNotificationHref
} from "@/lib/internal-notifications";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMock }));

const items = [
  {
    id: "n1",
    type: "task_assigned",
    title: "Tarefa atribuída",
    body: "Confirmar orçamento da reforma",
    source_type: "task",
    source_id: "task-1",
    actor_id: "u2",
    actor_name: "Ana Souza",
    read_at: "2026-01-01T00:00:00.000Z",
    created_at: new Date(Date.now() - 30_000).toISOString()
  },
  {
    id: "n2",
    type: "mention",
    title: "Menção em nota",
    body: "@você, dê uma olhada no lead",
    source_type: "lead",
    source_id: "lead-9",
    actor_id: "u3",
    actor_name: "Bruno Dias",
    read_at: null,
    created_at: new Date(Date.now() - 3_600_000).toISOString()
  }
];

const response = { items, total_unread: 2, page: { has_more: false, next_cursor: null } };

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/me/internal-notifications?")) return response;
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Cache do SWR é global entre testes: um provider novo por render isola cada caso.
function renderBell() {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <InternalNotifications />
    </SWRConfig>
  );
}

describe("InternalNotifications (sino do shell)", () => {
  it("mostra o badge de não lidas derivado de total_unread", async () => {
    renderBell();
    const trigger = await screen.findByRole("button", { name: "Sino de notificações" });
    expect(trigger.textContent).toContain("2");
  });

  it("abre o popover com role=dialog, lista título/corpo/autor/tempo e marca lida ao abrir item", async () => {
    renderBell();
    const trigger = await screen.findByRole("button", { name: "Sino de notificações" });
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Notificações internas" });
    expect(dialog.textContent).toContain("Tarefa atribuída");
    expect(dialog.textContent).toContain("Confirmar orçamento da reforma");
    expect(dialog.textContent).toContain("Ana Souza");
    expect(dialog.textContent).toContain("agora");

    apiMock.mockClear();
    fireEvent.click(screen.getByText("Menção em nota"));
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        "/me/internal-notifications/n2/read",
        { method: "POST" },
        { reportErrors: false }
      );
    });
    // Popover fechou após abrir o item.
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Notificações internas" })).toBeNull();
    });
  });

  it("tem empty state 'Sem notificações' quando não há itens", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/me/internal-notifications?")) {
        return { items: [], total_unread: 0, page: { has_more: false, next_cursor: null } };
      }
      return undefined;
    });
    renderBell();
    const trigger = await screen.findByRole("button", { name: "Sino de notificações" });
    expect(trigger.textContent).not.toContain("9");
    fireEvent.click(trigger);
    expect(await screen.findByText("Sem notificações")).toBeTruthy();
    expect(screen.queryByText("Marcar todas")).toBeNull();
  });

  it("'Marcar todas' chama read-all", async () => {
    renderBell();
    const trigger = await screen.findByRole("button", { name: "Sino de notificações" });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByText("Marcar todas"));
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        "/me/internal-notifications/read-all",
        { method: "POST" },
        { reportErrors: false }
      );
    });
  });

  it("falla silenciosamente quando a API não existe ainda (404)", async () => {
    apiMock.mockRejectedValue(new Error("404"));
    renderBell();
    const trigger = await screen.findByRole("button", { name: "Sino de notificações" });
    expect(trigger.textContent).not.toContain("9");
    fireEvent.click(trigger);
    expect(await screen.findByText("Sem notificações")).toBeTruthy();
  });
});

describe("contratos do sino (lib/internal-notifications)", () => {
  it("mapeia source_type em links: lead→/contatos/:id, conversation→/conversas?id=, task→null", () => {
    expect(internalNotificationHref({ source_type: "lead", source_id: "lead-9" })).toBe("/contatos/lead-9");
    expect(internalNotificationHref({ source_type: "conversation", source_id: "conv-1" })).toBe("/conversas?id=conv-1");
    expect(internalNotificationHref({ source_type: "task", source_id: "task-1" })).toBeNull();
    expect(internalNotificationHref({ source_type: null, source_id: null })).toBeNull();
  });

  it("formata tempo relativo em pt-BR", () => {
    const now = Date.now();
    expect(formatRelativeNotificationTime(new Date(now - 5_000).toISOString(), now)).toBe("agora");
    expect(formatRelativeNotificationTime(new Date(now - 5 * 60_000).toISOString(), now)).toContain("minuto");
    expect(formatRelativeNotificationTime(new Date(now - 2 * 3_600_000).toISOString(), now)).toContain("hora");
    expect(formatRelativeNotificationTime(new Date(now - 3 * 86_400_000).toISOString(), now)).toContain("dia");
    expect(formatRelativeNotificationTime("não-é-data", now)).toBe("");
  });
});