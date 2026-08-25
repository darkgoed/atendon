export type AgentCandidateSource = "manual" | "template";

export type AgentCandidateQueuedResponse = {
  status: "queued";
  candidateVersionId: string;
  proposalId: string;
  runId: string;
  version: {
    id: string;
    system_prompt?: string;
  };
};

export type AgentPublishedResponse = {
  status: "published";
  candidateVersionId: string;
  proposalId: string;
  runId: null;
  version: {
    id: string;
    system_prompt?: string;
  };
};

export type AgentSaveResponse = AgentCandidateQueuedResponse | AgentPublishedResponse;

export type PendingAgentReplay = {
  source: AgentCandidateSource;
  candidateVersionId: string;
  proposalId: string;
  runId: string;
};

export function pendingAgentReplay(
  response: AgentCandidateQueuedResponse,
  source: AgentCandidateSource
): PendingAgentReplay {
  return {
    source,
    candidateVersionId: response.candidateVersionId,
    proposalId: response.proposalId,
    runId: response.runId
  };
}

export function queuedCandidateMessage(source: AgentCandidateSource): string {
  return source === "template"
    ? "Template salvo como candidata. Replay pendente; o prompt ativo não mudou."
    : "Alterações salvas como candidata. Replay pendente; a configuração ativa não mudou.";
}

export function directPublicationMessage(source: AgentCandidateSource): string {
  return source === "template"
    ? "Template publicado diretamente; o avaliador está temporariamente desativado."
    : "Alterações publicadas diretamente; o avaliador está temporariamente desativado.";
}

export function preserveActiveFormAfterQueue<T extends { isActive: boolean }>(
  active: T,
  submitted: T
): T {
  return { ...active, isActive: submitted.isActive };
}
