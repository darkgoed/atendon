// @vitest-environment jsdom
// Importação por OPERADOR sem fields.manage: o backend ignora as colunas de
// e-mail/campos e devolve `warnings`; o resultado precisa mostrá-las (senão a
// omissão é silenciosa).
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children?: ReactNode }) => <main>{children}</main> }));
vi.mock("@/lib/use-permission", () => ({ usePermission: () => true }));
vi.mock("@/lib/lead-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lead-import")>();
  return {
    ...actual,
    fetchImportHistory: vi.fn(async () => ({ imports: [] })),
    submitImport: vi.fn(async () => ({
      imported: 1, updated: 0, skipped: 0, duplicates_flagged: 0, errors: [],
      warnings: ["Colunas de e-mail e campos personalizados foram ignoradas: exigem permissão para gerenciar campos"]
    }))
  };
});

import ImportContactsPage from "../app/contatos/importar/page";

afterEach(cleanup);

describe("/contatos/importar — avisos do backend", () => {
  it("mostra as colunas ignoradas por falta de permissão", async () => {
    const user = userEvent.setup();
    render(<ImportContactsPage />);
    const file = new File(["nome,telefone,email\nAna,21988887777,ana@exemplo.com\n"], "contatos.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("Arquivo CSV ou XLSX para importação"), file);
    await user.click(await screen.findByRole("button", { name: "Continuar para revisão" }));
    await user.click(await screen.findByRole("button", { name: /Importar 1 contato/ }));
    expect(await screen.findByText(/Colunas de e-mail e campos personalizados foram ignoradas/)).toBeInTheDocument();
  });
});
