// ONDA 2-B (SPEC v7) — B10 Storage: galeria de mídias armazenadas (5 fontes
// BYTEA) com filtros/keyset/dedupe por content_hash, DELETE em lote passando
// OBRIGATORIAMENTE pelo ponto único (purgeStoredMediaRows) — tripz rejeitado,
// logo vira logo_data NULL, audit gravado — e retenção lida pelo job diário
// EXISTENTE via updateStorageSettings({retention:{enabled,months}}) +
// runStorageRetention (asserções POR TENANT — o banco de teste é SHARED).
// app.ts é do orquestrador: o app de teste registra apenas o plugin de rotas
// de mídia + @fastify/cookie.
import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionToken } from "../src/auth/session.js";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { registerOrganizationStorageRoutes } from "../src/modules/organization/storage.js";
import {
  updateStorageSettings,
  runStorageRetention,
  type StorageMediaItem
} from "../src/modules/organization/storage.js";
import { localDateKey } from "../src/timezone.js";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

const app = Fastify({ logger: false });
// Handler ANTES do register: plugins encapsulados não herdam um setErrorHandler
// registrado depois (Fastify resolve o errorHandler no encapsulamento).
app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
  if (error instanceof ZodError) {
    return reply.status(400).send({ error: error.issues[0]?.message ?? "Payload inválido" });
  }
  const status = typeof error.statusCode === "number" ? error.statusCode : 500;
  return reply.status(status).send({ error: error.message });
});
await app.register(cookie);
await app.register(registerOrganizationStorageRoutes);
await app.ready();

type Row = { id: string };
let tenantA = "";
let tenantB = "";
let ownerA = "";
let operatorA = "";
let ownerB = "";
let sessionA = "";
let followUpOldId = "";
const emails = new Map<string, string>();
const cookies = new Map<string, string>();

const sha256 = (label: string) => createHash("sha256").update(`${label}:${randomUUID()}`).digest("hex");
const logoDataUrl = (bytes: number) => `data:image/png;base64,${Buffer.alloc(bytes, 7).toString("base64")}`;
const bytes = (size: number) => Buffer.alloc(size, 9);

async function cookieFor(userId: string, tenantId: string): Promise<string> {
  const cached = cookies.get(userId);
  if (cached) return cached;
  const token = await createSessionToken({
    userId,
    tenantId,
    email: emails.get(userId)!,
    isRoot: false,
    rootWorkspaceAccess: false,
    mustChangePassword: false
  });
  const header = `atendon_session=${token}`;
  cookies.set(userId, header);
  return header;
}

async function listMedia(userId: string, tenantId: string, query: Record<string, string> = {}) {
  return app.inject({
    method: "GET",
    url: "/organization/storage/media",
    query,
    headers: { cookie: await cookieFor(userId, tenantId) }
  });
}

// ---- fixtures ---------------------------------------------------------------

async function sticker(client: pg.PoolClient, tenantId: string, values: { size: number; createdAt?: string }) {
  const hash = sha256("sticker");
  return (await client.query<Row>(
    `INSERT INTO ai_stickers(tenant_id,name,file_name,size_bytes,content_hash,media_data,source,created_at)
     VALUES($1,'teste','x.webp',$2,$3,$4,'panel_upload',COALESCE($5,now())) RETURNING id`,
    [tenantId, values.size, hash, bytes(values.size), values.createdAt ?? null]
  )).rows[0].id;
}

async function followUp(client: pg.PoolClient, tenantId: string, values: { size: number; createdAt?: string }) {
  const hash = sha256("follow-up");
  return (await client.query<Row>(
    `INSERT INTO ai_follow_up_media_assets(tenant_id,name,mime_type,file_name,size_bytes,content_hash,media_data,created_at)
     VALUES($1,'teste','image/png','x.png',$2,$3,$4,COALESCE($5,now())) RETURNING id`,
    [tenantId, values.size, hash, bytes(values.size), values.createdAt ?? null]
  )).rows[0].id;
}

let tripzSequence = 0;
async function tripzAttachment(client: pg.PoolClient, tenantId: string, ownerUserId: string, conversationId: string, values: { hash: string; createdAt?: string }) {
  tripzSequence += 1;
  return (await client.query<Row>(
    `INSERT INTO tripz_ai_attachments(tenant_id,conversation_id,uploaded_by_user_id,file_name,mime_type,extension,size_bytes,content_hash,file_data,created_at)
     VALUES($1,$2,$3,$4,'application/pdf','pdf',4096,$5,$6,COALESCE($7,now())) RETURNING id`,
    [tenantId, conversationId, ownerUserId, `documento-${tripzSequence}.pdf`, values.hash, bytes(4096), values.createdAt ?? null]
  )).rows[0].id;
}

async function instagramMedia(client: pg.PoolClient, tenantId: string, sessionId: string, values: { size: number; createdAt?: string }) {
  return (await client.query<Row>(
    `INSERT INTO instagram_media(tenant_id,session_id,media_data,content_type,size_bytes,expires_at,created_at)
     VALUES($1,$2,$3,'image/png',$4,now()+interval '1 day',COALESCE($5,now())) RETURNING id`,
    [tenantId, sessionId, bytes(values.size), values.size, values.createdAt ?? null]
  )).rows[0].id;
}

beforeAll(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantA = (await client.query<Row>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`StorageGallery A ${randomUUID()}`])).rows[0].id;
    tenantB = (await client.query<Row>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`StorageGallery B ${randomUUID()}`])).rows[0].id;

    // Papéis/permissões: sem isto os membros não têm role e toda rota dá 403.
    await ensureWorkspaceDefaultRoles(client, tenantA);
    await ensureWorkspaceDefaultRoles(client, tenantB);

    const createUser = async (tenantId: string, roleName: string, name: string) => {
      const email = `storage-gallery-${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID()}@test.local`;
      const user = (await client.query<Row>(
        "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
        [email, "storage-gallery-password"]
      )).rows[0].id;
      await client.query(
        `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
         SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name=$3`,
        [tenantId, user, roleName]
      );
      emails.set(user, email);
      return user;
    };
    ownerA = await createUser(tenantA, "OWNER", "Owner A");
    operatorA = await createUser(tenantA, "OPERADOR", "Operador A");
    ownerB = await createUser(tenantB, "OWNER", "Owner B");

    // tenant A: uma mídia em cada origem + segunda tripz com o MESMO
    // content_hash (dedupe → 1 item) + logo do workspace.
    sessionA = (await client.query<Row>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantA])).rows[0].id;
    const oldKey = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await sticker(client, tenantA, { size: 2048, createdAt: oldKey });
    await sticker(client, tenantA, { size: 512 });
    const followUpDeleted = await followUp(client, tenantA, { size: 1024 });
    followUpOldId = await followUp(client, tenantA, { size: 1024, createdAt: oldKey });
    const tripzConversation = (await client.query<Row>(
      "INSERT INTO tripz_ai_conversations(tenant_id,created_by_user_id) VALUES($1,$2) RETURNING id",
      [tenantA, ownerA]
    )).rows[0].id;
    const tripzSharedHash = sha256("tripz-shared");
    await tripzAttachment(client, tenantA, ownerA, tripzConversation, { hash: tripzSharedHash, createdAt: oldKey });
    // A UNIQUE (tenant,conversa,content_hash) de 0114 barra cópia não vinculada
    // na MESMA conversa; o dedupe da galeria é por hash do tenant, então a
    // segunda cópia vive em outra conversa.
    const tripzConversationB = (await client.query<Row>(
      "INSERT INTO tripz_ai_conversations(tenant_id,created_by_user_id) VALUES($1,$2) RETURNING id",
      [tenantA, ownerA]
    )).rows[0].id;
    await tripzAttachment(client, tenantA, ownerA, tripzConversationB, { hash: tripzSharedHash });
    await instagramMedia(client, tenantA, sessionA, { size: 768 });
    await instagramMedia(client, tenantA, sessionA, { size: 256, createdAt: oldKey });
    await client.query("UPDATE tenants SET logo_data=$2 WHERE id=$1", [tenantA, logoDataUrl(120)]);

    // Referências de delivery apontando para as mídias de follow-up (limpas
    // pelo ponto único de exclusão).
    await client.query(
      `INSERT INTO tenant_ai_settings(tenant_id,media_fallback_audio,media_fallback_image,media_fallback_document,ai_follow_up_delivery)
       VALUES($1,'','','',$2)
       ON CONFLICT(tenant_id) DO UPDATE SET ai_follow_up_delivery=EXCLUDED.ai_follow_up_delivery`,
      [tenantA, JSON.stringify([
        { type: "image", assetId: followUpDeleted },
        { type: "image", assetId: followUpOldId }
      ])]
    );

    // tenant B: mídias antigas mas SEM config de retenção → job não toca.
    await client.query("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantB]);
    await sticker(client, tenantB, { size: 2048, createdAt: oldKey });
    await followUp(client, tenantB, { size: 1024, createdAt: oldKey });

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}, 120_000);

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id IN ($1,$2)", [tenantA, tenantB]);
  await app.close();
  await pool.end();
});

describe("B10 — galeria (GET /organization/storage/media)", () => {
  it("lista as 5 origens com dedupe por content_hash (2 tripz iguais → 1 item)", async () => {
    const response = await listMedia(ownerA, tenantA);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: StorageMediaItem[]; has_more: boolean; next_cursor: string | null };
    expect(body.items).toHaveLength(8); // 2 stickers + 2 follow-ups + 1 tripz (dedupe) + 2 instagram + logo
    const tripz = body.items.filter((item) => item.type === "tripz");
    expect(tripz).toHaveLength(1);
    expect(tripz[0].deletable).toBe(false);
    expect(tripz[0].size_bytes).toBe(4096);
    const types = new Set(body.items.map((item) => item.type));
    expect([...types].sort()).toEqual(["follow_up", "instagram", "logo", "sticker", "tripz"]);
    const logo = body.items.find((item) => item.type === "logo")!;
    expect(logo.id).toBe(tenantA);
    expect(logo.file_name).toBe("logo-do-workspace");
    expect(logo.mime_type).toBe("image/png");
    expect(logo.size_bytes).toBe(120);
    expect(logo.deletable).toBe(true);
    expect(new Set(body.items.map((item) => item.id)).size).toBe(8);
  });

  it("filtra por type e por janela de datas (logo criada na época sai da janela)", async () => {
    const tripzOnly = await listMedia(ownerA, tenantA, { type: "tripz" });
    expect(tripzOnly.statusCode).toBe(200);
    const tripzItems = tripzOnly.json().items as StorageMediaItem[];
    expect(tripzItems).toHaveLength(1);
    expect(tripzItems[0].type).toBe("tripz");

    const today = localDateKey(new Date(), "UTC");
    const fresh = await listMedia(ownerA, tenantA, { from: today });
    const freshItems = fresh.json().items as StorageMediaItem[];
    // Fresh: sticker (512), follow-up (1024), tripz mais recente (dedupe pega
    // o mais novo), instagram — a logo (created_at = época) fica de fora.
    expect(freshItems).toHaveLength(4);
    expect(freshItems.map((item) => item.type).sort()).toEqual(["follow_up", "instagram", "sticker", "tripz"]);
    expect(freshItems.find((item) => item.type === "logo")).toBeUndefined();
  });

  it("keyset com cursor µs-safe percorre tudo sem repetir nem pular", async () => {
    const collected: StorageMediaItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const response = await listMedia(ownerA, tenantA, { limit: "3", ...(cursor ? { cursor } : {}) });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { items: StorageMediaItem[]; has_more: boolean; next_cursor: string | null };
      collected.push(...body.items);
      if (!body.has_more) {
        expect(body.next_cursor).toBeNull();
        break;
      }
      expect(body.next_cursor).toBeTruthy();
      cursor = body.next_cursor!;
    }
    expect(collected).toHaveLength(8);
    expect(new Set(collected.map((item) => item.id)).size).toBe(8);
    // A logo (created_at = época) é sempre a última página.
    expect(collected[collected.length - 1].type).toBe("logo");
  });

  it("cursor inválido → 400; operador sem storage.manage → 403", async () => {
    expect((await listMedia(ownerA, tenantA, { cursor: "lixo" })).statusCode).toBe(400);
    expect((await listMedia(ownerA, tenantA, { from: "2026-13-99" })).statusCode).toBe(400);
    const operator = await listMedia(operatorA, tenantA);
    expect(operator.statusCode).toBe(403);
  });

  it("tenancy: owner B não vê mídias de A", async () => {
    const response = await listMedia(ownerB, tenantB);
    expect(response.statusCode).toBe(200);
    const items = response.json().items as StorageMediaItem[];
    // B tem exatamente as 2 mídias antigas próprias (sem logo configurada).
    expect(items.map((item) => item.type).sort()).toEqual(["follow_up", "sticker"]);
    expect(items.find((item) => item.type === "sticker")!.size_bytes).toBe(2048);
  });
});

describe("B10 — exclusão em lote (DELETE /organization/storage/media)", () => {
  it("tripz é rejeitado com 400 (documento de negócio) e nada é apagado", async () => {
    const tripzId = (await pool.query<Row>(
      "SELECT id FROM tripz_ai_attachments WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1",
      [tenantA]
    )).rows[0].id;
    const response = await app.inject({
      method: "DELETE",
      url: "/organization/storage/media",
      headers: { cookie: await cookieFor(ownerA, tenantA) },
      payload: { items: [{ type: "tripz", id: tripzId }] }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Tripz");
    const remaining = await pool.query("SELECT 1 FROM tripz_ai_attachments WHERE tenant_id=$1 AND id=$2", [tenantA, tripzId]);
    expect(remaining.rows).toHaveLength(1);
  });

  it("apaga sticker/follow-up/instagram em lote, zera logo_data, limpa referências e audita", async () => {
    const before = await pool.query<{ count: string }>("SELECT count(*) count FROM instagram_media WHERE tenant_id=$1", [tenantA]);
    expect(Number(before.rows[0].count)).toBe(2);
    const stickerId = (await pool.query<Row>(
      "SELECT id FROM ai_stickers WHERE tenant_id=$1 AND size_bytes=512", [tenantA]
    )).rows[0].id;
    const followUpId = (await pool.query<Row>(
      "SELECT id FROM ai_follow_up_media_assets WHERE tenant_id=$1 AND created_at>=now()-interval '1 day'", [tenantA]
    )).rows[0].id;
    const instagramId = (await pool.query<Row>(
      "SELECT id FROM instagram_media WHERE tenant_id=$1 AND created_at>=now()-interval '1 day'", [tenantA]
    )).rows[0].id;

    const response = await app.inject({
      method: "DELETE",
      url: "/organization/storage/media",
      headers: { cookie: await cookieFor(ownerA, tenantA) },
      payload: { items: [
        { type: "sticker", id: stickerId },
        { type: "follow_up", id: followUpId },
        { type: "instagram", id: instagramId },
        { type: "logo", id: tenantA }
      ] }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { deleted: number; storage: { used_bytes: number; per_origem: Array<{ origem: string; bytes: number; itens: number }> } };
    expect(body.deleted).toBe(4);

    // Linhas efetivamente excluídas por origem…
    expect((await pool.query("SELECT 1 FROM ai_stickers WHERE tenant_id=$1 AND id=$2", [tenantA, stickerId])).rows).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM ai_follow_up_media_assets WHERE tenant_id=$1 AND id=$2", [tenantA, followUpId])).rows).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM instagram_media WHERE tenant_id=$1 AND id=$2", [tenantA, instagramId])).rows).toHaveLength(0);
    // …a logo não tem linha: vira logo_data NULL.
    const logo = await pool.query<{ logo_data: string | null }>("SELECT logo_data FROM tenants WHERE id=$1", [tenantA]);
    expect(logo.rows[0].logo_data).toBeNull();
    // Referência de delivery do follow-up excluído é removida (a da mídia
    // antiga — ainda existente — permanece até a retenção).
    const settings = await pool.query<{ ai_follow_up_delivery: Array<{ assetId: string }> }>(
      "SELECT ai_follow_up_delivery FROM tenant_ai_settings WHERE tenant_id=$1", [tenantA]
    );
    expect(settings.rows[0].ai_follow_up_delivery).toEqual([{ type: "image", assetId: followUpOldId }]);

    // Uso recalculado: sobram figurinha antiga (2048) + follow-up antigo (1024)
    // + as 2 tripz (2×4096). Sem logo, sem instagram.
    expect(body.storage.used_bytes).toBe(2048 + 1024 + 2 * 4096 + 256); // + instagram old (256), que permanece
    const perOrigem = Object.fromEntries(body.storage.per_origem.map((item) => [item.origem, item]));
    expect(perOrigem.figurinhas_ia).toMatchObject({ bytes: 2048, itens: 1 });
    expect(perOrigem.midias_follow_up).toMatchObject({ bytes: 1024, itens: 1 });
    expect(perOrigem.midias_instagram).toMatchObject({ bytes: 256, itens: 1 }); // a old (256) permanece
    expect(perOrigem.anexos_tripz).toMatchObject({ bytes: 8192, itens: 2 });
    expect(perOrigem.logo_workspace).toMatchObject({ bytes: 0 });

    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_logs WHERE workspace_id=$1 AND action='organization.storage.media.delete' ORDER BY created_at DESC LIMIT 1",
      [tenantA]
    );
    expect(audit.rows[0].metadata).toMatchObject({
      itens: 4,
      por_tipo: { sticker: 1, follow_up: 1, instagram: 1, logo: 1 }
    });
  });

  it("itens duplicados no payload deduplicam (deleted conta linha excluída)", async () => {
    const stickerId = (await pool.query<Row>(
      "SELECT id FROM ai_stickers WHERE tenant_id=$1", [tenantA]
    )).rows[0].id;
    const response = await app.inject({
      method: "DELETE",
      url: "/organization/storage/media",
      headers: { cookie: await cookieFor(ownerA, tenantA) },
      payload: { items: [
        { type: "sticker", id: stickerId },
        { type: "sticker", id: stickerId }
      ] }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().deleted).toBe(1);
    expect((await pool.query("SELECT 1 FROM ai_stickers WHERE tenant_id=$1", [tenantA])).rows).toHaveLength(0);
  });
});

describe("B10 — retenção lida pelo job diário existente", () => {
  it("updateStorageSettings persiste {enabled,months} e recusa config dupla", async () => {
    const set = await updateStorageSettings(
      tenantA,
      { retention: { enabled: true, months: 1 } },
      { userId: ownerA, actorScope: "workspace" }
    );
    expect(set.retention).toEqual({ enabled: true, months: 1 });
    expect(set.used_bytes).toBeGreaterThan(0);
    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_logs WHERE workspace_id=$1 AND action='organization.storage.settings.update' ORDER BY created_at DESC LIMIT 1",
      [tenantA]
    );
    expect(audit.rows[0].metadata.retention).toEqual({ enabled: true, months: 1 });

    await expect(updateStorageSettings(
      tenantA,
      { retention: { enabled: true, months: 2 }, retention_days: 5 },
      { userId: ownerA, actorScope: "workspace" }
    )).rejects.toMatchObject({ statusCode: 400 });
  });

  it("runStorageRetention exclui mídias antigas por tenant e preserva tripz e tenants sem config", async () => {
    const result = await runStorageRetention({ now: new Date() });
    expect(result.tenants_examined).toBeGreaterThanOrEqual(1);
    // O job percorre TODOS os tenants do banco SHARED com config ativa —
    // itens_excluidos é a soma global: limite inferior = o que A tinha elegível
    // (follow-up antigo + instagram antigo; os stickers de A já foram excluídos
    // pelos testes da galeria).
    expect(result.itens_excluidos).toBeGreaterThanOrEqual(2);

    // Por tenant — banco SHARED: asserções sempre escopadas por tenant_id.
    expect(Number((await pool.query<{ count: string }>("SELECT count(*) count FROM ai_stickers WHERE tenant_id=$1", [tenantA])).rows[0].count)).toBe(0);
    expect(Number((await pool.query<{ count: string }>("SELECT count(*) count FROM ai_follow_up_media_assets WHERE tenant_id=$1", [tenantA])).rows[0].count)).toBe(0);
    expect(Number((await pool.query<{ count: string }>("SELECT count(*) count FROM instagram_media WHERE tenant_id=$1", [tenantA])).rows[0].count)).toBe(0);
    // tripz NUNCA é excluído (nem antigo nem fresco) — documento de negócio.
    expect(Number((await pool.query<{ count: string }>("SELECT count(*) count FROM tripz_ai_attachments WHERE tenant_id=$1", [tenantA])).rows[0].count)).toBe(2);
    // Referência de delivery do follow-up antigo também caiu.
    const settings = await pool.query<{ ai_follow_up_delivery: unknown[] }>(
      "SELECT ai_follow_up_delivery FROM tenant_ai_settings WHERE tenant_id=$1", [tenantA]
    );
    expect(settings.rows[0].ai_follow_up_delivery).toEqual([]);

    // Tenant B (sem config): mídias antigas intactas.
    expect(Number((await pool.query<{ count: string }>("SELECT count(*) count FROM ai_stickers WHERE tenant_id=$1", [tenantB])).rows[0].count)).toBe(1);
    expect(Number((await pool.query<{ count: string }>("SELECT count(*) count FROM ai_follow_up_media_assets WHERE tenant_id=$1", [tenantB])).rows[0].count)).toBe(1);
  });
});
