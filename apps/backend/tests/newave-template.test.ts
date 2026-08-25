import { describe, expect, it } from "vitest";
import { loadNewavePromptTemplate } from "../src/db/newave-template.js";

describe("Newave prompt template", () => {
  it("recovers a listening objection in WhatsApp before offering a meeting", async () => {
    const prompt = await loadNewavePromptTemplate();

    expect(prompt).toContain("Quando o contato sentir que não foi ouvido");
    expect(prompt).toContain("se não houver pergunta direta de identidade, não revele espontaneamente");
    expect(prompt).toContain("não faça pergunta de qualificação");
    expect(prompt).toContain("recupere em uma frase os fatos já informados");
    expect(prompt).toContain("cliente precisa esperar até o fim do mês");
  });

  it("is transparent only after a direct identity question", async () => {
    const prompt = await loadNewavePromptTemplate();

    expect(prompt).toContain("Não diga espontaneamente que é IA, robô, chatbot, automação");
    expect(prompt).toContain("Se o contato perguntar diretamente se você é robô, bot, IA ou automação");
    expect(prompt).toContain("você é o assistente digital da Newave Pay");
    expect(prompt).toContain("ofereça atendimento humano caso a pessoa prefira");
    expect(prompt).toContain("Uma reclamação como “parece um robô”");
    expect(prompt).not.toContain("Nunca diga que é IA, robô, chatbot, automação");
  });

  it("keeps follow-ups, reminders and no-shows conditional on CRM runtime state", async () => {
    const prompt = await loadNewavePromptTemplate();

    expect(prompt).toContain("Só siga esta seção quando o CRM ou o runtime acionar explicitamente");
    expect(prompt).toContain("O CRM e o runtime são a autoridade sobre disparo, quantidade de tentativas, horário");
    expect(prompt).toContain("Nunca infira sozinho que chegou a hora de enviar follow-up ou lembrete");
    expect(prompt).toContain("Só trate ausência quando o CRM confirmar que o contato não compareceu");
  });

  it("defines Arthur's v2 SDR mission, tone and decision priorities", async () => {
    const prompt = await loadNewavePromptTemplate();

    expect(prompt).toContain("# Arthur, SDR da Newave Pay no WhatsApp");
    expect(prompt).toContain("assistente comercial e SDR da Newave Pay");
    expect(prompt).toContain("linguagem natural, próxima, atenta, profissional, direta e específica ao contexto");
    expect(prompt).toContain("### Prioridades de decisão");
    expect(prompt).toContain("avance somente um próximo passo comercial");
  });

  it("only presents meeting context proactively and treats a short answer as scheduling confirmation", async () => {
    const prompt = await loadNewavePromptTemplate();

    expect(prompt).toContain(
      "Só mencione uma dor quando ela estiver explícita na conversa, nunca invente nem presuma uma dor para introduzir a reunião"
    );
    expect(prompt).toContain("Faça a primeira oferta proativa de reunião somente quando");
    expect(prompt).toContain("Se o contato perguntar diretamente por uma data ou horário");
    expect(prompt).toContain("sem reapresentar Google Meet, duração ou objetivo da reunião");
    expect(prompt).toContain("respostas como “sim”, “pode ser”, “fechado”, “confirmo”, “marca” ou “ss” autorizam o agendamento das 17h");
    expect(prompt).toContain("Correções internas são silenciosas");
    expect(prompt).toContain("Etapas, fluxo, processo e próximo passo são conceitos exclusivamente internos");
    expect(prompt).toContain("Nunca anuncie ao contato “o próximo passo é”");
    expect(prompt).toContain("Entregue somente a mensagem final ao contato");
    expect(prompt).toContain("que a equipe mostra como a Newave funciona na prática e entende a operação da empresa");
    expect(prompt).toContain("Vamos fazer um bate-papo de 20 a 40 minutos no Google Meet?");
    expect(prompt).toContain("Hoje tenho às 18h. Funciona pra você?");
    expect(prompt).toContain("Evite frases explicativas ou robóticas como “O convite é para uma reunião”");
    expect(prompt).not.toContain("Essa falta de limite acaba travando vendas");
  });

  it("answers ticket-range questions directly and stays transparent about unknown rates", async () => {
    const prompt = await loadNewavePromptTemplate();

    expect(prompt).toContain(
      "Se o contato perguntar se um valor, faixa de ticket ou volume específico pode ser atendido, a primeira frase confirma objetivamente esse valor antes de qualquer outra explicação"
    );
    expect(prompt).toContain("“Sim, valores entre R$ 7.900 e R$ 9.900 podem entrar na análise, a aprovação depende do perfil de cada cliente”");
    expect(prompt).toContain("Nunca abra a resposta com frases vagas como “pode ser avaliado para a operação”");
    expect(prompt).toContain("Se não souber a taxa exata, diga isso com transparência e avance para uma pergunta de qualificação");
  });

  // Ticket deixou de ser qualificação obrigatória: o excesso de perguntas era a
  // reclamação real do atendimento, então ele agora é desejável e nunca adia o convite.
  it("does not push for an immediate call and keeps ticket as an optional qualification", async () => {
    const prompt = await loadNewavePromptTemplate();

    expect(prompt).toContain("Quando o contato não pode falar naquele momento");
    expect(prompt).toContain("não insista em contato imediato e não repita a oferta de reunião");
    expect(prompt).toContain("“Sem problema, continuamos por aqui e já deixamos um bate-papo de 20 a 40 minutos no Google Meet marcado pra outro horário, qual período costuma ser melhor pra você?”");
    expect(prompt).toContain("As demais são desejáveis, nunca obrigatórias");
    expect(prompt).toContain("Faça no máximo quatro perguntas de qualificação na conversa inteira");
    expect(prompt).toContain("quantas vendas perde por mês por falta de limite ou de crédito no cliente");
    expect(prompt).toContain("“Pelo valor das motos e pelo problema de limite no cartão, faz sentido avaliarmos sua loja");
  });

  it("keeps the commercial range separate from operational agenda duration", async () => {
    const prompt = await loadNewavePromptTemplate();

    expect(prompt).toContain("bate-papo de 20 a 40 minutos no Google Meet");
    expect(prompt).toContain("O `slot_duration_min` serve apenas para controle interno de término, conflitos e capacidade da agenda");
    expect(prompt).not.toContain("15 minutinhos no Google Meet");
    expect(prompt).not.toContain("sempre use 15 minutinhos");
  });

  it("requires every turn to fulfil at least one commercial function", async () => {
    const prompt = await loadNewavePromptTemplate();

    expect(prompt).toContain("Todo turno precisa cumprir pelo menos uma destas funções");
    expect(prompt).toContain("responder uma dúvida nova");
    expect(prompt).toContain("reduzir uma objeção");
    expect(prompt).toContain("avançar para a reunião");
    expect(prompt).toContain("encaminhar para credenciamento");
  });

  it("keeps greetings human without restarting the script or repeating the name question", async () => {
    const prompt = await loadNewavePromptTemplate();

    expect(prompt).toContain("Quando o contato responde com outra saudação");
    expect(prompt).toContain("a conversa não recomeçou");
    expect(prompt).toContain("sem repetir nem reformular a pergunta anterior nesse turno");
    expect(prompt).toContain("“Bom dia! Sou o Arthur, assistente da Newave Pay");
    expect(prompt).toContain("“Bom dia! Que bom falar com você por aqui”");
    expect(prompt).toContain("Pergunte o nome de forma simples e humana, preferindo “como posso te chamar?”");
    expect(prompt).toContain("“pra eu direcionar melhor o atendimento”");
  });

  it("continues difficult conversations and leaves explicit human requests to the platform", async () => {
    const prompt = await loadNewavePromptTemplate();

    expect(prompt).toContain("O sistema identifica e processa antes da sua resposta os pedidos explícitos");
    expect(prompt).toContain("Não decida transferência por conta própria");
    expect(prompt).toContain("Irritação, frustração, reclamação, dúvida, objeção, resposta incompleta");
    expect(prompt).toContain("não use falha de ferramenta como motivo para transferir");
    expect(prompt).toContain("nunca use handoff para escapar de dúvida");
    expect(prompt).not.toContain("ficar irritada, apresentar situação sensível");
  });

  it("offers the chronologically nearest slots regardless of clock hour while honoring the lead's exact request", async () => {
    const prompt = await loadNewavePromptTemplate();

    expect(prompt).toContain("priorize todos os horários disponíveis de hoje que ainda não passaram");
    expect(prompt).toContain("o quanto antes é sempre melhor");
    expect(prompt).toContain("Não aplique uma faixa preferencial fixa, como 12h a 18h");
    expect(prompt).toContain("Se houver vagas às 10h e 11h hoje, ofereça essas vagas antes");
    expect(prompt).toContain("17h de hoje acontece antes de 10h de amanhã");
    expect(prompt).toContain("essa escolha vira a prioridade absoluta");
    expect(prompt).toContain("Consulte primeiro exatamente a data e o horário pedidos");
    expect(prompt).toContain("ofereci uma data futura mesmo existindo qualquer horário futuro disponível hoje?");
    expect(prompt).not.toContain("priorize os horários disponíveis de hoje entre 12h e 18h");
  });
});
