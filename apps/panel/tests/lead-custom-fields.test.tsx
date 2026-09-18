// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: apiMock }));

import { LeadCustomFields, formatCustomFieldValue } from "../components/lead-custom-fields";

type Recorded = { path: string; method: string; body?: Record<string, unknown> };

const SESSION = {
  user: { id: "user-1", name: "Marina Duarte", email: "marina@exemplo.com", isRoot: false },
  activeWorkspace: { id: "ws-1", name: "AtendON", timezone: "America/Sao_Paulo" },
  workspaces: [],
  permissions: ["leads.read", "fields.manage"],
  actorScope: "workspace"
};

const ITEMS = [
  { field_id: "f-text", key: "contrato", label: "Nº do contrato", type: "text", required: false, options: [], value: "CT-2026-09" },
  { field_id: "f-currency", key: "orcamento", label: "Valor do orçamento", type: "currency", required: false, options: [], value: 1234.5 },
  { field_id: "f-number", key: "funcionarios", label: "Funcionários", type: "number", required: false, options: [], value: 42 },
  { field_id: "f-date", key: "renovacao", label: "Data de renovação", type: "date", required: false, options: [], value: "2026-09-18" },
  { field_id: "f-select", key: "canal", label: "Canal preferido", type: "select", required: false, options: ["WhatsApp", "E-mail"], value: "WhatsApp" },
  { field_id: "f-multi", key: "interesses", label: "Interesses", type: "multiselect", required: false, options: ["Suporte", "Vendas", "Integração"], value: ["Suporte", "Vendas"] },
  { field_id: "f-bool", key: "aprovado", label: "Orçamento aprovado", type: "boolean", required: false, options: [], value: true },
  { field_id: "f-empty", key: "vazio", label: "Campo sem valor", type: "text", required: false, options: [], value: null }
];

const calls: Recorded[] = [];

function renderComponent() {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <LeadCustomFields leadId="lead-1" />
    </SWRConfig>
  );
}

beforeEach(() => {
  calls.length = 0;
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined });
    if (path === "/me") return Promise.resolve(SESSION);
    if (path === "/organization/leads/lead-1/custom-values") return Promise.resolve({ items: ITEMS });
    if (path === "/organization/leads/lead-1/custom-values" && method === "PUT") return Promise.resolve({ field_id: "x", value: "y" });
    return Promise.resolve({});
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("campos personalizados do contato (R7)", () => {
  it("renderiza os valores por tipo (moeda, data, multi, booleano)", async () => {
    renderComponent();
    expect(await screen.findByText("CT-2026-09")).toBeInTheDocument();
    expect(screen.getByText("R$ 1.234,50")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("18/09/2026")).toBeInTheDocument();
    expect(screen.getByText("WhatsApp")).toBeInTheDocument();
    expect(screen.getByText("Suporte, Vendas")).toBeInTheDocument();
    expect(screen.getByText("Sim")).toBeInTheDocument();
    // Campo sem valor exibe traço, não vazio.
    const rows = screen.getAllByText("—");
    expect(rows.length).toBe(1);
    expect(screen.queryByRole("button", { name: "Editar valor: Nº do contrato" })).toBeInTheDocument();
  });

  it("salva valor de moeda como JSON number via PUT", async () => {
    const user = userEvent.setup();
    renderComponent();
    await screen.findByText("R$ 1.234,50");
    await user.click(screen.getByRole("button", { name: "Editar valor: Valor do orçamento" }));
    const input = screen.getByLabelText("Valor do orçamento") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2500" } });
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => {
      const put = calls.find((call) => call.method === "PUT");
      expect(put).toBeTruthy();
      expect(put?.path).toBe("/organization/leads/lead-1/custom-values");
      expect(put?.body).toEqual({ field_id: "f-currency", value: 2500 });
      expect(typeof put?.body?.value).toBe("number");
    });
  });

  it("salva seleção múltipla como array e data como ISO", async () => {
    const user = userEvent.setup();
    renderComponent();
    await screen.findByText("Suporte, Vendas");

    await user.click(screen.getByRole("button", { name: "Editar valor: Interesses" }));
    const multi = screen.getByLabelText("Interesses") as HTMLSelectElement;
    await user.deselectOptions(multi, ["Suporte", "Vendas"]);
    await user.selectOptions(multi, ["Integração"]);
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ field_id: "f-multi", value: ["Integração"] });

    await user.click(screen.getByRole("button", { name: "Editar valor: Data de renovação" }));
    const dateInput = screen.getByLabelText("Data de renovação") as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2026-10-05" } });
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => {
      const datePut = calls.find((call) => call.method === "PUT" && call.body?.field_id === "f-date");
      expect(datePut?.body).toEqual({ field_id: "f-date", value: "2026-10-05" });
    });
  });

  it("limpa valor enviando null", async () => {
    const user = userEvent.setup();
    renderComponent();
    await screen.findByText("CT-2026-09");
    await user.click(screen.getByRole("button", { name: "Editar valor: Nº do contrato" }));
    const input = screen.getByLabelText("Nº do contrato") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    const textPut = calls.find((call) => call.method === "PUT" && call.body?.field_id === "f-text");
    expect(textPut?.body).toEqual({ field_id: "f-text", value: null });
  });

  it("sem fields.manage não oferece edição", async () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/me") return Promise.resolve({ ...SESSION, permissions: ["leads.read"] });
      if (path === "/organization/leads/lead-1/custom-values") return Promise.resolve({ items: ITEMS });
      return Promise.resolve({});
    });
    renderComponent();
    expect(await screen.findByText("CT-2026-09")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Editar valor/ })).not.toBeInTheDocument();
  });

  it("sem campos cadastrados e sem permissão de gestão, não renderiza nada", () => {
    apiMock.mockImplementation((path: string) => {
      if (path === "/me") return Promise.resolve({ ...SESSION, permissions: ["leads.read"] });
      if (path === "/organization/leads/lead-1/custom-values") return Promise.resolve({ items: [] });
      return Promise.resolve({});
    });
    const { container } = renderComponent();
    expect(container).toBeEmptyDOMElement();
  });

  it("formata valor vazio como traço e booleano como Sim/Não", () => {
    const base = { field_id: "x", key: "x", required: false, options: [] as string[] };
    expect(formatCustomFieldValue({ ...base, label: "a", type: "boolean", value: false })).toBe("Não");
    expect(formatCustomFieldValue({ ...base, label: "a", type: "text", value: null })).toBe("—");
    expect(formatCustomFieldValue({ ...base, label: "a", type: "multiselect", value: [] })).toBe("—");
  });
});
