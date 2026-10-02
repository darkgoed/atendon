// @vitest-environment jsdom
/* C1-h: o nó interactive só entra na paleta quando interactiveSupported é
   true; fluxos existentes com nós interativos continuam no canvas. */
import "@testing-library/jest-dom/vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("@/lib/api", () => ({ api: mocks.api }));
vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "fluxo-gating" }) }));

import { FlowEditor } from "@/components/flow-editor/flow-editor";
import { starterDefinition, normalizeDefinition } from "@/components/flow-editor/flow-model";

afterEach(cleanup);

function renderEditor(interactiveSupported: boolean) {
  return render(
    <FlowEditor
      flowId="fluxo-gating"
      nome="Fluxo gating"
      ativo={false}
      definition={normalizeDefinition(starterDefinition())}
      canManage={true}
      saving={false}
      saved={false}
      serverError={null}
      trace={null}
      onNome={() => undefined}
      onDefinition={() => undefined}
      onSave={() => undefined}
      onSimulate={() => undefined}
      onCloseTrace={() => undefined}
      interactiveSupported={interactiveSupported}
    />
  );
}

describe("paleta — gating do nó interactive", () => {
  it("sem capability interativa a paleta não oferece o nó", async () => {
    renderEditor(false);
    await waitFor(() => expect(screen.getByLabelText("Adicionar etapa")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Interativo/ })).toBeNull();
  });

  it("com capability a paleta oferece o nó", async () => {
    renderEditor(true);
    await waitFor(() => expect(screen.getByLabelText("Adicionar etapa")).toBeInTheDocument());
    expect(screen.getAllByRole("button", { name: /Interativo/ }).length).toBeGreaterThan(0);
  });
});
