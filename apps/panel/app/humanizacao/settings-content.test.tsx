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

import HumanizacaoPage from "./page";
import { HumanizationSettingsContent } from "./settings-content";

describe("Conteúdo reutilizável de humanização (aninhamento /configuracoes/humanizacao)", () => {
  afterEach(cleanup);

  it("Content renderiza o cabeçalho sem Shell", () => {
    render(<HumanizationSettingsContent />);
    expect(screen.getByRole("heading", { name: "Humanização" })).toBeVisible();
    expect(screen.queryByTestId("shell-marker")).not.toBeInTheDocument();
  });

  it("página legada envolve o mesmo conteúdo em Shell", () => {
    render(<HumanizacaoPage />);
    const shell = screen.getByTestId("shell-marker");
    expect(within(shell).getByRole("heading", { name: "Humanização" })).toBeVisible();
  });
});
