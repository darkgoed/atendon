import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { InstagramRepository } from "../src/modules/instagram/repository.js";
import { InstagramService } from "../src/modules/instagram/service.js";
import type { InstagramProvider } from "../src/modules/instagram/types.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const key = "instagram-refresh-service-key-00000000000000";
const tenantIds: string[] = [];

async function tenant(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Instagram refresh ${randomUUID()}`]
  );
  tenantIds.push(result.rows[0].id);
  return result.rows[0].id;
}

function provider(refreshAccessToken: InstagramProvider["refreshAccessToken"]): InstagramProvider {
  return {
    exchangeOAuthCode: vi.fn(),
    refreshAccessToken,
    subscribeWebhook: vi.fn(),
    sendText: vi.fn(),
    sendMedia: vi.fn(),
    fetchMedia: vi.fn()
  };
}

describe("Instagram due token refresh service", () => {
  beforeAll(async () => {
    await pool.query("SELECT 1");
  });

  afterAll(async () => {
    if (tenantIds.length > 0) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenantIds]);
    await pool.end();
  });

  it("refreshes only due active tokens", async () => {
    const tenantId = await tenant();
    const repository = new InstagramRepository(pool, key);
    const due = await repository.saveConnection({
      tenantId,
      label: "Due",
      accountId: `account-${randomUUID()}`,
      accessToken: "due-token",
      expiresAt: new Date(Date.now() + 60_000)
    });
    await repository.saveConnection({
      tenantId,
      label: "Not due",
      accountId: `account-${randomUUID()}`,
      accessToken: "later-token",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    });
    const refresh = vi.fn(async () => ({
      accessToken: "rotated-token",
      expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)
    }));
    const service = new InstagramService(repository, provider(refresh));

    await expect(service.refreshDueTokens(new Date(Date.now() + 24 * 60 * 60 * 1000))).resolves.toEqual({
      refreshed: 1,
      revoked: 0,
      failed: 0
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await expect(repository.getToken(tenantId, due.id)).resolves.toBe("rotated-token");
  });

  it("invalidates a provider-revoked connection and never selects it again", async () => {
    const tenantId = await tenant();
    const repository = new InstagramRepository(pool, key);
    const connection = await repository.saveConnection({
      tenantId,
      label: "Revoked",
      accountId: `account-${randomUUID()}`,
      accessToken: "revoked-token",
      expiresAt: new Date(Date.now() + 60_000)
    });
    const rejected = vi.fn(async () => {
      throw Object.assign(new Error("Meta rejected refresh"), { status: 401 });
    });
    const service = new InstagramService(repository, provider(rejected));

    await expect(service.refreshDueTokens(new Date(Date.now() + 24 * 60 * 60 * 1000))).resolves.toEqual({
      refreshed: 0,
      revoked: 1,
      failed: 0
    });
    await expect(repository.getToken(tenantId, connection.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(repository.refreshDueTokens(new Date(Date.now() + 24 * 60 * 60 * 1000))).resolves.toEqual([]);
    expect((await pool.query(
      "SELECT status,reconnect_required,credentials_encrypted FROM whatsapp_sessions WHERE id=$1",
      [connection.id]
    )).rows[0]).toEqual({ status: "disconnected", reconnect_required: true, credentials_encrypted: null });
  });

  it("does not overwrite a reauthorized token with a stale refresh result", async () => {
    const tenantId = await tenant();
    const repository = new InstagramRepository(pool, key);
    const accountId = `account-${randomUUID()}`;
    const connection = await repository.saveConnection({
      tenantId,
      label: "Concurrent refresh",
      accountId,
      accessToken: "old-token",
      expiresAt: new Date(Date.now() + 60_000)
    });
    let notifyStarted: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let resolveRefresh: (value: { accessToken: string; expiresAt: Date }) => void = () => undefined;
    const providerResult = new Promise<{ accessToken: string; expiresAt: Date }>((resolve) => {
      resolveRefresh = resolve;
    });
    const refresh = vi.fn(async () => {
      notifyStarted?.();
      return providerResult;
    });
    const service = new InstagramService(repository, provider(refresh));
    const inFlight = service.refresh(tenantId, connection.id);
    await refreshStarted;
    await repository.saveConnection({
      tenantId,
      id: connection.id,
      label: "Reauthorized",
      accountId,
      accessToken: "new-oauth-token",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    });
    resolveRefresh({
      accessToken: "stale-refreshed-token",
      expiresAt: new Date(Date.now() + 180_000)
    });

    await expect(inFlight).rejects.toMatchObject({ code: "INSTAGRAM_REFRESH_STALE" });
    await expect(repository.getToken(tenantId, connection.id)).resolves.toBe("new-oauth-token");
  });

  it("does not revoke a reauthorized token after a stale provider rejection", async () => {
    const tenantId = await tenant();
    const repository = new InstagramRepository(pool, key);
    const accountId = `account-${randomUUID()}`;
    const connection = await repository.saveConnection({
      tenantId,
      label: "Concurrent rejection",
      accountId,
      accessToken: "old-token",
      expiresAt: new Date(Date.now() + 60_000)
    });
    let rejectRefresh: ((error: Error) => void) | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const providerResult = new Promise<{ accessToken: string; expiresAt: Date }>((_resolve, reject) => {
      rejectRefresh = reject;
    });
    const refresh = vi.fn(async () => {
      notifyStarted?.();
      return providerResult;
    });
    const service = new InstagramService(repository, provider(refresh));
    const inFlight = service.refresh(tenantId, connection.id);
    await started;
    await repository.saveConnection({
      tenantId,
      id: connection.id,
      label: "Reauthorized",
      accountId,
      accessToken: "new-oauth-token",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    });
    rejectRefresh?.(Object.assign(new Error("old token rejected"), { status: 401 }));

    await expect(inFlight).rejects.toMatchObject({ code: "INSTAGRAM_REFRESH_STALE" });
    await expect(repository.getToken(tenantId, connection.id)).resolves.toBe("new-oauth-token");
  });

  it("keeps an ambiguous refresh active for explicit retry without changing its token", async () => {
    const tenantId = await tenant();
    const repository = new InstagramRepository(pool, key);
    const connection = await repository.saveConnection({
      tenantId,
      label: "Ambiguous",
      accountId: `account-${randomUUID()}`,
      accessToken: "original-token",
      expiresAt: new Date(Date.now() + 60_000)
    });
    const ambiguous = vi.fn(async () => {
      throw new Error("network timeout");
    });
    const service = new InstagramService(repository, provider(ambiguous));

    await expect(service.refreshDueTokens(new Date(Date.now() + 24 * 60 * 60 * 1000))).resolves.toEqual({
      refreshed: 0,
      revoked: 0,
      failed: 1
    });
    await expect(repository.getToken(tenantId, connection.id)).resolves.toBe("original-token");
  });
});
