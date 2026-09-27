import { EventEmitter } from "node:events";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redis falso: cada createClient devolve um emissor com connect/subscribe/quit.
type FakeRedis = EventEmitter & { isReady: boolean; connect: () => Promise<void>; subscribe: () => Promise<void>; quit: () => Promise<void>; publish: () => Promise<number> };
const redisClients: FakeRedis[] = [];
vi.mock("redis", () => ({
  createClient: () => {
    const client = Object.assign(new EventEmitter(), {
      isReady: false,
      connect: async () => { client.isReady = true; },
      subscribe: async () => undefined,
      quit: async () => { client.isReady = false; },
      publish: async () => 1
    }) as FakeRedis;
    redisClients.push(client);
    return client;
  }
}));

const { RealtimeCoordinator } = await import("../src/modules/realtime/coordinator.js");

type FakePgClient = EventEmitter & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
function fakePool(listen: () => Promise<unknown> = async () => undefined) {
  const clients: FakePgClient[] = [];
  const pool = {
    connect: vi.fn(async () => {
      const client = Object.assign(new EventEmitter(), { query: vi.fn(listen), release: vi.fn() }) as FakePgClient;
      clients.push(client);
      return client;
    }),
    query: vi.fn(async () => ({ rows: [] }))
  };
  return { pool: pool as unknown as pg.Pool, clients, connect: pool.connect };
}
const log = { warn: vi.fn(), info: vi.fn() };

beforeEach(() => {
  redisClients.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("RealtimeCoordinator — conexões (ORG C7, C8)", () => {
  it("devolve ao pool (destruindo) o cliente do LISTEN que caiu, antes de reconectar", async () => {
    const { pool, clients, connect } = fakePool();
    const coordinator = new RealtimeCoordinator(pool, "redis://fake", log);
    await coordinator.ensureStarted();
    expect(clients).toHaveLength(1);

    const failure = new Error("terminating connection due to administrator command");
    clients[0].emit("error", failure);
    clients[0].emit("error", failure); // erro repetido não pode liberar duas vezes (pg-pool lança)
    expect(clients[0].release).toHaveBeenCalledTimes(1);
    expect(clients[0].release).toHaveBeenCalledWith(failure);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect).toHaveBeenCalledTimes(2);
    await coordinator.stop();
  });

  it("devolve o cliente quando o próprio LISTEN falha", async () => {
    const { pool, clients } = fakePool(async () => { throw new Error("LISTEN failed"); });
    const coordinator = new RealtimeCoordinator(pool, "redis://fake", log);
    await coordinator.ensureStarted();
    expect(clients[0].release).toHaveBeenCalledTimes(1);
    await coordinator.stop();
  });

  it("queda DURANTE o LISTEN (erro emitido e query rejeitada) libera uma vez só e não derruba o processo (Ponytail #1)", async () => {
    let failListen = true;
    const clients: FakePgClient[] = [];
    const pool = {
      connect: vi.fn(async () => {
        const client = Object.assign(new EventEmitter(), { release: vi.fn(() => { if (client.release.mock.calls.length > 1) throw new Error("Release called on client which has already been released to the pool."); }) }) as unknown as FakePgClient;
        client.query = vi.fn(async () => {
          if (!failListen) return undefined;
          const error = new Error("Connection terminated unexpectedly");
          client.emit("error", error);
          throw error;
        });
        clients.push(client);
        return client;
      }),
      query: vi.fn(async () => ({ rows: [] }))
    } as unknown as pg.Pool;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const coordinator = new RealtimeCoordinator(pool, "redis://fake", log);
      await expect(coordinator.ensureStarted()).resolves.toBeUndefined();
      expect(clients[0].release).toHaveBeenCalledTimes(1);
      // Erro tardio no cliente já devolvido não pode virar exceção sem listener.
      expect(() => clients[0].emit("error", new Error("late"))).not.toThrow();
      failListen = false;
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(clients).toHaveLength(2);
      expect(unhandled).not.toHaveBeenCalled();
      await coordinator.stop();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("erro no Redis pub/sub agenda reconexão sem depender de nova aba", async () => {
    const { pool } = fakePool();
    const coordinator = new RealtimeCoordinator(pool, "redis://fake", log);
    await coordinator.ensureStarted();
    expect(redisClients).toHaveLength(2);

    const subscriber = redisClients[1];
    subscriber.isReady = false;
    subscriber.emit("error", new Error("Socket closed unexpectedly"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(redisClients.length).toBeGreaterThan(2);
    await coordinator.stop();
  });
});
