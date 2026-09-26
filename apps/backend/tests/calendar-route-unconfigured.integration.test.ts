import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import { encryptSecret } from "../src/modules/ai-router/secret-box.js";
import {
  CalendarSyncProcessor,
  CalendarSyncRepository,
  type CalendarSyncJob
} from "../src/modules/scheduling/calendar-sync.js";
import {
  atendonCalendarEventId,
  type GoogleCalendarClient,
  type GoogleCalendarEvent,
  type GoogleCalendarEventFields
} from "../src/modules/scheduling/google-calendar.js";

// Regressão do roteamento silencioso para calendário de terceiro: rota explícita
// de pipeline aponta para uma conexão cujo calendar_id virou NULL (reconexão
// limpa a seleção). O LATERAL do WORK_SELECT não encontra route_target e o
// resolveTarget NÃO pode cair para a conexão do assignee (M2) — o evento iria
// para o calendário de outra pessoa. Falha observável (last_error/sync_error,
// retry com backoff — sem loop quente) e converge quando a agenda é reselecionada.
const TEST_KEY = "calendar-route-test-data-key";
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const repo = new CalendarSyncRepository(pool);
const processor = new CalendarSyncProcessor(repo, () => fakeClient, { DATA_ENCRYPTION_KEY: TEST_KEY });

const CAL_M1 = "cal-m1-route";
const CAL_M2 = "cal-m2-assignee";
const START = "2030-03-10T09:00:00-03:00";

let tenantId = "";
let memberM1 = "";
let memberM2 = "";
let connM1 = "";
let connM2 = "";
let pipelineId = "";
const cleanupUserIds: string[] = [];

type Call = { token: string; calendarId: string; eventId: string };
const calls = {
  upserts: [] as Array<Call & { fields: GoogleCalendarEventFields; etag?: string }>,
  deletes: [] as Call[]
};

function resetFake(): void {
  calls.upserts.length = 0;
  calls.deletes.length = 0;
}

const fakeClient = {
  async upsertEvent(
    token: string,
    calendarId: string,
    eventId: string,
    fields: GoogleCalendarEventFields,
    etag?: string
  ): Promise<GoogleCalendarEvent> {
    calls.upserts.push({ token, calendarId, eventId, fields, etag });
    return { id: eventId, etag: `etag-${calls.upserts.length}`, start: fields.start, end: fields.end };
  },
  async deleteEvent(token: string, calendarId: string, eventId: string): Promise<void> {
    calls.deletes.push({ token, calendarId, eventId });
  },
  async getEvent(): Promise<GoogleCalendarEvent> {
    throw new Error("stub: reconciliação não é escopo deste teste");
  }
} as unknown as GoogleCalendarClient;

// Rota explícita pipeline→conexão, gravada direto (o worker lê a tabela, não a API).
async function routePipelineTo(connectionId: string): Promise<void> {
  await pool.query(
    `INSERT INTO scheduling_pipeline_calendar_routes(tenant_id,pipeline_id,team_id,connection_id)
     VALUES($1,$2,NULL,$3)
     ON CONFLICT (tenant_id,pipeline_id) DO UPDATE SET connection_id=$3,updated_at=now()`,
    [tenantId, pipelineId, connectionId]
  );
}

async function createAppointment(memberId: string): Promise<string> {
  // status 'agendado' → gatilho de estágio põe o lead no estágio padrão do
  // pipeline default (mesmo mecanismo dos testes irmãos).
  const lead = await pool.query<{ id: string }>(
    `INSERT INTO scheduling_leads(tenant_id,phone,name,source,status,unit_id,assigned_member_id)
     VALUES($1,$2,'Lead Route Unconfigured','whatsapp','agendado','reunioes-comerciais',$3)
     RETURNING id`,
    [tenantId, `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, memberId]
  );
  const appointment = await pool.query<{ id: string }>(
    `INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at,status,assigned_member_id,assigned_at)
     VALUES($1,$2,'reunioes-comerciais',$3::timestamptz,$3::timestamptz + interval '60 minutes','confirmado',$4,now())
     RETURNING id`,
    [tenantId, lead.rows[0].id, START, memberId]
  );
  return appointment.rows[0].id;
}

async function claimOne(appointmentId: string): Promise<CalendarSyncJob> {
  const jobs = await repo.claimDue(100);
  const job = jobs.find((candidate) => candidate.appointmentId === appointmentId);
  expect(job, `linha do outbox de ${appointmentId} não estava disponível`).toBeDefined();
  return job!;
}

async function syncAppointment(appointmentId: string): Promise<void> {
  expect(await processor.process(await claimOne(appointmentId))).toBe("synced");
}

async function outboxRow(appointmentId: string): Promise<{
  attempts: number; claimed_at: Date | null; last_error: string | null;
} | null> {
  return (await pool.query(
    `SELECT attempts,claimed_at,last_error
     FROM scheduling_calendar_sync_outbox WHERE appointment_id=$1 AND tenant_id=$2`,
    [appointmentId, tenantId]
  )).rows[0] ?? null;
}

async function linkRow(appointmentId: string): Promise<{
  connection_id: string | null; calendar_id: string; event_id: string; sync_error: string | null;
} | null> {
  return (await pool.query(
    `SELECT connection_id,calendar_id,event_id,sync_error
     FROM scheduling_appointment_calendar_events WHERE appointment_id=$1 AND tenant_id=$2`,
    [appointmentId, tenantId]
  )).rows[0] ?? null;
}

async function setConnectionCalendar(connectionId: string, calendarId: string | null): Promise<void> {
  await pool.query(
    "UPDATE scheduling_calendar_connections SET calendar_id=$2,updated_at=now() WHERE id=$1",
    [connectionId, calendarId]
  );
}

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','America/Sao_Paulo') RETURNING id",
    [`Calendar Route Unconfigured ${randomUUID()}`]
  )).rows[0].id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    await client.query(
      "INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'route-unconfigured-category','Route unconfigured')",
      [tenantId]
    );
    await client.query(
      `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity)
       VALUES($1,'reunioes-comerciais','Reuniões comerciais','09:00','19:30',ARRAY[1,2,3,4,5,6]::smallint[],60,1)`,
      [tenantId]
    );
    for (const label of ["croute-m1", "croute-m2"]) {
      const user = await client.query<{ id: string }>(
        "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
        [`${label}-${randomUUID()}@test.local`]
      );
      cleanupUserIds.push(user.rows[0].id);
      const member = await client.query<{ id: string }>(
        `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
         SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'
         RETURNING id`,
        [tenantId, user.rows[0].id]
      );
      if (label === "croute-m1") memberM1 = member.rows[0].id; else memberM2 = member.rows[0].id;
    }
    // M1: rota explícita aponta para cá — reconectado, SEM agenda selecionada.
    connM1 = (await client.query<{ id: string }>(
      `INSERT INTO scheduling_calendar_connections(tenant_id,member_id,google_email,refresh_token_encrypted)
       VALUES($1,$2,'m1@test.local',$3) RETURNING id`,
      [tenantId, memberM1, encryptSecret("rt-connM1", TEST_KEY)]
    )).rows[0].id;
    // M2: assignee com agenda configurada (o destino errado do bug).
    connM2 = (await client.query<{ id: string }>(
      `INSERT INTO scheduling_calendar_connections(tenant_id,member_id,google_email,refresh_token_encrypted,calendar_id,calendar_timezone)
       VALUES($1,$2,'m2@test.local',$3,$4,'America/Sao_Paulo') RETURNING id`,
      [tenantId, memberM2, encryptSecret("rt-connM2", TEST_KEY), CAL_M2]
    )).rows[0].id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  pipelineId = (await pool.query<{ id: string }>(
    "SELECT id FROM pipelines WHERE tenant_id=$1 AND is_default AND archived_at IS NULL LIMIT 1",
    [tenantId]
  )).rows[0].id;
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [cleanupUserIds]);
  await pool.end();
});

beforeEach(() => {
  resetFake();
});

describe("rota explícita para conexão sem agenda selecionada", () => {
  it("NÃO publica no calendário do assignee: falha observável na outbox, retry com backoff", async () => {
    await routePipelineTo(connM1);
    const appointmentId = await createAppointment(memberM2);

    expect(await processor.process(await claimOne(appointmentId))).toBe("pending");
    expect(calls.upserts).toEqual([]); // NADA no calendário de terceiro (CAL_M2)
    expect(calls.deletes).toEqual([]);
    expect(await linkRow(appointmentId)).toBeNull();
    const row = await outboxRow(appointmentId);
    expect(row?.last_error).toContain("agenda selecionada");
    expect(row?.claimed_at).toBeNull(); // solto para retry com backoff, não loop quente
  });

  it("com vínculo antigo na agenda da rota: sync_error no vínculo, sem publicar no assignee; reseleção converge", async () => {
    await routePipelineTo(connM1);
    // Rota funcionando: vínculo nasce na agenda da conexão da rota.
    await setConnectionCalendar(connM1, CAL_M1);
    const appointmentId = await createAppointment(memberM2);
    await syncAppointment(appointmentId);
    expect(await linkRow(appointmentId)).toMatchObject({ connection_id: connM1, calendar_id: CAL_M1 });
    const upsertsBefore = calls.upserts.length;

    // Reconexão limpa a agenda selecionada (mesma escrita de connectGoogleCalendar).
    await setConnectionCalendar(connM1, null);
    await pool.query(
      "UPDATE scheduling_appointments SET observation=$2,updated_at=now() WHERE id=$1",
      [appointmentId, "Mutação pós-reconexão"]
    );

    expect(await processor.process(await claimOne(appointmentId))).toBe("pending");
    expect(calls.upserts.length).toBe(upsertsBefore); // zero publicação nova (nem em CAL_M2)
    expect(await linkRow(appointmentId)).toMatchObject({
      connection_id: connM1,
      calendar_id: CAL_M1,
      sync_error: expect.stringContaining("agenda selecionada")
    });
    expect(await outboxRow(appointmentId)).not.toBeNull();

    // Guarda da rota existente pós-reconexão: agenda reselecionada → o retry
    // converge para o destino da ROTA (não para o assignee), sem duplicata.
    await setConnectionCalendar(connM1, CAL_M1);
    await pool.query(
      "UPDATE scheduling_calendar_sync_outbox SET available_at=now() WHERE appointment_id=$1 AND tenant_id=$2",
      [appointmentId, tenantId]
    );
    expect(await processor.process(await claimOne(appointmentId))).toBe("synced");
    expect(calls.upserts.at(-1)).toMatchObject({ token: "rt-connM1", calendarId: CAL_M1 });
    expect(await linkRow(appointmentId)).toMatchObject({ connection_id: connM1, calendar_id: CAL_M1, sync_error: null });
    expect(await outboxRow(appointmentId)).toBeNull();
  });

  it("controle: sem rota de conexão, o fallback para o assignee configurado continua válido", async () => {
    await pool.query(
      "DELETE FROM scheduling_pipeline_calendar_routes WHERE tenant_id=$1 AND pipeline_id=$2",
      [tenantId, pipelineId]
    );
    const appointmentId = await createAppointment(memberM2);

    expect(await processor.process(await claimOne(appointmentId))).toBe("synced");
    expect(calls.upserts).toEqual([
      expect.objectContaining({ token: "rt-connM2", calendarId: CAL_M2, eventId: atendonCalendarEventId(appointmentId) })
    ]);
    expect(await linkRow(appointmentId)).toMatchObject({ connection_id: connM2, calendar_id: CAL_M2 });
    expect(await outboxRow(appointmentId)).toBeNull();
  });
});
