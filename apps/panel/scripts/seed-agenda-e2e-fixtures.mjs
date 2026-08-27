#!/usr/bin/env node
/**
 * Popula a agenda do tenant de teste com uma unidade real e agendamentos que
 * representam o pior caso de layout: nomes longos, e-mails longos, horários
 * compartilhados por vários agendamentos e status variados.
 *
 * Sem esses dados a agenda renderiza apenas "Cadastre uma unidade para montar
 * a agenda." e qualquer auditoria responsiva mede uma tela vazia.
 */
import { config as loadEnv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const envFile = {};
loadEnv({ path: resolve(here, "../../../.env.test"), processEnv: envFile, quiet: true });
const connectionString = process.env.TEST_DATABASE_URL ?? envFile.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL é obrigatória");
const database = new URL(connectionString);
if (!/test/i.test(decodeURIComponent(database.pathname))) {
  throw new Error("Recuso popular fixtures fora de um banco de testes");
}

const UNIT_ID = "unidade-agenda-e2e";
const pool = new pg.Pool({ connectionString });

/** Nomes propositalmente longos: é onde corte e sobreposição aparecem. */
const contacts = [
  ["Maria Aparecida Gonçalves de Albuquerque Santos", "5511987650001"],
  ["João", "5511987650002"],
  ["Ana Beatriz Rodrigues do Nascimento Vasconcelos", "5511987650003"],
  ["Cliente Sem Nome Cadastrado No Sistema Ainda", "5511987650004"],
  ["Pedro Henrique", "5511987650005"],
  ["Luiza Fernanda Carvalho Monteiro da Silva Prado", "5511987650006"]
];

const statuses = ["confirmado", "reagendado", "concluido", "cancelado", "no_show"];

function atLocalHour(dayOffset, hour, minute = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + dayOffset);
  // A unidade abre 08:00 e fecha 18:00 no fuso do tenant (America/Sao_Paulo,
  // UTC-3), então gravamos em UTC somando 3 horas.
  date.setUTCHours(hour + 3, minute, 0, 0);
  return date;
}

async function main() {
  const client = await pool.connect();
  try {
    const tenant = await client.query(
      `SELECT m.workspace_id AS tenant_id, u.id AS user_id
         FROM users u
         JOIN workspace_members m ON m.user_id = u.id
        WHERE u.email = $1
        LIMIT 1`,
      [(process.env.PANEL_SEED_EMAIL ?? "admin@atendon.local").toLowerCase()]
    );
    if (!tenant.rowCount) throw new Error("Usuário de seed não encontrado: rode o seed do backend antes");
    const { tenant_id: tenantId, user_id: userId } = tenant.rows[0];

    const member = await client.query(
      "SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 LIMIT 1",
      [tenantId, userId]
    );
    const memberId = member.rows[0]?.id ?? null;

    await client.query("BEGIN");

    await client.query(
      `INSERT INTO scheduling_units (tenant_id, id, name, opening_time, closing_time, operating_days, slot_duration_min, simultaneous_capacity)
       VALUES ($1,$2,'Unidade Centro — Atendimento Comercial Presencial','08:00','18:00', ARRAY[1,2,3,4,5]::smallint[], 60, 3)
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         name = EXCLUDED.name,
         opening_time = EXCLUDED.opening_time,
         closing_time = EXCLUDED.closing_time,
         operating_days = EXCLUDED.operating_days,
         slot_duration_min = EXCLUDED.slot_duration_min,
         simultaneous_capacity = EXCLUDED.simultaneous_capacity`,
      [tenantId, UNIT_ID]
    );

    // Limpa somente o que este fixture criou, para ser idempotente.
    await client.query(
      "DELETE FROM scheduling_appointments WHERE tenant_id=$1 AND unit_id=$2",
      [tenantId, UNIT_ID]
    );
    await client.query(
      "DELETE FROM scheduling_leads WHERE tenant_id=$1 AND unit_id=$2",
      [tenantId, UNIT_ID]
    );

    const stage = await client.query(
      "SELECT id FROM pipeline_stages WHERE tenant_id=$1 ORDER BY position LIMIT 1",
      [tenantId]
    );
    const stageId = stage.rows[0]?.id;
    if (!stageId) throw new Error("Nenhum estágio de pipeline no tenant de teste");

    let created = 0;
    for (let index = 0; index < contacts.length; index += 1) {
      const [name, phone] = contacts[index];
      const lead = await client.query(
        `INSERT INTO scheduling_leads (tenant_id, phone, name, unit_id, source, pipeline_stage_id, assigned_member_id)
         VALUES ($1,$2,$3,$4,'e2e-fixture',$5,$6)
         RETURNING id`,
        [tenantId, phone, name, UNIT_ID, stageId, memberId]
      );
      const leadId = lead.rows[0].id;

      // Dois agendamentos por lead: um hoje e um espalhado pela semana. Vários
      // caem no mesmo horário de propósito para exercitar o slot compartilhado.
      const plan = [
        { dayOffset: 0, hour: 9 + (index % 3) },
        { dayOffset: (index % 5) + 1, hour: 14 }
      ];
      for (let slot = 0; slot < plan.length; slot += 1) {
        const { dayOffset, hour } = plan[slot];
        const start = atLocalHour(dayOffset, hour);
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        const status = slot === 0 ? statuses[index % statuses.length] : "confirmado";
        // Só um agendamento ativo por lead é permitido pelo índice único.
        const activeAlready = slot > 0 && ["confirmado", "reagendado"].includes(statuses[index % statuses.length]);
        const finalStatus = activeAlready ? "concluido" : status;
        // O schema exige desfecho comercial coerente para 'concluido'.
        const outcome = finalStatus === "concluido" ? "fechado" : null;
        const saleValue = outcome === "fechado" ? 1250.5 : null;
        await client.query(
          `INSERT INTO scheduling_appointments (lead_id, tenant_id, unit_id, start_at, end_at, status, assigned_member_id, assigned_at, created_by_user_id, commercial_outcome, sale_value, finalized_by_user_id, finalized_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, now(), $8, $9, $10,
                   CASE WHEN $9::text IS NULL THEN NULL ELSE $8::uuid END,
                   CASE WHEN $9::text IS NULL THEN NULL ELSE now() END)`,
          [leadId, tenantId, UNIT_ID, start.toISOString(), end.toISOString(), finalStatus, memberId, userId, outcome, saleValue]
        );
        created += 1;
      }
    }

    await client.query("COMMIT");
    console.log(JSON.stringify({ tenantId, unitId: UNIT_ID, leads: contacts.length, appointments: created }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
