// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PipelineBoard } from "../components/pipeline-board";
import { DEFAULT_PIPELINE_PREFERENCES, type PipelineLead, type PipelineStage } from "../lib/pipeline";

/*
  Mecânica kanban da referência sobre a PipelineBoard AtendON:
  - drag por pointer events com overlay/placeholder (slot calculado);
  - teclado: espaço pega, setas movem, espaço solta, Esc devolve;
  - governança: mesmo-coluna = no-op, coluna não permitida devolve,
    ai_follow_up nunca recebe slot;
  - ScrollRail aparece quando o quadro transborda.

  jsdom não tem layout: a geometria usada pelo snapshot/slotAt é stubada por
  data-attribute (data-pipeline-column/list/card).
*/

type Box = { x: number; y: number; w: number; h: number };

const CARD_H = 56;
const GAP = 8;

const GEOM: Record<string, Box> = {
  "column:A": { x: 0, y: 0, w: 280, h: 520 },
  "column:B": { x: 300, y: 0, w: 280, h: 520 },
  "column:AI": { x: 600, y: 0, w: 280, h: 520 },
  "list:A": { x: 2, y: 120, w: 276, h: 380 },
  "list:B": { x: 302, y: 120, w: 276, h: 380 },
  "list:AI": { x: 602, y: 120, w: 276, h: 380 },
  "card:l1": { x: 2, y: 120, w: 276, h: CARD_H },
  "card:l2": { x: 2, y: 120 + CARD_H + GAP, w: 276, h: CARD_H },
  "card:l3": { x: 302, y: 120, w: 276, h: CARD_H }
};

function rectFor(key: string | null): DOMRect {
  const g = key ? GEOM[key] : undefined;
  if (!g) {
    return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
  }
  return { x: g.x, y: g.y, width: g.w, height: g.h, top: g.y, left: g.x, right: g.x + g.w, bottom: g.y + g.h, toJSON: () => ({}) } as DOMRect;
}

function stage(id: string, name: string, overrides: Partial<PipelineStage> = {}): PipelineStage {
  return { id, name, color: "var(--primary)", position: 1, technical_status: "novo", is_default: true, ...overrides } as PipelineStage;
}

function lead(id: string, stageId: string): PipelineLead {
  return { id, telefone: "5511999999999", nome: "Lead " + id, status: "novo", atualizado_em: "2026-01-01T00:00:00Z", pipeline_stage_id: stageId } as PipelineLead;
}

const STAGES = [
  stage("A", "Novo"),
  stage("B", "Fechado"),
  stage("AI", "Follow-up 1", { operational_kind: "ai_follow_up" })
];

function leadL1(): PipelineLead {
  return lead("l1", "A");
}

function BoardHarness(props: {
  allowed?: Set<string>;
  onMoveRequest?: (lead: PipelineLead, target?: PipelineStage) => void;
  canMove?: boolean;
  pendingLeadIds?: Set<string>;
}) {
  return React.createElement(PipelineBoard, {
    stages: STAGES,
    leads: [leadL1(), lead("l2", "A"), lead("l3", "B")],
    allowedTransitions: props.allowed ?? new Set(["A:B"]),
    legacy: false,
    showAllStages: true,
    loading: false,
    hasActiveFilters: false,
    canMove: props.canMove ?? true,
    canSelect: false,
    selectedIds: new Set<string>(),
    pendingLeadIds: props.pendingLeadIds ?? new Set<string>(),
    preferences: DEFAULT_PIPELINE_PREFERENCES,
    timezone: "UTC",
    onToggleSelected: () => undefined,
    onMoveRequest: props.onMoveRequest ?? (() => undefined),
    onRetry: () => undefined
  });
}

function pointerEvent(type: string, x: number, y: number): Event {
  return new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
}

function grabLead(id: string) {
  const card = document.querySelector(`[data-pipeline-card="${id}"]`) as HTMLElement;
  expect(card).toBeTruthy();
  const box = GEOM[`card:${id}`];
  fireEvent(card, pointerEvent("pointerdown", box.x + box.w / 2, box.y + box.h / 2));
}

function movePointer(x: number, y: number) {
  fireEvent(document.body, pointerEvent("pointermove", x, y));
}

function releasePointer(x: number, y: number) {
  fireEvent(document.body, pointerEvent("pointerup", x, y));
}

function liveAnnouncement(): string {
  return screen.getByRole("status").textContent ?? "";
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function mockRect(this: HTMLElement) {
    const el = this as HTMLElement;
    const key = el.getAttribute?.("data-pipeline-column")
      ? `column:${el.getAttribute("data-pipeline-column")}`
      : el.getAttribute?.("data-pipeline-list")
        ? `list:${el.getAttribute("data-pipeline-list")}`
        : el.getAttribute?.("data-pipeline-card")
          ? `card:${el.getAttribute("data-pipeline-card")}`
          : null;
    return rectFor(key);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PipelineBoard kanban (mecânica da referência)", () => {
  it("drag por pointer de etapa permitida chama onMoveRequest com o stage alvo", () => {
    const onMoveRequest = vi.fn();
    render(React.createElement(BoardHarness, { onMoveRequest }));

    grabLead("l1");
    // placeholder abre na posição de origem (slot inicial)
    expect(document.querySelector('[data-pipeline-placeholder]')).toBeTruthy();
    // move para o centro da coluna B, abaixo do card existente → slot no fim
    movePointer(440, 300);
    const bBody = document.querySelector('[data-pipeline-list="B"]') as HTMLElement;
    expect(bBody.querySelector('[data-pipeline-placeholder]')).toBeTruthy();
    releasePointer(440, 300);

    expect(onMoveRequest).toHaveBeenCalledTimes(1);
    expect(onMoveRequest).toHaveBeenCalledWith(leadL1(), expect.objectContaining({ id: "B" }));
    expect(liveAnnouncement()).toContain("movimento para Fechado solicitado");
  });

  it("soltar na mesma etapa é no-op: sem onMoveRequest, anúncio de mesma etapa", () => {
    const onMoveRequest = vi.fn();
    render(React.createElement(BoardHarness, { onMoveRequest }));

    grabLead("l1");
    movePointer(140, 300); // ainda sobre a coluna A
    releasePointer(140, 300);

    expect(onMoveRequest).not.toHaveBeenCalled();
    expect(liveAnnouncement()).toContain("mesma etapa");
    // o card volta para a lista de origem
    const aBody = document.querySelector('[data-pipeline-list="A"]') as HTMLElement;
    expect(aBody.querySelector('[data-pipeline-card="l1"]')).toBeTruthy();
  });

  it("soltar em coluna não permitida devolve o card à origem e anuncia cancelamento", () => {
    const onMoveRequest = vi.fn();
    render(React.createElement(BoardHarness, { onMoveRequest, allowed: new Set<string>() }));

    grabLead("l1");
    movePointer(440, 300); // sobre B, sem transição permitida → nenhum slot
    expect(document.querySelector('[data-pipeline-list="B"] [data-pipeline-placeholder]')).toBeNull();
    const bColumn = document.querySelector('[data-pipeline-column="B"]') as HTMLElement;
    expect(bColumn.getAttribute("data-drop-state")).toBe("unavailable");
    expect(bColumn.className).toContain("pipeline-column--dimmed");
    releasePointer(440, 300);

    expect(onMoveRequest).not.toHaveBeenCalled();
    expect(liveAnnouncement()).toContain("permanece em Novo");
    const aBody = document.querySelector('[data-pipeline-list="A"]') as HTMLElement;
    expect(aBody.querySelector('[data-pipeline-card="l1"]')).toBeTruthy();
  });

  it("coluna de IA nunca recebe slot nem placeholder durante o drag", () => {
    const onMoveRequest = vi.fn();
    render(React.createElement(BoardHarness, { onMoveRequest }));

    grabLead("l1");
    movePointer(740, 300); // sobre a coluna de IA
    expect(document.querySelector('[data-pipeline-list="AI"] [data-pipeline-placeholder]')).toBeNull();
    releasePointer(740, 300);
    expect(onMoveRequest).not.toHaveBeenCalled();
  });

  it("teclado: espaço pega, seta direita escolhe etapa permitida, espaço solta com onMoveRequest", () => {
    const onMoveRequest = vi.fn();
    render(React.createElement(BoardHarness, { onMoveRequest }));

    const card = document.querySelector('[data-pipeline-card="l1"]') as HTMLElement;
    card.focus();
    fireEvent.keyDown(card, { key: " " });
    expect(liveAnnouncement()).toContain("selecionado para movimentação");
    expect(card).toHaveAttribute("aria-grabbed", "true");

    fireEvent.keyDown(card, { key: "ArrowRight" });
    const bBody = document.querySelector('[data-pipeline-list="B"]') as HTMLElement;
    expect(bBody.querySelector('[data-pipeline-placeholder]')).toBeTruthy();
    expect(liveAnnouncement()).toContain("Etapa Fechado disponível");

    fireEvent.keyDown(card, { key: " " });
    expect(onMoveRequest).toHaveBeenCalledTimes(1);
    expect(onMoveRequest).toHaveBeenCalledWith(leadL1(), expect.objectContaining({ id: "B" }));
  });

  it("teclado: seta para etapa não permitida mantém o slot e anuncia a recusa", () => {
    const onMoveRequest = vi.fn();
    render(React.createElement(BoardHarness, { onMoveRequest, allowed: new Set<string>() }));

    const card = document.querySelector('[data-pipeline-card="l1"]') as HTMLElement;
    card.focus();
    fireEvent.keyDown(card, { key: " " });
    fireEvent.keyDown(card, { key: "ArrowRight" });
    expect(document.querySelector('[data-pipeline-list="B"] [data-pipeline-placeholder]')).toBeNull();
    expect(liveAnnouncement()).toContain("não é permitido");

    fireEvent.keyDown(card, { key: "Escape" });
    expect(onMoveRequest).not.toHaveBeenCalled();
    expect(liveAnnouncement()).toContain("permanece em Novo");
  });

  it("teclado: seta vertical anuncia que a ordem dentro da etapa não muda", () => {
    const onMoveRequest = vi.fn();
    render(React.createElement(BoardHarness, { onMoveRequest }));

    const card = document.querySelector('[data-pipeline-card="l1"]') as HTMLElement;
    card.focus();
    fireEvent.keyDown(card, { key: " " });
    fireEvent.keyDown(card, { key: "ArrowDown" });
    expect(liveAnnouncement()).toContain("ordem dentro da etapa não é alterada");
    fireEvent.keyDown(card, { key: "Escape" });
    expect(onMoveRequest).not.toHaveBeenCalled();
  });

  it("Esc durante o drag por ponteiro devolve o card", () => {
    const onMoveRequest = vi.fn();
    render(React.createElement(BoardHarness, { onMoveRequest }));

    grabLead("l1");
    movePointer(440, 300);
    fireEvent(document.body, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onMoveRequest).not.toHaveBeenCalled();
    expect(liveAnnouncement()).toContain("permanece em Novo");
    const aBody = document.querySelector('[data-pipeline-list="A"]') as HTMLElement;
    expect(aBody.querySelector('[data-pipeline-card="l1"]')).toBeTruthy();
  });

  it("canMove=false: cards não pegam por ponteiro nem por teclado", () => {
    const onMoveRequest = vi.fn();
    render(React.createElement(BoardHarness, { onMoveRequest, canMove: false }));

    const card = document.querySelector('[data-pipeline-card="l1"]') as HTMLElement;
    expect(card.className).not.toContain("cursor-grab");
    expect(card).not.toHaveAttribute("tabindex");
    card.focus();
    fireEvent.keyDown(card, { key: " " });
    expect(liveAnnouncement()).not.toContain("selecionado");
    grabLead("l1");
    movePointer(440, 300);
    releasePointer(440, 300);
    expect(onMoveRequest).not.toHaveBeenCalled();
  });

  it("pendingLeadIds bloqueia a captura do card", () => {
    const onMoveRequest = vi.fn();
    render(React.createElement(BoardHarness, { onMoveRequest, pendingLeadIds: new Set(["l1"]) }));

    const card = document.querySelector('[data-pipeline-card="l1"]') as HTMLElement;
    expect(card.className).not.toContain("cursor-grab");
    grabLead("l1");
    expect(liveAnnouncement()).not.toContain("selecionado");
    expect(document.querySelector('[data-pipeline-placeholder]')).toBeNull();
  });

  it("checkbox de seleção preserva o espaço e o clique próprios", () => {
    const onToggleSelected = vi.fn();
    function Harness() {
      return React.createElement(PipelineBoard, {
        stages: STAGES,
        leads: [leadL1()],
        allowedTransitions: new Set(["A:B"]),
        legacy: false,
        showAllStages: true,
        loading: false,
        hasActiveFilters: false,
        canMove: true,
        canSelect: true,
        selectedIds: new Set<string>(),
        pendingLeadIds: new Set<string>(),
        preferences: DEFAULT_PIPELINE_PREFERENCES,
        timezone: "UTC",
        onToggleSelected,
        onMoveRequest: () => undefined,
        onRetry: () => undefined
      });
    }
    render(React.createElement(Harness));

    const checkbox = screen.getByRole("checkbox", { name: "Selecionar Lead l1" }) as HTMLInputElement;
    fireEvent(checkbox, new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 }));
    // o pointerdown do checkbox não captura o card para drag
    expect(document.querySelector('[data-pipeline-placeholder]')).toBeNull();
    fireEvent.click(checkbox);
    expect(onToggleSelected).toHaveBeenCalledTimes(1);
  });

  it("ScrollRail aparece quando o quadro transborda e some quando cabe", () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(500);
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockReturnValue(1200);
    render(React.createElement(BoardHarness));
    expect(document.querySelector(".pipeline-rail")).toBeTruthy();
    cleanup();

    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockReturnValue(1200);
    render(React.createElement(BoardHarness));
    expect(document.querySelector(".pipeline-rail")).toBeNull();
  });

  it("borda do track tem máscara de fade quando há colunas escondidas à direita", () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(500);
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockReturnValue(1200);
    render(React.createElement(BoardHarness));
    const track = document.querySelector(".pipeline-board") as HTMLElement;
    // jsdom não implementa mask-image no CSSOM; o estado fica observável em
    // data-edge-fade (e o maskImage segue inline para browsers reais)
    expect(track.getAttribute("data-edge-fade")).toBe("on");
    cleanup();

    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockReturnValue(1200);
    render(React.createElement(BoardHarness));
    const trackCapped = document.querySelector(".pipeline-board") as HTMLElement;
    expect(trackCapped.getAttribute("data-edge-fade")).toBe("off");
  });
});
