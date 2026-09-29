import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

let component = "";
let overview = "";
let home = "";
let agent = "";
let agentContent = "";

beforeAll(async () => {
  [component, overview, home, agent, agentContent] = await Promise.all([
    readFile(new URL("../components/dashboard-widgets.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/dashboard-reference-overview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/agente/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/agente/settings-content.tsx", import.meta.url), "utf8")
  ]);
  // O corpo do agente vive em settings-content.tsx (aninhamento /configuracoes/agente);
  // a página legada envolve o conteúdo com o Shell. Os asserts cobrem os dois juntos.
  agent = `${agent}\n${agentContent}`;
});

describe("visão geral única", () => {
  it("keeps the legacy home as the kill-switch fallback", () => {
    expect(home).toContain('panelFeatureEnabled(featureFlags, "dashboard_widgets_v1")');
    expect(home).toContain("if (widgetsEnabled) return <DashboardWidgets />");
    expect(home).toContain("legacyDashboardUrl");
  });

  it("renderiza a Visão geral de referência como única tela, sem board nem biblioteca", () => {
    expect(component).toContain("<DashboardReferenceOverview");
    expect(component).not.toContain("Biblioteca de widgets");
    expect(component).not.toContain("widgetLibrary");
    expect(component).not.toContain("applyPreset");
    expect(overview).not.toContain("components/ui/funnel");
  });

  it("cobre os grupos do board antigo com seções no visual de referência", () => {
    for (const section of ["Atendimento", "Agenda de hoje", "Handoffs aguardando", "Alertas recentes", "Pipeline", "Origem dos leads", "Vendas por origem", "Equipe"]) {
      expect(overview).toContain(section);
    }
    for (const operational of ["Mensagens recebidas", "Tempo médio 1ª resposta", "Follow-ups atrasados", "Leads sem responsável"]) {
      expect(overview).toContain(operational);
    }
  });

  it("applies one period filter — including a custom range — to every section", () => {
    expect(component).toContain('period === "custom"');
    expect(component).toContain("period=custom&start=");
    // O seletor de período é um Segmented (botões aria-pressed), não um <select>:
    // o contrato é que "Período" personalizado continue sendo uma das opções.
    expect(component).toContain('["custom", "Período"]');
    expect(component).toContain('aria-pressed={period === key}');
  });

  it("seções toleram 403 e falha de rede sem quebrar a página", () => {
    expect(overview).toContain("isForbidden");
    expect(overview).toContain("function settled");
  });

  it("envia o target no toggle e impede alternar um alvo herdado antes de salvar override", () => {
    expect(agent).toContain('body: JSON.stringify({ isActive: next, sessionId: target || null })');
    expect(agent).toContain('const targetNeedsOverride = Boolean(target && scope === "shared")');
    expect(agent).toContain('disabled={!canManage || !form || changingStatus || saving || removingOverride || targetNeedsOverride}');
    expect(agent).toContain("Salve as alterações para criar um prompt exclusivo antes de alterar o status deste número.");
  });
});
