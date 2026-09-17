// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api }));
vi.mock("../components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
import BillingAdminPage from "../app/root/saas/billing/page";
const root = { user: { id: "r", email: "r@test", isRoot: true }, activeWorkspace: null, workspaces: [], permissions: [], actorScope: "root" };
function setup() { api.mockImplementation(async (path: string) => path === "/me" ? root : path.includes("dunning") ? { attempts: [{ id: "a1", status: "FAILED" }] } : { coupons: [], entries: [], signals: [], findings: [] }); return render(<SWRConfig value={{ provider: () => new Map() }}><BillingAdminPage /></SWRConfig>); }
describe("ROOT billing operations page", () => {
 beforeEach(() => { cleanup(); api.mockReset(); });
 it("renders real billing sections and states", async () => { setup(); expect(await screen.findByRole("heading", { name: "Operações de billing" })).toBeVisible(); expect(screen.getByText("dunning")).toBeVisible(); expect(screen.getByText("ledger")).toBeVisible(); expect(screen.getByText("fraud")).toBeVisible(); expect(screen.getByText("reconciliation")).toBeVisible(); await waitFor(() => expect(screen.getByText("FAILED")).toBeVisible()); expect(screen.queryByRole("button", { name: /reembolso remoto|refund remoto/i })).not.toBeInTheDocument(); });
 it("shows coupon creation controls without claiming remote refunds", async () => { setup(); await screen.findByRole("heading", { name: "Operações de billing" }); await screen.getByRole("button", { name: "coupons" }).click(); expect(screen.getByPlaceholderText("Código")).toBeVisible(); expect(screen.getByRole("button", { name: "Criar cupom" })).toBeVisible(); expect(screen.queryByText(/reembolso remoto/i)).not.toBeInTheDocument(); });
});
