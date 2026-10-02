// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api }));
vi.mock("../lib/realtime", () => ({ useRealtimeSignals: () => undefined }));

import { AlertasBody } from "../app/alertas/alertas-content";

const rootSession = { user: { id: "u1", email: "root@example.com", isRoot: true, name: "Root" }, activeWorkspace: null, workspaces: [], permissions: [], actorScope: "root", rootWorkspaceAccess: true };

function alertsData(unread: number) {
  return {
    alerts: [
      { id: "a-1", message: "Falha de conexão", kind: "operational", metadata: {}, created_at: "2026-10-01T10:00:00Z", notified_at: null, read_at: unread > 0 ? null : "2026-10-01T11:00:00Z", can_acknowledge: true }
    ],
    unread,
    total: 1,
    offset: 0,
    limit: 50,
    receipt_mode: "member"
  };
}

function setup(initialUnread: number) {
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/me") return rootSession;
    if (path === "/feature-flags") return { flags: {} };
    if (path.startsWith("/alerts?")) return alertsData(initialUnread);
    if (path === "/alerts/read-all") {
      expect((init as RequestInit).method).toBe("PATCH");
      initialUnread = 0;
      return { ok: true, updated: 1 };
    }
    return {};
  });
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <AlertasBody />
    </SWRConfig>
  );
}

describe("alertas — marcar todas como lidas", () => {
  beforeEach(() => {
    cleanup();
    api.mockReset();
  });

  it("só oferece a ação quando há alertas não lidos", async () => {
    setup(1);
    expect(await screen.findByText("Falha de conexão")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Marcar todas como lidas" })).toBeTruthy();
  });

  it("não oferece a ação com tudo lido", async () => {
    setup(0);
    expect(await screen.findByText("Falha de conexão")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Marcar todas como lidas" })).toBeNull();
  });

  it("PATCHa /alerts/read-all e atualiza o contador", async () => {
    const user = userEvent.setup();
    setup(3);
    await user.click(await screen.findByRole("button", { name: "Marcar todas como lidas" }));
    await vi.waitFor(() => expect(api.mock.calls.some(([path, init]) => path === "/alerts/read-all" && (init as RequestInit).method === "PATCH")).toBe(true));
    await vi.waitFor(() => expect(screen.getByText(/^0$/)).toBeTruthy());
  });
});
