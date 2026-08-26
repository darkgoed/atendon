import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { PipelineBoard, horizontalWheelDelta } from "../components/pipeline-board";
import { DEFAULT_PIPELINE_PREFERENCES, type PipelineStage } from "../lib/pipeline";

describe("pipeline horizontal wheel", () => {
  it("uses deltaX and falls back to deltaY when horizontal delta is zero", () => {
    expect(horizontalWheelDelta({ deltaX: 12, deltaY: 40 })).toBe(12);
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: -7.5 })).toBe(-7.5);
    expect(horizontalWheelDelta({ deltaX: 0, deltaY: 0 })).toBe(0);
    expect(horizontalWheelDelta({ deltaX: Number.NaN, deltaY: 3 })).toBe(3);
  });

  it("renders an accessible board with a card descendant", () => {
    const markup = renderToStaticMarkup(
      createElement(PipelineBoard, {
        stages: [{
          id: "stage-1",
          name: "Novo",
          color: "#000000",
          position: 0,
          technical_status: "novo",
          is_default: true,
          operational_kind: "call",
          operational_source_stage_id: undefined,
          capacity_target: null
        } satisfies PipelineStage],
        leads: [],
        allowedTransitions: new Set<string>(),
        legacy: false,
        loading: false,
        hasActiveFilters: false,
        canMove: false,
        canSelect: false,
        selectedIds: new Set<string>(),
        pendingLeadIds: new Set<string>(),
        preferences: DEFAULT_PIPELINE_PREFERENCES,
        onToggleSelected: () => undefined,
        onMoveRequest: () => undefined,
        onRetry: () => undefined
      })
    );
    expect(markup).toContain('aria-label="Quadro de pipeline"');
    expect(markup).toContain("pipeline-column__body");
  });
});
