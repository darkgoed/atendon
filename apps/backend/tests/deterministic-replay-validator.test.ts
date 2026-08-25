import { describe, expect, it } from "vitest";
import {
  validateDeterministicReplay,
  type DeterministicReplayExpectation
} from "../src/modules/agent-improvement/deterministic-replay-validator.js";

const expectation: DeterministicReplayExpectation = {
  action: "schedule",
  actionEvidence: { type: "tool", toolName: "agendar_reuniao" },
  toolCalls: [{
    name: "agendar_reuniao",
    arguments: {
      agenda_id: "agenda-comercial",
      start: "2030-01-07T13:00:00.000Z"
    }
  }],
  claims: [{ claimType: "appointment_status", normalizedValue: "confirmado" }]
};

const validCall = {
  name: "agendar_reuniao",
  arguments: {
    start: "2030-01-07T13:00:00.000Z",
    agenda_id: "agenda-comercial"
  },
  transactionalOutcome: {
    status: "succeeded" as const,
    claims: [{ claimType: "appointment_status", normalizedValue: "confirmado" }]
  }
};

describe("deterministic replay validator", () => {
  it("accepts exact action, arguments and claims independently of object key order", () => {
    expect(validateDeterministicReplay({
      severity: "critical",
      expectation,
      response: "Sua reunião foi confirmada.",
      calls: [validCall]
    })).toEqual({ passed: true, violations: [] });
  });

  it("rejects divergent tool arguments", () => {
    const result = validateDeterministicReplay({
      severity: "critical",
      expectation,
      response: "Sua reunião foi confirmada.",
      calls: [{
        ...validCall,
        arguments: {
          ...validCall.arguments,
          start: "2030-01-07T14:00:00.000Z"
        }
      }]
    });
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(expect.objectContaining({
      code: "TOOL_ARGUMENTS_MISMATCH"
    }));
  });

  it("rejects a missing action even when the response claims success", () => {
    const result = validateDeterministicReplay({
      severity: "critical",
      expectation,
      response: "Está tudo confirmado.",
      calls: []
    });
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(expect.objectContaining({
      code: "ACTION_EVIDENCE_MISSING"
    }));
  });

  it("rejects a missing transactional claim", () => {
    const result = validateDeterministicReplay({
      severity: "high",
      expectation,
      response: "Sua reunião foi confirmada.",
      calls: [{ name: validCall.name, arguments: validCall.arguments }]
    });
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(expect.objectContaining({
      code: "CLAIM_SET_MISMATCH"
    }));
  });

  it("fails closed when a critical or high case has no deterministic contract", () => {
    expect(validateDeterministicReplay({
      severity: "high",
      response: "Resposta aparentemente correta.",
      calls: []
    }).violations).toContainEqual(expect.objectContaining({
      code: "DETERMINISTIC_EXPECTATION_MISSING"
    }));
  });
});
