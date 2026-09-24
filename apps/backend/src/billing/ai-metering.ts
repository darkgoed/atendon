import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { recordUsage } from "./usage.js";
import { getLimit } from "./entitlements.js";
import { db } from "../db/client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";

export const AI_INTERACTION_METRIC = "MAX_AI_INTERACTIONS";
type AiPurpose = "inbound_reply" | "follow_up" | "copilot_suggestion";

export function buildAiTurnIdempotencyKey(tenantId: string, purpose: AiPurpose, logicalTurnId: string): string {
  return createHash("sha256").update(`${tenantId}\0${purpose}\0${logicalTurnId}`, "utf8").digest("hex");
}

export async function recordAiInteraction(client: PoolClient, tenantId: string, purpose: AiPurpose, logicalTurnId: string, metadata?: Record<string, unknown>): Promise<void> {
  await recordUsage(client, tenantId, AI_INTERACTION_METRIC, 1, buildAiTurnIdempotencyKey(tenantId, purpose, logicalTurnId), metadata);
}

/** @deprecated Legacy compatibility for old tests/integrations. Production uses consumeAiInteraction. */
export async function canConsumeAiInteraction(tenantId: string): Promise<boolean> {
  try {
    const limit = await getLimit(tenantId, AI_INTERACTION_METRIC);
    if (limit === null) return true;
    if (limit === 0) return false;
    // Legacy metering is backed by usage_counters. The newer usage_periods
    // ledger is consumed by billing/ai-consumption.ts and must not replace
    // this compatibility path.
    const usedResult = await db.query<{ used: string }>(
      `SELECT COALESCE(used,0) used FROM usage_counters
       WHERE tenant_id=$1 AND metric_key=$2
         AND period_start=(SELECT current_period_start FROM tenant_subscriptions WHERE tenant_id=$1)`,
      [tenantId, AI_INTERACTION_METRIC]
    );
    const used = Number(usedResult.rows[0]?.used ?? 0);
    return used < limit;
  } catch (error) {
    console.error(`[billing] failed to check AI interaction quota for tenant ${tenantId}`, error);
    return true;
  }
}

export async function recordAiInteractionForTenant(tenantId: string, purpose: AiPurpose, logicalTurnId: string, metadata?: Record<string, unknown>): Promise<void> {
  await withTenantTransaction(db, tenantId, (client) => recordAiInteraction(client, tenantId, purpose, logicalTurnId, metadata));
}

/**
 * Reserva UMA interação de IA de forma atômica e idempotente.
 *
 * Por que existe: `canConsumeAiInteraction` sozinha é uma checagem sem lock —
 * duas mensagens simultâneas do mesmo tenant podem ler o mesmo saldo e ambas
 * passarem, estourando a franquia (achado ALTO da revisão da Fase 8).
 * Aqui a leitura do saldo e a gravação do consumo acontecem na MESMA transação,
 * serializada por tenant com `SELECT ... FOR UPDATE` em tenant_subscriptions —
 * o mesmo mecanismo já usado por `assertLimitWithinTransaction`.
 *
 * Idempotência: a chave deriva do turno lógico, então reprocessar o mesmo turno
 * (retentativa de job) reserva sem consumir de novo e devolve `true`.
 *
 * @deprecated Legacy compatibility for old tests/integrations. Production uses consumeAiInteraction.
 */
export async function reserveAiInteraction(tenantId: string, purpose: AiPurpose, logicalTurnId: string, metadata?: Record<string, unknown>): Promise<boolean> {
  try {
    return await withTenantTransaction(db, tenantId, async (client) => {
      const subscription = await client.query<{ id: string }>(
        "SELECT id FROM tenant_subscriptions WHERE tenant_id=$1 FOR UPDATE",
        [tenantId]
      );
      // Sem assinatura: fail-open (protege quem já estava em produção).
      if (!subscription.rows[0]) {
        await recordAiInteraction(client, tenantId, purpose, logicalTurnId, metadata);
        return true;
      }
      const limit = await getLimit(tenantId, AI_INTERACTION_METRIC);
      if (limit === 0) return false;
      if (limit !== null) {
        const used = await client.query<{ used: string }>(
          `SELECT COALESCE(used,0) used FROM usage_counters
           WHERE tenant_id=$1 AND metric_key=$2
             AND period_start=(SELECT current_period_start FROM tenant_subscriptions WHERE tenant_id=$1)`,
          [tenantId, AI_INTERACTION_METRIC]
        );
        const alreadyCounted = await client.query(
          "SELECT 1 FROM usage_events WHERE tenant_id=$1 AND metric_key=$2 AND idempotency_key=$3",
          [tenantId, AI_INTERACTION_METRIC, buildAiTurnIdempotencyKey(tenantId, purpose, logicalTurnId)]
        );
        // Turno já contabilizado antes: liberar sem consumir de novo.
        if (alreadyCounted.rowCount) return true;
        if (Number(used.rows[0]?.used ?? 0) >= limit) return false;
      }
      await recordAiInteraction(client, tenantId, purpose, logicalTurnId, metadata);
      return true;
    });
  } catch (error) {
    console.error(`[billing] failed to reserve AI interaction for tenant ${tenantId}`, error);
    return true;
  }
}
