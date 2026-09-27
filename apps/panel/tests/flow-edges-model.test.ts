import { describe, expect, it } from "vitest";

import {
  NODE_W,
  TRIGGER_ID,
  estimateNodeHeight,
  graphFromDefinition,
  layoutDefinition,
  setEdgeTarget,
  stepHandles,
  type FlowDefinition,
  type FlowStep,
  type GraphNode,
} from "@/components/flow-editor/flow-model";

/* Contrato de edges/handles do modelo puro do editor de fluxos.
   Cobertura: handles por kind (out, escolhas, timeout, inválida), colisão de
   escolha chamada "out", TRIGGER_ID reescrevendo definition.start, mutações
   inválidas devolvendo a definition SEM alteração (self-loop só bloqueado na
   CRIAÇÃO — ciclos legados continuam renderizando), e layout com largura 320. */

function definition(steps: FlowDefinition["steps"], start = "P1"): FlowDefinition {
  return { start, triggers: { ctwa: false, session_ids: [], keywords: [] }, steps };
}

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return { id: "x", nodeType: "message", label: "Mensagem", preview: "", options: [], ...overrides };
}

const BASE: FlowDefinition = definition({
  P1: { kind: "options", question: "?", options: [{ value: "A" }, { value: "B" }], transitions: { A: "M1" }, next: "P2" },
  P2: { kind: "wait_for_reply", timeout_minutes: 30, on_timeout: "T1", on_invalid_reply: "I1", next: "M1" },
  T1: { kind: "message", message: "tempo esgotado", next: "F1" },
  I1: { kind: "message", message: "resposta inválida", next: "F1" },
  M1: { kind: "message", message: "oi", next: "F1" },
  F1: { kind: "final", message: "fim" },
  FZ: { kind: "finalize", end_reason: "ok" },
});

const handleIds = (step: FlowStep) => stepHandles(step).map((handle) => handle.id);

describe("contrato de handles (stepHandles)", () => {
  it("kinds de saída única expõem só 'out'", () => {
    expect(handleIds({ kind: "message", message: "oi", next: "F1" })).toEqual(["out"]);
    expect(handleIds({ kind: "delay", wait_minutes: 5, next: "F1" })).toEqual(["out"]);
    expect(handleIds({ kind: "text", question: "?", next: "F1" })).toEqual(["out"]);
    expect(handleIds({ kind: "action", action_type: "tag_add", tag_ids: [], next: "F1" })).toEqual(["out"]);
  });

  it("wait_for_reply expõe out + timeout + inválida com rótulos legíveis", () => {
    const handles = stepHandles({ kind: "wait_for_reply", timeout_minutes: 30, next: "M1", on_timeout: "T1" });
    expect(handles.map((handle) => handle.id)).toEqual(["timeout", "invalid", "out"]);
    expect(handles.find((handle) => handle.id === "timeout")?.label).toBe("Tempo esgotado");
    expect(handles.find((handle) => handle.id === "invalid")?.label).toBe("Resposta inválida");
    expect(handles.find((handle) => handle.id === "out")?.label).toBe("Próxima");
  });

  it("terminadores (final/finalize) não expõem nenhum handle de saída", () => {
    expect(stepHandles({ kind: "final", message: "fim" })).toEqual([]);
    expect(stepHandles({ kind: "finalize", end_reason: "ok" })).toEqual([]);
  });

  it("kinds de escolha expõem um handle por opção + fallback 'out'; branch só yes/no", () => {
    expect(handleIds({ kind: "options", question: "?", options: [{ value: "A" }, { value: "B" }] })).toEqual(["A", "B", "out"]);
    expect(handleIds({ kind: "boolean", question: "?", options: [{ value: "SIM" }, { value: "NÃO" }] })).toEqual(["SIM", "NÃO", "out"]);
    expect(handleIds({ kind: "interactive", interactive_type: "buttons", message: "", options: [{ value: "Sim" }] })).toEqual(["Sim", "out"]);
    expect(handleIds({ kind: "branch", variable_name: "v", operator: "eq", value: "x" })).toEqual(["yes", "no"]);
  });
});

describe("grafo: edges on_timeout/on_invalid_reply", () => {
  it("emite arestas com handle e label legível p/ timeout e resposta inválida", () => {
    const { edges } = graphFromDefinition(BASE);
    expect(edges.find((edge) => edge.id === "P2:timeout")).toEqual({
      id: "P2:timeout",
      source: "P2",
      target: "T1",
      sourceHandle: "timeout",
      label: "Tempo esgotado",
    });
    expect(edges.find((edge) => edge.id === "P2:invalid")).toEqual({
      id: "P2:invalid",
      source: "P2",
      target: "I1",
      sourceHandle: "invalid",
      label: "Resposta inválida",
    });
  });

  it("arestas de next e escolhas continuam com ids/labels de hoje (sem perda)", () => {
    const { edges } = graphFromDefinition(BASE);
    expect(edges.find((edge) => edge.id === "P1:out")?.target).toBe("P2");
    expect(edges.find((edge) => edge.id === "P1:opt:A")?.label).toBe("A");
    expect(edges.find((edge) => edge.id === "P1:opt:A")?.target).toBe("M1");
    expect(edges.find((edge) => edge.source === TRIGGER_ID)?.target).toBe("P1");
  });

  it("ciclo legado existente continua renderizando (só a CRIAÇÃO de self-loop é bloqueada)", () => {
    const cycled: FlowDefinition = {
      ...BASE,
      steps: { ...BASE.steps, M1: { kind: "message", message: "oi", next: "P2" } },
    };
    const { edges } = graphFromDefinition(cycled);
    expect(edges.find((edge) => edge.id === "M1:out")?.target).toBe("P2");
    expect(edges.find((edge) => edge.id === "P1:out")?.target).toBe("P2");
  });
});

describe("colisão de escolha chamada 'out'", () => {
  const COLLISION: FlowDefinition = definition({
    S: { kind: "options", question: "?", options: [{ value: "out" }, { value: "B" }], transitions: { out: "M1" }, next: "P2" },
    P2: { kind: "message", message: "padrão", next: "M1" },
    M1: { kind: "final", message: "fim" },
  });

  it("'out' fica reservado p/ next; a escolha 'out' ganha handle dedicado 'opt:out' (link não descartado)", () => {
    const { edges } = graphFromDefinition(COLLISION);
    expect(edges.find((edge) => edge.id === "S:out")?.sourceHandle).toBe("out");
    expect(edges.find((edge) => edge.id === "S:out")?.target).toBe("P2");
    const choiceOut = edges.find((edge) => edge.id === "S:opt:out");
    expect(choiceOut?.sourceHandle).toBe("opt:out");
    expect(choiceOut?.target).toBe("M1");
    expect(choiceOut?.label).toBe("out");
    expect(handleIds(COLLISION.steps.S)).toEqual(["opt:out", "B", "out"]);
  });

  it("'out' escreve next; 'opt:out' escreve transitions.out — um não apaga o outro", () => {
    const viaOut = setEdgeTarget(COLLISION, "S", "out", "P2");
    expect(viaOut.steps.S.next).toBe("P2");
    expect(viaOut.steps.S.transitions?.out).toBe("M1");

    const viaOptOut = setEdgeTarget(COLLISION, "S", "opt:out", "P2");
    expect(viaOptOut.steps.S.transitions?.out).toBe("P2");
    expect(viaOptOut.steps.S.next).toBe("P2");
  });
});

describe("handles reservados ficam injetivos (keys out/timeout/invalid e opt:* legadas)", () => {
  /* Auditoria (bug real): wait_for_reply com on_timeout E transitions.timeout
     (destinos distintos, permitidos no backend legado) emitia DUAS edges com o
     MESMO sourceHandle "timeout" — reconectar a aresta de transitions escrevia
     on_timeout. Idem transitions.out vs transitions["opt:out"]: ambos viravam
     o handle "opt:out". Contrato novo: choiceHandle é injetivo — key que casa
     com (opt:)*(out|timeout|invalid) ganha prefixo "opt:" (UMA vez); raw
     A/B/yes/no passa intocado; ids de edges e payload não mudam. */
  const DUP: FlowDefinition = definition({
    W: {
      kind: "wait_for_reply",
      timeout_minutes: 30,
      on_timeout: "T1",
      transitions: { timeout: "P2" },
      next: "M1",
    },
    T1: { kind: "message", message: "tempo", next: "F1" },
    P2: { kind: "message", message: "legado", next: "F1" },
    M1: { kind: "message", message: "ok", next: "F1" },
    F1: { kind: "final", message: "fim" },
  });

  it("on_timeout e transitions.timeout ganham handles distintos; ids de edge preservados", () => {
    const { edges } = graphFromDefinition(DUP);
    expect(edges.find((edge) => edge.id === "W:timeout")).toMatchObject({ source: "W", target: "T1", sourceHandle: "timeout" });
    expect(edges.find((edge) => edge.id === "W:opt:timeout")).toMatchObject({ source: "W", target: "P2", sourceHandle: "opt:timeout" });
    /* Injetivo: nenhum sourceHandle repete entre as edges da etapa. */
    const handles = edges.filter((edge) => edge.source === "W").map((edge) => edge.sourceHandle);
    expect(new Set(handles).size).toBe(handles.length);
    expect(handleIds(DUP.steps.W)).toEqual(["timeout", "invalid", "opt:timeout", "out"]);
  });

  it("reconectar/limpar a aresta de transitions escreve transitions.timeout; on_timeout fica intacto", () => {
    const repointed = setEdgeTarget(DUP, "W", "opt:timeout", "M1");
    expect(repointed.steps.W.transitions?.timeout).toBe("M1");
    expect(repointed.steps.W.on_timeout).toBe("T1");

    const cleared = setEdgeTarget(DUP, "W", "opt:timeout", null);
    expect(cleared.steps.W.transitions?.timeout).toBeUndefined();
    expect(cleared.steps.W.on_timeout).toBe("T1");

    /* Mutação independente: o handle dedicado segue escrevendo on_timeout. */
    const viaDedicated = setEdgeTarget(cleared, "W", "timeout", "P2");
    expect(viaDedicated.steps.W.on_timeout).toBe("P2");
    expect(viaDedicated.steps.W.next).toBe("M1");
  });

  it("colisão opt:out: transitions.out e transitions['opt:out'] ganham handles e mutações próprias", () => {
    const OUTS: FlowDefinition = definition({
      S: {
        kind: "options",
        question: "?",
        options: [{ value: "A" }],
        transitions: { out: "M1", "opt:out": "P2" },
        next: "I2",
      },
      P2: { kind: "message", message: "x", next: "M1" },
      I2: { kind: "message", message: "y", next: "M1" },
      M1: { kind: "final", message: "fim" },
    });
    const { edges } = graphFromDefinition(OUTS);
    expect(edges.find((edge) => edge.id === "S:opt:out")).toMatchObject({ target: "M1", sourceHandle: "opt:out" });
    expect(edges.find((edge) => edge.id === "S:opt:opt:out")).toMatchObject({ target: "P2", sourceHandle: "opt:opt:out" });
    expect(handleIds(OUTS.steps.S)).toEqual(["A", "opt:out", "opt:opt:out", "out"]);

    const viaOut = setEdgeTarget(OUTS, "S", "opt:out", "I2");
    expect(viaOut.steps.S.transitions?.out).toBe("I2");
    expect(viaOut.steps.S.transitions?.["opt:out"]).toBe("P2");

    const viaOptOptOut = setEdgeTarget(OUTS, "S", "opt:opt:out", "M1");
    expect(viaOptOptOut.steps.S.transitions?.["opt:out"]).toBe("M1");
    expect(viaOptOptOut.steps.S.transitions?.out).toBe("M1");
  });

  it("escolhas comuns (raw A/yes/Sim e opt: solto) passam intocadas; payload não é mutado", () => {
    const step: FlowStep = {
      kind: "options",
      question: "?",
      options: [{ value: "A" }, { value: "yes" }, { value: "opt:timeout" }, { value: "out" }],
      transitions: { A: "M1", yes: "M1", "opt:timeout": "M1", out: "M1", timeout: "P2" },
      next: "P2",
    };
    expect(handleIds(step)).toEqual(["A", "yes", "opt:opt:timeout", "opt:out", "opt:timeout", "out"]);
    const before = JSON.parse(JSON.stringify(step));
    stepHandles(step);
    expect(step).toEqual(before);
  });
});

describe("setEdgeTarget: validação e sem mutação em entrada inválida", () => {
  it("TRIGGER_ID + handle 'out' altera definition.start", () => {
    const moved = setEdgeTarget(BASE, TRIGGER_ID, "out", "M1");
    expect(moved.start).toBe("M1");
    expect(moved.steps.P2.on_timeout).toBe("T1");
  });

  it("gatilho com handle errado, sem alvo ou alvo inexistente devolve a mesma referência", () => {
    expect(setEdgeTarget(BASE, TRIGGER_ID, "timeout", "M1")).toBe(BASE);
    expect(setEdgeTarget(BASE, TRIGGER_ID, "out", null)).toBe(BASE);
    expect(setEdgeTarget(BASE, TRIGGER_ID, "out", "fantasma")).toBe(BASE);
  });

  it("handle arbitrário NÃO escreve transitions — devolve sem mutação", () => {
    expect(setEdgeTarget(BASE, "P1", "handle-inventado", "M1")).toBe(BASE);
    expect(setEdgeTarget(BASE, "P1", "handle-inventado", null)).toBe(BASE);
  });

  it("self-loop não é criado; origem inexistente e destino inexistente idem", () => {
    expect(setEdgeTarget(BASE, "P1", "out", "P1")).toBe(BASE);
    expect(setEdgeTarget(BASE, "fantasma", "out", "M1")).toBe(BASE);
    expect(setEdgeTarget(BASE, "P1", "out", "fantasma")).toBe(BASE);
  });

  it("terminadores não originam conexão (nenhum handle)", () => {
    expect(setEdgeTarget(BASE, "F1", "out", "M1")).toBe(BASE);
    expect(setEdgeTarget(BASE, "FZ", "out", "M1")).toBe(BASE);
  });

  it("handles válidos continuam escrevendo: out→next, timeout→on_timeout, invalid→on_invalid_reply, escolha→transitions", () => {
    const viaOut = setEdgeTarget(BASE, "P1", "out", "T1");
    expect(viaOut.steps.P1.next).toBe("T1");
    expect(viaOut.steps.P1.transitions?.A).toBe("M1");

    const viaTimeout = setEdgeTarget(BASE, "P2", "timeout", "I1");
    expect(viaTimeout.steps.P2.on_timeout).toBe("I1");
    expect(viaTimeout.steps.P2.on_invalid_reply).toBe("I1");

    const viaInvalid = setEdgeTarget(BASE, "P2", "invalid", "T1");
    expect(viaInvalid.steps.P2.on_invalid_reply).toBe("T1");
    expect(viaInvalid.steps.P2.on_timeout).toBe("T1");

    const viaChoice = setEdgeTarget(BASE, "P1", "A", "T1");
    expect(viaChoice.steps.P1.transitions?.A).toBe("T1");
  });

  it("limpar (target null) apaga só o campo do handle e preserva os demais links", () => {
    const clearedNext = setEdgeTarget(BASE, "P1", "out", null);
    expect(clearedNext.steps.P1.next).toBeUndefined();
    expect(clearedNext.steps.P1.transitions?.A).toBe("M1");

    const clearedTimeout = setEdgeTarget(BASE, "P2", "timeout", null);
    expect(clearedTimeout.steps.P2.on_timeout).toBeUndefined();
    expect(clearedTimeout.steps.P2.on_invalid_reply).toBe("I1");
    expect(clearedTimeout.steps.P2.next).toBe("M1");

    const clearedInvalid = setEdgeTarget(BASE, "P2", "invalid", null);
    expect(clearedInvalid.steps.P2.on_invalid_reply).toBeUndefined();
    expect(clearedInvalid.steps.P2.on_timeout).toBe("T1");
  });

  it("link legado (transitions sem opção correspondente) continua endereçável e removível", () => {
    const legacy: FlowDefinition = definition({
      S: { kind: "options", question: "?", options: [{ value: "A" }], transitions: { Z: "M1" }, next: "P2" },
      P2: { kind: "message", message: "x", next: "M1" },
      M1: { kind: "final", message: "fim" },
    });
    const repointed = setEdgeTarget(legacy, "S", "Z", "P2");
    expect(repointed.steps.S.transitions?.Z).toBe("P2");
    const removed = setEdgeTarget(legacy, "S", "Z", null);
    expect(removed.steps.S.transitions?.Z).toBeUndefined();
    expect(removed.steps.S.next).toBe("P2");
  });

  it("ciclo maior (A→B→A) continua sendo criável — só self-loop direto é impedido", () => {
    const twoCycle = setEdgeTarget(BASE, "M1", "out", "P2");
    expect(twoCycle.steps.M1.next).toBe("P2");
  });
});

describe("handles para transitions legadas (key sem opção correspondente)", () => {
  /* Mesma shape do teste de mutação acima: transitions {Z} sem opção "Z".
     graphFromDefinition emite edge S:opt:Z para TODA key — sem handle, a aresta
     fica sem ponto de origem no DOM. */
  const LEGACY: FlowDefinition = definition({
    S: { kind: "options", question: "?", options: [{ value: "A" }], transitions: { Z: "M1" }, next: "P2" },
    P2: { kind: "message", message: "x", next: "M1" },
    M1: { kind: "final", message: "fim" },
  }, "S");

  it("stepHandles inclui a key legada 'Z' junto às choices e à Próxima (combo next default)", () => {
    expect(handleIds(LEGACY.steps.S)).toEqual(["A", "Z", "out"]);
  });

  it("edge S:opt:Z usa o mesmo sourceHandle presente em stepHandles; S:out intacta", () => {
    const { edges } = graphFromDefinition(LEGACY);
    const handles = new Set(handleIds(LEGACY.steps.S));
    const legacyEdge = edges.find((edge) => edge.id === "S:opt:Z");
    expect(legacyEdge).toMatchObject({ sourceHandle: "Z", target: "M1" });
    expect(handles.has(legacyEdge?.sourceHandle ?? "")).toBe(true);
    expect(edges.find((edge) => edge.id === "S:out")).toMatchObject({ sourceHandle: "out", target: "P2" });
  });

  it("toda edge emitida tem handle na etapa de origem; wait_for_reply separa keys legadas dos dedicados", () => {
    const mixed: FlowDefinition = definition({
      S: LEGACY.steps.S,
      W: {
        kind: "wait_for_reply",
        timeout_minutes: 30,
        on_timeout: "M1",
        transitions: { timeout: "P2", invalid: "P2" },
        next: "P2",
      },
      P2: { kind: "message", message: "x", next: "M1" },
      M1: { kind: "final", message: "fim" },
    }, "S");
    /* Keys timeout/invalid ganham handles opt:-prefixados — um handle por
       destino, sem colidir com os dedicados on_timeout/on_invalid_reply. */
    expect(handleIds(mixed.steps.W)).toEqual(["timeout", "invalid", "opt:timeout", "opt:invalid", "out"]);
    expect(new Set(handleIds(mixed.steps.W)).size).toBe(handleIds(mixed.steps.W).length);
    const { edges } = graphFromDefinition(mixed);
    for (const edge of edges) {
      if (edge.source === TRIGGER_ID) continue;
      expect(handleIds(mixed.steps[edge.source]), `edge ${edge.id}`).toContain(edge.sourceHandle);
    }
    expect(edges.find((edge) => edge.id === "W:timeout")?.target).toBe("M1");
    expect(edges.find((edge) => edge.id === "W:opt:timeout")?.target).toBe("P2");
  });

  it("roundtrip legado: ids de edges não mudam e o payload da definition não é mutado", () => {
    const before = JSON.parse(JSON.stringify(LEGACY)) as FlowDefinition;
    const { edges } = graphFromDefinition(LEGACY);
    expect(edges.map((edge) => edge.id)).toEqual(["__trigger__:out", "S:out", "S:opt:Z", "P2:out"]);
    stepHandles(LEGACY.steps.S);
    expect(LEGACY).toEqual(before);
  });
});

describe("layout: largura real do CSS e altura variável", () => {
  it("NODE_W acompanha o CSS (320px)", () => {
    expect(NODE_W).toBe(320);
  });

  it("altura estimada cresce com chips de opção, com opções que quebram linha e com erro", () => {
    const base = estimateNodeHeight(node());
    expect(estimateNodeHeight(node({ options: ["A", "B"] }))).toBeGreaterThan(base);
    expect(estimateNodeHeight(node({ options: Array.from({ length: 12 }, (_, index) => `opção bem comprida ${index}`) })))
      .toBeGreaterThan(estimateNodeHeight(node({ options: ["A", "B"] })));
    expect(estimateNodeHeight(node({ error: "Etapa precisa de destino" }))).toBeGreaterThan(base);
    expect(estimateNodeHeight(node({ options: ["A"] }))).toBe(estimateNodeHeight(node({ options: ["A", "B"] })));
  });

  it("layoutDefinition posiciona todos os nós consumindo a altura variável", () => {
    const positions = layoutDefinition(BASE);
    for (const id of ["__trigger__", "P1", "P2", "T1", "I1", "M1", "F1", "FZ"]) {
      expect(positions.get(id)).toBeDefined();
    }
    expect(positions.get("P1")).not.toEqual(positions.get("P2"));
  });
});

describe("opções duplicadas (legado do backend)", () => {
  /* Bug real: renomear o único botão "Opção 1" p/ "Opção 2" e clicar + gerava
     OUTRO "Opção 2" (o número vinha do comprimento, não do valor livre); o
     backend legado também guarda fluxos com value repetido — stepHandles
     emitia DOIS handles com o MESMO id (colisão de origem no React Flow). */
  it("um handle por valor único; o payload mantém as duplicatas do legado intactas", () => {
    const step: FlowStep = {
      kind: "interactive",
      interactive_type: "buttons",
      message: "Escolha:",
      options: [{ value: "Opção 2" }, { value: "Opção 2" }],
      next: "M1",
    };
    expect(stepHandles(step)).toEqual([
      { id: "Opção 2", label: "Opção 2" },
      { id: "out", label: "Próxima" },
    ]);
    expect(step.options).toEqual([{ value: "Opção 2" }, { value: "Opção 2" }]); // legado não é reescrito
  });

  it("mesma dedupe p/ kind options legado; nenhuma edge repetida no grafo", () => {
    const def = definition({
      S: { kind: "options", question: "?", options: [{ value: "A" }, { value: "A" }], transitions: { A: "M1" }, next: "P2" },
      P2: { kind: "message", message: "x", next: "M1" },
      M1: { kind: "final", message: "fim" },
    }, "S");
    expect(handleIds(def.steps.S)).toEqual(["A", "out"]);
    const { edges } = graphFromDefinition(def);
    expect(edges.filter((edge) => edge.source === "S").map((edge) => edge.id)).toEqual(["S:out", "S:opt:A"]);
  });
});
