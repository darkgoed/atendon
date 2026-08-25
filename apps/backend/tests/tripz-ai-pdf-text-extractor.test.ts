import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import {
  extractTripzPdfTextLocally,
  TRIPZ_MAX_EXTRACTED_PDF_TEXT_CHARACTERS
} from "../src/modules/tripz-ai/pdf-text-extractor.js";
import { validateTripzUpload } from "../src/modules/tripz-ai/storage.js";

async function realPdf(text?: string) {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 200]);
  if (text) {
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText(text, { x: 24, y: 120, size: 12, font });
  }
  const data = Buffer.from(await document.save());
  const validated = validateTripzUpload({
    fileName: "documento.pdf",
    mimeType: "application/pdf",
    data
  });
  return {
    data: validated.data,
    mimeType: validated.mimeType,
    sizeBytes: validated.data.length,
    metadata: validated.metadata
  };
}

describe("Tripz local PDF text extraction", () => {
  it("extracts text from a real, validated textual PDF", async () => {
    const input = await realPdf("Roteiro Tripz local para Aruba");
    await expect(extractTripzPdfTextLocally(input)).resolves.toContain("Roteiro Tripz local para Aruba");
  });

  it("returns no text for a real image-only/blank PDF", async () => {
    await expect(extractTripzPdfTextLocally(await realPdf())).resolves.toBeUndefined();
  });

  it("fails safely and always destroys a parser that throws", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    const getText = vi.fn();
    const result = await extractTripzPdfTextLocally(await realPdf("conteúdo privado"), {
      createParser: () => ({
        getInfo: vi.fn().mockRejectedValue(new Error("parser failed with conteúdo privado")),
        getText,
        destroy
      })
    });
    expect(result).toBeUndefined();
    expect(getText).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("times out safely and destroys the parser", async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);
    const result = await extractTripzPdfTextLocally(await realPdf("lento"), {
      timeoutMs: 5,
      createParser: () => ({
        getInfo: vi.fn().mockReturnValue(new Promise(() => undefined)),
        getText: vi.fn(),
        destroy
      })
    });
    expect(result).toBeUndefined();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects an actual page count over 200 and caps extracted text at 200k characters", async () => {
    const input = await realPdf("limites");
    const overPagesDestroy = vi.fn().mockResolvedValue(undefined);
    const overPagesGetText = vi.fn();
    await expect(extractTripzPdfTextLocally(input, {
      createParser: () => ({
        getInfo: vi.fn().mockResolvedValue({ total: 201 }),
        getText: overPagesGetText,
        destroy: overPagesDestroy
      })
    })).resolves.toBeUndefined();
    expect(overPagesGetText).not.toHaveBeenCalled();
    expect(overPagesDestroy).toHaveBeenCalledTimes(1);

    const cappedDestroy = vi.fn().mockResolvedValue(undefined);
    const text = await extractTripzPdfTextLocally(input, {
      createParser: () => ({
        getInfo: vi.fn().mockResolvedValue({ total: 1 }),
        getText: vi.fn().mockResolvedValue({
          text: "x".repeat(TRIPZ_MAX_EXTRACTED_PDF_TEXT_CHARACTERS + 1)
        }),
        destroy: cappedDestroy
      })
    });
    expect(text).toHaveLength(TRIPZ_MAX_EXTRACTED_PDF_TEXT_CHARACTERS);
    expect(cappedDestroy).toHaveBeenCalledTimes(1);
  });

  it("does not instantiate a parser for a PDF outside the validated boundary", async () => {
    const createParser = vi.fn();
    await expect(extractTripzPdfTextLocally({
      data: Buffer.from("not a pdf"),
      mimeType: "application/pdf",
      sizeBytes: 9,
      metadata: { pageCountHint: 1 }
    }, { createParser })).resolves.toBeUndefined();
    expect(createParser).not.toHaveBeenCalled();
  });
});
