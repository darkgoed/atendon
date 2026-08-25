import { describe, expect, it } from "vitest";
import {
  aiTurnProgressSatisfiedByMessages,
  parseAiTurnProgress,
  reconcileAiTurnProgress,
  type AiTurnProgress
} from "../lib/ai-turn-progress";

function progress(overrides: Partial<AiTurnProgress> = {}): AiTurnProgress {
  return {
    type: "conversation.ai.progress",
    conversationId: "conversation-1",
    turnId: "turn-1",
    attempt: 1,
    revision: 0,
    phase: "reading",
    startedAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
    expiresAt: "2026-08-10T10:30:00.000Z",
    ...overrides
  };
}

describe("AI turn progress", () => {
  it("parses only bounded public payloads", () => {
    expect(parseAiTurnProgress(progress())).toEqual(progress());
    expect(parseAiTurnProgress({ ...progress(), preview: "x".repeat(12_001) })).toBeNull();
    expect(parseAiTurnProgress({ ...progress(), arguments: { secret: true } })).toBeNull();
    expect(parseAiTurnProgress({ ...progress(), attempt: 0 })).toBeNull();
  });

  it("discards old revisions and clears only the current or a newer turn", () => {
    const current = progress({ revision: 4, phase: "preview", preview: "Olá" });
    expect(reconcileAiTurnProgress(current, progress({ revision: 3 }), Date.parse("2026-08-10T10:01:00Z")))
      .toBe(current);
    expect(reconcileAiTurnProgress(current, progress({ revision: 5, phase: "cleared" }), Date.parse("2026-08-10T10:01:00Z")))
      .toBeNull();
    const next = progress({
      turnId: "turn-2",
      startedAt: "2026-08-10T10:02:00.000Z",
      updatedAt: "2026-08-10T10:02:00.000Z",
      expiresAt: "2026-08-10T10:32:00.000Z"
    });
    expect(reconcileAiTurnProgress(next, progress({ revision: 99, phase: "cleared" }), Date.parse("2026-08-10T10:03:00Z")))
      .toBe(next);
  });

  it("expires stale updates and replaces previews when the persisted reply appears", () => {
    const preview = progress({ phase: "preview", preview: "Primeira bolha\n\nSegunda bolha" });
    expect(reconcileAiTurnProgress(null, preview, Date.parse("2026-08-10T10:31:00Z"))).toBeNull();
    expect(aiTurnProgressSatisfiedByMessages(preview, [{
      sender: "agent",
      content: "Primeira bolha",
      created_at: "2026-08-10T10:00:02.000Z"
    }])).toBe(true);
  });
});
