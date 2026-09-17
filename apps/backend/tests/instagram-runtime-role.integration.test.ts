import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { InstagramOAuthStore, createOAuthState } from "../src/modules/instagram/oauth.js";
import { InstagramRepository } from "../src/modules/instagram/repository.js";
import { InstagramService } from "../src/modules/instagram/service.js";
import { verifyChallenge } from "../src/modules/instagram/provider.js";
import type { InstagramProvider, NormalizedInstagramEvent } from "../src/modules/instagram/types.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const key = "instagram-runtime-role-key-000000000000000";
const roleName = `atendon_runtime_test_${randomUUID().replaceAll("-", "")}`;
const quotedRole = `"${roleName}"`;
const tenantIds: string[] = [];

function roleDatabase(): Pick<pg.Pool, "connect" | "query"> {
  return {
    async query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${quotedRole}`);
        const result = await client.query<T>(text, values);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async connect() {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === "query") {
            return async (text: string, values?: unknown[]) => {
              const result = await target.query(text, values);
              if (/^\s*BEGIN\b/i.test(text)) await target.query(`SET LOCAL ROLE ${quotedRole}`);
              return result;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }
  } as unknown as Pick<pg.Pool, "connect" | "query">;
}

async function tenant(name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`${name}-${randomUUID()}`]
  );
  tenantIds.push(result.rows[0].id);
  return result.rows[0].id;
}

function messageEvent(accountId: string, contactId: string): NormalizedInstagramEvent {
  const eventId = `mid-${randomUUID()}`;
  return {
    kind: "message",
    eventId,
    accountId,
    providerUserId: contactId,
    timestamp: new Date(),
    text: "runtime role",
    isEcho: false,
    raw: { message: { mid: eventId, text: "runtime role" } }
  };
}

describe("Instagram foundation under the real runtime PostgreSQL role shape", () => {
  beforeAll(async () => {
    await pool.query(
      `CREATE ROLE ${quotedRole}
       LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
    );
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${quotedRole}`);
    await pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${quotedRole}`);
    await pool.query(`GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${quotedRole}`);
  });

  afterAll(async () => {
    if (tenantIds.length > 0) {
      await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenantIds]);
    }
    await pool.query(`DROP OWNED BY ${quotedRole}`);
    await pool.query(`DROP ROLE ${quotedRole}`);
    await pool.end();
  });

  it("keeps tenant RLS closed while OAuth, webhook, media and worker lookups run as runtime", async () => {
    const attributes = (await pool.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolinherit: boolean;
      rolbypassrls: boolean;
    }>("SELECT rolcanlogin,rolsuper,rolinherit,rolbypassrls FROM pg_roles WHERE rolname=$1", [roleName])).rows[0];
    expect(attributes).toEqual({
      rolcanlogin: true,
      rolsuper: false,
      rolinherit: false,
      rolbypassrls: false
    });

    const database = roleDatabase();
    const repository = new InstagramRepository(database, key);
    const oauth = new InstagramOAuthStore(database);
    const tenantA = await tenant("instagram-runtime-a");
    const tenantB = await tenant("instagram-runtime-b");
    const userId = (await pool.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
      [`instagram-runtime-${randomUUID()}@test.local`]
    )).rows[0].id;
    const oauthState = createOAuthState();
    await oauth.create({
      tenantId: tenantA,
      userId,
      sessionVersion: 1,
      state: oauthState.state,
      browserNonce: oauthState.browserNonce,
      redirectUri: "https://panel.example.test/backend/instagram/oauth/callback",
      label: "Runtime OAuth"
    });
    await expect(oauth.consume({
      tenantId: tenantA,
      userId,
      sessionVersion: 1,
      state: oauthState.state,
      browserNonce: oauthState.browserNonce,
      redirectUri: "https://panel.example.test/backend/instagram/oauth/callback"
    })).resolves.toMatchObject({ tenantId: tenantA, label: "Runtime OAuth" });
    expect(verifyChallenge({ mode: "subscribe", token: "runtime-verify", challenge: "ok" }, "runtime-verify"))
      .toBe("ok");

    const accountA = `account-${randomUUID()}`;
    const accountB = `account-${randomUUID()}`;
    const provider: InstagramProvider = {
      exchangeOAuthCode: vi.fn(async () => ({
        accountId: accountA,
        username: "runtime_a",
        accessToken: "oauth-token-a",
        tokenExpiresAt: new Date(Date.now() + 60_000),
        scopes: ["instagram_business_basic", "instagram_business_manage_messages"]
      })),
      subscribeWebhook: vi.fn(async () => undefined),
      refreshAccessToken: vi.fn(async ({ accessToken }) => ({
        accessToken: `${accessToken}-refreshed`,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      })),
      sendText: vi.fn(),
      sendMedia: vi.fn(),
      fetchUserProfile: vi.fn(),
      fetchMedia: vi.fn()
    };
    const service = new InstagramService(repository, provider);
    await service.connectOAuth({
      tenantId: tenantA,
      label: "Runtime A",
      code: "oauth-code",
      redirectUri: "https://panel.example.test/backend/instagram/oauth/callback"
    });
    const ownerA = await repository.resolveAccount(accountA);
    expect(ownerA).toMatchObject({ tenantId: tenantA });
    const connectionB = await repository.saveConnection({
      tenantId: tenantB,
      label: "Runtime B",
      accountId: accountB,
      accessToken: "oauth-token-b",
      expiresAt: new Date(Date.now() + 60_000)
    });
    await expect(repository.resolveAccount(accountB)).resolves.toEqual({
      tenantId: tenantB,
      sessionId: connectionB.id
    });
    await expect(repository.listActiveTenants()).resolves.toEqual([tenantA, tenantB].sort());

    const event = messageEvent(accountA, `igsid-${randomUUID()}`);
    const persisted = await repository.persistEvent(
      tenantA,
      ownerA!.sessionId,
      event,
      Buffer.from('{"runtime":true}')
    );
    await expect(repository.persistEvent(
      tenantB,
      ownerA!.sessionId,
      event,
      Buffer.from('{"crossTenant":true}')
    )).rejects.toMatchObject({ code: "INSTAGRAM_CONNECTION_NOT_FOUND" });
    await expect(repository.claimInbox(tenantB)).resolves.toEqual([]);

    const media = await repository.savePublicMedia({
      tenantId: tenantA,
      sessionId: ownerA!.sessionId,
      conversationId: persisted.conversationId,
      bytes: Buffer.from("runtime-media-bytes"),
      contentType: "image/jpeg",
      expiresAt: new Date(Date.now() + 60_000)
    });
    await expect(database.query("SELECT id FROM instagram_media")).resolves.toMatchObject({ rows: [] });
    const wrongTenant = await pool.connect();
    try {
      await wrongTenant.query("BEGIN");
      await wrongTenant.query(`SET LOCAL ROLE ${quotedRole}`);
      await wrongTenant.query(`SET LOCAL app.tenant_id='${tenantB}'`);
      expect((await wrongTenant.query("SELECT id FROM instagram_media WHERE id=$1", [media.id])).rows).toEqual([]);
      await wrongTenant.query(`SET LOCAL app.tenant_id='${tenantA}'`);
      expect((await wrongTenant.query("SELECT id FROM instagram_media WHERE id=$1", [media.id])).rows)
        .toEqual([{ id: media.id }]);
      await wrongTenant.query("ROLLBACK");
    } finally {
      wrongTenant.release();
    }

    await expect(repository.getPublicMedia(media.id)).rejects.toMatchObject({ code: "42501" });
    const roleProvisioning = await readFile(
      new URL("../../../deploy/postgres/provision-roles.sh", import.meta.url),
      "utf8"
    );
    expect(roleProvisioning).toContain(
      "GRANT EXECUTE ON FUNCTION public.get_signed_instagram_public_media(uuid) TO %I"
    );
    expect(roleProvisioning).toContain(":'runtime_role'");
    await pool.query(
      `GRANT EXECUTE ON FUNCTION public.get_signed_instagram_public_media(uuid) TO ${quotedRole}`
    );
    await expect(repository.getPublicMedia(media.id)).resolves.toMatchObject({
      id: media.id,
      contentType: "image/jpeg",
      sizeBytes: 19
    });

    await expect(service.refreshDueTokens(new Date(Date.now() + 24 * 60 * 60 * 1000))).resolves.toEqual({
      refreshed: 2,
      revoked: 0,
      failed: 0
    });
    expect(provider.refreshAccessToken).toHaveBeenCalledTimes(2);
    await expect(repository.listActiveTenants()).resolves.toEqual([tenantA, tenantB].sort());
  });
});
