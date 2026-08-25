import type { Pool } from "pg";

const ALERT_WINDOW = "1 hour";

async function insertAlertOnce(db: Pool, tenantId: string, message: string): Promise<void> {
  await db.query(
    `INSERT INTO system_alerts(tenant_id,message)
     SELECT $1,$2 WHERE NOT EXISTS (
       SELECT 1 FROM system_alerts
       WHERE tenant_id=$1 AND message=$2 AND created_at>=now()-$3::interval
     )`,
    [tenantId, message, ALERT_WINDOW]
  );
}

export async function recordPostEvaluationAlerts(
  db: Pool,
  input: { tenantId: string; versionId: string; evaluationId: string; hasCriticalFailure: boolean }
): Promise<void> {
  if (input.hasCriticalFailure) {
    const published = await db.query(
      `SELECT 1 FROM agent_configs a
       WHERE a.tenant_id=$1 AND a.active_version_id=$2`,
      [input.tenantId, input.versionId]
    );
    if (published.rows[0]) {
      await insertAlertOnce(
        db,
        input.tenantId,
        `Falha crítica detectada na versão ativa ${input.versionId}; avaliação ${input.evaluationId}`
      );
    }
  }

  const rates = await db.query<{
    version_id: string;
    evaluation_count: number;
    critical_rate: number;
  }>(
    `WITH active AS (
       SELECT a.id agent_config_id,a.active_version_id,v.version_number
       FROM agent_configs a JOIN agent_config_versions v ON v.id=a.active_version_id
       WHERE a.tenant_id=$1
     ), compared AS (
       SELECT v.id version_id
       FROM active a JOIN agent_config_versions v ON v.agent_config_id=a.agent_config_id
       WHERE v.id=a.active_version_id OR v.version_number=(
         SELECT max(previous.version_number) FROM agent_config_versions previous
         WHERE previous.agent_config_id=a.agent_config_id AND previous.version_number<a.version_number
       )
     )
     SELECT c.version_id,count(e.id)::int evaluation_count,
       COALESCE(avg(CASE WHEN e.has_critical_failure THEN 1.0 ELSE 0.0 END),0)::float critical_rate
     FROM compared c LEFT JOIN ai_attendance_evaluations e
       ON e.agent_config_version_id=c.version_id AND e.tenant_id=$1
     GROUP BY c.version_id`,
    [input.tenantId]
  );
  const active = rates.rows.find((row) => row.version_id === input.versionId);
  const previous = rates.rows.find((row) => row.version_id !== input.versionId);
  if (active && previous && active.evaluation_count >= 20
    && active.critical_rate >= previous.critical_rate * 1.5
    && active.critical_rate > previous.critical_rate) {
    await insertAlertOnce(
      db,
      input.tenantId,
      `Taxa de falha crítica da versão ${input.versionId} aumentou pelo menos 50% após ${active.evaluation_count} avaliações`
    );
  }
}

export async function deleteExpiredAutomaticEvaluations(db: Pool): Promise<number> {
  const result = await db.query(
    `DELETE FROM ai_attendance_evaluations
     WHERE trigger<>'manual' AND created_at<now()-interval '180 days'`
  );
  return result.rowCount ?? 0;
}

export async function alertEvaluationQueueDelay(db: Pool, jobs: Array<{ timestamp: number; tenantId?: string }>): Promise<void> {
  const delayedTenants = new Set(jobs
    .filter((job) => job.tenantId && job.timestamp <= Date.now() - 30 * 60_000)
    .map((job) => job.tenantId!));
  await Promise.all([...delayedTenants].map((tenantId) => insertAlertOnce(
    db,
    tenantId,
    `Fila de avaliação atrasada há mais de 30 minutos no workspace ${tenantId}`
  )));
}

export async function alertConsecutiveEvaluatorErrors(db: Pool, tenantId: string): Promise<void> {
  await insertAlertOnce(db, tenantId, `Avaliador acumulou cinco erros consecutivos no workspace ${tenantId}`);
}
