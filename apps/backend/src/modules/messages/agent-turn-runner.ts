import type { AiRouter, FinalTextCorrection, ToolExecutor } from "../ai-router/openrouter.js";
import { protectedSystemPrompt } from "../ai-router/prompt-guard.js";
import { enabledToolDefinitions } from "../ai-router/tools.js";
import { AI_HANDOFF_MARKER } from "./handoff.js";
import {
  gateToolsForCanonicalState,
  type CanonicalConversationState
} from "./state-tool-gating.js";

declare const replayToolCapability: unique symbol;

/**
 * Nominal capability accepted only by replay mode. A production executor is a
 * plain function and cannot be assigned here without going through the
 * explicit simulator factory.
 */
export type ReplayToolExecutor = ToolExecutor & {
  readonly [replayToolCapability]: "simulated-only";
};

export function createReplayToolExecutor(execute: ToolExecutor): ReplayToolExecutor {
  return execute as ReplayToolExecutor;
}

interface SharedTurnInput {
  gateway: Pick<AiRouter, "complete">;
  clock: () => Date;
  model: string;
  provider?: string;
  apiKey?: string;
  baseSystemPrompt: string;
  dynamicNotes?: readonly string[];
  clockNote?: (now: Date) => string;
  temperature: number;
  maxTokens: number;
  reasoningEffort?: Parameters<AiRouter["complete"]>[0]["reasoningEffort"];
  history: Array<{ role: "user" | "assistant"; content: string }>;
  enabledToolNames: readonly string[];
  canonicalState?: CanonicalConversationState;
  stateToolGatingEnabled?: boolean;
  ambiguousSchedulingTurn?: boolean;
  toolChoice?: Parameters<AiRouter["complete"]>[0]["toolChoice"];
  validateFinalText?: (text: string) => FinalTextCorrection | string | undefined;
  onUsage?: Parameters<AiRouter["complete"]>[0]["onUsage"];
  trace?: Parameters<AiRouter["complete"]>[0]["trace"];
}

export type AgentTurnInput =
  | (SharedTurnInput & { mode: "production"; executeTool?: ToolExecutor })
  | (SharedTurnInput & { mode: "replay"; executeTool?: ReplayToolExecutor });

export interface AgentTurnResult {
  completion: Awaited<ReturnType<AiRouter["complete"]>>;
  enabledToolNames: string[];
  systemPrompt: string;
}

const FALSE_APPOINTMENT_CONFIRMATION =
  /\b(?:agendad[oa]|confirmad[oa]|marcad[oa]|reservad[oa])\b/iu;

function sharedFinalValidator(
  input: Pick<SharedTurnInput, "ambiguousSchedulingTurn" | "validateFinalText">,
  text: string
): FinalTextCorrection | string | undefined {
  if (input.ambiguousSchedulingTurn && FALSE_APPOINTMENT_CONFIRMATION.test(text)) {
    return "A escolha do contato é ambígua porque havia mais de um horário. Pergunte qual horário ele prefere e não afirme que o compromisso foi criado.";
  }
  return input.validateFinalText?.(text);
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const enabledToolNames = input.stateToolGatingEnabled && input.canonicalState
    ? gateToolsForCanonicalState(input.enabledToolNames, input.canonicalState)
    : [...input.enabledToolNames];
  const dynamicNotes = [
    ...(input.clockNote ? [input.clockNote(input.clock())] : []),
    ...(input.dynamicNotes ?? [])
  ].filter(Boolean);
  // Keep tenant instructions stable and cacheable. Per-turn facts (especially
  // the second-level clock) live in a separate system message so they do not
  // invalidate the large Anthropic prompt cache on every provider request.
  // Usa a lista configurada, não a filtrada por estado: o gating muda de turno
  // para turno e trocaria o bloco de política no meio da conversa, invalidando
  // o cache de prompt sem motivo.
  const cacheableSystemPrompt = protectedSystemPrompt(
    input.baseSystemPrompt,
    AI_HANDOFF_MARKER,
    input.enabledToolNames
  );
  const systemContext = dynamicNotes.join("");
  const systemPrompt = `${cacheableSystemPrompt}${systemContext}`;
  const requestedToolName = typeof input.toolChoice === "object"
    ? input.toolChoice.function.name
    : undefined;
  const toolChoice = requestedToolName && !enabledToolNames.includes(requestedToolName)
    ? undefined
    : input.toolChoice;
  const completion = await input.gateway.complete({
    model: input.model,
    provider: input.provider,
    apiKey: input.apiKey,
    systemPrompt: cacheableSystemPrompt,
    systemContext,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    reasoningEffort: input.reasoningEffort,
    history: input.history,
    tools: enabledToolDefinitions(enabledToolNames),
    executeTool: input.executeTool,
    toolChoice,
    validateFinalText: (text) => sharedFinalValidator(input, text),
    onUsage: input.onUsage,
    trace: input.trace
  });
  return { completion, enabledToolNames, systemPrompt };
}
