const FAILURE_WINDOW_MS = 15 * 60_000;
const OPEN_WINDOW_MS = 5 * 60_000;
const FAILURE_THRESHOLD = 5;

export interface CircuitBreakerRedis {
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<number>;
  set(key: string, value: string, mode: "PX", milliseconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

export class EvaluatorCircuitOpenError extends Error {
  constructor() {
    super("Evaluator circuit breaker is open");
    this.name = "EvaluatorCircuitOpenError";
  }
}

export class EvaluatorCircuitBreaker {
  constructor(private readonly redis: () => Promise<CircuitBreakerRedis>) {}

  private failureKey(tenantId: string): string {
    return `atendon:evaluator:circuit:${tenantId}:failures`;
  }

  private openKey(tenantId: string): string {
    return `atendon:evaluator:circuit:${tenantId}:open`;
  }

  async assertAvailable(tenantId: string): Promise<void> {
    const client = await this.redis();
    if (await client.get(this.openKey(tenantId))) throw new EvaluatorCircuitOpenError();
  }

  async recordSuccess(tenantId: string): Promise<void> {
    const client = await this.redis();
    await client.del(this.failureKey(tenantId), this.openKey(tenantId));
  }

  async recordFailure(tenantId: string): Promise<{ failures: number; opened: boolean }> {
    const client = await this.redis();
    const failureKey = this.failureKey(tenantId);
    const failures = await client.incr(failureKey);
    await client.pexpire(failureKey, FAILURE_WINDOW_MS);
    const opened = failures >= FAILURE_THRESHOLD;
    if (opened) await client.set(this.openKey(tenantId), "1", "PX", OPEN_WINDOW_MS);
    return { failures, opened };
  }
}
