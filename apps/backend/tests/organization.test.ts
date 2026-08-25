import { describe, expect, it } from "vitest";
import { configuredStageTransitionIsUndoable, domainAllowsStageTransition } from "../src/modules/organization/domain.js";
import {
  bulkApplySchema,
  bulkPreviewSchema,
  parseSavedViewFilters,
  stageTransitionsSchema
} from "../src/modules/organization/schemas.js";

const leadId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";

describe("case organization domain", () => {
  it("never lets visual pipeline configuration expand technical transitions", () => {
    expect(domainAllowsStageTransition("em_atendimento","qualificado")).toBe(true);
    expect(domainAllowsStageTransition("perdido","fechado")).toBe(true);
    expect(domainAllowsStageTransition("fechado","agendado")).toBe(false);
    expect(domainAllowsStageTransition("qualificado","qualificado")).toBe(true);
  });

  it("only makes same-status stage movement undoable", () => {
    expect(configuredStageTransitionIsUndoable("qualificado","qualificado")).toBe(true);
    expect(configuredStageTransitionIsUndoable("em_atendimento","qualificado")).toBe(false);
  });
});

describe("case organization schemas", () => {
  it("rejects unknown saved-view fields instead of accepting dynamic filters", () => {
    expect(() => parseSavedViewFilters("leads",{ status: "qualificado", injected_sql: "DROP TABLE" })).toThrow();
    expect(parseSavedViewFilters("pipeline",{ pipeline_stage_id: targetId })).toEqual({ pipeline_stage_id: targetId });
    expect(parseSavedViewFilters("pipeline",{ pipeline_stage_id: `operational:ai-follow-up:${targetId}:7` }))
      .toEqual({ pipeline_stage_id: `operational:ai-follow-up:${targetId}:7` });
    expect(parseSavedViewFilters("pipeline",{ pipeline_stage_id: `operational:call:${targetId}` }))
      .toEqual({ pipeline_stage_id: `operational:call:${targetId}` });
    expect(() => parseSavedViewFilters("pipeline",{ pipeline_stage_id: `operational:call:${targetId}:1` })).toThrow();
    expect(() => parseSavedViewFilters("pipeline",{ pipeline_stage_id: `operational:ai-follow-up:${targetId}` })).toThrow();
  });

  it("bounds and deduplicates bulk selections", () => {
    expect(() => bulkPreviewSchema.parse({
      action: "assign",
      assigned_member_id: null,
      items: [{ id: leadId },{ id: leadId }]
    })).toThrow(/duplicados/i);
    expect(() => bulkPreviewSchema.parse({
      action: "move_stage",
      stage_id: targetId,
      items: Array.from({ length: 201 },(_, index) => ({
        id: `${String(index).padStart(8,"0")}-1111-4111-8111-111111111111`
      }))
    })).toThrow();
  });

  it("requires an idempotency key only when applying a valid action", () => {
    const preview = {
      action: "tags_add" as const,
      tag_ids: [targetId],
      items: [{ id: leadId }]
    };
    expect(bulkPreviewSchema.parse(preview)).toEqual(preview);
    expect(() => bulkApplySchema.parse(preview)).toThrow();
    expect(bulkApplySchema.parse({ ...preview, idempotency_key: "toolbar-click-1" })).toMatchObject({
      action: "tags_add",
      idempotency_key: "toolbar-click-1"
    });
  });

  it("rejects duplicate configured transitions", () => {
    expect(() => stageTransitionsSchema.parse({ to_stage_ids: [targetId,targetId] })).toThrow(/duplicadas/i);
  });
});
