import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

let component = "";
let home = "";

beforeAll(async () => {
  [component, home] = await Promise.all([
    readFile(new URL("../components/dashboard-widgets.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8")
  ]);
});

describe("personalizable dashboard UI", () => {
  it("keeps the legacy home as the kill-switch fallback", () => {
    expect(home).toContain('panelFeatureEnabled(featureFlags, "dashboard_widgets_v1")');
    expect(home).toContain("if (widgetsEnabled) return <DashboardWidgets />");
    expect(home).toContain("legacyDashboardUrl");
  });

  it("uses one responsive layout and exposes order, visibility, size, save and reset", () => {
    expect(component).toContain("grid grid-cols-12 gap-4");
    expect(component).toContain('small: "col-span-12 sm:col-span-6 xl:col-span-3"');
    expect(component).toContain("patchItem(item.key, { visible:");
    expect(component).toContain("move(item.key, -1)");
    expect(component).toContain('method: "PUT"');
    expect(component).toContain('method: "DELETE"');
    expect(component).not.toContain("mobileLayout");
  });

  it("loads every visible widget independently with skeleton, empty, error and retry", () => {
    expect(component).toContain("`/dashboard/widgets/${item.key}?${periodQuery}`");
    expect(component).toContain("<WidgetSkeleton />");
    expect(component).toContain("<EmptyWidget");
    expect(component).toContain('role="alert"');
    expect(component).toContain("Tentar novamente");
    expect(component).toContain("void mutate()");
    expect(component).toContain("stage.name ?? stage.status");
    expect(component).toContain("stage.color");
    expect(component).toContain("capacity_target");
  });

  it("leads with commercial result, then conversion, performance and operation", () => {
    for (const label of ["Novos contatos", "Agendamentos", "Calls realizadas", "No-show", "Vendas", "Valor vendido"]) {
      expect(component).toContain(label);
    }
    for (const step of ["Lead → Agendamento", "Agendamento → Comparecimento", "Call → Venda", "Lead → Venda", "Taxa de no-show"]) {
      expect(component).toContain(step);
    }
    for (const operational of ["Mensagens recebidas", "Handoffs", "Tempo médio 1ª resposta", "Follow-ups atrasados", "Leads sem responsável"]) {
      expect(component).toContain(operational);
    }
  });

  it("renders the overview with charts instead of plain numbers", () => {
    expect(component).toContain('from "@/components/commercial-dashboard-charts"');
    expect(component).toContain("<TrendChart data={series} />");
    expect(component).toContain("<Sparkline values={series.map((item) => item[spark])}");
    expect(component).toContain("<RateRing value={Number(funnel.lead_to_sale ?? 0)}");
    expect(component).toContain("trendDelta(series, spark)");
  });

  it("applies one period filter — including a custom range — to every widget", () => {
    expect(component).toContain('period === "custom"');
    expect(component).toContain("period=custom&start=");
    expect(component).toContain('<option value="custom">');
  });
});
