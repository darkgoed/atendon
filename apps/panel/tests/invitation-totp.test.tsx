// @vitest-environment jsdom
// Aceitar convite com 2FA ativo: o backend aceita o convite mas só emite o
// desafio (totp_required); o painel deve levar ao passo do código, não a "/"
// sem sessão.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock, push } = vi.hoisted(() => ({ apiMock: vi.fn(), push: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

import InvitationAcceptPage from "../app/invitations/[token]/screen";
import Login from "../app/login/page";

beforeEach(() => { apiMock.mockReset(); push.mockReset(); });
afterEach(cleanup);

describe("convite com 2FA", () => {
  it("leva ao passo do código quando o aceite devolve totp_required", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/invitations/")) return { invitation: { email: "ana@exemplo.com", status: "pending", expires_at: new Date(Date.now() + 86_400_000).toISOString(), workspace_name: "Acme", role_name: "ADMIN", existingUser: true } };
      if (path === "/auth/accept-invitation") return { totp_required: true, user: { id: "u1", email: "ana@exemplo.com", isRoot: false } };
      throw new Error(`rota inesperada ${path}`);
    });
    const user = userEvent.setup();
    render(<InvitationAcceptPage token="tok" />);
    await user.type(await screen.findByLabelText(/Senha atual/), "senha-da-ana");
    await user.click(screen.getByRole("button", { name: /Aceitar/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/login?totp=1"));
    expect(push).not.toHaveBeenCalledWith("/?welcome=invite");
  });

  it("login aberto com ?totp=1 já mostra o passo do código", async () => {
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, search: "?totp=1", pathname: "/login", assign: vi.fn() } });
    render(<Login />);
    expect(await screen.findByLabelText("Código de verificação")).toBeInTheDocument();
  });
});
