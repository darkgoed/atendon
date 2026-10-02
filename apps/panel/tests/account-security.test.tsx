// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api }));

import { AccountSecurity } from "../components/account-security";

const sessions = {
  items: [
    { id: "s-current", created_at: "2026-10-01T10:00:00Z", expires_at: "2026-10-01T22:00:00Z", current: true, ip_address: "10.0.0.1", user_agent: "Chrome" },
    { id: "s-other", created_at: "2026-09-30T08:00:00Z", expires_at: "2026-10-01T20:00:00Z", current: false, ip_address: "10.0.0.9", user_agent: "Firefox" }
  ]
};

function setup(totpEnabled = false, onTotpChanged = vi.fn()) {
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/me/sessions") return sessions;
    if (path === "/me/totp/setup") return { secret: "JBSWY3DPEHPK3PXP", otpauth_url: "otpauth://totp/AtendON:user@example.com?secret=JBSWY3DPEHPK3PXP" };
    if (path === "/me/totp/activate") return { ok: true };
    if (path === "/me/totp/deactivate") return { ok: true };
    if (path.startsWith("/me/sessions/revoke-others")) return { ok: true, revoked: 1 };
    if (path.startsWith("/me/sessions/")) return { ok: true, current: false };
    void init;
    return {};
  });
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <AccountSecurity totpEnabled={totpEnabled} onTotpChanged={onTotpChanged} />
    </SWRConfig>
  );
}

function callsFor(path: string) { return api.mock.calls.filter(([calledPath]) => calledPath === path); }

describe("account security — sessões ativas e 2FA TOTP", () => {
  beforeEach(() => {
    cleanup();
    api.mockReset();
    vi.stubGlobal("confirm", vi.fn(() => true));
    Object.defineProperty(window, "location", { configurable: true, value: { origin: "http://localhost", assign: vi.fn() } });
  });

  it("lista sessões com a marcação da sessão atual e encerra as outras", async () => {
    const user = userEvent.setup();
    setup();
    expect(await screen.findByText("Esta sessão")).toBeTruthy();
    // Cada linha tem o seu Encerrar — inclusive a atual (encerrar a própria
    // sessão desloga e redireciona para /login).
    const encerrarButtons = screen.getAllByRole("button", { name: "Encerrar" });
    expect(encerrarButtons).toHaveLength(2);
    const otherRow = screen.getByText(/Firefox/).closest("li");
    expect(otherRow).toBeTruthy();
    await user.click(within(otherRow as HTMLElement).getByRole("button", { name: "Encerrar" }));
    expect(callsFor("/me/sessions/s-other").some(([, init]) => (init as RequestInit).method === "DELETE")).toBe(true);
    expect(screen.getByRole("button", { name: "Encerrar outras sessões" })).toBeTruthy();
  });

  it("encerra as outras sessões via revoke-others", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole("button", { name: "Encerrar outras sessões" }));
    const call = callsFor("/me/sessions/revoke-others")[0];
    expect(call).toBeTruthy();
    expect((call![1] as RequestInit).method).toBe("POST");
  });

  it("2FA inativo: setup devolve QR + chave manual e a ativação POSTa o código", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    setup(false, onChanged);
    await user.click(await screen.findByRole("button", { name: "Ativar verificação em duas etapas" }));
    expect(await screen.findByRole("img", { name: /QR Code de configuração/ })).toBeTruthy();
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeTruthy();
    await user.type(screen.getByLabelText("2. Código gerado pelo aplicativo"), "123456");
    await user.click(screen.getByRole("button", { name: "Confirmar ativação" }));
    const activate = callsFor("/me/totp/activate")[0];
    expect(activate).toBeTruthy();
    expect((activate![1] as RequestInit).body).toBe(JSON.stringify({ code: "123456" }));
    expect(await screen.findByText("Verificação em duas etapas ativada.")).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it("2FA ativo: desativação exige a senha atual", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    setup(true, onChanged);
    expect(await screen.findByText(/Ativa: além da senha/)).toBeTruthy();
    await user.type(screen.getByLabelText("Senha atual"), "senha-errada");
    await user.click(screen.getByRole("button", { name: "Desativar verificação em duas etapas" }));
    const deactivate = callsFor("/me/totp/deactivate")[0];
    expect(deactivate).toBeTruthy();
    expect((deactivate![1] as RequestInit).body).toBe(JSON.stringify({ current_password: "senha-errada" }));
    expect(await screen.findByText("Verificação em duas etapas desativada.")).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
  });

  it("2FA ativo não oferece setup e o inativo não oferece desativação", async () => {
    setup(true);
    await screen.findByText(/Ativa: além da senha/);
    expect(screen.queryByRole("button", { name: "Ativar verificação em duas etapas" })).toBeNull();
    cleanup();
    setup(false);
    await screen.findByText(/Inativa: adicione uma segunda etapa/);
    expect(screen.queryByRole("button", { name: "Desativar verificação em duas etapas" })).toBeNull();
  });
});
