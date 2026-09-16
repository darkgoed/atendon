export interface InstagramWorkerRefreshResult {
  refreshed: number;
  revoked: number;
  failed: number;
}

export interface InstagramWorkerSchedulerDependencies {
  listActiveTenants(): Promise<string[]>;
  drainTenant(tenantId: string): Promise<number>;
  refreshDueTokens(): Promise<InstagramWorkerRefreshResult>;
  onDrain?(tenantId: string, drained: number): void;
  onRefresh?(result: InstagramWorkerRefreshResult): void;
  onError?(operation: "drain" | "refresh", error: unknown): void;
}

export interface InstagramWorkerSchedulerIntervals {
  drainMs?: number;
  refreshMs?: number;
}

export class InstagramWorkerScheduler {
  private drainInFlight: Promise<void> | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly dependencies: InstagramWorkerSchedulerDependencies) {}

  runDrain(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.drainInFlight) return this.drainInFlight;
    const run = (async () => {
      const tenants = await this.dependencies.listActiveTenants();
      for (const tenantId of tenants) {
        const drained = await this.dependencies.drainTenant(tenantId);
        this.dependencies.onDrain?.(tenantId, drained);
      }
    })();
    this.drainInFlight = run.finally(() => {
      this.drainInFlight = null;
    });
    return this.drainInFlight;
  }

  runRefresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.refreshInFlight) return this.refreshInFlight;
    const run = this.dependencies.refreshDueTokens().then((result) => {
      this.dependencies.onRefresh?.(result);
    });
    this.refreshInFlight = run.finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  start(intervals: InstagramWorkerSchedulerIntervals = {}): void {
    if (this.stopped || this.drainTimer || this.refreshTimer) return;
    const reportDrainError = (error: unknown): void => this.dependencies.onError?.("drain", error);
    const reportRefreshError = (error: unknown): void => this.dependencies.onError?.("refresh", error);
    void this.runDrain().catch(reportDrainError);
    void this.runRefresh().catch(reportRefreshError);
    this.drainTimer = setInterval(() => {
      void this.runDrain().catch(reportDrainError);
    }, intervals.drainMs ?? 5_000);
    this.refreshTimer = setInterval(() => {
      void this.runRefresh().catch(reportRefreshError);
    }, intervals.refreshMs ?? 6 * 60 * 60 * 1_000);
    this.drainTimer.unref();
    this.refreshTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.drainTimer) clearInterval(this.drainTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.drainTimer = null;
    this.refreshTimer = null;
    await Promise.allSettled([
      this.drainInFlight ?? Promise.resolve(),
      this.refreshInFlight ?? Promise.resolve()
    ]);
  }
}
