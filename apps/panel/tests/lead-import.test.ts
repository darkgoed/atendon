// @vitest-environment jsdom
// R14/R11 — importação: parsing CSV (aspas, delimitador pt-BR), template
// oficial, mapeamento automático, contrato real de submissão (POST
// /contact-ops/import com base64 + mapping objeto) e erros row→line.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ api: vi.fn() }));

import { api } from "@/lib/api";
import {
  autoMapColumns,
  buildImportErrorsCsv,
  buildImportTemplateCsv,
  csvEscape,
  detectCsvDelimiter,
  IMPORT_TEMPLATE_COLUMNS,
  importMappingMissingRequired,
  importResultLines,
  normalizeImportHeader,
  parseCsv,
  submitImport,
  type ImportResult
} from "@/lib/lead-import";

describe("csv parsing", () => {
  it("detects pt-BR semicolon files before comma files", () => {
    expect(detectCsvDelimiter("nome;telefone\nAna;119")).toBe(";");
    expect(detectCsvDelimiter("nome,telefone\nAna,119")).toBe(",");
  });

  it("parses quotes, escaped quotes and CRLF rows", () => {
    const parsed = parseCsv("nome,telefone,observacao\r\n\"Ana \"\"Silva\"\"\",119,\"Quer\nagendar\"\r\nBruno,219,\"\"\r\n");
    expect(parsed.headers).toEqual(["nome", "telefone", "observacao"]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual(["Ana \"Silva\"", "119", "Quer\nagendar"]);
    expect(parsed.rows[1]).toEqual(["Bruno", "219", ""]);
  });

  it("strips the BOM and drops blank lines", () => {
    const parsed = parseCsv("\uFEFFnome,telefone\n\nAna,119\n");
    expect(parsed.headers).toEqual(["nome", "telefone"]);
    expect(parsed.rows).toEqual([["Ana", "119"]]);
  });
});

describe("official template", () => {
  it("brings the canonical columns plus two example rows, escaped and with BOM", () => {
    const csv = buildImportTemplateCsv();
    const parsed = parseCsv(csv);
    expect(parsed.headers).toEqual(IMPORT_TEMPLATE_COLUMNS);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0][1]).toBe("11987654321");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("escapes cells containing separator, quotes or newlines", () => {
    expect(csvEscape("normal")).toBe("normal");
    expect(csvEscape("a,b")).toBe("\"a,b\"");
    expect(csvEscape("a\"b")).toBe("\"a\"\"b\"");
  });
});

describe("column mapping", () => {
  it("normalizes headers stripping accents and case", () => {
    expect(normalizeImportHeader(" Telefone ")).toBe("telefone");
    expect(normalizeImportHeader("Observação")).toBe("observacao");
  });

  it("auto-maps canonical and aliased headers, ignoring unknown columns", () => {
    const mapping = autoMapColumns(["Nome do contato", "Número / WhatsApp", "E-mail", "Campanha", "outro"]);
    expect(mapping).toEqual(["nome", "telefone", "email", "campanha", ""]);
  });

  it("leaves template columns without backend destination unmapped", () => {
    // Decisão simplificada: unidade/categoria/parceiro/observação não têm
    // destino em /contact-ops/import e entram como "Ignorar coluna".
    expect(autoMapColumns(["unidade", "categoria", "parceiro", "observacao"])).toEqual(["", "", "", ""]);
  });

  it("blocks the import while the phone (identity per R11) is unmapped", () => {
    const missing = importMappingMissingRequired(autoMapColumns(["nome", "obs"]));
    expect(missing).toEqual(["telefone"]);
    expect(importMappingMissingRequired(autoMapColumns(["telefone"]))).toEqual([]);
  });
});

describe("import submit (POST /contact-ops/import)", () => {
  it("sends csv_base64 plus the mapping object keyed by column name", async () => {
    vi.mocked(api).mockClear().mockResolvedValue({ imported: 1, updated: 0, skipped: 0, duplicates_flagged: 0 });
    const content = "nome,telefone\nAna,119";
    const file = new File([content], "contatos.csv", { type: "text/csv" });
    await submitImport({
      file,
      filename: "contatos.csv",
      headers: ["nome", "telefone", "unidade"],
      mapping: ["nome", "telefone", ""],
      onDuplicate: "flag"
    });
    const [path, init] = vi.mocked(api).mock.calls[0];
    expect(path).toBe("/contact-ops/import");
    expect(init?.method).toBe("POST");
    const payload = JSON.parse(String(init?.body));
    expect(payload.csv_base64).toBe(btoa(content));
    expect(payload.xlsx_base64).toBeUndefined();
    expect(payload.filename).toBe("contatos.csv");
    expect(payload.mapping).toEqual({ nome: "nome", telefone: "telefone" });
    expect(payload.options).toEqual({ on_duplicate: "flag" });
  });

  it("routes .xlsx to xlsx_base64 and drops fields mapped to headerless columns", async () => {
    vi.mocked(api).mockClear().mockResolvedValue({ imported: 0, updated: 0, skipped: 0, duplicates_flagged: 0 });
    const file = new File(["x"], "planilha.xlsx");
    await submitImport({
      file,
      filename: "planilha.xlsx",
      headers: ["", "telefone"],
      mapping: ["nome", "telefone"],
      onDuplicate: "skip"
    });
    const payload = JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body));
    expect(Object.keys(payload)).toEqual(expect.arrayContaining(["xlsx_base64", "filename", "mapping", "options"]));
    expect(payload.csv_base64).toBeUndefined();
    expect(payload.mapping).toEqual({ telefone: "telefone" });
    expect(payload.options).toEqual({ on_duplicate: "skip" });
  });
});

describe("import result", () => {
  it("maps backend errors {row,field,message} to display lines (row = 1-based file line)", () => {
    const result: ImportResult = {
      imported: 8,
      updated: 0,
      skipped: 1,
      duplicates_flagged: 2,
      errors: [
        { row: 4, field: "linha", message: "Telefone ausente: todo contato precisa de um telefone válido" },
        { row: 7, field: "custom/aniversario", message: "Data inválida: use ISO (YYYY-MM-DD) ou dd/mm/aaaa" }
      ]
    };
    expect(importResultLines(result)).toEqual([
      { line: 4, status: "error", field: "linha", message: "Telefone ausente: todo contato precisa de um telefone válido" },
      { line: 7, status: "error", field: "custom/aniversario", message: "Data inválida: use ISO (YYYY-MM-DD) ou dd/mm/aaaa" }
    ]);
  });

  it("exports errors as CSV and reports flagged duplicates only as a count", () => {
    const result: ImportResult = {
      imported: 0,
      updated: 0,
      skipped: 0,
      duplicates_flagged: 3,
      errors: [{ row: 4, field: "linha", message: "Linha sem telefone" }]
    };
    const csv = buildImportErrorsCsv(result);
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe("linha,status,mensagem");
    expect(lines[1]).toBe("4,error,\"Linha sem telefone\"");
    expect(importResultLines(result)).toHaveLength(1);
    // Sem erros por linha (duplicados sinalizados viram só o contador).
    expect(importResultLines({ imported: 1, updated: 0, skipped: 0, duplicates_flagged: 3 })).toEqual([]);
  });
});
