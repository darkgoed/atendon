export type OperationalStepStatus = "complete" | "pending" | "unknown";

export type OperationalChecklistAccess = {
  connection: boolean;
  connectionManage: boolean;
  agent: boolean;
  agentManage: boolean;
  catalog: boolean;
  catalogPage: boolean;
  catalogManage: boolean;
};

export type OperationalChecklistReality = {
  connections: {
    connected: number;
    total: number;
  };
  agentActive: boolean;
  catalog: {
    status: "loading" | "ready" | "error";
    categories: number;
    units: number;
  };
};

export type OperationalChecklistStep = {
  id: "connection" | "agent" | "catalog";
  title: string;
  description: string;
  href?: string;
  actionLabel?: string;
  status: OperationalStepStatus;
};

export function buildOperationalChecklist(
  access: OperationalChecklistAccess,
  reality: OperationalChecklistReality
): OperationalChecklistStep[] {
  const steps: OperationalChecklistStep[] = [];

  if (access.connection) {
    const complete = reality.connections.connected > 0;
    const connectionCount = `${reality.connections.connected} de ${reality.connections.total} ${reality.connections.total === 1 ? "conexão conectada" : "conexões conectadas"}`;
    steps.push({
      id: "connection",
      title: "Conectar o WhatsApp",
      description: complete
        ? `${connectionCount}. Pelo menos uma conexão está pronta para receber mensagens.`
        : `${connectionCount}. Conecte pelo menos um número antes de iniciar a operação.`,
      href: "/conexao",
      actionLabel: complete || !access.connectionManage ? "Abrir conexão" : "Conectar WhatsApp",
      status: complete ? "complete" : "pending"
    });
  }

  if (access.agent) {
    steps.push({
      id: "agent",
      title: "Ativar o agente principal",
      description: reality.agentActive
        ? "O agente está ativo para responder novas conversas."
        : "O agente está pausado ou ainda não foi configurado para responder.",
      href: "/agente",
      actionLabel: reality.agentActive || !access.agentManage ? "Abrir agente" : "Revisar agente",
      status: reality.agentActive ? "complete" : "pending"
    });
  }

  if (access.catalog) {
    const catalogReady = reality.catalog.status === "ready";
    const complete = catalogReady && reality.catalog.categories > 0 && reality.catalog.units > 0;
    const status: OperationalStepStatus = reality.catalog.status === "error"
      ? "unknown"
      : complete
        ? "complete"
        : "pending";
    const description = reality.catalog.status === "loading"
      ? "Verificando categorias e unidades disponíveis."
      : reality.catalog.status === "error"
        ? "Não foi possível verificar os cadastros agora. Abra o catálogo para consultar o estado atual."
        : complete
          ? `${reality.catalog.categories} categoria(s) e ${reality.catalog.units} unidade(s) disponíveis.`
          : "Cadastre ao menos uma categoria e uma unidade para qualificar e agendar atendimentos.";
    const catalogNavigation = access.catalogPage ? {
      href: "/configuracoes",
      actionLabel: complete || !access.catalogManage ? "Abrir catálogo" : "Cadastrar no catálogo"
    } : {};
    steps.push({
      id: "catalog",
      title: "Preparar categoria e unidade",
      description,
      ...catalogNavigation,
      status
    });
  }

  return steps;
}

export function summarizeOperationalChecklist(steps: readonly OperationalChecklistStep[]) {
  return steps.reduce(
    (summary, step) => {
      summary[step.status] += 1;
      summary.total += 1;
      return summary;
    },
    { complete: 0, pending: 0, unknown: 0, total: 0 }
  );
}

export function onboardingStorageKey(userId: string, workspaceId: string) {
  return `atendon:onboarding:${userId}:${workspaceId}:visibility`;
}

export function isOnboardingCollapsed(value: string | null) {
  return value === "collapsed";
}
