export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/** Declared per tool, not inferred from its name. Kept out of ToolDefinition so it never rides along in the wire payload sent to the provider. */
export interface ToolSafetyMetadata {
  readOnly: boolean;
  idempotent: boolean;
  parallelSafe: boolean;
}

// Unmarked tools default to the safe assumption: mutating and sequential-only.
const MUTATING: ToolSafetyMetadata = { readOnly: false, idempotent: false, parallelSafe: false };
const READ_ONLY: ToolSafetyMetadata = { readOnly: true, idempotent: true, parallelSafe: true };

const TOOL_SAFETY = new Map<string, ToolSafetyMetadata>();

export function toolSafetyMetadata(name: string): ToolSafetyMetadata {
  return TOOL_SAFETY.get(name) ?? MUTATING;
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
  safety: ToolSafetyMetadata = MUTATING
): ToolDefinition {
  TOOL_SAFETY.set(name, safety);
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

const META_CELL_TOOL_DEFINITIONS: ToolDefinition[] = [
  tool("consultar_categorias", "Lista as categorias de interesse ativas cadastradas para este tenant, com id e nome.", {}, [], READ_ONLY),
  tool("consultar_parceiros", "Lista os parceiros de financiamento/proposta ativos, em ordem de prioridade (tentar o primeiro antes de cair para o próximo).", {}, [], READ_ONLY),
  tool("consultar_unidades", "Lista as unidades ativas, com id, nome e horário de funcionamento.", {}, [], READ_ONLY),
  tool(
    "registrar_lead",
    "Cria ou atualiza o cadastro do lead atual. O telefone é resolvido automaticamente; nunca o pergunte. Envie categoria_interesse_id, unidade_id ou parceiro_id somente se o mesmo ID tiver sido retornado antes por uma ferramenta de consulta; caso contrário, omita esses campos.",
    {
      nome: { type: "string", description: "Nome do contato, se informado." },
      categoria_interesse_id: { type: "string", description: "Id de uma categoria retornada por consultar_categorias." },
      unidade_id: { type: "string", description: "Id de uma unidade retornada por consultar_unidades." },
      parceiro_id: { type: "string", description: "Id de um parceiro retornado por consultar_parceiros." },
      origem: { type: "string", description: "Origem do lead, ex: whatsapp." },
      status: { type: "string", enum: ["novo", "em_atendimento", "aguardando_resposta", "qualificado"] }
    }
  ),
  tool(
    "verificar_horarios",
    "Consulta os horários (slots) disponíveis de uma unidade em uma data específica.",
    {
      unidade_id: { type: "string", description: "Id de uma unidade retornada por consultar_unidades." },
      data: { type: "string", description: "Data no formato YYYY-MM-DD." }
    },
    ["unidade_id", "data"],
    READ_ONLY
  ),
  tool(
    "agendar_visita",
    "Confirma o agendamento de uma visita/retirada para o lead atual em um horário disponível.",
    {
      unidade_id: { type: "string", description: "Id de uma unidade retornada por consultar_unidades." },
      start: { type: "string", description: "Início do horário escolhido, em ISO 8601 (ex: 2026-07-08T15:00:00.000Z), como retornado por verificar_horarios." }
    },
    ["unidade_id", "start"]
  ),
  tool(
    "reagendar_visita",
    "Move o agendamento ativo mais recente do lead atual para um novo horário.",
    {
      unidade_id: { type: "string", description: "Nova unidade, se estiver mudando; omitir para manter a mesma." },
      start: { type: "string", description: "Novo horário em ISO 8601." }
    },
    ["start"]
  ),
  tool("cancelar_visita", "Cancela o agendamento ativo mais recente do lead atual."),
  tool(
    "enviar_proposta_parceiro",
    "Associa um parceiro ao lead atual e retorna o link de proposta dele para envio ao contato.",
    { parceiro_id: { type: "string", description: "Id de um parceiro retornado por consultar_parceiros." } },
    ["parceiro_id"]
  ),
  tool(
    "atualizar_status_lead",
    "Atualiza o status do lead atual no funil.",
    { status: { type: "string", enum: ["novo", "em_atendimento", "aguardando_resposta", "qualificado"] } },
    ["status"]
  ),
  tool(
    "pesquisar_modelo",
    "Pesquisa na web se um modelo específico de produto (celular, TV, tablet etc.) existe. Use SEMPRE que o contato citar qualquer modelo específico, mesmo que você ache que reconhece, incluindo correções ou mensagens curtas como '18 Pro Max', '17 Pro Max', 'iPhone 17 Pro Max' ou 'Galaxy S26'. Use antes de elogiar, confirmar, comparar ou conduzir o fluxo sobre esse modelo. Nunca diga que um modelo existe ou não existe sem usar esta ferramenta. O resultado é informação interna sua: NUNCA repita ao contato que o modelo existe, nem fabricante, especificações ou dados de lançamento. Se o resultado for 'não encontrado', não elogie nem valide o modelo; diga apenas que esse você não conhece e que o time da loja confirma no estoque. Ela não consulta o estoque da loja — disponibilidade e preço continuam com o time da loja.",
    { modelo: { type: "string", description: "Nome do modelo citado pelo contato, ex: Samsung Galaxy S26 Pro." } },
    ["modelo"],
    // Read-only web lookup; result can vary between identical calls, so not idempotent.
    { readOnly: true, idempotent: false, parallelSafe: true }
  )
];

const NEWAVE_TOOL_DEFINITIONS: ToolDefinition[] = [
  tool(
    "pesquisar_contexto",
    "Pesquisa silenciosamente na web um nome de empresa, marca, produto ou termo comercial específico que pareça incerto, especialmente após áudio ou quando a grafia puder estar errada. Use somente quando a pesquisa ajudar a interpretar o que o contato disse. Não use para perguntas comuns nem revele resultados como se fossem dados fornecidos pelo contato.",
    { termo: { type: "string", description: "Termo específico e curto a verificar, com o pouco contexto disponível." } },
    ["termo"],
    { readOnly: true, idempotent: false, parallelSafe: true }
  ),
  tool(
    "qualificar_lead",
    "Registra a avaliação contextual final do lead. Use uma única vez quando houver contexto suficiente. A nota e a justificativa são internas e nunca devem ser reveladas ao contato.",
    {
      estrelas: { type: "integer", minimum: 1, maximum: 5, description: "Avaliação holística interna de 1 a 5 estrelas." },
      respostas: {
        type: "object",
        description: "Respostas estruturadas extraídas da conversa, sem inventar o que o contato não informou.",
        properties: {
          tempo_mercado: { type: "string" },
          faturamento: { type: "string" },
          nicho: { type: "string" },
          ticket_medio: { type: "string", description: "Valor ou faixa de valor do produto/serviço vendido, se informado." },
          causa_perda_vendas: { type: "string" },
          possibilidade_investimento: { type: "string" },
          cidade: { type: "string" },
          decisor_comercial: { type: "string" },
          instagram: { type: "string" },
          participacao_decisor: { type: "string", description: "Registrar no formato: Decisor: sozinho|sócio|outro; Todos participarão: sim|não confirmado." },
          momento_compra: { type: "string", description: "Classificação INTERNA do momento de compra: quente (quer implementar agora/curto prazo), morno (está avaliando) ou frio (curiosidade/sem previsão). Nunca revelar ao contato." }
        },
        additionalProperties: false
      },
      resumo: { type: "string", description: "Resumo factual e curto do perfil e do momento comercial." },
      justificativa: { type: "string", description: "Justificativa interna da avaliação, baseada no conjunto da conversa." }
    },
    ["estrelas", "respostas", "resumo", "justificativa"]
  ),
  tool("consultar_agendas", "Lista as agendas comerciais disponíveis para reuniões, com id, nome, funcionamento e duracao_slot_min canônica.", {}, [], READ_ONLY),
  tool(
    "verificar_horarios_reuniao",
    "Consulta horários disponíveis de uma agenda comercial. Uma única chamada basta: o sistema já respeita fuso, horário de funcionamento, conflitos e horários passados, e avança sozinho para os próximos dias quando a data pedida não tem vaga. Envie periodo somente quando o contato tiver pedido explicitamente manhã ou tarde; nunca escolha um período por iniciativa própria nem com base na hora atual. O resultado traz data (a data realmente disponível, que pode ser posterior a data), periodo_atendido e horarios com hora local pronta para uso. Em cada horário, vagas é a quantidade de closers ainda livres naquele mesmo horário: 2 closers permitem 2 reuniões simultâneas, 3 closers permitem 3, e o horário só fica indisponível quando vagas chega a zero. Nunca converta fuso, nunca calcule outra data e nunca ofereça horário que não esteja em horarios. Se o contato pedir um horário exato, envie horario_solicitado no formato HH:mm.",
    {
      agenda_id: { type: "string", description: "Id retornado por consultar_agendas." },
      data: { type: "string", description: "Data inicial da busca no formato YYYY-MM-DD." },
      periodo: { type: "string", enum: ["manha", "tarde"], description: "Período pedido pelo contato. Omitir quando ele não indicou preferência." },
      horario_solicitado: { type: "string", description: "Horário exato pedido pelo contato no formato HH:mm. Omitir quando estiver apenas buscando sugestões da grade." }
    },
    ["agenda_id", "data"],
    READ_ONLY
  ),
  tool(
    "agendar_reuniao",
    "Agenda uma reunião para o lead atual após registrar a qualificação. Toda nota de 1 a 5 estrelas pode avançar. A duração retornada é apenas operacional e nunca deve ser informada ao contato. Quando o resultado trouxer meet_link, confirme de forma curta e natural o dia e o horário e envie exatamente esse link.",
    {
      agenda_id: { type: "string", description: "Id retornado por consultar_agendas." },
      start: { type: "string", description: "Início ISO 8601 retornado por verificar_horarios_reuniao." }
    },
    ["agenda_id", "start"]
  ),
  tool(
    "reagendar_reuniao",
    "Move a reunião ativa mais recente do lead atual para outro horário.",
    {
      agenda_id: { type: "string", description: "Nova agenda; omitir para manter a atual." },
      start: { type: "string", description: "Novo início em ISO 8601." }
    },
    ["start"]
  ),
  tool("cancelar_reuniao", "Cancela a reunião ativa mais recente do lead atual.")
];

export const DEFAULT_ENABLED_TOOL_NAMES = META_CELL_TOOL_DEFINITIONS.map((definition) => definition.function.name);
export const NEWAVE_ENABLED_TOOL_NAMES = [
  "pesquisar_contexto",
  "registrar_lead",
  "qualificar_lead",
  "consultar_agendas",
  "verificar_horarios_reuniao",
  "agendar_reuniao",
  "reagendar_reuniao",
  "cancelar_reuniao"
] as const;

export const SCHEDULING_TOOL_DEFINITIONS: ToolDefinition[] = [
  ...META_CELL_TOOL_DEFINITIONS,
  ...NEWAVE_TOOL_DEFINITIONS
];

export const AVAILABLE_TOOL_NAMES = SCHEDULING_TOOL_DEFINITIONS.map((definition) => definition.function.name);

export function enabledToolDefinitions(names: readonly string[]): ToolDefinition[] {
  const enabled = new Set(names);
  return SCHEDULING_TOOL_DEFINITIONS.filter((definition) => enabled.has(definition.function.name));
}
