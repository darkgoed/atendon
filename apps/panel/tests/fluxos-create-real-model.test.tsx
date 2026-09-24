// @vitest-environment jsdom
// Criação de fluxo pela lista com o flow-model REAL (newFlowId/starterDefinition
// sem mock): só a rede (@/lib/api → api) é simulada; SWR e usePermission reais
// sobre /me. Par do backend apps/backend/tests/flow-create-panel.integration.test.ts
// (PUT do starter real → 201; sem agent.manage → 403). Operador sem
// agent.manage precisa ver o MOTIVO do "Novo fluxo" desabilitado (não um CTA
// inerte sem explicação); gestor cria com o payload real e navega ao editor.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";

const mocks = vi.hoisted(() => ({ api: vi.fn(), push: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api: mocks.api }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));

import FluxosPage from "@/app/fluxos/page";
import { starterDefinition } from "@/components/flow-editor/flow-model";

const MOTIVO = /não tem permissão para criar/i;

/* Rede simulada: sessão /me sem root, listagem vazia e o PUT de criação. */
function network(permissions: string[]) {
  mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/me") return { user: { isRoot: false }, actorScope: "workspace", rootWorkspaceAccess: false, permissions };
    if (url === "/qualification/flows" && !init) return { flows: [] };
    if (url.startsWith("/qualification/flows/") && init?.method === "PUT") return { flow: {} };
    throw new Error(`rede inesperada: ${init?.method ?? "GET"} ${url}`);
  });
}

async function renderEmptyList() {
  render(<SWRConfig value={{ provider: () => new Map() }}><FluxosPage /></SWRConfig>);
  await screen.findByText("Nenhum fluxo");
}

afterEach(() => {
  cleanup();
  mocks.api.mockReset();
  mocks.push.mockReset();
});

describe("/fluxos — criação com o flow-model real", () => {
  it("operador sem agent.manage vê o motivo do Novo fluxo desabilitado", async () => {
    network(["agent.read"]);
    await renderEmptyList();
    const cta = screen.getByRole("button", { name: "Novo fluxo" });
    expect(cta).toBeDisabled();
    expect(screen.getByText(MOTIVO)).toBeVisible();
    expect(cta).toHaveAccessibleDescription(MOTIVO);
    expect(mocks.api.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("gestor com agent.manage cria com o starter real e navega ao editor", async () => {
    network(["agent.read", "agent.manage"]);
    await renderEmptyList();
    expect(screen.queryByText(MOTIVO)).not.toBeInTheDocument();
    const cta = screen.getAllByRole("button", { name: "Novo fluxo" })[0];
    if (!cta) throw new Error("CTA Novo fluxo ausente");
    fireEvent.click(cta);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledTimes(1));
    const put = mocks.api.mock.calls.find(([, init]) => init?.method === "PUT");
    const id = String(put?.[0]).replace("/qualification/flows/", "");
    expect(id).toMatch(/^fluxo-[a-z0-9]{12}$/);
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ nome: "Novo fluxo", ativo: false, definition: starterDefinition(), revisao_base: 0 });
    expect(mocks.push).toHaveBeenCalledWith(`/fluxos/${id}`);
  });
});
