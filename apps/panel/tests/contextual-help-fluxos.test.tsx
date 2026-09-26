// @vitest-environment jsdom
// Ajuda contextual do pacote fluxos: HelpHint na lista (robô antes da IA),
// explicação do tipo de etapa no painel de propriedades do editor, gatilho,
// fluxo ativo e salvar/revisões no cabeçalho do editor, e histórico de versões.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/* Radix Popover/Popper medem o balão com ResizeObserver, ausente no jsdom
   (mesmo stub do flow-editor.test.tsx e dos primitives). */
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
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body?: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  },
}));

vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => true }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "fluxo-teste" }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("swr", () => ({ default: () => ({ data: undefined, error: undefined, isLoading: false, mutate: vi.fn() }) }));

import FluxosPage from "@/app/fluxos/page";
import { FlowEditor } from "@/components/flow-editor/flow-editor";
import { FlowHistory } from "@/components/flow-editor/flow-history";
import { normalizeDefinition, type FlowDefinition } from "@/components/flow-editor/flow-model";

const FIXTURE: FlowDefinition = normalizeDefinition({
  start: "P1",
  origem: "facebook",
  triggers: { ctwa: false, session_ids: [], keywords: ["oi"] },
  steps: {
    P1: {
      kind: "options",
      question: "Qual é o seu nicho?",
      field: "nicho",
      options: [{ value: "Ótica" }, { value: "Outros" }],
      transitions: { "Ótica": "E1" },
      next: "E1",
    },
    E1: { kind: "final", message: "Perfeito! Em breve falamos com você." },
  },
});

const editorProps = {
  flowId: "fluxo-teste",
  nome: "Fluxo de teste",
  ativo: false,
  definition: FIXTURE,
  canManage: true,
  saving: false,
  saved: false,
  saveState: "idle" as const,
  serverError: null,
  trace: null,
  conflict: null,
  onNome: () => {},
  onDefinition: () => {},
  onSave: () => {},
  onSimulate: () => {},
  onCloseTrace: () => {},
  onReload: () => {},
  onOpenHistory: () => {},
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ajuda contextual — pacote fluxos", () => {
  it("lista de fluxos: HelpHint do cabeçalho abre e explica robô antes da IA", async () => {
    render(<FluxosPage />);
    const hint = screen.getByRole("button", { name: "Ajuda: Fluxos" });
    fireEvent.click(hint);
    expect(await screen.findByText(/o fluxo é o robô do atendimento/i)).toBeInTheDocument();
    expect(await screen.findByText(/a IA assume/i)).toBeInTheDocument();
  });

  it("editor: painel de propriedades explica o tipo da etapa (options)", () => {
    render(<FlowEditor {...editorProps} />);
    fireEvent.click(screen.getByTestId("flow-node-P1"));
    const panel = screen.getByRole("complementary", { name: "Propriedades da etapa" });
    expect(panel.querySelector('button[aria-label="Ajuda: Opções"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ajuda: Opções" }));
    expect(screen.getByText(/pergunta com opções fixas/i)).toBeInTheDocument();
  });

  it("editor: nó do gatilho tem ajuda própria", () => {
    render(<FlowEditor {...editorProps} />);
    fireEvent.click(screen.getByTestId("flow-node-__trigger__"));
    const panel = screen.getByRole("complementary", { name: "Propriedades da etapa" });
    expect(panel.querySelector('button[aria-label="Ajuda: Gatilho"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ajuda: Gatilho" }));
    expect(screen.getByText(/define quando o robô assume a conversa/i)).toBeInTheDocument();
  });

  it("editor: cabeçalho ajuda fluxo ativo e salvar/revisões", () => {
    render(<FlowEditor {...editorProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Ajuda: fluxo ativo" }));
    expect(screen.getByText(/ativar e desativar são feitos na lista de fluxos/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ajuda: salvar e revisões" }));
    expect(screen.getByText(/cada salvamento cria uma revisão do fluxo/i)).toBeInTheDocument();
  });

  it("histórico de versões: HelpHint explica snapshot e restauração", async () => {
    mocks.api.mockResolvedValue({ versions: [], next_cursor: null });
    render(
      <FlowHistory
        flowId="fluxo-teste"
        revisao={3}
        canManage
        onRestored={() => {}}
        onConflict={() => {}}
        onClose={() => {}}
      />,
    );
    await screen.findByText(/nenhuma versão ainda/i);
    fireEvent.click(screen.getByRole("button", { name: "Ajuda: histórico de versões" }));
    expect(await screen.findByText(/um snapshot é gravado a cada salvamento do fluxo/i)).toBeInTheDocument();
  });
});
