// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
let canManage = true;
let uuidSeq = 0;
vi.mock("../lib/api", () => ({ api }));
vi.mock("../lib/use-permission", () => ({ usePermission: () => canManage }));
vi.mock("../lib/compat", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), randomUUID: () => `uuid-${++uuidSeq}` }));
import { UsoBody } from "../app/uso/uso-content";

const dashboard = { planName: "Pro", usageUnit: "CREDIT", includedLimit: 5000, includedUsage: 1200, rolloverGranted: 700, rolloverUsage: 100, bonusGranted: 200, bonusUsage: 10, totalAvailable: 5900, totalUsed: 1310, usedPercentBps: 2220, periodEnd: "2026-10-01T00:00:00Z", daysUntilRenewal: 12, creditLimitCents: 370000, creditUsedCents: 12300 };
const credit = { setting: { enabled: false }, allowed: { suggested: 370000 } };
const sku = { sku: "AI_CREDITS_50M", credits: 1000, priceCents: 5000, currency: "BRL" };

let invoices: Record<string, string>;
let invoiceSeq: number;
let chargeCalls: string[];
let failNextCharge: boolean;
let failNextPost: boolean;
let idemKeys: Record<string, string>;

function mockApi(overrides: { usageUnit?: string; failOptional?: boolean } = {}) {
  invoices = {}; invoiceSeq = 0; chargeCalls = []; idemKeys = {};
  const failOptional = overrides.failOptional ?? false;
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/billing/usage-dashboard") return { dashboard: { ...dashboard, usageUnit: overrides.usageUnit ?? "CREDIT" } };
    if (path.startsWith("/billing/history")) return { history: [] };
    if (path === "/billing/usage-credit") return credit;
    if (path === "/billing/ai-credit-packs/balance") { if (failOptional) throw new Error("Saldo indisponível"); return { balance: { availableCredits: 0, grants: [] } }; }
    if (path.startsWith("/billing/ai-usage")) { if (failOptional) throw new Error("Relatório indisponível"); return { summary: { calls: { count: 0 } } }; }
    if (path === "/billing/ai-credit-packs") {
      if (init?.method === "POST") {
        // Formato real do endpoint ({ purchase, invoice:{ id, status, amountCents } }, credit-packs.ts);
        // retry com a MESMA idempotencyKey reapresenta a MESMA fatura (ref-lock do backend).
        const key = JSON.parse((init.body as string) ?? "{}").idempotencyKey as string;
        const existing = idemKeys[key];
        if (existing) return { purchase: { invoiceId: existing, status: invoices[existing] }, invoice: { id: existing, status: invoices[existing], amountCents: sku.priceCents, currency: "BRL" } };
        const id = `inv-${++invoiceSeq}`; invoices[id] = "PENDING_PAYMENT"; idemKeys[key] = id;
        if (failNextPost) { failNextPost = false; throw new Error("Erro interno (500)"); }
        return { purchase: { invoiceId: id, status: "PENDING_PAYMENT" }, invoice: { id, status: "PENDING_PAYMENT", amountCents: sku.priceCents, currency: "BRL" } };
      }
      return { sku, purchases: Object.entries(invoices).map(([invoiceId, status]) => ({ invoiceId, status })) };
    }
    if (path.endsWith("/charge")) {
      const id = path.split("/")[3];
      chargeCalls.push(id);
      if (failNextCharge) { failNextCharge = false; throw new Error("Fatura não está pendente (404)"); }
      return { charge: { id: `pix-${id}`, status: "pending", qr_code: "qr-value", ticket_url: "https://pay.test" } };
    }
    return {};
  });
}

const postPacks = () => api.mock.calls.filter(([p, init]) => p === "/billing/ai-credit-packs" && (init as RequestInit | undefined)?.method === "POST");

beforeEach(() => { cleanup(); api.mockReset(); canManage = true; uuidSeq = 0; failNextCharge = false; failNextPost = false; });

describe("usage page AI credit packs flow", () => {
  it("starts a new invoice and idempotency key after a purchase is confirmed (webhook GRANTED)", async () => {
    mockApi();
    render(<UsoBody />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Comprar pacote" }));
    await screen.findByRole("button", { name: "Verificar status agora" });
    expect(postPacks()).toHaveLength(1);
    invoices["inv-1"] = "GRANTED";
    await user.click(screen.getByRole("button", { name: "Verificar status agora" }));
    await screen.findByRole("button", { name: "Comprar outro pacote" });
    expect(screen.getByText("Pagamento confirmado — créditos disponíveis no saldo.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Verificar status agora" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Comprar outro pacote" }));
    await screen.findByRole("button", { name: "Verificar status agora" });
    const posts = postPacks();
    expect(posts).toHaveLength(2);
    const keys = posts.map(([, init]) => JSON.parse((init as RequestInit).body as string).idempotencyKey);
    expect(keys).toEqual(["uuid-1", "uuid-2"]);
    expect(chargeCalls).toEqual(["inv-1", "inv-2"]);
  });

  it("retries the same invoice and idempotency key when the charge call fails", async () => {
    mockApi();
    failNextCharge = true;
    render(<UsoBody />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Comprar pacote" }));
    await screen.findByText(/não está pendente/i);
    expect(screen.getByRole("alert")).toHaveTextContent("Fatura não está pendente (404)");
    await user.click(screen.getByRole("button", { name: "Gerar PIX novamente (mesma fatura)" }));
    await screen.findByRole("button", { name: "Verificar status agora" });
    const posts = postPacks();
    expect(posts).toHaveLength(1);
    expect(JSON.parse((posts[0][1] as RequestInit).body as string).idempotencyKey).toBe("uuid-1");
    expect(chargeCalls).toEqual(["inv-1", "inv-1"]);
  });

  it("reuses the same idempotency key when the purchase POST fails after committing (500)", async () => {
    mockApi();
    failNextPost = true;
    render(<UsoBody />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Comprar pacote" }));
    await screen.findByText("Erro interno (500)");
    expect(Object.keys(invoices)).toEqual(["inv-1"]);
    await user.click(screen.getByRole("button", { name: "Comprar pacote" }));
    await screen.findByRole("button", { name: "Verificar status agora" });
    const posts = postPacks();
    expect(posts).toHaveLength(2);
    const keys = posts.map(([, init]) => JSON.parse((init as RequestInit).body as string).idempotencyKey);
    expect(keys).toEqual(["uuid-1", "uuid-1"]);
    expect(chargeCalls).toEqual(["inv-1"]);
    expect(Object.keys(invoices)).toEqual(["inv-1"]);
  });

  it("ignores a concurrent second click while the first purchase is in flight", async () => {
    mockApi();
    render(<UsoBody />);
    const button = await screen.findByRole("button", { name: "Comprar pacote" });
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Verificar status agora" });
    expect(postPacks()).toHaveLength(1);
    expect(chargeCalls).toEqual(["inv-1"]);
  });

  it("does not post anything for viewers without billing.manage", async () => {
    mockApi();
    canManage = false;
    render(<UsoBody />);
    expect(await screen.findByText("Histórico mensal")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Comprar pacote" })).toBeNull();
    expect(api.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== "POST")).toBe(true);
  });

  it("keeps the page up when optional APIs fail and labels INTERACTION/CREDIT correctly", async () => {
    mockApi({ usageUnit: "INTERACTION", failOptional: true });
    const first = render(<UsoBody />);
    expect(await screen.findByText("Interações acumuladas")).toBeTruthy();
    expect(screen.getByText(/Bônus restante: .*\(inclui pacotes comprados no período\)/)).toBeTruthy();
    expect(screen.getByText(/Pacotes comprados: — .* já está contado no bônus restante acima/)).toBeTruthy();
    expect(screen.queryByText("Consumo de IA")).toBeNull();
    first.unmount(); cleanup();
    mockApi();
    render(<UsoBody />);
    expect(await screen.findByText("Créditos de IA do período")).toBeTruthy();
  });
});
