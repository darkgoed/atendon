// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PipelineBoard, PipelineColumn } from "../components/pipeline-board";
import { PipelineList } from "../components/pipeline-list";
import { PipelineTransitionDialog } from "../components/pipeline-transition-dialog";
import type { PipelineLead, PipelineStage } from "../lib/pipeline";

const ROOT = join(__dirname, "..");
function source(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

function stage(overrides: Partial<PipelineStage> & { id: string; name: string }): PipelineStage {
  return { technical_status: "novo", position: 1, color: "#3366cc", ...overrides } as PipelineStage;
}

function lead(id: string, stageId: string | null): PipelineLead {
  return { id, telefone: "5511999999999", nome: "Lead " + id, status: "novo", atualizado_em: "2026-01-01T00:00:00Z", pipeline_stage_id: stageId } as PipelineLead;
}

const preferences: import("../lib/pipeline").PipelinePreferences = { density: "compact", visibleFields: ["ownership", "nextAction"], auxiliaryBadges: [], columnWidth: 280 };

const noop = () => undefined;
const emptySet = new Set<string>();

function columnElement(stageValue: PipelineStage) {
  return React.createElement(PipelineColumn, {
    key: stageValue.id,
    stage: stageValue,
    leads: [],
    loading: false,
    canMove: false,
    canSelect: false,
    selectedIds: emptySet,
    pendingLeadIds: emptySet,
    preferences,
    timezone: "UTC",
    dragging: null,
    droppable: false,
    dropActive: false,
    onGrabPointerDown: noop,
    onGrabKeyDown: noop,
    onToggleSelected: noop,
    onMoveRequest: noop
  });
}

function BoardHarness(props: { from: PipelineStage; stages: PipelineStage[]; allowed: Set<string> }) {
  return React.createElement(PipelineBoard, {
    stages: props.stages,
    leads: [lead("l1", props.from.id)],
    allowedTransitions: props.allowed,
    legacy: false,
    showAllStages: true,
    loading: false,
    hasActiveFilters: false,
    canMove: true,
    canSelect: false,
    selectedIds: emptySet,
    pendingLeadIds: emptySet,
    preferences,
    timezone: "UTC",
    onToggleSelected: noop,
    onMoveRequest: noop,
    onRetry: noop
  });
}

// O drag agora é por pointer events (referência); um clique sintático de
// pointerdown com botão esquerdo é a captura. MouseEvent carrega button/
// clientX mesmo onde jsdom não define PointerEvent.
function grabFirstLead() {
  const card = document.querySelector('[data-pipeline-card="l1"]') as HTMLElement;
  expect(card).toBeTruthy();
  fireEvent(card, new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 100, clientY: 100 }));
}

describe("pipeline free movement UI (R3/R4/R5)", () => {
  afterEach(cleanup);

  it("page.tsx keeps free pairs when enforce_transitions === false and passes the flag to settings", () => {
    const page = source("app/pipeline/page.tsx");
    expect(page.includes("enforce_transitions === false")).toBe(true);
    // Free mode: every ordered pair of configured stages is allowed.
    expect(page.includes("flatMap((source)")).toBe(true);
    // The flag reaches PipelineSettings so the toggle reflects the tenant mode.
    expect(page.includes("enforceTransitions={pipelineData?.enforce_transitions}")).toBe(true);
  });

  it("pipeline-settings.tsx persists the toggle via PATCH /organization/pipeline/settings", () => {
    const settings = source("components/pipeline-settings.tsx");
    expect(settings.includes("/organization/pipeline/settings")).toBe(true);
    expect(settings.includes("enforce_transitions")).toBe(true);
    expect(settings.includes("Movimentação livre entre qualquer etapa")).toBe(true);
  });

  it("board render: ai_follow_up column is NEVER droppable even with an allowed transition edge", () => {
    const sourceStage = stage({ id: "src", name: "Novo" });
    const aiStage = stage({ id: "ai", name: "Follow-up 1", operational_kind: "ai_follow_up" });
    // Sabotage guard: even granting the edge explicitly, the AI column must refuse the drop.
    const { container } = render(React.createElement(BoardHarness, { from: sourceStage, stages: [sourceStage, aiStage], allowed: new Set(["src:ai"]) }));
    grabFirstLead();
    const aiColumn = container.querySelector('[aria-label="Follow-up 1, 0 lead(s)"]');
    expect(aiColumn).toBeTruthy();
    expect(aiColumn!.getAttribute("data-drop-state")).not.toBe("available");
    expect(aiColumn!.getAttribute("data-drop-state")).not.toBe("active");
    // Pill present for every stage, including AI.
    expect(aiColumn!.textContent).toContain("IA");
    cleanup();
    // Manual stage under the same harness IS droppable (free mode edge granted).
    const manualStage = stage({ id: "manual", name: "Fechado" });
    const { container: container2 } = render(React.createElement(BoardHarness, { from: sourceStage, stages: [sourceStage, manualStage], allowed: new Set(["src:manual"]) }));
    grabFirstLead();
    const manualColumn = container2.querySelector('[aria-label="Fechado, 0 lead(s)"]');
    expect(manualColumn).toBeTruthy();
    expect(manualColumn!.getAttribute("data-drop-state")).toBe("available");
    expect(manualColumn!.textContent).toContain("Manual");
  });

  it("board source keeps the ai_follow_up guard in the droppable calculation", () => {
    const board = source("components/pipeline-board.tsx");
    expect(board.includes('operational_kind !== "ai_follow_up"')).toBe(true);
  });

  it("column pills: call shows Ligação, unnamed operational_kind shows Manual, aria-label intact", () => {
    const callStage = stage({ id: "call", name: "Ligação", operational_kind: "call" });
    const plainStage = stage({ id: "plain", name: "Proposta" });
    const { container } = render(React.createElement("div", null, [columnElement(callStage), columnElement(plainStage)]));
    expect(container.querySelector('[data-stage-kind="call"]')!.textContent).toBe("Ligação");
    expect(container.querySelector('[data-stage-kind="manual"]')!.textContent).toBe("Manual");
    expect(container.querySelector('[aria-label="Ligação, 0 lead(s)"]')).toBeTruthy();
  });

  it("list and transition dialog render the automation indicator", () => {
    const aiStage = stage({ id: "ai", name: "Follow-up 1", operational_kind: "ai_follow_up" });
    const callStage = stage({ id: "call", name: "Ligação", operational_kind: "call" });
    const manualStage = stage({ id: "manual", name: "Proposta" });
    render(React.createElement(PipelineList, {
      leads: [lead("l1", "ai"), lead("l2", "call")],
      stages: [aiStage, callStage],
      members: [],
      legacy: false,
      loading: false,
      canMove: false,
      canSelect: false,
      selectedIds: emptySet,
      pendingLeadIds: emptySet,
      onToggleSelected: noop,
      onMoveRequest: noop
    }));
    expect(screen.getByText("IA")).toBeTruthy();
    cleanup();

    render(React.createElement(PipelineTransitionDialog, {
      lead: lead("l1", "src"),
      targets: [aiStage, callStage, manualStage],
      pending: false,
      timezone: "UTC",
      onClose: noop,
      onSubmit: noop
    }));
    const options = Array.from(document.querySelectorAll("option"));
    expect(options.some((option) => (option.textContent ?? "").includes("Follow-up 1") && (option.textContent ?? "").includes("IA"))).toBe(true);
    expect(options.some((option) => (option.textContent ?? "").includes("Ligação") && (option.textContent ?? "").includes("· Ligação"))).toBe(true);
    expect(options.some((option) => (option.textContent ?? "").includes("Proposta") && (option.textContent ?? "").includes("· Manual"))).toBe(true);
  });
});
