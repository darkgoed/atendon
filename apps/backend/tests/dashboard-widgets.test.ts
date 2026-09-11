import { describe, expect, it } from "vitest";
import { OPERATOR_PERMISSIONS } from "../src/auth/rbac.js";
import {
  availableDashboardWidgets,
  defaultDashboardLayout,
  sanitizeDashboardLayout,
  validateDashboardLayout
} from "../src/modules/dashboard-widgets/catalog.js";

describe("dashboard widget catalog and layout", () => {
  it("filters the controlled catalog by effective RBAC permissions", () => {
    const catalog = availableDashboardWidgets(OPERATOR_PERMISSIONS);
    expect(catalog.map((widget) => widget.key)).not.toContain("whatsapp_connection");
    expect(catalog.map((widget) => widget.key)).toEqual(expect.arrayContaining([
      "open_conversations", "handoffs", "messages_today", "today_agenda", "pipeline", "team_load"
    ]));
  });

  it("shows exactly the five essential widgets by default and hides legacy widgets", () => {
    const layout = defaultDashboardLayout(availableDashboardWidgets(OPERATOR_PERMISSIONS));
    expect(layout.filter((item) => item.visible).map((item) => item.key)).toEqual([
      "conversations_started", "appointments_count", "sales_count", "sales_value", "conversion_rate"
    ]);
    expect(layout.find((item) => item.key === "commercial_metrics")?.visible).toBe(false);
    expect(layout.find((item) => item.key === "pipeline")?.visible).toBe(false);
    expect(layout.find((item) => item.key === "recent_alerts")?.visible).toBe(false);
  });

  it("marks only duplicated compound widgets as non-selectable", () => {
    const catalog = availableDashboardWidgets(OPERATOR_PERMISSIONS);
    const definition = (key: string) => catalog.find((widget) => widget.key === key);
    expect(definition("commercial_metrics")?.selectable).toBe(false);
    expect(definition("open_conversations")?.selectable).toBe(false);
    expect(definition("team_load")?.selectable).toBe(false);
    expect(definition("handoffs")?.selectable).toBe(true);
    expect(definition("sales_by_seller")?.selectable).toBe(true);
  });

  it("removes widgets after permission loss and canonicalizes order and sizes", () => {
    const catalog = availableDashboardWidgets(OPERATOR_PERMISSIONS);
    const layout = sanitizeDashboardLayout([
      { key: "whatsapp_connection", order: 0, visible: true, size: "small" },
      { key: "handoffs", order: 4, visible: true, size: "full" },
      { key: "handoffs", order: 3, visible: false, size: "small" }
    ], catalog);
    expect(layout.map((item) => item.key)).not.toContain("whatsapp_connection");
    expect(layout.filter((item) => item.key === "handoffs")).toHaveLength(1);
    expect(layout[0]).toMatchObject({ key: "handoffs", order: 0, size: "small", visible: false });
    expect(layout.every((item, index) => item.order === index)).toBe(true);
  });

  it("rejects attempts to persist unauthorized, duplicate or unsupported widgets", () => {
    const catalog = availableDashboardWidgets(OPERATOR_PERMISSIONS);
    expect(() => validateDashboardLayout([
      { key: "whatsapp_connection", order: 0, visible: true, size: "small" }
    ], catalog)).toThrow("Widget não permitido");
    expect(() => validateDashboardLayout([
      { key: "handoffs", order: 0, visible: true, size: "small" },
      { key: "handoffs", order: 1, visible: true, size: "small" }
    ], catalog)).toThrow("Widget duplicado");
    expect(() => validateDashboardLayout([
      { key: "handoffs", order: 0, visible: true, size: "full" }
    ], catalog)).toThrow("Tamanho indisponível");
  });
});
