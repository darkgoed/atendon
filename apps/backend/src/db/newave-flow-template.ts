/**
 * Questionário de qualificação do fluxo inicial do cliente New Wave.
 * Código de provisionamento do cliente — NÃO é parte do runtime genérico do
 * produto. Consumido por src/db/provision-newave.ts; o produto usa o fluxo
 * neutro de src/modules/qualification/flow.ts.
 */

export const NEWAVE_QUALIFICATION_FLOW = {
  start: "P1_TEMPO_DE_MERCADO",
  origem: "facebook",
  intro: "Oi! Que bom te ver por aqui 😊 Vou te fazer algumas perguntas rápidas pra entender o momento da sua loja, tudo bem?",
  triggers: { ctwa: false, session_ids: [], keywords: [] },
  steps: {
    P1_TEMPO_DE_MERCADO: {
      kind: "years",
      field: "tempo_mercado",
      question: "Pra começar: há quanto tempo a sua loja está no mercado?",
      options: [
        { value: "Menos de 1 ano", keywords: ["recem", "acabei de abrir", "abrindo agora", "comecando"] },
        { value: "De 1 a 3 anos" },
        { value: "De 3 a 5 anos" },
        { value: "Mais de 5 anos", keywords: ["muito tempo", "bastante tempo", "ha anos"] }
      ],
      next: "P2_FATURAMENTO"
    },
    P2_FATURAMENTO: {
      kind: "revenue",
      field: "faturamento",
      question: "E qual é o faturamento mensal médio da loja hoje?",
      options: [
        { value: "Até R$ 10 mil" },
        { value: "De R$ 10 mil a R$ 20 mil" },
        { value: "De R$ 20 mil a R$ 30 mil" },
        { value: "De R$ 30 mil a R$ 50 mil" },
        { value: "De R$ 50 mil a R$ 100 mil" },
        { value: "Acima de R$ 100 mil" }
      ],
      transitions: {
        "Até R$ 10 mil": "P5_INVESTIMENTO",
        "De R$ 10 mil a R$ 20 mil": "P5_INVESTIMENTO",
        "De R$ 20 mil a R$ 30 mil": "P5_INVESTIMENTO",
        "De R$ 30 mil a R$ 50 mil": "P3_NICHO",
        "De R$ 50 mil a R$ 100 mil": "P3_NICHO",
        "Acima de R$ 100 mil": "P3_NICHO"
      }
    },
    P3_NICHO: {
      kind: "options",
      field: "nicho",
      question: "Qual é o principal nicho da sua loja?",
      options: [
        { value: "Smartphones e eletrônicos", keywords: ["celular", "smartphone", "eletronic", "iphone", "samsung", "telefone", "notebook", "informatica", "\\btv\\b", "tablet"] },
        { value: "Scooters", keywords: ["scooter", "patinete", "bike eletrica", "bicicleta eletrica"] },
        { value: "Ótica", keywords: ["otica", "oculos", "lente"] },
        { value: "Outros", keywords: ["\\boutro"] }
      ],
      next: "P4_PERDA_DE_VENDAS"
    },
    P4_PERDA_DE_VENDAS: {
      kind: "options",
      field: "motivo_perda_vendas",
      question: "Hoje, qual é o principal motivo de perda de vendas na loja?",
      options: [
        { value: "Clientes não conseguem pagar à vista", keywords: ["a vista", "nao consegue(m)? pagar", "sem dinheiro", "nao tem (o )?dinheiro", "credito negado", "nome sujo", "na hora"] },
        { value: "Poucas opções de pagamento", keywords: ["opc(ao|oes) de pagamento", "forma(s)? de pagamento", "maquininha", "parcel", "so aceito"] },
        { value: "Empresa sem diferencial competitivo", keywords: ["diferencial", "concorrenc", "concorrente", "destaca"] },
        { value: "Margem de lucro muito baixa", keywords: ["margem", "lucro (muito )?baix", "ganho pouco", "sobra pouco"] }
      ],
      next: "P6A_INSTAGRAM"
    },
    P5_INVESTIMENTO: {
      kind: "boolean",
      field: "investimento",
      question: "Se fizesse sentido pra loja, você teria possibilidade de investir pra destravar esse crescimento?",
      options: [{ value: "SIM" }, { value: "NÃO" }],
      transitions: { "SIM": "P6B_INSTAGRAM", "NÃO": "E3_ENCERRAMENTO" }
    },
    P6A_INSTAGRAM: {
      kind: "text",
      field: "instagram",
      question: "Última pergunta: qual é o @ do Instagram da sua loja?",
      next: "E1_PAGINA_FINAL"
    },
    P6B_INSTAGRAM: {
      kind: "text",
      field: "instagram",
      question: "Última pergunta: qual é o @ do Instagram da sua loja?",
      next: "E2_PAGINA_FINAL"
    },
    E1_PAGINA_FINAL: {
      kind: "final",
      classificacao: "Perfil qualificado — alto faturamento",
      message: "Perfeito! Formulário concluído com sucesso. Pelo que você me contou, sua loja tem exatamente o perfil que a oferta configurada procura. Obrigado por compartilhar essas informações! 🚀"
    },
    E2_PAGINA_FINAL: {
      kind: "final",
      classificacao: "Perfil qualificado — potencial com investimento",
      message: "Obrigado pelas respostas! Formulário concluído com sucesso. Sua loja tem muito potencial de crescimento, e as informações já ficaram registradas por aqui. 💪"
    },
    E3_ENCERRAMENTO: {
      kind: "final",
      classificacao: "Sem perfil oferta configurada no momento",
      message: "Obrigado pelas respostas! No momento a gente não tem uma solução que encaixe no perfil da sua loja, mas vamos guardar seu contato pra futuras novidades. Sucesso por aí! 🙌"
    }
  }
};
