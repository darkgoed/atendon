import { describe, expect, it } from "vitest";
import {
  assertProposalTransition,
  evaluateReplayGates,
  replayHasTransactionalEvidence,
  SimulatedToolExecutor
} from "../src/modules/agent-improvement/replay.js";

const passingCase = {
  caseId: "case-1",
  severity: "high" as const,
  relatedToTarget: true,
  baselineScores: { continuity: 70, communication: 90 },
  candidateScores: { continuity: 80, communication: 89 },
  baselineOverall: 80,
  candidateOverall: 84,
  candidateHasCriticalFailure: false,
  unexpectedToolCalls: 0,
  missingTransactionalEvidence: false,
  passed: true
};

describe("safe AI improvement replay", () => {
  it("produces ready only when every blocking gate passes", () => {
    expect(evaluateReplayGates({
      cases: [passingCase],
      targetDimensions: ["continuity"],
      baselineCostPerResponse: 0.01,
      candidateCostPerResponse: 0.011
    })).toMatchObject({ status: "ready", reasons: [] });
  });

  it("blocks critical/high failures, regressions, unexpected tools and excess cost", () => {
    const result = evaluateReplayGates({
      cases: [{
        ...passingCase,
        passed: false,
        candidateHasCriticalFailure: true,
        candidateScores: { continuity: 72, communication: 80 },
        candidateOverall: 77,
        unexpectedToolCalls: 1
      }],
      targetDimensions: ["continuity"],
      baselineCostPerResponse: 0.01,
      candidateCostPerResponse: 0.02
    });
    expect(result.status).toBe("test_failed");
    expect(result.reasons).toHaveLength(7);
  });

  it("uses only recorded simulator results and flags an unexpected tool without discarding the turn", async () => {
    const simulator = new SimulatedToolExecutor([{ name: "verificar_horarios", result: "09:00, 10:00" }]);
    await expect(simulator.execute("verificar_horarios", "{}")).resolves.toBe("09:00, 10:00");
    expect(simulator.unexpectedToolCalls).toBe(0);

    const rejecting = new SimulatedToolExecutor([]);
    const result = await rejecting.execute("agendar_reuniao", "{}");
    expect(JSON.parse(result)).toHaveProperty("error");
    expect(rejecting.unexpectedToolCalls).toBe(1);
  });

  it("blocks transactional success unless the simulator carries approved structured claims", async () => {
    const withoutEvidence = new SimulatedToolExecutor([{
      name: "agendar_reuniao",
      result: JSON.stringify({ status: "confirmado" })
    }]);
    await withoutEvidence.execute("agendar_reuniao", "{}");
    expect(replayHasTransactionalEvidence("Pronto, agendei sua reunião.", withoutEvidence.calls)).toBe(false);
    expect(evaluateReplayGates({
      cases: [{ ...passingCase, missingTransactionalEvidence: true, passed: false }],
      targetDimensions: ["continuity"],
      baselineCostPerResponse: 0,
      candidateCostPerResponse: 0
    })).toMatchObject({
      status: "test_failed",
      metrics: { missingTransactionalEvidence: 1 }
    });

    const withEvidence = new SimulatedToolExecutor([{
      name: "agendar_reuniao",
      result: JSON.stringify({ status: "confirmado" }),
      transactionalOutcome: {
        status: "succeeded",
        claims: [{ claimType: "transaction_status", normalizedValue: "succeeded" }]
      }
    }]);
    await withEvidence.execute("agendar_reuniao", "{}");
    expect(replayHasTransactionalEvidence("Pronto, agendei sua reunião.", withEvidence.calls)).toBe(true);
  });

  it("does not block a status reaffirmation when the scenario has an active appointment", () => {
    expect(replayHasTransactionalEvidence("A visita está agendada, posso ajudar em algo mais?", [], true))
      .toBe(true);
  });

  it("rejects invalid proposal state transitions", () => {
    expect(() => assertProposalTransition("ready", "published")).not.toThrow();
    expect(() => assertProposalTransition("test_failed", "published")).toThrow(/Transição inválida/);
    expect(() => assertProposalTransition("published", "testing")).toThrow(/Transição inválida/);
  });
});
