// @vitest-environment jsdom
// Ajuda contextual do pacote fluxos: HelpHint na lista (robô antes da IA),
// explicação do tipo de etapa no painel de propriedades do editor, gatilho,
// fluxo ativo e salvar/revisões no cabeçalho do editor, e histórico de versões.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    const user = userEvent.setup();
    render(<FluxosPage />);
    const hint = screen.getByText("Fluxos");
    expect(hint).toHaveAccessibleDescription(/Se nenhum fluxo for acionado, a IA assume/);
    expect(screen.queryByRole("button", { name: /^Ajuda:/ })).toBeNull();
    await user.hover(hint);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("O robô atende antes da IA quando o gatilho é acionado.");
  });

  it("editor: painel de propriedades explica o tipo da etapa (options)", async () => {
    const user = userEvent.setup();
    render(<FlowEditor {...editorProps} />);
    fireEvent.click(screen.getByTestId("flow-node-P1"));
    const panel = screen.getByRole("complementary", { name: "Propriedades da etapa" });
    const label = panel.querySelector<HTMLElement>('[aria-describedby][tabindex="0"]');
    expect(label).toHaveAccessibleDescription(/pergunta com opções fixas/i);
    expect(panel.querySelector('button[aria-label^="Ajuda:"]')).toBeNull();
    await user.hover(label!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/pergunta com opções fixas/i);
  });

  it("editor: nó do gatilho tem ajuda própria", async () => {
    const user = userEvent.setup();
    render(<FlowEditor {...editorProps} />);
    fireEvent.click(screen.getByTestId("flow-node-__trigger__"));
    const panel = screen.getByRole("complementary", { name: "Propriedades da etapa" });
    const label = panel.querySelector<HTMLElement>('[aria-describedby][tabindex="0"]');
    expect(label).toHaveAccessibleDescription(/define quando o robô assume a conversa/i);
    await user.hover(label!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/define quando o robô assume a conversa/i);
  });

  it("editor: cabeçalho ajuda fluxo ativo e salvar/revisões", async () => {
    const user = userEvent.setup();
    render(<FlowEditor {...editorProps} />);
    expect(screen.getByText("Inativo")).toHaveAccessibleDescription(/ativar e desativar são feitos na lista de fluxos/i);
    expect(screen.getByRole("button", { name: "Salvar" })).toHaveAccessibleDescription(/cada salvamento cria uma revisão do fluxo/i);
    await user.hover(screen.getByRole("button", { name: "Salvar" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Salvar cria uma revisão e protege contra sobrescritas.");
    expect(screen.queryByRole("button", { name: /^Ajuda:/ })).toBeNull();
  });

  it("histórico de versões: HelpHint explica snapshot e restauração", async () => {
    const user = userEvent.setup();
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
    expect(screen.getByText("Histórico de versões")).toHaveAccessibleDescription(/um snapshot é gravado a cada salvamento do fluxo/i);
    await user.hover(screen.getByText("Histórico de versões"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Restaurar cria uma versão sem apagar as anteriores.");
  });
});
