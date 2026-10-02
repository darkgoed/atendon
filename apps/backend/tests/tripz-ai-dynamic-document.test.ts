import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { proposalSpecSchema, renderProposalHtml, TRIPZ_PROPOSAL_BRAND, buildProposalPages } from "@atendon/proposal-renderer";
import { TRIPZ_DOCX_MIME, TRIPZ_XLSX_MIME, extractOfficeText, detectOfficeZip } from "../src/modules/tripz-ai/office-text.js";
import { validateTripzUpload } from "../src/modules/tripz-ai/storage.js";
import { applyEditorialBlock } from "../src/modules/tripz-ai/ai/orchestrator.js";
import { repairJsonObjectText, tripzProviderProposalPatchSchema, tripzProposalPatchSchema } from "../src/modules/tripz-ai/ai/schemas.js";
import { createEmptyTripzProposalState } from "../src/modules/tripz-ai/domain.js";
import { stateToSpec } from "../src/modules/tripz-ai/document/editorial.js";
import { TRIPZ_AI_SYSTEM_PROMPT } from "../src/modules/tripz-ai/ai/prompt.js";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

function docx(xml: string): Buffer {
  const container = XLSX.CFB.utils.cfb_new({ type: "zip" });
  XLSX.CFB.utils.cfb_add(container, "/[Content_Types].xml", Buffer.from("<Types/>"));
  XLSX.CFB.utils.cfb_add(container, "/word/document.xml", Buffer.from(xml));
  return Buffer.from(XLSX.CFB.write(container, { fileType: "zip", type: "buffer" }));
}

function xlsx(rows: unknown[][]): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Cotação");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

describe("documentos de escritório", () => {
  it("extrai texto de Word, Excel, CSV e TXT", () => {
    const word = docx("<w:document><w:body><w:p><w:r><w:t>Hotel St. Regis &amp; Spa</w:t></w:r></w:p><w:p><w:r><w:t>Total</w:t></w:r><w:tab/><w:r><w:t>R$ 36.000</w:t></w:r></w:p></w:body></w:document>");
    expect(detectOfficeZip(word)).toBe(TRIPZ_DOCX_MIME);
    expect(extractOfficeText(word, TRIPZ_DOCX_MIME)).toBe("Hotel St. Regis & Spa\nTotal\tR$ 36.000");
    const sheet = xlsx([["Voo", "Data"], ["LA 8084", "2027-08-20"]]);
    expect(detectOfficeZip(sheet)).toBe(TRIPZ_XLSX_MIME);
    expect(extractOfficeText(sheet, TRIPZ_XLSX_MIME)).toBe("### Planilha: Cotação\nVoo,Data\nLA 8084,2027-08-20");
    expect(extractOfficeText(Buffer.from("\uFEFFnome;valor\nCarlos;36000"), "text/csv")).toBe("nome;valor\nCarlos;36000");
  });

  it("upload valida o conteúdo real, não só a extensão", () => {
    const word = docx("<w:document><w:body><w:p><w:r><w:t>ok</w:t></w:r></w:p></w:body></w:document>");
    expect(validateTripzUpload({ fileName: "cotacao.docx", mimeType: TRIPZ_DOCX_MIME, data: word }).extension).toBe("docx");
    expect(validateTripzUpload({ fileName: "notas.md", mimeType: "text/plain", data: Buffer.from("Roteiro em Nova York") }).extension).toBe("txt");
    expect(() => validateTripzUpload({ fileName: "cotacao.xlsx", mimeType: TRIPZ_XLSX_MIME, data: word })).toThrow();
    expect(() => validateTripzUpload({ fileName: "binario.txt", mimeType: "text/plain", data: Buffer.from([0, 1, 2, 3, 0]) })).toThrow();
  });
});

describe("documento dinâmico", () => {
  const section = {
    id: "dicas", eyebrow: "DICAS", title: "O que levar", layout: "standard" as const, after: "concept",
    blocks: [{ type: "bullets" as const, style: "check" as const, items: ["Casaco leve", "Adaptador de tomada"] }]
  };

  it("patch da IA aceita seções, tema e layout; upsert e remoção por id", () => {
    const patch = tripzProposalPatchSchema.parse({
      destination: "Nova York",
      editorial: {
        customSections: [section],
        theme: { palette: { primary: "#1f3a2e" }, fontPair: "modern", coverStyle: "minimal" },
        pageOverrides: [{ page: "destination:nova-york", layout: "side", order: -1 }, { page: "section:dicas", hidden: false }]
      }
    });
    let state = applyEditorialBlock(createEmptyTripzProposalState(), patch.editorial!);
    expect(state.editorial?.customSections).toHaveLength(1);
    state = applyEditorialBlock(state, { customSections: [{ ...section, title: "Bagagem" }], theme: { palette: { accent: "#a5502f" } } });
    expect(state.editorial?.customSections?.[0].title).toBe("Bagagem");
    expect(state.editorial?.theme).toEqual({ palette: { primary: "#1f3a2e", accent: "#a5502f" }, fontPair: "modern", coverStyle: "minimal" });
    state = applyEditorialBlock(state, { customSections: [{ id: "dicas", remove: true }], theme: null });
    expect(state.editorial?.customSections).toEqual([]);
    expect(state.editorial?.theme).toBeUndefined();
    expect(() => tripzProposalPatchSchema.parse({ editorial: { customSections: [{ ...section, blocks: [{ type: "html", html: "<script>" }] }] } })).toThrow();
  });

  it("seções e tema chegam ao PDF; cor ilegível é descartada", () => {
    const state = applyEditorialBlock({ ...createEmptyTripzProposalState(), destination: "Nova York" }, {
      customSections: [section],
      theme: { palette: { primary: "#f5f5f5", accent: "#a5502f" }, fontPair: "elegant", coverStyle: "framed" }
    });
    const spec = proposalSpecSchema.parse(stateToSpec(state, { tenantId: "t" }).spec);
    expect(buildProposalPages(spec).map((page) => page.id)).toContain("section:dicas");
    const html = renderProposalHtml({ spec, brand: TRIPZ_PROPOSAL_BRAND, assets: {} });
    expect(html).toContain("O que levar");
    expect(html).toContain("Cormorant Garamond");
    expect(html).toContain("--tp-accent:#a5502f");
    expect(html).not.toContain("--tp-primary:#f5f5f5");
  });

  it("repara proposalPatch grande com chave sobrando ou cortado, sem aceitar lixo", () => {
    const patch = { destination: "Lisboa", editorial: { customSections: [section] } };
    const text = JSON.stringify(patch);
    expect(tripzProviderProposalPatchSchema.parse(`${text}}`)).toEqual(tripzProposalPatchSchema.parse(patch));
    expect(repairJsonObjectText(text.slice(0, -3))).toMatchObject({ destination: "Lisboa" });
    expect(repairJsonObjectText('{"a": "texto com } e { dentro"}}')).toEqual({ a: "texto com } e { dentro" });
    expect(repairJsonObjectText('{"a": "aberto')).toBeUndefined();
    expect(repairJsonObjectText("[1,2]")).toBeUndefined();
    expect(tripzProviderProposalPatchSchema.safeParse("{\"destination\": }").success).toBe(false);
  });

  it("normaliza formatos reais do modelo: seções no topo e inclusions como objeto", () => {
    const parsed = tripzProviderProposalPatchSchema.parse(JSON.stringify({
      destination: "Lisboa",
      customSections: [section],
      editorial: { inclusions: { eyebrow: "O QUE ESTÁ INCLUÍDO", items: ["Voos TAP", "Seguro viagem"] } }
    }));
    expect(parsed.editorial?.customSections?.[0]).toMatchObject({ id: "dicas" });
    expect(parsed.editorial?.inclusions).toEqual([{ section: "O QUE ESTÁ INCLUÍDO", items: [{ title: "Voos TAP" }, { title: "Seguro viagem" }] }]);
    const list = tripzProviderProposalPatchSchema.parse({ editorial: { inclusions: ["Traslado"] } });
    expect(list.editorial?.inclusions).toEqual([{ section: "Incluído", items: [{ title: "Traslado" }] }]);
  });

  it("item decorativo inválido é descartado sozinho; erro em dado real continua barrando", () => {
    const parsed = tripzProviderProposalPatchSchema.parse({
      destination: "Lisboa",
      editorial: {
        customSections: [section, { id: "Inválido Com Espaço", title: "x", blocks: [] }],
        theme: { fontPair: "comic-sans" }
      }
    });
    expect(parsed.editorial?.customSections).toEqual([{ ...section }]);
    expect(parsed.editorial?.theme).toBeUndefined();
    expect(tripzProviderProposalPatchSchema.safeParse({ startDate: "2027-02-30", editorial: { theme: { fontPair: "x" } } }).success).toBe(false);
  });

  it("texto de destino e hotel no lugar errado é movido, não perdido; nomes não repetem", () => {
    const parsed = tripzProviderProposalPatchSchema.parse({
      destination: "Lisboa e Sintra",
      editorial: {
        destinations: [
          { id: "lisboa", headline: "A cidade da saudade", body: ["Alfama e o Tejo."] },
          { id: "sintra", eyebrow: "SERRA", body: "Palácios na névoa." }
        ],
        hotels: [{ id: "memmo", name: "Memmo Alfama", headline: "Vista para o rio", body: ["Terraço.", "Piscina."] }]
      }
    });
    expect(parsed.editorial?.narrative?.destinationCopy).toEqual({
      lisboa: { headline: "A cidade da saudade", body: ["Alfama e o Tejo."] },
      sintra: { eyebrow: "SERRA", body: ["Palácios na névoa."] }
    });
    expect(parsed.editorial?.hotels?.[0]).toMatchObject({ description: "Terraço.\n\nPiscina.", highlightNote: "Vista para o rio" });
    const state = applyEditorialBlock({ ...createEmptyTripzProposalState(), destination: "Lisboa e Sintra" }, parsed.editorial!);
    const spec = proposalSpecSchema.parse(stateToSpec(state, { tenantId: "t" }).spec);
    expect(spec.destinations.map((item) => item.name)).toEqual(["Lisboa", "Sintra"]);
  });

  it("prompt ensina seções, blocos e tema", () => {
    for (const fragment of ["customSections", "\"timeline\"", "fontPair", "coverStyle", "POSTURA ABERTA"]) {
      expect(TRIPZ_AI_SYSTEM_PROMPT).toContain(fragment);
    }
  });
});
