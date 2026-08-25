import { describe, expect, it } from "vitest";
import { decodeStickerBase64, MAX_STICKER_BYTES } from "../src/modules/stickers/repository.js";

function minimalWebp() {
  const data = Buffer.alloc(12);
  data.write("RIFF", 0, "ascii");
  data.write("WEBP", 8, "ascii");
  return data;
}

describe("sticker validation", () => {
  it("accepts WebP data and strips a data URL prefix", () => {
    const encoded = minimalWebp().toString("base64");
    expect(decodeStickerBase64(`data:image/webp;base64,${encoded}`)).toEqual(minimalWebp());
  });

  it("rejects another image format and oversized files", () => {
    expect(() => decodeStickerBase64(Buffer.from("not-webp").toString("base64"))).toThrow("WebP");
    const oversized = Buffer.alloc(MAX_STICKER_BYTES + 1).toString("base64");
    expect(() => decodeStickerBase64(oversized)).toThrow("1 MB");
  });
});
