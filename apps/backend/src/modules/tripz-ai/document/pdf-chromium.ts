import { TRIPZ_PDF_DISABLE_CHROMIUM } from "./env.js";
import type { ProposalSpec } from "@atendon/proposal-renderer";

/**
 * PDF final via Chromium (playwright) a partir EXATAMENTE do HTML SSR dos
 * componentes de proposta — mesmo DOM do preview do painel (DESIGN.md §6).
 */

const PDF_ENGINE_UNAVAILABLE = "TRIPZ_PDF_ENGINE_UNAVAILABLE";

export interface DocumentPdfInput {
  spec: ProposalSpec;
  html: string;
}

let chromiumModule: unknown | undefined;

async function loadChromium(): Promise<{ pdfViaChromium: (html: string) => Promise<Buffer> }> {
  if (chromiumModule !== undefined) return chromiumModule as { pdfViaChromium: (html: string) => Promise<Buffer> };
  // Import tardio: unit tests rodam sem chromium e o boot da API não deve
  // depender dele até o primeiro PDF.
  const playwright = await import("playwright").catch(() => null);
  if (!playwright) throw new Error("playwright indisponível");
  chromiumModule = playwright;
  return chromiumModule as { pdfViaChromium: (html: string) => Promise<Buffer> };
}

export async function exportDocumentPdf(input: { spec: ProposalSpec; html: string }): Promise<Buffer> {
  if (TRIPZ_PDF_DISABLE_CHROMIUM(process.env)) {
    throw new Error(PDF_ENGINE_UNAVAILABLE);
  }
  const module = await loadChromium() as unknown as { chromium: { launch: (opts: { headless: boolean; executablePath?: string }) => Promise<unknown> } };
  const browser = await module.chromium.launch({ headless: true });
  try {
    const context = await (browser as unknown as { newContext: (opts: unknown) => Promise<unknown> })
      .newContext({ viewport: { width: 900, height: 1300 } });
    // Defesa em profundidade contra SSRF pelo HTML da proposta: no modo PDF
    // fontes e imagens já vão inline (data:), então nenhuma requisição de rede
    // é legítima — um <iframe>/<img> injetado não alcança a rede interna.
    await (context as unknown as { route: (pattern: string, handler: (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => Promise<void>) => Promise<void> })
      .route("**/*", (route) => /^(data|about|blob):/.test(route.request().url()) ? route.continue() : route.abort());
    const page = await (context as unknown as { newPage: () => Promise<unknown> }).newPage();
    const typed = page as unknown as {
      setContent: (html: string, opts: unknown) => Promise<void>;
      evaluate: (fn: () => unknown) => Promise<unknown>;
      pdf: (opts: unknown) => Promise<Buffer>;
    };
    await typed.setContent(input.html, { waitUntil: "load" });
    await typed.evaluate(() => document.fonts.ready);
    const pdf = await typed.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" }
    });
    return Buffer.from(pdf);
  } finally {
    await (browser as unknown as { close: () => Promise<void> }).close();
  }
}

export { PDF_ENGINE_UNAVAILABLE };
