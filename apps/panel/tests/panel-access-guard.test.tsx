// @vitest-environment jsdom
// C1 (auditoria P1): com senha temporária, GET /me responde 428. A página
// /alterar-senha não depende de sessão, então o guard não pode exigir /me.
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/alterar-senha",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() })
}));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

import { PanelAccessGuard } from "../components/panel-access-guard";
import RequiredPasswordChangePage from "../app/alterar-senha/page";

afterEach(cleanup);

describe("PanelAccessGuard — troca obrigatória de senha", () => {
  it("renderiza o formulário de /alterar-senha mesmo com /me respondendo 428", async () => {
    apiMock.mockImplementation((path: string) =>
      path === "/me"
        ? Promise.reject(Object.assign(new Error("Altere sua senha para continuar"), { status: 428 }))
        : Promise.resolve({})
    );
    render(<PanelAccessGuard><RequiredPasswordChangePage /></PanelAccessGuard>);
    expect(await screen.findByRole("heading", { name: "Crie uma nova senha" })).toBeInTheDocument();
    expect(screen.queryByText("Não foi possível validar sua sessão")).not.toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalledWith("/me");
  });
});
