// @vitest-environment jsdom
// R25 — duplicação de fluxos: POST /qualification/flows/:id/duplicate com body
// {name} (contrato strict do backend), fallback client-side em 404/405.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  mutate: vi.fn(),
  flows: [{ id: "fluxo-a", nome: "Fluxo A", ativo: true, definition: {}, atualizado_em: null }],
}));

vi.mock("@/lib/api", () => ({
  api: mocks.api,
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
}));
vi.mock("swr", () => ({ default: () => ({ data: { flows: mocks.flows }, error: undefined, isLoading: false, mutate: mocks.mutate }) }));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => true }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/flow-editor/flow-model", () => ({ newFlowId: () => "fluxo-novo", starterDefinition: () => ({}), triggerSummary: () => "gatilho" }));
vi.mock("@/lib/format", () => ({ formatPanelDateTime: () => "—" }));

import FluxosPage from "@/app/fluxos/page";

afterEach(() => {
  cleanup();
  mocks.api.mockReset();
  mocks.mutate.mockReset();
  mocks.flows = [{ id: "fluxo-a", nome: "Fluxo A", ativo: true, definition: {}, atualizado_em: null }];
});

describe("página de fluxos (/fluxos) — duplicar", () => {
  it("duplicates via POST /duplicate with body {name}", async () => {
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

  it("falls back to the PUT clone when the duplicate endpoint is 404", async () => {
    const { ApiError } = await import("@/lib/api");
    mocks.api.mockRejectedValueOnce(new ApiError("Fluxo não encontrado", 404)).mockResolvedValueOnce(undefined);
    render(<FluxosPage />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicar" }));
    await waitFor(() => {
      expect(mocks.api).toHaveBeenLastCalledWith("/qualification/flows/fluxo-novo", {
        method: "PUT",
        body: JSON.stringify({ nome: "Fluxo A (cópia)", ativo: false, definition: {} }),
      });
    });
    expect((mocks.api as Mock).mock.calls[0][0]).toBe("/qualification/flows/fluxo-a/duplicate");
  });

  it("surfaces non-404/405 duplicate failures instead of cloning silently", async () => {
    const { ApiError } = await import("@/lib/api");
    mocks.api.mockRejectedValueOnce(new ApiError("Não foi possível duplicar", 500));
    render(<FluxosPage />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicar" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível duplicar"));
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });
});
