// R4 — Armazenamento da empresa (specs/active/v6-evolucao-estrutural-atendon.md).
// Quota/bloqueio/uso/associação/retenção dos bytes que o backend guarda hoje
// (ver descoberta no relatório): ai_stickers, ai_follow_up_media_assets,
// instagram_media, tripz_ai_attachments e tenants.logo_data. Mídia de
// conversas WhatsApp NÃO é persistida (download on-demand no gateway), então
// não entra no uso — e nunca é bloqueada.
//
// Ponto único de exclusão é o job diário (runStorageRetention, chamado pelo
// worker); nada aqui apaga em cascata mensagens/conversas — as FKs que saem
// das tabelas de mídia apontam apenas para registros de uso (ai_sticker_sends)
// e referências de configuração (tenant_ai_settings.ai_follow_up_delivery),
// que são explicitamente limpas.
import type { PoolClient } from "pg";
import { db } from "../../db/client.js";
import { withTenantTransaction } from "../../db/tenant-transaction.js";

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

export interface OrganizationStorage {
  used_bytes: number;
  quota_bytes: number | null;
  retention_days: number | null;
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
    per_origem: perOrigem
  };
}

export async function updateStorageSettings(
  tenantId: string,
  input: { storage_quota_bytes?: number | null; retention_days?: number | null },
  actor: StorageActor
): Promise<{ used_bytes: number; quota_bytes: number | null; retention_days: number | null }> {
  const sets: string[] = [];
  const values: unknown[] = [tenantId];
  if (input.storage_quota_bytes !== undefined) {
    values.push(input.storage_quota_bytes);
    sets.push(`storage_quota_bytes=$${values.length}::bigint`);
  }
  if (input.retention_days !== undefined) {
    values.push(input.retention_days);
    sets.push(`storage_retention_days=$${values.length}::int`);
  }
  if (sets.length === 0) throw Object.assign(new Error("Informe ao menos um campo"), { statusCode: 400 });
  return withTenantTransaction(db, tenantId, async (client) => {
    const result = await client.query<{ storage_quota_bytes: string | null; storage_retention_days: number | null }>(
      `UPDATE tenants SET ${sets.join(",")} WHERE id=$1
       RETURNING storage_quota_bytes,storage_retention_days`,
      values
    );
    if (!result.rows[0]) throw Object.assign(new Error("Workspace não encontrado"), { statusCode: 404 });
    const usedBytes = await recalculateStorageUsage(tenantId, client);
    await client.query(
      `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
       VALUES($1,$2,$3,'organization.storage.settings.update','workspace',$4,$5,$6,$7)`,
      [actor.userId, tenantId, actor.actorScope, tenantId,
        {
          storage_quota_bytes: result.rows[0].storage_quota_bytes === null ? null : Number(result.rows[0].storage_quota_bytes),
          retention_days: result.rows[0].storage_retention_days
        },
        actor.ipAddress ?? null, actor.userAgent ?? null]
    );
    return {
      used_bytes: usedBytes,
      quota_bytes: result.rows[0].storage_quota_bytes === null ? null : Number(result.rows[0].storage_quota_bytes),
      retention_days: result.rows[0].storage_retention_days
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

export interface StorageRetentionResult {
  tenants_examined: number;
  itens_excluidos: number;
  tenants_com_falha: number;
}

/**
 * Job diário (worker): para cada tenant com storage_retention_days setado,
 * exclui mídias armazenadas criadas há mais de N dias e recalcula o uso.
 * PONTO ÚNICO de exclusão — nenhuma cascata atinge messages/conversations:
 * - ai_sticker_sends (uso de figurinha) cai junto com a figurinha por FK;
 * - referências em tenant_ai_settings.ai_follow_up_delivery são removidas;
 * - instagram_media é cache por conversa (deletar a linha não toca mensagens);
 * - tripz_ai_attachments ficam FORA da retenção: são documentos de negócio
 *   referenciados por propostas (deletá-los apodreceria a proposta).
 */
export async function runStorageRetention(options: { now?: Date } = {}): Promise<StorageRetentionResult> {
  const now = options.now ?? new Date();
  const tenants = await db.query<{ id: string; storage_retention_days: number }>(
    "SELECT id,storage_retention_days FROM tenants WHERE storage_retention_days IS NOT NULL"
  );
  let itensExcluidos = 0;
  let tenantsComFalha = 0;
  for (const tenant of tenants.rows) {
    const cutoff = new Date(now.getTime() - tenant.storage_retention_days * 86_400_000);
    try {
      itensExcluidos += await withTenantTransaction(db, tenant.id, async (client) => {
        const stickers = await client.query<{ id: string }>(
          "DELETE FROM ai_stickers WHERE tenant_id=$1 AND created_at<$2 RETURNING id",
          [tenant.id, cutoff]
        );
        const followUp = await client.query<{ id: string }>(
          "DELETE FROM ai_follow_up_media_assets WHERE tenant_id=$1 AND created_at<$2 RETURNING id",
          [tenant.id, cutoff]
        );
        const instagram = await client.query<{ id: string }>(
          "DELETE FROM instagram_media WHERE tenant_id=$1 AND created_at<$2 RETURNING id",
          [tenant.id, cutoff]
        );
        for (const row of followUp.rows) {
          await stripFollowUpDeliveryReference(client, tenant.id, row.id, ["image", "audio", "video"]);
        }
        for (const row of stickers.rows) {
          await stripFollowUpDeliveryReference(client, tenant.id, row.id, ["sticker"]);
        }
        await recalculateStorageUsage(tenant.id, client);
        return (stickers.rowCount ?? 0) + (followUp.rowCount ?? 0) + (instagram.rowCount ?? 0);
      });
    } catch {
      tenantsComFalha += 1;
    }
  }
  return { tenants_examined: tenants.rows.length, itens_excluidos: itensExcluidos, tenants_com_falha: tenantsComFalha };
}
