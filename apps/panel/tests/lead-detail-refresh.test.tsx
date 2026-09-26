// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";

const { apiMock, signalHandlers, router } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  router: { replace: () => undefined, push: () => undefined },
  signalHandlers: [] as Array<(signal: { type: string }) => void>
}));

vi.mock("@/lib/api", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  }
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "lead-1" }),
  useRouter: () => router
}));
vi.mock("@/lib/realtime", () => ({
  useRealtimeSignals: (input: { onSignal: (signal: { type: string }) => void }) => { signalHandlers.push(input.onSignal); }
}));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => true }));
vi.mock("@/lib/loss-reasons", () => ({ useLossReasons: () => ({ reasons: [] }), lossReasonLabel: () => "" }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/lead-notes", () => ({ LeadNotes: () => null }));
vi.mock("@/components/lead-history-tabs", () => ({ LeadEventHistory: () => null }));
vi.mock("@/components/lead-custom-fields", () => ({ LeadCustomFields: () => null }));

import LeadDetail from "../app/contatos/[id]/page";

const SESSION = {
  user: { id: "user-1", name: "Marina", email: "marina@exemplo.com", isRoot: false },
  activeWorkspace: { id: "ws-1", name: "AtendON", timezone: "America/Sao_Paulo" },
  workspaces: [],
  permissions: [],
  actorScope: "workspace"
};

// Cada GET devolve um objeto novo (como o fetch real), com o mesmo conteúdo.
function leadResponse() {
  return {
    lead: { nome: "Aurora", telefone: "+5511988881200", status: "em_atendimento" },
    qualificacao: { estrelas: 3, resumo: null, avaliado_em: null, requer_decisao_humana: false },
    agendamentos: [],
    status_permitidos: ["qualificado", "fechado"],
    timezone: "America/Sao_Paulo"
  };
}

function followUpResponse() {
  return {
    follow_up: { responsavel: null, proxima_acao: "Ligar", proxima_acao_em: "2026-10-01T15:00:00.000Z", timezone: "America/Sao_Paulo" },
    notas: [],
    responsaveis: []
  };
}

beforeEach(() => {
  signalHandlers.length = 0;
  apiMock.mockImplementation((path: string) => {
    if (path === "/me") return Promise.resolve(SESSION);
    if (path === "/scheduling/leads/lead-1") return Promise.resolve(leadResponse());
    if (path === "/scheduling/leads/lead-1/follow-up") return Promise.resolve(followUpResponse());
    return Promise.resolve({});
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <LeadDetail />
    </SWRConfig>
  );
}

async function fireRefresh() {
  const leadGets = () => apiMock.mock.calls.filter(([path]) => path === "/scheduling/leads/lead-1").length;
  const before = leadGets();
  await act(async () => {
    signalHandlers.at(-1)?.({ type: "conversation.messages.changed" });
  });
  await waitFor(() => expect(leadGets()).toBeGreaterThan(before));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("detalhe do contato: recarga em segundo plano não reseta formulários (C5)", () => {
  it("mantém o próximo status escolhido após um refresh idêntico e envia o status escolhido", async () => {
    const user = userEvent.setup();
    renderPage();
    const select = await screen.findByLabelText("Próximo status");
    await user.selectOptions(select, "fechado");
    await fireRefresh();
    expect(screen.getByLabelText("Próximo status")).toHaveValue("fechado");
    await user.click(screen.getByRole("button", { name: "Atualizar status" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      "/scheduling/leads/lead-1/status",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ status: "fechado" }) })
    ));
  });

  it("não sobrescreve a próxima ação sendo digitada quando o servidor não mudou", async () => {
    const user = userEvent.setup();
    renderPage();
    const action = await screen.findByLabelText("Próxima ação");
    await waitFor(() => expect(action).toHaveValue("Ligar"));
    await user.type(action, " amanhã");
    await fireRefresh();
    expect(screen.getByLabelText("Próxima ação")).toHaveValue("Ligar amanhã");
  });

  it("não apaga a mensagem de erro de uma ação na recarga em segundo plano", async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/me") return Promise.resolve(SESSION);
      if (path === "/scheduling/leads/lead-1") return Promise.resolve(leadResponse());
      if (path === "/scheduling/leads/lead-1/follow-up") return Promise.resolve(followUpResponse());
      if (path === "/scheduling/leads/lead-1/status" && init?.method === "PATCH") return Promise.reject(new Error("Transição inválida"));
      return Promise.resolve({});
    });
    renderPage();
    await screen.findByLabelText("Próximo status");
    await user.click(screen.getByRole("button", { name: "Atualizar status" }));
    expect(await screen.findByText("Transição inválida")).toBeInTheDocument();
    await fireRefresh();
    expect(screen.getByText("Transição inválida")).toBeInTheDocument();
  });

  it("atualiza a próxima ação quando o servidor muda e o campo não foi editado", async () => {
    renderPage();
    const action = await screen.findByLabelText("Próxima ação");
    await waitFor(() => expect(action).toHaveValue("Ligar"));
    apiMock.mockImplementation((path: string) => {
      if (path === "/me") return Promise.resolve(SESSION);
      if (path === "/scheduling/leads/lead-1") return Promise.resolve(leadResponse());
      if (path === "/scheduling/leads/lead-1/follow-up") return Promise.resolve({ ...followUpResponse(), follow_up: { ...followUpResponse().follow_up, proxima_acao: "Enviar proposta" } });
      return Promise.resolve({});
    });
    await fireRefresh();
    await waitFor(() => expect(screen.getByLabelText("Próxima ação")).toHaveValue("Enviar proposta"));
  });
});
