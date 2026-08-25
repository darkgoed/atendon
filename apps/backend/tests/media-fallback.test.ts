import { describe, expect, it } from "vitest";
import { mediaFallback } from "../src/modules/messages/media-fallback.js";

describe("mediaFallback", () => {
  it.each([
    ["audio", "Recebi seu áudio"],
    ["image", "Recebi sua imagem"],
    ["document", "Recebi seu documento"]
  ] as const)("maps %s to its internal default response", (type, expected) => {
    expect(mediaFallback(type)).toContain(expected);
  });
});
