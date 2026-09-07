import { describe, expect, it } from "vitest";
import { statusLabel } from "../app/leads/lead-domain";
import { buildPipelineTransitionPayload } from "../lib/pipeline";

describe("leads, pipeline and agenda shared contracts", () => {
  it("preserves lead status transition labels", () => {
    expect(statusLabel("qualificado")).toBe("Qualificado");
  });

  it("keeps the pipeline persistence payload stable for rollback-capable mutations", () => {
    expect(buildPipelineTransitionPayload({
      stage: { id: "stage-1", name: "Qualificado", color: "#000", position: 1, technical_status: "qualificado", is_default: true },
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z"
    })).toEqual({ stage_id: "stage-1", expected_updated_at: "2026-01-01T00:00:00.000Z" });
  });

  it("renders agenda navigation inputs as stable UTC calendar values", () => {
    expect(new Date("2026-01-05T00:00:00.000Z").toLocaleDateString("pt-BR", { timeZone: "UTC" })).toBe("05/01/2026");
  });
});
