import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PostSalesChecklist } from "../components/post-sales-checklist";
import { PostSalesSummaryStrip } from "../components/post-sales-summary";
import type { PostSaleChecklistEntry } from "../lib/post-sales";

const activeEntry: PostSaleChecklistEntry = {
  id: "entry-active",
  item_id: "item-active",
  description: "Oferecer treinamento da equipe",
  position: 0,
  is_active: true,
  item_archived_at: null,
  item_version: 1,
  result: "aceito",
  note: "Equipe confirmada",
  version: 3,
  updated_at: "2026-08-19T10:00:00.000Z",
  updated_by_name: "Ana Operadora"
};

describe("post-sales components", () => {
  it("renders all portfolio summary queues with an accessible definition list", () => {
    const html = renderToStaticMarkup(<PostSalesSummaryStrip summary={{
      active: 12,
      archived: 2,
      not_started: 3,
      in_progress: 4,
      complete: 5,
      overdue: 1,
      today: 2,
      upcoming: 6
    }} />);
    expect(html).toContain('aria-label="Resumo da carteira"');
    expect(html).toContain("Carteira ativa");
    expect(html).toContain("Atrasados");
    expect(html).toContain('data-tone="warn"');
  });

  it("keeps active answers editable and archived answers in read-only history", () => {
    const archivedEntry: PostSaleChecklistEntry = {
      ...activeEntry,
      id: "entry-archived",
      item_id: "item-archived",
      description: "Oferta histórica",
      is_active: false,
      item_archived_at: "2026-08-19T11:00:00.000Z",
      result: "recusado",
      note: "Cliente não quis"
    };
    const html = renderToStaticMarkup(
      <PostSalesChecklist entries={[activeEntry, archivedEntry]} errors={{ "entry-active": "Conflito recarregado" }} onSave={() => undefined} />
    );
    expect(html).toContain('aria-label="Checklist de pós-venda"');
    expect(html).toContain("Oferecer treinamento da equipe");
    expect(html).toContain("Atualizado por Ana Operadora");
    expect(html).toContain("Histórico arquivado (1)");
    expect(html).toContain("Oferta histórica");
    expect(html).toContain("Cliente não quis");
    expect(html).toContain('role="alert"');
  });

  it("renders an explicit first-use empty state", () => {
    const html = renderToStaticMarkup(<PostSalesChecklist entries={[]} onSave={() => undefined} />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Checklist ainda vazio");
    expect(html).toContain("Configurar checklist");
  });
});
