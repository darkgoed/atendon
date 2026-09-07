// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api }));
vi.mock("../components/shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));

import MetricsPage from "../app/root/saas/metricas/page";

const rootSession = { user: { id: "root", email: "root@example.com", isRoot: true, name: "Root" }, activeWorkspace: null, workspaces: [], permissions: [], actorScope: "root" };

function setup() {
  api.mockImplementation(async (path: string) => {
    if (path === "/me") return rootSession;
    if (path === "/root/billing/metrics") return {
      metrics: [
        { tenantId: "tenant-a", planId: "plan-a", month: "2026-08", includedGranted: 100, includedUsed: 80, rolloverGenerated: 0, rolloverUsed: 0, rolloverExpired: 0, bonusGranted: 0, bonusUsed: 0, overageInteractions: 2, overageRevenueCents: 1000, providerCostUsdMicros: 0, providerCostBrlCents: 300 },
        { tenantId: "tenant-a", planId: "plan-a", month: "2026-09", includedGranted: 100, includedUsed: 90, rolloverGenerated: 0, rolloverUsed: 0, rolloverExpired: 0, bonusGranted: 0, bonusUsed: 0, overageInteractions: 1, overageRevenueCents: 500, providerCostUsdMicros: 0, providerCostBrlCents: 200 },
        { tenantId: "tenant-b", planId: "plan-b", month: "2026-09", includedGranted: 100, includedUsed: 70, rolloverGenerated: 0, rolloverUsed: 0, rolloverExpired: 0, bonusGranted: 0, bonusUsed: 0, overageInteractions: 2, overageRevenueCents: 1000, providerCostUsdMicros: 0, providerCostBrlCents: 200 },
      ],
    };
    throw new Error(`Unexpected API path: ${path}`);
  });
  return render(<SWRConfig value={{ provider: () => new Map() }}><MetricsPage /></SWRConfig>);
}

describe("root SaaS metrics", () => {
  beforeEach(() => { cleanup(); api.mockReset(); });

  it("loads the billing metrics contract and renders its aggregate", async () => {
    setup();

    await waitFor(() => expect(api).toHaveBeenCalledWith("/root/billing/metrics"));
    expect(await screen.findByText(/R\$\s25,00/)).toBeTruthy();
    expect(screen.getByText(/R\$\s7,00/)).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });
});
