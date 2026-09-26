// @vitest-environment jsdom
// Tela de Uso abre no CICLO DE COBRANÇA do tenant (period=current), não em
// "últimos 30 dias": a janela vem do backend (start_at/end_at do período) e as
// datas são exibidas no fuso do workspace.
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api }));
vi.mock("../lib/use-permission", () => ({ usePermission: () => false }));
import { UsoBody } from "../app/uso/uso-content";

const dashboard = { planName: "Pro", usageUnit: "CREDIT", includedLimit: 5000, includedUsage: 10, rolloverGranted: 0, rolloverUsage: 0, bonusGranted: 0, bonusUsage: 0, totalAvailable: 5000, totalUsed: 10, usedPercentBps: 20, periodStart: "2026-09-15T03:00:00.000Z", periodEnd: "2026-10-15T03:00:00.000Z", daysUntilRenewal: 19, creditLimitCents: null, creditUsedCents: 0 };

function mockApi(window: Record<string, string>) {
  api.mockImplementation(async (path: string) => {
    if (path === "/billing/usage-dashboard") return { dashboard };
    if (path.startsWith("/billing/history")) return { history: [] };
    if (path === "/billing/usage-credit") return { setting: { enabled: false }, allowed: {} };
    if (path === "/billing/ai-credit-packs/balance") return { balance: { availableCredits: 0, grants: [] } };
    if (path.startsWith("/billing/ai-usage")) return { summary: { window, calls: { count: 3 } } };
    return {};
  });
}
const usageCalls = () => api.mock.calls.map(([p]) => p as string).filter((p) => p.startsWith("/billing/ai-usage"));

beforeEach(() => { cleanup(); api.mockReset(); });

describe("Uso: janela padrão = ciclo de cobrança", () => {
  it("pede period=current já na primeira carga (sem depender de carga anterior)", async () => {
    mockApi({ from: "2026-09-15T03:00:00.000Z", to: "2026-10-15T03:00:00.000Z", source: "billing_period", timezone: "America/Sao_Paulo" });
    render(<UsoBody />);
    await screen.findByText(/Ciclo de cobrança/);
    expect(usageCalls()).toHaveLength(2);
    for (const p of usageCalls()) expect(p).toMatch(/[?&]period=current(&|$)/);
  });

  it("exibe o ciclo no fuso do workspace: 03:00Z = 00:00 em São Paulo; fim exclusivo mostra o dia anterior", async () => {
    mockApi({ from: "2026-09-15T03:00:00.000Z", to: "2026-10-15T03:00:00.000Z", source: "billing_period", timezone: "America/Sao_Paulo" });
    render(<UsoBody />);
    expect(await screen.findByText("Ciclo de cobrança: 15/09/2026 a 14/10/2026")).toBeInTheDocument();
  });

  it("mesmo instante em fuso UTC: início 15/09, fim exclusivo 15/10 03:00Z → último dia 15/10", async () => {
    mockApi({ from: "2026-09-15T03:00:00.000Z", to: "2026-10-15T03:00:00.000Z", source: "billing_period", timezone: "UTC" });
    render(<UsoBody />);
    expect(await screen.findByText("Ciclo de cobrança: 15/09/2026 a 15/10/2026")).toBeInTheDocument();
  });

  it("sem ciclo aberto (fallback por datas) rotula como Período com os dias informados", async () => {
    mockApi({ from: "2026-08-28", to: "2026-09-26", source: "dates" });
    render(<UsoBody />);
    expect(await screen.findByText("Período: 28/08/2026 a 26/09/2026")).toBeInTheDocument();
  });
});
