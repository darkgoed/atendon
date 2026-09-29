// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { DashboardWidgets } from "@/components/dashboard-widgets";

vi.mock("@/components/shell", () => ({
  Shell: ({ children }: { children: ReactNode }) => <>{children}</>
}));

vi.mock("@/lib/capabilities", () => ({
  useCapabilities: () => ({ isEnabled: () => true })
}));

vi.mock("@/lib/realtime", () => ({
  useRealtimeSignals: () => undefined
}));

const respond = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const session = { user: { id: "user-1" }, activeWorkspace: { id: "workspace-1" } };

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Visão geral única (sem board de widgets)", () => {
  it("renderiza a referência com o funil mesmo com layout salvo no backend", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/me")) return respond(session);
      if (url.endsWith("/dashboard/widgets/catalog")) {
        return respond({ widgets: [{ key: "handoffs", label: "Handoffs", description: "Fila", group: "atendimento", sizes: ["small"], default_size: "small" }], default_layout: [] });
      }
      if (url.endsWith("/dashboard/widgets/layout")) {
        // Layout salvo da era do board: não pode trazer o board de volta.
        return respond({ layout: { source: "saved", items: [{ key: "handoffs", order: 0, visible: true, size: "small" }] } });
      }
      if (url.includes("commercial_metrics")) {
        return respond({ data: { result: { new_contacts: 48, appointments: 21, calls: 18, sales: 9, sold_value: 13500, average_ticket: 1500, due_meetings: 20, no_show: 3 }, funnel: { lead_to_appointment: 44, appointment_to_attendance: 90, call_to_sale: 50, lead_to_sale: 19, no_show_rate: 15 } } });
      }
      if (url.includes("conversations_started")) return respond({ data: { value: 52 } });
      if (url.includes("conversion_rate")) return respond({ data: { value: 17.3 } });
      return new Response(JSON.stringify({ message: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SWRConfig value={{ provider: () => new Map() }}><DashboardWidgets /></SWRConfig>);

    expect(await screen.findByText("Funil de conversão")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hoje" })).toBeInTheDocument();
    // Não existe alternância nem biblioteca: a Visão geral é a única tela.
    expect(screen.queryByRole("button", { name: "Personalizar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Meus widgets" })).not.toBeInTheDocument();
    expect(screen.queryByText("Biblioteca de widgets")).not.toBeInTheDocument();
    // O catálogo/layout do board antigo não é mais consultado pela página.
    expect(calls.some((url) => url.endsWith("/dashboard/widgets/catalog"))).toBe(false);
    expect(calls.some((url) => url.endsWith("/dashboard/widgets/layout"))).toBe(false);
  });

  it("o filtro de período reconsulta os endpoints das seções", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/me")) return respond(session);
      if (url.includes("commercial_metrics")) {
        return respond({ data: { result: { new_contacts: 48, appointments: 21, calls: 18, sales: 9, sold_value: 13500, average_ticket: 1500, due_meetings: 20, no_show: 3 }, funnel: { lead_to_appointment: 44, appointment_to_attendance: 90, call_to_sale: 50, lead_to_sale: 19, no_show_rate: 15 } } });
      }
      if (url.includes("conversations_started")) return respond({ data: { value: 52 } });
      if (url.includes("conversion_rate")) return respond({ data: { value: 17.3 } });
      return new Response(JSON.stringify({ message: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SWRConfig value={{ provider: () => new Map() }}><DashboardWidgets /></SWRConfig>);
    expect(await screen.findByText("Funil de conversão")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Semana" }));
    await waitFor(() => {
      expect(calls.some((url) => url.includes("commercial_metrics") && url.includes("period=week"))).toBe(true);
    });
  });
});
