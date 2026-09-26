import { PDFParse } from "pdf-parse";
import { TRIPZ_MAX_PDF_BYTES, TRIPZ_MAX_PDF_PAGE_HINT } from "./storage.js";

export const TRIPZ_MAX_EXTRACTED_PDF_TEXT_CHARACTERS = 200_000;
export const TRIPZ_LOCAL_PDF_PARSE_TIMEOUT_MS = 10_000;

export interface TripzPdfTextExtractionInput {
  data: Buffer;
  mimeType: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
}

interface TripzPdfTextParser {
  getInfo(): Promise<{ total: number }>;
  getText(parameters?: { first?: number; pageJoiner?: string }): Promise<{ text: string }>;
  destroy(): Promise<void>;
}

export interface TripzPdfTextExtractorOptions {
  timeoutMs?: number;
  createParser?: (data: Uint8Array) => TripzPdfTextParser;
}

function isValidatedTripzPdf(input: TripzPdfTextExtractionInput): boolean {
  const pageCountHint = input.metadata.pageCountHint;
  return input.mimeType === "application/pdf"
    && Buffer.isBuffer(input.data)
    && input.data.length >= 8
    && input.data.length === input.sizeBytes
    && input.data.length <= TRIPZ_MAX_PDF_BYTES
    && input.data.subarray(0, 5).toString("ascii") === "%PDF-"
    && Number.isInteger(pageCountHint)
    && (pageCountHint as number) >= 1
    && (pageCountHint as number) <= TRIPZ_MAX_PDF_PAGE_HINT;
}

async function withinTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timeout = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([operation, expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Extracts text only from an attachment that already passed the Tripz upload
 * boundary. Any unsupported, malformed, oversized, image-only or slow PDF
 * returns undefined so the caller can retain the existing private raw-file
 * parser fallback.
 */
export async function extractTripzPdfTextLocally(
  input: TripzPdfTextExtractionInput,
  options: TripzPdfTextExtractorOptions = {}
): Promise<string | undefined> {
  if (!isValidatedTripzPdf(input)) return undefined;

  const createParser = options.createParser ?? ((data: Uint8Array) => new PDFParse({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    stopAtErrors: true,
    useSystemFonts: false,
    verbosity: 0
  }));
  let parser: TripzPdfTextParser | undefined;
  let extraction: Promise<string | undefined> | undefined;
  let pending = true;
  let abandoned = false;
  try {
    // Copy the validated private buffer because PDF.js may transfer ownership
    // of typed arrays to its worker.
    const created = parser = createParser(new Uint8Array(input.data));
    extraction = (async () => {
      const info = await created.getInfo();
      if (abandoned || !Number.isInteger(info.total) || info.total < 1 || info.total > TRIPZ_MAX_PDF_PAGE_HINT) {
        return undefined;
      }
      const result = await created.getText({ first: info.total, pageJoiner: "" });
      const text = result.text.trim();
      if (!text) return undefined;
      return text.slice(0, TRIPZ_MAX_EXTRACTED_PDF_TEXT_CHARACTERS).trim() || undefined;
    })().finally(() => {
      pending = false;
    });
    return await withinTimeout(extraction, options.timeoutMs ?? TRIPZ_LOCAL_PDF_PARSE_TIMEOUT_MS);
  } catch {
    return undefined;
  } finally {
    abandoned = true;
    if (parser) {
      const created = parser;
      await destroyQuietly(created);
      // Timeout during load: PDFParse has no document yet, so destroy() was a
      // no-op. Destroy the document pdf.js hands over once loading settles.
      if (pending && extraction) {
        void extraction.then(() => destroyQuietly(created), () => destroyQuietly(created));
      }
    }
  }
}

async function destroyQuietly(parser: TripzPdfTextParser): Promise<void> {
  try {
    await parser.destroy();
  } catch {
    // Destruction is best-effort and must never replace the raw PDF fallback.
  }
}
