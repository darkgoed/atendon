import { describe, expect, it } from "vitest";
import {
  applyPipelineSavedView,
  buildOperationalPipelineStages,
  buildPipelineFilterQuery,
  buildPipelineTransitionPayload,
  currentPipelineStageId,
  EMPTY_PIPELINE_FILTERS,
  isOperationalPipelineStageId,
  normalizePipelinePreferences,
  pipelineFiltersForSavedView,
  pipelinePreferenceStorageKey,
  pipelineTransitionRequirement,
  type PipelineStage
} from "../lib/pipeline";

const stages: PipelineStage[] = [
  { id: "stage-new", name: "Novo", color: "#2563EB", position: 10, technical_status: "novo", is_default: true },
  { id: "stage-qualified", name: "Qualificado", color: "#059669", position: 40, technical_status: "qualificado", is_default: true },
  { id: "stage-follow-up", name: "Follow-up", color: "#A16207", position: 80, technical_status: "follow_up", is_default: true },
  { id: "stage-closed", name: "Fechado", color: "#047857", position: 90, technical_status: "fechado", is_default: true }
];

describe("pipeline filters", () => {
  it("serializes the supported query and saved-view keys only when populated", () => {
    const filters = {
      ...EMPTY_PIPELINE_FILTERS,
      busca: "  Marina  ",
      sdr_member_id: "member-1",
      action_bucket: "recovery"
    };
    expect(buildPipelineFilterQuery(filters)).toBe("busca=++Marina++&sdr_member_id=member-1&action_bucket=recovery");
    expect(pipelineFiltersForSavedView(filters)).toEqual({
      busca: "  Marina  ",
      sdr_member_id: "member-1",
      action_bucket: "recovery"
    });
  });

  it("restores a saved view into a clean fixed-shape filter state", () => {
    expect(applyPipelineSavedView({ busca: "Ravi", pipeline_stage_id: "stage-new", ignored: "value", sdr_member_id: 12 })).toEqual({
      ...EMPTY_PIPELINE_FILTERS,
      busca: "Ravi",
      pipeline_stage_id: "stage-new"
    });
  });

});

describe("AI follow-up operational stages", () => {
  it("projects every configured attempt and the final call queue without duplicating the persisted pipeline", () => {
    const projected = buildOperationalPipelineStages(stages, { enabled: true, max_count: 7 });
    expect(projected.map((stage) => stage.name)).toEqual([
      "Novo", "Qualificado",
      "Follow-up 1", "Follow-up 2", "Follow-up 3", "Follow-up 4", "Follow-up 5", "Follow-up 6", "Follow-up 7",
      "Ligação", "Fechado"
    ]);
    expect(projected.filter((stage) => stage.operational_kind === "ai_follow_up")).toHaveLength(7);
    expect(projected).not.toContainEqual(expect.objectContaining({ id: "stage-follow-up" }));
    expect(projected.every((stage) => stage.technical_status !== "follow_up" || isOperationalPipelineStageId(stage.id))).toBe(true);
  });

  it("advances to the next attempt and sends an exhausted sequence to Ligação", () => {
    const projected = buildOperationalPipelineStages(stages, { enabled: true, max_count: 3 });
    const lead = {
      id: "lead-1",
      telefone: "5511999999999",
      status: "aguardando_resposta",
      pipeline_stage_id: "stage-new",
      atualizado_em: "2026-08-14T10:00:00.000Z"
    };
    expect(projected.find((stage) => stage.id === currentPipelineStageId({
      ...lead,
      ai_follow_up: { count: 1, status: "scheduled" }
    }, projected, false))?.name).toBe("Follow-up 2");
    expect(projected.find((stage) => stage.id === currentPipelineStageId({
      ...lead,
      ai_follow_up: { count: 3, status: "completed", cancellation_reason: "maximum_reached" }
    }, projected, false))?.name).toBe("Ligação");
    expect(currentPipelineStageId({
      ...lead,
      ai_follow_up: { count: 3, status: "cancelled", cancellation_reason: "pipeline_stage_changed" }
    }, projected, false)).toBe("stage-new");
    expect(projected.find((stage) => stage.id === currentPipelineStageId({
      ...lead,
      pipeline_stage_id: "stage-follow-up",
      status: "follow_up",
      ai_follow_up: null
    }, projected, false))?.name).toBe("Ligação");
  });
});

describe("pipeline presentation preferences", () => {
  it("normalizes persisted preferences and scopes storage by tenant and session user", () => {
    expect(pipelinePreferenceStorageKey("tenant-4", "user-27")).toBe("atendon.pipeline.preferences.v3:tenant-4:user-27");
    expect(normalizePipelinePreferences({
      density: "compact",
      visibleFields: ["origin", "unknown", "stalled"],
      auxiliaryBadges: ["recovery", "other"],
      columnWidth: 320
    })).toEqual({
      density: "compact",
      visibleFields: ["origin", "stalled"],
      auxiliaryBadges: ["recovery"],
      columnWidth: 320
    });
    expect(normalizePipelinePreferences({ density: "invalid", columnWidth: 999 })).toMatchObject({ density: "compact", columnWidth: 280 });
  });
});

describe("pipeline transition payload", () => {
  it("requires structured commercial data for the five guarded target stages", () => {
    expect(pipelineTransitionRequirement("fechado")).toBe("sale");
    expect(pipelineTransitionRequirement("perdido")).toBe("loss");
    for (const status of ["em_negociacao", "proposta_enviada", "follow_up"]) {
      expect(pipelineTransitionRequirement(status)).toBe("next_action");
    }
    expect(pipelineTransitionRequirement("qualificado")).toBeNull();
  });

  it("builds the exact nested PATCH contract", () => {
    expect(buildPipelineTransitionPayload({
      stage: stages[3],
      expectedUpdatedAt: "2026-08-13T09:00:00.000Z",
      commercial: { sale_value: 18750.5 }
    })).toEqual({
      stage_id: "stage-closed",
      expected_updated_at: "2026-08-13T09:00:00.000Z",
      commercial: { sale_value: 18750.5 }
    });
  });
});
