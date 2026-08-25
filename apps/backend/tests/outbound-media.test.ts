import { describe, expect, it } from "vitest";
import { decodeOutboundMedia, safeMediaResponseMime } from "../src/modules/messages/outbound-media.js";

describe("outbound media validation", () => {
  it("normalizes a valid voice recording and fingerprints its bytes", () => {
    const result = decodeOutboundMedia({
      mediaType: "audio",
      mimeType: "audio/webm;codecs=opus",
      fileName: "audio/atendimento.webm",
      dataBase64: "data:audio/webm;codecs=opus;base64,V2ViTQ=="
    });
    expect(result).toEqual(expect.objectContaining({
      mediaType: "audio",
      mimeType: "audio/webm",
      fileName: "audio_atendimento.webm",
      dataBase64: "V2ViTQ==",
      sizeBytes: 4
    }));
    expect(result.contentFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects executable content disguised as a document", () => {
    expect(() => decodeOutboundMedia({
      mediaType: "document",
      mimeType: "application/x-msdownload",
      fileName: "arquivo.exe",
      dataBase64: "TVqQAAMAAAAEAAAA"
    })).toThrow(/não permitido/i);
  });

  it("does not reflect unsafe provider mime types in media responses", () => {
    expect(safeMediaResponseMime("image", "image/svg+xml")).toBe("application/octet-stream");
    expect(safeMediaResponseMime("image", "image/webp")).toBe("image/webp");
  });
});
