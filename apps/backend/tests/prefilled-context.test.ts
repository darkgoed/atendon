import { describe, expect, it } from "vitest";
import {
  canonicalizeMeetingDurationPrompt,
  extractPrefilledFields,
  initialPrefilledGreetingCorrection,
  meetingDurationContextNote,
  meetingDurationDisclosureCorrection,
  meetingInvitationContextCorrection,
  prefilledLeadContextNote,
  prefilledQualificationAcknowledgement,
  prefilledQualificationCompletionCorrection,
  schedulingAvailabilityPolicyCorrection,
  schedulingPeriodQuestionCorrection
} from "../src/modules/messages/prefilled-context.js";

describe("contexto de anúncio ou formulário preenchido", () => {
  it("extrai o exemplo reportado sem depender de uma lista fixa de campos", () => {
    const content = `Olá! Preenchi seu formulário e gostaria de saber mais sobre sua empresa.

Há quanto tempo sua empresa está no mercado?: Menos de 1 ano
Qual é o faturamento médio mensal da empresa?: Até R$ 30 mil
Qual é o nicho da sua empresa?: Outros
Qual o principal motivo da perda de vendas na sua loja?: Perco clientes por falta de limite no cartão
Qual o Instagram da sua empresa?: Não temos
Email: batistalima37@gmail.com
Full name: Jeferson Santos
Phone number: +5511949401803
State: SP`;

    const fields = extractPrefilledFields([{ role: "user", content }]);
    expect(fields).toHaveLength(9);
    expect(fields).toEqual(expect.arrayContaining([
      { label: "Full name", value: "Jeferson Santos" },
      { label: "Qual é o nicho da sua empresa?", value: "Outros" },
      { label: "Qual o Instagram da sua empresa?", value: "Não temos" }
    ]));

    const note = prefilledLeadContextNote([{ role: "user", content }]);
    expect(note).toContain("Full name: Jeferson Santos");
    expect(note).toContain("qualquer que seja o nome do campo");
    expect(note).toContain("não peça confirmação");
    expect(note).toContain("Outros");
  });

  it("aceita campos arbitrários e faz a resposta mais recente para o mesmo rótulo prevalecer", () => {
    const history = [
      { role: "user" as const, content: "Cor favorita: azul\nPossui equipe própria: sim" },
      { role: "assistant" as const, content: "Entendi" },
      { role: "user" as const, content: "Cor favorita: verde\nPrazo desejado — ainda esta semana" }
    ];
    expect(extractPrefilledFields(history)).toEqual(expect.arrayContaining([
      { label: "Possui equipe própria", value: "sim" },
      { label: "Cor favorita", value: "verde" },
      { label: "Prazo desejado", value: "ainda esta semana" }
    ]));
    expect(extractPrefilledFields(history)).toHaveLength(3);
  });

  it("não confunde uma frase isolada com dois-pontos com um formulário", () => {
    expect(extractPrefilledFields([{ role: "user", content: "Só uma observação: prefiro falar amanhã" }])).toEqual([]);
  });

  it("aceita anúncio com um único campo quando há indicação de formulário ou atribuição Meta", () => {
    expect(extractPrefilledFields([{ role: "user", content: "Preenchi o formulário\nSegmento especial: energia solar" }]))
      .toEqual([{ label: "Segmento especial", value: "energia solar" }]);
    expect(prefilledLeadContextNote(
      [{ role: "user", content: "Pergunta única da campanha: resposta única" }],
      { provider: "meta", source_type: "ad" }
    )).toContain("Pergunta única da campanha: resposta única");
  });

  it("combina campos preenchidos recebidos como metadados com os campos do texto", () => {
    const note = prefilledLeadContextNote(
      [{ role: "user", content: "Modelo de atendimento: presencial\nQuantidade de lojas: 2" }],
      { prefilled_fields: { "Cidade de operação": "Campinas", "Possui CNPJ": "Sim" } }
    );
    expect(note).toContain("Cidade de operação: Campinas");
    expect(note).toContain("Modelo de atendimento: presencial");
  });

  it("gera um reconhecimento específico para o formulário reportado", () => {
    const history = [{ role: "user" as const, content: `Olá! Preenchi seu formulário e gostaria de saber mais sobre sua empresa.
Há quanto tempo sua empresa está no mercado?: Mais de 5 anos
Qual é o faturamento médio mensal da empresa?: Mais de 50mil
Qual é o nicho da sua empresa?: Venda de smartphone
Qual o principal motivo da perda de vendas na sua loja?: Perco clientes por falta de limite no cartão
Qual o Instagram da sua empresa?: Não temos
Full name: Renan de Carvalho` }];

    expect(prefilledQualificationAcknowledgement(history)).toBe(
      "Oi, Renan, tudo certo?\n\nEntendi o cenário da sua loja de smartphones e como a falta de limite no cartão acaba travando vendas"
    );
  });

  it("não inventa uma mensagem de espera quando não há campos de formulário", () => {
    expect(prefilledQualificationAcknowledgement([
      { role: "user", content: "Não temos Instagram" }
    ])).toBeUndefined();
  });

  it("bloqueia novas perguntas de qualificação quando o formulário já cobre todos os tópicos", () => {
    const history = [{ role: "user" as const, content: `Preenchi o formulário
Há quanto tempo sua empresa está no mercado?: Menos de 1 ano
Qual é o faturamento médio mensal da empresa?: Até R$ 30 mil
Qual é o nicho da sua empresa?: Outros
Qual o principal motivo da perda de vendas na sua loja?: Falta de limite no cartão
Qual o Instagram da sua empresa?: Não temos` }];

    expect(prefilledQualificationCompletionCorrection(
      "Me diz só qual é o ticket médio de uma venda na tua loja?",
      history
    )).toMatch(/não faça outra pergunta de qualificação/i);
    expect(prefilledQualificationCompletionCorrection(
      "Pra eu seguir certinho por aqui, me conta o que vocês vendem hoje?",
      history
    )).toMatch(/não faça outra pergunta de qualificação/i);
    expect(prefilledQualificationCompletionCorrection(
      "Hoje vocês vendem mais à vista ou parcelado?",
      history
    )).toMatch(/não faça outra pergunta de qualificação/i);
    expect(prefilledQualificationCompletionCorrection(
      "Tenho horários de reunião às 14h e às 16h, qual fica melhor?",
      history
    )).toBeUndefined();
  });

  it("não bloqueia perguntas quando o formulário ainda não cobre os tópicos essenciais", () => {
    const history = [{ role: "user" as const, content: "Preenchi o formulário\nNicho: smartphones\nInstagram: Não temos" }];
    expect(prefilledQualificationCompletionCorrection("Há quanto tempo a empresa está no mercado?", history)).toBeUndefined();
  });
});

describe("política de oferta de horários", () => {
  it.each([
    "Tenho disponibilidade de reunião pra hoje mais tarde? quais horários melhor pra você?",
    "Quais horários você prefere para a nossa reunião?",
    "Qual dia fica melhor para você?",
    "Quando você tem disponibilidade?",
    "Me diz sua disponibilidade para a reunião"
  ])("bloqueia pergunta aberta ou pergunta sobre a própria disponibilidade: %s", (text) => {
    expect(schedulingAvailabilityPolicyCorrection(text)).toContain("Consulte agora");
  });

  it("aceita a escolha entre horários concretos retornados", () => {
    expect(schedulingAvailabilityPolicyCorrection("Hoje tenho às 14h e às 16h, qual fica melhor pra você?")).toBeUndefined();
    expect(schedulingAvailabilityPolicyCorrection("Hoje tenho ao meio-dia, esse horário funciona pra você?")).toBeUndefined();
  });

  it("identifica o bate-papo, a faixa comercial e o Google Meet ao perguntar o período", () => {
    expect(schedulingPeriodQuestionCorrection("Você prefere conversar de manhã ou à tarde?"))
      .toContain("bate-papo de 20 a 40 minutos no Google Meet");
    expect(schedulingPeriodQuestionCorrection(
      "Para marcar nosso bate-papo de 20–40 minutos no Google Meet, você prefere de manhã ou à tarde?"
    )).toBeUndefined();
    expect(schedulingPeriodQuestionCorrection(
      "Para marcar uma conversa de 15 minutos no Google Meet, você prefere de manhã ou à tarde?"
    )).toContain("20 a 40 minutos");
    expect(schedulingPeriodQuestionCorrection(
      "Para uma conversa no Google Meet, você prefere de manhã ou à tarde? Nosso SLA é de 20 a 40 minutos."
    )).toContain("bate-papo de 20 a 40 minutos no Google Meet");
  });
});

describe("contextualização do convite para reunião", () => {
  const slotDurationMinutes = 60;
  const history = [{ role: "user" as const, content: `Preenchi o formulário
Há quanto tempo sua empresa está no mercado?: Mais de 5 anos
Qual é o faturamento médio mensal da empresa?: Mais de 50 mil
Qual é o nicho da sua empresa?: Venda de smartphone
Qual o principal motivo da perda de vendas na sua loja?: Perco clientes por falta de limite no cartão
Qual o Instagram da sua empresa?: Não temos` }];

  it("bloqueia a chamada fixa de 15 minutos reportada mesmo sem citar o Meet", () => {
    expect(meetingDurationDisclosureCorrection(
      "Vamos marcar uma chamada rapidinha de 15 minutos?"
    )).toMatch(/20 a 40 minutos no Google Meet/i);
  });

  it("bloqueia a oferta seca de horários reportada", () => {
    expect(meetingInvitationContextCorrection(
      "Perfeito, pra amanhã tenho 9h, 10h e 11h\n\nMe diz qual horário fica melhor pra você",
      history,
      {},
      slotDurationMinutes
    )).toMatch(/bate-papo de 20 a 40 minutos no Google Meet/i);
  });

  it("usa a atribuição pré-preenchida para impedir novas perguntas sobre o formulário", () => {
    expect(meetingInvitationContextCorrection(
      "Amanhã tenho 9h e 10h, qual fica melhor?",
      history,
      { source_id: "form-1" },
      slotDurationMinutes
    )).toMatch(/dados do anúncio ou formulário já são contexto suficiente/i);
  });

  it("aceita a faixa comercial sem expor a duração operacional", () => {
    expect(meetingInvitationContextCorrection(
      "A falta de limite no cartão trava vendas, e o financiamento da Newave pode ajudar nesse cenário\n\nQuero agendar um bate-papo de 20 a 40 minutos no Google Meet pra mostrar como a Newave funciona e entender a operação da loja\n\nAmanhã tenho 9h, 10h e 11h, qual fica melhor pra você?",
      history,
      {},
      slotDurationMinutes
    )).toBeUndefined();
  });

  it("aceita o convite direto e humano seguido de uma oferta natural de horário", () => {
    expect(meetingInvitationContextCorrection(
      "A falta de limite no cartão pode travar vendas da loja\n\nVamos fazer um bate-papo de 20 a 40 minutos no Google Meet? Aí eu consigo te explicar melhor como a Newave funciona, entender um pouco da sua operação e você também consegue ver como isso pode funcionar nas vendas da sua loja.\n\nHoje tenho às 18h. Funciona pra você?",
      history,
      {},
      slotDurationMinutes
    )).toBeUndefined();
  });

  it("corrige a formulação robótica que explica o convite em vez de convidar", () => {
    const correction = meetingInvitationContextCorrection(
      "A falta de limite no cartão trava vendas, e o crédito da Newave pode ajudar\n\nO convite é para uma reunião de 20 a 40 minutos no Google Meet pra explicar como a Newave funciona e entender a operação da loja\n\nHoje tenho às 18h. Funciona pra você?",
      history,
      {},
      slotDurationMinutes
    );
    expect(correction).toContain("Vamos fazer um bate-papo");
    expect(correction).toContain("Evite frases explicativas e robóticas");
  });

  it("aceita horários depois de explicar a dor, a solução e o objetivo da reunião", () => {
    expect(meetingInvitationContextCorrection(
      "A falta de limite no cartão trava vendas que podem seguir por outra forma de crédito, e o financiamento da Newave pode ajudar nesse cenário\n\nÉ uma conversa de 20 a 40 minutos no Google Meet pra mostrar como funciona e entender a operação da loja\n\nAmanhã tenho 9h, 10h e 11h, qual fica melhor pra você?",
      history,
      {},
      slotDurationMinutes
    )).toBeUndefined();
  });

  it.each([
    ["reunião", "20 a 40"],
    ["papo", "20-40"],
    ["bate-papo", "20–40"],
    ["conversa", "20 a 40"],
    ["call", "20-40"],
    ["encontro", "20–40"]
  ])("aceita %s com a faixa comercial %s", (meetingWord, range) => {
    expect(meetingInvitationContextCorrection(
      `A falta de limite no cartão trava vendas, e o crédito da Newave pode ajudar nesse cenário\n\nÉ um ${meetingWord} de ${range} minutos no Google Meet pra te explicar como a Newave funciona e entender a operação da loja\n\nAmanhã tenho 9h, 10h e 11h, qual fica melhor pra você?`,
      history,
      {},
      slotDurationMinutes
    )).toBeUndefined();
  });

  it.each([15, 45, 60])("bloqueia o convite com duração fixa de %i minutos", (duration) => {
    expect(meetingInvitationContextCorrection(
      `A falta de limite no cartão trava vendas, e o crédito da Newave pode ajudar nesse cenário\n\nÉ um papo de ${duration} minutos no Google Meet pra te explicar como a Newave funciona e entender a operação da loja\n\nAmanhã tenho 9h, 10h e 11h, qual fica melhor pra você?`,
      history,
      {},
      slotDurationMinutes
    )).toMatch(/20 a 40 minutos no Google Meet/i);
  });

  it("bloqueia o convite que expõe a duração operacional mesmo com a faixa comercial correta", () => {
    expect(meetingInvitationContextCorrection(
      "A falta de limite no cartão trava vendas, e o crédito da Newave pode ajudar nesse cenário\n\nÉ um bate-papo de 20 a 40 minutos no Google Meet pra explicar como a Newave funciona e entender a operação da loja; a agenda reserva 60 minutos\n\nAmanhã tenho 9h, pode ser?",
      history,
      {},
      slotDurationMinutes
    )).toMatch(/Nunca informe 15 minutos, outra duração fixa, duração operacional/i);
  });

  it.each([
    "É um bate-papo de 20 a 40 minutos no Google Meet; mas serão 60 minutos reservados",
    "É um bate-papo de 20 a 40 minutos no Google Meet; 60 minutos ficam reservados na agenda",
    "Amanhã às 15h está disponível. Nosso slot reservado é de 60 minutos",
    "A conversa no Google Meet dura 15 minutos"
  ])("bloqueia duração interna ou comercial incorreta em qualquer texto final: %s", (text) => {
    expect(meetingDurationDisclosureCorrection(text)).toContain("20 a 40 minutos no Google Meet");
  });

  it("aceita convite natural sem linguagem operacional", () => {
    expect(meetingDurationDisclosureCorrection(
      "Podemos fazer um bate-papo de 20 a 40 minutos no Google Meet amanhã?"
    )).toBeUndefined();
    expect(meetingDurationDisclosureCorrection(
      "Ficou reservado nosso bate-papo de 20 a 40 minutos no Google Meet para amanhã"
    )).toBeUndefined();
  });

  it("também bloqueia a primeira oferta seca em conversas sem formulário", () => {
    expect(meetingInvitationContextCorrection(
      "Amanhã tenho 9h e 10h, qual fica melhor?",
      [{ role: "user", content: "Quero marcar uma conversa" }],
      {},
      slotDurationMinutes
    )).toMatch(/explicar como a Newave funciona/i);
  });

  it("responde diretamente quando o contato já pediu uma data e um horário", () => {
    expect(meetingInvitationContextCorrection(
      "Amanhã às 15h tá disponível, quer que eu deixe esse horário pra você?",
      [
        { role: "user", content: "oi" },
        { role: "user", content: "amanhã tem horário na agenda?" },
        { role: "user", content: "15h" },
        { role: "user", content: "ou n" }
      ],
      {},
      slotDurationMinutes
    )).toBeUndefined();
  });

  it("bloqueia o caso reportado em uma qualificação orgânica", () => {
    const organicHistory = [
      { role: "assistant" as const, content: "Pra eu te direcionar certo, me diz só em que ponto a venda costuma travar aí, no parcelamento, no limite do cliente ou em outra parte do fechamento?" },
      { role: "user" as const, content: "Muitas pessoas não tem limites suficientes no cartão e outras não tem cartão temos interesse em poder vender no crediario ou boletos" }
    ];

    expect(meetingInvitationContextCorrection(
      "Tenho só um horário disponível hoje, 18h30\n\nSe quiser, eu já deixo reservado pra você, pode ser?",
      organicHistory,
      {},
      slotDurationMinutes
    )).toMatch(/dois objetivos: explicar como a Newave funciona e entender a operação/i);
  });

  it("exige explicar a Newave e entender a operação, não apenas mencionar uma reunião", () => {
    expect(meetingInvitationContextCorrection(
      "A falta de limite no cartão trava vendas e o crédito da Newave pode ajudar\n\nÉ um bate-papo de 20 a 40 minutos no Google Meet para falar sobre isso\n\nHoje tenho 18h30, pode ser?",
      history,
      {},
      slotDurationMinutes
    )).toMatch(/explicar como a Newave funciona/i);
  });

  it("não manda repetir toda a contextualização quando o contato pede um horário mais tarde", () => {
    const continuedHistory = [
      ...history,
      { role: "assistant" as const, content: "A falta de limite no cartão trava vendas, e o financiamento da Newave pode ajudar nesse cenário" },
      { role: "assistant" as const, content: "É um bate-papo de 20 a 40 minutos no Google Meet pra mostrar como funciona e entender a operação da loja" },
      { role: "assistant" as const, content: "Hoje tenho 13h, 14h e 15h, qual fica melhor pra você?" },
      { role: "user" as const, content: "não tem mais tarde?" }
    ];

    expect(meetingInvitationContextCorrection(
      "Tenho também às 16h, esse horário fica melhor pra você?",
      continuedHistory,
      {},
      slotDurationMinutes
    )).toBeUndefined();
  });

  it("rejeita a duração operacional e aceita apenas a faixa comercial", () => {
    expect(meetingInvitationContextCorrection(
      "A falta de limite no cartão trava vendas, e o financiamento da Newave pode ajudar\n\nÉ uma reunião rápida de 60 minutos no Google Meet pra mostrar como funciona e entender a operação da loja\n\nAmanhã tenho 9h, pode ser?",
      history,
      {},
      30
    )).toMatch(/20 a 40 minutos/i);
    expect(meetingInvitationContextCorrection(
      "A falta de limite no cartão trava vendas, e o financiamento da Newave pode ajudar\n\nÉ um bate-papo de 20 a 40 minutos no Google Meet pra mostrar como funciona e entender a operação da loja\n\nAmanhã tenho 9h, pode ser?",
      history,
      {},
      30
    )).toBeUndefined();
    expect(prefilledLeadContextNote(history, {}, 30)).toContain("bate-papo de 20 a 40 minutos");
    expect(prefilledLeadContextNote(history, {}, 30)).not.toContain("bate-papo de 30 minutos");
  });

  it("normaliza apenas a duração comercial para a faixa e preserva follow-up, espera e SLA", () => {
    const prompt = "A reunião rápida de 15 minutos ocorre no Google Meet. Faça follow-up em 30 minutos, aguarde 5 minutos entre tentativas e aguarde 10 minutos antes da reunião. Respeite o SLA de 45 minutos.";
    const canonical = canonicalizeMeetingDurationPrompt(prompt, 60);
    expect(canonical).toContain("reunião de 20 a 40 minutos");
    expect(canonical).toContain("follow-up em 30 minutos");
    expect(canonical).toContain("aguarde 5 minutos");
    expect(canonical).toContain("aguarde 10 minutos antes da reunião");
    expect(canonical).toContain("SLA de 45 minutos");
    expect(canonical).not.toContain("reunião rápida de 60 minutos");
  });

  it.each(["20-40", "20 a 40", "20–40"])("canonicaliza a grafia comercial %s sem tocar em outros tempos", (range) => {
    const canonical = canonicalizeMeetingDurationPrompt(
      `Faça um bate-papo de ${range} minutos no Google Meet e envie follow-up em 30 minutos.`
    );
    expect(canonical).toContain("bate-papo de 20 a 40 minutos");
    expect(canonical).toContain("follow-up em 30 minutos");
  });

  it.each([
    "Faça follow-up depois de 15 minutos de conversa sem resposta.",
    "O SLA prevê uma conversa de 15 minutos com o suporte antes da escalação.",
    "Aguarde 15 minutos de papo antes da nova tentativa.",
    "Use um slot de 60 minutos para verificar conflitos."
  ])("preserva tempo operacional não relacionado ao convite: %s", (operationalText) => {
    expect(canonicalizeMeetingDurationPrompt(operationalText)).toBe(operationalText);
  });

  it("canonicaliza duração comercial verbal ligada ao Google Meet", () => {
    expect(canonicalizeMeetingDurationPrompt("A conversa no Google Meet dura 15 minutos."))
      .toBe("A conversa de 20 a 40 minutos no Google Meet.");
  });

  it("lista agendas divergentes sem inventar duração canônica antes da seleção", () => {
    const agendas = [
      { id: "curta", name: "Agenda curta", slotDurationMinutes: 30 },
      { id: "longa", name: "Agenda longa", slotDurationMinutes: 60 }
    ];
    const note = meetingDurationContextNote(agendas);
    expect(note).toContain("curta (Agenda curta): 30 minutos");
    expect(note).toContain("longa (Agenda longa): 60 minutos");
    expect(note).toContain("disponibilidade, reservar o intervalo correto e verificar conflitos");
    expect(note).toContain("bate-papo de 20 a 40 minutos no Google Meet");
    const unresolved = canonicalizeMeetingDurationPrompt(
      "Ofereça uma reunião de 15 minutos no Google Meet.",
      undefined
    );
    expect(unresolved).toContain("reunião de 20 a 40 minutos");
    expect(unresolved).not.toMatch(/reunião de 60 minutos/i);
  });
});

describe("saudação no primeiro retorno ao formulário", () => {
  const history = [{ role: "user" as const, content: `Olá! Preenchi seu formulário e gostaria de saber mais sobre sua empresa.
Há quanto tempo sua empresa está no mercado?: Mais de 5 anos
Qual é o faturamento médio mensal da empresa?: Mais de 50 mil
Qual é o nicho da sua empresa?: Venda de smartphone
Qual o principal motivo da perda de vendas na sua loja?: Perco clientes por falta de limite no cartão
Qual o Instagram da sua empresa?: Não temos
Full name: Renan de Carvalho` }];

  it("bloqueia a abertura seca reportada", () => {
    expect(initialPrefilledGreetingCorrection(
      "Renan, entendi, hoje o que está pegando é a perda de vendas por falta de limite no cartão\n\nA solução da Newave entra justamente pra te ajudar\n\nTenho às 13h, 14h e 15h, qual fica melhor pra você?",
      history
    )).toMatch(/comece a primeira bolha com uma saudação curta/i);
  });

  it.each([
    "Olá, Renan, tudo certo por aí?\n\nEntendi o cenário que você trouxe",
    "Opa Renan, tudo bem?\n\nEntendi o cenário que você trouxe",
    "Bom dia, Renan\n\nEntendi o cenário que você trouxe"
  ])("aceita uma primeira bolha que começa com saudação: %s", (text) => {
    expect(initialPrefilledGreetingCorrection(text, history)).toBeUndefined();
  });

  it("não exige nova saudação quando o atendimento já começou", () => {
    expect(initialPrefilledGreetingCorrection(
      "Entendi o cenário que você trouxe",
      [...history, { role: "assistant", content: "Olá, Renan, tudo certo?" }]
    )).toBeUndefined();
  });
});
