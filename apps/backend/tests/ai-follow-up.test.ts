import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_FOLLOW_UP_NOT_NEEDED_MARKER,
  AiFollowUpProcessor,
  followUpContinuityContext,
  followUpSystemPrompt,
  hasAlreadyRetriedSameTopic,
  isRepetitiveFollowUp,
  isSameFollowUpTopic,
  parseFollowUpDecision,
  startsAsReplyToUnansweredMessage,
  startsLikeCannedFollowUp
} from "../src/modules/messages/ai-follow-up.js";

const acquireConversationLockMock = vi.hoisted(() => vi.fn());
const releaseConversationLockMock = vi.hoisted(() => vi.fn());
const extendConversationLockMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));

vi.mock("../src/modules/messages/conversation-lock.js", () => ({
  acquireConversationLock: acquireConversationLockMock,
  releaseConversationLock: releaseConversationLockMock,
  extendConversationLock: extendConversationLockMock
}));

const claim = {
  conversationId: "conversation-1",
  tenantId: "tenant-1",
  sessionId: "session-1",
  contactPhone: "5511999999999",
  contactJid: "5511999999999@s.whatsapp.net",
  sequenceVersion: 3,
  followUpCount: 0,
  maxCount: 2,
  delaysMinutes: [120, 1440],
  delivery: { type: "text" as const },
  model: "model-1",
  systemPrompt: "Atenda a loja com clareza.",
  temperature: 0.4,
  maxTokens: 512,
  history: [
    { role: "user" as const, content: "Gostei do aparelho azul. Tem como reservar?" },
    { role: "assistant" as const, content: "Consigo conferir a reserva. Você prefere retirar hoje ou amanhã?" }
  ]
};

function setup() {
  const repository = {
    claimDue: vi.fn().mockResolvedValue(claim),
    releaseClaim: vi.fn().mockResolvedValue(undefined),
    isClaimCurrent: vi.fn().mockResolvedValue(true),
    recordAiUsage: vi.fn().mockResolvedValue(undefined),
    completeSent: vi.fn().mockResolvedValue(undefined),
    cancelClaim: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue(false),
    createFailureAlert: vi.fn().mockResolvedValue(undefined)
  };
  const gateway = {
    setPresence: vi.fn().mockResolvedValue(undefined),
    sendPresence: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue({ externalId: "follow-up-sent-1" }),
    sendMedia: vi.fn().mockResolvedValue({ externalId: "follow-up-image-1" }),
    sendSticker: vi.fn().mockResolvedValue({ externalId: "follow-up-sticker-1" }),
    markMessageAsRead: vi.fn().mockResolvedValue(undefined)
  };
  const ai = {
    complete: vi.fn().mockImplementation(async (input) => {
      await input.onUsage?.({ providerRequestId: "follow-up-generation-1", model: "model-1", inputTokens: 12, outputTokens: 8, costUsd: 0.002 });
      return { text: "Pra eu deixar certinho, a retirada fica melhor hoje ou amanhã?", inputTokens: 12, outputTokens: 8, costUsd: 0.002 };
    })
  };
  return {
    processor: new AiFollowUpProcessor(repository as never, gateway, ai),
    repository,
    gateway,
    ai
  };
}

describe("AI follow-ups", () => {
  beforeEach(() => {
    acquireConversationLockMock.mockReset();
    acquireConversationLockMock.mockResolvedValue({ redisKey: "follow-up-lock", token: "token" });
    releaseConversationLockMock.mockReset();
    releaseConversationLockMock.mockResolvedValue(undefined);
  });

  it("prioritizes the latest exchange and records a contextual follow-up", async () => {
    const { processor, repository, gateway, ai } = setup();

    await expect(processor.process(claim.conversationId)).resolves.toBe("sent");

    expect(ai.complete).toHaveBeenCalledWith(expect.objectContaining({
      history: claim.history,
      systemPrompt: expect.stringContaining("prioridade máxima ao assunto que ficou pendente")
    }));
    expect(gateway.sendText).toHaveBeenCalledWith(
      claim.sessionId,
      claim.contactJid,
      "Pra eu deixar certinho, a retirada fica melhor hoje ou amanhã?"
    );
    expect(repository.recordAiUsage).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: claim.tenantId,
      conversationId: claim.conversationId,
      providerRequestId: "follow-up-generation-1"
    }));
    expect(repository.completeSent).toHaveBeenCalledWith(claim, expect.objectContaining({
      externalId: "follow-up-sent-1"
    }));
  });

  it("sends a multi-paragraph follow-up as separate bubbles and records every provider id", async () => {
    const { processor, repository, gateway, ai } = setup();
    const text = "Claro Renan\n\nFunciona assim, a ideia é não travar a venda quando o cliente quer comprar e o cartão não cobre tudo, aí a Newave entra como uma opção de financiamento pra ele seguir com a compra e a loja não perder a venda\n\nSe tu quiser, eu posso te explicar melhor como fica o pagamento do cliente, como a loja recebe ou como a análise funciona?";
    ai.complete.mockResolvedValueOnce({ text, inputTokens: 20, outputTokens: 67, costUsd: 0.003 });
    gateway.sendText.mockReset();
    gateway.sendText
      .mockResolvedValueOnce({ externalId: "follow-up-bubble-1" })
      .mockResolvedValueOnce({ externalId: "follow-up-bubble-2" })
      .mockResolvedValueOnce({ externalId: "follow-up-bubble-3" })
      .mockResolvedValueOnce({ externalId: "follow-up-bubble-4" });

    await expect(processor.process(claim.conversationId)).resolves.toBe("sent");

    expect(gateway.sendText).toHaveBeenCalledTimes(4);
    expect(gateway.sendText).toHaveBeenNthCalledWith(1, claim.sessionId, claim.contactJid, "Claro Renan");
    expect(gateway.sendText).toHaveBeenNthCalledWith(
      4,
      claim.sessionId,
      claim.contactJid,
      "Se tu quiser, eu posso te explicar melhor como fica o pagamento do cliente, como a loja recebe ou como a análise funciona?"
    );
    expect(repository.completeSent).toHaveBeenCalledWith(claim, expect.objectContaining({
      text,
      externalId: "follow-up-bubble-1",
      bubbles: [
        expect.objectContaining({ externalId: "follow-up-bubble-1", text: "Claro Renan" }),
        expect.objectContaining({ externalId: "follow-up-bubble-2" }),
        expect.objectContaining({ externalId: "follow-up-bubble-3" }),
        expect.objectContaining({ externalId: "follow-up-bubble-4" })
      ]
    }));
  });

  it("sends a selected case image with the generated follow-up as its caption", async () => {
    const { processor, repository, gateway, ai } = setup();
    repository.claimDue.mockResolvedValueOnce({
      ...claim,
      delivery: {
        type: "image",
        assetId: "11111111-1111-4111-8111-111111111111",
        name: "Case Newave — 14 dias",
        description: "Resultados de vendas do cliente Newave nos primeiros 14 dias.",
        mimeType: "image/png",
        fileName: "case-newave.png",
        sizeBytes: 8421,
        dataBase64: "aW1hZ2Vt"
      }
    });

    await expect(processor.process(claim.conversationId)).resolves.toBe("sent");

    expect(gateway.sendMedia).toHaveBeenCalledWith(claim.sessionId, claim.contactJid, {
      mediaType: "image",
      mimeType: "image/png",
      fileName: "case-newave.png",
      dataBase64: "aW1hZ2Vt",
      caption: "Pra eu deixar certinho, a retirada fica melhor hoje ou amanhã?"
    });
    expect(ai.complete).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining("Resultados de vendas do cliente Newave nos primeiros 14 dias.")
    }));
    expect(gateway.sendText).not.toHaveBeenCalled();
    expect(repository.completeSent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      text: "Pra eu deixar certinho, a retirada fica melhor hoje ou amanhã?",
      mediaType: "image",
      mediaMimeType: "image/png"
    }));
  });

  it("sends a selected sticker by itself without a text bubble", async () => {
    const { processor, repository, gateway } = setup();
    repository.claimDue.mockResolvedValueOnce({
      ...claim,
      delivery: {
        type: "sticker",
        assetId: "22222222-2222-4222-8222-222222222222",
        mimeType: "image/webp",
        fileName: "descontrair.webp",
        sizeBytes: 5120,
        dataBase64: "ZmlndXJpbmhh"
      }
    });

    await expect(processor.process(claim.conversationId)).resolves.toBe("sent");

    expect(gateway.sendSticker).toHaveBeenCalledWith(
      claim.sessionId,
      claim.contactJid,
      { dataBase64: "ZmlndXJpbmhh" }
    );
    expect(gateway.sendText).not.toHaveBeenCalled();
    expect(gateway.sendMedia).not.toHaveBeenCalled();
    expect(repository.completeSent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      text: "",
      mediaIsSticker: true
    }));
  });

  it("stops before sending when the contact changed the conversation during generation", async () => {
    const { processor, repository, gateway } = setup();
    repository.isClaimCurrent.mockResolvedValueOnce(false);

    await expect(processor.process(claim.conversationId)).resolves.toBe("cancelled");

    expect(repository.cancelClaim).toHaveBeenCalledWith(claim, "conversation_changed");
    expect(gateway.sendText).not.toHaveBeenCalled();
    expect(repository.completeSent).not.toHaveBeenCalled();
  });

  it("detects repeated copy and gives the model a concrete rewrite instruction", async () => {
    expect(isRepetitiveFollowUp(
      "Você prefere retirar hoje ou amanhã?",
      ["Consigo conferir. Você prefere retirar hoje ou amanhã?"]
    )).toBe(true);
    expect(isRepetitiveFollowUp(
      "Quer que eu compare as formas de pagamento antes de você decidir?",
      ["Consigo conferir. Você prefere retirar hoje ou amanhã?"]
    )).toBe(false);

    const prompt = followUpSystemPrompt(claim);
    expect(prompt).toContain("follow-up 1 de no máximo 2");
    expect(prompt).toContain("Não copie literalmente frases, perguntas, ofertas");
    expect(prompt).toContain("bora vender mais");
    expect(prompt).toContain("tem alguém por aí");
    expect(prompt).toContain("não uma frase de cobrança seguida da mesma pergunta");
    expect(prompt).toContain("Por aí o pessoal costuma fechar mais no pix ou dividir?");
    expect(prompt).toContain("foco em chegar ao agendamento");
    expect(prompt).toContain("confirmar um horário concreto já oferecido");
    expect(prompt).toContain("SDR ou especialista");
    expect(prompt).toContain(AI_FOLLOW_UP_NOT_NEEDED_MARKER);
  });

  it("lets the model cancel a follow-up when the missing response is not required to advance", async () => {
    const { processor, repository, gateway, ai } = setup();
    repository.claimDue.mockResolvedValueOnce({
      ...claim,
      history: [
        { role: "user", content: "Prefiro não informar o ticket." },
        { role: "assistant", content: "Pode me passar uma faixa do ticket médio da loja?" }
      ]
    });
    ai.complete.mockResolvedValueOnce({
      text: AI_FOLLOW_UP_NOT_NEEDED_MARKER,
      inputTokens: 10,
      outputTokens: 4,
      costUsd: 0.001
    });

    await expect(processor.process(claim.conversationId)).resolves.toBe("cancelled");

    expect(parseFollowUpDecision(AI_FOLLOW_UP_NOT_NEEDED_MARKER)).toEqual({ send: false, text: "" });
    expect(parseFollowUpDecision(`${AI_FOLLOW_UP_NOT_NEEDED_MARKER} texto indevido`)).toEqual({
      send: false,
      text: "texto indevido"
    });
    expect(repository.cancelClaim).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: claim.conversationId, history: expect.arrayContaining([
        expect.objectContaining({ content: "Prefiro não informar o ticket." })
      ]) }),
      "response_not_required"
    );
    expect(gateway.sendText).not.toHaveBeenCalled();
    expect(repository.completeSent).not.toHaveBeenCalled();
  });

  it("keeps a concrete scheduling confirmation eligible for follow-up", async () => {
    const { processor, repository, gateway } = setup();
    const schedulingClaim = {
      ...claim,
      history: [
        { role: "user" as const, content: "Pode ser amanhã." },
        { role: "assistant" as const, content: "Tenho 10h disponível amanhã. Posso confirmar esse horário?" }
      ]
    };
    repository.claimDue.mockResolvedValueOnce(schedulingClaim);

    await expect(processor.process(claim.conversationId)).resolves.toBe("sent");

    expect(gateway.sendText).toHaveBeenCalledOnce();
    expect(repository.cancelClaim).not.toHaveBeenCalledWith(schedulingClaim, "response_not_required");
  });

  it("rejects a no-send marker mixed with customer-facing text", async () => {
    const { processor, ai, gateway } = setup();
    ai.complete.mockImplementationOnce(async (input) => {
      expect(input.validateFinalText?.(`${AI_FOLLOW_UP_NOT_NEEDED_MARKER} Posso ajudar em algo mais?`))
        .toContain("deve ser somente");
      return { text: AI_FOLLOW_UP_NOT_NEEDED_MARKER, inputTokens: 10, outputTokens: 4, costUsd: 0.001 };
    });

    await expect(processor.process(claim.conversationId)).resolves.toBe("cancelled");
    expect(gateway.sendText).not.toHaveBeenCalled();
  });

  it("does not cancel the sequence or hand off when a model emits an unauthorized marker", async () => {
    const { processor, repository, ai, gateway } = setup();
    ai.complete.mockImplementationOnce(async (input) => {
      expect(input.validateFinalText?.("[[HANDOFF]]")).toContain("não pediu atendimento humano");
      // Simula um provider que ignorou o callback de validação.
      return { text: "[[HANDOFF]]", inputTokens: 10, outputTokens: 4, costUsd: 0.001 };
    });

    await expect(processor.process(claim.conversationId)).rejects.toThrow(/unauthorized handoff/i);
    expect(repository.cancelClaim).not.toHaveBeenCalled();
    expect(gateway.sendText).not.toHaveBeenCalled();
  });

  it("exposes factual continuity and recognizes the same pending topic across rewrites", () => {
    const ticketHistory = [
      { role: "user" as const, content: "Prefiro não passar esse valor." },
      { role: "assistant" as const, content: "Tranquilo, isso só ajuda a entender o formato, mas não é obrigatório." },
      { role: "assistant" as const, content: "Posso só uma faixa aproximada do ticket médio, por exemplo até 1k, de 1 a 2k, de 2 a 3k ou acima de 3k?" },
      { role: "assistant" as const, content: "Só pra ter uma noção rápida, o ticket médio fica até 1k, entre 1 e 2k, entre 2 e 3k ou acima de 3k?" }
    ];

    expect(isSameFollowUpTopic(ticketHistory[2].content, ticketHistory[3].content)).toBe(true);
    expect(isSameFollowUpTopic(
      "Posso só uma faixa aproximada do ticket médio, por exemplo até 1k, 1 2k, 2 3k ou acima de 3k?",
      "Tranquilo, Jeferson, só pra ter uma noção rápida, você diria que o ticket médio fica em uma dessas faixas: até 1k, entre 1 e 2k, entre 2 e 3k ou acima de 3k?"
    )).toBe(true);
    expect(isSameFollowUpTopic(
      "Tranquilo, Jeferson, só pra ter uma noção rápida, você diria que o ticket médio fica em uma dessas faixas: até 1k, entre 1 e 2k, entre 2 e 3k ou acima de 3k?",
      "Pode me dizer em qual faixa fica o ticket médio da loja, até 1k, entre 1 e 2k, entre 2 e 3k ou acima de 3k?"
    )).toBe(true);
    expect(isSameFollowUpTopic(
      ticketHistory[3].content,
      "Quer que eu te mostre como funciona o financiamento para a loja?"
    )).toBe(false);
    expect(hasAlreadyRetriedSameTopic(ticketHistory)).toBe(true);
    expect(followUpContinuityContext(ticketHistory)).toContain("Mensagens do atendimento depois dela, ainda sem nova resposta do contato: 3");
    expect(followUpContinuityContext(ticketHistory)).toContain("Prefiro não passar esse valor.");
  });

  it("keeps sending the configured sequence while a required scheduling confirmation remains unanswered", async () => {
    const { processor, repository, gateway, ai } = setup();
    repository.claimDue.mockResolvedValueOnce({
      ...claim,
      followUpCount: 1,
      maxCount: 3,
      history: [
        { role: "user", content: "Amanhã de manhã funciona." },
        { role: "assistant", content: "Tenho amanhã às 10h. Posso confirmar esse horário?" },
        { role: "assistant", content: "Posso reservar para você o horário de amanhã às 10h?" }
      ]
    });

    await expect(processor.process(claim.conversationId)).resolves.toBe("sent");

    expect(repository.cancelClaim).not.toHaveBeenCalled();
    expect(ai.complete).toHaveBeenCalledOnce();
    expect(gateway.sendText).toHaveBeenCalledOnce();
  });

  it("keeps the latest agent question unanswered instead of inventing a contact reply", async () => {
    expect(startsAsReplyToUnansweredMessage("Entendi, só smartphones, perfeito.")).toBe(true);
    expect(startsAsReplyToUnansweredMessage("Boa, smartphones mesmo")).toBe(true);
    expect(startsAsReplyToUnansweredMessage("Show, então vocês vendem parcelado.")).toBe(true);
    expect(startsAsReplyToUnansweredMessage("Perfeito! Onde vocês sentem que perdem vendas hoje?")).toBe(true);
    expect(startsAsReplyToUnansweredMessage("Vocês trabalham também com acessórios ou somente com smartphones?")).toBe(false);

    const prompt = followUpSystemPrompt(claim);
    expect(prompt).toContain("continua SEM RESPOSTA");
    expect(prompt).toContain("não avance como se ele tivesse respondido");
    expect(prompt).toContain("É permitido reformular a última pergunta ainda não respondida");
  });

  it("rejects formal or canned collection openings and requests a casual new approach", async () => {
    expect(startsLikeCannedFollowUp(
      "Fico no aguardo por aqui, me diz só se hoje vocês vendem mais à vista ou parcelado?"
    )).toBe(true);
    expect(startsLikeCannedFollowUp(
      "Me diz só se hoje vocês vendem mais à vista ou parcelado?"
    )).toBe(true);
    expect(startsLikeCannedFollowUp("Por aí sai mais no pix ou parcelado?")).toBe(false);

    const { processor, ai, gateway } = setup();
    ai.complete.mockImplementationOnce(async (input) => {
      const correction = input.validateFinalText?.(
        "Fico no aguardo por aqui, me diz só se hoje vocês vendem mais à vista ou parcelado?"
      );
      expect(correction).toContain("soa como cobrança automática");
      expect(correction).toContain("mudando de verdade a abordagem");
      return { text: "Por aí o pessoal costuma fechar mais no pix ou dividir?", inputTokens: 10, outputTokens: 8, costUsd: 0.001 };
    });

    await expect(processor.process(claim.conversationId)).resolves.toBe("sent");
    expect(gateway.sendText).toHaveBeenCalledWith(
      claim.sessionId,
      claim.contactJid,
      "Por aí o pessoal costuma fechar mais no pix ou dividir?"
    );
  });

  it("asks the model to rewrite a follow-up that acknowledges a nonexistent reply", async () => {
    const { processor, ai, gateway } = setup();
    ai.complete.mockImplementationOnce(async (input) => {
      const correction = input.validateFinalText?.("Entendi, só smartphones, perfeito. Onde vocês perdem vendas hoje?");
      expect(correction).toContain("nenhuma resposta chegou");
      return { text: "Além dos smartphones, vocês trabalham com alguma outra linha de produtos?", inputTokens: 10, outputTokens: 8, costUsd: 0.001 };
    });

    await expect(processor.process(claim.conversationId)).resolves.toBe("sent");
    expect(gateway.sendText).toHaveBeenCalledWith(
      claim.sessionId,
      claim.contactJid,
      "Além dos smartphones, vocês trabalham com alguma outra linha de produtos?"
    );
  });
});
