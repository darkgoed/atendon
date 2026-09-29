import { describe, expect, it } from "vitest";
import { protectedSystemPrompt } from "../src/modules/ai-router/prompt-guard.js";
import { REQUIRED_ZULU_TOOLS as TRIPZ_ZULU_TOOLS } from "../src/db/provision-tripz.js";
import {
  appendOffersInvitation,
  isTripzZuluAgent,
  tripzZuluDetectsBoletoPayment,
  tripzZuluDetectsExclusiveOffers,
  tripzZuluDetectsOwnerNameReferral,
  tripzZuluRequestsOwnerHandoff,
  tripzZuluTurnSignals
} from "../src/modules/tripz-ai/zulu.js";
import {
  TRIPZ_ZULU_OFFERS_GROUP_LINK,
  TRIPZ_ZULU_OWNER_NAME,
  TRIPZ_ZULU_OWNER_REFERRAL_REPLY,
  TRIPZ_ZULU_SYSTEM_PROMPT
} from "../src/db/zulu-provision.js";

describe("Tripz Zulu instruction and deterministic signals", () => {
  it("contains the complete triage principles and the configured offers link policy", () => {
    expect(TRIPZ_ZULU_SYSTEM_PROMPT).toContain("uma pergunta principal por vez");
    expect(TRIPZ_ZULU_SYSTEM_PROMPT).toContain("Lead A");
    expect(TRIPZ_ZULU_SYSTEM_PROMPT).toContain("Lead D");
    expect(TRIPZ_ZULU_SYSTEM_PROMPT).toContain("boleto bancário");
    expect(TRIPZ_ZULU_SYSTEM_PROMPT).toContain("grupo de ofertas");
    // O link do grupo é configuração do tenant/provisionamento, não constante do produto.
    expect(TRIPZ_ZULU_SYSTEM_PROMPT).not.toContain("chat.whatsapp.com");
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
      [`Confira nosso grupo de ofertas da Tripz: ${TRIPZ_ZULU_OFFERS_GROUP_LINK}`],
      TRIPZ_ZULU_OFFERS_GROUP_LINK,
      "da Tripz"
    ).exclusiveOffers).toBe(false);
    const invitation = appendOffersInvitation("Entendi 😊", TRIPZ_ZULU_OFFERS_GROUP_LINK, "da Tripz");
    expect(invitation).toContain(TRIPZ_ZULU_OFFERS_GROUP_LINK);
    expect(appendOffersInvitation(invitation, TRIPZ_ZULU_OFFERS_GROUP_LINK, "da Tripz")).toBe(invitation);
  });

  it("classifies boleto/bank-slip intent as a Tripz disqualifying signal", () => {
    expect(tripzZuluDetectsBoletoPayment("Quero pagar no boleto bancário")).toBe(true);
    expect(tripzZuluDetectsBoletoPayment("bank slip")).toBe(true);
    expect(tripzZuluTurnSignals("Quero pagar só no boleto").boletoPayment).toBe(true);
    expect(tripzZuluDetectsBoletoPayment("Não quero pagar no boleto")).toBe(false);
    expect(tripzZuluDetectsBoletoPayment("Prefiro cartão, sem boleto")).toBe(false);
  });

  it("detects a first message that already names the configured owner and carries the handoff reply", () => {
    const owner = TRIPZ_ZULU_OWNER_NAME;
    expect(tripzZuluDetectsOwnerNameReferral(`Oi ${owner}, tudo bem?`, owner)).toBe(true);
    expect(tripzZuluDetectsOwnerNameReferral(`O ${owner} me passou esse número`, owner)).toBe(true);
    expect(tripzZuluDetectsOwnerNameReferral("LUCAS, você tem um tempo?", "Lucas")).toBe(true);
    // Fail-closed: sem responsável configurado, o guard não dispara.
    expect(tripzZuluDetectsOwnerNameReferral("Oi Lucas, tudo bem?", "")).toBe(false);
    expect(tripzZuluDetectsOwnerNameReferral("Oi, gostaria de saber sobre viagens para Cancún", owner)).toBe(false);
    expect(tripzZuluDetectsOwnerNameReferral("Vi o anúncio de vocês no Instagram", owner)).toBe(false);
    expect(TRIPZ_ZULU_OWNER_REFERRAL_REPLY).toBe(
      "Olá, tudo bem? No momento o Lucas está em atendimento, vou transferir o chamado e em breve ele irá te responder."
    );
  });

  it("detects an explicit request for the owner without treating a bare mention as a request", () => {
    const owner = TRIPZ_ZULU_OWNER_NAME;
    expect(tripzZuluRequestsOwnerHandoff(`Gostaria de falar com o ${owner}`, owner)).toBe(true);
    expect(tripzZuluRequestsOwnerHandoff(`Pode me passar para o ${owner}?`, owner)).toBe(true);
    expect(tripzZuluRequestsOwnerHandoff(`O ${owner} me passou esse número`, owner)).toBe(false);
    expect(tripzZuluRequestsOwnerHandoff(`Você é o ${owner}?`, owner)).toBe(false);
    expect(tripzZuluRequestsOwnerHandoff(`Gostaria de falar com o ${owner}`, "")).toBe(false);
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
