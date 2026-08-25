import { describe, expect, it, vi } from "vitest";
import { OpenRouterClient, type AiRouter, type ToolExecutor } from "../src/modules/ai-router/openrouter.js";
import { SimulatedToolExecutor } from "../src/modules/agent-improvement/replay.js";
import {
  createReplayToolExecutor,
  runAgentTurn,
  type AgentTurnInput
} from "../src/modules/messages/agent-turn-runner.js";
import { workspaceClockNote } from "../src/modules/messages/turn-clock.js";

const gateway = {
  complete: vi.fn<AiRouter["complete"]>().mockImplementation(async (input) => {
    const correction = input.validateFinalText?.("Reunião confirmada.");
    return {
      text: (typeof correction === "string" ? correction : correction?.correction) ?? "ok",
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0
    };
  })
};

const common = {
  gateway,
  clock: () => new Date("2030-01-07T12:00:00.000Z"),
  clockNote: (now: Date) => workspaceClockNote("America/Sao_Paulo", now),
  model: "model/test",
  baseSystemPrompt: "Atenda.",
  temperature: 0.2,
  maxTokens: 512,
  history: [{ role: "user" as const, content: "sim" }],
  enabledToolNames: ["verificar_horarios_reuniao", "agendar_reuniao"]
};

describe("shared agent turn runner", () => {
  it("injects the clock, applies the same state gate and corrects ambiguous success", async () => {
    const executeTool = createReplayToolExecutor(async () => "{}");
    const result = await runAgentTurn({
      ...common,
      mode: "replay",
      canonicalState: "awaiting_confirmation",
      stateToolGatingEnabled: true,
      ambiguousSchedulingTurn: true,
      executeTool
    });

    expect(result.enabledToolNames).toEqual(["verificar_horarios_reuniao"]);
    expect(result.systemPrompt).toContain("2030-01-07 (segunda-feira), 09:00:00");
    expect(result.completion.text).toContain("escolha do contato é ambígua");
    expect(gateway.complete.mock.calls.at(-1)![0].tools
      ?.map((tool) => tool.function.name)).toEqual(["verificar_horarios_reuniao"]);
  });

  it("preserves configured tools in production when the state flag is OFF", async () => {
    const result = await runAgentTurn({
      ...common,
      mode: "production",
      stateToolGatingEnabled: false,
      executeTool: async () => "{}"
    });
    expect(result.enabledToolNames).toEqual(common.enabledToolNames);
  });

  it("produces a non-empty final answer in replay mode after a simulated tool call", async () => {
    // Regression test for a historical bug where the replay's simulated tool
    // result never reached the model's next turn, so candidate/baseline
    // responses came back empty for every gold case that used a tool and
    // blocked every publish. This exercises the real OpenRouterClient (not a
    // stub gateway) driving a SimulatedToolExecutor exactly like replay-runner.ts.
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call-1",
              type: "function",
              function: { name: "consultar_agendas", arguments: "{}" }
            }]
          }
        }]
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "Hoje tenho 10h ou 14h, qual funciona melhor pra você?" } }]
      }));
    const realGateway = new OpenRouterClient({
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_APP_URL: "https://atendon.test",
      OPENROUTER_APP_NAME: "AtendON",
      OPENROUTER_TIMEOUT_MS: 60_000,
      AI_MAX_PROVIDER_REQUESTS_PER_TURN: 14,
      AI_RESERVED_FINAL_REQUESTS: 2
    } as never, fetcher);
    const simulator = new SimulatedToolExecutor([
      { name: "consultar_agendas", arguments: {}, result: JSON.stringify({ agendas: [{ id: "reunioes", nome: "Reuniões" }] }) }
    ]);
    const executeTool = createReplayToolExecutor((name, argumentsJson) => simulator.execute(name, argumentsJson));

    const result = await runAgentTurn({
      ...common,
      gateway: realGateway,
      mode: "replay",
      apiKey: "tenant-secret",
      history: [{ role: "user", content: "Quais horários vocês têm?" }],
      enabledToolNames: ["consultar_agendas"],
      executeTool
    });

    expect(result.completion.text).not.toBe("");
    expect(result.completion.text).toContain("10h");
    expect(simulator.calls).toEqual([{ name: "consultar_agendas", arguments: {} }]);
    expect(simulator.unexpectedToolCalls).toBe(0);
  });

  it("requires the explicit simulator capability in replay mode at compile time", () => {
    const realExecutor: ToolExecutor = async () => "{}";
    const base = { ...common, mode: "replay" as const };
    // @ts-expect-error A plain/real executor does not carry the replay-only capability.
    const unsafeReplay: AgentTurnInput = { ...base, executeTool: realExecutor };
    expect(unsafeReplay.mode).toBe("replay");
  });
});
