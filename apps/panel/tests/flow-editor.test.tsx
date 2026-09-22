// @vitest-environment jsdom
import { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/* jsdom não implementa ResizeObserver (React Flow mede nós na montagem) —
   stub mínimo antes de qualquer render. */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  flowId: "fluxo-teste",
}));

vi.mock("@/lib/api", () => ({
  api: mocks.api,
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("@/components/shell", () => ({
  Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock("@/lib/use-permission", () => ({
  usePermission: () => true,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: mocks.flowId }),
}));

/* Phosphor é pesado demais para os testes. Mock explícito por ícone —
   NÃO usar Proxy com get: () => stub: o proxy também intercepta "then",
   o namespace da mock vira um thenable que nunca resolve e o import do
   módulo trava a coleta inteira do vitest (hang sem saída). */
vi.mock("@phosphor-icons/react", () => ({
  ArrowsDownUp: () => null,
  ChatText: () => null,
  Clock: () => null,
  CursorClick: () => null,
  Eye: () => null,
  Flag: () => null,
  GitBranch: () => null,
  GitFork: () => null,
  Hourglass: () => null,
  Kanban: () => null,
  Keyboard: () => null,
  ListBullets: () => null,
  Plug: () => null,
  Power: () => null,
  Tag: () => null,
  UserFocus: () => null,
  WebhooksLogo: () => null,
  X: () => null,
}));

import { FlowEditor } from "@/components/flow-editor/flow-editor";
import {
  graphFromDefinition,
  layoutDefinition,
  newFlowId,
  newStepFor,
  normalizeDefinition,
  parseTrace,
  removeStep,
  setEdgeTarget,
  validateDefinition,
  type FlowDefinition,
  type PaletteItem,
} from "@/components/flow-editor/flow-model";
import FluxoEditorPage from "@/app/fluxos/[id]/page";

/* Definition fixo — válido no schema ATUAL do backend (kinds clássicos). */
const FIXTURE: FlowDefinition = normalizeDefinition({
  start: "P1",
  origem: "facebook",
  intro: "Olá! Vamos começar.",
  triggers: { ctwa: true, session_ids: [], keywords: ["oi"] },
  steps: {
    P1: {
      kind: "options",
      question: "Qual é o seu nicho?",
      field: "nicho",
      options: [{ value: "Ótica" }, { value: "Outros" }],
      transitions: { "Ótica": "E1" },
      next: "P2",
    },
    P2: {
      kind: "boolean",
      question: "Tem investimentos para crescer?",
      options: [{ value: "SIM" }, { value: "NÃO" }],
      transitions: { "SIM": "E1", "NÃO": "E2" },
    },
    E1: { kind: "final", message: "Perfeito! Em breve falamos com você." },
    E2: { kind: "final", message: "Obrigado pelo contato!" },
  },
});

/* Shape REAL do backend (flowStepSchema): delay=wait_minutes,
   wait_for_reply=timeout_minutes+on_timeout, action=action_type+tag_ids(uuid). */
const TAG_ID = "11111111-2222-3333-4444-555555555555";
const NEW_SHAPES: FlowDefinition = normalizeDefinition({
  start: "D1",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: ["oi"] },
  steps: {
    D1: { kind: "delay", wait_minutes: 5, next: "W1" },
    W1: { kind: "wait_for_reply", timeout_minutes: 30, on_timeout: "E1", next: "A1", variable_name: "resposta" },
    A1: { kind: "action", action_type: "tag_add", tag_ids: [TAG_ID], next: "E1" },
    E1: { kind: "final", message: "Feito!" },
  },
});

/* Kinds SPEC v7 (branch/finalize/interactive) — válido no zod do backend
   (superRefine flow.ts:200-242): branch exige yes/no, interactive buttons
   roteia por transitions[value] ou next, finalize exige end_reason. */
const V7_SHAPES: FlowDefinition = normalizeDefinition({
  start: "M1",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: ["robo"] },
  steps: {
    M1: { kind: "message", message: "Olá!", next: "B1" },
    B1: { kind: "branch", variable_name: "tipo", operator: "eq", value: "loja", transitions: { yes: "I1", no: "FZ1" } },
    I1: {
      kind: "interactive",
      interactive_type: "buttons",
      message: "Escolha:",
      interactive_button_text: "Escolher",
      options: [{ value: "Falar com humano" }],
      transitions: { "Falar com humano": "FZ2" },
    },
    FZ1: { kind: "finalize", end_reason: "perfil_servico" },
    FZ2: { kind: "finalize", end_reason: "transferido_humano" },
  },
});

const baseProps = {
  flowId: "fluxo-teste",
  nome: "Fluxo de teste",
  ativo: true,
  canManage: true,
  saving: false,
  saved: false,
  serverError: null,
  trace: null,
  onNome: () => {},
  onDefinition: () => {},
  onSave: () => {},
  onSimulate: () => {},
  onCloseTrace: () => {},
};

function editorProps(overrides: Partial<typeof baseProps> = {}) {
  return { ...baseProps, ...overrides };
}

/* O FlowEditor é controlado: quem aplica onDefinition é o pai (a página).
   O harness replica a página — guarda o definition em estado e registra
   as chamadas — para que edições reflitam no canvas como no app real. */
function InteractiveEditor({ initialDefinition, onDefinition }: { initialDefinition: FlowDefinition; onDefinition: (next: FlowDefinition) => void }) {
  const [definition, setDefinition] = useState(initialDefinition);
  return (
    <FlowEditor
      {...editorProps()}
      definition={definition}
      onDefinition={(next: FlowDefinition) => {
        onDefinition(next);
        setDefinition(next);
      }}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* O <label> do Field embute o hint — o nome acessível do campo inclui o
   texto do hint; este helper casa pelo texto do span.label (sem o hint). */
function panelField(panel: HTMLElement, labelText: string): HTMLElement {
  const label = Array.from(panel.querySelectorAll("label")).find(
    (candidate) => (candidate.querySelector("span.label")?.textContent ?? "").startsWith(labelText),
  );
  if (!label) throw new Error(`campo não encontrado no painel: ${labelText}`);
  return label.querySelector("input, textarea, select") as HTMLElement;
}

describe("modelo puro (flow-model)", () => {
  it("converte definition em nós/edges com handles por opção e gatilho→start", () => {
    const { nodes, edges } = graphFromDefinition(FIXTURE);
    expect(nodes.map((node) => node.id)).toEqual(["__trigger__", "P1", "P2", "E1", "E2"]);
    const triggerEdge = edges.find((edge) => edge.source === "__trigger__");
    expect(triggerEdge?.target).toBe("P1");
    // P1: aresta "out" (next) + aresta da opção "Ótica"
    expect(edges.find((edge) => edge.id === "P1:out")?.target).toBe("P2");
    expect(edges.find((edge) => edge.id === "P1:opt:Ótica")?.target).toBe("E1");
    expect(edges.find((edge) => edge.id === "P1:opt:Ótica")?.label).toBe("Ótica");
    // P2 boolean: handles SIM/NÃO rotulados Sim/Não
    expect(edges.find((edge) => edge.id === "P2:opt:SIM")?.label).toBe("Sim");
    expect(edges.find((edge) => edge.id === "P2:opt:NÃO")?.label).toBe("Não");
  });

  it("liga nós atualizando next (handle out) ou transitions (handle da opção)", () => {
    const linked = setEdgeTarget(FIXTURE, "P1", "out", "E1");
    expect(linked.steps.P1.next).toBe("E1");
    const branched = setEdgeTarget(FIXTURE, "P2", "SIM", "P1");
    expect(branched.steps.P2.transitions?.SIM).toBe("P1");
    const removed = setEdgeTarget(FIXTURE, "P2", "NÃO", null);
    expect(removed.steps.P2.transitions?.NÃO).toBeUndefined();
  });

  it("removeStep limpa next/transitions que apontavam para a etapa e reponta o start", () => {
    const next = removeStep(FIXTURE, "E1");
    expect(next?.steps.E1).toBeUndefined();
    expect(next?.start).toBe("P1");
    expect(next?.steps.P1.transitions?.["Ótica"]).toBeUndefined();
    expect(next?.steps.P2.transitions?.SIM).toBeUndefined();
    expect(next?.steps.P2.transitions?.NÃO).toBe("E2");
  });

  it("valida como o backend: start inexistente, final sem mensagem, opção sem destino", () => {
    expect(validateDefinition(FIXTURE)).toEqual([]);
    const broken: FlowDefinition = {
      ...FIXTURE,
      start: "fantasma",
      steps: { E1: { kind: "final" }, X1: { kind: "options", question: "?", options: [{ value: "A" }] } },
    };
    const messages = validateDefinition(broken).map((issue) => issue.message);
    expect(messages.some((message) => message.includes("gatilho"))).toBe(true);
    expect(messages.some((message) => message.includes("mensagem"))).toBe(true);
    expect(messages.some((message) => message.includes("Opção \"A\""))).toBe(true);
  });

  it("kinds novos nascem com o shape do backend em minutos", () => {
    const paletteItem = (id: PaletteItem["id"], kind: PaletteItem["kind"]): PaletteItem => ({ id, kind, label: id, hint: "", icon: "" });
    expect(newStepFor(paletteItem("delay", "delay"))).toEqual({ kind: "delay", wait_minutes: 5 });
    expect(newStepFor(paletteItem("wait_for_reply", "wait_for_reply"))).toEqual({ kind: "wait_for_reply", timeout_minutes: 30 });
    expect(newStepFor(paletteItem("tag_add", "action"))).toEqual({ kind: "action", action_type: "tag_add", tag_ids: [] });
    expect(newStepFor(paletteItem("stage_move", "action"))).toEqual({ kind: "action", action_type: "stage_move" });
    expect(newStepFor(paletteItem("webhook", "action"))).toEqual({ kind: "action", action_type: "webhook" });
  });

  it("validação client espelha o zod do backend nos kinds novos", () => {
    expect(validateDefinition(NEW_SHAPES)).toEqual([]);
    const broken: FlowDefinition = {
      ...FIXTURE,
      steps: {
        ...FIXTURE.steps,
        D1: { kind: "delay", wait_minutes: 2000, next: "E1" },
        W1: { kind: "wait_for_reply", next: "E1" },
        A1: { kind: "action", action_type: "webhook", webhook_url: "http://localhost/hook", next: "E1" },
        A2: { kind: "action", next: "E1" },
        A3: { kind: "action", action_type: "tag_add", tag_ids: ["nao-uuid"], next: "E1" },
      },
    };
    const messages = validateDefinition(broken).map((issue) => issue.message);
    expect(messages.some((message) => message.includes("wait_minutes (1-1440)"))).toBe(true);
    expect(messages.some((message) => message.includes("timeout_minutes (1-1440)"))).toBe(true);
    expect(messages.some((message) => message.includes("on_timeout"))).toBe(true);
    expect(messages.some((message) => message.includes("action_type"))).toBe(true);
    expect(messages.some((message) => message.includes("https://"))).toBe(true);
    expect(messages.some((message) => message.includes("tag_ids"))).toBe(true);
  });

  it("layout dagre posiciona todos os nós sem colisão de ids", () => {
    const positions = layoutDefinition(FIXTURE);
    expect(positions.get("__trigger__")).toBeDefined();
    expect(positions.get("E2")).toBeDefined();
    expect(positions.get("P1")).not.toEqual(positions.get("P2"));
  });

  it("parseTrace aceita snake_case e camelCase", () => {
    const trace = parseTrace({ steps: [{ node_id: "P1", label: "Opções", output: "oi" }], end_reason: "aguardando" });
    expect(trace.steps[0].nodeId).toBe("P1");
    expect(trace.endReason).toBe("aguardando");
    expect(parseTrace({ steps: [{ nodeId: "E1" }] }).steps[0].nodeId).toBe("E1");
    expect(parseTrace(null).steps).toEqual([]);
  });

  it("parseTrace lê o contrato REAL do backend (kind/result) — simulação deixa de aparecer vazia", () => {
    const trace = parseTrace({
      trace: [
        { node_id: "B1", kind: "branch", result: "tipo_negocio eq loja → yes", next: "M1" },
        { node_id: "M1", kind: "message", result: "Perfil de loja!", next: "F1" },
        { node_id: "F1", kind: "final", result: "Obrigado!" },
      ],
    });
    expect(trace.steps[0]).toMatchObject({ nodeId: "B1", label: "branch", output: "tipo_negocio eq loja → yes" });
    expect(trace.steps[2]).toMatchObject({ nodeId: "F1", label: "final", output: "Obrigado!" });
  });

  it("kinds SPEC v7 (branch/finalize/interactive) são válidos e salvos — sem falso-positivo de pergunta/opções", () => {
    const valid: FlowDefinition = normalizeDefinition({
      start: "M1",
      origem: "facebook",
      triggers: { ctwa: false, session_ids: [], keywords: ["robo"] },
      steps: {
        M1: { kind: "message", message: "Olá!", next: "B1" },
        B1: {
          kind: "branch",
          variable_name: "tipo",
          operator: "eq",
          value: "loja",
          transitions: { yes: "I1", no: "FZ1" },
        },
        I1: {
          kind: "interactive",
          interactive_type: "buttons",
          message: "Escolha:",
          options: [{ value: "Falar com humano" }],
          transitions: { "Falar com humano": "FZ2" },
        },
        FZ1: { kind: "finalize", end_reason: "perfil_servico" },
        FZ2: { kind: "finalize", end_reason: "transferido_humano" },
      },
    });
    expect(validateDefinition(valid)).toEqual([]);

    const { nodes, edges } = graphFromDefinition(valid);
    const branch = nodes.find((node) => node.id === "B1")!;
    expect(branch.options).toEqual(["yes", "no"]); // chips/handles Sim/Não no canvas
    expect(edges.find((edge) => edge.id === "B1:opt:yes")?.target).toBe("I1");
    const interactive = nodes.find((node) => node.id === "I1")!;
    expect(interactive.options).toEqual(["Falar com humano"]);
    expect(edges.find((edge) => edge.id === "I1:opt:Falar com humano")?.target).toBe("FZ2");

    const broken = normalizeDefinition({
      ...valid,
      steps: {
        ...valid.steps,
        B1: { kind: "branch", variable_name: "tipo", operator: "eq", transitions: { yes: "I1", no: "FZ1" } },
        FZ1: { kind: "finalize" },
        I1: { kind: "interactive", interactive_type: "buttons", options: [{ value: "A" }, { value: "B" }, { value: "C" }, { value: "D" }], next: "FZ2" },
      },
    });
    const messages = validateDefinition(broken).map((issue) => issue.message);
    expect(messages.some((message) => message.includes("precisa de value"))).toBe(true);
    expect(messages.some((message) => message.includes("end_reason"))).toBe(true);
    expect(messages.some((message) => message.includes("no máximo 3 botões"))).toBe(true);
  });

  it("removeStep limpa on_timeout/on_invalid_reply órfãos (antes bloqueava o save sem pista)", () => {
    const withWaits = normalizeDefinition({
      start: "W1",
      origem: "facebook",
      triggers: { ctwa: false, session_ids: [], keywords: ["oi"] },
      steps: {
        W1: { kind: "wait_for_reply", timeout_minutes: 30, on_timeout: "E1", on_invalid_reply: "E1", next: "E2" },
        E1: { kind: "finalize", end_reason: "timeout" },
        E2: { kind: "finalize", end_reason: "fim" },
      },
    });
    const next = removeStep(withWaits, "E1");
    expect(next?.steps.E1).toBeUndefined();
    expect(next?.steps.W1.on_timeout).toBeUndefined();
    expect(next?.steps.W1.on_invalid_reply).toBeUndefined();
    // Sem destino a validação agora aponta o CAMPO faltante (acionável), não
    // mais "aponta para etapa inexistente" sem pista de onde quebrou.
    const messages = validateDefinition(next!).map((issue) => issue.message);
    expect(messages.some((message) => message.includes("precisa de on_timeout"))).toBe(true);
    expect(messages.every((message) => !message.includes("inexistente"))).toBe(true);
  });

  it("id de fluxo novo é slug válido para o backend", () => {
    expect(newFlowId()).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});

describe("FlowEditor", () => {
  it("renderiza paleta por grupos, nós das etapas e arestas do definition fixo", () => {
    render(<FlowEditor {...editorProps()} definition={FIXTURE} />);
    expect(screen.getByText("Mensagens")).toBeInTheDocument();
    expect(screen.getByText("Controle")).toBeInTheDocument();
    expect(screen.getByText("Ações CRM")).toBeInTheDocument();
    // nós: gatilho + 4 etapas
    for (const id of ["__trigger__", "P1", "P2", "E1", "E2"]) {
      expect(screen.getByTestId(`flow-node-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("flow-node-P1").textContent).toContain("Qual é o seu nicho?");
    expect(screen.getByTestId("flow-node-P2").textContent).toContain("Sim");
    // arestas renderizadas pelo React Flow
    expect(document.querySelector(".react-flow__edges")).not.toBeNull();
  });

  it("mudar propriedade reflete no cartão do nó e chama onDefinition com a etapa alterada", () => {
    const onDefinition = vi.fn();
    render(<InteractiveEditor initialDefinition={FIXTURE} onDefinition={onDefinition} />);
    fireEvent.click(screen.getByTestId("flow-node-P1"));
    const panel = screen.getByRole("complementary", { name: "Propriedades da etapa" });
    const question = panel.querySelector("textarea") as HTMLTextAreaElement;
    expect(question.value).toBe("Qual é o seu nicho?");
    fireEvent.change(question, { target: { value: "Qual é o nicho da loja?" } });
    expect(screen.getByTestId("flow-node-P1").textContent).toContain("Qual é o nicho da loja?");
    expect(onDefinition).toHaveBeenCalled();
    const next = onDefinition.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.P1.question).toBe("Qual é o nicho da loja?");
    expect(next.steps.P1.next).toBe("P2"); // resto preservado — edição incremental
  });

  it("clique na paleta adiciona nó com id novo e abre o painel de propriedades", () => {
    const onDefinition = vi.fn();
    render(<InteractiveEditor initialDefinition={FIXTURE} onDefinition={onDefinition} />);
    fireEvent.click(screen.getByRole("button", { name: /Aguardar resposta/ }));
    const addedId = onDefinition.mock.calls.at(-1)?.[0].start === "P1"
      ? Object.keys(onDefinition.mock.calls.at(-1)?.[0].steps).find((id: string) => !FIXTURE.steps[id])
      : null;
    expect(addedId).toMatch(/^n_[0-9a-f]+$/);
    // NÓ EXISTENTE: ids do definition continuam os mesmos (upsert por id, sem recreate)
    expect(Object.keys(onDefinition.mock.calls.at(-1)?.[0].steps)).toEqual(
      expect.arrayContaining(["P1", "P2", "E1", "E2", addedId]),
    );
    expect(screen.getByRole("complementary", { name: "Propriedades da etapa" }).textContent).toContain("Aguardar resposta");
  });

  it("painel do wait_for_reply edita timeout_minutes e on_timeout (shape do backend)", () => {
    const onDefinition = vi.fn();
    render(<InteractiveEditor initialDefinition={NEW_SHAPES} onDefinition={onDefinition} />);
    fireEvent.click(screen.getByTestId("flow-node-W1"));
    const panel = screen.getByRole("complementary", { name: "Propriedades da etapa" });
    const timeout = panel.querySelector('input[type="number"]') as HTMLInputElement;
    expect(timeout.value).toBe("30");
    fireEvent.change(timeout, { target: { value: "45" } });
    let next = onDefinition.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.W1.timeout_minutes).toBe(45);
    const select = panel.querySelector("select") as HTMLSelectElement; // primeiro select = on_timeout
    fireEvent.change(select, { target: { value: "A1" } });
    next = onDefinition.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.W1.on_timeout).toBe("A1");
  });

  it("painel da ação edita tag_ids (um uuid por linha)", () => {
    const onDefinition = vi.fn();
    render(<InteractiveEditor initialDefinition={NEW_SHAPES} onDefinition={onDefinition} />);
    fireEvent.click(screen.getByTestId("flow-node-A1"));
    const panel = screen.getByRole("complementary", { name: "Propriedades da etapa" });
    const tags = panel.querySelector("textarea") as HTMLTextAreaElement;
    expect(tags.value).toBe(TAG_ID);
    fireEvent.change(tags, { target: { value: `${TAG_ID}\n66666666-2222-3333-4444-555555555555` } });
    const next = onDefinition.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.A1.tag_ids).toEqual([TAG_ID, "66666666-2222-3333-4444-555555555555"]);
    expect(next.steps.A1.action_type).toBe("tag_add");
  });

  it("mostra problemas de validação e o trace de simulação quando fornecidos", () => {
    const broken: FlowDefinition = { ...FIXTURE, steps: { ...FIXTURE.steps, E1: { kind: "final" } } };
    render(
      <FlowEditor
        {...editorProps()}
        definition={broken}
        trace={{ running: false, steps: [{ nodeId: "P1", label: "Opções", output: "Ótica" }], endReason: "aguardando" }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("problema(s)");
    const region = screen.getByRole("region", { name: "Resultado da simulação" });
    expect(region.textContent).toContain("P1");
    expect(region.textContent).toContain("aguardando");
  });
});

describe("forms por kind SPEC v7 (branch/finalize/interactive) — M2", () => {
  it("painel do branch: variable_name sanitiza, operator tem as 7 opções e value OCULTA+LIMPA em is_empty; saídas yes/no são selects", () => {
    const onDefinition = vi.fn();
    render(<InteractiveEditor initialDefinition={V7_SHAPES} onDefinition={onDefinition} />);
    fireEvent.click(screen.getByTestId("flow-node-B1"));
    const panel = screen.getByRole("complementary", { name: "Propriedades da etapa" });

    const variable = panelField(panel, "Variável") as HTMLInputElement;
    expect(variable.value).toBe("tipo");
    fireEvent.change(variable, { target: { value: "Tipo Loja" } });
    let next = onDefinition.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.B1.variable_name).toBe("tipoloja"); // regex ^[a-z0-9_]+$ (max 100)

    const operator = panelField(panel, "Operador") as HTMLSelectElement;
    expect(Array.from(operator.options).map((option) => option.value)).toEqual(
      ["eq", "neq", "contains", "not_contains", "starts_with", "is_empty", "is_not_empty"],
    );
    const value = panelField(panel, "Valor") as HTMLInputElement;
    expect(value.value).toBe("loja");
    expect((panelField(panel, "Saída Sim") as HTMLSelectElement).value).toBe("I1");
    expect((panelField(panel, "Saída Não") as HTMLSelectElement).value).toBe("FZ1");

    fireEvent.change(operator, { target: { value: "is_empty" } });
    next = onDefinition.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.B1.operator).toBe("is_empty");
    expect(next.steps.B1.value).toBeUndefined(); // value LIMPO quando o operador esconde o campo
    expect(screen.queryByLabelText(/^Valor/)).toBeNull(); // campo oculto (superRefine flow.ts:204-205)

    fireEvent.change(panelField(panel, "Saída Sim"), { target: { value: "FZ1" } });
    next = onDefinition.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.B1.transitions?.yes).toBe("FZ1");
    expect(next.steps.B1.transitions?.no).toBe("FZ1"); // saída "Não" preservada
  });

  it("painel do finalize edita end_reason (1-200)", () => {
    const onDefinition = vi.fn();
    render(<InteractiveEditor initialDefinition={V7_SHAPES} onDefinition={onDefinition} />);
    fireEvent.click(screen.getByTestId("flow-node-FZ1"));
    const panel = screen.getByRole("complementary", { name: "Propriedades da etapa" });
    const reason = panelField(panel, "Motivo do encerramento") as HTMLInputElement;
    expect(reason.value).toBe("perfil_servico");
    fireEvent.change(reason, { target: { value: "novo_motivo" } });
    const next = onDefinition.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.FZ1.end_reason).toBe("novo_motivo");
  });

  it("painel do interactive: mensagem, interactive_button_text e botão com URL http(s) ≤500 validada inline", () => {
    const onDefinition = vi.fn();
    render(<InteractiveEditor initialDefinition={V7_SHAPES} onDefinition={onDefinition} />);
    fireEvent.click(screen.getByTestId("flow-node-I1"));
    const panel = screen.getByRole("complementary", { name: "Propriedades da etapa" });

    const message = panelField(panel, "Mensagem") as HTMLTextAreaElement;
    expect(message.value).toBe("Escolha:");
    fireEvent.change(message, { target: { value: "Escolha uma opção:" } });
    let next = onDefinition.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.I1.message).toBe("Escolha uma opção:");

    const buttonText = panelField(panel, "Texto do botão") as HTMLInputElement;
    expect(buttonText.value).toBe("Escolher");
    fireEvent.change(buttonText, { target: { value: "Responder" } });
    next = onDefinition.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.I1.interactive_button_text).toBe("Responder");

    // renomear o botão preserva o roteamento (renameOption carrega transitions)
    const rowInput = panel.querySelector('input[aria-label="Texto do botão Falar com humano"]') as HTMLInputElement;
    fireEvent.change(rowInput, { target: { value: "Quero atendimento" } });
    next = onDefinition.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.I1.options?.[0]?.value).toBe("Quero atendimento");
    expect(next.steps.I1.transitions?.["Quero atendimento"]).toBe("FZ2");

    // URL inválida mostra erro acionável; válida some e grava
    const urlInput = () => panel.querySelector('input[aria-label="URL do botão Quero atendimento"]') as HTMLInputElement;
    fireEvent.change(urlInput(), { target: { value: "ftp://exemplo.com/x" } });
    expect(screen.getByText("URL precisa usar http(s)")).toBeTruthy();
    next = onDefinition.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.I1.options?.[0]?.url).toBe("ftp://exemplo.com/x");
    fireEvent.change(urlInput(), { target: { value: `https://exemplo.com/${"a".repeat(500)}` } });
    expect(screen.getByText("URL excede 500 caracteres")).toBeTruthy();
    fireEvent.change(urlInput(), { target: { value: "https://exemplo.com/promo" } });
    expect(screen.queryByText("URL precisa usar http(s)")).toBeNull();
    next = onDefinition.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.I1.options?.[0]?.url).toBe("https://exemplo.com/promo");
  });

  it("painel do interactive: roteamento por escolha (transitions[value]) + destino padrão (next); botões 1-3", () => {
    const onDefinition = vi.fn();
    render(<InteractiveEditor initialDefinition={V7_SHAPES} onDefinition={onDefinition} />);
    fireEvent.click(screen.getByTestId("flow-node-I1"));
    const panel = screen.getByRole("complementary", { name: "Propriedades da etapa" });

    // destino do botão gravado em transitions[value]
    const choiceTarget = panel.querySelector('select[aria-label="Destino do botão Falar com humano"]') as HTMLSelectElement;
    expect(choiceTarget.value).toBe("FZ2"); // herda o transitions do definition
    fireEvent.change(choiceTarget, { target: { value: "FZ1" } });
    let next = onDefinition.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.I1.transitions?.["Falar com humano"]).toBe("FZ1");

    // destino padrão gravado em next
    const nextTarget = panelField(panel, "Destino padrão") as HTMLSelectElement;
    expect(nextTarget.value).toBe("");
    fireEvent.change(nextTarget, { target: { value: "FZ2" } });
    next = onDefinition.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.I1.next).toBe("FZ2");
    expect(next.steps.I1.transitions?.["Falar com humano"]).toBe("FZ1"); // escolha específica intacta

    // adicionar botões até o teto de 3; remover volta a 1
    const addButton = () => screen.getByRole("button", { name: "+ botão" });
    fireEvent.click(addButton());
    next = onDefinition.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.I1.options).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Remover botão Opção 2" }));
    next = onDefinition.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.I1.options?.[0]?.value).toBe("Falar com humano");
    fireEvent.click(addButton());
    fireEvent.click(addButton());
    next = onDefinition.mock.calls.at(-1)?.[0] as FlowDefinition;
    expect(next.steps.I1.options).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "+ botão" })).toBeNull(); // máx 3 (flow.ts:223-224)
  });

  it("issue clicável seleciona/foca o nó no canvas (R4)", () => {
    const broken: FlowDefinition = {
      ...V7_SHAPES,
      steps: { ...V7_SHAPES.steps, B1: { kind: "branch", variable_name: "tipo", operator: "eq", transitions: { yes: "I1", no: "FZ1" } } },
    };
    render(<FlowEditor {...editorProps()} definition={broken} />);
    expect(screen.getByTestId("flow-node-B1").getAttribute("data-error")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("precisa de value");
    fireEvent.click(screen.getByTestId("flow-issue-B1"));
    expect(screen.getByTestId("flow-node-B1").getAttribute("data-selected")).toBe("true");
    expect(screen.getByRole("complementary", { name: "Propriedades da etapa" }).textContent).toContain("Condição");
  });

  it("modal 409 abre com Recarregar e botão de Histórico que chama onOpenHistory (não navega); fechar dispensa", () => {
    const onReload = vi.fn();
    const onOpenHistory = vi.fn();
    render(<FlowEditor {...editorProps()} definition={FIXTURE} conflict={{ revisao: 7 }} onReload={onReload} onOpenHistory={onOpenHistory} />);
    const dialog = screen.getByRole("dialog", { name: "Fluxo alterado por outro salvamento" });
    expect(dialog.textContent).toContain("revisão");
    expect(dialog.textContent).toContain("7");
    expect(screen.getByTestId("flow-conflict-reload").textContent).toContain("Recarregar");
    const historyButton = screen.getByTestId("flow-conflict-history");
    expect(historyButton.tagName).toBe("BUTTON"); // Histórico é drawer da página, não rota: nada de <a href>
    fireEvent.click(historyButton);
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("flow-conflict-reload"));
    expect(onReload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Continuar editando" }));
    expect(screen.queryByRole("dialog", { name: "Fluxo alterado por outro salvamento" })).toBeNull();
  });

  it("save bloqueado: branch sem valor não dispara PUT e o alert lista o problema acionável", async () => {
    mocks.flowId = "fluxo-branch-quebrado";
    const flowPath = `/qualification/flows/${mocks.flowId}`;
    const broken: FlowDefinition = normalizeDefinition({
      ...V7_SHAPES,
      steps: { ...V7_SHAPES.steps, B1: { kind: "branch", variable_name: "tipo", operator: "eq", transitions: { yes: "I1", no: "FZ1" } } },
    });
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === flowPath && (!init || !init.method)) {
        return Promise.resolve({ flow: { id: mocks.flowId, nome: "Fluxo quebrado", ativo: true, definition: broken, atualizado_em: null } });
      }
      return Promise.resolve({});
    });
    render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-B1")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("precisa de value"));
    expect(mocks.api.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    mocks.flowId = "fluxo-teste"; // restaura o default — os testes de página dependem dele
  });
});

describe("página do editor (/fluxos/:id)", () => {
  function mockGet() {
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/qualification/flows/fluxo-teste" && (!init || !init.method)) {
        return Promise.resolve({ flow: { id: "fluxo-teste", nome: "Fluxo de teste", ativo: true, definition: FIXTURE, atualizado_em: null } });
      }
      if (path === "/qualification/flows/fluxo-teste/simulate") {
        return Promise.resolve({ steps: [{ nodeId: "P1", label: "Opções" }, { nodeId: "P2", label: "Sim/Não" }], end_reason: "aguardando" });
      }
      return Promise.resolve({});
    });
  }

  it("salva via PUT com payload válido e simula exibindo o trace", async () => {
    mockGet();
    render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-P1")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => {
      expect(mocks.api.mock.calls.some(([path, init]) => path === "/qualification/flows/fluxo-teste" && init?.method === "PUT")).toBe(true);
    });
    const putCall = mocks.api.mock.calls.find(([path, init]) => path === "/qualification/flows/fluxo-teste" && init?.method === "PUT")!;
    const payload = JSON.parse(String(putCall[1].body));
    expect(payload.nome).toBe("Fluxo de teste");
    expect(payload.ativo).toBe(true);
    expect(payload.definition.start).toBe("P1");
    expect(payload.definition.steps.P1.options).toHaveLength(2);
    expect(payload.definition.steps.P1.transitions).toEqual({ "Ótica": "E1" });

    fireEvent.click(screen.getByRole("button", { name: "Simular" }));
    const region = await screen.findByRole("region", { name: "Resultado da simulação" });
    expect(region.textContent).toContain("P1");
    expect(region.textContent).toContain("aguardando");
  });

  it("PUT com kinds novos envia o shape real do backend (wait_minutes/timeout_minutes/action_type/tag_ids)", async () => {
    mocks.flowId = "fluxo-formas-novas"; // outra chave SWR — cache do teste anterior não vaza
    const flowPath = `/qualification/flows/${mocks.flowId}`;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === flowPath && (!init || !init.method)) {
        return Promise.resolve({ flow: { id: mocks.flowId, nome: "Fluxo de teste", ativo: true, definition: NEW_SHAPES, atualizado_em: null } });
      }
      return Promise.resolve({});
    });
    render(<FluxoEditorPage />);
    await waitFor(() => expect(screen.getByTestId("flow-node-D1")).toBeInTheDocument());
    expect(screen.getByTestId("flow-node-D1").textContent).toContain("Aguardar 5 min");

    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => {
      expect(mocks.api.mock.calls.some(([path, init]) => path === flowPath && init?.method === "PUT")).toBe(true);
    });
    const putCall = mocks.api.mock.calls.find(([path, init]) => path === flowPath && init?.method === "PUT")!;
    const payload = JSON.parse(String(putCall[1].body));
    const steps = payload.definition.steps;
    expect(steps.D1).toEqual({ kind: "delay", wait_minutes: 5, next: "W1" });
    expect(steps.W1).toEqual({ kind: "wait_for_reply", timeout_minutes: 30, on_timeout: "E1", next: "A1", variable_name: "resposta" });
    expect(steps.A1).toEqual({ kind: "action", action_type: "tag_add", tag_ids: [TAG_ID], next: "E1" });
    // Nenhum campo chutado do shape antigo no payload inteiro (chave "x":; não casa com o VALOR "action" de kind).
    expect(JSON.stringify(payload)).not.toMatch(/"(seconds|timeout_seconds|attendant|url|action)":/);
  });
});
