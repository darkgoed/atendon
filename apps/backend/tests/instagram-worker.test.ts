import { afterEach, describe, expect, it, vi } from "vitest";
import { InstagramWorkerScheduler } from "../src/modules/instagram/index.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Instagram worker scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts drain and refresh immediately, repeats them, and cancels both timers on shutdown", async () => {
    vi.useFakeTimers();
    const listActiveTenants = vi.fn(async () => ["tenant-a"]);
    const drainTenant = vi.fn(async () => 1);
    const refreshDueTokens = vi.fn(async () => ({ refreshed: 1, revoked: 0, failed: 0 }));
    const scheduler = new InstagramWorkerScheduler({
      listActiveTenants,
      drainTenant,
      refreshDueTokens
    });

    scheduler.start({ drainMs: 100, refreshMs: 200 });
    await vi.advanceTimersByTimeAsync(0);
    expect(listActiveTenants).toHaveBeenCalledTimes(1);
    expect(drainTenant).toHaveBeenCalledTimes(1);
    expect(refreshDueTokens).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(listActiveTenants).toHaveBeenCalledTimes(3);
    expect(drainTenant).toHaveBeenCalledTimes(3);
    expect(refreshDueTokens).toHaveBeenCalledTimes(2);

    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listActiveTenants).toHaveBeenCalledTimes(3);
    expect(refreshDueTokens).toHaveBeenCalledTimes(2);
  });

  it("serializes durable inbox drains and waits for an active drain during shutdown", async () => {
    const gate = deferred();
    const drainTenant = vi.fn(async (tenantId: string) => {
      void tenantId;
      await gate.promise;
      return 1;
    });
    const scheduler = new InstagramWorkerScheduler({
      listActiveTenants: async () => ["tenant-a", "tenant-b"],
      drainTenant,
      refreshDueTokens: async () => ({ refreshed: 0, revoked: 0, failed: 0 })
    });

    const first = scheduler.runDrain();
    const overlapping = scheduler.runDrain();
    await vi.waitFor(() => expect(drainTenant).toHaveBeenCalledTimes(1));
    const shutdown = scheduler.stop();
    let stopped = false;
    void shutdown.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    gate.resolve();
    await Promise.all([first, overlapping, shutdown]);
    expect(drainTenant).toHaveBeenCalledTimes(2);
    expect(drainTenant.mock.calls.map(([tenantId]) => tenantId)).toEqual(["tenant-a", "tenant-b"]);
  });

  it("coalesces overlapping token refresh runs", async () => {
    const gate = deferred();
    const refreshDueTokens = vi.fn(async () => {
      await gate.promise;
      return { refreshed: 1, revoked: 0, failed: 0 };
    });
    const scheduler = new InstagramWorkerScheduler({
      listActiveTenants: async () => [],
      drainTenant: async () => 0,
      refreshDueTokens
    });

    const first = scheduler.runRefresh();
    const overlapping = scheduler.runRefresh();
    await vi.waitFor(() => expect(refreshDueTokens).toHaveBeenCalledTimes(1));
    gate.resolve();
    await Promise.all([first, overlapping]);
    expect(refreshDueTokens).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });
});
