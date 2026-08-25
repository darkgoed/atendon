import { describe, expect, it } from "vitest";
import {
  canPublishImprovementProposal,
  hasValidImprovementConfirmation,
  resolveImprovementViewState
} from "../lib/ai-improvement-ui";

describe("continuous improvement UI guards", () => {
  it("distinguishes loading, error, empty and populated states", () => {
    expect(resolveImprovementViewState({ loading: true, error: "", itemCount: 0 })).toBe("loading");
    expect(resolveImprovementViewState({ loading: false, error: "Falhou", itemCount: 0 })).toBe("error");
    expect(resolveImprovementViewState({ loading: false, error: "", itemCount: 0 })).toBe("empty");
    expect(resolveImprovementViewState({ loading: false, error: "", itemCount: 1 })).toBe("ready");
  });

  it("requires exact typed confirmation for publish and rollback", () => {
    expect(hasValidImprovementConfirmation("publish", "publicar")).toBe(false);
    expect(hasValidImprovementConfirmation("publish", "PUBLICAR")).toBe(true);
    expect(hasValidImprovementConfirmation("rollback", "REVERTER")).toBe(true);
  });

  it("offers publication only for a ready proposal with rollout enabled", () => {
    expect(canPublishImprovementProposal("proposed", true)).toBe(false);
    expect(canPublishImprovementProposal("ready", false)).toBe(false);
    expect(canPublishImprovementProposal("ready", true)).toBe(true);
  });
});
