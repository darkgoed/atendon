// @vitest-environment jsdom
// R25 — duplicação de fluxos: POST /qualification/flows/:id/duplicate com body
// {name} (contrato strict do backend), fallback client-side em 404/405.
// F4-r1 CAS (WP L1): toda mutação da LISTA envia revisao_base — 0 na criação
// e no fallback de duplicação (PUT upsert), revisão da linha no toggle
// (PATCH oficial {ativo,revisao_base}, sem reescrever nome). Sem token válido
// a ação bloqueia e revalida a listagem (nunca busca a revisão sozinha).
// 409 FLOW_VERSION_CONFLICT revalida e orienta revisar/tentar de novo, sem
// auto-retry. Trava síncrona no run impede clique duplo antes do render.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

type TestFlow = {
  id: string;
  nome: string;
  ativo: boolean;
  definition: unknown;
  atualizado_em: string | null;
  revisao?: number;
};

const baseFlow: TestFlow = { id: "fluxo-a", nome: "Fluxo A", ativo: true, definition: {}, atualizado_em: null, revisao: 3 };

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  mutate: vi.fn(),
  push: vi.fn(),
  perms: { read: true, manage: true },
  flows: [] as TestFlow[],
}));

vi.mock("@/lib/api", () => ({
  api: mocks.api,
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body?: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  },
}));
vi.mock("swr", () => ({ default: () => ({ data: { flows: mocks.flows }, error: undefined, isLoading: false, mutate: mocks.mutate }) }));
vi.mock("@/lib/use-permission", () => ({ usePermission: (permission: string) => (permission === "agent.read" ? mocks.perms.read : mocks.perms.manage) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/flow-editor/flow-model", () => ({ newFlowId: () => "fluxo-novo", starterDefinition: () => ({ starter: true }), triggerSummary: () => "gatilho" }));
vi.mock("@/lib/format", () => ({ formatPanelDateTime: () => "—" }));

import FluxosPage from "@/app/fluxos/page";
import { ApiError } from "@/lib/api";

afterEach(() => {
  cleanup();
  mocks.api.mockReset();
  mocks.mutate.mockReset();
  mocks.push.mockReset();
  mocks.perms.read = true;
  mocks.perms.manage = true;
  mocks.flows = [{ ...baseFlow }];
});

describe("página de fluxos (/fluxos) — duplicar", () => {
  it("duplicates via POST /duplicate with body {name}", async () => {
    mocks.flows = [{ ...baseFlow }];
    mocks.api.mockResolvedValue({ flow: { id: "fluxo-a-copia" } });
    render(<FluxosPage />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicar" }));
    await waitFor(() => {
      expect(mocks.api).toHaveBeenCalledWith("/qualification/flows/fluxo-a/duplicate", {
        method: "POST",
        body: JSON.stringify({ name: "Fluxo A (cópia)" }),
      });
    });
    expect(mocks.mutate).toHaveBeenCalled();
  });

  it("falls back to the PUT clone with revisao_base 0 when the duplicate endpoint is 404", async () => {
    mocks.api.mockRejectedValueOnce(new ApiError("Fluxo não encontrado", 404)).mockResolvedValueOnce(undefined);
    render(<FluxosPage />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicar" }));
    await waitFor(() => {
      expect(mocks.api).toHaveBeenLastCalledWith("/qualification/flows/fluxo-novo", {
        method: "PUT",
        body: JSON.stringify({ nome: "Fluxo A (cópia)", ativo: false, definition: {}, revisao_base: 0 }),
      });
    });
    expect(mocks.api.mock.calls[0][0]).toBe("/qualification/flows/fluxo-a/duplicate");
  });

  it("surfaces non-404/405 duplicate failures instead of cloning silently", async () => {
    mocks.api.mockRejectedValueOnce(new ApiError("Não foi possível duplicar", 500));
    render(<FluxosPage />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicar" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível duplicar"));
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });
});

describe("página de fluxos (/fluxos) — CAS da lista", () => {
  it("creates a new flow with revisao_base 0", async () => {
    mocks.api.mockResolvedValue({ flow: { id: "fluxo-novo" } });
    render(<FluxosPage />);
    fireEvent.click(screen.getByRole("button", { name: "Novo fluxo" }));
    await waitFor(() => {
      expect(mocks.api).toHaveBeenCalledWith("/qualification/flows/fluxo-novo", {
        method: "PUT",
        body: JSON.stringify({ nome: "Novo fluxo", ativo: false, definition: { starter: true }, revisao_base: 0 }),
      });
    });
    expect(mocks.push).toHaveBeenCalledWith("/fluxos/fluxo-novo");
  });

  it("toggles active via PATCH {ativo, revisao_base} using the row revision", async () => {
    mocks.api.mockResolvedValue({ flow: {} });
    render(<FluxosPage />);
    fireEvent.click(screen.getByRole("button", { name: "Desativar" }));
    await waitFor(() => {
      expect(mocks.api).toHaveBeenCalledWith("/qualification/flows/fluxo-a", {
        method: "PATCH",
        body: JSON.stringify({ ativo: false, revisao_base: 3 }),
      });
    });
    expect(mocks.mutate).toHaveBeenCalled();
  });

  it("blocks the toggle without a valid revision token, revalidating instead of fetching it", async () => {
    mocks.flows = [{ id: "fluxo-a", nome: "Fluxo A", ativo: true, definition: {}, atualizado_em: null }];
    render(<FluxosPage />);
    fireEvent.click(screen.getByRole("button", { name: "Desativar" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/desatualizada/i);
    });
    expect(mocks.api).not.toHaveBeenCalled();
    expect(mocks.mutate).toHaveBeenCalled();
  });

  it("on 409 FLOW_VERSION_CONFLICT revalidates the listing and guides a manual retry without auto-retry", async () => {
    mocks.api.mockRejectedValueOnce(new ApiError("Conflito de versão do fluxo", 409, { code: "FLOW_VERSION_CONFLICT", revisao: 4 }));
    render(<FluxosPage />);
    fireEvent.click(screen.getByRole("button", { name: "Desativar" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/revise o estado/i);
    });
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalled();
  });

  it("surfaces non-conflict errors without revalidating", async () => {
    mocks.api.mockRejectedValueOnce(new ApiError("Erro interno", 500));
    render(<FluxosPage />);
    fireEvent.click(screen.getByRole("button", { name: "Desativar" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Erro interno");
    });
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});

describe("página de fluxos (/fluxos) — clique duplo e permissões", () => {
  it("ignores a second synchronous Novo fluxo click while a creation is in flight", () => {
    mocks.flows = [];
    mocks.api.mockImplementation(() => new Promise(() => undefined));
    render(<FluxosPage />);
    const [, emptyStateButton] = screen.getAllByRole("button", { name: "Novo fluxo" });
    if (!emptyStateButton) throw new Error("expected the empty-state Novo fluxo button");
    fireEvent.click(emptyStateButton);
    fireEvent.click(emptyStateButton);
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });

  it("keeps management actions disabled without agent.manage", () => {
    mocks.perms.manage = false;
    render(<FluxosPage />);
    expect((screen.getByRole("button", { name: "Novo fluxo" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Duplicar" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Desativar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the read-permission notice without agent.read", () => {
    mocks.perms.read = false;
    render(<FluxosPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("Você não tem permissão para ver fluxos.");
  });
});
