// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineCard } from "@/components/pipeline-card";
import { PipelineBoard } from "@/components/pipeline-board";
import { PipelineViewPreferences } from "@/components/pipeline-view-preferences";
import {
  DEFAULT_PIPELINE_PREFERENCES,
  type PipelineLead,
  type PipelinePreferences,
  type PipelineStage
} from "@/lib/pipeline";

const lead: PipelineLead = {
  id: "lead-1",
  telefone: "5511999999999",
  nome: "Ana Souza",
  interesse: "Plano Enterprise",
  status: "aguardando_resposta",
  situacao: "aguardando_resposta",
  unidade_nome: "Empresa Confidencial Ltda.",
  origem: "Indicação",
  campanha: "Campanha secreta",
  tags: [{ id: "tag-1", name: "VIP", color: "#000000" }],
  qualificacao: { estrelas: 5, requer_decisao_humana: true },
  responsavel_email: "carlos.lima@example.com",
  commercial_outcome: "nao_avancou",
  sale_value: 98765,
  loss_reason: "Sem orçamento",
  proxima_acao: "Enviar resumo da proposta",
  proxima_acao_em: "2099-01-15T12:00:00.000Z",
  latest_appointment: {
    id: "appointment-1",
    start: "2099-01-20T12:00:00.000Z",
    end: "2099-01-20T13:00:00.000Z",
    status: "scheduled"
  },
  atualizado_em: "2099-01-01T12:00:00.000Z",
  pipeline_stage_id: "stage-legacy"
};

const stages: PipelineStage[] = [
  { id: "stage-base", name: "Em atendimento", color: "var(--info)", position: 1, technical_status: "em_atendimento", is_default: true },
  { id: "stage-legacy", name: "Coluna técnica legada", color: "var(--warn)", position: 2, technical_status: "aguardando_resposta", is_default: false }
];

const cardProps = {
  selected: false,
  canSelect: false,
  canMove: false,
  pending: false,
  timezone: "UTC",
  onToggleSelected: vi.fn(),
  onMove: vi.fn(),
  onDragStart: vi.fn(),
  onDragEnd: vi.fn()
};

function renderCard(preferences: PipelinePreferences = DEFAULT_PIPELINE_PREFERENCES) {
  render(<PipelineCard {...cardProps} lead={lead} preferences={preferences} />);
  return screen.getByRole("article");
}

afterEach(() => cleanup());

describe("PipelineCard e PipelineBoard", () => {
  it("mostra somente os campos padrão do card, sem dados comerciais ou de organização", () => {
    const card = renderCard();

    expect(within(card).getByText("Ana Souza")).toBeVisible();
    expect(within(card).getByText("Interesse: Plano Enterprise")).toBeVisible();
    expect(within(card).getByLabelText("Responsável: carlos.lima")).toBeVisible();
    expect(within(card).getByText("Situação: Aguardando resposta")).toBeVisible();
    expect(within(card).getByText("Enviar resumo da proposta")).toBeVisible();
    expect(within(card).queryByText("Empresa Confidencial Ltda.")).not.toBeInTheDocument();
    expect(within(card).queryByText("R$ 98.765")).not.toBeInTheDocument();
    expect(within(card).queryByText("VIP")).not.toBeInTheDocument();
    expect(within(card).queryByText("Sem orçamento")).not.toBeInTheDocument();
    expect(within(card).queryByText("Indicação")).not.toBeInTheDocument();
    expect(within(card).queryByText("5 de 5 na qualificação")).not.toBeInTheDocument();
  });

  it("mantém situação como chip sem mudar a coluna técnica do lead", () => {
    render(
      <PipelineBoard
        stages={stages}
        leads={[lead]}
        allowedTransitions={new Set()}
        legacy={false}
        showAllStages
        loading={false}
        hasActiveFilters={false}
        canMove={false}
        canSelect={false}
        selectedIds={new Set()}
        pendingLeadIds={new Set()}
        preferences={DEFAULT_PIPELINE_PREFERENCES}
        timezone="UTC"
        onToggleSelected={vi.fn()}
        onMoveRequest={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    const technicalColumn = screen.getByRole("region", { name: "Coluna técnica legada, 1 lead(s)" });
    expect(within(technicalColumn).getByRole("article")).toBeInTheDocument();
    expect(within(technicalColumn).getByText("Situação: Aguardando resposta")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Em atendimento, 0 lead(s)" })).queryByRole("article")).toBeNull();
  });

  it("permite optar pelos campos extras sem deixar de exercitar o card real", () => {
    const preferences: PipelinePreferences = {
      ...DEFAULT_PIPELINE_PREFERENCES,
      visibleFields: ["ownership", "origin", "qualification", "nextMeeting", "nextAction", "stalled"]
    };
    const card = renderCard(preferences);

    expect(within(card).getByText("Indicação · Campanha secreta")).toBeVisible();
    expect(within(card).getByLabelText("5 de 5 na qualificação")).toBeVisible();
    expect(within(card).getByText("20/01/2099, 12:00")).toBeVisible();
    expect(within(card).getByText("Enviar resumo da proposta")).toBeVisible();
  });

  it("expõe preferências opt-in por controles acessíveis e atualiza a seleção", async () => {
    const user = userEvent.setup();
    function PreferencesHarness() {
      const [preferences, setPreferences] = useState(DEFAULT_PIPELINE_PREFERENCES);
      return <>
        <PipelineViewPreferences value={preferences} onChange={setPreferences} />
        <PipelineCard {...cardProps} lead={lead} preferences={preferences} />
      </>;
    }

    render(<PreferencesHarness />);
    const trigger = screen.getByRole("button", { name: "Exibição" });
    expect(trigger).toHaveAttribute("aria-haspopup", "true");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const origin = screen.getByRole("checkbox", { name: "Origem e campanha" });
    const qualification = screen.getByRole("checkbox", { name: "Qualificação" });
    expect(origin).not.toBeChecked();
    expect(qualification).not.toBeChecked();
    await user.click(origin);
    await user.click(qualification);
    expect(origin).toBeChecked();
    expect(qualification).toBeChecked();
    expect(screen.getByText("Indicação · Campanha secreta")).toBeVisible();
    expect(screen.getByLabelText("5 de 5 na qualificação")).toBeVisible();
  });
});
