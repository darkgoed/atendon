import { describe, expect, it } from "vitest";
import { agentSchema } from "../src/app.js";
import { parseAppConfig } from "../src/config.js";

const baseEnvironment = {
  DATABASE_URL: "postgresql://atendon:atendon@localhost:5436/atendon",
  PANEL_SEED_PASSWORD: "local-only"
};

describe("system prompt limits", () => {
  it("accepts and preserves prompts beyond the former 30,000-character cap", () => {
    const systemPrompt = `${"regra importante ".repeat(2_000)}MARCADOR-FINAL-${"x".repeat(20_000)}`;
    const parsed = agentSchema.parse({
      systemPrompt,
      aiModel: "model/long-prompt",
      temperature: 0.4,
      maxTokens: 512,
      isActive: true
    });

    expect(parsed.systemPrompt).toBe(systemPrompt);
  });

  it("still rejects prompts that contain only whitespace", () => {
    expect(() => agentSchema.parse({
      systemPrompt: "   \n\t",
      aiModel: "model/blank-prompt",
      temperature: 0.4,
      maxTokens: 512,
      isActive: true
    })).toThrow(/Informe as instruções do agente/);
  });

  it("preserves an unlimited default prompt while rejecting a whitespace-only seed/runtime value", () => {
    const defaultPrompt = `${"contexto extenso ".repeat(3_000)}MARCADOR-FINAL`;
    expect(parseAppConfig({ ...baseEnvironment, DEFAULT_SYSTEM_PROMPT: defaultPrompt }).DEFAULT_SYSTEM_PROMPT)
      .toBe(defaultPrompt);
    expect(() => parseAppConfig({ ...baseEnvironment, DEFAULT_SYSTEM_PROMPT: " \n\t " }))
      .toThrow(/DEFAULT_SYSTEM_PROMPT não pode conter somente espaços/);
  });
});
