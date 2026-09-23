import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import type { LeadFilters } from "../lib/lead-filters";
import { applyLeadSavedViewFilters, leadFiltersForSavedView } from "../lib/organization";

let bulkActions = "";
let leadTagPicker = "";
let pipelinePage = "";
let pipelineBoard = "";
let pipelineCard = "";
let pipelineDialog = "";
let pipelineSettings = "";
let savedViews = "";

beforeAll(async () => {
  [bulkActions, leadTagPicker, pipelinePage, pipelineBoard, pipelineCard, pipelineDialog, pipelineSettings, savedViews] = await Promise.all([
    readFile(new URL("../components/bulk-lead-actions.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/lead-tag-picker.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/pipeline/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/pipeline-board.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/pipeline-card.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/pipeline-transition-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/pipeline-settings.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/saved-views-control.tsx", import.meta.url), "utf8")
  ]);
});

const filters: LeadFilters = {
  status: "aprovado",
  busca: "Ana",
  unidade_id: "unidade-1",
  categoria_id: "",
  parceiro_id: "",
  estrelas: "4",
  fila_humana: "true",
  faturamento: "alto"
};

describe("case organization UI contracts", () => {
  it("serializes only the fixed lead saved-view schema and restores numeric stars", () => {
    expect(leadFiltersForSavedView(filters)).toEqual({
      status: "aprovado",
      busca: "Ana",
      unidade_id: "unidade-1",
      estrelas: 4
    });
    expect(applyLeadSavedViewFilters(filters, { status: "recusado", estrelas: 2 })).toMatchObject({
      status: "recusado",
      estrelas: "2",
      fila_humana: "",
      faturamento: ""
    });
  });

  it("uses the tag assignment contract and avoids duplicating read-only chips", () => {
    expect(leadTagPicker).toContain('method: active ? "DELETE" : "PUT"');
    expect(leadTagPicker).toContain("`/organization/leads/${leadId}/tags/${tag.id}`");
    expect(leadTagPicker).toContain("if (!canApply || organizationEnabled !== true) return null");
  });

  it("loads personal/shared views and only exposes deletion to an owner or publisher", () => {
    expect(savedViews).toContain("/organization/saved-views?resource=${resource}");
    expect(savedViews).toContain("canPublish || view.owner_user_id === session?.user.id");
    expect(savedViews).toContain("onApply(view.filters); close();");
  });

  it("keeps movement keyboard-accessible, announced and protected by optimistic concurrency", () => {
    expect(pipelineDialog).toContain("<ModalDialog");
    expect(pipelineDialog).toContain('describedBy="pipeline-transition-description"');
    expect(pipelineCard).toContain(">Mover</button>");
    expect(pipelineCard).not.toContain("md:hidden");
    expect(pipelineBoard).toContain('aria-live="polite"');
    expect(pipelineBoard).toContain("data-drop-state=");
    const initialToken = pipelinePage.indexOf("let expectedUpdatedAt = lead.atualizado_em;");
    const assignment = pipelinePage.indexOf("await api(`/scheduling/leads/${lead.id}/follow-up`");
    const revalidation = pipelinePage.indexOf("const refreshed = await api<{ lead?: { atualizado_em?: string } }>(`/scheduling/leads/${lead.id}`);");
    const refreshedToken = pipelinePage.indexOf("expectedUpdatedAt = refreshed.lead?.atualizado_em ?? expectedUpdatedAt;");
    const transitionPayload = pipelinePage.indexOf("buildPipelineTransitionPayload({ stage: persistenceStage, expectedUpdatedAt, commercial })");
    expect(initialToken).toBeGreaterThanOrEqual(0);
    expect(assignment).toBeGreaterThan(initialToken);
    expect(revalidation).toBeGreaterThan(assignment);
    expect(refreshedToken).toBeGreaterThan(revalidation);
    expect(transitionPayload).toBeGreaterThan(refreshedToken);
    expect(pipelinePage).toContain("allowedTransitions.has(`${sourceId}:${target.id}`)");
  });

  it("keeps the feature-flag fallback aligned with the ten canonical stages", () => {
    expect(pipelinePage).toContain("CANONICAL_PIPELINE_STATUSES.map");
    expect(pipelinePage).toContain("`fallback:${status}`");
    expect(pipelinePage).not.toContain('const legacyStatuses = ["em_qualificacao"');
  });

  it("constrains stage replacement and visual transitions to backend domain rules", () => {
    expect(pipelineSettings).toContain("technicalTransitions[stage.technical_status]?.includes(candidate.technical_status)");
    expect(pipelineSettings).toContain("candidate.technical_status === stage.technical_status");
    expect(pipelineSettings).toContain("needsReplacement = stage.is_default || (stage.lead_count ?? 0) > 0");
  });

  it("previews before applying, reuses one idempotency key, and offers timed undo", () => {
    expect(bulkActions).toContain('"/organization/bulk/preview"');
    expect(bulkActions).toContain("setApplyKey(result.valid ? randomUUID() : null)");
    expect(bulkActions).toContain("idempotency_key: applyKey");
    expect(bulkActions).toContain("Prévia validada para {preview.count} lead(s).");
    expect(bulkActions).toContain("`/organization/bulk/${applied.operation.id}/undo`");
    // DS v2: Desfazer virou IconButton — o texto antigo vive no label acessível.
    expect(bulkActions).toContain("label={`Desfazer · ${undoSeconds}s`}");
  });
});
