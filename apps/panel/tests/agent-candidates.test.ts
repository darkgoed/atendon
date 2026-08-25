import { describe, expect, it } from "vitest";
import {
  directPublicationMessage,
  pendingAgentReplay,
  preserveActiveFormAfterQueue,
  queuedCandidateMessage,
  type AgentCandidateQueuedResponse
} from "../lib/agent-candidates";

const queuedResponse: AgentCandidateQueuedResponse = {
  status: "queued",
  candidateVersionId: "candidate-version-id",
  proposalId: "proposal-id",
  runId: "run-id",
  version: { id: "candidate-version-id" }
};

describe("agent candidate UI contract", () => {
  it("keeps the candidate, proposal and replay identities returned by the API", () => {
    expect(pendingAgentReplay(queuedResponse, "manual")).toEqual({
      source: "manual",
      candidateVersionId: "candidate-version-id",
      proposalId: "proposal-id",
      runId: "run-id"
    });
  });

  it("states explicitly that manual and template edits remain outside production", () => {
    expect(queuedCandidateMessage("manual")).toBe(
      "Alterações salvas como candidata. Replay pendente; a configuração ativa não mudou."
    );
    expect(queuedCandidateMessage("template")).toBe(
      "Template salvo como candidata. Replay pendente; o prompt ativo não mudou."
    );
  });

  it("states explicitly when the evaluator bypass publishes directly", () => {
    expect(directPublicationMessage("manual")).toContain("publicadas diretamente");
    expect(directPublicationMessage("template")).toContain("publicado diretamente");
  });

  it("restores active configuration fields after queueing while preserving operational status", () => {
    const active = { systemPrompt: "Ativo", aiModel: "model/active", isActive: true };
    const submitted = { systemPrompt: "Candidata", aiModel: "model/candidate", isActive: false };

    expect(preserveActiveFormAfterQueue(active, submitted)).toEqual({
      systemPrompt: "Ativo",
      aiModel: "model/active",
      isActive: false
    });
  });
});
