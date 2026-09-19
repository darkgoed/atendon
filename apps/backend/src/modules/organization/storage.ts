// R4 — Armazenamento da empresa (specs/active/v6-evolucao-estrutural-atendon.md)
// + ONDA 2-B (specs/active/v7-port-crm-whatsapp.md B10 — SOMENTE aditivo).
// Quota/bloqueio/uso/associação/retenção dos bytes que o backend guarda hoje
// (ver descoberta no relatório): ai_stickers, ai_follow_up_media_assets,
// instagram_media, tripz_ai_attachments e tenants.logo_data. Mídia de
// conversas WhatsApp NÃO é persistida (download on-demand no gateway), então
// não entra no uso — e nunca é bloqueada.
//
// Ponto único de exclusão é purgeStoredMediaRows (abaixo), usado pelo job
// diário (runStorageRetention, chamado pelo worker) e pelo DELETE em lote da
// galeria (deleteStorageMediaBatch); nada aqui apaga em cascata
// mensagens/conversas — as FKs que saem das tabelas de mídia apontam apenas
// para registros de uso (ai_sticker_sends) e referências de configuração
// (tenant_ai_settings.ai_follow_up_delivery), que são explicitamente limpas.
// tripz_ai_attachments NÃO são excluídos (nem pela retenção nem pela galeria):
// são documentos de negócio referenciados por propostas.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PoolClient } from "pg";
import { db } from "../../db/client.js";
import { withTenantTransaction } from "../../db/tenant-transaction.js";
import { requirePermission } from "../../auth/session.js";
import { localDateTimeToUtc } from "../../timezone.js";
import { shiftDateKey } from "../reporting.js";
import { httpError } from "../scheduling/service.js";

/**
 * Superfície mínima de consulta: Pool ou PoolClient — evita depender do Pool
 * inteiro em testes e permite recalcular dentro da transação do chamador.
 */
export interface StorageQueryable {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface StorageActor {
  userId: string;
  actorScope: string;
  ipAddress?: string;
  userAgent?: string | undefined;
}

export interface StorageOrigem {
  origem: string;
  bytes: number;
  itens: number;
}

export interface StorageRetentionConfig {
  enabled: boolean;
  months: number | null;
}

export interface OrganizationStorage {
  used_bytes: number;
  quota_bytes: number | null;
  retention_days: number | null;
  // B10 — config de retenção em meses (0180): o payload espelha o que o job
  // diário resolve (months quando enabled, senão days legado).
  retention: StorageRetentionConfig;
  per_origem: StorageOrigem[];
}

const RECALCULATE_SQL = `INSERT INTO tenant_storage_usage(tenant_id,used_bytes,updated_at)
VALUES($1,(
  (SELECT COALESCE(SUM(octet_length(media_data)),0) FROM ai_stickers WHERE tenant_id=$1)
+ (SELECT COALESCE(SUM(octet_length(media_data)),0) FROM ai_follow_up_media_assets WHERE tenant_id=$1)
+ (SELECT COALESCE(SUM(octet_length(media_data)),0) FROM instagram_media WHERE tenant_id=$1)
+ (SELECT COALESCE(SUM(octet_length(file_data)),0) FROM tripz_ai_attachments WHERE tenant_id=$1)
+ COALESCE((
    SELECT CASE WHEN t.logo_data IS NULL THEN 0
                WHEN t.logo_data LIKE 'data:%,%'
                  THEN octet_length(decode(split_part(t.logo_data,',',2),'base64'))
                ELSE octet_length(t.logo_data) END
    FROM tenants t WHERE t.id=$1
  ),0)
),now())
ON CONFLICT(tenant_id) DO UPDATE SET used_bytes=EXCLUDED.used_bytes,updated_at=now()
RETURNING used_bytes`;

const OVERVIEW_SQL = `SELECT
  t.storage_quota_bytes,t.storage_retention_days,
  t.storage_retention_enabled,t.storage_retention_months,
  (SELECT count(*) FROM ai_stickers WHERE tenant_id=$1) stickers_itens,
  (SELECT COALESCE(SUM(octet_length(media_data)),0) FROM ai_stickers WHERE tenant_id=$1) stickers_bytes,
  (SELECT count(*) FROM ai_follow_up_media_assets WHERE tenant_id=$1) follow_up_itens,
  (SELECT COALESCE(SUM(octet_length(media_data)),0) FROM ai_follow_up_media_assets WHERE tenant_id=$1) follow_up_bytes,
  (SELECT count(*) FROM instagram_media WHERE tenant_id=$1) instagram_itens,
  (SELECT COALESCE(SUM(octet_length(media_data)),0) FROM instagram_media WHERE tenant_id=$1) instagram_bytes,
  (SELECT count(*) FROM tripz_ai_attachments WHERE tenant_id=$1) tripz_itens,
  (SELECT COALESCE(SUM(octet_length(file_data)),0) FROM tripz_ai_attachments WHERE tenant_id=$1) tripz_bytes,
  COALESCE(CASE WHEN t.logo_data IS NULL THEN 0
                WHEN t.logo_data LIKE 'data:%,%'
                  THEN octet_length(decode(split_part(t.logo_data,',',2),'base64'))
                ELSE octet_length(t.logo_data) END,0) logo_bytes
FROM tenants t WHERE t.id=$1`;

export function storageQuotaExceededError(usedBytes: number, quotaBytes: number, deltaBytes: number): Error {
  return Object.assign(
    new Error(
      `Armazenamento da empresa esgotado: ${usedBytes} de ${quotaBytes} bytes em uso. ` +
      "Libere espaço ou aumente a quota antes de enviar novos arquivos."
    ),
    {
      statusCode: 413,
      code: "STORAGE_QUOTA_EXCEEDED",
      details: { used_bytes: usedBytes, quota_bytes: quotaBytes, required_bytes: deltaBytes }
    }
  );
}

/**
 * Reserva `deltaBytes` no contador do tenant com bloqueio por linha
 * (SELECT ... FOR UPDATE) e aplica a verificação de quota ANTES de gravar:
 * 413 quando a soma ultrapassaria tenants.storage_quota_bytes (NULL =
 * ilimitado). Delta negativo (substituição por arquivo menor / exclusão)
 * nunca é bloqueado. Deve rodar na MESMA transação do insert/update do asset.
 */
export async function reserveStorageBytes(client: StorageQueryable, tenantId: string, deltaBytes: number): Promise<void> {
  if (!Number.isFinite(deltaBytes) || deltaBytes === 0) return;
  if (deltaBytes < 0) {
    await client.query(
      `INSERT INTO tenant_storage_usage(tenant_id,used_bytes) VALUES($1,0)
       ON CONFLICT(tenant_id) DO UPDATE
         SET used_bytes=GREATEST(0,tenant_storage_usage.used_bytes+$2),updated_at=now()`,
      [tenantId, deltaBytes]
    );
    return;
  }
  await client.query(
    "INSERT INTO tenant_storage_usage(tenant_id,used_bytes) VALUES($1,0) ON CONFLICT(tenant_id) DO NOTHING",
    [tenantId]
  );
  const locked = await client.query<{ storage_quota_bytes: string | null; used_bytes: string }>(
    `SELECT t.storage_quota_bytes,u.used_bytes
     FROM tenant_storage_usage u JOIN tenants t ON t.id=u.tenant_id
     WHERE u.tenant_id=$1
     FOR UPDATE OF u`,
    [tenantId]
  );
  const row = locked.rows[0];
  if (!row) throw Object.assign(new Error("Workspace não encontrado"), { statusCode: 404 });
  const used = Number(row.used_bytes);
  const quota = row.storage_quota_bytes === null ? null : Number(row.storage_quota_bytes);
  if (quota !== null && used + deltaBytes > quota) throw storageQuotaExceededError(used, quota, deltaBytes);
  await client.query(
    "UPDATE tenant_storage_usage SET used_bytes=used_bytes+$2,updated_at=now() WHERE tenant_id=$1",
    [tenantId, deltaBytes]
  );
}

/**
 * Conteúdo idêntico (mesmo content_hash) deduplica no tenant e não adiciona
 * bytes — chamadores consultam isto antes de reservar para não cobrar
 * re-upload do mesmo arquivo.
 */
export async function hasStoredContent(
  client: StorageQueryable,
  table: "ai_stickers" | "ai_follow_up_media_assets",
  tenantId: string,
  contentHash: string
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM ${table} WHERE tenant_id=$1 AND content_hash=$2 LIMIT 1`,
    [tenantId, contentHash]
  );
  return Boolean(result.rows[0]);
}

/**
 * Ponto único de reconciliação: UMA query soma os bytes reais por tenant e
 * atualiza tenant_storage_usage. `client` opcional roda na transação do
 * chamador (uploads/exclusões); sem ele, abre transação própria.
 */
export async function recalculateStorageUsage(tenantId: string, client?: StorageQueryable): Promise<number> {
  const run = async (queryable: StorageQueryable): Promise<number> => {
    const result = await queryable.query<{ used_bytes: string }>(RECALCULATE_SQL, [tenantId]);
    return Number(result.rows[0].used_bytes);
  };
  return client ? run(client) : withTenantTransaction(db, tenantId, run);
}

/** Tamanho decodificado (bytes) de um data URL base64. */
export function dataUrlByteLength(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Buffer.from(base64, "base64").length;
}

export async function getOrganizationStorage(tenantId: string): Promise<OrganizationStorage> {
  // Uma única query de leitura: logo entra no OVERVIEW e used_bytes é a soma
  // das origens (sem UPDATE de reconciliação nem JOIN no contador).
  const overview = await db.query<{
    storage_quota_bytes: string | null;
    storage_retention_days: number | null;
    storage_retention_enabled: boolean;
    storage_retention_months: number | null;
    stickers_itens: string;
    stickers_bytes: string;
    follow_up_itens: string;
    follow_up_bytes: string;
    instagram_itens: string;
    instagram_bytes: string;
    tripz_itens: string;
    tripz_bytes: string;
    logo_bytes: string;
  }>(OVERVIEW_SQL, [tenantId]);
  const row = overview.rows[0];
  const perOrigem: StorageOrigem[] = [
    { origem: "figurinhas_ia", bytes: Number(row?.stickers_bytes ?? 0), itens: Number(row?.stickers_itens ?? 0) },
    { origem: "midias_follow_up", bytes: Number(row?.follow_up_bytes ?? 0), itens: Number(row?.follow_up_itens ?? 0) },
    { origem: "midias_instagram", bytes: Number(row?.instagram_bytes ?? 0), itens: Number(row?.instagram_itens ?? 0) },
    { origem: "anexos_tripz", bytes: Number(row?.tripz_bytes ?? 0), itens: Number(row?.tripz_itens ?? 0) },
    { origem: "logo_workspace", bytes: Number(row?.logo_bytes ?? 0), itens: 1 }
  ];
  return {
    used_bytes: perOrigem.reduce((total, item) => total + item.bytes, 0),
    quota_bytes: row?.storage_quota_bytes === null || row?.storage_quota_bytes === undefined ? null : Number(row.storage_quota_bytes),
    retention_days: row?.storage_retention_days ?? null,
    retention: {
      enabled: Boolean(row?.storage_retention_enabled),
      months: row?.storage_retention_months ?? null
    },
    per_origem: perOrigem
  };
}

export async function updateStorageSettings(
  tenantId: string,
  input: {
    storage_quota_bytes?: number | null;
    retention_days?: number | null;
    retention?: StorageRetentionConfig;
  },
  actor: StorageActor
): Promise<{ used_bytes: number; quota_bytes: number | null; retention_days: number | null; retention: StorageRetentionConfig }> {
  const sets: string[] = [];
  const values: unknown[] = [tenantId];
  if (input.storage_quota_bytes !== undefined) {
    values.push(input.storage_quota_bytes);
    sets.push(`storage_quota_bytes=$${values.length}::bigint`);
  }
  if (input.retention && input.retention_days !== undefined) {
    throw httpError(400, "Informe retention (meses) OU retention_days — as duas configs são mutuamente exclusivas");
  }
  if (input.retention) {
    if (input.retention.enabled) {
      // Habilitar meses zera a config legada em dias — sempre UMA config ativa.
      values.push(input.retention.months);
      sets.push("storage_retention_enabled=true", `storage_retention_months=$${values.length}::int`, "storage_retention_days=NULL");
    } else {
      // Desligar a retenção por meses limpa a config de meses; o job volta a
      // resolver pelos dias legados (quando existirem).
      sets.push("storage_retention_enabled=false", "storage_retention_months=NULL");
    }
  }
  if (input.retention_days !== undefined) {
    values.push(input.retention_days);
    sets.push(`storage_retention_days=$${values.length}::int`, "storage_retention_enabled=false", "storage_retention_months=NULL");
  }
  if (sets.length === 0) throw httpError(400, "Informe ao menos um campo");
  return withTenantTransaction(db, tenantId, async (client) => {
    const result = await client.query<{
      storage_quota_bytes: string | null;
      storage_retention_days: number | null;
      storage_retention_enabled: boolean;
      storage_retention_months: number | null;
    }>(
      `UPDATE tenants SET ${sets.join(",")} WHERE id=$1
       RETURNING storage_quota_bytes,storage_retention_days,storage_retention_enabled,storage_retention_months`,
      values
    );
    if (!result.rows[0]) throw Object.assign(new Error("Workspace não encontrado"), { statusCode: 404 });
    const row = result.rows[0];
    const usedBytes = await recalculateStorageUsage(tenantId, client);
    const retention: StorageRetentionConfig = {
      enabled: row.storage_retention_enabled,
      months: row.storage_retention_months
    };
    await client.query(
      `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
       VALUES($1,$2,$3,'organization.storage.settings.update','workspace',$4,$5,$6,$7)`,
      [actor.userId, tenantId, actor.actorScope, tenantId,
        {
          storage_quota_bytes: row.storage_quota_bytes === null ? null : Number(row.storage_quota_bytes),
          retention_days: row.storage_retention_days,
          retention
        },
        actor.ipAddress ?? null, actor.userAgent ?? null]
    );
    return {
      used_bytes: usedBytes,
      quota_bytes: row.storage_quota_bytes === null ? null : Number(row.storage_quota_bytes),
      retention_days: row.storage_retention_days,
      retention
    };
  });
}

/**
 * Remove referências penduradas em tenant_ai_settings.ai_follow_up_delivery
 * (limpeza de bytes + referências; o delivery é um array de {type,assetId}).
 */
async function stripFollowUpDeliveryReference(
  client: PoolClient,
  tenantId: string,
  assetId: string,
  types: string[]
): Promise<void> {
  await client.query(
    `UPDATE tenant_ai_settings
     SET ai_follow_up_delivery=(
       SELECT COALESCE(jsonb_agg(entry),'[]'::jsonb)
       FROM jsonb_array_elements(tenant_ai_settings.ai_follow_up_delivery) entry
       WHERE NOT (entry->>'assetId'=$2 AND entry->>'type'=ANY($3::text[]))
     )
     WHERE tenant_id=$1 AND jsonb_typeof(ai_follow_up_delivery)='array'
       AND ai_follow_up_delivery @> jsonb_build_array(jsonb_build_object('assetId',$2::text))`,
    [tenantId, assetId, types]
  );
}

/**
 * PONTO ÚNICO de exclusão de mídias armazenadas: usado pelo job diário
 * (runStorageRetention) e pelo DELETE em lote da galeria
 * (deleteStorageMediaBatch). Roda dentro da transação do chamador:
 * - apaga as linhas informadas por origem (sempre filtrando por tenant);
 * - limpa as referências em tenant_ai_settings.ai_follow_up_delivery das
 *   linhas EFETIVAMENTE excluídas (RETURNING);
 * - zera tenants.logo_data quando clearLogo (a logo não é uma linha: é uma
 *   coluna do tenant);
 * - recalcula tenant_storage_usage ao final.
 * NUNCA toca tripz_ai_attachments (documentos de negócio) nem mensagens/
 * conversas — nenhuma FK de mídia aponta para elas.
 */
export interface PurgeStoredMediaInput {
  stickerIds?: string[];
  followUpIds?: string[];
  instagramIds?: string[];
  clearLogo?: boolean;
}

export async function purgeStoredMediaRows(
  client: PoolClient,
  tenantId: string,
  input: PurgeStoredMediaInput = {}
): Promise<number> {
  let removed = 0;
  const stickerIds = input.stickerIds ?? [];
  const followUpIds = input.followUpIds ?? [];
  const instagramIds = input.instagramIds ?? [];
  if (stickerIds.length > 0) {
    const deleted = await client.query<{ id: string }>(
      "DELETE FROM ai_stickers WHERE tenant_id=$1 AND id=ANY($2::uuid[]) RETURNING id",
      [tenantId, stickerIds]
    );
    for (const row of deleted.rows) {
      await stripFollowUpDeliveryReference(client, tenantId, row.id, ["sticker"]);
    }
    removed += deleted.rowCount ?? 0;
  }
  if (followUpIds.length > 0) {
    const deleted = await client.query<{ id: string }>(
      "DELETE FROM ai_follow_up_media_assets WHERE tenant_id=$1 AND id=ANY($2::uuid[]) RETURNING id",
      [tenantId, followUpIds]
    );
    for (const row of deleted.rows) {
      await stripFollowUpDeliveryReference(client, tenantId, row.id, ["image", "audio", "video"]);
    }
    removed += deleted.rowCount ?? 0;
  }
  if (instagramIds.length > 0) {
    const deleted = await client.query<{ id: string }>(
      "DELETE FROM instagram_media WHERE tenant_id=$1 AND id=ANY($2::uuid[]) RETURNING id",
      [tenantId, instagramIds]
    );
    removed += deleted.rowCount ?? 0;
  }
  if (input.clearLogo) {
    await client.query("UPDATE tenants SET logo_data=NULL WHERE id=$1", [tenantId]);
    removed += 1;
  }
  await recalculateStorageUsage(tenantId, client);
  return removed;
}

export interface StorageRetentionResult {
  tenants_examined: number;
  itens_excluidos: number;
  tenants_com_falha: number;
}

/**
 * Job diário (worker): para cada tenant com config ativa, exclui mídias
 * armazenadas criadas antes do cutoff e recalcula o uso. A config ativa é
 * SEMPRE UMA: meses quando storage_retention_enabled (janela = months*30
 * dias), senão os dias legados (storage_retention_days).
 * A exclusão passa pelo purgeStoredMediaRows (ponto único):
 * - ai_sticker_sends (uso de figurinha) cai junto com a figurinha por FK;
 * - referências em tenant_ai_settings.ai_follow_up_delivery são removidas;
 * - instagram_media é cache por conversa (deletar a linha não toca mensagens);
 * - tripz_ai_attachments ficam FORA da retenção: são documentos de negócio
 *   referenciados por propostas (deletá-los apodreceria a proposta).
 */
export async function runStorageRetention(options: { now?: Date } = {}): Promise<StorageRetentionResult> {
  const now = options.now ?? new Date();
  const tenants = await db.query<{ id: string; window_days: number }>(
    `SELECT id,
            CASE WHEN storage_retention_enabled THEN storage_retention_months * 30
                 ELSE storage_retention_days END window_days
     FROM tenants
     WHERE (storage_retention_enabled AND storage_retention_months IS NOT NULL)
        OR (NOT storage_retention_enabled AND storage_retention_days IS NOT NULL)`
  );
  let itensExcluidos = 0;
  let tenantsComFalha = 0;
  for (const tenant of tenants.rows) {
    const cutoff = new Date(now.getTime() - tenant.window_days * 86_400_000);
    try {
      itensExcluidos += await withTenantTransaction(db, tenant.id, async (client) => {
        const stickerIds = (await client.query<{ id: string }>(
          "SELECT id FROM ai_stickers WHERE tenant_id=$1 AND created_at<$2",
          [tenant.id, cutoff]
        )).rows.map((row) => row.id);
        const followUpIds = (await client.query<{ id: string }>(
          "SELECT id FROM ai_follow_up_media_assets WHERE tenant_id=$1 AND created_at<$2",
          [tenant.id, cutoff]
        )).rows.map((row) => row.id);
        const instagramIds = (await client.query<{ id: string }>(
          "SELECT id FROM instagram_media WHERE tenant_id=$1 AND created_at<$2",
          [tenant.id, cutoff]
        )).rows.map((row) => row.id);
        return purgeStoredMediaRows(client, tenant.id, {
          stickerIds,
          followUpIds,
          instagramIds,
          clearLogo: false
        });
      });
    } catch {
      tenantsComFalha += 1;
    }
  }
  return { tenants_examined: tenants.rows.length, itens_excluidos: itensExcluidos, tenants_com_falha: tenantsComFalha };
}

// ---------------------------------------------------------------------------
// B10 — galeria de mídias armazenadas (5 fontes BYTEA) + exclusão em lote.
// Metadados apenas: os bytes continuam sendo servidos pelos endpoints de mídia
// existentes (figurinhas/follow-up/instagram/tripz/logo).
// ---------------------------------------------------------------------------

export type StorageMediaType = "sticker" | "follow_up" | "instagram" | "tripz" | "logo";

const STORAGE_MEDIA_TYPES: StorageMediaType[] = ["sticker", "follow_up", "instagram", "tripz", "logo"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_US_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const STORAGE_MEDIA_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LIST_MEDIA_DEFAULT_LIMIT = 50;
const LIST_MEDIA_MAX_LIMIT = 100;

export interface StorageMediaItem {
  id: string;
  type: StorageMediaType;
  deletable: boolean;
  created_at: string;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number;
  content_hash: string | null;
}

export interface StorageMediaPage {
  items: StorageMediaItem[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * As três fontes com content_hash deduplicam por conteúdo (mesmo arquivo não
 * aparece duas vezes — DISTINCT ON fica com a linha mais recente);
 * instagram_media (cache sem hash) e a logo (coluna do tenant) não deduplicam.
 * A logo usa created_at=época: não tem própria e o keyset exige um valor
 * estável entre páginas.
 */
const LIST_MEDIA_SQL = `
WITH dedupe_sources AS (
  SELECT 'sticker'::text type, s.id::text id, s.created_at, s.content_hash::text content_hash,
         s.mime_type, s.file_name, s.size_bytes::bigint size_bytes, true deletable
  FROM ai_stickers s WHERE s.tenant_id=$1
  UNION ALL
  SELECT 'follow_up'::text, f.id::text, f.created_at, f.content_hash::text,
         f.mime_type, f.file_name, f.size_bytes::bigint, true
  FROM ai_follow_up_media_assets f WHERE f.tenant_id=$1
  UNION ALL
  SELECT 'tripz'::text, t.id::text, t.created_at, t.content_hash::text,
         t.mime_type, t.file_name, t.size_bytes::bigint, false
  FROM tripz_ai_attachments t WHERE t.tenant_id=$1
),
deduped AS (
  SELECT DISTINCT ON (content_hash)
         type,id,created_at,content_hash,mime_type,file_name,size_bytes,deletable
  FROM dedupe_sources
  ORDER BY content_hash, created_at DESC, id DESC
),
all_media AS (
  SELECT type,id,created_at,content_hash,mime_type,file_name,size_bytes,deletable FROM deduped
  UNION ALL
  SELECT 'instagram'::text, i.id::text, i.created_at, NULL::text, i.content_type,
         NULL::text, i.size_bytes, true
  FROM instagram_media i WHERE i.tenant_id=$1
  UNION ALL
  SELECT 'logo'::text, lg.id::text, 'epoch'::timestamptz, NULL::text,
         CASE WHEN lg.logo_data LIKE 'data:%;%' THEN split_part(split_part(lg.logo_data,':',2),';',1) END,
         'logo-do-workspace'::text,
         COALESCE(CASE WHEN lg.logo_data IS NULL THEN 0
                       WHEN lg.logo_data LIKE 'data:%,%'
                         THEN octet_length(decode(split_part(lg.logo_data,',',2),'base64'))
                       ELSE octet_length(lg.logo_data) END,0)::bigint,
         true
  FROM tenants lg WHERE lg.id=$1 AND lg.logo_data IS NOT NULL
)
SELECT type,id,created_at,content_hash,mime_type,file_name,size_bytes,deletable,
       to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at_key
FROM all_media
WHERE ($2::text IS NULL OR type=$2)
  AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)
  AND ($4::timestamptz IS NULL OR created_at < $4::timestamptz)
  AND ($5::text IS NULL OR (created_at,type,id) < ($5::timestamptz,$6::text,$7::text))
ORDER BY created_at DESC,type DESC,id DESC
LIMIT ($8::int + 1)`; // lookahead: has_more = rows > limit

export function encodeStorageMediaCursor(row: { created_at_key: string; type: string; id: string }): string {
  return `${row.created_at_key}|${row.type}|${row.id}`;
}

function decodeStorageMediaCursor(raw: string): { at: string; type: StorageMediaType; id: string } {
  const parts = raw.split("|");
  if (parts.length !== 3
    || !ISO_US_PATTERN.test(parts[0])
    || !STORAGE_MEDIA_TYPES.includes(parts[1] as StorageMediaType)
    || !UUID_PATTERN.test(parts[2])) {
    throw httpError(400, "Cursor inválido");
  }
  return { at: parts[0], type: parts[1] as StorageMediaType, id: parts[2] };
}

/** 00:00 local → UTC; data impossível (ex. 2026-13-99) é 400, não 500. */
function localDateToUtcOr400(date: string, timezone: string): Date {
  try {
    return localDateTimeToUtc(date, "00:00", timezone);
  } catch {
    throw httpError(400, `Data inválida: ${date}`);
  }
}

export async function listStorageMedia(
  tenantId: string,
  input: { type?: StorageMediaType; from?: string; to?: string; cursor?: string; limit?: number } = {}
): Promise<StorageMediaPage> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? LIST_MEDIA_DEFAULT_LIMIT), 1), LIST_MEDIA_MAX_LIMIT);
  for (const key of ["from", "to"] as const) {
    const value = input[key];
    if (value !== undefined && !STORAGE_MEDIA_DATE_PATTERN.test(value)) {
      throw httpError(400, "Datas devem usar o formato AAAA-MM-DD");
    }
  }
  if (input.from && input.to && input.to < input.from) {
    throw httpError(400, "A data final deve ser igual ou posterior à inicial");
  }
  const timezone = (await db.query<{ timezone: string }>(
    "SELECT timezone FROM tenants WHERE id=$1",
    [tenantId]
  )).rows[0]?.timezone ?? "UTC";
  const cursor = input.cursor ? decodeStorageMediaCursor(input.cursor) : null;
  const result = await db.query<{
    id: string; type: StorageMediaType; deletable: boolean; created_at: Date;
    file_name: string | null; mime_type: string | null; size_bytes: string;
    content_hash: string | null; created_at_key: string;
  }>(
    LIST_MEDIA_SQL,
    [
      tenantId,
      input.type ?? null,
      input.from ? localDateToUtcOr400(input.from, timezone) : null,
      input.to ? localDateToUtcOr400(shiftDateKey(input.to, 1), timezone) : null,
      cursor?.at ?? null,
      cursor?.type ?? null,
      cursor?.id ?? null,
      limit
    ]
  );
  const hasMore = result.rows.length > limit;
  const page = result.rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => ({
      id: row.id,
      type: row.type,
      deletable: row.deletable,
      created_at: row.created_at.toISOString(),
      file_name: row.file_name,
      mime_type: row.mime_type,
      size_bytes: Number(row.size_bytes),
      content_hash: row.content_hash
    })),
    has_more: hasMore,
    next_cursor: hasMore && last ? encodeStorageMediaCursor(last) : null
  };
}

export interface StorageMediaDeleteItem {
  // União completa: tripz entra para poder ser REJEITADO com mensagem clara
  // (documentos de negócio) em vez de falhar na validação de payload.
  type: StorageMediaType;
  id: string;
}

/**
 * DELETE em lote da galeria — passa OBRIGATORIAMENTE pelo purgeStoredMediaRows
 * (ponto único de exclusão). tripz NÃO é deletável: documentos de negócio
 * referenciados por propostas. Logo não tem linha: vira logo_data=NULL.
 */
export async function deleteStorageMediaBatch(
  tenantId: string,
  items: StorageMediaDeleteItem[],
  actor: StorageActor
): Promise<{ deleted: number; storage: OrganizationStorage }> {
  if (items.some((item) => item.type === "tripz")) {
    throw httpError(400, "Anexos do Tripz são documentos de negócio e não podem ser excluídos");
  }
  const unique = new Map(items.map((item) => [`${item.type}:${item.id}`, item] as const));
  const values = [...unique.values()];
  const stickerIds = values.filter((item) => item.type === "sticker").map((item) => item.id);
  const followUpIds = values.filter((item) => item.type === "follow_up").map((item) => item.id);
  const instagramIds = values.filter((item) => item.type === "instagram").map((item) => item.id);
  const clearLogo = values.some((item) => item.type === "logo");
  const deleted = await withTenantTransaction(db, tenantId, async (client) => {
    const removed = await purgeStoredMediaRows(client, tenantId, {
      stickerIds,
      followUpIds,
      instagramIds,
      clearLogo
    });
    await client.query(
      `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
       VALUES($1,$2,$3,'organization.storage.media.delete','workspace',$4,$5,$6,$7)`,
      [actor.userId, tenantId, actor.actorScope, tenantId,
        {
          itens: removed,
          por_tipo: {
            sticker: stickerIds.length,
            follow_up: followUpIds.length,
            instagram: instagramIds.length,
            logo: clearLogo ? 1 : 0
          }
        },
        actor.ipAddress ?? null, actor.userAgent ?? null]
    );
    return removed;
  });
  return { deleted, storage: await getOrganizationStorage(tenantId) };
}

const storageMediaTypeSchema = z.enum(STORAGE_MEDIA_TYPES as [StorageMediaType, ...StorageMediaType[]]);
const storageMediaQuerySchema = z.object({
  type: storageMediaTypeSchema.optional(),
  from: z.string().regex(STORAGE_MEDIA_DATE_PATTERN).optional(),
  to: z.string().regex(STORAGE_MEDIA_DATE_PATTERN).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(LIST_MEDIA_MAX_LIMIT).optional()
}).strict();

const storageMediaDeleteSchema = z.object({
  items: z.array(z.object({
    type: storageMediaTypeSchema,
    id: z.string().uuid()
  }).strict()).min(1).max(200)
}).strict();

/**
 * B10 — rotas da galeria (o GET/PATCH de /organization/storage e o PATCH de
 * settings continuam em organization/routes.ts; aqui só a mídia em si).
 */
export async function registerOrganizationStorageRoutes(app: FastifyInstance): Promise<void> {
  app.get("/organization/storage/media", async (request) => {
    const session = await requirePermission(request, "storage.manage");
    const query = storageMediaQuerySchema.parse(request.query ?? {});
    return await listStorageMedia(session.tenantId, query);
  });
  app.delete("/organization/storage/media", async (request) => {
    const session = await requirePermission(request, "storage.manage");
    const body = storageMediaDeleteSchema.parse(request.body);
    return await deleteStorageMediaBatch(session.tenantId, body.items, {
      userId: session.userId,
      actorScope: session.actorScope,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"]
    });
  });
}
