import { describe, expect, it } from "vitest";
import {
  sanitizeTripzFileName,
  tripzContentDisposition,
  validateTripzUpload
} from "../src/modules/tripz-ai/storage.js";

function png(width = 2, height = 3): Buffer {
  const data = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data, 0);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function jpeg(width = 2, height = 3): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9
  ]);
}

describe("Tripz attachment validation", () => {
  it("accepts verified PNG/JPEG and returns only safe derived metadata", () => {
    const image = validateTripzUpload({ fileName: "Piscina verão.png", mimeType: "image/png", data: png() });
    expect(image).toMatchObject({
      fileName: "Piscina verão.png",
      mimeType: "image/png",
      extension: "png",
      metadata: { width: 2, height: 3 }
    });
    expect(image.contentHash).toMatch(/^[0-9a-f]{64}$/);

    expect(validateTripzUpload({ fileName: "quarto.jpeg", mimeType: "image/jpeg", data: jpeg() }))
      .toMatchObject({ extension: "jpg", metadata: { width: 2, height: 3 } });
  });

  it("accepts PDF from magic bytes and treats its content only as document data", () => {
    const data = Buffer.from("%PDF-1.7\n1 0 obj<</Type /Page>>endobj\n%%EOF", "latin1");
    const result = validateTripzUpload({ fileName: "proposta.pdf", mimeType: "application/pdf", data });
    expect(result).toMatchObject({ extension: "pdf", metadata: { pageCountHint: 1 } });
    expect(result.data).toEqual(data);
  });

  it("rejects MIME/extension/magic-byte mismatch and decompression-bomb dimensions", () => {
    expect(() => validateTripzUpload({ fileName: "foto.pdf", mimeType: "image/png", data: png() }))
      .toThrow("extensão");
    expect(() => validateTripzUpload({ fileName: "foto.png", mimeType: "image/png", data: jpeg() }))
      .toThrow("conteúdo");
    expect(() => validateTripzUpload({ fileName: "foto.png", mimeType: "image/png", data: png(16_384, 16_384) }))
      .toThrow("dimensões");
    expect(() => validateTripzUpload({ fileName: "arquivo.svg", mimeType: "image/png", data: Buffer.from("<svg>") }))
      .toThrow("extensão");
  });

  it("neutralizes traversal/control characters in names and response headers", () => {
    expect(sanitizeTripzFileName("../../segredo\r\n.pdf")).toBe("segredo.pdf");
    const disposition = tripzContentDisposition("../../Olá\r\n.pdf", "attachment");
    expect(disposition).toContain("attachment;");
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
    expect(disposition).not.toContain("../");
  });
});
