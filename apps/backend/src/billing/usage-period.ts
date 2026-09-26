import type { PoolClient } from "pg";
import { closePeriodAndGrantRollover } from "./rollover.js";

export type UsagePeriodRow = {
  id: string;
  tenant_id: string;
  subscription_id: string | null;
  sequence: number;
  start_at: Date;
  end_at: Date;
  included_limit: string | null;
  included_usage: string;
  rollover_granted: string;
  rollover_usage: string;
  bonus_granted: string;
  bonus_usage: string;
  overage_usage: string;
  overage_amount_brl_cents: string;
  reserved_cents: string;
  usage_unit: "INTERACTION" | "CREDIT";
  reserved_credits: string;
  provider_cost_usd_micros: string;
  status: "OPEN" | "CLOSED" | "INVOICED";
  closed_at: Date | null;
  invoiced_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type SubscriptionRow = { id: string; plan_id: string; current_period_start: Date; current_period_end: Date };
type PeriodState = {
  open: UsagePeriodRow | null;
  /** true quando existe periodo OPEN e ele ainda esta vigente (end_at > now()), decidido pelo BANCO. */
  open_is_current: boolean | null;
  latest: { start_at: string; end_at: string; sequence: number } | null;
};

export const AI_INTERACTION_LIMIT_KEY = "MAX_AI_INTERACTIONS";
export const AI_CREDIT_LIMIT_KEY = "MAX_AI_CREDITS";

const periodColumns = `id, tenant_id, subscription_id, sequence, start_at, end_at,
  included_limit, included_usage, rollover_granted, rollover_usage, bonus_granted,
  bonus_usage, overage_usage, overage_amount_brl_cents, reserved_cents, usage_unit,
  reserved_credits, provider_cost_usd_micros, status, closed_at, invoiced_at, created_at, updated_at`;

export async function effectiveLimit(client: PoolClient, tenantId: string, planId: string, limitKey: string = AI_INTERACTION_LIMIT_KEY): Promise<number | null> {
  const result = await client.query<{ limit_value: string | null }>(
    `SELECT CASE WHEN o.tenant_id IS NOT NULL THEN o.int_value::text ELSE pl.limit_value::text END AS limit_value
       FROM plans p
       LEFT JOIN plan_limits pl ON pl.plan_id = p.id AND pl.limit_key = $3
       LEFT JOIN tenant_entitlement_overrides o ON o.tenant_id = $1 AND o.kind = 'limit'
        AND o.entitlement_key = $3 AND (o.expires_at IS NULL OR o.expires_at > now())
      WHERE p.id = $2 LIMIT 1`, [tenantId, planId, limitKey]
  );
  return result.rows[0]?.limit_value == null ? null : Number(result.rows[0].limit_value);
}

async function readPeriodState(client: PoolClient, tenantId: string): Promise<PeriodState> {
  // A vigencia do periodo e decidida pelo BANCO (end_at > now()), nunca em JS:
  // row_to_json devolve end_at como STRING, e comparar `Date < string` em JS
  // resulta sempre em false — o que fazia o avanco de periodo girar ate o limite.
  const result = await client.query<PeriodState>(
    `SELECT
       (SELECT row_to_json(u) FROM (SELECT ${periodColumns} FROM usage_periods WHERE tenant_id=$1 AND status='OPEN' LIMIT 1) u) AS open,
       (SELECT end_at > now() FROM usage_periods WHERE tenant_id=$1 AND status='OPEN' LIMIT 1) AS open_is_current,
       (SELECT row_to_json(p) FROM (SELECT start_at, end_at, sequence FROM usage_periods WHERE tenant_id=$1 ORDER BY start_at DESC LIMIT 1) p) AS latest`,
    [tenantId]
  );
  return result.rows[0];
}

async function readOpen(client: PoolClient, tenantId: string): Promise<UsagePeriodRow | null> {
  const result = await client.query<UsagePeriodRow>(`SELECT ${periodColumns} FROM usage_periods WHERE tenant_id=$1 AND status='OPEN'`, [tenantId]);
  return result.rows[0] ?? null;
}

/**
 * Snapshot do período novo = saldo REAL das fontes ativas na MESMA unidade:
 * rollover_ledger não expirado + usage_grants (BONUS/CREDIT_PACKAGE) restantes.
 * Espelha exatamente a elegibilidade do consumo (consumeAiInteraction):
 * rollover exige expires_at > now() (NULL nunca é consumível) e grants aceitam
 * NULL. SET (nunca +=): o rollover gerado no fechamento já está no ledger —
 * somar no contador duplicaria; grants concedidos no próprio período seguem
 * sendo incrementados por quem concede (ledger.ts/credit-packs.ts). Assim,
 * pacotes concedidos em ciclos anteriores — inclusive retidos em períodos
 * legados INTERACTION — e sobras de rollover de ciclos anteriores entram na
 * visão do ciclo novo; consumos antigos ficam nos períodos antigos
 * (bonus_usage/rollover_usage nascem 0). Roda uma única vez, na criação.
 */
async function syncCarryoverSnapshot(client: PoolClient, periodId: string): Promise<void> {
  await client.query(
    `UPDATE usage_periods p SET
       rollover_granted = COALESCE((SELECT SUM(l.generated_amount - l.consumed_amount - l.expired_amount)
          FROM rollover_ledger l
         WHERE l.tenant_id = p.tenant_id AND l.usage_unit = p.usage_unit
           AND l.expires_at > now()
           AND l.generated_amount - l.consumed_amount - l.expired_amount > 0), 0),
       bonus_granted = COALESCE((SELECT SUM(g.amount - g.consumed_amount)
          FROM usage_grants g
         WHERE g.tenant_id = p.tenant_id AND g.usage_unit = p.usage_unit
           AND g.kind IN ('BONUS','CREDIT_PACKAGE')
           AND (g.expires_at IS NULL OR g.expires_at > now())
           AND g.amount - g.consumed_amount > 0), 0),
       updated_at = now()
     WHERE p.id = $1`,
    [periodId]
  );
}

export async function ensureOpenPeriod(client: PoolClient, tenantId: string): Promise<UsagePeriodRow | null> {
  const subscription = await client.query<SubscriptionRow>(
    `SELECT id, plan_id, current_period_start, current_period_end FROM tenant_subscriptions WHERE tenant_id=$1`, [tenantId]
  );
  const sub = subscription.rows[0];
  if (!sub) return null;

  let state = await readPeriodState(client, tenantId);
  let open = state.open;
  let iterations = 0;
  // Períodos novos nascem em créditos normalizados quando o plano define
  // MAX_AI_CREDITS; sem o limite o plano segue no modo legado de interações.
  const creditLimit = await effectiveLimit(client, tenantId, sub.plan_id, AI_CREDIT_LIMIT_KEY);
  const useCredits = creditLimit !== null;
  while (true) {
    if (open && state.open_is_current === true) return open;
    const source = open;
    if (source) {
      await client.query(`UPDATE usage_periods SET status='CLOSED', closed_at=now(), updated_at=now() WHERE id=$1 AND status='OPEN'`, [source.id]);
    }
    const prior = state.latest;
    const limit = useCredits ? creditLimit : await effectiveLimit(client, tenantId, sub.plan_id);
    if (iterations++ >= 60) throw new Error(`usage period advancement exceeded 60 periods for tenant ${tenantId}`);

    await client.query("SAVEPOINT sp_open_period");
    try {
      const inserted = await client.query<UsagePeriodRow>(
        `INSERT INTO usage_periods (tenant_id, subscription_id, sequence, start_at, end_at, included_limit, usage_unit, status)
         VALUES ($1,$2,$3,$4::timestamptz,$4::timestamptz + interval '1 month',$5,$6,'OPEN') RETURNING ${periodColumns}`,
        [tenantId, sub.id, prior ? prior.sequence + 1 : 1, prior?.end_at ?? sub.current_period_start, limit, useCredits ? "CREDIT" : "INTERACTION"]
      );
      await client.query("RELEASE SAVEPOINT sp_open_period");
      open = inserted.rows[0];
      if (source) await closePeriodAndGrantRollover(client, tenantId, source.id, open.id);
      await syncCarryoverSnapshot(client, open.id);
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT sp_open_period");
      if ((error as { code?: string }).code !== "23505") throw error;
      open = await readOpen(client, tenantId);
      if (!open) throw error;
    }
    state = await readPeriodState(client, tenantId);
    open = state.open ?? open;
  }
}

export async function getOpenPeriod(client: PoolClient, tenantId: string): Promise<UsagePeriodRow | null> {
  return readOpen(client, tenantId);
}

export async function updatePeriodLimitSnapshot(client: PoolClient, tenantId: string, newLimit: number | null): Promise<void> {
  // Só períodos legados de interação recebem o snapshot de MAX_AI_INTERACTIONS;
  // períodos de crédito têm limite próprio (MAX_AI_CREDITS) e não podem ser
  // corrompidos com um valor em outra unidade.
  await client.query(`UPDATE usage_periods SET included_limit=$2, updated_at=now() WHERE tenant_id=$1 AND status='OPEN' AND usage_unit='INTERACTION'`, [tenantId, newLimit]);
}
