// @vitest-environment jsdom
/* Colocação de nós NOVOS no canvas (bug real em Playwright: dois cliques na
   paleta criavam dois nós na MESMA posição — um cobria o outro, o duplo
   clique na aresta falhava e o hit-test do handle arrastava o card errado;
   o fallback do rfNodes dava a MESMA coordenada {x:40, y:fallbackY+gap} a
   TODO id ausente do Map e handleAddNode nunca registrava posição):
   1. dois adds sequenciais (message e final) nascem em posições DISTINTAS,
      bounds sem sobreposição, nós existentes intactos;
   2. drag posterior move SÓ o nó arrastado e o add seguinte preserva a
      posição manual (arrasto não desvia);
   3. definition alterada por OUTRO caminho (parent edita direto): fallback
      do rfNodes dá coordenada distinta POR ID aos ids ainda sem posição,
      sem mover nós conhecidos. */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/* jsdom não implementa ResizeObserver (React Flow mede nós na montagem). */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}

/* Mock parcial SEM Proxy do @xyflow/react (padrão do flow-reconnect.test.tsx):
   espalha o módulo real e troca só o <ReactFlow> por um stub que captura as
   props — os nós capturados SÃO o rfNodes do componente, com position real. */
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
import {
  NODE_W,
  TRIGGER_H,
  TRIGGER_ID,
  estimateNodeHeight,
  normalizeDefinition,
  type FlowDefinition,
  type FlowStep,
} from "@/components/flow-editor/flow-model";

/* P1 options (Ótica→E1, next→W1) → W1 wait_for_reply (timeout→E2, next→E1) →
   E1 final / E2 finalize. Layout inicial vem do dagre (layoutDefinition). */
const BASE: FlowDefinition = normalizeDefinition({
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
  flowId: "fluxo-placement",
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

/* Parent que altera a definition POR OUTRO CAMINHO (dois passos diretos,
   sem passar pelo handleAddNode): exercita o fallback do rfNodes. */
function HarnessDirectAdd({
  initial,
  makeSteps,
}: {
  initial: FlowDefinition;
  makeSteps?: (current: FlowDefinition) => Record<string, FlowStep>;
}) {
  const [definition, setDefinition] = useState(initial);
  return (
    <>
      <button
        type="button"
        onClick={() => setDefinition((current) => ({
          ...current,
          steps: {
            ...current.steps,
            ...(makeSteps
              ? makeSteps(current)
              : {
                  X1: { kind: "message", message: "x1", next: current.start },
                  X2: { kind: "message", message: "x2", next: current.start },
                }),
          },
        }))}
      >
        adicionar via parent
      </button>
      <FlowEditor {...baseProps} definition={definition} onDefinition={setDefinition} />
    </>
  );
}

type XY = { x: number; y: number };
type PlacedNode = { id: string; position: XY; data: { nodeType: string; options: string[]; error?: string } };
type Rect = { x: number; y: number; w: number; h: number };

function flowNodes(): PlacedNode[] {
  if (!captured.last) throw new Error("ReactFlow não montou");
  return (captured.last.nodes ?? []) as unknown as PlacedNode[];
}

function flowProps(): Record<string, unknown> {
  if (!captured.last) throw new Error("ReactFlow não montou");
  return captured.last;
}

function drag(changes: unknown[]) {
  act(() => {
    (flowProps().onNodesChange as (input: unknown[]) => void)(changes);
  });
}

function positionsMap(): Map<string, XY> {
  return new Map(flowNodes().map((node) => [node.id, node.position]));
}

function rectOf(node: PlacedNode): Rect {
  return {
    x: node.position.x,
    y: node.position.y,
    w: NODE_W,
    h: node.data.nodeType === "trigger"
      ? TRIGGER_H
      : estimateNodeHeight({ options: node.data.options, error: node.data.error }),
  };
}

function sobreponhe(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const BASE_IDS = new Set(Object.keys(BASE.steps).concat(TRIGGER_ID));
const novos = () => flowNodes().filter((node) => !BASE_IDS.has(node.id));

afterEach(cleanup);

describe("colocação de nós novos no canvas (sem sobreposição)", () => {
  it("dois adds sequenciais (message e final) nascem em posições distintas e sem sobreposição", async () => {
    render(<Harness initial={BASE} />);
    await screen.findByTestId(`rf-node-${TRIGGER_ID}`);
    const antes = positionsMap();

    fireEvent.click(screen.getByRole("button", { name: /^Mensagem/ }));
    expect(novos()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /^Finalizar/ }));
    const [a, b] = novos();
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a.position).not.toEqual(b.position);
    expect(sobreponhe(rectOf(a), rectOf(b))).toBe(false);

    /* Nós existentes NÃO se moveram (posições manuais/dagre preservadas). */
    const depois = positionsMap();
    for (const [id, position] of antes) expect(depois.get(id)).toEqual(position);
  });

  it("drag posterior move só o nó arrastado; add seguinte preserva a posição manual", async () => {
    render(<Harness initial={BASE} />);
    await screen.findByTestId(`rf-node-${TRIGGER_ID}`);
    fireEvent.click(screen.getByRole("button", { name: /^Mensagem/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Finalizar/ }));
    const [a, b] = novos();

    /* Arrasto em duas fases (meio do drag com dragging, depois solta). */
    drag([{ id: a.id, type: "position", position: { x: 700, y: 900 }, dragging: true }]);
    drag([{ id: a.id, type: "position", position: { x: 777, y: 555 } }]);
    const aposDrag = positionsMap();
    expect(aposDrag.get(a.id)).toEqual({ x: 777, y: 555 });
    expect(aposDrag.get(b?.id ?? "")).toEqual(b?.position);

    /* Add seguinte: posição manual de `a` preservada e o novo nó não nasce
       em cima de NENHUM dos anteriores (a e b). */
    fireEvent.click(screen.getByRole("button", { name: /^Encerramento/ }));
    expect(novos()).toHaveLength(3);
    const c = novos().find((node) => node.id !== a.id && node.id !== b?.id);
    expect(c).toBeTruthy();
    if (!c || !b) return;
    expect(positionsMap().get(a.id)).toEqual({ x: 777, y: 555 });
    expect(c.position).not.toEqual(b.position);
    expect(sobreponhe(rectOf(c), rectOf(b))).toBe(false);
    expect(sobreponhe(rectOf(c), rectOf({ ...a, position: { x: 777, y: 555 } }))).toBe(false);
  });

  it("definition alterada por outro caminho: fallback dá coordenada distinta por id, sem mover conhecidos", async () => {
    render(<HarnessDirectAdd initial={BASE} />);
    await screen.findByTestId(`rf-node-${TRIGGER_ID}`);
    const antes = positionsMap();

    fireEvent.click(screen.getByRole("button", { name: "adicionar via parent" }));
    const pendentes = novos().map((node) => node.id).sort();
    expect(pendentes).toEqual(["X1", "X2"]);
    const [x1, x2] = novos();
    expect(x1 && x2).toBeTruthy();
    if (!x1 || !x2) return;
    expect(x1.position).not.toEqual(x2.position);
    expect(sobreponhe(rectOf(x1), rectOf(x2))).toBe(false);

    /* Estável entre renders e sem mover nós conhecidos. */
    const depois = positionsMap();
    for (const [id, position] of antes) expect(depois.get(id)).toEqual(position);
  });

  it("dois pendentes externos com o PRIMEIRO alto (> NODE_GAP_Y): bounds [y, y+altura] sem interseção", async () => {
    render(<HarnessDirectAdd initial={BASE} makeSteps={(current) => ({
      X1: {
        kind: "options",
        question: "Escolha",
        field: "escolha",
        options: Array.from({ length: 8 }, (_, i) => ({ value: `Opção longa ${i} com texto estendido` })),
        next: current.start,
      },
      X2: { kind: "message", message: "x2", next: current.start },
    })} />);
    await screen.findByTestId(`rf-node-${TRIGGER_ID}`);
    const antes = positionsMap();

    fireEvent.click(screen.getByRole("button", { name: "adicionar via parent" }));

    const placed = new Map(flowNodes().map((node) => [node.id, node]));
    const x1 = placed.get("X1");
    const x2 = placed.get("X2");
    expect(x1 && x2).toBeTruthy();
    if (!x1 || !x2) return;
    /* Premissa: X1 (1º no empilhamento por id) é MAIS alto que NODE_GAP_Y
       (140, não exportado do flow-editor) — sem acumular a altura do
       pending anterior, X2 nascia dentro do rect de X1. */
    expect(rectOf(x1).h).toBeGreaterThan(140);
    /* Ordem por id: X1 acima, e o topo de X2 NÃO entra no rect [y, y+altura] de X1. */
    expect(x1.position.y).toBeLessThan(x2.position.y);
    expect(x2.position.y).toBeGreaterThanOrEqual(x1.position.y + rectOf(x1).h);
    expect(sobreponhe(rectOf(x1), rectOf(x2))).toBe(false);
    expect(x1.position).not.toEqual(x2.position);

    /* Nós conhecidos NÃO se moveram (posições manuais/dagre preservadas). */
    const depois = positionsMap();
    for (const [id, position] of antes) expect(depois.get(id)).toEqual(position);
  });
});
