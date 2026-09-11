// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { DashboardWidgets } from "@/components/dashboard-widgets";

vi.mock("@/components/shell", () => ({ Shell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/lib/capabilities", () => ({ useCapabilities: () => ({ isEnabled: () => true }) }));
vi.mock("@/lib/realtime", () => ({ useRealtimeSignals: () => undefined }));

const catalog = {
  widgets: [
    { key: "handoffs", label: "Handoffs", description: "Fila", group: "atendimento", sizes: ["small"], default_size: "small" },
    { key: "recent_alerts", label: "Alertas", description: "Alertas", group: "atendimento", sizes: ["small"], default_size: "small" }
  ],
  default_layout: []
};
const layout = { layout: { source: "saved" as const, items: [
  { key: "handoffs", order: 0, visible: true, size: "small" as const },
  { key: "recent_alerts", order: 1, visible: true, size: "small" as const }
] } };

function response(body: unknown) { return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }); }

describe("dashboard legacy renderers", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("does not send handoffs or alerts with items to DashboardTeamWidget", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/dashboard/widgets/catalog")) return response(catalog);
      if (url.includes("/dashboard/widgets/layout")) return response(layout);
      if (url.includes("/handoffs")) return response({ key: "handoffs", data: { total: 1, items: [{ id: "h1", contact_name: "Contato da fila", waiting_minutes: 5 }] } });
      if (url.includes("/recent_alerts")) return response({ key: "recent_alerts", data: { items: [{ id: "a1", message: "Alerta operacional", created_at: "2025-01-01T00:00:00Z" }] } });
      throw new Error(`URL inesperada: ${url}`);
    });

    render(<SWRConfig value={{ provider: () => new Map() }}><DashboardWidgets /></SWRConfig>);
    expect(await screen.findByText("Contato da fila")).toBeInTheDocument();
    expect(await screen.findByText("Alerta operacional")).toBeInTheDocument();
    expect(screen.queryByText("Membro")).not.toBeInTheDocument();
  });
});
