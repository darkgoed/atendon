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

// jsdom deste projeto não expõe localStorage (origem opaca): stub mínimo em
// memória para o marcador de personalização persistir entre "recarregamentos".
const memoryStorage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  get length() { return memoryStorage.size; },
  clear: () => memoryStorage.clear(),
  getItem: (key: string) => memoryStorage.get(key) ?? null,
  key: (index: number) => [...memoryStorage.keys()][index] ?? null,
  removeItem: (key: string) => { memoryStorage.delete(key); },
  setItem: (key: string, value: string) => { memoryStorage.set(key, String(value)); }
} satisfies Pick<Storage, "length" | "clear" | "getItem" | "key" | "removeItem" | "setItem">);

const catalog = {
  widgets: [
    { key: "handoffs", label: "Handoffs", description: "Fila de handoff", group: "atendimento", sizes: ["small"], default_size: "small" },
    { key: "recent_alerts", label: "Alertas", description: "Alertas recentes", group: "atendimento", sizes: ["small"], default_size: "small" },
    { key: "commercial_metrics", label: "Resultado comercial", description: "Contatos, agendamentos, calls, no-show e vendas do período.", group: "vendas", sizes: ["full"], default_size: "full" }
  ],
  default_layout: []
};

const session = { user: { id: "user-1" }, activeWorkspace: { id: "workspace-1" } };

function layoutResponse(items: Array<Record<string, unknown>>, source: "saved" | "default" = "saved") {
  return { layout: { source, items } };
}

const allVisible = [
  { key: "handoffs", order: 0, visible: true, size: "small" },
  { key: "recent_alerts", order: 1, visible: true, size: "small" }
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function referencePayloads() {
  return {
    commercial: { data: { result: { new_contacts: 10, appointments: 6, calls: 5, sales: 2, sold_value: 1000, average_ticket: 500, due_meetings: 4, no_show: 1 }, funnel: { lead_to_appointment: 0.6, appointment_to_attendance: 0.8, call_to_sale: 0.4, lead_to_sale: 0.2, no_show_rate: 0.25 } } },
    started: { data: { value: 10 } },
    conversion: { data: { value: 20 } }
  };
}

function widgetPayloads() {
  return {
    handoffs: { key: "handoffs", data: { total: 1, items: [{ id: "h1", contact_name: "Contato da fila", waiting_minutes: 5 }] } },
    alerts: { key: "recent_alerts", data: { items: [{ id: "a1", message: "Alerta operacional", created_at: "2025-01-01T00:00:00Z" }] } }
  };
}

type MockState = {
  savedLayout: Array<Record<string, unknown>>;
  layoutSource: "saved" | "default";
};

function installFetchMock(state: MockState) {
  const payloads = { ...referencePayloads(), ...widgetPayloads() };
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/me")) return jsonResponse(session);
    if (url.endsWith("/dashboard/widgets/catalog")) return jsonResponse(catalog);
    if (url.endsWith("/dashboard/widgets/layout")) {
      if (method === "PUT") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { items: Array<Record<string, unknown>> };
        state.savedLayout = body.items;
        state.layoutSource = "saved";
        return jsonResponse(layoutResponse(body.items, "saved"));
      }
      if (method === "DELETE") {
        state.savedLayout = allVisible;
        state.layoutSource = "default";
        return jsonResponse(layoutResponse(allVisible, "default"));
      }
      return jsonResponse(layoutResponse(state.savedLayout, state.layoutSource));
    }
    if (url.includes("/dashboard/widgets/commercial_metrics")) return jsonResponse(payloads.commercial);
    if (url.includes("/dashboard/widgets/conversations_started")) return jsonResponse(payloads.started);
    if (url.includes("/dashboard/widgets/conversion_rate")) return jsonResponse(payloads.conversion);
    if (url.includes("/dashboard/widgets/handoffs")) return jsonResponse(payloads.handoffs);
    if (url.includes("/dashboard/widgets/recent_alerts")) return jsonResponse(payloads.alerts);
    throw new Error(`URL inesperada: ${url} ${method}`);
  });
}

function mountDashboard() {
  // Novo cache SWR por montagem: simula um reload completo do painel,
  // enquanto o localStorage do jsdom persiste entre montagens.
  render(<SWRConfig value={{ provider: () => new Map() }}><DashboardWidgets /></SWRConfig>);
}

async function savePersonalization() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Personalizar" }));
  await screen.findByRole("heading", { name: "Biblioteca de widgets" });
  await user.click(screen.getByRole("checkbox", { name: /Alertas/ }));
  await user.click(screen.getByRole("button", { name: "Salvar" }));
  await waitFor(() => {
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([input, init]) => String(input).endsWith("/dashboard/widgets/layout") && init?.method === "PUT")).toBe(true);
  });
  await screen.findByText("Layout salvo");
}

describe("personalização da Visão geral (referência)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("usuário sem personalização vê a referência mesmo com layout salvo", async () => {
    const state: MockState = { savedLayout: allVisible, layoutSource: "saved" };
    installFetchMock(state);
    mountDashboard();

    expect(await screen.findByText("Funil de conversão")).toBeInTheDocument();
    // Layout salvo da era anterior NÃO traz o board antigo como default.
    expect(screen.queryByText("Contato da fila")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Biblioteca de widgets" })).not.toBeInTheDocument();
  });

  it("Personalizar → esconder widget → Salvar mostra o board e persiste no reload", async () => {
    const state: MockState = { savedLayout: allVisible, layoutSource: "saved" };
    installFetchMock(state);
    mountDashboard();

    expect(await screen.findByText("Funil de conversão")).toBeInTheDocument();
    await savePersonalization();

    // Depois de salvar, a tela exibida é o board com as escolhas aplicadas.
    expect(await screen.findByText("Contato da fila")).toBeInTheDocument();
    expect(screen.queryByText("Alerta operacional")).not.toBeInTheDocument();
    expect(screen.queryByText("Funil de conversão")).not.toBeInTheDocument();
    const putCalls = vi.mocked(globalThis.fetch).mock.calls.filter(([, init]) => init?.method === "PUT");
    expect(putCalls).toHaveLength(1);
    const savedItems = JSON.parse(String(putCalls[0][1]?.body)) as { items: Array<{ key: string; visible: boolean }> };
    expect(savedItems.items.find((item) => item.key === "recent_alerts")?.visible).toBe(false);

    // Reload: SWR zerado, localStorage mantido — o board continua.
    cleanup();
    installFetchMock(state);
    mountDashboard();
    expect(await screen.findByText("Contato da fila")).toBeInTheDocument();
    expect(screen.queryByText("Alerta operacional")).not.toBeInTheDocument();
    expect(screen.queryByText("Funil de conversão")).not.toBeInTheDocument();
  });

  it("com board salvo, a alternância traz a Visão geral de volta e persiste", async () => {
    const state: MockState = { savedLayout: allVisible, layoutSource: "saved" };
    installFetchMock(state);
    mountDashboard();

    expect(await screen.findByText("Funil de conversão")).toBeInTheDocument();
    await savePersonalization();
    expect(await screen.findByText("Contato da fila")).toBeInTheDocument();

    // Um clique na alternância devolve a referência (com o funil) sem
    // descartar a personalização salva.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Visão geral" }));
    expect(await screen.findByText("Funil de conversão")).toBeInTheDocument();
    expect(screen.queryByText("Contato da fila")).not.toBeInTheDocument();

    // Reload: a escolha persiste — a referência segue na tela.
    cleanup();
    installFetchMock(state);
    mountDashboard();
    expect(await screen.findByText("Funil de conversão")).toBeInTheDocument();
    expect(screen.queryByText("Contato da fila")).not.toBeInTheDocument();

    // E o board continua alcançável, com o layout salvo preservado.
    const userReloaded = userEvent.setup();
    await userReloaded.click(screen.getByRole("button", { name: "Meus widgets" }));
    expect(await screen.findByText("Contato da fila")).toBeInTheDocument();
    expect(screen.queryByText("Alerta operacional")).not.toBeInTheDocument();
  });

  it("Restaurar padrão volta para a referência e limpa a marca", async () => {
    const state: MockState = { savedLayout: allVisible, layoutSource: "saved" };
    installFetchMock(state);
    mountDashboard();

    expect(await screen.findByText("Funil de conversão")).toBeInTheDocument();
    await savePersonalization();
    expect(await screen.findByText("Contato da fila")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Personalizar" }));
    await screen.findByRole("heading", { name: "Biblioteca de widgets" });
    await user.click(screen.getByRole("button", { name: "Restaurar padrão" }));
    await screen.findByText("Layout restaurado ao padrão");

    await user.click(screen.getByRole("button", { name: "Fechar" }));
    expect(await screen.findByText("Funil de conversão")).toBeInTheDocument();
    expect(screen.queryByText("Contato da fila")).not.toBeInTheDocument();

    cleanup();
    installFetchMock(state);
    mountDashboard();
    expect(await screen.findByText("Funil de conversão")).toBeInTheDocument();
    expect(screen.queryByText("Contato da fila")).not.toBeInTheDocument();
  });
});
