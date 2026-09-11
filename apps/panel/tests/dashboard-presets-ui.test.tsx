// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

const groups = [
  ["atendimento", "Conversas iniciadas"],
  ["origem", "Leads de tráfego pago"],
  ["agendamento", "Agendamentos"],
  ["vendas", "Vendas"],
  ["origem_das_vendas", "Vendas de tráfego pago"],
  ["equipe", "Vendas por vendedor"]
] as const;

let essentialApplied = false;

const catalog = {
  widgets: groups.map(([group, label], index) => ({
    key: `widget_${index}`,
    label,
    description: `Descrição de ${label}`,
    group,
    sizes: ["small", "medium"],
    default_size: "small"
  })),
  default_layout: []
};

const suppressExpectedPresetFailure = (reason: unknown) => {
  if (reason instanceof Error && reason.message === "falha") return;
  throw reason;
};

function layout(visible: boolean) {
  return {
    layout: {
      source: "saved" as const,
      items: groups.map(([,], index) => ({
        key: `widget_${index}`,
        order: index,
        visible,
        size: "small" as const
      }))
    }
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function openEditor() {
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <DashboardWidgets />
    </SWRConfig>
  );
  await userEvent.setup().click(screen.getByRole("button", { name: "Personalizar" }));
  await screen.findByRole("heading", { name: "Biblioteca de widgets" });
}

describe("presets do dashboard", () => {
  afterEach(() => {
    cleanup();
    process.off("unhandledRejection", suppressExpectedPresetFailure);
  });

  beforeEach(() => {
    process.on("unhandledRejection", suppressExpectedPresetFailure);
    essentialApplied = false;
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/dashboard/widgets/catalog")) return jsonResponse(catalog);
      if (url.endsWith("/dashboard/widgets/layout")) return jsonResponse(layout(essentialApplied));
      if (url.includes("/dashboard/widgets/presets/essencial")) {
        essentialApplied = true;
        return jsonResponse({ items: layout(true).layout.items });
      }
      if (url.includes("/dashboard/widgets/widget_")) {
        return jsonResponse({ key: url.match(/widget_\d+/)?.[0] ?? "widget", data: { value: 1 } });
      }
      throw new Error(`URL inesperada: ${url} ${(init?.method ?? "GET")}`);
    });
  });

  it("renderiza os quatro botões do contrato", async () => {
    await openEditor();
    const presetBar = screen.getByLabelText("Presets do dashboard");
    expect(within(presetBar).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Essencial",
      "Comercial",
      "Gestão completa",
      "Personalizado"
    ]);
  });

  it("clica em Essencial, faz POST e revalida o layout", async () => {
    await openEditor();

    const user = userEvent.setup();
    await user.click(within(screen.getByLabelText("Presets do dashboard")).getByRole("button", { name: "Essencial" }));

    await waitFor(() => {
      const calls = vi.mocked(globalThis.fetch).mock.calls;
      expect(calls.some(([input, init]) => String(input).endsWith("/dashboard/widgets/presets/essencial") && init?.method === "POST")).toBe(true);
      expect(calls.filter(([input]) => String(input).endsWith("/dashboard/widgets/layout"))).toHaveLength(2);
    });
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /Conversas iniciadas/ })).toBeChecked());
  });

  it("exibe exatamente os seis grupos e preserva alterações quando o preset falha", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/dashboard/widgets/catalog")) return jsonResponse(catalog);
      if (url.endsWith("/dashboard/widgets/layout")) return jsonResponse(layout(false));
      if (url.includes("/dashboard/widgets/presets/essencial")) return jsonResponse({ error: "falha" }, 500);
      throw new Error(`URL inesperada: ${url} ${(init?.method ?? "GET")}`);
    });

    await openEditor();
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Atendimento",
      "Origem",
      "Agendamento",
      "Vendas",
      "Origem das vendas",
      "Equipe"
    ]);

    const checkbox = screen.getByRole("checkbox", { name: /Conversas iniciadas/ });
    await userEvent.setup().click(checkbox);
    expect(checkbox).toBeChecked();
    await userEvent.setup().click(within(screen.getByLabelText("Presets do dashboard")).getByRole("button", { name: "Essencial" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/dashboard/widgets/presets/essencial") && init?.method === "POST")).toBe(true));
    expect(checkbox).toBeChecked();
  });
});
