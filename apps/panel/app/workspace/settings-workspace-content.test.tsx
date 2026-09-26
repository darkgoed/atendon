// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { render, screen, within, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Estado de carregamento determinístico: sem rede, sem sessão. Basta para
// verificar o contrato estrutural (cabeçalho renderiza, Shell ausente).
vi.mock("swr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("swr")>();
  return { ...actual, default: () => ({ data: undefined, error: undefined, mutate: () => Promise.resolve() }) };
});
// Marcador: qualquer uso de Shell aparece como shell-marker no DOM.
vi.mock("@/components/shell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/shell")>();
  return { ...actual, Shell: ({ children }: { children?: ReactNode }) => <div data-testid="shell-marker">{children}</div> };
});

import WorkspaceAuditPage from "./audit/page";
import { WorkspaceAuditContent } from "./audit/content";
import WorkspaceMembersPage from "./members/page";
import { WorkspaceMembersContent } from "./members/content";
import WorkspaceRolesPage from "./roles/page";
import { WorkspaceRolesContent } from "./roles/content";

const cases = [
  { name: "membros", heading: /Membros/, Content: WorkspaceMembersContent, Page: WorkspaceMembersPage },
  { name: "funções", heading: /Funções e permissões/, Content: WorkspaceRolesContent, Page: WorkspaceRolesPage },
  { name: "auditoria", heading: /Auditoria do workspace/, Content: WorkspaceAuditContent, Page: WorkspaceAuditPage }
];

describe("Conteúdos reutilizáveis de settings-workspace", () => {
  afterEach(cleanup);

  it.each(cases)("$name: Content renderiza o cabeçalho sem Shell", ({ heading, Content }) => {
    render(<Content />);
    expect(screen.getByRole("heading", { name: heading })).toBeVisible();
    expect(screen.queryByTestId("shell-marker")).not.toBeInTheDocument();
  });

  it.each(cases)("$name: página legada envolve o mesmo conteúdo em Shell", ({ heading, Page }) => {
    render(<Page />);
    const shell = screen.getByTestId("shell-marker");
    expect(within(shell).getByRole("heading", { name: heading })).toBeVisible();
  });
});
