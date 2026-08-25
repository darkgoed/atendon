import { describe, expect, it } from "vitest";
import { protectedSystemPrompt } from "../src/modules/ai-router/prompt-guard.js";
import { REQUIRED_ZULU_TOOLS as TRIPZ_ZULU_TOOLS } from "../src/db/provision-tripz.js";
import {
  appendTripzOffersInvitation,
  isTripzZuluAgent,
  TRIPZ_DEFAULT_OFFERS_GROUP_LINK,
  TRIPZ_ZULU_OWNER_REFERRAL_REPLY,
  TRIPZ_ZULU_SYSTEM_PROMPT,
  tripzZuluDetectsBoletoPayment,
  tripzZuluDetectsExclusiveOffers,
  tripzZuluDetectsOwnerNameReferral,
  tripzZuluRequestsOwnerHandoff,
  tripzZuluTurnSignals
} from "../src/modules/tripz-ai/zulu.js";

describe("Tripz Zulu instruction and deterministic signals", () => {
  it("contains the complete triage principles and the configured offers link policy", () => {
    expect(TRIPZ_ZULU_SYSTEM_PROMPT).toContain("uma pergunta principal por vez");
    expect(TRIPZ_ZULU_SYSTEM_PROMPT).toContain("Lead A");
    expect(TRIPZ_ZULU_SYSTEM_PROMPT).toContain("Lead D");
    expect(TRIPZ_ZULU_SYSTEM_PROMPT).toContain("boleto bancário");
    expect(TRIPZ_ZULU_SYSTEM_PROMPT).toContain("grupo de ofertas");
    expect(TRIPZ_DEFAULT_OFFERS_GROUP_LINK).toBe("https://chat.whatsapp.com/F2XZvKQaToNFf6cDFYKPDL");
    expect(TRIPZ_ZULU_SYSTEM_PROMPT).toContain(TRIPZ_DEFAULT_OFFERS_GROUP_LINK);
    expect(TRIPZ_ZULU_SYSTEM_PROMPT).toContain("ausência de abertura para alternativas");
    expect(TRIPZ_ZULU_SYSTEM_PROMPT).toContain("confirmar se são todos adultos ou se há criança");
  });

  it("does not invite a casual promotion mention, but does invite exclusive cheap-trip intent", () => {
    expect(tripzZuluDetectsExclusiveOffers("Vi uma promoção de Paris")).toBe(false);
    expect(tripzZuluDetectsExclusiveOffers("Vi uma promoção, mas aceito opções")).toBe(false);
    expect(tripzZuluDetectsExclusiveOffers("Só quero promoções e viagens baratas")).toBe(true);
    expect(tripzZuluDetectsExclusiveOffers("Quero o mais barato, sem mais nada")).toBe(true);
    expect(tripzZuluDetectsExclusiveOffers("Só quero viajar para Paris")).toBe(false);
    expect(tripzZuluDetectsExclusiveOffers("Só quero promoções, mas aceito outras opções")).toBe(false);
    expect(tripzZuluTurnSignals("Aceito analisar opções", ["Só quero promoções e viagens baratas"]).exclusiveOffers).toBe(false);
    expect(tripzZuluTurnSignals(
      "Só quero promoções e viagens baratas",
      [`Confira nosso grupo de ofertas da Tripz: ${TRIPZ_DEFAULT_OFFERS_GROUP_LINK}`],
      TRIPZ_DEFAULT_OFFERS_GROUP_LINK
    ).exclusiveOffers).toBe(false);
    const invitation = appendTripzOffersInvitation("Entendi 😊", TRIPZ_DEFAULT_OFFERS_GROUP_LINK);
    expect(invitation).toContain(TRIPZ_DEFAULT_OFFERS_GROUP_LINK);
    expect(appendTripzOffersInvitation(invitation, TRIPZ_DEFAULT_OFFERS_GROUP_LINK)).toBe(invitation);
  });

  it("classifies boleto/bank-slip intent as a Tripz disqualifying signal", () => {
    expect(tripzZuluDetectsBoletoPayment("Quero pagar no boleto bancário")).toBe(true);
    expect(tripzZuluDetectsBoletoPayment("bank slip")).toBe(true);
    expect(tripzZuluTurnSignals("Quero pagar só no boleto").boletoPayment).toBe(true);
    expect(tripzZuluDetectsBoletoPayment("Não quero pagar no boleto")).toBe(false);
    expect(tripzZuluDetectsBoletoPayment("Prefiro cartão, sem boleto")).toBe(false);
  });

  it("detects a first message that already names the owner and carries the fixed handoff reply", () => {
    expect(tripzZuluDetectsOwnerNameReferral("Oi Lucas, tudo bem?")).toBe(true);
    expect(tripzZuluDetectsOwnerNameReferral("O Lucas me passou esse número")).toBe(true);
    expect(tripzZuluDetectsOwnerNameReferral("LUCAS, você tem um tempo?")).toBe(true);
    expect(tripzZuluDetectsOwnerNameReferral("Oi, gostaria de saber sobre viagens para Cancún")).toBe(false);
    expect(tripzZuluDetectsOwnerNameReferral("Vi o anúncio de vocês no Instagram")).toBe(false);
    expect(TRIPZ_ZULU_OWNER_REFERRAL_REPLY).toBe(
      "Olá, tudo bem? No momento o Lucas está em atendimento, vou transferir o chamado e em breve ele irá te responder."
    );
  });

  it("detects an explicit request for Lucas without treating a bare mention as a request", () => {
    expect(tripzZuluRequestsOwnerHandoff("Gostaria de falar com o Lucas")).toBe(true);
    expect(tripzZuluRequestsOwnerHandoff("Pode me passar para o Lucas?")).toBe(true);
    expect(tripzZuluRequestsOwnerHandoff("O Lucas me passou esse número")).toBe(false);
    expect(tripzZuluRequestsOwnerHandoff("Você é o Lucas?")).toBe(false);
  });

  it("delivers Zulu a prompt free of other verticals", () => {
    // Regressão: a política global mandava a vertical de estoque/agenda para
    // todo tenant, e o Zulu passou a improvisar saudação de loja e a ignorar
    // a abertura própria da Tripz.
    const composed = protectedSystemPrompt(TRIPZ_ZULU_SYSTEM_PROMPT, "[HANDOFF]", TRIPZ_ZULU_TOOLS);
    for (const foreign of ["estoque", "iPhone", "Galaxy", "pesquisar_modelo", "disponibilidade de reunião"]) {
      expect(composed).not.toContain(foreign);
    }
    expect(composed).toContain("o escopo prevalece sobre os exemplos de tom desta política");
  });

  it("keeps the opening asking for the name", () => {
    expect(TRIPZ_ZULU_SYSTEM_PROMPT).toContain("Perguntar o nome nesse primeiro turno não é opcional");
    expect(TRIPZ_ZULU_SYSTEM_PROMPT).not.toContain("Obrigado pelo seu contato, qual o seu nome");
  });

  it("scopes the instruction to Zulu Tripz agents", () => {
    expect(isTripzZuluAgent(TRIPZ_ZULU_SYSTEM_PROMPT, true)).toBe(true);
    expect(isTripzZuluAgent(TRIPZ_ZULU_SYSTEM_PROMPT, false)).toBe(false);
    expect(isTripzZuluAgent("Você é um atendente genérico da Tripz IA copiloto", true)).toBe(false);
  });
});
