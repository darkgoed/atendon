// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api }));
vi.mock("../components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

import GatewaysPage from "../app/root/saas/gateways/page";

const rootSession = { user: { id: "root", email: "root@example.com", isRoot: true, name: "Root" }, activeWorkspace: null, workspaces: [], permissions: [], actorScope: "root" };
const providers = [
  { code: "mercadopago", name: "Mercado Pago", environment: "sandbox", status: "connected", credentials_hint: "sandbox-account" },
  { code: "mercadopago", name: "Mercado Pago", environment: "production", status: "not_connected", credentials_hint: null },
];

function setup() {
  api.mockImplementation(async (path: string) => {
    if (path === "/me") return rootSession;
    if (path === "/root/billing/providers") return { providers };
    if (path.endsWith("/oauth/begin")) return { authorizationUrl: "https://mercadopago.example/authorize" };
    return {};
  });
  return render(<SWRConfig value={{ provider: () => new Map() }}><GatewaysPage /></SWRConfig>);
}

function callsFor(path: string) { return api.mock.calls.filter(([calledPath]) => calledPath === path); }

describe("root SaaS gateways", () => {
  beforeEach(() => {
    cleanup();
    api.mockReset();
    vi.stubGlobal("confirm", vi.fn(() => true));
    Object.defineProperty(window, "location", { configurable: true, value: { origin: "http://localhost", assign: vi.fn() } });
  });

  it("loads providers and renders each provider by code and environment", async () => {
    setup();
    expect(await screen.findByText("connected")).toBeTruthy();
    expect(screen.getByText("not_connected")).toBeTruthy();
    expect(screen.getByText(/sandbox-account/)).toBeTruthy();
    expect(callsFor("/root/billing/providers")).toHaveLength(1);
    expect(screen.getAllByText("Mercado Pago")).toHaveLength(2);
  });

  it("saves Mercado Pago credentials using the exact backend contract", async () => {
    setup();
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: "Conectar / credenciais" }))[0]);
    await user.type(screen.getByRole("textbox", { name: "Client ID" }), "client-123");
    await user.type(screen.getByLabelText("Client Secret"), "secret-456");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/root/billing/providers/mercadopago/sandbox/credentials", {
      method: "PUT",
      body: JSON.stringify({ credentials: { clientId: "client-123", clientSecret: "secret-456" } }),
    }));
  });

  it("disconnects only after confirmation with confirm true", async () => {
    setup();
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: "Desconectar" }))[0]);
    await waitFor(() => expect(api).toHaveBeenCalledWith("/root/billing/providers/mercadopago/sandbox/disconnect", {
      method: "POST", body: JSON.stringify({ confirm: true }),
    }));
    expect(window.confirm).toHaveBeenCalledWith("Desconectar Mercado Pago (sandbox)? Isso remove apenas as credenciais locais do AtendON. O Mercado Pago não oferece API para revogação remota; para revogar totalmente o acesso, faça isso manualmente na sua conta do Mercado Pago em Configurações > Suas integrações.");
    expect(await screen.findByRole("status")).toHaveTextContent("Gateway desconectado localmente. O Mercado Pago não oferece API para revogação remota.");
  });

  it("starts OAuth and redirects to the returned authorization URL", async () => {
    setup();
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: "Conectar via OAuth" }))[0]);
    await waitFor(() => expect(api).toHaveBeenCalledWith("/root/billing/providers/sandbox/oauth/begin", {
      method: "POST", body: JSON.stringify({ redirectUri: "http://localhost/billing/providers/mercadopago/oauth/callback" }),
    }));
    expect(window.location.assign).toHaveBeenCalledWith("https://mercadopago.example/authorize");
  });

  it("shows a visible OAuth failure message from the callback", async () => {
    Object.defineProperty(window, "location", { configurable: true, value: { origin: "http://localhost", pathname: "/root/saas/gateways", search: "?mercadopago=error", assign: vi.fn() } });
    setup();
    expect(await screen.findByRole("status")).toHaveTextContent("Não foi possível concluir a conexão OAuth");
  });

  it("tests the connection using the exact backend route", async () => {
    setup();
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: "Testar conexão" }))[0]);
    await waitFor(() => expect(api).toHaveBeenCalledWith("/root/billing/providers/sandbox/test-connection", { method: "POST" }));
  });

  it("enables a connected gateway using the exact backend route", async () => {
    setup();
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: "Habilitar" }))[0]);
    await waitFor(() => expect(api).toHaveBeenCalledWith("/root/billing/providers/mercadopago/sandbox/enabled", {
      method: "POST", body: JSON.stringify({ enabled: true }),
    }));
  });

  it("disables an already-enabled gateway", async () => {
    api.mockImplementation(async (path: string) => {
      if (path === "/me") return rootSession;
      if (path === "/root/billing/providers") return { providers: providers.map((p) => (p.environment === "sandbox" ? { ...p, enabled: true } : p)) };
      return {};
    });
    render(<SWRConfig value={{ provider: () => new Map() }}><GatewaysPage /></SWRConfig>);
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole("button", { name: "Desabilitar" }))[0]);
    await waitFor(() => expect(api).toHaveBeenCalledWith("/root/billing/providers/mercadopago/sandbox/enabled", {
      method: "POST", body: JSON.stringify({ enabled: false }),
    }));
  });
});
