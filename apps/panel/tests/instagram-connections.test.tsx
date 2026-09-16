// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstagramConnections } from "@/components/instagram-connections";

const status = { configured: true, missing: [], graph_version: "v26.0", max_connections: 10 };
const base = {
  id: "ig-1",
  label: "Comercial",
  channel: "instagram" as const,
  is_primary: false,
  phone_number: null,
  qr_code: null,
  status: "connected" as const,
  last_connected_at: null,
  disconnected_reason: null,
  created_at: "2026-01-01T00:00:00Z",
  instagram_username: "@atendon",
  instagram_account_id: "123",
  token_expires_at: "2026-12-01T00:00:00Z"
};

function response(body: unknown, code = 200): Response {
  return new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => cleanup());

describe("Instagram connection UI contract", () => {
  it("shows only missing configuration names and no WhatsApp controls", () => {
    render(<InstagramConnections status={{ ...status, configured: false, missing: ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"] }} connections={[]} canManage onChanged={() => undefined} />);
    expect(screen.getByText(/INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET/)).toBeInTheDocument();
    expect(screen.queryByText(/QR Code|Adicionar número|Principal/)).not.toBeInTheDocument();
  });

  it("starts OAuth through the real API adapter with the exact body and navigates", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push({ url: String(input), init });
      return response({ authorization_url: "https://www.instagram.com/oauth/authorize?state=opaque" });
    });
    const navigate = vi.fn();
    render(<InstagramConnections status={status} connections={[]} canManage onChanged={() => undefined} navigateToAuthorization={navigate} />);

    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Nome da conexão" }), "Instagram Vendas");
    await user.click(screen.getByRole("button", { name: "Conectar Instagram" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://www.instagram.com/oauth/authorize?state=opaque"));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/backend/instagram/oauth/start");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(new Headers(requests[0]?.init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ label: "Instagram Vendas" });
  });

  it("reauthorizes permission errors with the connection id and reports start failures", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push({ url: String(input), init });
      return response({ error: "Autorização indisponível" }, 503);
    });
    render(<InstagramConnections status={status} connections={[{ ...base, status: "permission_error", reconnect_required: true }]} canManage onChanged={() => undefined} navigateToAuthorization={vi.fn()} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Reautorizar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Autorização indisponível");
    expect(requests[0]?.url).toBe("/backend/instagram/oauth/start");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ label: "Comercial", connection_id: "ig-1" });
  });

  it("refreshes through the exact endpoint then reloads connections", async () => {
    const onChanged = vi.fn();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push({ url: String(input), init });
      return response({ ok: true });
    });
    render(<InstagramConnections status={status} connections={[base]} canManage onChanged={onChanged} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Atualizar" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: "/backend/instagram/connections/ig-1/refresh", init: { method: "POST" } });
    expect(screen.getByText("@atendon")).toBeInTheDocument();
    expect(screen.queryByText("@@atendon")).not.toBeInTheDocument();
  });

  it("shows a sanitized refresh error and does not claim a reload", async () => {
    const onChanged = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ error: "Token precisa de nova autorização" }, 409));
    render(<InstagramConnections status={status} connections={[base]} canManage onChanged={onChanged} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Atualizar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Token precisa de nova autorização");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("cancels disconnect before the API and confirms it once accepted", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push({ url: String(input), init });
      return response({ ok: true });
    });
    const onChanged = vi.fn();
    render(<InstagramConnections status={status} connections={[base]} canManage onChanged={onChanged} />);
    const disconnect = screen.getByRole("button", { name: "Desconectar" });

    await userEvent.setup().click(disconnect);
    expect(requests).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();

    await userEvent.setup().click(disconnect);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith("Desconectar a conta @atendon? O histórico será preservado.");
    expect(requests[0]).toMatchObject({ url: "/backend/instagram/connections/ig-1/disconnect", init: { method: "POST" } });
  });

  it("enforces RBAC by hiding every management action", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ ok: true }));
    render(<InstagramConnections status={status} connections={[base]} canManage={false} onChanged={() => undefined} />);

    expect(screen.queryByRole("button", { name: /Conectar Instagram|Atualizar|Desconectar|Reautorizar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Nome da conexão" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
