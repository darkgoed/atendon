import { describe, expect, it } from "vitest";
import { commercialPreparationAnswers, qualificationAnswerLabel, readableQualificationAnswers } from "@/lib/labels";

describe("qualification answer labels", () => {
  it("translates known keys", () => {
    expect(qualificationAnswerLabel("momento_compra")).toBe("Momento de compra");
    expect(qualificationAnswerLabel("participacao_decisor")).toBe("Participação do decisor");
  });

  it("uses a readable fallback for unknown keys", () => {
    expect(qualificationAnswerLabel("nova_chave")).toBe("Nova chave");
  });

  it("omits empty values", () => {
    expect(readableQualificationAnswers({ cidade: "São Paulo", nicho: "", faturamento: "   " })).toEqual([
      { key: "cidade", label: "Cidade", value: "São Paulo" }
    ]);
  });

  it("keeps a stable reading order regardless of the jsonb key order", () => {
    const ordered = readableQualificationAnswers({
      momento_compra: "quente",
      nicho: "Smartphones",
      tempo_mercado: "3 anos"
    }).map((answer) => answer.key);
    expect(ordered).toEqual(["tempo_mercado", "nicho", "momento_compra"]);
  });

  it("selects only the two fields that prepare the closer for the call", () => {
    expect(commercialPreparationAnswers({
      tempo_mercado: "3 anos",
      nicho: "Smartphones",
      participacao_decisor: "Decisor: sócio; Todos participarão: não confirmado",
      momento_compra: "morno"
    })).toEqual([
      { key: "participacao_decisor", label: "Participação do decisor", value: "Decisor: sócio; Todos participarão: não confirmado" },
      { key: "momento_compra", label: "Momento de compra", value: "morno" }
    ]);
  });

  it("returns nothing when the commercial fields were not filled", () => {
    expect(commercialPreparationAnswers({ nicho: "Smartphones" })).toEqual([]);
    expect(commercialPreparationAnswers(null)).toEqual([]);
  });
});
