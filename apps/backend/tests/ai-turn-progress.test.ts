import { describe, expect, it, vi } from "vitest";
import {
  AI_TURN_PREVIEW_MAX_CHARACTERS,
  aiTurnProgressSchema,
  buildAiTurnPreview,
  safeAiToolLabel
} from "../src/modules/realtime/ai-turn-contract.js";
import { AiTurnProgressStore } from "../src/modules/realtime/ai-turn-progress.js";

describe("AI turn progress contract", () => {
  it("uses safe labels without exposing unknown tool names", () => {
    expect(safeAiToolLabel("verificar_horarios_reuniao")).toBe("Verificando horários…");
    expect(safeAiToolLabel("internal_secret_tool")).toBe("Consultando informações…");
    expect(safeAiToolLabel("internal_secret_tool")).not.toContain("internal_secret_tool");
  });

  it("joins future WhatsApp bubbles and bounds the preview payload", () => {
    expect(buildAiTurnPreview(["Primeira", "Segunda"])).toEqual({
      preview: "Primeira\n\nSegunda",
      previewTruncated: false
    });
    const truncated = buildAiTurnPreview(["x".repeat(AI_TURN_PREVIEW_MAX_CHARACTERS + 50)]);
    expect(truncated.preview).toHaveLength(AI_TURN_PREVIEW_MAX_CHARACTERS);
    expect(truncated.previewTruncated).toBe(true);
  });

  it("rejects private tool and reasoning fields from the public schema", () => {
    const publicProgress = {
      type: "conversation.ai.progress",
      conversationId: "conversation-1",
      turnId: "turn-1",
      attempt: 1,
      revision: 2,
      phase: "preview",
      preview: "Resposta final",
      startedAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:00:01.000Z",
      expiresAt: "2026-08-10T10:30:01.000Z"
    };
    expect(aiTurnProgressSchema.safeParse(publicProgress).success).toBe(true);
    expect(aiTurnProgressSchema.safeParse({ ...publicProgress, reasoning: "secret" }).success).toBe(false);
    expect(aiTurnProgressSchema.safeParse({ ...publicProgress, arguments: { token: "secret" } }).success).toBe(false);
  });

  it("keeps Redis outages best-effort", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{
        flag_key: "ai_turn_visibility_v1",
        description: "AI visibility",
        default_enabled: false,
        global_enabled: true,
        kill_switch_enabled: false,
        tenant_override: null,
        updated_at: "2026-08-10T10:00:00.000Z"
      }] })
    };
    const store = new AiTurnProgressStore(pool as never, "redis://127.0.0.1:1/15");
    const startedAt = Date.now();
    await expect(store.start({
      tenantId: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      turnId: "turn-1",
      attempt: 1
    })).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await expect(store.get(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    )).resolves.toBeNull();
    await store.close();
  });
});
