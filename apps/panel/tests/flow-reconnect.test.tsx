// @vitest-environment jsdom
/* onReconnect do editor de fluxo, com a semântica REAL do @xyflow/react v12
   (EdgeUpdateAnchors): arrastar a âncora ORIGEM inicia o arrasto no handle de
   destino antigo e o drop preenche connection.source — a connection é a
   aresta NOVA completa; arrastar a âncora DESTINO mantém a origem.
   Mock parcial SEM Proxy do @xyflow/react: espalha o módulo real e troca só
   o <ReactFlow> por um stub que captura as props — o onReconnect capturado é
   o handleReconnect real do componente (proxy com get genérico intercepta
   "then", o namespace vira thenable e a coleta do vitest trava).
   Cobertura:
   1. Reconectar a ORIGEM da aresta do GATILHO para outro passo é impossível
      no modelo (start obrigatório): setEdgeTarget(TRIGGER, "out", null) é
      no-op e a nova ligação criaria uma SEGUNDA aresta — bloqueado sem
      mutação (bug reproduzido: usuário via trigger→start + nova aresta);
   2. mudar só o DESTINO da aresta do gatilho reescreve start (única aresta);
   3. origem NORMAL reconectada para o gatilho move o start para o destino
      antigo e remove a aresta antiga numa única mutação;
   4. drop inválido (self-loop por destino, self-loop por origem e drop sem
      destino) não commita NEM apaga a aresta original;
   5. mudar o DESTINO de aresta normal move o campo sem apagar o resto do
      passo de origem. */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection, Edge } from "@xyflow/react";

/* jsdom não implementa ResizeObserver (React Flow mede nós na montagem). */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}

const captured = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  const ReactFlowStub = (props: { nodes?: Array<{ id: string }>; children?: ReactNode }) => {
    captured.last = props;
    return (
      <div data-testid="rf-stub">
        {(props.nodes ?? []).map((node) => (
          <div key={node.id} data-testid={`rf-node-${node.id}`} />
        ))}
      </div>
    );
  };
  return { ...actual, ReactFlow: ReactFlowStub as unknown as typeof actual.ReactFlow };
});

import { FlowEditor } from "@/components/flow-editor/flow-editor";
import { normalizeDefinition, TRIGGER_ID, type FlowDefinition } from "@/components/flow-editor/flow-model";

/* P1 options (Ótica→E1, next→W1) → W1 wait_for_reply (timeout→E2, next→E1) →
   E1 final / E2 finalize. Arestas: __trigger__:out→P1, P1:opt:Ótica→E1,
   P1:out→W1, W1:timeout→E2, W1:out→E1. */
const FIXTURE: FlowDefinition = normalizeDefinition({
  start: "P1",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: ["oi"] },
  steps: {
    P1: {
      kind: "options",
      question: "Qual o nicho?",
      field: "nicho",
      options: [{ value: "Ótica" }, { value: "Outros" }],
      transitions: { "Ótica": "E1" },
      next: "W1",
    },
    W1: { kind: "wait_for_reply", timeout_minutes: 30, on_timeout: "E2", next: "E1", variable_name: "resposta" },
    E1: { kind: "final", message: "Até logo!" },
    E2: { kind: "finalize", end_reason: "sem_resposta" },
  },
});

const baseProps = {
  flowId: "fluxo-reconnect",
  nome: "Fluxo de teste",
  ativo: false,
  canManage: true,
  saving: false,
  saved: false,
  serverError: null,
  trace: null,
  onNome: () => {},
  onSave: () => {},
  onSimulate: () => {},
  onCloseTrace: () => {},
};

function Harness({ initial, onDefinition }: { initial: FlowDefinition; onDefinition?: (next: FlowDefinition) => void }) {
  const [definition, setDefinition] = useState(initial);
  return (
    <FlowEditor
      {...baseProps}
      definition={definition}
      onDefinition={(next: FlowDefinition) => {
        onDefinition?.(next);
        setDefinition(next);
      }}
    />
  );
}

/** Props capturadas no último render do <ReactFlow> stub. */
function flowProps(): { onReconnect: (oldEdge: Edge, connection: Connection) => void } & Record<string, unknown> {
  if (!captured.last) throw new Error("ReactFlow não montou");
  return captured.last as { onReconnect: (oldEdge: Edge, connection: Connection) => void } & Record<string, unknown>;
}

/** Aresta do grafo (ids do graphFromDefinition; targetHandle não emitido). */
function edgeOf(id: string, source: string, sourceHandle: string, target: string): Edge {
  return { id, source, sourceHandle, target, targetHandle: null };
}

afterEach(cleanup);

describe("reconexão de arestas do editor de fluxo (onReconnect real)", () => {
  it("bloqueia reconexão da ORIGEM da aresta do gatilho para outro passo, sem duplicar", async () => {
    const spy = vi.fn();
    render(<Harness initial={FIXTURE} onDefinition={spy} />);
    await screen.findByTestId(`rf-node-${TRIGGER_ID}`);

    /* Arrastar a âncora ORIGEM da aresta __trigger__:out→P1 e soltar no
       "out" de W1: a aresta do gatilho (start) não pode ser removida, então
       NADA muda — nem a aresta antiga sai, nem uma nova entra. */
    act(() => {
      flowProps().onReconnect(edgeOf("__trigger__:out", TRIGGER_ID, "out", "P1"), {
        source: "W1",
        sourceHandle: "out",
        target: "P1",
        targetHandle: null,
      });
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("aresta do gatilho: mudar só o DESTINO reescreve start numa única aresta", async () => {
    const spy = vi.fn();
    render(<Harness initial={FIXTURE} onDefinition={spy} />);
    await screen.findByTestId(`rf-node-${TRIGGER_ID}`);

    /* Arrastar a âncora DESTINO da aresta do gatilho para W1: start vira W1
       (setEdgeTarget reescreve definition.start), steps intocados. */
    act(() => {
      flowProps().onReconnect(edgeOf("__trigger__:out", TRIGGER_ID, "out", "P1"), {
        source: TRIGGER_ID,
        sourceHandle: "out",
        target: "W1",
        targetHandle: null,
      });
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const next = spy.mock.calls[0][0] as FlowDefinition;
    expect(next.start).toBe("W1");
    expect(next.steps).toEqual(FIXTURE.steps);
  });

  it("origem NORMAL reconectada para o gatilho: start vai ao destino antigo e a aresta antiga sai", async () => {
    const spy = vi.fn();
    render(<Harness initial={FIXTURE} onDefinition={spy} />);
    await screen.findByTestId(`rf-node-${TRIGGER_ID}`);

    /* Arrastar a âncora ORIGEM da aresta W1:out→E1 e soltar no "out" do
       gatilho: a etapa E1 vira start e a ligação W1:out some (uma única
       mutação — sem aresta antiga órfã nem duplicata). */
    act(() => {
      flowProps().onReconnect(edgeOf("W1:out", "W1", "out", "E1"), {
        source: TRIGGER_ID,
        sourceHandle: "out",
        target: "E1",
        targetHandle: null,
      });
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const next = spy.mock.calls[0][0] as FlowDefinition;
    expect(next.start).toBe("E1");
    expect(next.steps.W1).not.toHaveProperty("next");
    expect(next.steps.W1.on_timeout).toBe("E2");
  });

  it("drop inválido não commita nem apaga a aresta original", async () => {
    const spy = vi.fn();
    render(<Harness initial={FIXTURE} onDefinition={spy} />);
    await screen.findByTestId(`rf-node-${TRIGGER_ID}`);
    const p1outW1 = edgeOf("P1:out", "P1", "out", "W1");

    /* Self-loop por DESTINO (voltar em P1): setEdgeTarget recusa self-loop
       novo — nada muda e a aresta original P1:out→W1 fica. */
    act(() => {
      flowProps().onReconnect(p1outW1, { source: "P1", sourceHandle: "out", target: "P1", targetHandle: null });
    });
    expect(spy).not.toHaveBeenCalled();

    /* Self-loop por ORIGEM (soltar a âncora origem no próprio "out" de W1):
       o ramo de rewire remove a aresta antiga e a nova ligação é no-op —
       o guard impede o commit e a aresta original permanece. */
    act(() => {
      flowProps().onReconnect(p1outW1, { source: "W1", sourceHandle: "out", target: "W1", targetHandle: null });
    });
    expect(spy).not.toHaveBeenCalled();

    /* Drop sem destino: o React Flow v12 só chama onReconnect em conexão
       completa (target nunca é null no contrato do callback — o tipo exige
       cast); o guard do handleReconnect é defesa. */
    const semDestino = { source: "W1", sourceHandle: "out", target: null, targetHandle: null } as unknown as Connection;
    act(() => {
      flowProps().onReconnect(p1outW1, semDestino);
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("mudar o DESTINO de aresta normal move o campo sem apagar o passo de origem", async () => {
    const spy = vi.fn();
    render(<Harness initial={FIXTURE} onDefinition={spy} />);
    await screen.findByTestId(`rf-node-${TRIGGER_ID}`);

    /* Arrastar a âncora DESTINO da aresta P1:out→W1 para E2: só o "next" de
       P1 muda; transitions e o resto do passo ficam intactos. */
    act(() => {
      flowProps().onReconnect(edgeOf("P1:out", "P1", "out", "W1"), {
        source: "P1",
        sourceHandle: "out",
        target: "E2",
        targetHandle: null,
      });
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const next = spy.mock.calls[0][0] as FlowDefinition;
    expect(next.steps.P1.next).toBe("E2");
    expect(next.steps.P1.transitions).toEqual({ "Ótica": "E1" });
    expect(next.steps.W1).toEqual(FIXTURE.steps.W1);
  });
});
