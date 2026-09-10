// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => true }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/failed-message-recovery", () => ({
  FailedMessageRecovery: () => <div data-testid="failed-message-recovery" />
}));

import ConnectionPage from "../app/conexao/page";

const recovery = {
  available: 0,
  ambiguous: 0,
  has_connected_session: true,
  legacy_unrecoverable: 0,
  oldest_at: null
};

const connections = [
  {
    id: "connection-primary",
    label: "Comercial",
    is_primary: true,
    phone_number: "5511999999999",
    status: "connected" as const,
    qr_code: null,
    last_connected_at: "2026-09-09T12:00:00.000Z",
    disconnected_reason: null,
    created_at: "2026-09-01T12:00:00.000Z"
  },
  {
    id: "connection-support",
    label: "Suporte",
    is_primary: false,
    phone_number: null,
    status: "qr_pending" as const,
    qr_code: "support-qr-payload",
    last_connected_at: null,
    disconnected_reason: null,
    created_at: "2026-09-02T12:00:00.000Z"
  }
];

function mockInitialLoad(max: number | null = 3) {
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/connections" && !init) return { connections, limits: { used: connections.length, max } };
    if (path === "/connection/failed-messages") return { recovery };
    throw new Error(`Unexpected API call: ${path}`);
  });
}

describe("multiple WhatsApp connections page", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders two connection cards with their distinct states and QR", async () => {
    mockInitialLoad();

    render(<ConnectionPage />);

    const commercial = await screen.findByRole("group", { name: /Comercial/ });
    const support = screen.getByRole("group", { name: /Suporte/ });
    expect(within(commercial).getByText("Principal")).toBeInTheDocument();
    expect(within(commercial).getByText("WhatsApp conectado")).toBeInTheDocument();
    expect(within(commercial).getAllByText("5511999999999")).toHaveLength(2);
    expect(within(support).getByText("Aguardando leitura")).toBeInTheDocument();
    expect(within(support).getByTitle("QR Code de Suporte")).toBeInTheDocument();
    expect(screen.getAllByText(/Conexão não-oficial/)).toHaveLength(2);
  });

  it("keeps the last rendered list when a polling request fails", async () => {
    let connectionLoads = 0;
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/connections") {
        connectionLoads += 1;
        if (connectionLoads === 1) return { connections, limits: { used: 2, max: 3 } };
        throw new Error("Falha temporária de rede");
      }
      if (path === "/connection/failed-messages") return { recovery };
      throw new Error(`Unexpected API call: ${path}`);
    });
    vi.useFakeTimers();

    render(<ConnectionPage />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("group", { name: /Comercial/ })).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });

    expect(screen.getByRole("group", { name: /Comercial/ })).toBeInTheDocument();
    expect(screen.getByText("Atualização temporariamente indisponível")).toBeInTheDocument();
    expect(screen.getByText("Falha temporária de rede")).toBeInTheDocument();
  });

  it("disables adding a number and explains the plan limit", async () => {
    mockInitialLoad(2);

    render(<ConnectionPage />);

    const addButton = await screen.findByRole("button", { name: "Adicionar número" });
    expect(addButton).toBeDisabled();
    expect(addButton).toHaveAttribute("title", "Seu plano permite até 2 conexões de WhatsApp.");
  });

  it("shows the backend plan error when creating a connection over the limit", async () => {
    const planError = "Seu plano atingiu o limite de conexões do WhatsApp";
    mockInitialLoad(3);
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/connections" && !init) return { connections, limits: { used: 2, max: 3 } };
      if (path === "/connection/failed-messages") return { recovery };
      if (path === "/connections" && init?.method === "POST") throw new Error(planError);
      throw new Error(`Unexpected API call: ${path}`);
    });
    const user = userEvent.setup();

    render(<ConnectionPage />);
    await user.click(await screen.findByRole("button", { name: "Adicionar número" }));
    await user.type(screen.getByRole("textbox", { name: "Rótulo do número" }), "Financeiro");
    await user.click(screen.getByRole("button", { name: "Adicionar conexão" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(planError);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/connections", {
      method: "POST",
      body: JSON.stringify({ label: "Financeiro" })
    }));
  });
});
