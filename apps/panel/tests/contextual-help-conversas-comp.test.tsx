// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorToasts } from "@/components/error-toasts";

// Radix Popover/Tooltip medem o balão com ResizeObserver, ausente no jsdom.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("swr", () => ({
  // Só o seletor de status precisa de dados; as outras chaves ficam sem dados.
  default: (key: unknown) => ({
    data: typeof key === "string" && key.startsWith("/organization/pipeline")
      ? {
          stages: [
            { id: "stage-new", name: "Novo", color: "#000", position: 1, technical_status: "novo", is_default: true },
            { id: "stage-sale", name: "Venda", color: "#000", position: 2, technical_status: "fechado", is_default: false }
          ],
          transitions: [{ from_stage_id: "stage-new", to_stage_id: "stage-sale" }],
          members: [{ id: "member-1", name: "Operador", email: "operator@example.com", status: "active" }]
        }
      : undefined
  })
}));
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => true }));
vi.mock("@/lib/organization", () => ({ useCaseOrganizationEnabled: () => true }));
vi.mock("@/components/modal-dialog", () => ({ ModalDialog: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));
vi.mock("@/lib/loss-reasons", () => ({ useLossReasons: () => ({ reasons: [], error: null }), lossReasonRequiresNote: () => false }));

import { ConversationComposer, type ConversationComposerCapabilities } from "@/components/conversation-composer";
import { ConversationNotes } from "@/components/conversation-notes";
import { ConversationStatusPicker } from "@/components/conversation-status-picker";

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function whatsappCapabilities(): ConversationComposerCapabilities {
  return {
    channel: "whatsapp",
    can_send: true,
    reason: null,
    window_expires_at: null,
    text: true,
    image: true,
    audio: true,
    video: false,
    document: true
  };
}

function statusPickerProps() {
  return {
    leadId: "lead-1",
    leadName: "Ana",
    leadPhone: "5511999999999",
    leadResponsibleMemberId: null,
    leadResponsibleEmail: null,
    leadStatus: "novo",
    leadUpdatedAt: "2026-01-01T00:00:00.000Z",
    pipelineStage: { id: "stage-new", name: "Novo", color: "#000", position: 1, technical_status: "novo", is_default: true },
    timezone: "UTC"
  };
}

describe("ajuda contextual do pacote conversas-comp", () => {
  it("composer: ajuda compatível abre no hover/foco e fecha com Esc; botão de IA mantém o nome", async () => {
    const user = userEvent.setup();
    render(<ConversationComposer conversationId="conv-help" capabilities={whatsappCapabilities()} onError={vi.fn()} onSent={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Gerar sugestão da IA" })).toBeInTheDocument();
    const trigger = screen.getByRole("textbox", { name: "Mensagem" });
    expect(screen.queryByRole("group", { name: "Respostas rápidas" })).toBeNull();
    expect(trigger).toHaveAccessibleDescription(/no começo da mensagem.*preenchidas na inserção/);
    for (const text of ["Enviar proposta", "Confirmar horário", "Pedir CNPJ"]) {
      expect(screen.queryByText(text)).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /^Ajuda:/ })).toBeNull();
    await user.hover(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Digite / para escolher uma resposta rápida.");
    await user.unhover(trigger);
    act(() => trigger.focus());
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Digite / para escolher uma resposta rápida.");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(trigger).toHaveAccessibleDescription(/preenchidas na inserção/);
    expect(screen.getByRole("button", { name: "Gerar sugestão da IA" })).toBeEnabled();
  });

  it("nota interna fechada: ajuda de visibilidade ao lado do botão, sem buscar nada", () => {
    render(<ConversationNotes conversationId="conv-help" />);
    expect(screen.getByRole("button", { name: "Nota interna" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nota interna" })).toHaveAccessibleDescription("Apenas a equipe vê estas notas.");
    expect(screen.queryByRole("button", { name: "Ajuda: Nota interna" })).toBeNull();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("mover o lead mostra o flash 'Lead movido para Venda' só no sucesso", async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue({ ok: true });
    render(<><ErrorToasts /><ConversationStatusPicker {...statusPickerProps()} onChanged={vi.fn()} /></>);

    await user.click(screen.getByRole("button", { name: /Etapa comercial atual: Novo/i }));
    await user.type(screen.getByLabelText("Produto"), "Plano");
    await user.type(screen.getByLabelText("Valor da venda"), "100");
    await user.selectOptions(screen.getByLabelText("Responsável"), "member-1");
    await user.type(screen.getByLabelText("Origem"), "Indicação");
    await user.type(screen.getByLabelText("Modalidade"), "WhatsApp");
    await user.click(screen.getByRole("button", { name: /Confirmar movimento/i }));

    await waitFor(() => expect(screen.getByText("Lead movido para Venda")).toBeInTheDocument());
    expect(document.querySelectorAll(".error-toast")).toHaveLength(1);
  });

  it("falha ao mover o lead não mostra flash", async () => {
    const user = userEvent.setup();
    apiMock.mockRejectedValueOnce(new Error("falhou"));
    render(<><ErrorToasts /><ConversationStatusPicker {...statusPickerProps()} onChanged={vi.fn()} /></>);

    await user.click(screen.getByRole("button", { name: /Etapa comercial atual: Novo/i }));
    await user.type(screen.getByLabelText("Produto"), "Plano");
    await user.type(screen.getByLabelText("Valor da venda"), "100");
    await user.selectOptions(screen.getByLabelText("Responsável"), "member-1");
    await user.type(screen.getByLabelText("Origem"), "Indicação");
    await user.type(screen.getByLabelText("Modalidade"), "WhatsApp");
    await user.click(screen.getByRole("button", { name: /Confirmar movimento/i }));

    await waitFor(() => expect(apiMock).toHaveBeenCalled());
    expect(screen.queryByText("Lead movido para Venda")).toBeNull();
  });
});
