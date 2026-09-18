import { describe, expect, it } from "vitest";
import { activationIssues, assertPublicWebhookUrl, flowDefinitionSchema, NEWAVE_FLOW, renderFinalMessage, renderQuestion, totalQuestions, webhookUrlSchema } from "../src/modules/qualification/flow.js";
import { classifyBoolean, classifyRevenue, classifyYears, matchAnswer, matchAnswerCandidates, normalizeInstagram } from "../src/modules/qualification/normalizer.js";

const FLOW = flowDefinitionSchema.parse({
  ...NEWAVE_FLOW,
  triggers: { ctwa: true, session_ids: [], keywords: [] }
});
const step = (id: string) => FLOW.steps[id];

describe("normalização de tempo de mercado", () => {
  it("interpreta linguagem natural", () => {
    expect(matchAnswer(step("P1_TEMPO_DE_MERCADO"), "tenho a loja há dois anos")).toBe("De 1 a 3 anos");
    expect(matchAnswer(step("P1_TEMPO_DE_MERCADO"), "uns 8 meses")).toBe("Menos de 1 ano");
    expect(matchAnswer(step("P1_TEMPO_DE_MERCADO"), "4 anos")).toBe("De 3 a 5 anos");
    expect(matchAnswer(step("P1_TEMPO_DE_MERCADO"), "mais de 5 anos")).toBe("Mais de 5 anos");
    expect(matchAnswer(step("P1_TEMPO_DE_MERCADO"), "quase 3 anos")).toBe("De 1 a 3 anos");
  });
  it("não inventa quando não dá para inferir", () => {
    expect(matchAnswer(step("P1_TEMPO_DE_MERCADO"), "faz um tempinho")).toBeNull();
    expect(classifyYears("nenhum número aqui")).toBeNull();
  });
});

describe("normalização de faturamento", () => {
  it("interpreta valores livres", () => {
    expect(matchAnswer(step("P2_FATURAMENTO"), "faturo uns 45 mil")).toBe("De R$ 30 mil a R$ 50 mil");
    expect(matchAnswer(step("P2_FATURAMENTO"), "uns 15000 por mês")).toBe("De R$ 10 mil a R$ 20 mil");
    expect(matchAnswer(step("P2_FATURAMENTO"), "R$ 8.000")).toBe("Até R$ 10 mil");
    expect(matchAnswer(step("P2_FATURAMENTO"), "passa de 100 mil")).toBe("Acima de R$ 100 mil");
    expect(matchAnswer(step("P2_FATURAMENTO"), "faturo 45")).toBe("De R$ 30 mil a R$ 50 mil");
  });
  it("trata 30 mil como faixa qualificada (>= 30 mil)", () => {
    expect(matchAnswer(step("P2_FATURAMENTO"), "30 mil")).toBe("De R$ 30 mil a R$ 50 mil");
    expect(matchAnswer(step("P2_FATURAMENTO"), "uns 25 mil")).toBe("De R$ 20 mil a R$ 30 mil");
  });
  it("aceita o texto exato da opção", () => {
    expect(matchAnswer(step("P2_FATURAMENTO"), "De R$ 20 mil a R$ 30 mil")).toBe("De R$ 20 mil a R$ 30 mil");
  });
  it("marca como ambíguo valores sem unidade clara", () => {
    expect(classifyRevenue("500")).toBeNull();
    expect(matchAnswer(step("P2_FATURAMENTO"), "razoável")).toBeNull();
  });
});

describe("normalização de nicho e perda de vendas", () => {
  it("mapeia por palavras-chave", () => {
    expect(matchAnswer(step("P3_NICHO"), "vendo celulares")).toBe("Smartphones e eletrônicos");
    expect(matchAnswer(step("P3_NICHO"), "patinetes elétricos")).toBe("Scooters");
    expect(matchAnswer(step("P3_NICHO"), "trabalho com óculos")).toBe("Ótica");
    expect(matchAnswer(step("P3_NICHO"), "vendo doces")).toBeNull();
    expect(matchAnswer(step("P4_PERDA_DE_VENDAS"), "o cliente não consegue pagar na hora")).toBe("Clientes não conseguem pagar à vista");
    expect(matchAnswer(step("P4_PERDA_DE_VENDAS"), "minha margem é muito apertada")).toBe("Margem de lucro muito baixa");
  });
  it("não escolhe a primeira opção quando a resposta contém múltiplas correspondências", () => {
    expect(matchAnswerCandidates(step("P3_NICHO"), "vendo celulares e scooters")).toEqual(["Smartphones e eletrônicos", "Scooters"]);
    expect(matchAnswer(step("P3_NICHO"), "vendo celulares e scooters")).toBeNull();
  });
});

describe("normalização de sim/não", () => {
  it("reconhece variações e negações", () => {
    expect(classifyBoolean("consigo sim")).toBe("SIM");
    expect(classifyBoolean("não tenho como agora")).toBe("NÃO");
    expect(classifyBoolean("talvez")).toBeNull();
    expect(matchAnswer(step("P5_INVESTIMENTO"), "com certeza")).toBe("SIM");
    expect(matchAnswer(step("P5_INVESTIMENTO"), "não dá")).toBe("NÃO");
  });
});

describe("definição do fluxo Newave", () => {
  it("calcula o caminho mais longo de perguntas", () => {
    expect(totalQuestions(FLOW)).toBe(5);
  });
  it("renderiza perguntas e encerra o formulário dentro da própria conversa", () => {
    expect(renderQuestion(step("P1_TEMPO_DE_MERCADO"))).toContain("• Menos de 1 ano");
    expect(renderQuestion(step("P5_INVESTIMENTO"))).toContain("(Sim ou Não)");
    expect(renderFinalMessage(step("E1_PAGINA_FINAL"))).toContain("Formulário concluído com sucesso");
    expect(renderFinalMessage(step("E2_PAGINA_FINAL"))).toContain("Formulário concluído com sucesso");
    for (const id of ["E1_PAGINA_FINAL", "E2_PAGINA_FINAL", "E3_ENCERRAMENTO"]) {
      expect(renderFinalMessage(step(id))).not.toMatch(/wa\.me|especialista/i);
    }
  });
  it("exige apenas um gatilho para ativar", () => {
    const incomplete = flowDefinitionSchema.parse(NEWAVE_FLOW);
    expect(activationIssues(incomplete)).toEqual([expect.stringContaining("gatilho")]);
    expect(activationIssues(FLOW)).toEqual([]);
  });
  it("neutraliza mensagens legadas de snapshots que redirecionavam para especialista", () => {
    expect(renderFinalMessage({
      kind: "final",
      classificacao: "Perfil Newave — alto faturamento",
      message: "Fala com um especialista: {{whatsapp_principal}}"
    })).toContain("Formulário concluído com sucesso");
    expect(renderFinalMessage({
      kind: "final",
      classificacao: "Perfil Newave — potencial com investimento",
      message: "Falar com a nossa equipe: https://wa.me/5511999999999"
    })).not.toMatch(/wa\.me|especialista|nossa equipe/i);
  });
});

describe("Instagram", () => {
  it("aceita @, URL do Instagram e ausência explícita", () => {
    expect(normalizeInstagram("@minha.loja")).toBe("@minha.loja");
    expect(normalizeInstagram("https://instagram.com/minha.loja")).toContain("instagram.com/minha.loja");
    expect(normalizeInstagram("não possui")).toBe("NÃO POSSUI");
  });
  it("rejeita texto livre e URL de outro domínio", () => {
    expect(normalizeInstagram("minha loja no insta")).toBeNull();
    expect(normalizeInstagram("https://example.com/minha.loja")).toBeNull();
  });
});

describe("webhook_url — SSRF (F-05)", () => {
  it("rejeita http:// e hosts internos", () => {
    expect(webhookUrlSchema.safeParse("http://example.com/hook").success).toBe(false);
    expect(webhookUrlSchema.safeParse("https://localhost/hook").success).toBe(false);
    expect(webhookUrlSchema.safeParse("https://192.168.1.1/hook").success).toBe(false);
    expect(webhookUrlSchema.safeParse("https://169.254.169.254/hook").success).toBe(false);
  });
  it("rejeita faixas privadas/loopback/CGNAT e IPv6 interno", () => {
    for (const url of [
      "https://10.0.0.5/hook",
      "https://127.0.0.1/hook",
      "https://0.1.2.3/hook",
      "https://172.16.0.9/hook",
      "https://172.31.255.1/hook",
      "https://100.64.0.1/hook",
      "https://minhaapp.internal/hook",
      "https://minhaapp.local/hook",
      "https://intranet/hook",
      "https://[::1]/hook",
      "https://[fc00::1]/hook",
      "https://[fe80::1]/hook",
      "https://[::ffff:10.0.0.1]/hook"
    ]) {
      expect(webhookUrlSchema.safeParse(url).success, url).toBe(false);
    }
  });
  it("aceita https público", () => {
    expect(webhookUrlSchema.safeParse("https://api.example.com/hook").success).toBe(true);
    expect(webhookUrlSchema.safeParse("https://8.8.8.8/hook").success).toBe(true);
  });
  it("guarda runtime bloqueia snapshot de fluxo obsoleto", () => {
    expect(() => assertPublicWebhookUrl("https://localhost/hook")).toThrow();
    expect(() => assertPublicWebhookUrl("https://192.168.0.10/hook")).toThrow();
    expect(() => assertPublicWebhookUrl("http://example.com/hook")).toThrow();
    expect(() => assertPublicWebhookUrl("https://api.example.com/hook")).not.toThrow();
  });
});
