// W2A — R4 Armazenamento da empresa (migration 0173, storage.ts, rotas
// /organization/storage). Cobre: bloqueio de upload ao estourar quota (413 via
// logo), soma real do uso (recalculate via GET), persistência do PATCH de
// settings, tenancy (A não vê nem afeta B), primitiva reserveStorageBytes e
// retenção diária (runStorageRetention) com limpeza de referências.
import { randomBytes, randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { seedTenantCapabilities } from "./helpers/capability-seed.js";
import { withTenantTransaction } from "../src/db/tenant-transaction.js";
import {
  reserveStorageBytes,
  runStorageRetention,
  storageQuotaExceededError
} from "../src/modules/organization/storage.js";

const password = "storage-quota-password";
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
let tenantA = "";
let tenantB = "";
let ownerA = "";
let ownerB = "";
let operatorA = "";
const emails = new Map<string, string>();
const cookies = new Map<string, string>();

function logoDataUrl(bytes: number): string {
  return `data:image/png;base64,${randomBytes(bytes).toString("base64")}`;
}

async function loginAs(userId: string) {
  const cached = cookies.get(userId);
  if (cached) return cached;
  const email = emails.get(userId)!;
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(response.statusCode).toBe(200);
  const cookie = (Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"][0] : response.headers["set-cookie"]!).split(";")[0];
  cookies.set(userId, cookie);
  return cookie;
}

async function createUser(client: pg.PoolClient, tenantId: string, roleId: string, email: string) {
  const user = await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [email, await hash(password, 4)]);
  await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())", [tenantId, user.rows[0].id, roleId]);
  emails.set(user.rows[0].id, email);
  return user.rows[0].id;
}

async function roleIdOf(client: pg.PoolClient, tenantId: string, name: string) {
  return (await client.query<{ id: string }>("SELECT id FROM workspace_roles WHERE workspace_id=$1 AND name=$2", [tenantId, name])).rows[0].id;
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantA = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Storage A ${randomUUID()}`])).rows[0].id;
    tenantB = (await client.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Storage B ${randomUUID()}`])).rows[0].id;
    await seedTenantCapabilities(client, [tenantA, tenantB]);
    await ensureWorkspaceDefaultRoles(client, tenantA);
    await ensureWorkspaceDefaultRoles(client, tenantB);
    ownerA = await createUser(client, tenantA, await roleIdOf(client, tenantA, "OWNER"), `sq-a-owner-${randomUUID()}@test.local`);
    operatorA = await createUser(client, tenantA, await roleIdOf(client, tenantA, "OPERADOR"), `sq-a-op-${randomUUID()}@test.local`);
    ownerB = await createUser(client, tenantB, await roleIdOf(client, tenantB, "OWNER"), `sq-b-owner-${randomUUID()}@test.local`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id IN ($1,$2)", [tenantA, tenantB]);
  await app.close();
  await pool.end();
});

describe("armazenamento — permissões e leitura de uso", () => {
  it("gestor (storage.manage) lê uso e quota; operador não", async () => {
    const owner = await app.inject({ url: "/organization/storage", headers: { cookie: await loginAs(ownerA) } });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().storage).toMatchObject({ used_bytes: expect.any(Number), quota_bytes: null, retention_days: null });
    expect(owner.json().storage.per_origem).toHaveLength(5);
    const operator = await app.inject({ url: "/organization/storage", headers: { cookie: await loginAs(operatorA) } });
    expect(operator.statusCode).toBe(403);
  });
});

describe("armazenamento — PATCH /organization/storage/settings", () => {
  it("persiste quota e retenção; NULL limpa; operador não escreve", async () => {
    const set = await app.inject({
      method: "PATCH", url: "/organization/storage/settings", headers: { cookie: await loginAs(ownerA) },
      payload: { storage_quota_bytes: 1048576, retention_days: 30 }
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().storage).toMatchObject({ quota_bytes: 1048576, retention_days: 30 });

    const read = await app.inject({ url: "/organization/storage", headers: { cookie: await loginAs(ownerA) } });
    expect(read.json().storage).toMatchObject({ quota_bytes: 1048576, retention_days: 30 });

    const clear = await app.inject({
      method: "PATCH", url: "/organization/storage/settings", headers: { cookie: await loginAs(ownerA) },
      payload: { storage_quota_bytes: null, retention_days: null }
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().storage).toMatchObject({ quota_bytes: null, retention_days: null });

    const forbidden = await app.inject({
      method: "PATCH", url: "/organization/storage/settings", headers: { cookie: await loginAs(operatorA) },
      payload: { retention_days: 7 }
    });
    expect(forbidden.statusCode).toBe(403);

    const invalid = await app.inject({
      method: "PATCH", url: "/organization/storage/settings", headers: { cookie: await loginAs(ownerA) },
      payload: { storage_quota_bytes: -1 }
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe("armazenamento — bloqueio de upload (413) pela logo do workspace", () => {
  it("upload grava; acima da quota → 413 STORAGE_QUOTA_EXCEEDED sem alterar o uso; liberar quota destrava", async () => {
    const clean = await app.inject({
      method: "PATCH", url: "/workspaces/current/logo", headers: { cookie: await loginAs(ownerA) },
      payload: { logo_data: logoDataUrl(120) }
    });
    expect(clean.statusCode).toBe(200);

    const afterFirst = await app.inject({ url: "/organization/storage", headers: { cookie: await loginAs(ownerA) } });
    const usedAfterFirst = afterFirst.json().storage.used_bytes;
    expect(usedAfterFirst).toBeGreaterThanOrEqual(120);

    // quota exatamente no uso atual: qualquer arquivo novo estoura.
    await app.inject({
      method: "PATCH", url: "/organization/storage/settings", headers: { cookie: await loginAs(ownerA) },
      payload: { storage_quota_bytes: usedAfterFirst }
    });
    const blocked = await app.inject({
      method: "PATCH", url: "/workspaces/current/logo", headers: { cookie: await loginAs(ownerA) },
      payload: { logo_data: logoDataUrl(240) }
    });
    expect(blocked.statusCode).toBe(413);
    expect(blocked.json().code).toBe("STORAGE_QUOTA_EXCEEDED");

    const unchanged = await app.inject({ url: "/organization/storage", headers: { cookie: await loginAs(ownerA) } });
    expect(unchanged.json().storage.used_bytes).toBe(usedAfterFirst);

    // Mídia/exibição existente nunca é bloqueada: a logo continua servida.
    const stillThere = await app.inject({ url: "/organization/storage", headers: { cookie: await loginAs(ownerA) } });
    expect(stillThere.json().storage.per_origem.find((o: { origem: string }) => o.origem === "logo_workspace")!.bytes).toBe(120);

    await app.inject({
      method: "PATCH", url: "/organization/storage/settings", headers: { cookie: await loginAs(ownerA) },
      payload: { storage_quota_bytes: null }
    });
    const unblocked = await app.inject({
      method: "PATCH", url: "/workspaces/current/logo", headers: { cookie: await loginAs(ownerA) },
      payload: { logo_data: logoDataUrl(240) }
    });
    expect(unblocked.statusCode).toBe(200);

    const afterSecond = await app.inject({ url: "/organization/storage", headers: { cookie: await loginAs(ownerA) } });
    expect(afterSecond.json().storage.used_bytes).toBe(usedAfterFirst + 120);
  });
});

describe("armazenamento — soma real do uso por origem", () => {
  it("recalculate soma figurinhas + mídias de follow-up + logo (bytes reais)", async () => {
    const stickerBytes = 4096;
    const followUpBytes = 8192;
    await pool.query(
      `INSERT INTO ai_stickers(tenant_id,name,file_name,size_bytes,content_hash,media_data,source)
       VALUES($1,'teste','x.webp',$2,$3,$4,'panel_upload')`,
      [tenantA, stickerBytes, `hash-${randomUUID()}`, Buffer.alloc(stickerBytes)]
    );
    await pool.query(
      `INSERT INTO ai_follow_up_media_assets(tenant_id,name,mime_type,file_name,size_bytes,content_hash,media_data)
       VALUES($1,'teste','image/png','x.png',$2,$3,$4)`,
      [tenantA, followUpBytes, `hash-${randomUUID()}`, Buffer.alloc(followUpBytes)]
    );

    const response = await app.inject({ url: "/organization/storage", headers: { cookie: await loginAs(ownerA) } });
    const storage = response.json().storage;
    expect(storage.used_bytes).toBe(240 + stickerBytes + followUpBytes);
    const stickers = storage.per_origem.find((o: { origem: string }) => o.origem === "figurinhas_ia");
    const followUp = storage.per_origem.find((o: { origem: string }) => o.origem === "midias_follow_up");
    const logo = storage.per_origem.find((o: { origem: string }) => o.origem === "logo_workspace");
    expect(stickers.bytes).toBe(stickerBytes);
    expect(stickers.itens).toBe(1);
    expect(followUp.bytes).toBe(followUpBytes);
    expect(followUp.itens).toBe(1);
    expect(logo.bytes).toBe(240);
  });
});

describe("armazenamento — tenancy", () => {
  it("tenant B não vê uso de A e configurações são independentes", async () => {
    const b = await app.inject({ url: "/organization/storage", headers: { cookie: await loginAs(ownerB) } });
    expect(b.statusCode).toBe(200);
    expect(b.json().storage.used_bytes).toBe(0);

    await app.inject({
      method: "PATCH", url: "/organization/storage/settings", headers: { cookie: await loginAs(ownerB) },
      payload: { storage_quota_bytes: 999999 }
    });
    const a = await app.inject({ url: "/organization/storage", headers: { cookie: await loginAs(ownerA) } });
    expect(a.json().storage.quota_bytes).toBeNull();

    // Primitiva de reserva: delta de B não toca o contador de A.
    await withTenantTransaction(pool, tenantB, async (client) => {
      await reserveStorageBytes(client, tenantB, 5000);
    });
    const aAfter = await app.inject({ url: "/organization/storage", headers: { cookie: await loginAs(ownerA) } });
    expect(aAfter.json().storage.used_bytes).toBe(240 + 4096 + 8192);
  });
});

describe("armazenamento — primitiva reserveStorageBytes", () => {
  it("413 com code padronizado e contador intacto quando excede a quota", async () => {
    await pool.query("UPDATE tenants SET storage_quota_bytes=$2 WHERE id=$1", [tenantA, 1000]);
    let caught: unknown;
    try {
      await withTenantTransaction(pool, tenantA, async (client) => {
        await reserveStorageBytes(client, tenantA, 5000);
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error & { statusCode?: number; code?: string }).statusCode).toBe(413);
    expect((caught as Error & { code?: string }).code).toBe("STORAGE_QUOTA_EXCEEDED");

    // Contador otimista fica INTACTO quando o reserve falha (o GET deriva o
    // uso real por origem sem escrever o contador — reconciliação ocorre em
    // mutações e no job diário).
    const counter = await pool.query<{ used_bytes: string }>(
      "SELECT used_bytes FROM tenant_storage_usage WHERE tenant_id=$1", [tenantA]);
    const overview = await app.inject({ url: "/organization/storage", headers: { cookie: await loginAs(ownerA) } });
    expect(overview.json().storage.used_bytes).toBe(240 + 4096 + 8192);
    expect(Number(counter.rows[0].used_bytes)).toBeLessThan(240 + 4096 + 8192);

    // erro utilitário isolado (mesma forma que o handler de erros serializa)
    const error = storageQuotaExceededError(900, 1000, 5000);
    expect((error as Error & { details: unknown }).details).toEqual({
      used_bytes: 900, quota_bytes: 1000, required_bytes: 5000
    });
    await pool.query("UPDATE tenants SET storage_quota_bytes=NULL WHERE id=$1", [tenantA]);
  });
});

describe("armazenamento — retenção diária (ponto único de exclusão)", () => {
  it("exclui mídias antigas, limpa referências, preserva recentes e recalcula", async () => {
    await app.inject({
      method: "PATCH", url: "/organization/storage/settings", headers: { cookie: await loginAs(ownerA) },
      payload: { retention_days: 1 }
    });

    await pool.query(
      `INSERT INTO ai_stickers(tenant_id,name,file_name,size_bytes,content_hash,media_data,source,created_at)
       VALUES($1,'antiga','old.webp',2048,$2,$3,'panel_upload',now() - interval '5 days') RETURNING id`,
      [tenantA, `hash-old-${randomUUID()}`, Buffer.alloc(2048)]
    );
    const oldFollowUp = await pool.query<{ id: string }>(
      `INSERT INTO ai_follow_up_media_assets(tenant_id,name,mime_type,file_name,size_bytes,content_hash,media_data,created_at)
       VALUES($1,'antiga','image/png','old.png',1024,$2,$3,now() - interval '5 days') RETURNING id`,
      [tenantA, `hash-old-fu-${randomUUID()}`, Buffer.alloc(1024)]
    );
    const freshSticker = await pool.query<{ id: string }>(
      `INSERT INTO ai_stickers(tenant_id,name,file_name,size_bytes,content_hash,media_data,source)
       VALUES($1,'recente','new.webp',512,$2,$3,'panel_upload') RETURNING id`,
      [tenantA, `hash-new-${randomUUID()}`, Buffer.alloc(512)]
    );
    await pool.query(
      `INSERT INTO tenant_ai_settings(tenant_id,media_fallback_audio,media_fallback_image,media_fallback_document,ai_follow_up_delivery)
       VALUES($1,'','','',$2)
       ON CONFLICT(tenant_id) DO UPDATE SET ai_follow_up_delivery=EXCLUDED.ai_follow_up_delivery`,
      [tenantA, JSON.stringify([{ type: "image", assetId: oldFollowUp.rows[0].id }])]
    );
    // tenant B tem mídia antiga mas NÃO tem retenção — nada é excluído lá.
    const oldStickerB = await pool.query<{ id: string }>(
      `INSERT INTO ai_stickers(tenant_id,name,file_name,size_bytes,content_hash,media_data,source,created_at)
       VALUES($1,'antiga-b','old.webp',2048,$2,$3,'panel_upload',now() - interval '5 days') RETURNING id`,
      [tenantB, `hash-old-b-${randomUUID()}`, Buffer.alloc(2048)]
    );

    const result = await runStorageRetention({ now: new Date() });
    expect(result.tenants_examined).toBeGreaterThanOrEqual(1);

    const remainingA = await pool.query<{ count: string }>(
      "SELECT count(*) count FROM ai_stickers WHERE tenant_id=$1", [tenantA]);
    // sobrevivem: a figurinha do teste de soma (4096) e a recente (512)
    expect(Number(remainingA.rows[0].count)).toBe(2);
    const fresh = await pool.query<{ id: string }>("SELECT id FROM ai_stickers WHERE tenant_id=$1 AND id=$2", [tenantA, freshSticker.rows[0].id]);
    expect(fresh.rows[0]).toBeTruthy();
    const followUpGone = await pool.query("SELECT 1 FROM ai_follow_up_media_assets WHERE tenant_id=$1 AND id=$2", [tenantA, oldFollowUp.rows[0].id]);
    expect(followUpGone.rows).toHaveLength(0);
    const delivery = await pool.query<{ ai_follow_up_delivery: unknown }>(
      "SELECT ai_follow_up_delivery FROM tenant_ai_settings WHERE tenant_id=$1", [tenantA]);
    expect(delivery.rows[0].ai_follow_up_delivery).toEqual([]);
    const untouchedB = await pool.query("SELECT 1 FROM ai_stickers WHERE tenant_id=$1 AND id=$2", [tenantB, oldStickerB.rows[0].id]);
    expect(untouchedB.rows).toHaveLength(1);

    // uso recalculado sem os bytes excluídos: logo (240) + soma (4096+8192)
    // + figurinha recente (512)
    const afterRetention = await app.inject({ url: "/organization/storage", headers: { cookie: await loginAs(ownerA) } });
    expect(afterRetention.json().storage.used_bytes).toBe(240 + 4096 + 8192 + 512);

    // exclusões de retenção não apagam mensagens: nenhuma mensagem existe no
    // fixture e nenhuma FK de mídia aponta para messages/conversations.
    const messages = await pool.query<{ count: string }>(
      "SELECT count(*) count FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE tenant_id=$1)", [tenantA]);
    expect(Number(messages.rows[0].count)).toBe(0);

    await app.inject({
      method: "PATCH", url: "/organization/storage/settings", headers: { cookie: await loginAs(ownerA) },
      payload: { retention_days: null }
    });
  });
});
