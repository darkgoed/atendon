// R14 — parsing de arquivos de importação de contatos (specs/active/
// v6-evolucao-estrutural-atendon.md). CSV com parser próprio mínimo (aspas,
// vírgula, BOM); XLSX com a lib SheetJS `xlsx` — versão estável 0.18.5, a
// última publicada no npm pela SheetJS (as posteriores são distribuídas pelo
// CDN próprio), JS puro sem dependências nativas e com tipos embutidos
// (`@types/xlsx` entra como stub no devDependencies por exigência do contrato).
import { read as readWorkbook, utils as xlsxUtils } from "xlsx";

export const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024; // payload decodificado
export const MAX_IMPORT_ROWS = 10_000;

export class ImportFileError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "ImportFileError";
  }
}

/** Parser CSV mínimo: BOM, campos entre aspas com "" como escape, vírgula e CR/LF. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === "\"") {
        if (text[i + 1] === "\"") { cell += "\""; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += char; i++; continue;
    }
    if (char === "\"") { inQuotes = true; i++; continue; }
    if (char === ",") { row.push(cell); cell = ""; i++; continue; }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = ""; i++; continue;
    }
    cell += char; i++;
  }
  // Última célula/linha sem quebra no fim do arquivo (linhas totalmente vazias
  // no fim são descartadas).
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Primeira planilha do XLSX como matriz de strings (células formatadas). */
export function parseXlsx(buffer: Buffer): string[][] {
  const workbook = readWorkbook(buffer, { type: "buffer" });
  const firstKey = workbook.SheetNames[0];
  if (!firstKey) throw new ImportFileError("A planilha não possui abas");
  const sheet = workbook.Sheets[firstKey];
  const matrix = xlsxUtils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "", blankrows: false });
  return matrix.map((cells) => cells.map((value) => String(value ?? "")));
}

function decodeBase64Payload(raw: string, label: string): Buffer {
  if (!/^[A-Za-z0-9+/=\r\n_-]+$/.test(raw)) throw new ImportFileError(`${label} não é base64 válido`);
  const buffer = Buffer.from(raw, "base64");
  if (buffer.length === 0) throw new ImportFileError(`${label} decodifica para vazio`);
  if (buffer.length > MAX_IMPORT_FILE_BYTES) {
    throw new ImportFileError(`Arquivo maior que o limite de ${Math.floor(MAX_IMPORT_FILE_BYTES / (1024 * 1024))} MB`);
  }
  return buffer;
}

export function loadImportFile(body: { csv_base64?: string; xlsx_base64?: string }): { rows: string[][]; kind: "csv" | "xlsx" } {
  const hasCsv = Boolean(body.csv_base64);
  const hasXlsx = Boolean(body.xlsx_base64);
  if (hasCsv === hasXlsx) {
    throw new ImportFileError("Envie exatamente um de csv_base64 ou xlsx_base64");
  }
  if (hasCsv) {
    const rows = parseCsv(Buffer.from(decodeBase64Payload(body.csv_base64!, "csv_base64")).toString("utf8"));
    if (!rows.length) throw new ImportFileError("CSV vazio");
    return { rows, kind: "csv" };
  }
  const rows = parseXlsx(decodeBase64Payload(body.xlsx_base64!, "xlsx_base64"));
  if (!rows.length) throw new ImportFileError("Planilha vazia");
  return { rows, kind: "xlsx" };
}
