import { claimsUnprovenTransactionalSuccess } from "../messages/transactional-outcome.js";

export type QualityScores = Record<string, number>;

export interface ReplayCaseOutcome {
  caseId: string;
  severity: "critical" | "high" | "medium" | "low";
  relatedToTarget: boolean;
  baselineScores: QualityScores;
  candidateScores: QualityScores;
  baselineOverall: number;
  candidateOverall: number;
  candidateHasCriticalFailure: boolean;
  unexpectedToolCalls: number;
  missingTransactionalEvidence: boolean;
  deterministicFailures?: number;
  passed: boolean;
}

export interface ReplayGateResult {
  status: "ready" | "test_failed";
  reasons: string[];
  metrics: {
    targetDimensionDelta: number;
    overallDelta: number;
    worstDimensionDelta: number;
    costIncreasePercent: number;
    unexpectedToolCalls: number;
    missingTransactionalEvidence: number;
    deterministicFailures: number;
  };
}

function average(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

// ponytail: o juiz LLM só pontua continuity/communication (correctness, task_completion,
// security_privacy, tool_usage e handoff vêm fixos em 100 por instrução de prompt e são
// cobertos pelos gates determinísticos abaixo). Exigir delta de score nessas dimensões
// travaria o gate permanentemente em test_failed.
const JUDGE_SCORED_DIMENSIONS = ["continuity", "communication"];

export function evaluateReplayGates(input: {
  cases: ReplayCaseOutcome[];
  targetDimensions: string[];
  baselineCostPerResponse: number;
  candidateCostPerResponse: number;
  acceptedCostJustification?: boolean;
}): ReplayGateResult {
  const reasons: string[] = [];
  const blockingCases = input.cases.filter((item) => ["critical", "high"].includes(item.severity));
  if (blockingCases.some((item) => !item.passed)) reasons.push("Nem todos os casos críticos e altos passaram.");
  if (input.cases.some((item) => item.candidateHasCriticalFailure)) reasons.push("A candidata introduziu falha crítica.");

  const related = input.cases.filter((item) => item.relatedToTarget);
  const scorableTargets = input.targetDimensions.filter((dimension) => JUDGE_SCORED_DIMENSIONS.includes(dimension));
  const targetDeltas = related.flatMap((item) => scorableTargets.map((dimension) =>
    (item.candidateScores[dimension] ?? 0) - (item.baselineScores[dimension] ?? 0)));
  const targetDimensionDelta = average(targetDeltas);
  if (scorableTargets.length && (!related.length || targetDimensionDelta < 5)) {
    reasons.push("A dimensão alvo não melhorou pelo menos 5 pontos.");
  }

  const overallDelta = average(input.cases.map((item) => item.candidateOverall - item.baselineOverall));
  if (overallDelta < -1) reasons.push("A nota geral caiu mais de 1 ponto.");

  const allDimensions = new Set(input.cases.flatMap((item) => [
    ...Object.keys(item.baselineScores),
    ...Object.keys(item.candidateScores)
  ]));
  const dimensionDeltas = [...allDimensions].map((dimension) => average(input.cases.map((item) =>
    (item.candidateScores[dimension] ?? 0) - (item.baselineScores[dimension] ?? 0))));
  const worstDimensionDelta = dimensionDeltas.length ? Math.min(...dimensionDeltas) : 0;
  if (worstDimensionDelta < -3) reasons.push("Uma dimensão caiu mais de 3 pontos.");

  const unexpectedToolCalls = input.cases.reduce((total, item) => total + item.unexpectedToolCalls, 0);
  if (unexpectedToolCalls > 0) reasons.push("A candidata chamou ferramenta proibida ou inesperada.");

  const missingTransactionalEvidence = input.cases.filter((item) => item.missingTransactionalEvidence).length;
  if (missingTransactionalEvidence > 0) {
    reasons.push("A candidata afirmou sucesso transacional sem claims e evidência simulada aprovados.");
  }

  const deterministicFailures = input.cases.reduce(
    (total, item) => total + (item.deterministicFailures ?? 0),
    0
  );
  if (deterministicFailures > 0) {
    reasons.push("A candidata violou asserts determinísticos de ação, ferramenta, argumentos ou claims.");
  }

  const costIncreasePercent = input.baselineCostPerResponse > 0
    ? ((input.candidateCostPerResponse - input.baselineCostPerResponse) / input.baselineCostPerResponse) * 100
    : input.candidateCostPerResponse > 0 ? Number.POSITIVE_INFINITY : 0;
  if (costIncreasePercent > 20 && !input.acceptedCostJustification) {
    reasons.push("O custo estimado aumentou mais de 20% sem justificativa aceita.");
  }

  return {
    status: reasons.length ? "test_failed" : "ready",
    reasons,
    metrics: {
      targetDimensionDelta,
      overallDelta,
      worstDimensionDelta,
      costIncreasePercent,
      unexpectedToolCalls,
      missingTransactionalEvidence,
      deterministicFailures
    }
  };
}

export interface SimulatedTransactionalEvidence {
  status: "succeeded" | "failed" | "pending";
  claims: Array<{
    claimType: string;
    normalizedValue: string;
  }>;
}

export interface SimulatedToolExpectation {
  name: string;
  result: string;
  arguments?: Record<string, unknown>;
  transactionalOutcome?: SimulatedTransactionalEvidence;
}

export class SimulatedToolExecutor {
  private position = 0;
  private mismatchCount = 0;
  readonly calls: Array<{
    name: string;
    arguments: Record<string, unknown>;
    transactionalOutcome?: SimulatedTransactionalEvidence;
  }> = [];

  constructor(private readonly expectations: SimulatedToolExpectation[]) {}

  /** Ferramentas inesperadas ou com argumentos divergentes observadas até agora. */
  get unexpectedToolCalls(): number {
    return this.mismatchCount;
  }

  // ponytail: retorna um resultado de erro em vez de lançar exceção — uma ferramenta
  // simulada que falha não pode derrubar o turno inteiro e zerar a resposta final, do
  // contrário nunca sobra texto para o juiz/gates avaliarem (bug que travava todo publish).
  async execute(name: string, argumentsJson: string): Promise<string> {
    let args: Record<string, unknown>;
    try {
      const value = JSON.parse(argumentsJson || "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid arguments");
      args = value as Record<string, unknown>;
    } catch {
      this.mismatchCount += 1;
      this.calls.push({ name, arguments: {} });
      return JSON.stringify({ error: "Argumentos inválidos para esta ferramenta." });
    }
    const expected = this.expectations[this.position];
    if (!expected || expected.name !== name) {
      this.mismatchCount += 1;
      this.calls.push({ name, arguments: args });
      return JSON.stringify({ error: `Ferramenta indisponível neste cenário: ${name}.` });
    }
    if (expected.arguments && JSON.stringify(expected.arguments) !== JSON.stringify(args)) {
      this.mismatchCount += 1;
      this.calls.push({ name, arguments: args });
      return JSON.stringify({ error: `Argumentos inesperados para: ${name}.` });
    }
    this.calls.push({
      name,
      arguments: args,
      ...(expected.transactionalOutcome ? { transactionalOutcome: expected.transactionalOutcome } : {})
    });
    this.position += 1;
    return expected.result;
  }
}

export function replayHasTransactionalEvidence(
  response: string,
  calls: SimulatedToolExecutor["calls"],
  hasActiveAppointment = false
): boolean {
  if (!claimsUnprovenTransactionalSuccess(response, hasActiveAppointment)) return true;
  return calls.some((call) =>
    call.transactionalOutcome?.status === "succeeded"
    && call.transactionalOutcome.claims.length > 0
    && call.transactionalOutcome.claims.every((claim) =>
      claim.claimType.trim().length > 0 && claim.normalizedValue.trim().length > 0));
}

const transitions: Record<string, string[]> = {
  draft: ["proposed", "rejected"],
  proposed: ["testing", "rejected", "superseded"],
  testing: ["ready", "test_failed"],
  test_failed: ["testing", "rejected", "superseded"],
  ready: ["testing", "published", "rejected", "superseded"],
  published: [],
  rejected: [],
  superseded: []
};

export function assertProposalTransition(current: string, next: string): void {
  if (!transitions[current]?.includes(next)) {
    throw Object.assign(new Error(`Transição inválida de ${current} para ${next}`), { statusCode: 409 });
  }
}
