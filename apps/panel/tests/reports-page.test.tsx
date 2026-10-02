// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { SWRConfig } from "swr";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { api, permissions } = vi.hoisted(() => ({ api: vi.fn(), permissions: { value: true } }));

vi.mock("../lib/api", () => ({ api }));
vi.mock("../lib/use-permission", () => ({ usePermission: () => permissions.value }));
vi.mock("../lib/meet", () => ({ apiContentUrl: (path: string) => `/backend${path}` }));
vi.mock("../lib/labels", () => ({ leadStatusLabel: (status: string) => status }));
vi.mock("../components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
// ECharts não roda em jsdom: o gráfico vira um stub que marca o que receberia.
vi.mock("../components/ui/chart", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  LineAreaChart: ({ data, ariaLabel }: { data: Array<Record<string, unknown>>; ariaLabel: string }) => (
    <div data-testid="volume-chart" aria-label={ariaLabel}>{data.length} pontos</div>
  )
}));

import ReportsPage from "../app/relatorios/page";

const SESSION = {
  user: { id: "u1", email: "owner@example.com", isRoot: false, name: "Owner" },
  activeWorkspace: { id: "w1", name: "WS", slug: "ws", status: "active", role: "OWNER", timezone: "America/Sao_Paulo" },
  workspaces: [], permissions: ["dashboard.read"], actorScope: "workspace", rootWorkspaceAccess: false
};

const VOLUME = { points: [
  { date: "2026-09-30", total: 12, open: 5, closed: 6, pending: 1 },
  { date: "2026-10-01", total: 8, open: 7, closed: 1, pending: 3 }
] };
const AGENTS = { items: [{ user_id: "u2", name: "Alice", email: "alice@example.com", answered: 9, closed: 4, messages_sent: 120 }] };
const STATUS = { items: [{ status: "novo", total: 7, avg_close_minutes: null }, { status: "fechado", total: 3, avg_close_minutes: "142.5" }] };
const QUALITY = {
  from: "2026-09-02", to: "2026-10-01",
  idle_agents: [{ user_id: "u3", name: "Bruno", email: "b@example.com", last_message_at: "2026-09-20T10:00:00Z" }],
  queue: { count: 2, avg_wait_seconds: 340, items: [{ conversation_id: "c1", contact: { phone: "5511…", name: "Maria" }, waiting_since_seconds: 95, last_inbound_at: "2026-10-01T10:00:00Z" }] },
  avg_first_response: [{ user_id: "u2", name: "Alice", seconds: 75 }],
  bottlenecks: [{ pipeline_id: "p1", stage_id: "s1", stage_name: "Proposta enviada", contacts: 4, avg_minutes: 2880 }]
};

function renderPage() {
  // Cache novo por teste: sem isso o SWR global devolve dado da aba volume
  // de um teste anterior e o mock da API nem é chamado.
  return render(<SWRConfig value={{ provider: () => new Map() }}><ReportsPage /></SWRConfig>);
}

function mockReports() {
  api.mockImplementation(async (path: string) => {
    if (path === "/me") return SESSION;
    if (path.startsWith("/reports/conversation-volume")) return VOLUME;
    if (path.startsWith("/reports/agent-productivity")) return AGENTS;
    if (path.startsWith("/reports/status-flow")) return STATUS;
    if (path.startsWith("/reports/quality")) return QUALITY;
    return {};
  });
}

beforeEach(() => {
  cleanup();
  api.mockReset();
  permissions.value = true;
  mockReports();
});

describe("relatórios", () => {
  it("aba volume: busca com período, desenha gráfico e tabela", async () => {
    renderPage();
    expect(await screen.findByTestId("volume-chart")).toHaveTextContent("2 pontos");
    expect(screen.getByText("2026-09-30")).toBeInTheDocument();
    const calls = api.mock.calls.filter(([path]) => String(path).startsWith("/reports/conversation-volume"));
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[0]![0])).toMatch(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
    // Export CSV aponta para o endpoint existente com o tipo da aba ativa.
    const exportLink = screen.getByRole("link");
    expect(exportLink.getAttribute("href")).toMatch(/\/reports\/export\/csv\?type=volume&from=/);
  });

  it("aba produtividade: tabela de atendentes", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("tab", { name: "Produtividade" }));
    expect(await screen.findByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
  });

  it("aba status: mostra média de fechamento formatada e oculta zeros", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("tab", { name: "Fluxo de status" }));
    expect(await screen.findByText("novo")).toBeInTheDocument();
    expect(screen.getByText("2h 23min")).toBeInTheDocument(); // 142.5 min
    // status com total 0 não aparece na tabela
    expect(screen.queryByText("aguardando_resposta")).toBeNull();
  });

  it("aba qualidade: fila, primeira resposta, ociosos e gargalos", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("tab", { name: "Qualidade" }));
    expect(await screen.findByText(/2 conversa\(s\) aguardando resposta · espera média 5min/)).toBeInTheDocument();
    expect(screen.getByText("1min")).toBeInTheDocument(); // 75s primeira resposta
    expect(screen.getByText("Bruno")).toBeInTheDocument();
    expect(screen.getByText("Proposta enviada")).toBeInTheDocument();
    expect(screen.getByText("48h 00min")).toBeInTheDocument(); // 2880 min
  });

  it("erro da API aparece com role=alert", async () => {
    api.mockImplementation(async (path: string) => {
      if (path === "/me") return SESSION;
      if (path.startsWith("/reports/conversation-volume")) return Promise.reject(new Error("Falha de banco"));
      return {};
    });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Falha de banco");
  });

  it("sem dados de volume mostra estado vazio e sem gráfico", async () => {
    api.mockImplementation(async (path: string) => {
      if (path === "/me") return SESSION;
      if (path.startsWith("/reports/conversation-volume")) return { points: [{ date: "2026-09-30", total: 0, open: 0, closed: 0, pending: 0 }] };
      return {};
    });
    renderPage();
    expect(await screen.findByText("Sem dados neste período.")).toBeInTheDocument();
    expect(screen.queryByTestId("volume-chart")).toBeNull();
  });

  it("sem permissão dashboard.read a página explica o bloqueio", async () => {
    permissions.value = false;
    renderPage();
    expect(await screen.findByText(/Você não tem permissão para ver relatórios/)).toBeInTheDocument();
    expect(api.mock.calls.filter(([path]) => String(path).startsWith("/reports/"))).toHaveLength(0);
  });
});
