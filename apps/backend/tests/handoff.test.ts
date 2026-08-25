import { describe, expect, it } from "vitest";
import {
  contactAcceptsOfferedHandoff,
  contactRequestsHandoff,
  parseAgentHandoff,
  unauthorizedAgentHandoffCorrection
} from "../src/modules/messages/handoff.js";

describe("handoff detection", () => {
  it.each([
    "Quero falar com um atendente",
    "Preciso de uma pessoa",
    "Pode transferir para humano?",
    "Quero atendimento humano",
    "me passa para alguém",
    "gostaria de conversar com uma pessoa",
    "Posso falar com um atendente?",
    "Me coloca em contato com a equipe",
    "Quero falar direto com o suporte",
    "Atendente, por favor"
  ])(
    "detects explicit contact request: %s", (text) => expect(contactRequestsHandoff(text)).toBe(true)
  );
  it.each([
    "Pode me ajudar com o boleto?",
    "Não entendi",
    "Tenho uma dúvida",
    "Não sei responder isso",
    "Já expliquei e estou irritado",
    "Não quero falar com um humano",
    "Não precisa me passar para alguém",
    "Não quero que você me passe para alguém",
    "Não quero atendimento humano",
    "Não gostei, mas quero continuar por aqui"
  ])("does not turn ordinary conversation into handoff: %s", (text) => {
    expect(contactRequestsHandoff(text)).toBe(false);
  });
  it("removes only the agent protocol marker", () => expect(parseAgentHandoff("Vou chamar alguém. [[HANDOFF]]"))
    .toEqual({ handoff: true, text: "Vou chamar alguém." }));

  it.each([
    "Show, já te conecto com o consultor.",
    "Vou te encaminhar para nossa equipe.",
    "Irei lhe transferir para um atendente."
  ])("rewrites an autonomous transfer announcement: %s", (text) => {
    expect(unauthorizedAgentHandoffCorrection(text)).toMatch(/qual informa[cç][aã]o|necessidade/iu);
  });

  it("preserves a genuine question offering human service", () => {
    expect(unauthorizedAgentHandoffCorrection("Você quer que eu te encaminhe para um atendente?"))
      .toBeUndefined();
  });

  it("accepts a short confirmation only after an identity-driven human offer", () => {
    expect(contactAcceptsOfferedHandoff("sim, por favor", [
      { role: "user", content: "Você é um robô?" },
      { role: "assistant", content: "Sou o assistente digital da Newave. Se preferir, posso chamar alguém da equipe." }
    ])).toBe(true);
    expect(contactAcceptsOfferedHandoff("sim", [
      { role: "user", content: "Já expliquei isso e fiquei irritado" },
      { role: "assistant", content: "Quer que eu chame um atendente?" }
    ])).toBe(false);
    expect(contactAcceptsOfferedHandoff("sim", [
      { role: "assistant", content: "Quer continuar por aqui?" }
    ])).toBe(false);
    expect(contactAcceptsOfferedHandoff("sim", [
      { role: "user", content: "Você é uma IA?" },
      { role: "assistant", content: "Sou um assistente digital, mas não posso chamar alguém da equipe." }
    ])).toBe(false);
  });
});
