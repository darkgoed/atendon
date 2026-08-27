import { describe, expect, it } from "vitest";
import { aiFollowUpSettingsSchema } from "../src/app.js";
import { FollowUpMediaRepository } from "../src/modules/messages/follow-up-media.js";

const uuid = "00000000-0000-0000-0000-000000000001";

describe("configuração de follow-up com áudio e vídeo", () => {
  it("aceita deliveries de áudio e vídeo", () => {
    const result = aiFollowUpSettingsSchema.parse({
      enabled: true,
      delaysMinutes: [10, 20],
      delivery: [{ type: "audio", assetId: uuid }, { type: "video", assetId: uuid }]
    });
    expect(result.delivery).toHaveLength(2);
  });
});

describe("validação e remoção de mídia de follow-up", () => {
  it("rejeita asset inexistente de áudio e vídeo", async () => {
    const db = { query: async () => ({ rows: [] }) } as any;
    const repository = new FollowUpMediaRepository(db);
    await expect(repository.validateDelivery(uuid, [{ type: "audio", assetId: uuid }])).rejects.toThrow("mídias");
    await expect(repository.validateDelivery(uuid, [{ type: "video", assetId: uuid }])).rejects.toThrow("mídias");
  });

  it("não remove mídia referenciada como áudio", async () => {
    const db = {
      query: async (_sql: string, params: unknown[]) => params.length === 4 ? { rows: [{ used: true }] } : { rows: [] }
    } as any;
    await expect(new FollowUpMediaRepository(db).remove(uuid, uuid)).resolves.toBe("in_use");
  });
});