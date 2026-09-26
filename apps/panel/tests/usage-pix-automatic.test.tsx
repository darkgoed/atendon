// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
let canManage = true;
vi.mock("../lib/api", () => ({ api }));
vi.mock("../lib/use-permission", () => ({ usePermission: () => canManage }));
vi.mock("../lib/compat", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), randomUUID: () => "uuid-test" }));
import { UsoBody } from "../app/uso/uso-content";

const PIX_AUTO = "/billing/ai-credit-packs/pix-automatic";
const dashboard = { planName: "Pro", usageUnit: "CREDIT", includedLimit: 5000, includedUsage: 1200, rolloverGranted: 700, rolloverUsage: 100, bonusGranted: 200, bonusUsage: 10, totalAvailable: 5900, totalUsed: 1310, usedPercentBps: 2220, periodEnd: "2026-10-01T00:00:00Z", daysUntilRenewal: 12, creditLimitCents: 370000, creditUsedCents: 12300 };
const credit = { setting: { enabled: false }, allowed: { suggested: 370000 } };
const sku = { sku: "AI_CREDITS_50M", credits: 1000, priceCents: 5000, currency: "BRL" };
type Mandate = { id: string; status: string; firstDueOn: string; pixCopiaECola?: string };

let mandate: Mandate | null;
let keepMandateOnDelete: boolean;
let pixGets: number;
let pixWrites: string[];

function mockApi() {
  mandate = null; keepMandateOnDelete = false; pixGets = 0; pixWrites = [];
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/billing/usage-dashboard") return { dashboard };
    if (path.startsWith("/billing/history")) return { history: [] };
    if (path === "/billing/usage-credit") return credit;
    if (path === "/billing/ai-credit-packs/balance") return { balance: { availableCredits: 0, grants: [] } };
    if (path.startsWith("/billing/ai-usage")) return { summary: {} };
    if (path === "/billing/ai-credit-packs") return { sku, purchases: [] };
    if (path === PIX_AUTO) {
      if (init?.method === "POST" || init?.method === "DELETE") {
        pixWrites.push(init.method);
        if (init.method === "DELETE") { if (!keepMandateOnDelete) mandate = null; }
        else mandate = { id: "m-1", status: "PENDING", firstDueOn: "2026-11-10", pixCopiaECola: "PIX-AUTO-CODE" };
        return { mandate };
      }
      pixGets += 1;
      return { mandate };
    }
    return {};
  });
}

beforeEach(() => { cleanup(); api.mockReset(); canManage = true; });
afterEach(() => { vi.useRealTimers(); });

describe("uso — Pix Automático mensal", () => {
  it("renders a pending mandate with copia-e-cola, copy, stop and the info block", async () => {
    mockApi();
    mandate = { id: "m-1", status: "PENDING", firstDueOn: "2026-11-10", pixCopiaECola: "PIX-AUTO-CODE" };
    render(<UsoBody />);
    expect(await screen.findByText(/Status da autorização: Pendente/)).toBeTruthy();
    expect(screen.getByText(/50 milhões de créditos por R\$157 via Pix Automático/)).toBeTruthy();
    expect(screen.getByText(/Primeira cobrança prevista: 10\/11\/2026/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copiar PIX Automático" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Parar cobranças futuras" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Aderir ao Pix Automático" })).toBeNull();
    // Autorização pendente nunca pode ser apresentada como pagamento confirmado/crédito concedido.
    expect(screen.queryByText(/Pagamento confirmado|créditos liberados/i)).toBeNull();
  });

  it("aderir POSTs the endpoint with an empty body and shows the copia-e-cola", async () => {
    mockApi();
    render(<UsoBody />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Aderir ao Pix Automático" }));
    expect(await screen.findByText(/Status da autorização: Pendente/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copiar PIX Automático" })).toBeTruthy();
    expect(pixWrites).toEqual(["POST"]);
    const post = api.mock.calls.find(([p, init]) => p === PIX_AUTO && (init as RequestInit | undefined)?.method === "POST");
    expect(post).toBeTruthy();
    expect((post![1] as RequestInit).body).toBeUndefined();
  });

  it("parar cobranças DELETEs, returns to adhesion state and explains the bank app", async () => {
    mockApi();
    mandate = { id: "m-1", status: "APPROVED", firstDueOn: "2026-11-10" };
    render(<UsoBody />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Parar cobranças futuras" }));
    expect(await screen.findByText(/Cobranças futuras paradas neste painel/)).toBeTruthy();
    expect(screen.getByText(/cancele-a lá para encerrar de vez/)).toBeTruthy();
    expect(pixWrites).toEqual(["DELETE"]);
    expect(screen.queryByRole("button", { name: "Parar cobranças futuras" })).toBeNull();
    expect(screen.getByRole("button", { name: "Aderir ao Pix Automático" })).toBeTruthy();
  });

  it("DELETE keeping the mandate still confirms the stop and removes the stop button", async () => {
    mockApi();
    keepMandateOnDelete = true;
    mandate = { id: "m-1", status: "APPROVED", firstDueOn: "2026-11-10" };
    render(<UsoBody />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Parar cobranças futuras" }));
    expect(await screen.findByText(/Cobranças futuras paradas neste painel/)).toBeTruthy();
    expect(screen.getByText(/Status da autorização: Aprovada/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Parar cobranças futuras" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Aderir ao Pix Automático" })).toBeNull();
  });

  it("renders nothing and calls nothing without billing.manage", async () => {
    mockApi();
    canManage = false;
    render(<UsoBody />);
    expect(await screen.findByText("Histórico mensal")).toBeTruthy();
    expect(screen.queryByText(/Pix Automático/)).toBeNull();
    expect(api.mock.calls.some(([p]) => p === PIX_AUTO)).toBe(false);
    expect(api.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== "POST" && (init as RequestInit | undefined)?.method !== "DELETE")).toBe(true);
  });

  it("polls only while pending and stops once the GET confirms the mandate", async () => {
    mockApi();
    mandate = { id: "m-1", status: "PENDING", firstDueOn: "2026-11-10", pixCopiaECola: "PIX-AUTO-CODE" };
    vi.useFakeTimers();
    render(<UsoBody />);
    for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(pixGets).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    expect(pixGets).toBe(2); // pendente → consulta a cada 7s
    mandate = { ...mandate!, status: "APPROVED" };
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    expect(pixGets).toBe(3);
    expect(screen.getByText(/Status da autorização: Aprovada/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(pixGets).toBe(3); // confirmado → polling encerrado, sem refetch infinito
    expect(screen.queryByRole("button", { name: "Parar cobranças futuras" })).toBeTruthy();
  });

  it("does not poll at all when the mandate starts approved", async () => {
    mockApi();
    mandate = { id: "m-1", status: "APPROVED", firstDueOn: "2026-11-10" };
    vi.useFakeTimers();
    render(<UsoBody />);
    for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(pixGets).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(pixGets).toBe(1);
  });

  it("shows a failed GET as an alert without crashing the page", async () => {
    mockApi();
    api.mockImplementation(async (path: string) => {
      if (path === PIX_AUTO) throw new Error("Falha de rede");
      if (path === "/billing/usage-dashboard") return { dashboard };
      if (path.startsWith("/billing/history")) return { history: [] };
      if (path === "/billing/usage-credit") return credit;
      if (path === "/billing/ai-credit-packs/balance") return { balance: { availableCredits: 0, grants: [] } };
      if (path.startsWith("/billing/ai-usage")) return { summary: {} };
      if (path === "/billing/ai-credit-packs") return { sku, purchases: [] };
      return {};
    });
    render(<UsoBody />);
    expect(await screen.findByText("Falha de rede")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Aderir ao Pix Automático" })).toBeTruthy();
  });
});
