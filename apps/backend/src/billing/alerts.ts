import type { PoolClient } from "pg";
import { getEmailProvider } from "../mail/index.js";
import { logger } from "../logger.js";
import { getBillingSettings } from "./settings.js";
import { getOpenPeriod } from "./usage-period.js";

export type TriggeredAlert = {
  alertType: "QUOTA" | "CREDIT";
  thresholdBps: number;
  usedPercentBps: number;
  message: string;
};

type Period = {
  id: string; included_limit: string | null; included_usage: string;
  rollover_granted: string; rollover_usage: string; bonus_granted: string; bonus_usage: string;
  overage_amount_brl_cents: string; reserved_cents: string; start_at: Date; end_at: Date;
};

const integer = (v: unknown) => Number(v ?? 0);
const bps = (used: number, limit: number) => limit > 0 ? Math.floor((used * 10000) / limit) : 0;
const ptInteger = (v: number) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(v);
const ptMoney = (cents: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);

async function insertAlert(client: PoolClient, tenantId: string, periodId: string, alertType: "QUOTA" | "CREDIT", thresholdBps: number, usedPercentBps: number, message: string): Promise<TriggeredAlert | null> {
  const result = await client.query(
    `INSERT INTO usage_alerts (tenant_id, usage_period_id, alert_type, threshold_bps)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
    [tenantId, periodId, alertType, thresholdBps]
  );
  return result.rowCount === 1 ? { alertType, thresholdBps, usedPercentBps, message } : null;
}

function deliverAlertEmails(tenantName: string, recipients: string[], alerts: TriggeredAlert[]) {
  const emailProvider = getEmailProvider();
  if (!emailProvider.isConfigured || recipients.length === 0 || alerts.length === 0) return;
  for (const alert of alerts) {
    for (const to of recipients) {
      setImmediate(() => {
        void emailProvider.send({
          to,
          subject: `Aviso de uso de IA - ${tenantName}`,
          text: `${alert.message}\n\nConfira o painel de uso: /uso`,
          html: `<p>${alert.message}</p><p>Confira o painel de uso: <a href="/uso">/uso</a></p>`
        }).catch((error: unknown) => logger.warn({ error, tenantId: tenantName, to }, "billing alert email failed"));
      });
    }
  }
}

export async function evaluateAlerts(client: PoolClient, tenantId: string): Promise<TriggeredAlert[]> {
  const period = await getOpenPeriod(client, tenantId) as Period | null;
  if (!period) return [];
  const settings = await getBillingSettings(client);
  const alerts: TriggeredAlert[] = [];
  const quotaLimit = period.included_limit == null ? null : integer(period.included_limit) + integer(period.rollover_granted) + integer(period.bonus_granted);
  if (quotaLimit != null && quotaLimit > 0) {
    const used = integer(period.included_usage) + integer(period.rollover_usage) + integer(period.bonus_usage);
    const usedPercentBps = bps(used, quotaLimit);
    for (const thresholdBps of settings.quota_alert_thresholds_bps) {
      if (usedPercentBps >= thresholdBps) {
        const item = await insertAlert(client, tenantId, period.id, "QUOTA", thresholdBps, usedPercentBps,
          `Voce utilizou ${ptInteger(used)} das ${ptInteger(quotaLimit)} interacoes de IA incluidas neste mes.`);
        if (item) alerts.push(item);
      }
    }
  }
  const credit = (await client.query(`SELECT enabled, limit_type, monthly_spending_limit_cents FROM tenant_usage_credit_settings WHERE tenant_id=$1`, [tenantId])).rows[0];
  if (credit?.enabled && credit.limit_type === "FIXED" && integer(credit.monthly_spending_limit_cents) > 0) {
    const used = integer(period.overage_amount_brl_cents) + integer(period.reserved_cents);
    const limit = integer(credit.monthly_spending_limit_cents);
    const usedPercentBps = bps(used, limit);
    for (const thresholdBps of settings.credit_alert_thresholds_bps) {
      if (usedPercentBps >= thresholdBps) {
        const item = await insertAlert(client, tenantId, period.id, "CREDIT", thresholdBps, usedPercentBps,
          `Voce utilizou ${ptMoney(used)} dos ${ptMoney(limit)} definidos para Credito de Uso neste mes.`);
        if (item) alerts.push(item);
      }
    }
  }
  // UNLIMITED nao tem denominador/teto; portanto nao existe alerta de threshold numerico.
  if (alerts.length > 0) {
    const recipients = await client.query<{ email: string }>(
      `SELECT DISTINCT u.email
       FROM tenants t
       JOIN workspace_members m ON m.workspace_id=t.id AND m.status='active'
       JOIN workspace_roles r ON r.id=m.role_id AND r.name IN ('OWNER','ADMIN')
       JOIN users u ON u.id=m.user_id
       WHERE t.id=$1 AND u.email IS NOT NULL`, [tenantId]
    );
    const tenant = await client.query<{ name: string }>("SELECT name FROM tenants WHERE id=$1", [tenantId]);
    if (tenant.rows[0]) deliverAlertEmails(tenant.rows[0].name, recipients.rows.map(row => row.email), alerts);
  }
  return alerts;
}

export async function getUsageDashboard(client: PoolClient, tenantId: string) {
  const result = await client.query(`
    SELECT p.name AS plan_name, u.included_limit, u.included_usage, u.rollover_granted,
      u.rollover_usage, u.bonus_granted, u.bonus_usage, u.overage_amount_brl_cents,
      u.reserved_cents, u.start_at, u.end_at
    FROM usage_periods u LEFT JOIN tenant_subscriptions ts ON ts.tenant_id=u.tenant_id
      LEFT JOIN plans p ON p.id=ts.plan_id
    WHERE u.tenant_id=$1 AND u.status='OPEN' LIMIT 1`, [tenantId]);
  const row = result.rows[0];
  if (!row) return null;
  const includedLimit = row.included_limit == null ? null : integer(row.included_limit);
  const includedUsage = integer(row.included_usage), rolloverGranted = integer(row.rollover_granted), rolloverUsage = integer(row.rollover_usage);
  const bonusGranted = integer(row.bonus_granted), bonusUsage = integer(row.bonus_usage);
  const totalAvailable = includedLimit == null ? null : includedLimit + rolloverGranted + bonusGranted;
  const totalUsed = includedUsage + rolloverUsage + bonusUsage;
  const credit = (await client.query(`SELECT enabled, monthly_spending_limit_cents FROM tenant_usage_credit_settings WHERE tenant_id=$1`, [tenantId])).rows[0];
  const periodEnd = new Date(row.end_at);
  const daysUntilRenewal = Math.max(0, Math.ceil((periodEnd.getTime() - Date.now()) / 86400000));
  return { planName: row.plan_name, includedLimit, includedUsage, rolloverGranted, rolloverUsage, bonusGranted, bonusUsage,
    totalAvailable, totalUsed, usedPercentBps: totalAvailable == null ? 0 : bps(totalUsed, totalAvailable),
    periodStart: row.start_at, periodEnd, daysUntilRenewal, creditEnabled: Boolean(credit?.enabled),
    creditLimitCents: credit ? integer(credit.monthly_spending_limit_cents) : null,
    creditUsedCents: integer(row.overage_amount_brl_cents) + integer(row.reserved_cents),
    balanceLabel: "Creditos de IA", usageLabel: "Interacoes acumuladas" };
}
