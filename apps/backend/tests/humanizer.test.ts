import { describe, expect, it, vi } from "vitest";
import { composingDuration, consumeRateLimit, debounceInbound, DEFAULT_HUMANIZER_CONFIG, migrateHumanizerConfig, sanitizeOutbound, selectContextualReaction, splitResponse, withComposingRefresh, type HumanizerConfig } from "../src/modules/messages/humanizer.js";

const config: HumanizerConfig = {
  readDelay:{min:0,max:0},readingPause:{min:0,max:0},
  composing:{wpm:120,jitterMs:0,minMs:100,maxMs:10_000,resendIntervalMs:1000},
  presence:{onlineSessionMin:{min:1,max:1},offlineGapMin:{min:1,max:1},inactivityBeforeUnavailableMin:1,activeHours:{start:0,end:23}},
  debounce:{initialWindowMs:{min:10,max:10},silenceWindowMs:{min:10,max:10},extensionMs:{min:40,max:40}},
  messageSplit:{maxWordsPerBubble:4,pauseBetweenBubblesMs:{min:0,max:0}},
  timeOfDayMultiplier:{outsideActiveHours:1},reaction:{probability:0,emojis:[]},rateLimit:{maxMessagesPerContactPerMinute:2}
};

describe("humanizer", () => {
  it("splits long paragraphs without losing words", () => {
    expect(splitResponse("um dois três quatro cinco seis", 4)).toEqual(["um dois três quatro", "cinco seis"]);
  });
  it("prefers complete clauses and never leaves a dangling connector", () => {
    const response = "A gente oferece financiamento pro cliente final, ou seja o comprador pode parcelar a compra mesmo sem ter todo o dinheiro na hora, com análise de crédito feita pela Newave";
    expect(splitResponse(response, 18)).toEqual([
      "A gente oferece financiamento pro cliente final",
      "ou seja o comprador pode parcelar a compra mesmo sem ter todo o dinheiro na hora",
      "com análise de crédito feita pela Newave"
    ]);
  });
  it("splits the reported Newave follow-up into separate WhatsApp bubbles", () => {
    const response = "Claro Renan\n\nFunciona assim, a ideia é não travar a venda quando o cliente quer comprar e o cartão não cobre tudo, aí a Newave entra como uma opção de financiamento pra ele seguir com a compra e a loja não perder a venda\n\nSe tu quiser, eu posso te explicar melhor como fica o pagamento do cliente, como a loja recebe ou como a análise funciona?";
    expect(splitResponse(response, 30)).toEqual([
      "Claro Renan",
      "Funciona assim, a ideia é não travar a venda quando o cliente quer comprar e o cartão não cobre tudo",
      "aí a Newave entra como uma opção de financiamento pra ele seguir com a compra e a loja não perder a venda",
      "Se tu quiser, eu posso te explicar melhor como fica o pagamento do cliente, como a loja recebe ou como a análise funciona?"
    ]);
  });
  it("keeps a long commercial sentence in one bubble at the tenant's 48-word limit but not at the shared default of 30", () => {
    const sentence = "O cliente passa por uma análise e, se for aprovado, pode financiar o aparelho sem pagar tudo na hora, então sua loja ganha uma nova possibilidade de concluir uma venda que normalmente escaparia";
    expect(splitResponse(sentence, DEFAULT_HUMANIZER_CONFIG.messageSplit.maxWordsPerBubble).length).toBeGreaterThan(1);
    expect(splitResponse(sentence, 48)).toEqual([sentence]);
  });
  it("keeps a Brazilian decimal comma inside a monetary value intact when splitting by clause", () => {
    const response = "A moto sai de R$ 7.900,00 até R$ 9.900,00 dependendo da versão e da cor escolhida, e ainda dá pra parcelar em até 48x no cartão sem juros abusivos, com entrada facilitada";
    for (const part of splitResponse(response, 30)) {
      expect(part).not.toMatch(/\d,\s+\d/);
    }
    expect(splitResponse(response, 30).join(" ")).toContain("R$ 7.900,00");
    expect(splitResponse(response, 30).join(" ")).toContain("R$ 9.900,00");
  });
  // Bubble boundaries strip a dangling trailing comma/semicolon/colon on purpose
  // (finishBubble), so compare word content rather than exact punctuation.
  const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^\W+|\W+$/gu, "").toLowerCase());

  it("never loses or reorders words for texts just above 30, 48 and 60 words", () => {
    const paragraph = "Bom dia, tudo certo por aí? Vi que você se interessou pela nossa moto de entrada, que é ótima pra quem tá começando a trabalhar com entregas ou só quer economizar no dia a dia com combustível, ela vem com garantia de fábrica de um ano, revisões inclusas nos primeiros seis meses e assistência técnica em mais de cem cidades do país inteiro, além de aceitarmos seu usado na troca";
    for (const maxWords of [30, 48, 60]) {
      const bubbles = splitResponse(paragraph, maxWords);
      expect(words(bubbles.join(" "))).toEqual(words(paragraph));
      for (const bubble of bubbles) {
        expect(bubble.trim()).not.toMatch(/[,;:]$/);
        expect(bubble.split(/\s+/).length).toBeLessThanOrEqual(maxWords);
      }
    }
  });
  it("splits text with abbreviations without breaking the abbreviation itself", () => {
    const response = "Vc pode passar aqui na loja ou a gente manda o vendedor até vc, tipo assim: seg a sex das 9h às 18h, e sab das 9h às 13h, combinado?";
    const bubbles = splitResponse(response, 12);
    expect(words(bubbles.join(" "))).toEqual(words(response));
    for (const bubble of bubbles) expect(bubble.split(/\s+/).length).toBeGreaterThan(0);
  });
  it("falls back to word-boundary cuts for long text without any punctuation", () => {
    const response = "oi tudo bem eu queria saber mais sobre as motos que vocês vendem hoje porque eu vi no instagram de vocês um anúncio e fiquei interessado será que da pra conversar agora";
    const bubbles = splitResponse(response, 30);
    expect(bubbles.length).toBeGreaterThan(1);
    expect(bubbles.join(" ")).toBe(response);
    for (const bubble of bubbles) expect(bubble.split(/\s+/).length).toBeLessThanOrEqual(30);
  });
  it("ships with message splitting active by default", () => {
    expect(DEFAULT_HUMANIZER_CONFIG.messageSplit.maxWordsPerBubble).toBeLessThan(1000);
    expect(DEFAULT_HUMANIZER_CONFIG.messageSplit.pauseBetweenBubblesMs.max).toBeGreaterThan(0);
  });
  it("ships with balanced typing: not instant, not slow", () => {
    expect(DEFAULT_HUMANIZER_CONFIG.readDelay.min).toBeGreaterThanOrEqual(300);
    expect(DEFAULT_HUMANIZER_CONFIG.readingPause.min).toBeGreaterThanOrEqual(250);
    expect(DEFAULT_HUMANIZER_CONFIG.composing.wpm).toBeGreaterThanOrEqual(140);
    expect(DEFAULT_HUMANIZER_CONFIG.composing.wpm).toBeLessThanOrEqual(180);
    expect(DEFAULT_HUMANIZER_CONFIG.composing.minMs).toBeGreaterThanOrEqual(600);
    expect(DEFAULT_HUMANIZER_CONFIG.composing.maxMs).toBeLessThanOrEqual(4000);
    expect(DEFAULT_HUMANIZER_CONFIG.composing.resendIntervalMs).toBeGreaterThanOrEqual(5000);
    expect(DEFAULT_HUMANIZER_CONFIG.debounce.silenceWindowMs.min).toBeLessThanOrEqual(2000);
  });
  it("re-activates bubbles for tenants still carrying the disabled split sentinel", () => {
    const migrated = migrateHumanizerConfig({ ...config, messageSplit: { maxWordsPerBubble: 1000, pauseBetweenBubblesMs: { min: 0, max: 0 } } });
    expect(migrated.messageSplit).toEqual(DEFAULT_HUMANIZER_CONFIG.messageSplit);
    const custom = migrateHumanizerConfig({ ...config, messageSplit: { maxWordsPerBubble: 25, pauseBetweenBubblesMs: { min: 100, max: 200 } } });
    expect(custom.messageSplit).toEqual({ maxWordsPerBubble: 25, pauseBetweenBubblesMs: { min: 100, max: 200 } });
  });
  it("flattens Markdown links to the raw URL", () => {
    expect(sanitizeOutbound("Segue o link: [Clique aqui para acessar o formulário da Newave](https://sistema.newavepay.com/proposta-cliente/abc)"))
      .toBe("Segue o link: https://sistema.newavepay.com/proposta-cliente/abc");
    expect(sanitizeOutbound("https://exemplo.com sem markdown fica igual")).toBe("https://exemplo.com sem markdown fica igual");
  });
  it("removes internal fenced JSON and raw payloads", () => {
    expect(sanitizeOutbound("Resposta útil.\n```json\n{\"lead\":1}\n```" )).toBe("Resposta útil.");
    expect(sanitizeOutbound('{"payload":{"secret":true}}')).not.toContain("secret");
  });
  it("replaces dash punctuation that looks generated", () => {
    expect(sanitizeOutbound("Posso ver isso pra você — me diz o modelo")).toBe("Posso ver isso pra você, me diz o modelo");
    expect(sanitizeOutbound("Chego já – só um instante")).toBe("Chego já, só um instante");
  });
  it("removes every customer-facing hyphen without damaging links", () => {
    expect(sanitizeOutbound("Na prática é simples - o vendedor oferece - o cliente preenche os dados"))
      .toBe("Na prática é simples\n\no vendedor oferece\n\no cliente preenche os dados");
    expect(sanitizeOutbound("O retorno acontece na segunda-feira")).toBe("O retorno acontece na segunda feira");
    expect(sanitizeOutbound("Acesse https://meet.google.com/abc-defg-hij"))
      .toBe("Acesse https://meet.google.com/abc-defg-hij");
  });
  it("removes internal tool calls without discarding useful customer-facing prose", () => {
    expect(sanitizeOutbound('Qual unidade você prefere? registrar_lead(user_number, tenant, dados:{nome: "Arthur"}) enviar_formulario_payjoy(user_number, tenant)'))
      .toBe("Qual unidade você prefere?");
    expect(sanitizeOutbound("Resposta útil.\nconsultar_estoque({ produto: 'iPhone' })" )).toBe("Resposta útil.");
    expect(sanitizeOutbound('<tool_call>{"name":"registrar_lead","arguments":{"nome":"Arthur"}}</tool_call>Posso ajudar com mais alguma coisa?'))
      .toBe("Posso ajudar com mais alguma coisa?");
    expect(sanitizeOutbound('Ótimo, Arthur!\n\n`registrar_lead(user_number, tenant, dados:{nome: "Arthur"})`  \n`enviar_formulario_payjoy(user_number, tenant)`  \n\nAssim que preencher, seguimos.'))
      .toBe("Ótimo, Arthur!\n\nAssim que preencher, seguimos.");
  });
  it("removes bracket-style pseudo tool-call markers without touching the handoff marker", () => {
    expect(sanitizeOutbound("[verificar_horarios] Horário das 15h está disponível."))
      .toBe("Horário das 15h está disponível.");
    expect(sanitizeOutbound("Registrando seu interesse… [registrar_lead] Enviando formulário da Newave para você."))
      .toBe("Registrando seu interesse… Enviando formulário da Newave para você.");
    expect(sanitizeOutbound("Tudo certo! [[HANDOFF]]")).toBe("Tudo certo! [[HANDOFF]]");
  });
  it("calculates typing time from configured WPM", () => {
    expect(composingDuration("uma duas três quatro", config)).toBe(2000);
  });
  it("chooses reactions from message intent instead of randomly", () => {
    const allowed = ["👍", "❤️", "😊"];
    expect(selectContextualReaction("ok, pode enviar", allowed)).toBe("👍");
    expect(selectContextualReaction("muito obrigado!", allowed)).toBe("❤️");
    expect(selectContextualReaction("perfeito, gostei", allowed)).toBe("😊");
    expect(selectContextualReaction("qual é o valor?", allowed)).toBeUndefined();
    expect(selectContextualReaction("obrigado", ["👍"])).toBe("👍");
  });
  it("enforces a rolling per-contact message limit", () => {
    const key = `tenant:contact:${Math.random()}`;
    expect(consumeRateLimit(key, 2, 0)).toBe(true);
    expect(consumeRateLimit(key, 2, 1)).toBe(true);
    expect(consumeRateLimit(key, 2, 2)).toBe(false);
    expect(consumeRateLimit(key, 2, 60_000)).toBe(true);
  });
  it("debounces and gives only the latest waiter the combined text", { timeout: 10_000 }, async () => {
    vi.useFakeTimers();
    const first = debounceInbound("debounce-test", "Olá", { initialWindowMs: 10, silenceWindowMs: 10, extensionMs: 40 });
    const second = debounceInbound("debounce-test", "Tudo bem?", { initialWindowMs: 10, silenceWindowMs: 10, extensionMs: 40 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(first).resolves.toEqual({ text:"Olá\nTudo bem?", process:false });
    await expect(second).resolves.toEqual({ text:"Olá\nTudo bem?", process:true });
    vi.useRealTimers();
  });
  it("keeps listening while a contact sends spaced message fragments", async () => {
    vi.useFakeTimers();
    const first = debounceInbound("spaced-listening", "Arthur Muller", { initialWindowMs: 5_000, silenceWindowMs: 10_000, extensionMs: 45_000 });
    await vi.advanceTimersByTimeAsync(4_000);
    const second = debounceInbound("spaced-listening", "Não sou CLT", { initialWindowMs: 5_000, silenceWindowMs: 10_000, extensionMs: 45_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    const third = debounceInbound("spaced-listening", "Trabalho há 5 anos", { initialWindowMs: 5_000, silenceWindowMs: 10_000, extensionMs: 45_000 });
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(first).resolves.toEqual({ text: "Arthur Muller\nNão sou CLT\nTrabalho há 5 anos", process: false });
    await expect(second).resolves.toEqual({ text: "Arthur Muller\nNão sou CLT\nTrabalho há 5 anos", process: false });
    await expect(third).resolves.toEqual({ text: "Arthur Muller\nNão sou CLT\nTrabalho há 5 anos", process: true });
    vi.useRealTimers();
  });
  it("renews composing while an operation is still running", async () => {
    vi.useFakeTimers(); const refresh = vi.fn();
    const result = withComposingRefresh(10, async () => { refresh(); }, async () => { await new Promise(resolve => setTimeout(resolve, 25)); return "ok"; });
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toBe("ok"); expect(refresh).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
