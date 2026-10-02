// Texto de documentos de escritório para a IA (Word, Excel, CSV, TXT).
// O conteúdo vai ao modelo como DADO NÃO CONFIÁVEL, igual ao texto de PDF.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const TRIPZ_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const TRIPZ_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const TRIPZ_TEXT_MIMES = ["text/plain", "text/csv"] as const;
export const TRIPZ_OFFICE_MIMES = [TRIPZ_DOCX_MIME, TRIPZ_XLSX_MIME, ...TRIPZ_TEXT_MIMES] as const;
export type TripzOfficeMime = typeof TRIPZ_OFFICE_MIMES[number];

const MAX_TEXT = 200_000;

export function isTripzOfficeMime(mimeType: string): mimeType is TripzOfficeMime {
  return (TRIPZ_OFFICE_MIMES as readonly string[]).includes(mimeType);
}

interface CfbEntry { name: string; content: Uint8Array | number[] | Buffer }
interface CfbModule { read(data: Buffer, options: { type: "buffer" }): { FileIndex: CfbEntry[]; FullPaths: string[] } }
interface XlsxModule {
  CFB: CfbModule;
  read(data: Buffer, options: Record<string, unknown>): { SheetNames: string[]; Sheets: Record<string, unknown> };
  utils: { sheet_to_csv(sheet: unknown, options?: Record<string, unknown>): string };
}

function xlsxModule(): XlsxModule {
  return require("xlsx") as XlsxModule;
}

function zipEntries(data: Buffer): Map<string, Buffer> {
  const container = xlsxModule().CFB.read(data, { type: "buffer" });
  const entries = new Map<string, Buffer>();
  container.FileIndex.forEach((entry, index) => {
    const path = (container.FullPaths[index] ?? entry.name).replace(/^[^/]*\//, "");
    if (entry.content && (entry.content as { length?: number }).length) entries.set(path, Buffer.from(entry.content as Uint8Array));
  });
  return entries;
}

/** Tipo do contêiner zip pelo conteúdo (não pela extensão). */
export function detectOfficeZip(data: Buffer): typeof TRIPZ_DOCX_MIME | typeof TRIPZ_XLSX_MIME | null {
  if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) return null;
  try {
    const names = [...zipEntries(data).keys()];
    if (names.some((name) => name.endsWith("word/document.xml"))) return TRIPZ_DOCX_MIME;
    if (names.some((name) => name.endsWith("xl/workbook.xml"))) return TRIPZ_XLSX_MIME;
  } catch {
    return null;
  }
  return null;
}

/** Texto puro: UTF-8 válido (ou Latin-1 sem bytes de controle), sem NUL. */
export function looksLikeText(data: Buffer): boolean {
  if (data.length === 0 || data.includes(0)) return false;
  const sample = data.subarray(0, 64_000);
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(sample);
  const replacement = (decoded.match(/\uFFFD/g) ?? []).length;
  const control = (decoded.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g) ?? []).length;
  return replacement / Math.max(1, decoded.length) < 0.02 && control / Math.max(1, decoded.length) < 0.01;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function docxText(data: Buffer): string {
  const entries = zipEntries(data);
  const document = [...entries].find(([name]) => name.endsWith("word/document.xml"))?.[1];
  if (!document) return "";
  const xml = document.toString("utf8");
  return decodeXmlEntities(xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<\/w:tc>/g, " | ")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function xlsxText(data: Buffer): string {
  const xlsx = xlsxModule();
  const workbook = xlsx.read(data, { type: "buffer", cellFormula: false, cellHTML: false, sheetRows: 2_000 });
  return workbook.SheetNames.slice(0, 12).map((name) => {
    const csv = xlsx.utils.sheet_to_csv(workbook.Sheets[name], { blankrows: false, strip: true });
    return `### Planilha: ${name}\n${csv.trim()}`;
  }).join("\n\n").trim();
}

function plainText(data: Buffer): string {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(data);
  return (utf8.includes("\uFFFD") ? data.toString("latin1") : utf8).replace(/^\uFEFF/, "").trim();
}

/** Texto do documento (limitado a 200 mil caracteres) ou undefined se vazio. */
export function extractOfficeText(data: Buffer, mimeType: string): string | undefined {
  let text = "";
  if (mimeType === TRIPZ_DOCX_MIME) text = docxText(data);
  else if (mimeType === TRIPZ_XLSX_MIME) text = xlsxText(data);
  else if ((TRIPZ_TEXT_MIMES as readonly string[]).includes(mimeType)) text = plainText(data);
  text = text.slice(0, MAX_TEXT).trim();
  return text || undefined;
}
