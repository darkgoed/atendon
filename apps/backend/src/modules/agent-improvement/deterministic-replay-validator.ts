import type {
  SimulatedToolExecutor,
  SimulatedTransactionalEvidence
} from "./replay.js";

export type DeterministicActionEvidence =
  | {
      type: "tool";
      toolName: string;
    }
  | {
      type: "response";
      anyOf: string[];
    };

export interface DeterministicReplayExpectation {
  action: string;
  actionEvidence: DeterministicActionEvidence;
  toolCalls: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
  claims: Array<{
    claimType: string;
    normalizedValue: string;
  }>;
}

export type DeterministicReplayCall = SimulatedToolExecutor["calls"][number];

export type DeterministicReplayViolationCode =
  | "DETERMINISTIC_EXPECTATION_MISSING"
  | "ACTION_EVIDENCE_MISSING"
  | "TOOL_CALL_COUNT_MISMATCH"
  | "TOOL_ACTION_MISMATCH"
  | "TOOL_ARGUMENTS_MISMATCH"
  | "CLAIM_SET_MISMATCH";

export interface DeterministicReplayViolation {
  code: DeterministicReplayViolationCode;
  field: "configuration" | "action" | "tool_calls" | "tool_arguments" | "claims";
  detail: string;
}

export interface DeterministicReplayValidation {
  passed: boolean;
  violations: DeterministicReplayViolation[];
}

const BLOCKING_SEVERITIES = new Set(["critical", "high"]);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedClaims(calls: readonly DeterministicReplayCall[]): string[] {
  return calls
    .flatMap((call) =>
      call.transactionalOutcome?.status === "succeeded"
        ? call.transactionalOutcome.claims
        : []
    )
    .map((claim) => `${claim.claimType.trim()}:${claim.normalizedValue.trim()}`)
    .sort();
}

function expectedClaims(expectation: DeterministicReplayExpectation): string[] {
  return expectation.claims
    .map((claim) => `${claim.claimType.trim()}:${claim.normalizedValue.trim()}`)
    .sort();
}

export function claimsFromTransactionalOutcome(
  outcome: SimulatedTransactionalEvidence | undefined
): DeterministicReplayExpectation["claims"] {
  return outcome?.status === "succeeded" ? [...outcome.claims] : [];
}

export function validateDeterministicReplay(input: {
  severity: "critical" | "high" | "medium" | "low";
  expectation?: DeterministicReplayExpectation;
  response: string;
  calls: readonly DeterministicReplayCall[];
}): DeterministicReplayValidation {
  const violations: DeterministicReplayViolation[] = [];
  const expectation = input.expectation;

  if (!expectation) {
    if (BLOCKING_SEVERITIES.has(input.severity)) {
      violations.push({
        code: "DETERMINISTIC_EXPECTATION_MISSING",
        field: "configuration",
        detail: "Caso crítico ou alto não possui contrato determinístico."
      });
    }
    return { passed: violations.length === 0, violations };
  }

  if (expectation.actionEvidence.type === "tool") {
    const expectedToolName = expectation.actionEvidence.toolName;
    if (!input.calls.some((call) => call.name === expectedToolName)) {
      violations.push({
        code: "ACTION_EVIDENCE_MISSING",
        field: "action",
        detail: `A ação ${expectation.action} não executou a ferramenta esperada.`
      });
    }
  } else {
    const response = normalizedText(input.response);
    const actionObserved = expectation.actionEvidence.anyOf
      .filter((phrase) => phrase.trim().length > 0)
      .some((phrase) => response.includes(normalizedText(phrase)));
    if (!actionObserved) {
      violations.push({
        code: "ACTION_EVIDENCE_MISSING",
        field: "action",
        detail: `A resposta não contém evidência observável da ação ${expectation.action}.`
      });
    }
  }

  if (input.calls.length !== expectation.toolCalls.length) {
    violations.push({
      code: "TOOL_CALL_COUNT_MISMATCH",
      field: "tool_calls",
      detail: "A quantidade de ferramentas executadas diverge do contrato determinístico."
    });
  }

  const comparableLength = Math.min(input.calls.length, expectation.toolCalls.length);
  for (let index = 0; index < comparableLength; index += 1) {
    const actual = input.calls[index]!;
    const expected = expectation.toolCalls[index]!;
    if (actual.name !== expected.name) {
      violations.push({
        code: "TOOL_ACTION_MISMATCH",
        field: "tool_calls",
        detail: `A ferramenta na posição ${index + 1} diverge do contrato determinístico.`
      });
    }
    if (canonicalJson(actual.arguments) !== canonicalJson(expected.arguments)) {
      violations.push({
        code: "TOOL_ARGUMENTS_MISMATCH",
        field: "tool_arguments",
        detail: `Os argumentos da ferramenta na posição ${index + 1} divergem do contrato determinístico.`
      });
    }
  }

  if (canonicalJson(normalizedClaims(input.calls)) !== canonicalJson(expectedClaims(expectation))) {
    violations.push({
      code: "CLAIM_SET_MISMATCH",
      field: "claims",
      detail: "Os claims transacionais aprovados divergem do contrato determinístico."
    });
  }

  return { passed: violations.length === 0, violations };
}
