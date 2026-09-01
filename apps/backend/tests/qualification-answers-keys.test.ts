import { describe, expect, it } from "vitest";
import { qualificationAnswersBody } from "../src/modules/scheduling/service.js";
import { enabledToolDefinitions } from "../src/modules/ai-router/tools.js";

describe("qualification answer contract", () => {
  it("accepts and preserves the commercial qualification fields", () => {
    const result = qualificationAnswersBody.parse({
      participacao_decisor: "Decisor: sócio; Todos participarão: sim",
      momento_compra: "quente"
    });
    expect(result.participacao_decisor).toBe("Decisor: sócio; Todos participarão: sim");
    expect(result.momento_compra).toBe("quente");
  });

  it("rejects unknown answers", () => {
    expect(() => qualificationAnswersBody.parse({ inventada: "valor" })).toThrow();
  });

  it("keeps AI tool properties in parity with the strict zod schema", () => {
    const tool = enabledToolDefinitions(["qualificar_lead"]).find((item) => item.function.name === "qualificar_lead");
    expect(tool).toBeDefined();
    const parameters = tool!.function.parameters as unknown as { properties: { respostas: { properties: Record<string, unknown> } } };
    const aiKeys = Object.keys(parameters.properties.respostas.properties).sort();
    const zodKeys = Object.keys((qualificationAnswersBody as unknown as { shape: Record<string, unknown> }).shape).sort();
    expect(aiKeys).toEqual(zodKeys);
  });
});
