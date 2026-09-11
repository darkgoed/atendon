// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("swr", () => ({
  default: () => ({
    data: {
      stages: [
        { id: "stage-new", name: "Novo", color: "#000", position: 1, technical_status: "novo", is_default: true },
        { id: "stage-sale", name: "Venda", color: "#000", position: 2, technical_status: "fechado", is_default: false }
      ],
      transitions: [{ from_stage_id: "stage-new", to_stage_id: "stage-sale" }],
      members: [{ id: "member-1", name: "Operador", email: "operator@example.com", status: "active" }]
    }
  })
}));
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => true }));
vi.mock("@/lib/organization", () => ({ useCaseOrganizationEnabled: () => true }));
vi.mock("@/components/pipeline-transition-dialog", async () => {
  const actual = await vi.importActual<typeof import("@/components/pipeline-transition-dialog")>("@/components/pipeline-transition-dialog");
  return actual;
});
vi.mock("@/components/modal-dialog", () => ({ ModalDialog: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));
vi.mock("@/lib/loss-reasons", () => ({ useLossReasons: () => ({ reasons: [], error: null }), lossReasonRequiresNote: () => false }));

import { ConversationStatusPicker } from "@/components/conversation-status-picker";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ConversationStatusPicker operator flow", () => {
  it("uses pipeline members to build and submit a Venda without members.read", async () => {
    const user = userEvent.setup();
    apiMock.mockResolvedValue({ ok: true });
    render(<ConversationStatusPicker
      leadId="lead-1"
      leadName="Ana"
      leadPhone="5511999999999"
      leadResponsibleMemberId={null}
      leadResponsibleEmail={null}
      leadStatus="novo"
      leadUpdatedAt="2026-01-01T00:00:00.000Z"
      pipelineStage={{ id: "stage-new", name: "Novo", color: "#000", position: 1, technical_status: "novo", is_default: true }}
      timezone="UTC"
      onChanged={vi.fn()}
    />);

    await user.click(screen.getByRole("button", { name: /Etapa comercial atual: Novo/i }));
    expect(screen.getByRole("option", { name: "Operador" })).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalledWith("/workspaces/current/members", expect.anything());
    await user.type(screen.getByLabelText("Produto"), "Plano");
    await user.type(screen.getByLabelText("Valor da venda"), "100");
    await user.selectOptions(screen.getByLabelText("Responsável"), "member-1");
    await user.type(screen.getByLabelText("Origem"), "Indicação");
    await user.type(screen.getByLabelText("Modalidade"), "WhatsApp");
    await user.click(screen.getByRole("button", { name: /Confirmar movimento/i }));

    expect(apiMock).toHaveBeenCalledWith("/organization/leads/lead-1/stage", expect.objectContaining({
      method: "PATCH",
      body: expect.stringContaining('"responsavel_member_id":"member-1"')
    }));
  });
});