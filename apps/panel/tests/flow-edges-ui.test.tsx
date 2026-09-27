// @vitest-environment jsdom
/* Handles e arestas do canvas de fluxo (UI real do FlowEditor):
   1. StepNode renderiza TODOS os handles de stepHandles (escolhas + out,
      timeout/invalid + out; final/finalize zero; trigger 1) — antes,
      timeout/invalid não tinham handle e a aresta ficava sem âncora;
   2. arestas out/timeout/invalid/trigger emitidas pelo modelo (o React Flow
      não renderiza edge elements sob jsdom — handleBounds irreal);
   3. painel: escolha literal "out" escreve transitions["out"] pelo handle
      "opt:out" (o "out" cru é o next reservado) e não toca next;
   4. painel: values reservados recursivos (timeout, opt:out) gravam
      transitions[value] via choiceHandle — next e demais destinos intactos. */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: mocks.api,
  ApiError: class ApiError extends Error {},
}));

import { FlowEditor } from "@/components/flow-editor/flow-editor";
import { graphFromDefinition, normalizeDefinition, type FlowDefinition } from "@/components/flow-editor/flow-model";

/* P1 options (2 escolhas + out) → W1 wait_for_reply (timeout/invalid/out) →
   E1 final (zero handles) / E2 finalize. */
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

/* Interactive com botão cujo valor literal é "out" (colide com o next). */
const INT: FlowDefinition = normalizeDefinition({
  start: "I1",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: ["robo"] },
  steps: {
    I1: {
      kind: "interactive",
      interactive_type: "buttons",
      message: "Escolha:",
      interactive_button_text: "Escolher",
      options: [{ value: "out" }, { value: "humano" }],
      next: "FZ2",
    },
    FZ1: { kind: "finalize", end_reason: "transferido_humano" },
    FZ2: { kind: "finalize", end_reason: "encerrado" },
  },
});

/* Interactive com values reservados RECURSIVOS: "timeout" tem handle
   "opt:timeout" e "opt:out" tem handle "opt:opt:out" (choiceHandle). */
const INT2: FlowDefinition = normalizeDefinition({
  start: "I2",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: ["robo"] },
  steps: {
    I2: {
      kind: "interactive",
      interactive_type: "buttons",
      message: "Escolha:",
      options: [{ value: "timeout" }, { value: "opt:out" }, { value: "humano" }],
      transitions: { "humano": "FZ1" },
      next: "FZ3",
    },
    FZ1: { kind: "finalize", end_reason: "transferido_humano" },
    FZ2: { kind: "finalize", end_reason: "encerrado" },
    FZ3: { kind: "finalize", end_reason: "padrao" },
  },
});

const baseProps = {
  flowId: "fluxo-edges",
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

function HarnessEditor({ initial, onDefinition }: { initial: FlowDefinition; onDefinition?: (next: FlowDefinition) => void }) {
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

/* Handles de SAÍDA (bottom) do nó: ids do atributo data (v12: data-handleid). */
function sourceHandleIds(container: HTMLElement, nodeId: string): string[] {
  return Array.from(container.querySelectorAll(`.react-flow__node[data-id="${nodeId}"] .react-flow__handle-bottom`))
    .map((el) => el.getAttribute("data-handleid") ?? el.getAttribute("data-id") ?? "");
}

afterEach(cleanup);

describe("handles e arestas do canvas de fluxo (UI)", () => {
  it("StepNode renderiza todos os handles de stepHandles; final/finalize zero; trigger 1", async () => {
    const { container } = render(<HarnessEditor initial={FIXTURE} />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());
    expect(sourceHandleIds(container, "__trigger__")).toEqual(["out"]);
    /* Escolhas têm handle com o valor CRU; só o literal "out" vira "opt:out". */
    expect(sourceHandleIds(container, "P1")).toEqual(["Ótica", "Outros", "out"]);
    expect(sourceHandleIds(container, "W1")).toEqual(["timeout", "invalid", "out"]);
    expect(sourceHandleIds(container, "E1")).toEqual([]);
    expect(sourceHandleIds(container, "E2")).toEqual([]);
    const timeoutHandle = Array.from(container.querySelectorAll('.react-flow__node[data-id="W1"] .react-flow__handle-bottom'))
      .find((el) => (el.getAttribute("data-handleid") ?? el.getAttribute("data-id")) === "timeout");
    expect(timeoutHandle).toHaveAttribute("title", "Tempo esgotado");
  });

  it("arestas out/timeout/invalid/trigger emitidas pelo modelo; container de edges no canvas", async () => {
    render(<HarnessEditor initial={FIXTURE} />);
    await waitFor(() => expect(document.querySelector(".react-flow__edges")).not.toBeNull());
    const { edges } = graphFromDefinition(FIXTURE);
    expect(edges.find((edge) => edge.source === "__trigger__")?.target).toBe("P1");
    expect(edges.find((edge) => edge.id === "P1:out")?.target).toBe("W1");
    expect(edges.find((edge) => edge.id === "P1:opt:Ótica")?.target).toBe("E1");
    expect(edges.find((edge) => edge.id === "W1:timeout")?.target).toBe("E2");
    expect(edges.find((edge) => edge.id === "W1:invalid")).toBeUndefined();
  });

  it("painel: escolha literal \"out\" escreve transitions[\"out\"] pelo handle opt:out, sem tocar next", () => {
    const spy = vi.fn();
    render(<HarnessEditor initial={INT} onDefinition={spy} />);
    fireEvent.click(screen.getByTestId("flow-node-I1"));
    fireEvent.change(screen.getByRole("combobox", { name: "Destino do botão out" }), { target: { value: "FZ1" } });
    const next = spy.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.I1.transitions?.out).toBe("FZ1");
    expect(next.steps.I1.next).toBe("FZ2");
  });

  it("painel: botões com values reservados (timeout/opt:out) gravam transitions[value]; next e demais destinos intactos", () => {
    const spy = vi.fn();
    render(<HarnessEditor initial={INT2} onDefinition={spy} />);
    fireEvent.click(screen.getByTestId("flow-node-I2"));

    fireEvent.change(screen.getByRole("combobox", { name: "Destino do botão timeout" }), { target: { value: "FZ1" } });
    expect(spy).toHaveBeenCalledTimes(1);
    let next = spy.mock.calls[0][0] as FlowDefinition;
    expect(next.steps.I2.transitions?.timeout).toBe("FZ1");
    expect(next.steps.I2.next).toBe("FZ3");
    expect(next.steps.I2.transitions?.humano).toBe("FZ1");

    fireEvent.change(screen.getByRole("combobox", { name: "Destino do botão opt:out" }), { target: { value: "FZ2" } });
    expect(spy).toHaveBeenCalledTimes(2);
    next = spy.mock.calls[1][0] as FlowDefinition;
    /* Única mutação: transitions[value] do botão; o resto da etapa fica intacto. */
    expect(next.steps.I2).toEqual({
      ...INT2.steps.I2,
      transitions: { "humano": "FZ1", "timeout": "FZ1", "opt:out": "FZ2" },
    });
  });

  it("modelo: edge da escolha literal out é id/sourceHandle opt:out → destino", () => {
    const comTransicao: FlowDefinition = {
      ...INT,
      steps: { ...INT.steps, I1: { ...INT.steps.I1, transitions: { out: "FZ1" } } },
    };
    const { edges } = graphFromDefinition(comTransicao);
    const outEdge = edges.find((edge) => edge.id === "I1:opt:out");
    expect(outEdge?.target).toBe("FZ1");
    expect(outEdge?.sourceHandle).toBe("opt:out");
  });
});

/* Interactive com UM botão — caminho exato do bug: renomear e clicar +. */
const INT3: FlowDefinition = normalizeDefinition({
  start: "I3",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: [] },
  steps: {
    I3: {
      kind: "interactive",
      interactive_type: "buttons",
      message: "Escolha:",
      options: [{ value: "Opção 1" }],
      next: "FZ3",
    },
    FZ3: { kind: "finalize", end_reason: "padrao" },
  },
});

/* Legado: o backend aceita fluxos com value repetido ("Opção 2" ×2). */
const DUPLEGACY: FlowDefinition = normalizeDefinition({
  start: "I4",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: [] },
  steps: {
    I4: {
      kind: "interactive",
      interactive_type: "buttons",
      message: "Escolha:",
      options: [{ value: "Opção 2" }, { value: "Opção 2" }],
      next: "FZ3",
    },
    FZ3: { kind: "finalize", end_reason: "padrao" },
  },
});

/* Duplicado com url e transitions — reparo por índice: o usuário precisa
   conseguir editar UMA linha gêmea para consertar o payload legado. */
const DUPEDIT: FlowDefinition = normalizeDefinition({
  start: "I5",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: [] },
  steps: {
    I5: {
      kind: "interactive",
      interactive_type: "buttons",
      message: "Escolha:",
      options: [
        { value: "Opção 2", url: "https://a.example.com" },
        { value: "Opção 2", url: "https://b.example.com" },
        { value: "Falar com humano" },
      ],
      transitions: { "Opção 2": "FZ3", "Falar com humano": "FZ3" },
      next: "FZ3",
    },
    FZ3: { kind: "finalize", end_reason: "padrao" },
  },
});

/* Opções genéricas (kind "options") com value repetido legado. */
const DUPGENERIC: FlowDefinition = normalizeDefinition({
  start: "P9",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: [] },
  steps: {
    P9: {
      kind: "options",
      question: "Duplicado?",
      field: "resposta",
      options: [{ value: "A" }, { value: "A" }],
      transitions: { A: "FZ3" },
      next: "FZ3",
    },
    FZ3: { kind: "finalize", end_reason: "padrao" },
  },
});

describe("opções duplicadas (add pós-rename e legado)", () => {
  it("add pós-rename: '+ botão' gera o próximo número LIVRE (não repete o renomeado)", () => {
    const spy = vi.fn();
    render(<HarnessEditor initial={INT3} onDefinition={spy} />);
    fireEvent.click(screen.getByTestId("flow-node-I3"));
    fireEvent.change(screen.getByRole("textbox", { name: "Texto do botão Opção 1" }), { target: { value: "Opção 2" } });
    fireEvent.click(screen.getByRole("button", { name: "+ botão" }));
    const next = spy.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.I3.options?.map((option) => option.value)).toEqual(["Opção 2", "Opção 3"]);
    expect(next.steps.I3.next).toBe("FZ3"); // roteamento intacto
  });

  it("legado com value repetido: chips ×2, painel ×2 e UM handle por valor (sem duplicate-key)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { container } = render(<HarnessEditor initial={DUPLEGACY} />);
      fireEvent.click(screen.getByTestId("flow-node-I4"));
      /* Handles: um por valor único — handles gêmeos colidem no React Flow. */
      expect(sourceHandleIds(container, "I4")).toEqual(["Opção 2", "out"]);
      /* Payload legado segue íntegro: 2 linhas de botão no painel + 2 chips no nó.
         Linhas gêmeas ganham índice no rótulo (caso único mantém o nome puro). */
      expect(screen.getAllByRole("textbox", { name: /Texto do botão Opção 2/ })).toHaveLength(2);
      expect(screen.getByRole("textbox", { name: "Texto do botão Opção 2 (linha 1)" })).toBeTruthy();
      expect(screen.getByRole("textbox", { name: "Texto do botão Opção 2 (linha 2)" })).toBeTruthy();
      expect(container.querySelectorAll('.react-flow__node[data-id="I4"] .react-flow__handle-bottom')).toHaveLength(2);
      const keyWarnings = spy.mock.calls
        .map((call) => call.map(String).join(" "))
        .filter((line) => /same key|keys should be unique|duplicate/i.test(line));
      expect(keyWarnings).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("legado duplicado: URL e renome por índice mudam EXATAMENTE a linha editada (transição copiada e mantida)", () => {
    const spy = vi.fn();
    render(<HarnessEditor initial={DUPEDIT} onDefinition={spy} />);
    fireEvent.click(screen.getByTestId("flow-node-I5"));
    const urlRow = (linha: number) =>
      screen.getByRole("textbox", { name: `URL do botão Opção 2 (linha ${linha})` }) as HTMLInputElement;

    /* URL por índice: só a linha 2 muda; a gêmea preserva a url. */
    fireEvent.change(urlRow(2), { target: { value: "https://c.example.com" } });
    let next = spy.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.I5.options?.[1]?.url).toBe("https://c.example.com");
    expect(next.steps.I5.options?.[0]?.url).toBe("https://a.example.com");

    /* Renome por índice: só a linha 1 vira "Pagamento"; destino copiado para o
       novo valor e a transição antiga fica (a linha 2 ainda é "Opção 2"). */
    fireEvent.change(screen.getByRole("textbox", { name: "Texto do botão Opção 2 (linha 1)" }), { target: { value: "Pagamento" } });
    next = spy.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.I5.options?.[0]).toEqual({ value: "Pagamento", url: "https://a.example.com" });
    expect(next.steps.I5.options?.[1]).toEqual({ value: "Opção 2", url: "https://c.example.com" });
    expect(next.steps.I5.transitions?.Pagamento).toBe("FZ3");
    expect(next.steps.I5.transitions?.["Opção 2"]).toBe("FZ3");
    expect(next.steps.I5.transitions?.["Falar com humano"]).toBe("FZ3");

    /* Sem criar duplicata nova: renomear para valor que já existe não altera. */
    const antes = spy.mock.calls.at(-1)?.[0] as FlowDefinition;
    fireEvent.change(screen.getByRole("textbox", { name: "Texto do botão Pagamento" }), { target: { value: "Opção 2" } });
    const depois = spy.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(depois.steps.I5).toEqual(antes.steps.I5);
  });

  it("legado duplicado: remover por índice tira UMA linha; transição sai só quando o valor desaparece", () => {
    const spy = vi.fn();
    render(<HarnessEditor initial={DUPEDIT} onDefinition={spy} />);
    fireEvent.click(screen.getByTestId("flow-node-I5"));
    fireEvent.click(screen.getByRole("button", { name: "Remover botão Opção 2 (linha 2)" }));
    let next = spy.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.I5.options?.map((option) => option.value)).toEqual(["Opção 2", "Falar com humano"]);
    expect(next.steps.I5.options?.[0]?.url).toBe("https://a.example.com");
    expect(next.steps.I5.transitions?.["Opção 2"]).toBe("FZ3"); // ainda há uma linha "Opção 2"
    fireEvent.click(screen.getByRole("button", { name: "Remover botão Opção 2" })); // agora única → nome puro
    next = spy.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.I5.options?.map((option) => option.value)).toEqual(["Falar com humano"]);
    expect(next.steps.I5.transitions?.["Opção 2"]).toBeUndefined();
    expect(next.steps.I5.transitions?.["Falar com humano"]).toBe("FZ3");
  });

  it("opções genéricas duplicadas: renome por índice muda só a linha (transição copiada e mantida)", () => {
    const spy = vi.fn();
    render(<HarnessEditor initial={DUPGENERIC} onDefinition={spy} />);
    fireEvent.click(screen.getByTestId("flow-node-P9"));
    fireEvent.change(screen.getByRole("textbox", { name: "Opção A (linha 1)" }), { target: { value: "B" } });
    const next = spy.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.P9.options?.map((option) => option.value)).toEqual(["B", "A"]);
    expect(next.steps.P9.transitions).toEqual({ B: "FZ3", A: "FZ3" });
  });
});
