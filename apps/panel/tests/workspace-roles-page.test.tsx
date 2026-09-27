// @vitest-environment jsdom
// Auditoria P1 (suspeita confirmada): /workspace/roles aberto por link direto
// não tinha a guarda de /configuracoes/funcoes e o não-ROOT recebia o 403 de
// GET /workspaces/current/roles (requireRootWorkspace) como tela de erro.
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

import WorkspaceRolesPage from "../app/workspace/roles/page";

afterEach(cleanup);

describe("/workspace/roles", () => {
  it("não chama a API de funções para quem não está no workspace ROOT", async () => {
    const session = { user: { id: "u1", email: "ana@exemplo.com", isRoot: false }, activeWorkspace: { id: "ws-1", name: "Acme" }, workspaces: [], permissions: ["members.manage"], actorScope: "workspace" };
    apiMock.mockImplementation(async (path: string) => path === "/me" ? session : { roles: [], permissions: [] });
    render(<SWRConfig value={{ provider: () => new Map() }}><WorkspaceRolesPage /></SWRConfig>);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/me"));
    expect(apiMock).not.toHaveBeenCalledWith("/workspaces/current/roles");
  });
});
