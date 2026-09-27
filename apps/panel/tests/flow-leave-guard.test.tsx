// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gauge, type Icon } from "@/components/icons";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}

// jsdom não implementa scrollIntoView (a paleta rola o item ativo para a vista).
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const mocks = vi.hoisted(() => ({ api: vi.fn(), push: vi.fn(), flowId: "guard-1" }));

vi.mock("@/lib/api", () => ({
  api: mocks.api,
  ApiError: class ApiError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
}));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => true }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: mocks.flowId }),
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => `/fluxos/${mocks.flowId}`,
}));

import { normalizeDefinition } from "@/components/flow-editor/flow-model";
import { CommandPalette, type PaletteItem } from "@/components/command-palette";
import FluxoEditorPage from "@/app/fluxos/[id]/page";

const DEFINITION = normalizeDefinition({
  start: "M1",
  origem: "facebook",
  triggers: { ctwa: true, session_ids: [], keywords: [] },
  steps: {
    M1: { kind: "message", message: "Olá!", next: "E1" },
    E1: { kind: "final", message: "Tchau!" },
  },
});

const ITEMS: PaletteItem[] = [{ href: "/agenda", label: "Agenda", group: "Atendimento", Icon: Gauge as Icon }];

let flowCounter = 0;
beforeEach(() => {
  flowCounter += 1;
  mocks.flowId = `guard-${flowCounter}`;
  mocks.api.mockImplementation((path: string) => {
    if (path === `/qualification/flows/${mocks.flowId}`) {
      return Promise.resolve({ flow: { id: mocks.flowId, nome: "Fluxo", ativo: false, definition: DEFINITION, revisao: 1, atualizado_em: null } });
    }
    return Promise.resolve({ q: "", page: { limit: 8, has_more: false, next_cursor: null } });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function renderDirtyEditor() {
  render(
    <>
      <FluxoEditorPage />
      <CommandPalette items={ITEMS} open onOpenChange={() => {}} />
    </>
  );
  const name = await screen.findByLabelText("Nome do fluxo");
  fireEvent.change(name, { target: { value: "Fluxo renomeado" } });
}

describe("editor de fluxo: alterações não salvas (C10)", () => {
  it("navegação pela paleta de comandos pede confirmação e é cancelável", async () => {
    await renderDirtyEditor();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("option", { name: /Agenda/ }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mocks.push).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("option", { name: /Agenda/ }));
    expect(mocks.push).toHaveBeenCalledWith("/agenda");
  });

  it("sem alterações a paleta navega sem perguntar", async () => {
    render(
      <>
        <FluxoEditorPage />
        <CommandPalette items={ITEMS} open onOpenChange={() => {}} />
      </>
    );
    await screen.findByLabelText("Nome do fluxo");
    const confirm = vi.spyOn(window, "confirm");
    fireEvent.click(screen.getByRole("option", { name: /Agenda/ }));
    expect(confirm).not.toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledWith("/agenda");
  });

  it("Voltar do navegador pede confirmação; cancelar mantém a página com o rascunho", async () => {
    await renderDirtyEditor();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const browserBack = async () => {
      await act(async () => {
        History.prototype.back.call(window.history);
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    };
    await browserBack();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Nome do fluxo")).toHaveValue("Fluxo renomeado");

    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    confirm.mockReturnValue(true);
    await browserBack();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(back).toHaveBeenCalledTimes(1);
  });
});
