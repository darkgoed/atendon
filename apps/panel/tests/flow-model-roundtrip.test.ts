// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";

import {
  PALETTE,
  PALETTE_GROUPS,
  TRIGGER_ID,
  graphFromDefinition,
  newStepFor,
  paletteItemForStep,
  validateDefinition,
  type FlowDefinition,
  type FlowStep,
  type GraphEdge,
  type GraphNode,
} from "@/components/flow-editor/flow-model";

/* ─── fixture: uma etapa de CADA kind da paleta, válida no validateDefinition ── */
const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const FIXTURE: FlowDefinition = {
  start: "P1",
  triggers: { ctwa: false, session_ids: [], keywords: [] },
  steps: {
    P1: {
      kind: "options",
      question: "Qual o interesse?",
      field: "interesse",
      options: [{ value: "Ótica" }, { value: "Outros" }],
      transitions: { "Ótica": "M1" },
      next: "P2",
    },
    P2: {
      kind: "boolean",
      question: "É cliente?",
      options: [{ value: "SIM" }, { value: "NÃO" }],
      transitions: { "SIM": "B1", "NÃO": "F1" },
    },
    M1: { kind: "message", message: "Ótimo!", next: "T1" },
    T1: { kind: "text", question: "Seu nome?", field: "nome", next: "D1" },
    D1: { kind: "delay", wait_minutes: 5, next: "W1" },
    W1: { kind: "wait_for_reply", timeout_minutes: 30, on_timeout: "F1", next: "A1" },
    A1: { kind: "action", action_type: "tag_add", tag_ids: [UUID], next: "A2" },
    A2: { kind: "action", action_type: "tag_remove", tag_ids: [UUID], next: "A3" },
    A3: { kind: "action", action_type: "stage_move", stage_id: UUID, next: "A4" },
    A4: { kind: "action", action_type: "assign_agent", agent_id: UUID, next: "A5" },
    A5: { kind: "action", action_type: "webhook", webhook_url: "https://exemplo.com/webhook", next: "B1" },
    B1: {
      kind: "branch",
      variable_name: "interesse",
      operator: "eq",
      value: "otica",
      transitions: { yes: "I1", no: "F2" },
    },
    I1: {
      kind: "interactive",
      interactive_type: "buttons",
      options: [{ value: "Sim" }, { value: "Não" }, { value: "Talvez" }],
      transitions: { "Sim": "FIN", "Não": "F1", "Talvez": "F1" },
    },
    FIN: { kind: "finalize", end_reason: "cliente_atendido" },
    F1: { kind: "final", message: "Até logo!" },
    F2: { kind: "final", message: "Encerrado" },
  },
};

/** Projeção comparável do grafo: sem posições (dagre) e sem previews (payload). */
function project(graph: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  return {
    nodes: graph.nodes.map((node) => ({ id: node.id, nodeType: node.nodeType, options: node.options })),
    edges: graph.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      label: edge.label,
    })),
  };
}

/** definition → grafo → definition: nós dão os steps (payload = defaults da
    paleta + escolhas do grafo), arestas dão a topologia (next/transitions). */
function definitionFromGraph(nodes: GraphNode[], edges: GraphEdge[]): FlowDefinition {
  const steps: Record<string, FlowStep> = {};
  for (const node of nodes) {
    if (node.id === TRIGGER_ID) continue;
    const item = PALETTE.flatMap((group) => group.items).find((candidate) => candidate.id === node.nodeType);
    if (!item) throw new Error(`nodeType "${node.nodeType}" fora da paleta`);
    const step: FlowStep = { ...newStepFor(item) };
    /* Escolhas vindas do grafo viram options apenas nos kinds em que stepOptions
       deriva de step.options; branch (yes/no) não leva campo options. */
    if (node.options.length && ["options", "boolean", "years", "revenue", "interactive"].includes(item.kind)) {
      step.options = node.options.map((value) => ({ value }));
    }
    for (const edge of edges.filter((candidate) => candidate.source === node.id)) {
      if (edge.sourceHandle === "out") step.next = edge.target;
      else step.transitions = { ...step.transitions, [edge.sourceHandle]: edge.target };
    }
    steps[node.id] = step;
  }
  const triggerEdge = edges.find((edge) => edge.source === TRIGGER_ID);
  return {
    start: triggerEdge?.target ?? "",
    triggers: { ctwa: false, session_ids: [], keywords: [] },
    steps,
  };
}

describe("flow-model roundtrip definition↔graph↔definition", () => {
  it("grafo da fixture cobre todos os kinds da paleta (os existentes + os 3 novos)", () => {
    const graph = graphFromDefinition(FIXTURE);
    const nodeTypes = new Set(graph.nodes.map((node) => node.nodeType));
    for (const group of PALETTE) {
      for (const item of group.items) {
        expect(nodeTypes.has(item.id), `kind "${item.id}" ausente do grafo`).toBe(true);
      }
    }
    expect(nodeTypes.has("branch")).toBe(true);
    expect(nodeTypes.has("finalize")).toBe(true);
    expect(nodeTypes.has("interactive")).toBe(true);
  });

  it("definition → grafo → definition preserva identidade, tipo, escolhas e topologia (sem posições)", () => {
    expect(validateDefinition(FIXTURE)).toEqual([]);
    const first = graphFromDefinition(FIXTURE);
    const rebuilt = definitionFromGraph(first.nodes, first.edges);
    const second = graphFromDefinition(rebuilt);
    expect(project(second)).toEqual(project(first));
  });

  it("roundtrip é idempotente (definition reconstruída gera o mesmo grafo de si mesma)", () => {
    const first = graphFromDefinition(FIXTURE);
    const rebuilt = definitionFromGraph(first.nodes, first.edges);
    const again = definitionFromGraph(graphFromDefinition(rebuilt).nodes, graphFromDefinition(rebuilt).edges);
    expect(project(graphFromDefinition(again))).toEqual(project(first));
  });
});

describe("paleta consolidada (fonte única no flow-model)", () => {
  it("PALETTE_GROUPS é a própria PALETTE (mesma referência, grupos intactos)", () => {
    expect(PALETTE_GROUPS).toBe(PALETTE);
    expect(PALETTE.map((group) => group.group)).toEqual(["Mensagens", "Controle", "Ações CRM"]);
  });

  it("itens novos têm kind/action corretos e payload espelhado no zod", () => {
    const flat = PALETTE.flatMap((group) => group.items);
    const byId = Object.fromEntries(flat.map((item) => [item.id, item]));
    expect(byId.branch).toMatchObject({ kind: "branch" });
    expect(byId.finalize).toMatchObject({ kind: "finalize" });
    expect(byId.interactive).toMatchObject({ kind: "interactive" });
    expect(paletteItemForStep({ kind: "branch" })?.id).toBe("branch");
    expect(paletteItemForStep({ kind: "finalize" })?.id).toBe("finalize");
    expect(paletteItemForStep({ kind: "interactive" })?.id).toBe("interactive");
  });

  it("newStepFor dos 3 kinds novos espelha o shape do zod (flow.ts:117-127,122,124)", () => {
    const flat = PALETTE.flatMap((group) => group.items);
    const byId = Object.fromEntries(flat.map((item) => [item.id, item]));
    expect(newStepFor(byId.branch)).toEqual({ kind: "branch", variable_name: "", operator: "eq", value: "" });
    expect(newStepFor(byId.finalize)).toEqual({ kind: "finalize", end_reason: "" });
    expect(newStepFor(byId.interactive)).toEqual({
      kind: "interactive",
      interactive_type: "buttons",
      message: "",
      options: [{ value: "Opção 1" }],
    });
  });
});

describe("validação client rejeita payload inválido dos kinds novos", () => {
  it("branch sem transitions yes/no é rejeitado (controle: fixture com transitions passa)", () => {
    expect(validateDefinition(FIXTURE).filter((issue) => issue.stepId === "B1")).toEqual([]);
    const broken: FlowDefinition = {
      ...FIXTURE,
      steps: {
        ...FIXTURE.steps,
        B1: { ...FIXTURE.steps.B1, kind: "branch", variable_name: "v", operator: "eq", value: "x", transitions: undefined },
      },
    };
    const messages = validateDefinition(broken).filter((issue) => issue.stepId === "B1").map((issue) => issue.message);
    expect(messages.some((message) => message.includes('saída "yes"'))).toBe(true);
    expect(messages.some((message) => message.includes('saída "no"'))).toBe(true);
  });

  it("branch is_empty com value é rejeitado; sem value passa (controle)", () => {
    const withValue: FlowDefinition = {
      ...FIXTURE,
      steps: {
        ...FIXTURE.steps,
        B1: { ...FIXTURE.steps.B1, kind: "branch", variable_name: "v", operator: "is_empty", value: "sobrando", transitions: { yes: "I1", no: "F2" } },
      },
    };
    const messages = validateDefinition(withValue).filter((issue) => issue.stepId === "B1").map((issue) => issue.message);
    expect(messages.some((message) => message.includes("não aceita valor"))).toBe(true);

    const withoutValue: FlowDefinition = {
      ...FIXTURE,
      steps: {
        ...FIXTURE.steps,
        B1: { ...FIXTURE.steps.B1, kind: "branch", variable_name: "v", operator: "is_empty", value: undefined, transitions: { yes: "I1", no: "F2" } },
      },
    };
    expect(validateDefinition(withoutValue).filter((issue) => issue.stepId === "B1")).toEqual([]);
  });

  it("interactive com 4 botões é rejeitado (máx 3); escolha sem roteamento também", () => {
    const fourButtons: FlowDefinition = {
      ...FIXTURE,
      steps: {
        ...FIXTURE.steps,
        I1: {
          ...FIXTURE.steps.I1,
          kind: "interactive",
          interactive_type: "buttons",
          options: [{ value: "A" }, { value: "B" }, { value: "C" }, { value: "D" }],
          transitions: { A: "FIN", B: "F1", C: "F1", D: "F1" },
        },
      },
    };
    const messages = validateDefinition(fourButtons).filter((issue) => issue.stepId === "I1").map((issue) => issue.message);
    expect(messages.some((message) => message.includes("máximo 3 botões"))).toBe(true);

    const unrouted: FlowDefinition = {
      ...FIXTURE,
      steps: {
        ...FIXTURE.steps,
        I1: {
          ...FIXTURE.steps.I1,
          kind: "interactive",
          interactive_type: "buttons",
          options: [{ value: "Sim" }, { value: "Não" }, { value: "Talvez" }],
          transitions: { "Sim": "FIN" },
        },
      },
    };
    const unroutedMessages = validateDefinition(unrouted).filter((issue) => issue.stepId === "I1").map((issue) => issue.message);
    expect(unroutedMessages.filter((message) => message.includes("não tem etapa seguinte")).length).toBe(2);
  });
});
