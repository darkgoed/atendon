// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { render, screen, within, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Estado determinístico: sem rede (api pendente) e sem sessão. Basta para
// verificar o contrato estrutural (cabeçalho renderiza, Shell ausente/presente).
vi.mock("@/lib/api", () => ({ api: () => new Promise(() => undefined) }));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => true }));
// Marcador: qualquer uso de Shell aparece como shell-marker no DOM.
vi.mock("@/components/shell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/shell")>();
  return { ...actual, Shell: ({ children }: { children?: ReactNode }) => <div data-testid="shell-marker">{children}</div> };
});

import Connection from "./page";
import { ConnectionSettingsContent } from "./settings-content";

describe("Conteúdo reutilizável de conexão (aninhamento /configuracoes/conexao)", () => {
  afterEach(cleanup);

  it("Content renderiza o cabeçalho sem Shell", () => {
    render(<ConnectionSettingsContent />);
    expect(screen.getByRole("heading", { name: "Conexão" })).toBeVisible();
    expect(screen.queryByTestId("shell-marker")).not.toBeInTheDocument();
  });

  it("página legada envolve o mesmo conteúdo em Shell", () => {
    render(<Connection />);
    const shell = screen.getByTestId("shell-marker");
    expect(within(shell).getByRole("heading", { name: "Conexão" })).toBeVisible();
  });
});
