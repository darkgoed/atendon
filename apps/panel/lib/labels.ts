const leadStatuses: Record<string, string> = {
  novo: "Novo",
  em_atendimento: "Em atendimento",
  aguardando_resposta: "Aguardando resposta",
  qualificado: "Qualificado",
  em_negociacao: "Em negociação",
  proposta_enviada: "Proposta enviada",
  follow_up: "Follow-up",
  fechado: "Fechado",
  perdido: "Perdido",
  em_qualificacao: "Em qualificação",
  aguardando_proposta: "Aguardando proposta",
  aprovado: "Aprovado",
  recusado: "Recusado",
  agendado: "Agendado",
  cancelado: "Cancelado",
  transferido: "Transferido"
};

const handoffReasons: Record<string, string> = {
  manually_paused: "Pausa manual",
  contact_requested: "Cliente pediu atendimento",
  ai_decided: "Transferido pela IA",
  technical_failure: "Falha técnica da IA",
  commercial_handoff: "Em processo comercial",
  agent_requested: "Transferido pela IA",
  rate_limited: "Limite de mensagens atingido"
};

const accessStatuses: Record<string, string> = {
  active: "Ativo",
  inactive: "Inativo",
  trial: "Período de teste",
  suspended: "Suspenso",
  pending: "Pendente",
  accepted: "Aceito",
  revoked: "Revogado",
  expired: "Expirado"
};

const eventLabels: Record<string, string> = {
  lead_criado: "Lead criado",
  lead_atualizado: "Lead atualizado",
  status_atualizado: "Status atualizado",
  proposta_parceiro: "Proposta registrada",
  transferencia: "Transferência para atendimento humano",
  agendamento_criado: "Agendamento criado",
  agendamento_reagendado: "Agendamento reagendado",
  agendamento_cancelado: "Agendamento cancelado",
  responsavel_atribuido_automaticamente: "Responsável atribuído pelo rodízio",
  responsavel_reatribuido_retorno: "Responsável reatribuído no retorno",
  responsavel_transferido: "Responsável transferido",
  responsavel_redistribuido: "Responsável redistribuído",
  acompanhamento_atualizado: "Acompanhamento atualizado",
  nota_interna_adicionada: "Nota interna adicionada",
  formulario_iniciado: "Formulário de qualificação iniciado",
  formulario_resposta: "Resposta do formulário registrada",
  formulario_concluido: "Formulário de qualificação concluído",
  formulario_pausado: "Formulário pausado",
  formulario_retomado: "Formulário retomado",
  formulario_reiniciado: "Formulário reiniciado"
};

const qualificationStatuses: Record<string, string> = {
  em_andamento: "Em andamento",
  pausado: "Pausado",
  concluido: "Concluído"
};

const qualificationResults: Record<string, string> = {
  E1_PAGINA_FINAL: "E1 · Especialista (30 mil+)",
  E2_PAGINA_FINAL: "E2 · Equipe (com investimento)",
  E3_ENCERRAMENTO: "E3 · Encerramento"
};

const qualificationClasses: Record<string, string> = {
  alto_faturamento: "Alto faturamento",
  potencial_com_investimento: "Potencial com investimento",
  desqualificado: "Desqualificado"
};

const qualificationSteps: Record<string, string> = {
  P1_TEMPO_DE_MERCADO: "Tempo de mercado",
  P2_FATURAMENTO: "Faturamento",
  P3_NICHO: "Nicho",
  P4_PERDA_DE_VENDAS: "Perda de vendas",
  P5_INVESTIMENTO: "Investimento",
  P6A_INSTAGRAM: "Instagram",
  P6B_INSTAGRAM: "Instagram",
  E1_PAGINA_FINAL: "Página final E1",
  E2_PAGINA_FINAL: "Página final E2",
  E3_ENCERRAMENTO: "Encerramento E3"
};

const auditActions: Record<string, string> = {
  "agent.enabled": "Agente de IA ativado",
  "agent.disabled": "Agente de IA desativado",
  "agent.version.manual_published": "Versão manual do agente publicada",
  "agent.evaluator.updated": "Avaliador da IA atualizado",
  "agent.evaluation.confirmed": "Avaliação da IA confirmada",
  "agent.evaluation.rejected": "Avaliação da IA rejeitada",
  "agent.evaluation.manual_queued": "Avaliação manual enfileirada",
  "agent.regression_case.created": "Caso de regressão criado",
  "agent.regression_case.status_changed": "Status do caso de regressão alterado",
  "agent.regression_case.updated": "Caso de regressão atualizado",
  "agent.improvement.proposed": "Melhoria da IA proposta",
  "agent.improvement.rejected": "Melhoria da IA rejeitada",
  "agent.improvement.test_queued": "Replay da melhoria enfileirado",
  "agent.improvement.candidate_edited": "Candidata da melhoria editada",
  "agent.improvement.published": "Melhoria da IA publicada",
  "agent.improvement.rolled_back": "Versão do agente revertida",
  "conversation.ai_paused": "IA pausada na conversa",
  "conversation.claimed": "Conversa assumida por atendente",
  "conversation.resolved": "Conversa resolvida",
  "assignment.novo_contato": "Responsável atribuído a novo contato",
  "assignment.lead_criado": "Responsável atribuído a lead criado",
  "assignment.retorno_conversa_encerrada": "Responsável reatribuído no retorno",
  "assignment.reuniao_sem_responsavel": "Responsável atribuído antes da reunião",
  "assignment.transferencia_manual": "Atendimento transferido manualmente",
  "assignment.removido_do_pool": "Atendimento redistribuído após remoção do pool",
  "members.invite": "Convite de membro enviado",
  "members.invitation.revoke": "Convite de membro revogado",
  "members.remove": "Membro removido",
  "members.profile.update": "Perfil de membro atualizado",
  "members.update": "Membro atualizado",
  "scheduling.attendants.pool.update": "Equipe de atendimento atualizada",
  "scheduling.attendant.availability.update": "Disponibilidade do atendente atualizada",
  "scheduling.appointment.assignment.update": "Responsável da reunião atualizado",
  "roles.create": "Função criada",
  "roles.delete": "Função excluída",
  "roles.update": "Função atualizada",
  "root.workspace.access": "Acesso assistido ao workspace",
  "root.workspaces.update": "Workspace atualizado por ROOT",
  "workspace.update": "Workspace atualizado"
};

const auditResources: Record<string, string> = {
  agent: "Agente de IA",
  agent_config_version: "Versão do agente",
  tenant_ai_settings: "Configuração do avaliador",
  ai_attendance_evaluation: "Avaliação da IA",
  ai_regression_case: "Caso de regressão",
  ai_improvement_proposal: "Proposta de melhoria",
  conversation: "Conversa",
  workspace: "Workspace",
  workspace_invitation: "Convite do workspace",
  workspace_member: "Membro do workspace",
  workspace_role: "Função do workspace",
  scheduling_attendant_pool: "Equipe de atendimento",
  scheduling_attendant: "Atendente",
  scheduling_lead: "Lead",
  scheduling_appointment: "Agendamento"
};

const detailFields: Record<string, string> = {
  ai_model: "Modelo de IA",
  actor_scope: "Escopo do ator",
  categoria_id: "Categoria",
  categoria_interesse_id: "Categoria de interesse",
  clearOpenRouterApiKey: "Remover chave da OpenRouter",
  created_at: "Criado em",
  dias_funcionamento: "Dias de funcionamento",
  email: "E-mail",
  evaluatorModel: "Modelo avaliador",
  automaticEnabled: "Avaliações automáticas",
  previousVersionId: "Versão anterior",
  sourceVersionId: "Versão de origem",
  candidateVersionId: "Versão candidata",
  baselineVersionId: "Versão baseline",
  versionNumber: "Número da versão",
  issueCodes: "Códigos de problema",
  event_type: "Tipo de evento",
  horario_abertura: "Horário de abertura",
  horario_fechamento: "Horário de fechamento",
  isActive: "Ativo",
  link_proposta: "Link da proposta",
  motivo: "Motivo",
  name: "Nome",
  new_status: "Novo status",
  responsavel_anterior_member_id: "Responsável anterior",
  responsavel_novo_member_id: "Novo responsável",
  responsavel_novo_user_id: "Usuário do novo responsável",
  openRouterApiKey: "Chave da OpenRouter",
  parceiro_id: "Parceiro",
  permissions: "Permissões",
  previous_status: "Status anterior",
  roleId: "Função",
  status: "Status",
  unidade_id: "Unidade",
  updated_at: "Atualizado em",
  workspaceId: "Workspace"
};

const protectedFieldPattern = /(api.?key|authorization|cookie|password|secret|token)/i;

function readableFallback(value: string): string {
  const normalized = value
    .trim()
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .toLocaleLowerCase("pt-BR");
  return normalized ? normalized[0].toLocaleUpperCase("pt-BR") + normalized.slice(1) : "Não informado";
}

const qualificationAnswerLabels: Record<string, string> = {
  tempo_mercado: "Tempo de mercado",
  faturamento: "Faturamento",
  nicho: "Nicho",
  ticket_medio: "Ticket médio",
  causa_perda_vendas: "Causa da perda de vendas",
  possibilidade_investimento: "Possibilidade de investimento",
  cidade: "Cidade",
  decisor_comercial: "Decisor comercial",
  instagram: "Instagram",
  participacao_decisor: "Participação do decisor",
  momento_compra: "Momento de compra"
};

// O jsonb do banco não preserva ordem útil para leitura. Fixamos a ordem em que
// o comercial lê o card: contexto do negócio primeiro, decisão e momento por
// último, que é o que prepara a call.
const qualificationAnswerOrder = Object.keys(qualificationAnswerLabels);

/**
 * Campos que preparam o closer para a call, pedidos explicitamente pelo
 * comercial. Uma decisão anterior removeu do detalhe do lead o dump completo
 * das respostas estruturadas por ser ruído; estes dois continuam visíveis
 * porque respondem "quem decide" e "qual o momento", que mudam a abordagem da
 * reunião.
 */
const commercialPreparationKeys = ["participacao_decisor", "momento_compra"] as const;

export function qualificationAnswerLabel(key: string): string {
  return qualificationAnswerLabels[key] ?? readableFallback(key);
}

export function readableQualificationAnswers(answers?: Record<string, string> | null): Array<{ key: string; label: string; value: string }> {
  if (!answers) return [];
  return Object.entries(answers)
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .sort(([a], [b]) => {
      // Chave desconhecida vai para o fim, preservando ordem alfabética entre elas.
      const rankA = qualificationAnswerOrder.indexOf(a);
      const rankB = qualificationAnswerOrder.indexOf(b);
      if (rankA === -1 && rankB === -1) return a.localeCompare(b, "pt-BR");
      if (rankA === -1) return 1;
      if (rankB === -1) return -1;
      return rankA - rankB;
    })
    .map(([key, value]) => ({ key, label: qualificationAnswerLabel(key), value: value.trim() }));
}

/** Somente decisor e momento de compra, na ordem em que o closer lê antes da call. */
export function commercialPreparationAnswers(answers?: Record<string, string> | null): Array<{ key: string; label: string; value: string }> {
  const selected = commercialPreparationKeys as readonly string[];
  return readableQualificationAnswers(answers).filter((answer) => selected.includes(answer.key));
}
export function leadStatusLabel(value: string): string {
  return leadStatuses[value] ?? readableFallback(value);
}

export function handoffReasonLabel(value?: string | null): string {
  if (!value) return "Transferido para atendimento humano";
  return handoffReasons[value] ?? "Transferido para atendimento humano";
}

export function accessStatusLabel(value: string): string {
  return accessStatuses[value] ?? readableFallback(value);
}

export function leadEventLabel(value: string): string {
  return eventLabels[value] ?? readableFallback(value);
}

export function qualificationStatusLabel(value: string): string {
  return qualificationStatuses[value] ?? readableFallback(value);
}

export function qualificationResultLabel(value: string): string {
  return qualificationResults[value] ?? readableFallback(value);
}

export function qualificationClassLabel(value: string): string {
  return qualificationClasses[value] ?? readableFallback(value);
}

export function qualificationStepLabel(value: string): string {
  return qualificationSteps[value] ?? readableFallback(value);
}

export function auditActionLabel(value: string): string {
  return auditActions[value] ?? readableFallback(value);
}

export function auditResourceLabel(value: string): string {
  return auditResources[value] ?? readableFallback(value);
}

export function actorScopeLabel(value: string): string {
  if (value === "root") return "ROOT";
  if (value === "workspace") return "Workspace";
  return readableFallback(value);
}

export function detailFieldLabel(value: string): string {
  return detailFields[value] ?? readableFallback(value);
}

function displayScalar(value: unknown, depth: number): string {
  if (value === null || value === undefined || value === "") return "Não informado";
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string") {
    if (leadStatuses[value]) return leadStatuses[value];
    if (accessStatuses[value]) return accessStatuses[value];
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "Nenhum";
    const visible = value.slice(0, 8).map((item) => displayScalar(item, depth + 1));
    return `${visible.join(", ")}${value.length > visible.length ? ` e mais ${value.length - visible.length}` : ""}`;
  }
  if (typeof value === "object") {
    if (depth >= 2) return "Dados adicionais";
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 8);
    if (entries.length === 0) return "Sem detalhes";
    return entries.map(([key, item]) => `${detailFieldLabel(key)}: ${isProtectedField(key) ? "Conteúdo protegido" : displayScalar(item, depth + 1)}`).join(" · ");
  }
  return "Valor indisponível";
}

function isProtectedField(key: string): boolean {
  return protectedFieldPattern.test(key);
}

export type ReadableDetail = { key: string; label: string; value: string };

export function readableDetails(details?: Record<string, unknown> | null): ReadableDetail[] {
  if (!details) return [];
  return Object.entries(details).map(([key, value]) => ({
    key,
    label: detailFieldLabel(key),
    value: isProtectedField(key) ? "Conteúdo protegido" : displayScalar(value, 0)
  }));
}
