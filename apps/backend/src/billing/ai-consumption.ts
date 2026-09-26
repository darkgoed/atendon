import { db } from "../db/client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { PoolClient } from "pg";
import { buildAiTurnIdempotencyKey } from "./ai-metering.js";
import { ensureOpenPeriod } from "./usage-period.js";
import { estimateInteractionCents, estimateTurnCredits, getActivePricingRule, priceInteraction, type AiCostInput, type PricedInteraction } from "./pricing.js";
import { evaluateAlerts } from "./alerts.js";
import { appendFinancialLedgerEntry, grantUsageCredit } from "./ledger.js";
import { detectPaymentVelocity } from "./fraud-signals.js";

type AiPurpose = "inbound_reply" | "follow_up" | "copilot_suggestion";

/** Linha de reserva JÁ travada (FOR UPDATE) pronta para liberação. */
export type AiReservationRow = {
  id: string;
  usage_period_id: string;
  consumption_type: ConsumeResult["consumptionType"];
  billable_amount_brl_cents: string;
  pricing_snapshot: { sourceId?: string; generation?: number } | null;
  /** Opcionais: o reconciler TTL ainda seleciona sem estes campos; faltando, a liberação relê pelo id. */
  usage_unit?: "INTERACTION" | "CREDIT";
  reserved_credits?: string;
};
export type ConsumeResult = {
  allowed: boolean;
  reason?: "AI_DISABLED" | "QUOTA_EXCEEDED" | "CREDIT_CAP_REACHED" | "BILLING_UNAVAILABLE";
  consumptionType?: "INCLUDED" | "ROLLOVER" | "BONUS" | "OVERAGE";
  ledgerId?: string;
  usagePeriodId?: string;
  estimatedCents?: number;
  estimatedCredits?: number;
};

const n = (value: unknown): number => Number(value ?? 0);
/** Marcadores de reserva liberada SEM cobrança (releaseAiReservation). */
const RELEASED_WITHOUT_CHARGE = ["expired_without_usage_logs", "released_without_usage"];
// Retentativa da MESMA chave também reabre um uso tardio que não pôde ser
// cobrado: sem isso a retentativa receberia a reserva antiga (allowed com
// período possivelmente faturado) e rodaria IA sem cobrança. O lote periódico
// NÃO reprocessa late_usage_uncharged (evita tentativa eterna a cada ciclo).
const REOPENABLE_ON_RETRY = [...RELEASED_WITHOUT_CHARGE, "late_usage_uncharged"];

export async function consumeAiInteraction(
  tenantId: string,
  purpose: AiPurpose,
  logicalTurnId: string,
  metadata?: Record<string, unknown>,
): Promise<ConsumeResult> {
  try {
    return await withTenantTransaction(db, tenantId, async (client) => {
      const subscription = await client.query<{ id: string; plan_id: string; ai_enabled: boolean }>(
        `SELECT ts.id, ts.plan_id, COALESCE(p.ai_enabled, true) AS ai_enabled
           FROM tenant_subscriptions ts JOIN plans p ON p.id=ts.plan_id
          WHERE ts.tenant_id=$1 FOR UPDATE`, [tenantId],
      );
      const sub = subscription.rows[0];
      if (!sub) return { allowed: true };
      if (!sub.ai_enabled) return { allowed: false, reason: "AI_DISABLED" };
      return reserveAiTurnInTx(client, tenantId, sub.id, purpose, logicalTurnId, metadata);
    });
  } catch (error) {
    // Never expose provider/SQL details: they may contain credentials or query data.
    const operationalCode = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code).slice(0, 32)
      : "unknown";
    console.error(`[billing] AI reservation unavailable tenant=${tenantId} error_code=${operationalCode}`);
    // The transaction rolls back on error, so no durable reservation exists.
    // A subscribed tenant must not receive free AI when accounting is unhealthy.
    return { allowed: false, reason: "BILLING_UNAVAILABLE" };
  }
}

/**
 * Núcleo da reserva, com a assinatura JÁ travada pelo chamador (FOR UPDATE em
 * tenant_subscriptions — mesma ordem de locks de liberação e reconciliação).
 */
async function reserveAiTurnInTx(
  client: PoolClient,
  tenantId: string,
  subscriptionId: string,
  purpose: AiPurpose,
  logicalTurnId: string,
  metadata?: Record<string, unknown>,
): Promise<ConsumeResult> {
    const period = await ensureOpenPeriod(client, tenantId);
    if (!period) return { allowed: true };
    // Serialize reservations on the period row; the subscription lock alone does
    // not protect a period created/read by concurrent transactions.
    //
    // Relê os acumuladores DEPOIS do lock: `period` foi carregado por
    // ensureOpenPeriod antes de a linha ser travada, então usar os valores
    // dele para decidir o teto deixaria N transações concorrentes lendo o
    // mesmo saldo antigo e todas aprovarem a reserva (estouro do hard cap).
    const locked = await client.query<{ overage_amount_brl_cents: string; reserved_cents: string; reserved_credits: string; included_usage: string; usage_unit: string }>(
      "SELECT overage_amount_brl_cents, reserved_cents, reserved_credits, included_usage, usage_unit FROM usage_periods WHERE id=$1 FOR UPDATE",
      [period.id]
    );
    const current = locked.rows[0] ?? period;
    // Períodos criados antes da normalização seguem em interações (unidade
    // preservada); períodos novos nascem 'CREDIT' (tokens normalizados).
    const creditMode = current.usage_unit === "CREDIT";
    const interactionKey = buildAiTurnIdempotencyKey(tenantId, purpose, logicalTurnId);
    const existing = await client.query<{ id: string; usage_period_id: string; consumption_type: ConsumeResult["consumptionType"]; reconciled: boolean; pricing_snapshot: { reconciliation?: string; generation?: number } | null }>(
      `SELECT id, usage_period_id, consumption_type, reconciled, pricing_snapshot FROM ai_usage_ledger WHERE tenant_id=$1 AND interaction_key=$2 FOR UPDATE`, [tenantId, interactionKey],
    );
    const prior = existing.rows[0];
    // Reserva LIBERADA sem cobrança (TTL/falha) não é crédito grátis para a
    // mesma chave: uma retentativa (follow-up tem chave estável) ou um uso que
    // chegou depois da liberação reabre a MESMA linha como reserva nova — a
    // chave única (tenant_id, interaction_key) impede um segundo INSERT.
    const reopen = Boolean(prior?.reconciled && REOPENABLE_ON_RETRY.includes(prior.pricing_snapshot?.reconciliation ?? ""));
    if (prior && !reopen) return { allowed: true, consumptionType: prior.consumption_type, ledgerId: prior.id, usagePeriodId: prior.usage_period_id };
    // Geração da reserva: os lançamentos financeiros são idempotentes por
    // source_event_id, então cada reabertura precisa de chaves próprias — sem
    // isso a reserva/liberação da geração nova cairia no índice único e seria
    // descartada em silêncio (saldo do financial_ledger divergente).
    const generation = reopen ? Number(prior?.pricing_snapshot?.generation ?? 0) + 1 : 0;

    // A estimativa precisa existir ANTES de escolher a fonte: cada fonte só é
    // elegível se cobrir a reserva inteira (nunca saldo negativo na fonte).
    let estimatedCredits = 0;
    if (creditMode) estimatedCredits = await estimateTurnCredits(client);
    const unitAmount = creditMode ? estimatedCredits : 1;
    let type: ConsumeResult["consumptionType"];
    let sourceId: string | undefined;
    // Fontes de cota (rollover/grant) só valem na MESMA unidade do período.
    const grantUnit = creditMode ? "CREDIT" : "INTERACTION";
    const rollover = await client.query<{ id: string; available: string }>(
      `SELECT id, (generated_amount-consumed_amount-expired_amount) AS available
         FROM rollover_ledger WHERE tenant_id=$1 AND usage_unit=$2 AND expires_at > now() AND generated_amount-consumed_amount-expired_amount >= $3
        ORDER BY expires_at ASC LIMIT 1 FOR UPDATE`, [tenantId, grantUnit, unitAmount],
    );
    if (rollover.rows[0]) { type = "ROLLOVER"; sourceId = rollover.rows[0].id; }
    else {
      const bonus = await client.query<{ id: string; available: string }>(
        `SELECT id, (amount-consumed_amount) AS available FROM usage_grants
          WHERE tenant_id=$1 AND kind IN ('BONUS','CREDIT_PACKAGE') AND usage_unit=$2 AND (expires_at IS NULL OR expires_at > now()) AND amount-consumed_amount >= $3
          ORDER BY expires_at ASC NULLS LAST, created_at ASC LIMIT 1 FOR UPDATE`, [tenantId, grantUnit, unitAmount],
      );
      if (bonus.rows[0]) { type = "BONUS"; sourceId = bonus.rows[0].id; }
      // Teto duro inclui reservas em voo: included_usage JÁ contém as reservas
      // debitadas na reserva, então somar reserved_credits conta duas vezes;
      // a nova reserva só cabe se o teto cobre usage + estimativa desta.
      else if (period.included_limit === null || n(period.included_limit) >= n(current.included_usage) + unitAmount) type = "INCLUDED";
      else type = undefined;
    }

    let estimatedCents = 0;
    if (!type) {
      const settings = await client.query<{ enabled: boolean; limit_type: string; monthly_spending_limit_cents: string | null; confirmed_unlimited_at: Date | null }>(
        `SELECT enabled, limit_type, monthly_spending_limit_cents, confirmed_unlimited_at FROM tenant_usage_credit_settings WHERE tenant_id=$1`, [tenantId],
      );
      const credit = settings.rows[0];
      if (!credit?.enabled) return { allowed: false, reason: "QUOTA_EXCEEDED" };
      if (credit.limit_type === "FIXED") {
        estimatedCents = await estimateInteractionCents(tenantId, client);
        if (n(current.overage_amount_brl_cents) + n(current.reserved_cents) + estimatedCents > n(credit.monthly_spending_limit_cents)) return { allowed: false, reason: "CREDIT_CAP_REACHED" };
      } else if (credit.limit_type !== "UNLIMITED" || !credit.confirmed_unlimited_at) return { allowed: false, reason: "QUOTA_EXCEEDED" };
      type = "OVERAGE";
    }

    const rule = await getActivePricingRule(client);
    const snapshot = JSON.stringify({ ...rule.config, version: rule.version, sourceId, metadata, ...(generation ? { generation, reservedAt: new Date().toISOString() } : {}) });
    const ledger = reopen
      // Reabertura: vai para o período ABERTO atual (o original pode já estar
      // faturado) e zera o estado de liberação; tokens/custo seguem nulos até
      // a reconciliação real.
      ? await client.query<{ id: string }>(
          `UPDATE ai_usage_ledger SET subscription_id=$2, usage_period_id=$3, consumption_type=$4, billable_amount_brl_cents=$5, pricing_strategy=$6, pricing_snapshot=$7, reconciled=false, reconciled_at=NULL, usage_unit=$8, reserved_credits=$9
            WHERE id=$1 AND reconciled=true RETURNING id`,
          [prior!.id, subscriptionId, period.id, type, type === "OVERAGE" ? estimatedCents : 0, rule.strategy, snapshot, current.usage_unit, estimatedCredits],
        )
      : await client.query<{ id: string }>(
          `INSERT INTO ai_usage_ledger (tenant_id, subscription_id, usage_period_id, interaction_key, logical_turn_id, purpose, consumption_type, billable_amount_brl_cents, pricing_strategy, pricing_snapshot, reconciled, usage_unit, reserved_credits)
           VALUES ($1,$2,$3,$4,$5::uuid,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
          [tenantId, subscriptionId, period.id, interactionKey, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(logicalTurnId) ? logicalTurnId : null, purpose, type, type === "OVERAGE" ? estimatedCents : 0, rule.strategy, snapshot, false, current.usage_unit, estimatedCredits],
        );
    const column = type === "INCLUDED" ? "included_usage" : type === "ROLLOVER" ? "rollover_usage" : type === "BONUS" ? "bonus_usage" : "overage_usage";
    await client.query(`UPDATE usage_periods SET ${column}=${column}+$2, reserved_credits=reserved_credits+$3, reserved_cents=reserved_cents+$4, updated_at=now() WHERE id=$1`, [period.id, unitAmount, estimatedCredits, type === "OVERAGE" ? estimatedCents : 0]);
    if (type === "OVERAGE" && estimatedCents > 0) {
      await appendFinancialLedgerEntry(client, tenantId, {
        direction: "CREDIT",
        amountCents: estimatedCents,
        actorType: "AI_RESERVATION",
        reason: "AI usage reservation",
        sourceEventId: generation ? `${interactionKey}:g${generation}` : interactionKey,
        correlationId: period.id,
        metadata: { purpose, logicalTurnId, consumptionType: type },
      });
      await detectPaymentVelocity(client, tenantId);
    }
    if (type === "ROLLOVER") await client.query("UPDATE rollover_ledger SET consumed_amount=consumed_amount+$2 WHERE id=$1", [sourceId, unitAmount]);
    if (type === "BONUS") await client.query("UPDATE usage_grants SET consumed_amount=consumed_amount+$2 WHERE id=$1", [sourceId, unitAmount]);
    await client.query("SAVEPOINT billing_alerts");
    try { await evaluateAlerts(client, tenantId); await client.query("RELEASE SAVEPOINT billing_alerts"); }
    catch (error) { await client.query("ROLLBACK TO SAVEPOINT billing_alerts"); console.error(`[billing] alert evaluation failed for tenant ${tenantId}`, error); }
    return { allowed: true, consumptionType: type, ledgerId: ledger.rows[0].id, usagePeriodId: period.id, ...(type === "OVERAGE" ? { estimatedCents } : {}), ...(creditMode ? { estimatedCredits } : {}) };
}


/**
 * Libera a reserva de um turno que falhou ANTES de o provedor gerar uso.
 * Transacional e idempotente: só atua se o ledger ainda estiver não-conciliado
 * E não existir usage_logs para o requestId — se o provedor chegou a cobrar
 * (usage_logs presente), a reconciliação normal permanece responsável; nunca
 * oferecer IA grátis que o provedor cobrou. Erros são engolidos de propósito:
 * liberar é best-effort, o lote de reconciliação segue como rede de segurança.
 */
export async function releaseAiInteractionWithoutUsage(
  tenantId: string,
  purpose: AiPurpose,
  logicalTurnId: string,
): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(logicalTurnId)) return;
  try {
    await withTenantTransaction(db, tenantId, async (client) => {
      await client.query("SELECT id FROM tenant_subscriptions WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
      const charged = await client.query("SELECT 1 FROM usage_logs WHERE tenant_id=$1 AND request_id=$2::uuid LIMIT 1", [tenantId, logicalTurnId]);
      if (charged.rowCount) return;
      const reservation = await client.query<AiReservationRow>(
        `SELECT id, usage_period_id, consumption_type, billable_amount_brl_cents, pricing_snapshot
           FROM ai_usage_ledger WHERE tenant_id=$1 AND interaction_key=$2 AND reconciled=false FOR UPDATE`,
        [tenantId, buildAiTurnIdempotencyKey(tenantId, purpose, logicalTurnId)],
      );
      const item = reservation.rows[0];
      if (item) await releaseAiReservation(client, tenantId, item, "released_without_usage");
    });
  } catch (error) { console.error(`[billing] failed to release AI reservation without usage for tenant ${tenantId}`, error); }
}

/**
 * Núcleo compartilhado (transacional) de liberação de uma reserva JÁ travada:
 * devolve o contador do período correspondente, a reserva em reserved_cents e a
 * unidade consumida do ledger de origem (rollover/grant), marcando reconciled.
 * O reconciler TTL usa o mesmo caminho — sem isso, vencer o TTL consumia cota
 * incluída/rollover/bônus para sempre. Caller define o marcador de reconciliação.
 */
export async function releaseAiReservation(client: PoolClient, tenantId: string, item: AiReservationRow, reconciliation: string): Promise<void> {
  const type = item.consumption_type;
  // O reconciler TTL seleciona sem usage_unit/reserved_credits — reler aqui
  // quando faltar mantém uma única regra de liberação para os dois chamadores.
  let unit = item.usage_unit;
  let reservedCredits = item.reserved_credits;
  if (unit === undefined || reservedCredits === undefined) {
    const extra = await client.query<{ usage_unit: string; reserved_credits: string }>(
      "SELECT usage_unit, reserved_credits FROM ai_usage_ledger WHERE id=$1", [item.id],
    );
    unit = (extra.rows[0]?.usage_unit as AiReservationRow["usage_unit"]) ?? "INTERACTION";
    reservedCredits = extra.rows[0]?.reserved_credits ?? "0";
  }
  const creditMode = unit === "CREDIT";
  const estimatedCredits = Number(reservedCredits ?? 0);
  const unitAmount = creditMode ? estimatedCredits : 1;
  const column = type === "INCLUDED" ? "included_usage" : type === "ROLLOVER" ? "rollover_usage" : type === "BONUS" ? "bonus_usage" : "overage_usage";
  await client.query(`UPDATE usage_periods SET ${column}=GREATEST(0,${column}-$2), reserved_credits=GREATEST(0,reserved_credits-$3), reserved_cents=GREATEST(0,reserved_cents-$4), updated_at=now() WHERE id=$1`, [item.usage_period_id, unitAmount, estimatedCredits, item.billable_amount_brl_cents]);
  const sourceId = item.pricing_snapshot?.sourceId;
  if (type === "ROLLOVER" && sourceId) await client.query("UPDATE rollover_ledger SET consumed_amount=GREATEST(0,consumed_amount-$3) WHERE id=$2 AND tenant_id=$1", [tenantId, sourceId, unitAmount]);
  if (type === "BONUS" && sourceId) await client.query("UPDATE usage_grants SET consumed_amount=GREATEST(0,consumed_amount-$3) WHERE id=$2 AND tenant_id=$1", [tenantId, sourceId, unitAmount]);
  // Lançamento compensatório: liberar uma reserva OVERAGE sem estornar o CREDIT
  // estimado deixa saldo fantasma no financial_ledger (ROOT /root/billing/ledger).
  // Idempotente pela chave (source_event_id, correlation_id): a mesma liberação
  // repetida (lote TTL, falha de provedor) cai no índice único e não duplica.
  // Mesma transação e ANTES do mark reconciled — se o append falhar (ex. saldo
  // insuficiente), o rollback da transação deixa a reserva aberta e consistente.
  const amountCents = Number(item.billable_amount_brl_cents);
  if (type === "OVERAGE" && amountCents > 0) {
    await appendFinancialLedgerEntry(client, tenantId, {
      direction: "DEBIT",
      amountCents,
      actorType: "AI_RESERVATION",
      reason: "AI usage reservation release",
      // Geração no sufixo: após uma reabertura (uso tardio/retentativa) a nova
      // liberação não pode colidir com a chave idempotente da anterior.
      sourceEventId: item.pricing_snapshot?.generation ? `ai-reservation-release:${item.id}:g${item.pricing_snapshot.generation}` : `ai-reservation-release:${item.id}`,
      correlationId: item.usage_period_id,
      metadata: { reservationId: item.id, reconciliation },
    });
  }
  await client.query(`UPDATE ai_usage_ledger SET reconciled=true, reconciled_at=now(), pricing_snapshot=COALESCE(pricing_snapshot,'{}'::jsonb) || $2::jsonb WHERE id=$1 AND reconciled=false`, [item.id, JSON.stringify({ reconciliation })]);
}

export async function grantAiUsageBonus(input: { tenantId: string; amount: number; reason: string; idempotencyKey: string; grantedByUserId?: string | null; expiresAt?: Date | null }) {
  return withTenantTransaction(db, input.tenantId, async (client) => {
    const period = await ensureOpenPeriod(client, input.tenantId);
    if (!period) return null;
    const grant = await grantUsageCredit(client, { ...input, usagePeriodId: period.id });
    if (grant) {
      await appendFinancialLedgerEntry(client, input.tenantId, {
        direction: "CREDIT",
        amountCents: input.amount,
        actorType: "BONUS_GRANT",
        actorId: input.grantedByUserId,
        reason: input.reason,
        sourceEventId: input.idempotencyKey,
        correlationId: period.id,
        metadata: { usageGrantId: grant.id },
      });
    }
    return grant;
  });
}

/**
 * Compra/concessão de PACOTE de créditos normalizados (tokens equivalentes por
 * custo), ex.: 50M tokens por R$157. Idempotente pela idempotencyKey.
 * Contrato consumido pelo módulo isolado de compras (ver
 * scratch atendon-token-core-interface.md): granta uso_grants kind
 * 'CREDIT_PACKAGE' com usage_unit='CREDIT'; o consumo (consumeAiInteraction)
 * só debita grants na MESMA unidade do período aberto. O valor financeiro do
 * pacote é lançado pelo módulo comprador (appendFinancialLedgerEntry), não aqui.
 */
/**
 * Núcleo do grant de pacote rodando DENTRO de uma transação JÁ aberta do
 * chamador (PoolClient transacionado): o webhook de compra chama isto na PRÓPRIA
 * transação — rollback do chamador estorna o crédito e não há segunda transação
 * concorrente (risco de lock/deadlock e crédito desacoplado da compra).
 * Idempotência pela idempotencyKey (ON CONFLICT DO NOTHING) vale igualmente.
 */
export async function grantAiCreditPackageWithClient(client: PoolClient, input: { tenantId: string; credits: number; reason: string; idempotencyKey: string; grantedByUserId?: string | null; expiresAt?: Date | null }): Promise<{ id: string; amount: string } | null> {
  if (!Number.isFinite(input.credits) || input.credits <= 0) return null;
  const period = await ensureOpenPeriod(client, input.tenantId);
  if (!period) return null;
  const inserted = await client.query<{ id: string; amount: string }>(
    `INSERT INTO usage_grants(tenant_id,usage_period_id,kind,amount,usage_unit,reason,granted_by_user_id,expires_at,idempotency_key)
     VALUES($1,$2,'CREDIT_PACKAGE',$3,'CREDIT',$4,$5,$6,$7)
     ON CONFLICT (tenant_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id, amount`,
    [input.tenantId, period.id, Math.ceil(input.credits), input.reason, input.grantedByUserId ?? null, input.expiresAt ?? null, input.idempotencyKey],
  );
  const grant = inserted.rows[0];
  if (!grant) return null;
  // Só incrementa bonus_granted quando a unidade casa: em período legado de
  // interações o pacote fica retido (consumo exige unidade CREDIT) e o
  // contador de interações não pode inflar.
  if (period.usage_unit === "CREDIT") {
    await client.query("UPDATE usage_periods SET bonus_granted=bonus_granted+$2, updated_at=now() WHERE id=$1", [period.id, grant.amount]);
  }
  return grant;
}

/** Wrapper de conveniência: abre a própria transação e delega ao núcleo. */
export async function grantAiCreditPackage(input: { tenantId: string; credits: number; reason: string; idempotencyKey: string; grantedByUserId?: string | null; expiresAt?: Date | null }): Promise<{ id: string; amount: string } | null> {
  return withTenantTransaction(db, input.tenantId, (client) => grantAiCreditPackageWithClient(client, input));
}

/** Turno já precificado (agregado de uma ou mais chamadas/modelos). */
export type AiTurnPricedUsage = {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  priced: PricedInteraction;
  /** FASE B: custo estimado das chamadas SEM custo reportado, para persistir em usage_logs.priced_cost_usd_micros. */
  calls?: Array<{ usageLogId: string; providerCostUsdMicros: number }>;
};

type AiTurnUsageGroup = {
  model: string | null;
  /** Provider real da chamada (usage_logs.provider); null = desconhecido. */
  provider?: string | null;
  /** hasCost: provedor INFORMOU custo (mesmo 0 = real zero); providerCostUsd null = ausente (único caminho da tabela). */
  hasCost: boolean;
  usageLogId?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  providerCostUsd: number | null;
};

/**
 * Precifica cada chamada do turno com o SEU modelo/preço e agrega: créditos,
 * custo e valores somados por chamada (markup e arredondamento por chamada,
 * sem contaminação entre modelos). Por chamada, custo informado vence a
 * tabela — inclusive 0 informado, que permanece 0 (custo real, créditos 0;
 * 0 ambíguo nunca gera cobrança); só a ausência gera estimativa, e a SOMA do
 * turno inclui TODAS as chamadas precificadas — real E estimada. Modelo
 * histórico do ledger
 * = o de maior custo do turno (informado ou estimado).
 */
export async function priceAiTurn(groups: AiTurnUsageGroup[]): Promise<AiTurnPricedUsage> {
  const pricedGroups: Array<{ group: AiTurnUsageGroup; priced: PricedInteraction }> = [];
  for (const group of groups) {
    // Custo informado (mesmo 0) vence a tabela: 0 reportado é custo REAL zero e
    // nunca vira cobrança inventada; só a AUSÊNCIA (null) cai na tabela.
    const reported = group.hasCost && group.providerCostUsd != null ? group.providerCostUsd : undefined;
    const priced = await priceInteraction({
      model: group.model,
      provider: group.provider ?? null,
      inputTokens: group.inputTokens,
      outputTokens: group.outputTokens,
      cachedTokens: group.cachedTokens,
      cacheWriteTokens: group.cacheWriteTokens,
      providerCostUsd: reported != null && reported > 0 ? reported : undefined,
    });
    if (reported != null && reported <= 0) {
      priced.providerCostUsdMicros = 0;
      priced.providerCostBrlCents = 0;
      priced.billableAmountBrlCents = priced.pricingStrategy === "FIXED_PER_INTERACTION" ? priced.billableAmountBrlCents : 0;
      priced.normalizedCredits = 0;
      priced.inputPricePerMillionMicros = null;
      priced.outputPricePerMillionMicros = null;
      priced.pricingSnapshot.costSource = "provider_reported";
    }
    pricedGroups.push({ group, priced });
  }
  // FASE B: chamadas SEM custo reportado geram custo estimado (tabela) que o
  // chamador persiste em usage_logs.priced_cost_usd_micros; reportadas
  // permanecem raw (custo real do provedor, nada a estimar).
  const calls = pricedGroups
    .filter((g) => g.group.usageLogId && !g.group.hasCost)
    .map((g) => ({ usageLogId: g.group.usageLogId!, providerCostUsdMicros: g.priced.providerCostUsdMicros }));
  const tokens = {
    inputTokens: pricedGroups.reduce((sum, g) => sum + g.group.inputTokens, 0),
    outputTokens: pricedGroups.reduce((sum, g) => sum + g.group.outputTokens, 0),
    cachedTokens: pricedGroups.reduce((sum, g) => sum + g.group.cachedTokens, 0),
  };
  const dominant = pricedGroups.reduce((a, b) => (b.priced.providerCostUsdMicros > a.priced.providerCostUsdMicros ? b : a));
  if (pricedGroups.length === 1) return { model: dominant.group.model, ...tokens, priced: dominant.priced, ...(calls.length ? { calls } : {}) };
  let providerMicros = 0, providerBrlCents = 0, billable = 0, credits = 0;
  const models = pricedGroups.map((g) => {
    providerMicros += g.priced.providerCostUsdMicros;
    providerBrlCents += g.priced.providerCostBrlCents;
    billable += g.priced.billableAmountBrlCents;
    credits += g.priced.normalizedCredits;
    return { model: g.group.model, provider: g.group.provider ?? null, inputTokens: g.group.inputTokens, outputTokens: g.group.outputTokens, cachedTokens: g.group.cachedTokens, cacheWriteInputTokens: g.group.cacheWriteTokens, providerCostUsdMicros: g.priced.providerCostUsdMicros, providerCostBrlCents: g.priced.providerCostBrlCents, billableAmountBrlCents: g.priced.billableAmountBrlCents, normalizedCredits: g.priced.normalizedCredits, fallback: g.priced.pricingSnapshot.fallback };
  });
  const first = dominant.priced.pricingSnapshot;
  const priced: PricedInteraction = {
    providerCostUsdMicros: providerMicros,
    providerCostBrlCents: providerBrlCents,
    billableAmountBrlCents: billable,
    pricingStrategy: dominant.priced.pricingStrategy,
    pricingSnapshot: {
      version: first.version, strategy: first.strategy, markupBps: first.markupBps,
      fixedPricePerInteractionCents: first.fixedPricePerInteractionCents,
      usdBrlRateMicros: first.usdBrlRateMicros,
      creditReferencePricePerMillionMicros: first.creditReferencePricePerMillionMicros,
      models,
    },
    usdBrlRateMicros: dominant.priced.usdBrlRateMicros,
    inputPricePerMillionMicros: null,
    outputPricePerMillionMicros: null,
    normalizedCredits: credits,
    creditReferencePricePerMillionMicros: dominant.priced.creditReferencePricePerMillionMicros,
  };
  return { model: dominant.group.model, ...tokens, priced, ...(calls.length ? { calls } : {}) };
}

export async function reconcileAiInteraction(tenantId: string, purpose: AiPurpose, logicalTurnId: string, actual: AiCostInput): Promise<void> {
  try {
    const priced = await priceInteraction(actual);
    await reconcileAiTurnPriced(tenantId, purpose, logicalTurnId, { model: actual.model, inputTokens: actual.inputTokens, outputTokens: actual.outputTokens, cachedTokens: actual.cachedTokens, priced });
  } catch (error) { console.error(`[billing] failed to reconcile AI interaction for tenant ${tenantId}`, error); }
}

/**
 * Aplica uma reconciliação JÁ precificada: transacional e idempotente (só age
 * sobre a reserva ainda não reconciliada). A precificação acontece FORA da
 * transação para permitir agregar todas as chamadas/modelos do turno num
 * único passe — uma segunda reconciliação não acharia a reserva aberta.
 */
export async function reconcileAiTurnPriced(tenantId: string, purpose: AiPurpose, logicalTurnId: string, turn: AiTurnPricedUsage): Promise<void> {
  try {
    await withTenantTransaction(db, tenantId, async (client) => {
      const subscription = await client.query<{ id: string }>("SELECT id FROM tenant_subscriptions WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
      const key = buildAiTurnIdempotencyKey(tenantId, purpose, logicalTurnId);
      const applyReconciliation = () => client.query<{ id: string; usage_period_id: string; consumption_type: string; reserved: string; usage_unit: string; reserved_credits_est: string; source_id: string | null; generation: number }>(
        // A reserva estimada tem de ser lida ANTES do UPDATE: em Postgres, RETURNING
        // devolve os valores NOVOS da linha, entao `billable_amount_brl_cents` no
        // RETURNING seria o valor REAL recem-gravado, nao a reserva. Subtrair esse
        // valor de reserved_cents liberaria a quantia errada e o spending cap
        // (§17) passaria a derivar. A CTE `before` guarda o valor anterior (e a
        // unidade/reserva de créditos, que governam a correção dos contadores).
        `WITH before AS (
           SELECT id, billable_amount_brl_cents AS reserved, usage_unit, reserved_credits AS reserved_credits_est, pricing_snapshot->>'sourceId' AS source_id, COALESCE((pricing_snapshot->>'generation')::int, 0) AS generation
             FROM ai_usage_ledger WHERE tenant_id=$1 AND interaction_key=$2 AND reconciled=false
         ), upd AS (
           UPDATE ai_usage_ledger l SET model=$3,input_tokens=$4,output_tokens=$5,cached_tokens=$6,input_price_per_million_micros=$7,output_price_per_million_micros=$8,provider_cost_usd_micros=$9,provider_cost_brl_cents=$10,billable_amount_brl_cents=$11,pricing_strategy=$12,pricing_snapshot=$13,usd_brl_rate_micros=$14,normalized_credits=$15,reconciled=true,reconciled_at=now()
             FROM before b WHERE l.id=b.id AND l.reconciled=false
             RETURNING l.id, l.usage_period_id, l.consumption_type
         )
         SELECT upd.id, upd.usage_period_id, upd.consumption_type, before.reserved, before.usage_unit, before.reserved_credits_est, before.source_id, before.generation
           FROM upd JOIN before ON before.id=upd.id`,
        [tenantId, key, turn.model, turn.inputTokens, turn.outputTokens, turn.cachedTokens, turn.priced.inputPricePerMillionMicros, turn.priced.outputPricePerMillionMicros, turn.priced.providerCostUsdMicros, turn.priced.providerCostBrlCents, turn.priced.billableAmountBrlCents, turn.priced.pricingStrategy, JSON.stringify(turn.priced.pricingSnapshot), turn.priced.usdBrlRateMicros, turn.priced.normalizedCredits],
      );
      // `l.reconciled=false` no UPDATE (não só na CTE): se o TTL liberou a linha
      // enquanto esperávamos o lock, o Postgres reavalia a condição na versão
      // nova e o UPDATE não pisa numa reserva já devolvida aos contadores.
      let updated = await applyReconciliation();
      if (!updated.rows[0] && subscription.rows[0]) {
        // Uso TARDIO: a reserva expirou (TTL) ou foi liberada enquanto o
        // provedor ainda respondia. O provedor cobrou — reabrir a MESMA linha
        // como reserva nova no período aberto e reconciliar na mesma transação.
        // Linha já cobrada (reconciled sem marcador de liberação) não reabre:
        // idempotência preservada.
        const released = await client.query<{ id: string }>(
          `SELECT id FROM ai_usage_ledger WHERE tenant_id=$1 AND interaction_key=$2 AND reconciled=true
              AND pricing_snapshot->>'reconciliation' = ANY($3::text[]) FOR UPDATE`, [tenantId, key, RELEASED_WITHOUT_CHARGE]);
        if (released.rows[0]) {
          const reserved = await reserveAiTurnInTx(client, tenantId, subscription.rows[0].id, purpose, logicalTurnId, { lateUsage: true });
          if (reserved.allowed && reserved.ledgerId) updated = await applyReconciliation();
          else if (!reserved.allowed) {
            // Sem franquia/bônus/crédito para cobrir: nunca saldo negativo nem
            // cobrança acima do teto — custo real fica no ledger para auditoria.
            await client.query(
              `UPDATE ai_usage_ledger SET model=$2,input_tokens=$3,output_tokens=$4,cached_tokens=$5,provider_cost_usd_micros=$6,provider_cost_brl_cents=$7,normalized_credits=$8,
                  pricing_snapshot=pricing_snapshot || jsonb_build_object('reconciliation','late_usage_uncharged','lateUsageReason',$9::text)
                WHERE id=$1 AND reconciled=true`,
              [released.rows[0].id, turn.model, turn.inputTokens, turn.outputTokens, turn.cachedTokens, turn.priced.providerCostUsdMicros, turn.priced.providerCostBrlCents, turn.priced.normalizedCredits, reserved.reason ?? "unknown"]);
            console.error(`[billing] late AI usage not chargeable tenant=${tenantId} ledger=${released.rows[0].id} reason=${reserved.reason ?? "unknown"} (custo real preservado no ledger para auditoria)`);
          }
        }
      }
      if (!updated.rows[0]) return;
      // FASE B: custo estimado por chamada persiste na MESMA transação que
      // reconcilia o ledger (crash entre transações perderia o custo por
      // chamada) e apenas quando a reserva foi reconciliada — segunda
      // reconciliação sai no return acima (idempotente); rollback desfaz tudo.
      // cost_usd raw do provedor nunca é alterado.
      for (const call of turn.calls ?? []) {
        await client.query("UPDATE usage_logs SET priced_cost_usd_micros=$2 WHERE id=$1", [call.usageLogId, call.providerCostUsdMicros]);
      }
      const row = updated.rows[0];
      const creditMode = row.usage_unit === "CREDIT";
      const estimatedCredits = Number(row.reserved_credits_est ?? 0);
      // Em modo crédito a reserva estimada ocupa os contadores até a reconciliação
      // substituí-la pelo consumo REAL (tokens normalizados por custo); em modo
      // interação o +1 da reserva já é o valor final.
      const creditDelta = turn.priced.normalizedCredits - estimatedCredits;
      let rolloverDelta = 0, bonusDelta = 0;
      let includedDelta = 0, overageDelta = 0, overageCentsDelta = 0, grantDelta = 0, spill = 0;
      let franchise: { included_usage: string; included_limit: string | null; overage_amount_brl_cents: string; reserved_cents: string } | undefined;
      if (creditMode && row.consumption_type === "INCLUDED") {
        // A franquia incluída nunca ultrapassa included_limit: a reserva pode
        // SUBESTIMAR o consumo real e o delta positivo inteiro inflaria o
        // contador. Delta positivo é limitado ao espaço restante (negativo, de
        // superestimativa, libera normalmente); o excedente segue o MESMO
        // padrão do spill de rollover/bônus: overage apenas se as configurações
        // de crédito permitirem e o teto fixo tiver lastro, senão fica no
        // ledger + log de erro — perda nunca silenciosa.
        if (creditDelta < 0) includedDelta = creditDelta;
        else {
          franchise = (await client.query<{ included_usage: string; included_limit: string | null; overage_amount_brl_cents: string; reserved_cents: string }>(
            "SELECT included_usage, included_limit, overage_amount_brl_cents, reserved_cents FROM usage_periods WHERE id=$1 FOR UPDATE", [row.usage_period_id])).rows[0];
          const includedRoom = franchise?.included_limit == null ? Infinity : Math.max(0, Number(franchise.included_limit) - Number(franchise.included_usage));
          includedDelta = Math.min(creditDelta, includedRoom);
          spill = creditDelta - includedDelta;
        }
      }
      if (row.consumption_type === "OVERAGE") {
        // Teto duro (§17): a reconciliação nunca pode cobrar acima do cap — uma
        // reserva de 1 centavo sob teto 1 reconciliando 100 centavos criaria
        // overage_amount e lastro no financial_ledger acima do teto. Com a
        // linha do período travada (FOR UPDATE), room = teto - já cobrado -
        // reservas de TERCEIROS (a própria reserva sai de reserved_cents no
        // UPDATE abaixo); nunca negativo. Settings desligados ou UNLIMITED sem
        // confirmação: nada cobrável; UNLIMITED confirmado: valor integral.
        franchise = franchise
          ?? (await client.query<{ included_usage: string; included_limit: string | null; overage_amount_brl_cents: string; reserved_cents: string }>(
              "SELECT included_usage, included_limit, overage_amount_brl_cents, reserved_cents FROM usage_periods WHERE id=$1 FOR UPDATE", [row.usage_period_id])).rows[0];
        const settings = (await client.query<{ enabled: boolean; limit_type: string; monthly_spending_limit_cents: string | null; confirmed_unlimited_at: Date | null }>(
          "SELECT enabled, limit_type, monthly_spending_limit_cents, confirmed_unlimited_at FROM tenant_usage_credit_settings WHERE tenant_id=$1", [tenantId])).rows[0];
        let room = Infinity;
        if (!settings?.enabled) room = 0;
        else if (settings.limit_type === "FIXED") {
          const otherReservations = Math.max(0, Number(franchise?.reserved_cents ?? 0) - Number(row.reserved));
          room = Math.max(0, Number(settings.monthly_spending_limit_cents ?? 0) - Number(franchise?.overage_amount_brl_cents ?? 0) - otherReservations);
        } else if (settings.limit_type !== "UNLIMITED" || !settings.confirmed_unlimited_at) room = 0;
        const actualCents = turn.priced.billableAmountBrlCents;
        overageCentsDelta = Math.min(actualCents, room);
        // Créditos associados à parcela realmente cobrada (floor, mesmo padrão
        // do spill); o custo/normalizedCredits REAIS ficam no ai_usage_ledger.
        const chargedCredits = actualCents > 0 ? Math.floor((overageCentsDelta * turn.priced.normalizedCredits) / actualCents) : 0;
        overageDelta = creditMode ? chargedCredits - estimatedCredits : (overageCentsDelta > 0 ? 0 : -1);
        const uncharged = actualCents - overageCentsDelta;
        if (uncharged > 0) console.error(`[billing] AI usage beyond spending cap tenant=${tenantId} ledger=${row.id} uncharged_cents=${uncharged} (custo real preservado no ledger para auditoria)`);
      }
      if (creditMode && (row.consumption_type === "ROLLOVER" || row.consumption_type === "BONUS") && creditDelta !== 0) {
        grantDelta = creditDelta;
        if (creditDelta > 0) {
          // Excedente sobre a reserva: cobrar limitado ao SALDO da fonte (nunca
          // saldo negativo/bônus ou rollover fantasma); o remanescente vai à
          // franquia incluída e depois a overage sujeito ao teto. O que não
          // couber em nenhum fica no ledger + log de erro — perda nunca
          // silenciosa; o ledger preserva o custo real para auditoria.
          const source = row.source_id
            ? (await client.query<{ available: string }>(
                row.consumption_type === "ROLLOVER"
                  ? "SELECT (generated_amount-consumed_amount-expired_amount)::text AS available FROM rollover_ledger WHERE id=$1 AND tenant_id=$2 FOR UPDATE"
                  : "SELECT (amount-consumed_amount)::text AS available FROM usage_grants WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
                [row.source_id, tenantId])).rows[0]
            : undefined;
          grantDelta = Math.min(creditDelta, Math.max(0, Number(source?.available ?? 0)));
          spill = creditDelta - grantDelta;
          if (spill > 0) {
            franchise = franchise
              ?? (await client.query<{ included_usage: string; included_limit: string | null; overage_amount_brl_cents: string; reserved_cents: string }>(
                  "SELECT included_usage, included_limit, overage_amount_brl_cents, reserved_cents FROM usage_periods WHERE id=$1 FOR UPDATE", [row.usage_period_id])).rows[0];
            const includedRoom = franchise?.included_limit == null ? Infinity : Math.max(0, Number(franchise.included_limit) - Number(franchise.included_usage));
            includedDelta = Math.min(spill, includedRoom);
            spill -= includedDelta;
          }
        }
        // O contador do período acompanha a FONTE: a reserva creditou o
        // ESTIMATE em rollover/bonus_usage E em consumed_amount da fonte; a
        // correção por grantDelta vale para os dois — corrigir só a fonte
        // deixava painel/alerts no estimate (uso real ≠ reservado).
        if (row.consumption_type === "ROLLOVER") rolloverDelta = grantDelta;
        else bonusDelta = grantDelta;
      }
      if (spill > 0) {
        // Aritmética inteira (numerador×valor/denominador) para ceil/floor
        // determinísticos — nunca 4.999999→5 por erro de ponto flutuante.
        const spillCents = Math.ceil((spill * turn.priced.billableAmountBrlCents) / turn.priced.normalizedCredits);
        const settings = (await client.query<{ enabled: boolean; limit_type: string; monthly_spending_limit_cents: string | null; confirmed_unlimited_at: Date | null }>(
          "SELECT enabled, limit_type, monthly_spending_limit_cents, confirmed_unlimited_at FROM tenant_usage_credit_settings WHERE tenant_id=$1", [tenantId])).rows[0];
        let chargeable = spill;
        if (!settings?.enabled) chargeable = 0;
        else if (settings.limit_type === "FIXED") {
          const roomCents = Number(settings.monthly_spending_limit_cents ?? 0) - Number(franchise?.overage_amount_brl_cents ?? 0) - Number(franchise?.reserved_cents ?? 0);
          if (spillCents > roomCents) chargeable = roomCents > 0 ? Math.floor((roomCents * turn.priced.normalizedCredits) / turn.priced.billableAmountBrlCents) : 0;
        } else if (settings.limit_type !== "UNLIMITED" || !settings.confirmed_unlimited_at) chargeable = 0;
        chargeable = Math.min(chargeable, spill);
        overageDelta = chargeable;
        overageCentsDelta = Math.ceil((chargeable * turn.priced.billableAmountBrlCents) / turn.priced.normalizedCredits);
        const uncharged = spill - chargeable;
        if (uncharged > 0) console.error(`[billing] AI usage beyond grant, franchise and spending cap tenant=${tenantId} ledger=${row.id} uncharged_credits=${uncharged} (custo real preservado no ledger para auditoria)`);
      }
      await client.query(
        `UPDATE usage_periods SET provider_cost_usd_micros=provider_cost_usd_micros+$2,
          included_usage=included_usage+$3, rollover_usage=rollover_usage+$4, bonus_usage=bonus_usage+$5,
          overage_usage=overage_usage+$6, overage_amount_brl_cents=overage_amount_brl_cents+$7,
          reserved_credits=GREATEST(0,reserved_credits-$8), reserved_cents=GREATEST(0,reserved_cents-$9), updated_at=now() WHERE id=$1`,
        [row.usage_period_id, turn.priced.providerCostUsdMicros, includedDelta, rolloverDelta, bonusDelta, overageDelta, overageCentsDelta, creditMode ? estimatedCredits : 0, Number(row.reserved)],
      );
      if (creditMode && row.source_id && grantDelta !== 0) {
        if (row.consumption_type === "ROLLOVER") await client.query("UPDATE rollover_ledger SET consumed_amount=GREATEST(0,consumed_amount+$2) WHERE id=$1", [row.source_id, grantDelta]);
        if (row.consumption_type === "BONUS") await client.query("UPDATE usage_grants SET consumed_amount=GREATEST(0,consumed_amount+$2) WHERE id=$1", [row.source_id, grantDelta]);
      }
      // True-up do lançamento append-only: a reserva creditou o ESTIMATE, mas o
      // valor CHARGEABLE (custo real clamped ao teto, acima) pode divergir —
      // sem este ajuste o saldo ficaria preso no estimate para sempre (corrigir
      // exige um lançamento, nunca UPDATE). Subestimado → CREDIT da diferença;
      // superestimado → DEBIT. Estimate 0 (sem CREDIT na reserva) credita o
      // chargeable inteiro. Delta 0 não lança.
      // Idempotente pela chave única (source_event_id, correlation_id): nem uma
      // segunda reconciliação sequencial chega aqui (linha já reconciliada), e
      // uma corrida concorrente cai no índice único sem duplicar o DEBIT.
      if (row.consumption_type === "OVERAGE") {
        const deltaCents = overageCentsDelta - Number(row.reserved);
        if (deltaCents !== 0) {
          await appendFinancialLedgerEntry(client, tenantId, {
            direction: deltaCents > 0 ? "CREDIT" : "DEBIT",
            amountCents: Math.abs(deltaCents),
            actorType: "AI_RESERVATION",
            reason: "AI usage reservation reconciliation",
            sourceEventId: row.generation ? `ai-reservation-reconcile:${row.id}:g${row.generation}` : `ai-reservation-reconcile:${row.id}`,
            correlationId: row.usage_period_id,
            metadata: { reservationId: row.id, estimatedCents: Number(row.reserved), actualCents: turn.priced.billableAmountBrlCents, chargedCents: overageCentsDelta, unchargedCents: turn.priced.billableAmountBrlCents - overageCentsDelta },
          });
        }
      }
      // Spill de rollover/bônus cobrado como overage precisa de lastro no
      // financial_ledger: overage_amount_brl_cents é respaldado por lançamentos.
      if (overageCentsDelta > 0 && row.consumption_type !== "OVERAGE") {
        await appendFinancialLedgerEntry(client, tenantId, {
          direction: "CREDIT",
          amountCents: overageCentsDelta,
          actorType: "AI_RESERVATION",
          reason: "AI usage overage beyond grant/franchise",
          sourceEventId: row.generation ? `ai-reservation-reconcile:${row.id}:g${row.generation}` : `ai-reservation-reconcile:${row.id}`,
          correlationId: row.usage_period_id,
          metadata: { reservationId: row.id, spillCredits: overageDelta, spillCents: overageCentsDelta },
        });
      }
      await client.query("SAVEPOINT billing_alerts");
      try { await evaluateAlerts(client, tenantId); await client.query("RELEASE SAVEPOINT billing_alerts"); }
      catch (error) { await client.query("ROLLBACK TO SAVEPOINT billing_alerts"); console.error(`[billing] alert evaluation failed for tenant ${tenantId}`, error); }
    });
  } catch (error) { console.error(`[billing] failed to reconcile AI interaction for tenant ${tenantId}`, error); }
}

export async function reconcileAiTurnFromUsageLogs(
  tenantId: string,
  purpose: AiPurpose,
  logicalTurnId: string,
): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(logicalTurnId)) return;
  try {
    // Um turno pode conter várias chamadas com modelos DIFERENTES. FASE B: cada
    // usage_log é trazido por id e precificado INDIVIDUALMENTE com o próprio
    // modelo/tokens — provenance: usage_logs.cost_reported (0192) decide
    // hasCost; TRUE (default, linhas históricas inclusive) = cost_usd real do
    // provedor vence a tabela (0 = zero real, nunca cobrança inventada);
    // FALSE = API omitiu o custo → precificação pela tabela. Ausente só
    // existe na costura in-memory (reconcileAiInteraction).
    // reasoning já vem dentro do output_tokens (não se soma separado);
    // cache-write é insumo próprio e é precificado à parte.
    const result = await db.query<{
      id: string; model: string | null; provider: string | null; input_tokens: string; output_tokens: string;
      cached_input_tokens: string; cache_write_input_tokens: string; cost_usd: string;
      cost_reported: boolean;
    }>(
      `SELECT id, ai_model AS model, provider, COALESCE(input_tokens,0)::text AS input_tokens, COALESCE(output_tokens,0)::text AS output_tokens,
         COALESCE(cached_input_tokens,0)::text AS cached_input_tokens,
         COALESCE(cache_write_input_tokens,0)::text AS cache_write_input_tokens,
         COALESCE(cost_usd,0)::text AS cost_usd, cost_reported
       FROM usage_logs WHERE tenant_id=$1 AND request_id=$2::uuid
       ORDER BY COALESCE(cost_usd,0) DESC, ai_model ASC NULLS LAST, id ASC`, [tenantId, logicalTurnId]);
    const groups: AiTurnUsageGroup[] = result.rows
      .map((g) => ({ usageLogId: g.id, model: g.model, provider: g.provider, hasCost: g.cost_reported, inputTokens: Number(g.input_tokens), outputTokens: Number(g.output_tokens), cachedTokens: Number(g.cached_input_tokens), cacheWriteTokens: Number(g.cache_write_input_tokens), providerCostUsd: Number(g.cost_usd) }))
      .filter((g) => g.inputTokens > 0 || g.outputTokens > 0 || g.cachedTokens > 0 || g.cacheWriteTokens > 0 || (g.providerCostUsd ?? 0) > 0);
    if (!groups.length) return;
    await reconcileAiTurnPriced(tenantId, purpose, logicalTurnId, await priceAiTurn(groups));
  } catch (error) { console.error(`[billing] failed to reconcile AI turn from usage logs for tenant ${tenantId}`, error); }
}
