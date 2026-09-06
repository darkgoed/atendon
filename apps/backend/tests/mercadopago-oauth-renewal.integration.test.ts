import { describe, expect, it, vi } from "vitest";
import { runOAuthTokenRenewalBatch } from "../src/billing/mercadopago-renewal.js";

describe("Mercado Pago OAuth token renewal batch", () => {
  it("refreshes only selected providers and continues after a provider failure", async () => {
    const refresh = vi.fn(async (code: string) => {
      if (code === "expiring-fails") throw new Error("temporary failure");
    });
    const pool = { query: vi.fn(async () => ({ rows: [
      { code: "expiring-fails", environment: "sandbox" },
      { code: "expiring-ok", environment: "production" },
    ], rowCount: 2 })) };

    await runOAuthTokenRenewalBatch(pool, fetch, refresh);

    expect(refresh).toHaveBeenCalledWith("expiring-fails", "sandbox", fetch);
    expect(refresh).toHaveBeenCalledWith("expiring-ok", "production", fetch);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("token_expires_at IS NOT NULL"), [24 * 60 * 60 * 1000]);
  });

  it("does not refresh providers outside the window or permanent tokens", async () => {
    const refresh = vi.fn(async () => undefined);
    const query = vi.fn(async (...args: unknown[]) => { void args; return { rows: [], rowCount: 0 }; });
    const pool = { query };

    await runOAuthTokenRenewalBatch(pool, fetch, refresh);

    expect(refresh).not.toHaveBeenCalled();
    expect(query.mock.calls[0]?.[0]).toContain("status='CONNECTED'");
    expect(query.mock.calls[0]?.[0]).toContain("token_expires_at <= now()");
  });
});
