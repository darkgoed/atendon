import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A página já é coberta por testes de source-string (comments-ui-regression);
// render estático dela é pesado. Aqui apenas asserimos a integração dos cards
// R7 v6 (campos personalizados) e R3 v6 (notas com @menções) no detalhe.
const leadDetailSource = readFileSync(new URL("../app/contatos/[id]/page.tsx", import.meta.url), "utf8");

describe("lead detail integrates custom fields and notes cards", () => {
  it("renders LeadCustomFields immediately after LeadEventHistory in the main column", () => {
    expect(leadDetailSource).toContain('import { LeadCustomFields } from "@/components/lead-custom-fields"');
    const historyIndex = leadDetailSource.indexOf("<LeadEventHistory");
    const fieldsIndex = leadDetailSource.indexOf("<LeadCustomFields");
    expect(historyIndex).toBeGreaterThanOrEqual(0);
    expect(fieldsIndex).toBeGreaterThan(historyIndex);
    // "imediatamente após": entre os dois só cabe o fechamento do histórico.
    expect(fieldsIndex - historyIndex).toBeLessThan(200);
  });

  it("replaces the legacy follow-up notes card with the shared LeadNotes card", () => {
    expect(leadDetailSource).toContain('import { LeadNotes } from "@/components/lead-notes"');
    expect(leadDetailSource).toContain("<LeadNotes leadId={id} />");
    // O card antigo (form + lista sobre follow-up) saiu sem deixar morto código.
    expect(leadDetailSource).not.toContain("internal-notes-title");
    expect(leadDetailSource).not.toContain("addLeadNote");
    expect(leadDetailSource).not.toContain("followUpData.notas");
  });
});
