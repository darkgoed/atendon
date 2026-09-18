// @vitest-environment jsdom
// R9/R10 — card colapsável do histórico na página do contato: colapsado por
// padrão (nada é carregado fechado), abas locais Histórico | Atividades, 404 →
// seção vazia e contratos da spec.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.body = null;
    }
  }
  return { ApiError, api: vi.fn() };
});

import { api, ApiError } from "@/lib/api";
import { LeadEventHistory } from "@/components/lead-history-tabs";

const apiMock = api as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  apiMock.mockReset();
});

afterEach(() => cleanup());

describe("LeadEventHistory", () => {
  it("stays collapsed by default and loads nothing until expanded", () => {
    render(<LeadEventHistory leadId="lead-a" timezone="UTC" />);
    const header = screen.getByRole("button", { name: /Histórico do lead/ });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("tab", { name: "Histórico" })).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("expands with local tabs and consumes the timeline contract", async () => {
    apiMock.mockResolvedValue({
      items: [
        { type: "lead.created", at: "2026-09-18T10:00:00Z", actor: "sistema", detail: null },
        { type: "ai.qualification", at: "2026-09-18T09:00:00Z", actor: "IA", detail: { source: "ai", resumo: "Lead quente" } }
      ],
      page: { next_cursor: null, has_more: false }
    });
    render(<LeadEventHistory leadId="lead-b" timezone="UTC" />);
    fireEvent.click(screen.getByRole("button", { name: /Histórico do lead/ }));
    expect(screen.getByRole("tab", { name: "Histórico" }).getAttribute("aria-selected")).toBe("true");

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/scheduling/leads/lead-b/timeline?limit=20"));
    await waitFor(() => expect(screen.getByText("Lead criado")).toBeTruthy());
    // Fontes visualmente separadas: badge de IA distinto do badge de robô.
    await waitFor(() => expect(screen.getByText("IA")).toBeTruthy());
    expect(screen.getByText("Robô")).toBeTruthy();
    expect(screen.getByText("Lead quente")).toBeTruthy();
  });

  it("treats a 404 timeline contract as the empty section", async () => {
    apiMock.mockRejectedValue(new ApiError("não encontrado", 404));
    render(<LeadEventHistory leadId="lead-c" timezone="UTC" />);
    fireEvent.click(screen.getByRole("button", { name: /Histórico do lead/ }));
    await waitFor(() => expect(screen.getByText("Sem eventos ainda.")).toBeTruthy());
  });

  it("switches to the activities view and accepts either backend contract", async () => {
    // Contrato dedicado /activities existe → usado diretamente.
    apiMock.mockResolvedValue({
      items: [{ type: "transfer.requested", at: "2026-09-18T10:00:00Z", actor: "ana@x.com" }],
      page: { next_cursor: null, has_more: false }
    });
    render(<LeadEventHistory leadId="lead-d" timezone="UTC" />);
    fireEvent.click(screen.getByRole("button", { name: /Histórico do lead/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Atividades" }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/scheduling/leads/lead-d/activities?limit=20"));
    await waitFor(() => expect(screen.getByText("Transferência para atendimento humano")).toBeTruthy());

    cleanup();
    apiMock.mockReset();
    // Contrato dedicado ausente → fallback ?view=activities na mesma API.
    apiMock.mockImplementation((url: string) =>
      url.includes("/activities?") ? Promise.reject(new ApiError("não encontrado", 404)) : Promise.reject(new ApiError("não encontrado", 404))
    );
    render(<LeadEventHistory leadId="lead-e" timezone="UTC" />);
    fireEvent.click(screen.getByRole("button", { name: /Histórico do lead/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Atividades" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/scheduling/leads/lead-e/timeline?limit=20&view=activities"));
    await waitFor(() => expect(screen.getByText("Sem atividades ainda.")).toBeTruthy());
  });
});
