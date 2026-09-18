// R14/R11 — Importação de contatos: parsing CSV client-side, template oficial,
// mapeamento de colunas e contrato de resultado com sinalização de duplicidade.
// Contrato real de submissão: POST /contact-ops/import — JSON com
// {csv_base64|xlsx_base64, filename, mapping:{nome,telefone,email,origem,campanha},
// options:{on_duplicate}}; preview de XLSX e histórico seguem pendentes no backend
// (a UI trata indisponibilidade como erro claro / seção omitida).

import { api } from "./api";

export type ImportFieldId = "nome" | "telefone" | "email" | "origem" | "campanha";

export type ImportField = {
  id: ImportFieldId;
  label: string;
  required?: boolean;
  aliases?: string[];
};

// Só campos com destino real no backend (mapping de /contact-ops/import).
// As demais colunas do template (unidade, categoria, parceiro, observação) não
// têm destino e são ignoradas — o passo de mapeamento avisa isso na UI.
export const IMPORT_FIELDS: ImportField[] = [
  { id: "nome", label: "Nome", aliases: ["nome", "name", "nome do contato", "contato", "full name"] },
  { id: "telefone", label: "Telefone", required: true, aliases: ["telefone", "phone", "celular", "whatsapp", "numero", "número", "tel", "mobile"] },
  { id: "email", label: "E-mail", aliases: ["email", "e-mail", "mail", "correio"] },
  { id: "origem", label: "Origem", aliases: ["origem", "source", "canal"] },
  { id: "campanha", label: "Campanha", aliases: ["campanha", "campaign", "anuncio", "anúncio"] }
];

export const IMPORT_TEMPLATE_COLUMNS: string[] = ["nome", "telefone", "email", "origem", "campanha", "unidade", "categoria", "parceiro", "observacao"];

export type ImportDuplicatePolicy = "skip" | "update" | "flag";

export const IMPORT_DUPLICATE_OPTIONS: Array<{ id: ImportDuplicatePolicy; label: string; description: string }> = [
  { id: "skip", label: "Ignorar duplicados", description: "Linhas com telefone já existente são puladas." },
  { id: "update", label: "Atualizar existentes", description: "Linhas com telefone já existente atualizam o contato." },
  { id: "flag", label: "Sinalizar para revisão", description: "Linhas suspeitas entram marcadas como “possível duplicado”." }
];

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

/** Detecta o delimitador da primeira linha (vírgula vs ponto e vírgula). */
export function detectCsvDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  const commas = (firstLine.match(/,/g) ?? []).length;
  const semicolons = (firstLine.match(/;/g) ?? []).length;
  return semicolons > commas ? ";" : ",";
}

/** Parser CSV estilo RFC 4180 (aspas, aspas duplicadas, CRLF), delimitador configurável. */
export function parseCsvWithDelimiter(text: string, delimiter: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    if (inQuotes) {
      if (char === "\"") {
        if (clean[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === "\"") {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (char === "\r") {
      // ignorado: \r só existe como parte de CRLF
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((cell) => cell.trim() !== ""));
}

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const table = parseCsvWithDelimiter(text, detectCsvDelimiter(text));
  if (table.length === 0) return { headers: [], rows: [] };
  const [headers, ...body] = table;
  return { headers: headers.map((header) => header.trim()), rows: body };
}

export function csvEscape(value: string): string {
  return /[",\n\r;]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
}

export const IMPORT_TEMPLATE_FILENAME = "template-importacao-contatos.csv";

/** Template oficial: colunas canônicas + 2 linhas de exemplo (com BOM p/ Excel). */
export function buildImportTemplateCsv(): string {
  const table: string[][] = [
    IMPORT_TEMPLATE_COLUMNS,
    ["Maria Souza", "11987654321", "maria@exemplo.com", "instagram", "black friday", "Unidade Centro", "Estética", "Parceiro Alfa", "Cliente indicada, quer agendar avaliação"],
    ["João Pereira", "21991234567", "", "site", "", "Unidade Centro", "Consultoria", "", "Retornar depois das 18h"]
  ];
  const body = table.map((row) => row.map((cell) => csvEscape(cell)).join(",")).join("\r\n");
  return `\uFEFF${body}\r\n`;
}

/* ------------------------------------------------------------------ */
/* Mapeamento                                                          */
/* ------------------------------------------------------------------ */

export function normalizeImportHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Header vazio ou sem nome → "Ignorar" é a única opção coerente. */
export function autoMapColumns(headers: string[]): Array<ImportFieldId | ""> {
  const used = new Set<ImportFieldId>();
  const aliasIndex = new Map<string, ImportFieldId>();
  for (const field of IMPORT_FIELDS) {
    for (const alias of [field.id, ...(field.aliases ?? [])]) {
      const normalized = normalizeImportHeader(alias);
      if (normalized && !aliasIndex.has(normalized)) aliasIndex.set(normalized, field.id);
    }
  }
  return headers.map((header) => {
    const normalized = normalizeImportHeader(header);
    if (!normalized) return "";
    const exact = aliasIndex.get(normalized);
    if (exact && !used.has(exact)) {
      used.add(exact);
      return exact;
    }
    // Fallback: alias como palavra dentro de headers compostos
    // ("Número / WhatsApp" → telefone).
    for (const [alias, fieldId] of aliasIndex) {
      if (used.has(fieldId)) continue;
      const pattern = new RegExp(`(^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
      if (pattern.test(normalized)) {
        used.add(fieldId);
        return fieldId;
      }
    }
    return "";
  });
}

export type ImportMapping = Array<ImportFieldId | "">;

export function importMappingFieldCount(mapping: ImportMapping): number {
  return mapping.filter((entry) => entry !== "").length;
}

/** O telefone é a identidade do lead (R11): sem coluna mapeada não há import. */
export function importMappingMissingRequired(mapping: ImportMapping): ImportFieldId[] {
  return IMPORT_FIELDS.filter((field) => field.required && !mapping.includes(field.id)).map((field) => field.id);
}

/* ------------------------------------------------------------------ */
/* Contratos de API (pendentes do backend)                             */
/* ------------------------------------------------------------------ */

export type ImportPreview = { headers: string[]; rows: string[][] };

export const IMPORT_PREVIEW_PATH = "/organization/leads/import/preview";
export const IMPORT_SUBMIT_PATH = "/contact-ops/import";
export const IMPORT_HISTORY_PATH = "/organization/leads/import/history";

/** Preview no backend (obrigatório p/ XLSX; CSV é pré-parseado no cliente). */
export function previewImportFile(file: Blob, filename: string): Promise<ImportPreview> {
  const form = new FormData();
  form.append("file", file, filename);
  return api<ImportPreview>(IMPORT_PREVIEW_PATH, { method: "POST", body: form });
}

/** Base64 puro (sem o prefixo `data:…;base64,`) — o backend decodifica com Buffer.from(raw, "base64"). */
function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const separator = dataUrl.indexOf(",");
      resolve(separator === -1 ? dataUrl : dataUrl.slice(separator + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Falha ao ler o arquivo"));
    reader.readAsDataURL(file);
  });
}

/**
 * Mapping do wizard (array coluna→campo) → objeto do backend. O valor é o NOME
 * da coluna no arquivo (o backend resolve por header, case-insensitive);
 * colunas sem header não são referenciáveis e ficam de fora.
 */
export function buildImportMappingPayload(headers: string[], mapping: ImportMapping): Record<string, string> {
  const payload: Record<string, string> = {};
  mapping.forEach((field, index) => {
    const column = headers[index]?.trim();
    if (field && column) payload[field] = column;
  });
  return payload;
}

export async function submitImport(request: {
  file: Blob;
  filename: string;
  headers: string[];
  mapping: ImportMapping;
  onDuplicate: ImportDuplicatePolicy;
}): Promise<ImportResult> {
  const content = await fileToBase64(request.file);
  return api<ImportResult>(IMPORT_SUBMIT_PATH, {
    method: "POST",
    body: JSON.stringify({
      ...(/\.xlsx$/i.test(request.filename) ? { xlsx_base64: content } : { csv_base64: content }),
      filename: request.filename,
      mapping: buildImportMappingPayload(request.headers, request.mapping),
      options: { on_duplicate: request.onDuplicate }
    })
  });
}

export type ImportHistoryItem = {
  id: string;
  filename: string;
  created_at: string;
  imported: number;
  updated: number;
  skipped: number;
  duplicates_flagged: number;
  actor_email?: string | null;
};

export type ImportHistoryResponse = { imports?: ImportHistoryItem[] };

/* ------------------------------------------------------------------ */
/* Resultado                                                           */
/* ------------------------------------------------------------------ */

export type ImportResultError = { row: number; field: string; message: string };

export type ImportResult = {
  imported: number;
  updated: number;
  skipped: number;
  duplicates_flagged: number;
  errors?: ImportResultError[];
};

export type ImportResultLine = {
  line: number;
  status: "error";
  field: string;
  message: string;
};

/**
 * Erros por linha prontos para exibição. O backend não lista duplicados
 * sinalizados — o contador `duplicates_flagged` (badge "N possíveis
 * duplicados") é a única superfície deles; `row` é a linha 1-based do arquivo.
 */
export function importResultLines(result: ImportResult): ImportResultLine[] {
  return (result.errors ?? []).map((error) => ({
    line: error.row,
    status: "error",
    field: error.field,
    message: error.message
  }));
}

/** Download client-side dos erros completos (máx 50 visíveis na tela). */
export const IMPORT_ERRORS_FILENAME = "erros-importacao-contatos.csv";

/**
 * Coluna de mensagem sempre entre aspas: texto livre de leitura humana (a
 * mensagem pode ter vírgula, aspas ou quebra de linha sem aviso prévio), ao
 * contrário de linha/status, que são tokens fixos e seguem csvEscape normal.
 */
function csvQuoteFreeText(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function buildImportErrorsCsv(result: ImportResult): string {
  const lines = importResultLines(result);
  const header = ["linha", "status", "mensagem"].join(",");
  const body = lines
    .map((line) => [csvEscape(String(line.line)), csvEscape(line.status), csvQuoteFreeText(line.message)].join(","))
    .join("\r\n");
  return `\uFEFF${header}\r\n${body}\r\n`;
}
