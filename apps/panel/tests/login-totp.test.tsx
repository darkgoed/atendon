// @vitest-environment jsdom
// C10 (auditoria P1): com 2FA ativo o /auth/login só emite o desafio
// (totp_required). O painel precisa pedir o código e concluir em
// POST /auth/totp/verify antes de entrar; senão fica em loop com /login.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMock }));

import Login from "../app/login/page";

const assign = vi.fn();

beforeEach(() => {
  assign.mockReset();
  apiMock.mockReset();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign, pathname: "/login" } });
});
afterEach(cleanup);

describe("login com verificação em duas etapas", () => {
  it("pede o código após totp_required e só entra depois de /auth/totp/verify", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/auth/login") return { totp_required: true, user: { id: "u1", email: "ana@exemplo.com", isRoot: false } };
      if (path === "/auth/totp/verify") return { user: { id: "u1", email: "ana@exemplo.com", isRoot: false, mustChangePassword: false } };
      throw new Error(`rota inesperada ${path}`);
    });
    const user = userEvent.setup();
    render(<Login />);
    await user.type(screen.getByLabelText("E-mail"), "ana@exemplo.com");
    await user.type(screen.getByLabelText("Senha"), "senha-da-ana");
    await user.click(screen.getByRole("button", { name: "Entrar" }));

    const code = await screen.findByLabelText("Código de verificação");
    expect(assign).not.toHaveBeenCalled();
    await user.type(code, "123456");
    await user.click(screen.getByRole("button", { name: "Verificar e entrar" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(apiMock).toHaveBeenCalledWith("/auth/totp/verify", { method: "POST", body: JSON.stringify({ code: "123456" }) });
  });

  it("mostra o erro de código inválido e continua no passo do código", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/auth/login") return { totp_required: true, user: { id: "u1", email: "ana@exemplo.com", isRoot: false } };
      throw new Error("Código inválido");
    });
    const user = userEvent.setup();
    render(<Login />);
    await user.type(screen.getByLabelText("E-mail"), "ana@exemplo.com");
    await user.type(screen.getByLabelText("Senha"), "senha-da-ana");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    await user.type(await screen.findByLabelText("Código de verificação"), "000000");
    await user.click(screen.getByRole("button", { name: "Verificar e entrar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Código inválido");
    expect(screen.getByLabelText("Código de verificação")).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});
