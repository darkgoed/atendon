import type { PoolClient } from "pg";
import { db } from "../../db/client.js";

/**
 * Motivos de perda/desqualificação são um catálogo POR TENANT
 * (migration 0129). Antes eram sete valores fixos num CHECK global, o que
 * fazia o vocabulário comercial de um cliente vazar para os outros. A verdade
 * agora é a tabela `lead_loss_reasons`, referenciada por FK.
 */
export type LossReasonRow = {
  id: string;
  key: string;
  label: string;
  position: number;
  requires_note: boolean;
  is_system: boolean;
  archived_at: string | null;
};

export const lossReasonMapper = (row: LossReasonRow) => ({
  id: row.id,
  chave: row.key,
  rotulo: row.label,
  posicao: row.position,
  exige_observacao: row.requires_note,
  sistema: row.is_system,
  arquivado_em: row.archived_at
});

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

export async function listLossReasons(
  tenantId: string,
  includeArchived = false,
  client: Pick<PoolClient, "query"> = db
): Promise<LossReasonRow[]> {
  const result = await client.query<LossReasonRow>(
    `SELECT id,key,label,position,requires_note,is_system,archived_at
     FROM lead_loss_reasons
     WHERE tenant_id=$1 AND ($2 OR archived_at IS NULL)
     ORDER BY position,label`,
    [tenantId, includeArchived]
  );
  return result.rows;
}

/**
 * Valida o motivo contra o catálogo do tenant e normaliza a observação.
 * A observação é obrigatória quando o motivo exige (ex.: "Outro"), porque um
 * motivo genérico sem texto não informa nada ao closer.
 */
export async function resolveLossReason(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  key: string,
  note?: string | null
): Promise<{ key: string; note: string | null }> {
  const found = await client.query<LossReasonRow>(
    "SELECT id,key,label,position,requires_note,is_system,archived_at FROM lead_loss_reasons WHERE tenant_id=$1 AND key=$2",
    [tenantId, key]
  );
  const reason = found.rows[0];
  if (!reason) throw httpError(400, `Motivo de perda desconhecido: ${key}`);
  if (reason.archived_at) throw httpError(400, `Motivo de perda arquivado: ${reason.label}`);
  const trimmed = typeof note === "string" ? note.trim() : "";
  if (reason.requires_note && !trimmed) {
    throw httpError(400, `Descreva o motivo no campo de observação para "${reason.label}"`);
  }
  return { key: reason.key, note: trimmed ? trimmed.slice(0, 500) : null };
}

export async function createLossReason(
  tenantId: string,
  input: { chave: string; rotulo: string; posicao?: number; exige_observacao?: boolean }
): Promise<LossReasonRow> {
  const exists = await db.query(
    "SELECT 1 FROM lead_loss_reasons WHERE tenant_id=$1 AND key=$2",
    [tenantId, input.chave]
  );
  if (exists.rows[0]) throw httpError(409, "Já existe um motivo com essa chave");
  const created = await db.query<LossReasonRow>(
    `INSERT INTO lead_loss_reasons(tenant_id,key,label,position,requires_note,is_system)
     VALUES($1,$2,$3,$4,$5,false)
     RETURNING id,key,label,position,requires_note,is_system,archived_at`,
    [tenantId, input.chave, input.rotulo, input.posicao ?? 500, input.exige_observacao ?? false]
  );
  return created.rows[0];
}

export async function updateLossReason(
  tenantId: string,
  id: string,
  input: { rotulo?: string; posicao?: number; exige_observacao?: boolean; arquivado?: boolean }
): Promise<LossReasonRow> {
  const current = await db.query<LossReasonRow>(
    "SELECT id,key,label,position,requires_note,is_system,archived_at FROM lead_loss_reasons WHERE tenant_id=$1 AND id=$2",
    [tenantId, id]
  );
  if (!current.rows[0]) throw httpError(404, "Motivo de perda não encontrado");
  const updated = await db.query<LossReasonRow>(
    `UPDATE lead_loss_reasons SET
       label=COALESCE($3,label),
       position=COALESCE($4,position),
       requires_note=COALESCE($5,requires_note),
       archived_at=CASE WHEN $6::boolean IS NULL THEN archived_at WHEN $6 THEN COALESCE(archived_at,now()) ELSE NULL END,
       updated_at=now()
     WHERE tenant_id=$1 AND id=$2
     RETURNING id,key,label,position,requires_note,is_system,archived_at`,
    [tenantId, id, input.rotulo ?? null, input.posicao ?? null, input.exige_observacao ?? null, input.arquivado ?? null]
  );
  return updated.rows[0];
}
