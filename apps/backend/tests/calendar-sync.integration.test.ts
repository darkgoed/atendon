import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import { encryptSecret } from "../src/modules/ai-router/secret-box.js";
import {
  CalendarSyncProcessor,
  CalendarSyncRepository,
  reconcileLinkedCalendarEvents,
  startCalendarSyncWorker,
  type CalendarSyncJob
} from "../src/modules/scheduling/calendar-sync.js";
import {
  atendonCalendarEventId,
  GoogleCalendarApiError,
  GoogleCalendarAuthRevokedError,
  type GoogleCalendarClient,
  type GoogleCalendarEvent,
  type GoogleCalendarEventFields
} from "../src/modules/scheduling/google-calendar.js";

// Integração real (Postgres de teste): gatilho 0189, outbox, vínculos e
// worker. O Google é substituído por um stub injetado na costura existente
// (createClient do CalendarSyncProcessor); nada de rede.
const TEST_KEY = "calendar-sync-test-data-key";
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const repo = new CalendarSyncRepository(pool);
const processor = new CalendarSyncProcessor(repo, () => fakeClient, { DATA_ENCRYPTION_KEY: TEST_KEY });

const CAL_A = "cal-a";
const CAL_B = "cal-b";
const START = "2030-03-10T09:00:00-03:00";

let tenantId = "";
let memberA = "";
let memberB = "";
let memberNoCalendar = "";
let connA = "";
let connB = "";
const cleanupUserIds: string[] = [];

type Call = { token: string; calendarId: string; eventId: string };
const calls = {
  upserts: [] as Array<Call & { fields: GoogleCalendarEventFields; etag?: string }>,
  deletes: [] as Call[],
  gets: [] as Call[]
};
let upsertError: unknown = null;
let deleteError: unknown = null;
let getEventError: unknown = null;
let remoteEvent: GoogleCalendarEvent | null = null;
let etagSeq = 0;

function resetFake(): void {
  calls.upserts.length = 0;
  calls.deletes.length = 0;
  calls.gets.length = 0;
  upsertError = null;
  deleteError = null;
  getEventError = null;
  remoteEvent = null;
  etagSeq = 0;
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
    if (upsertError) throw upsertError;
    etagSeq += 1;
    return { id: eventId, etag: `etag-${etagSeq}`, start: fields.start, end: fields.end };
  },
  async deleteEvent(token: string, calendarId: string, eventId: string): Promise<void> {
    calls.deletes.push({ token, calendarId, eventId });
    if (deleteError) throw deleteError;
  },
  async getEvent(token: string, calendarId: string, eventId: string): Promise<GoogleCalendarEvent> {
    calls.gets.push({ token, calendarId, eventId });
    if (getEventError) throw getEventError;
    if (!remoteEvent) throw new Error("stub: remoteEvent não configurado");
    return remoteEvent;
  }
} as unknown as GoogleCalendarClient;

async function createMember(client: pg.PoolClient, label: string): Promise<string> {
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
  return member.rows[0].id;
}

async function createPoolMember(label: string): Promise<string> {
  // Fora do beforeAll (sem transação compartilhada): conexões de pool comuns.
  const user = await pool.query<{ id: string }>(
    "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
    [`${label}-${randomUUID()}@test.local`]
  );
  cleanupUserIds.push(user.rows[0].id);
  return (await pool.query<{ id: string }>(
    `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
     SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'
     RETURNING id`,
    [tenantId, user.rows[0].id]
  )).rows[0].id;
}

// Um agendamento ativo por lead: cada agendamento com o lead dele.
async function createAppointment(memberId: string | null): Promise<string> {
  const lead = await pool.query<{ id: string }>(
    `INSERT INTO scheduling_leads(tenant_id,phone,name,source,status,interest_category_id,unit_id,assigned_member_id)
     VALUES($1,$2,'Lead Calendar Sync','whatsapp','agendado','calendar-sync-category','reunioes-comerciais',$3)
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
  // claimDue é global: drena também linhas residuais de testes anteriores e
  // escolhe a linha alvo (residuais reclamadas ficam sob lease até expirar).
  const jobs = await repo.claimDue(100);
  const job = jobs.find((candidate) => candidate.appointmentId === appointmentId);
  expect(job, `linha do outbox de ${appointmentId} não estava disponível`).toBeDefined();
  return job!;
}

// Sincroniza até o vínculo existir (estado "já publicado no Google").
async function syncAppointment(appointmentId: string): Promise<void> {
  const outcome = await processor.process(await claimOne(appointmentId));
  expect(outcome).toBe("synced");
}

async function outboxRow(appointmentId: string): Promise<{
  kind: string; attempts: number; claimed_at: Date | null; available_at: Date; last_error: string | null;
} | null> {
  return (await pool.query(
    `SELECT kind,attempts,claimed_at,available_at,last_error
     FROM scheduling_calendar_sync_outbox WHERE appointment_id=$1 AND tenant_id=$2`,
    [appointmentId, tenantId]
  )).rows[0] ?? null;
}

async function linkRow(appointmentId: string): Promise<{
  connection_id: string | null; calendar_id: string; event_id: string; etag: string | null;
  last_synced_at: Date | null; sync_error: string | null;
} | null> {
  return (await pool.query(
    `SELECT connection_id,calendar_id,event_id,etag,last_synced_at,sync_error
     FROM scheduling_appointment_calendar_events WHERE appointment_id=$1 AND tenant_id=$2`,
    [appointmentId, tenantId]
  )).rows[0] ?? null;
}

async function conflictAlertCount(appointmentId: string): Promise<number> {
  return (await pool.query<{ n: number }>(
    `SELECT count(*)::int n FROM system_alerts
     WHERE tenant_id=$1 AND metadata->>'event'='calendar_event_conflict'
       AND metadata->>'appointment_id'=$2`,
    [tenantId, appointmentId]
  )).rows[0].n;
}

async function appointmentRow(appointmentId: string): Promise<{ status: string } | null> {
  return (await pool.query<{ status: string }>(
    "SELECT status FROM scheduling_appointments WHERE id=$1",
    [appointmentId]
  )).rows[0] ?? null;
}

async function leadOfAppointment(appointmentId: string): Promise<{
  status: string; recovery_member_id: string | null;
} | null> {
  return (await pool.query<{ status: string; recovery_member_id: string | null }>(
    `SELECT l.status,l.recovery_member_id
     FROM scheduling_appointments a JOIN scheduling_leads l ON l.id=a.lead_id
     WHERE a.id=$1`,
    [appointmentId]
  )).rows[0] ?? null;
}

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','America/Sao_Paulo') RETURNING id",
    [`Calendar Sync ${randomUUID()}`]
  )).rows[0].id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    await client.query(
      "INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'calendar-sync-category','Calendar sync')",
      [tenantId]
    );
    await client.query(
      `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity)
       VALUES($1,'reunioes-comerciais','Reuniões comerciais','09:00','19:30',ARRAY[1,2,3,4,5,6]::smallint[],60,1)`,
      [tenantId]
    );
    memberA = await createMember(client, "csync-a");
    memberB = await createMember(client, "csync-b");
    memberNoCalendar = await createMember(client, "csync-nc");
    connA = (await client.query<{ id: string }>(
      `INSERT INTO scheduling_calendar_connections(tenant_id,member_id,google_email,refresh_token_encrypted,calendar_id,calendar_timezone)
       VALUES($1,$2,'a@test.local',$3,$4,'America/Sao_Paulo') RETURNING id`,
      [tenantId, memberA, encryptSecret("rt-connA", TEST_KEY), CAL_A]
    )).rows[0].id;
    connB = (await client.query<{ id: string }>(
      `INSERT INTO scheduling_calendar_connections(tenant_id,member_id,google_email,refresh_token_encrypted,calendar_id,calendar_timezone)
       VALUES($1,$2,'b@test.local',$3,$4,'America/Sao_Paulo') RETURNING id`,
      [tenantId, memberB, encryptSecret("rt-connB", TEST_KEY), CAL_B]
    )).rows[0].id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [cleanupUserIds]);
  await pool.end();
});

beforeEach(() => {
  resetFake();
});

describe("gatilho 0189 (enqueue)", () => {
  it("enfileira upsert na criação, mantém linha única no reagendamento e vira delete no cancelamento", async () => {
    const appointmentId = await createAppointment(memberA);
    expect(await outboxRow(appointmentId)).toMatchObject({ kind: "upsert", attempts: 0 });

    await pool.query("UPDATE scheduling_appointments SET start_at=start_at + interval '1 hour', end_at=end_at + interval '1 hour' WHERE id=$1", [appointmentId]);
    const rows = await pool.query(
      "SELECT count(*)::int n FROM scheduling_calendar_sync_outbox WHERE appointment_id=$1 AND tenant_id=$2",
      [appointmentId, tenantId]
    );
    expect(rows.rows[0].n).toBe(1); // idempotente por (appointment, tenant)

    await pool.query("UPDATE scheduling_appointments SET status='cancelado' WHERE id=$1", [appointmentId]);
    expect(await outboxRow(appointmentId)).toMatchObject({ kind: "delete" });
  });

  it("re-enfileirar durante claim em voo preserva o claim (kind/attempts atualizam)", async () => {
    const appointmentId = await createAppointment(memberA);
    await claimOne(appointmentId);
    expect((await outboxRow(appointmentId))?.claimed_at).not.toBeNull();
    await pool.query("UPDATE scheduling_appointments SET start_at=start_at + interval '2 hours', end_at=end_at + interval '2 hours' WHERE id=$1", [appointmentId]);
    const row = await outboxRow(appointmentId);
    expect(row?.claimed_at).not.toBeNull(); // mutação não limpa claim em voo
    expect(row?.kind).toBe("upsert");
    expect(row?.attempts).toBe(0);
  });

  it("atualização apenas de observação re-enfileira upsert (observação vai na descrição do evento)", async () => {
    const appointmentId = await createAppointment(memberA);
    await syncAppointment(appointmentId); // drena a outbox: só a edição de observação pode recriar a linha
    expect(await outboxRow(appointmentId)).toBeNull();

    await pool.query(
      "UPDATE scheduling_appointments SET observation=$2,updated_at=now() WHERE id=$1",
      [appointmentId, "Cliente pediu remarcação presencial"]
    );
    expect(await outboxRow(appointmentId)).toMatchObject({ kind: "upsert", attempts: 0 });
  });
});

describe("claimDue", () => {
  it("respeita available_at (backoff): linha com retry agendado não é reclamada antes da hora", async () => {
    const appointmentId = await createAppointment(memberA);
    await claimOne(appointmentId); // claim legítimo (attempts=1)
    await pool.query(
      `UPDATE scheduling_calendar_sync_outbox
       SET claimed_at=NULL, available_at=now() + interval '1 hour'
       WHERE appointment_id=$1 AND tenant_id=$2`,
      [appointmentId, tenantId]
    );
    expect(await repo.claimDue(20)).toEqual([]); // RED: hoje ignora available_at
    await pool.query(
      "UPDATE scheduling_calendar_sync_outbox SET available_at=now() WHERE appointment_id=$1 AND tenant_id=$2",
      [appointmentId, tenantId]
    );
    expect(await repo.claimDue(20)).toHaveLength(1);
  });
});

describe("posse do claim (lease)", () => {
  it("claim vencido não conclui por cima do novo dono: complete obsoleto não grava nem drena", async () => {
    const leaseless = new CalendarSyncRepository(pool, 0);
    const appointmentId = await createAppointment(memberA);
    const claimSame = async (): Promise<CalendarSyncJob> =>
      (await leaseless.claimDue(100)).find((job) => job.appointmentId === appointmentId)!;
    const staleJob = await claimSame();
    const freshJob = await claimSame(); // lease 0 → mesmo agendamento reclamado de novo
    expect(freshJob.attempts).toBeGreaterThan(staleJob.attempts);
    expect(freshJob.claimToken).not.toBe(staleJob.claimToken); // novo token de posse

    const staleWork = await leaseless.loadWork(staleJob);
    expect(staleWork).not.toBeNull();
    expect(await repo.complete(staleWork!, { etag: "late-worker" })).toBe("stale");
    expect(await linkRow(appointmentId)).toBeNull(); // worker atrasado não gravou
    expect(await outboxRow(appointmentId)).not.toBeNull(); // e não drenou a linha do dono atual

    const freshWork = await repo.loadWork(freshJob);
    expect(await repo.complete(freshWork!, { etag: "etag-fresh" })).toBe("synced");
    expect((await linkRow(appointmentId))?.etag).toBe("etag-fresh");
    expect(await outboxRow(appointmentId)).toBeNull();
  });
});

describe("CalendarSyncProcessor.process", () => {
  it("upsert cria vínculo com event id determinístico e drena a outbox", async () => {
    const appointmentId = await createAppointment(memberA);
    expect(await processor.process(await claimOne(appointmentId))).toBe("synced");
    const link = await linkRow(appointmentId);
    expect(link).toMatchObject({
      connection_id: connA,
      calendar_id: CAL_A,
      event_id: atendonCalendarEventId(appointmentId),
      sync_error: null
    });
    expect(calls.upserts[0]).toMatchObject({ token: "rt-connA", calendarId: CAL_A });
    expect(calls.upserts[0].etag).toBeUndefined(); // primeira publicação: sem If-Match
    expect(await outboxRow(appointmentId)).toBeNull();
  });

  it("update posterior usa If-Match com o etag gravado e persiste o novo", async () => {
    const appointmentId = await createAppointment(memberA);
    await syncAppointment(appointmentId);
    const firstEtag = (await linkRow(appointmentId))?.etag;

    await pool.query("UPDATE scheduling_appointments SET start_at=start_at + interval '1 hour', end_at=end_at + interval '1 hour' WHERE id=$1", [appointmentId]);
    expect(await processor.process(await claimOne(appointmentId))).toBe("synced");
    expect(calls.upserts.at(-1)?.etag).toBe(firstEtag); // If-Match
    expect((await linkRow(appointmentId))?.etag).toBe("etag-2");
  });

  it("edição de observação atualiza a descrição do evento remoto no mesmo evento (sem duplicata)", async () => {
    const appointmentId = await createAppointment(memberA);
    await syncAppointment(appointmentId);

    await pool.query(
      "UPDATE scheduling_appointments SET observation=$2,updated_at=now() WHERE id=$1",
      [appointmentId, "Observação atualizada para o Google"]
    );
    expect(await processor.process(await claimOne(appointmentId))).toBe("synced");
    expect(calls.upserts).toHaveLength(2); // mesma publicação, evento determinístico
    expect(calls.upserts[1].eventId).toBe(atendonCalendarEventId(appointmentId));
    expect(calls.upserts[1].fields.description).toContain("Observação atualizada para o Google");
    expect(calls.deletes).toEqual([]); // sem criar/excluir evento: sem duplicata
    expect(await linkRow(appointmentId)).toMatchObject({
      connection_id: connA,
      calendar_id: CAL_A,
      event_id: atendonCalendarEventId(appointmentId)
    });
    expect(await outboxRow(appointmentId)).toBeNull();
  });

  it("mutação concorrente durante a chamada ao Google: complete libera em vez de drenar (lost-update)", async () => {
    const appointmentId = await createAppointment(memberA);
    const job = await claimOne(appointmentId);
    const work = await repo.loadWork(job);
    await pool.query("UPDATE scheduling_appointments SET start_at=start_at + interval '3 hours', end_at=end_at + interval '3 hours' WHERE id=$1", [appointmentId]);
    expect(await repo.complete(work!, { etag: "stale-write" })).toBe("raced");
    expect(await linkRow(appointmentId)).toBeNull();
    expect(await outboxRow(appointmentId)).not.toBeNull();
  });

  it("snapshot cobre member_target: troca de agenda do assignee durante o voo libera a linha", async () => {
    const appointmentId = await createAppointment(memberA);
    const job = await claimOne(appointmentId);
    const work = await repo.loadWork(job);
    try {
      await pool.query("UPDATE scheduling_calendar_connections SET calendar_id='cal-z' WHERE id=$1", [connA]);
      expect(await repo.complete(work!, { etag: "stale-target" })).toBe("raced"); // RED: snapshot ignora member_target_*
      expect(await linkRow(appointmentId)).toBeNull();
      expect(await outboxRow(appointmentId)).not.toBeNull();
    } finally {
      await pool.query("UPDATE scheduling_calendar_connections SET calendar_id=$2 WHERE id=$1", [connA, CAL_A]);
    }
  });

  it("reatribuição A→B remove o evento antigo na conta A antes de criar na conta B", async () => {
    const appointmentId = await createAppointment(memberA);
    await syncAppointment(appointmentId);

    await pool.query("UPDATE scheduling_appointments SET assigned_member_id=$2 WHERE id=$1", [appointmentId, memberB]);
    expect(await processor.process(await claimOne(appointmentId))).toBe("synced");
    expect(calls.deletes).toEqual([{ token: "rt-connA", calendarId: CAL_A, eventId: atendonCalendarEventId(appointmentId) }]);
    expect(calls.upserts.at(-1)).toMatchObject({ token: "rt-connB", calendarId: CAL_B, etag: undefined });
    const link = await linkRow(appointmentId);
    expect(link).toMatchObject({ connection_id: connB, calendar_id: CAL_B });
    expect(await outboxRow(appointmentId)).toBeNull();
  });

  it("rotação com exclusão recusada no Google (HTTP 403): sem novo evento, vínculo antigo intacto e falha visível; retry após recuperação converge", async () => {
    const appointmentId = await createAppointment(memberA);
    await syncAppointment(appointmentId);

    await pool.query("UPDATE scheduling_appointments SET assigned_member_id=$2 WHERE id=$1", [appointmentId, memberB]);
    deleteError = new GoogleCalendarApiError("O Google recusou a exclusão do evento no Calendar (HTTP 403)", "failed", 403);

    // Sem a exclusão confirmada (200/404/410) o evento novo não nasce: 'failed'
    // não é engolido (duplicata); vínculo fica no destino ANTIGO, com o erro
    // observável, e a outbox preservada para retry com backoff.
    expect(await processor.process(await claimOne(appointmentId))).toBe("pending");
    expect(calls.upserts).toHaveLength(1); // só a publicação original, em A
    expect(calls.upserts[0]).toMatchObject({ token: "rt-connA", calendarId: CAL_A });
    expect(calls.deletes).toEqual([{ token: "rt-connA", calendarId: CAL_A, eventId: atendonCalendarEventId(appointmentId) }]);
    expect(await linkRow(appointmentId)).toMatchObject({
      connection_id: connA,
      calendar_id: CAL_A,
      event_id: atendonCalendarEventId(appointmentId),
      etag: "etag-1"
    });
    expect((await linkRow(appointmentId))?.sync_error).toContain("exclusão");
    const row = await outboxRow(appointmentId);
    expect(row?.last_error).toContain("exclusão");
    expect(row?.claimed_at).toBeNull(); // solto para retry com backoff

    // Recuperação (permissão restaurada): backoff liberado à mão e o retry
    // converge — reexecuta a exclusão (idempotente) e cria o evento em B.
    deleteError = null;
    await pool.query(
      "UPDATE scheduling_calendar_sync_outbox SET available_at=now() WHERE appointment_id=$1 AND tenant_id=$2",
      [appointmentId, tenantId]
    );
    expect(await processor.process(await claimOne(appointmentId))).toBe("synced");
    expect(calls.deletes).toHaveLength(2);
    expect(calls.upserts).toHaveLength(2); // exatamente um evento novo, em B
    expect(calls.upserts[1]).toMatchObject({ token: "rt-connB", calendarId: CAL_B, etag: undefined });
    expect(await linkRow(appointmentId)).toMatchObject({ connection_id: connB, calendar_id: CAL_B, sync_error: null });
    expect(await outboxRow(appointmentId)).toBeNull();
  });

  it("delete confirmado remotamente apaga o vínculo local e drena a outbox", async () => {
    const appointmentId = await createAppointment(memberA);
    await syncAppointment(appointmentId);
    await pool.query("UPDATE scheduling_appointments SET status='cancelado' WHERE id=$1", [appointmentId]);

    expect(await processor.process(await claimOne(appointmentId))).toBe("synced");
    expect(calls.deletes).toEqual([{ token: "rt-connA", calendarId: CAL_A, eventId: atendonCalendarEventId(appointmentId) }]);
    expect(await linkRow(appointmentId)).toBeNull();
    expect(await outboxRow(appointmentId)).toBeNull();
  });

  it("vínculo órfão (conexão removida): delete mantém o histórico, marca sync_error e drena a outbox", async () => {
    // Membros/conexão dedicados: a conexão é apagada aqui sem afetar as outras.
    const memberId = await createPoolMember("csync-orphan");
    const connId = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_calendar_connections(tenant_id,member_id,google_email,refresh_token_encrypted,calendar_id)
       VALUES($1,$2,'orphan@test.local',$3,'cal-orphan') RETURNING id`,
      [tenantId, memberId, encryptSecret("rt-orphan", TEST_KEY)]
    )).rows[0].id;
    const appointmentId = await createAppointment(memberId);
    await syncAppointment(appointmentId);
    await pool.query("DELETE FROM scheduling_calendar_connections WHERE id=$1", [connId]);
    await pool.query("UPDATE scheduling_appointments SET status='cancelado' WHERE id=$1", [appointmentId]);

    expect(await processor.process(await claimOne(appointmentId))).toBe("conflict");
    expect(calls.deletes).toEqual([]);
    const link = await linkRow(appointmentId);
    expect(link?.sync_error).toContain("órfão");
    expect(await outboxRow(appointmentId)).toBeNull();
  });

  it("404 com If-Match (evento apagado no Google): conflito observável, sem recriar", async () => {
    const appointmentId = await createAppointment(memberA);
    await syncAppointment(appointmentId);
    await pool.query("UPDATE scheduling_appointments SET start_at=start_at + interval '1 hour', end_at=end_at + interval '1 hour' WHERE id=$1", [appointmentId]);
    upsertError = new GoogleCalendarApiError("O Google recusou a atualização do evento no Calendar (HTTP 404)", "failed", 404);
    const attemptsBefore = calls.upserts.length;

    expect(await processor.process(await claimOne(appointmentId))).toBe("conflict");
    expect(calls.upserts.length).toBe(attemptsBefore + 1); // 1 tentativa: nenhuma recriação/retry
    expect((await linkRow(appointmentId))?.sync_error).toContain("removido no Google");
    expect(await outboxRow(appointmentId)).toBeNull();
  });

  it("upsert sem destino e sem vínculo drena a outbox (sem loop quente)", async () => {
    const appointmentId = await createAppointment(memberNoCalendar);
    expect(await processor.process(await claimOne(appointmentId))).toBe("dropped");
    expect(await outboxRow(appointmentId)).toBeNull(); // RED: hoje a linha fica presa para sempre
  });

  it("delete sem vínculo remoto drena a outbox (sem loop quente)", async () => {
    const appointmentId = await createAppointment(memberA);
    await pool.query("UPDATE scheduling_appointments SET status='cancelado' WHERE id=$1", [appointmentId]);
    expect(await processor.process(await claimOne(appointmentId))).toBe("dropped");
    expect(await outboxRow(appointmentId)).toBeNull(); // RED: cancelamento nunca sincronizado gira para sempre
  });

  it("falha persiste mensagem opaca: nenhum token em last_error/sync_error", async () => {
    const appointmentId = await createAppointment(memberA);
    await syncAppointment(appointmentId);
    await pool.query("UPDATE scheduling_appointments SET start_at=start_at + interval '1 hour', end_at=end_at + interval '1 hour' WHERE id=$1", [appointmentId]);
    upsertError = new GoogleCalendarApiError("O Google recusou a atualização do evento no Calendar (HTTP 500)", "safe_to_retry", 500);

    expect(await processor.process(await claimOne(appointmentId))).toBe("pending");
    const row = await outboxRow(appointmentId);
    const encrypted = encryptSecret("rt-connA", TEST_KEY);
    expect(row?.last_error).toBe("O Google recusou a atualização do evento no Calendar (HTTP 500)");
    expect(row?.last_error).not.toContain("rt-conn");
    expect(row?.last_error).not.toContain(encrypted.slice(0, 20));
    expect((await linkRow(appointmentId))?.sync_error).toBe(row?.last_error);
    expect(row?.claimed_at).toBeNull();
  });

  it("invalid_grant no sync marca SÓ a conexão usada como revogada; retry continua com backoff", async () => {
    const appointmentId = await createAppointment(memberA);
    await syncAppointment(appointmentId);
    await pool.query("UPDATE scheduling_appointments SET start_at=start_at + interval '1 hour', end_at=end_at + interval '1 hour' WHERE id=$1", [appointmentId]);
    upsertError = new GoogleCalendarAuthRevokedError();
    try {
      expect(await processor.process(await claimOne(appointmentId))).toBe("pending");
      const marks = await pool.query<{ id: string; auth_error: string | null }>(
        "SELECT id,auth_error FROM scheduling_calendar_connections WHERE id=ANY($1::uuid[])", [[connA, connB]]
      );
      expect(marks.rows.find((row) => row.id === connA)?.auth_error).toContain("revogado");
      expect(marks.rows.find((row) => row.id === connB)?.auth_error).toBeNull();
      expect((await outboxRow(appointmentId))?.last_error).toContain("revogado");
    } finally {
      await pool.query("UPDATE scheduling_calendar_connections SET auth_error=NULL,auth_error_at=NULL WHERE id=$1", [connA]);
    }
  });
});

describe("conexão com acesso revogado", () => {
  it("worker não chama o Google com conexão marcada (auth_error): falha observável e retry após reconectar", async () => {
    const appointmentId = await createAppointment(memberA);
    await syncAppointment(appointmentId);
    await pool.query("UPDATE scheduling_calendar_connections SET auth_error='revogado',auth_error_at=now() WHERE id=$1", [connA]);
    try {
      await pool.query("UPDATE scheduling_appointments SET start_at=start_at + interval '1 hour', end_at=end_at + interval '1 hour' WHERE id=$1", [appointmentId]);
      resetFake();
      expect(await processor.process(await claimOne(appointmentId))).toBe("pending");
      expect(calls.upserts).toHaveLength(0);
      expect(calls.deletes).toHaveLength(0);
      expect((await outboxRow(appointmentId))?.last_error).toContain("revogado");
      // Cancelamento com vínculo na conexão revogada também não chama o Google.
      await pool.query("UPDATE scheduling_appointments SET status='cancelado' WHERE id=$1", [appointmentId]);
      await pool.query("UPDATE scheduling_calendar_sync_outbox SET available_at=now() WHERE appointment_id=$1", [appointmentId]);
      expect(await processor.process(await claimOne(appointmentId))).toBe("pending");
      expect(calls.deletes).toHaveLength(0);
    } finally {
      await pool.query("UPDATE scheduling_calendar_connections SET auth_error=NULL,auth_error_at=NULL WHERE id=$1", [connA]);
      await pool.query("DELETE FROM scheduling_calendar_sync_outbox WHERE appointment_id=$1", [appointmentId]);
    }
  });
});

describe("reconciliação de vínculos", () => {
  async function staleLink(appointmentId: string): Promise<void> {
    await pool.query(
      "UPDATE scheduling_appointment_calendar_events SET last_synced_at=now() - interval '10 minutes' WHERE appointment_id=$1",
      [appointmentId]
    );
  }

  // Fixture sem closer no pool (membros ficam de fora de propósito): a adoção
  // do movimento passa pelo serviço de domínio, que recusa o responsável fora
  // do pool — o conflito observável carrega o motivo REAL do domínio. A adoção
  // bem-sucedida do movimento é coberta em calendar-sync-inbound.integration.test.ts.
  it("evento movido no Google: adoção recusada pelo domínio vira conflito observável + alerta uma única vez", async () => {
    const appointmentId = await createAppointment(memberA);
    await syncAppointment(appointmentId);
    await staleLink(appointmentId);
    remoteEvent = {
      id: atendonCalendarEventId(appointmentId),
      etag: "g-1",
      start: { dateTime: new Date(Date.parse(START) + 2 * 3_600_000).toISOString() },
      end: { dateTime: new Date(Date.parse(START) + 3 * 3_600_000).toISOString() }
    };

    expect(await reconcileLinkedCalendarEvents(repo, processor)).toBe(1);
    expect((await linkRow(appointmentId))?.sync_error).toContain("closer ativo do pool");
    expect(await conflictAlertCount(appointmentId)).toBe(1);
    // 2º ciclo: conflito persiste → re-stala e reavalia; alerta NÃO se repete.
    await staleLink(appointmentId);
    expect(await reconcileLinkedCalendarEvents(repo, processor)).toBe(1);
    expect(await conflictAlertCount(appointmentId)).toBe(1); // sem spam por ciclo
  });

  it("invalid_grant na leitura marca a conexão e a tira da reconciliação até reconectar", async () => {
    const appointmentId = await createAppointment(memberA);
    await syncAppointment(appointmentId);
    await staleLink(appointmentId);
    getEventError = new GoogleCalendarAuthRevokedError();
    try {
      expect(await reconcileLinkedCalendarEvents(repo, processor)).toBe(1);
      expect((await pool.query<{ auth_error: string | null }>(
        "SELECT auth_error FROM scheduling_calendar_connections WHERE id=$1", [connA]
      )).rows[0]?.auth_error).toContain("revogado");
      // Sem adoção de cancelamento: credencial morta não é "evento removido".
      expect((await pool.query<{ status: string }>("SELECT status FROM scheduling_appointments WHERE id=$1", [appointmentId])).rows[0]?.status)
        .not.toBe("cancelado");
      await staleLink(appointmentId);
      expect(await reconcileLinkedCalendarEvents(repo, processor)).toBe(0);
    } finally {
      await pool.query("UPDATE scheduling_calendar_connections SET auth_error=NULL,auth_error_at=NULL WHERE id=$1", [connA]);
      // Não deixa este vínculo reclamável pelos testes seguintes.
      await pool.query("UPDATE scheduling_appointment_calendar_events SET last_synced_at=now() WHERE appointment_id=$1", [appointmentId]);
    }
  });

  it("evento em sincronia limpa sync_error e atualiza etag", async () => {
    const appointmentId = await createAppointment(memberA);
    await syncAppointment(appointmentId);
    await staleLink(appointmentId);
    await pool.query(
      "UPDATE scheduling_appointment_calendar_events SET sync_error='erro antigo' WHERE appointment_id=$1",
      [appointmentId]
    );
    remoteEvent = { id: atendonCalendarEventId(appointmentId), etag: "g-2", start: { dateTime: new Date(Date.parse(START)).toISOString() }, end: { dateTime: new Date(Date.parse(START) + 3_600_000).toISOString() } };

    expect(await reconcileLinkedCalendarEvents(repo, processor)).toBe(1);
    const link = await linkRow(appointmentId);
    expect(link?.sync_error).toBeNull();
    expect(link?.etag).toBe("g-2");
  });

  it("404 na leitura (evento removido no Google): adota o cancelamento pela jornada em vez de conflito", async () => {
    const appointmentId = await createAppointment(memberA);
    await syncAppointment(appointmentId);
    await staleLink(appointmentId);
    getEventError = new GoogleCalendarApiError("O Google recusou a leitura do evento no Calendar (HTTP 404)", "failed", 404);

    expect(await reconcileLinkedCalendarEvents(repo, processor)).toBe(1);
    // Adotado: 404 cancela pela jornada (disposição recover) — sem marca de
    // conflito no vínculo e sem alerta; gatilho 0189 reenfileira o delete.
    expect((await appointmentRow(appointmentId))?.status).toBe("cancelado");
    const lead = await leadOfAppointment(appointmentId);
    expect(lead?.status).toBe("follow_up");
    expect(lead?.recovery_member_id).toBe(memberA);
    expect((await linkRow(appointmentId))?.sync_error).toBeNull();
    expect(await conflictAlertCount(appointmentId)).toBe(0);
    expect(await outboxRow(appointmentId)).toMatchObject({ kind: "delete" });
    expect(await processor.process(await claimOne(appointmentId))).toBe("synced");
    expect(await linkRow(appointmentId)).toBeNull();
    expect(await outboxRow(appointmentId)).toBeNull();
  });
});

describe("loop do worker", () => {
  it("não sobrepor drenagens: tick novo enquanto a drenagem anterior está em voo é ignorado", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let claimCount = 0;
    const slowRepo = {
      claimDue: async (): Promise<CalendarSyncJob[]> => {
        claimCount += 1;
        if (claimCount === 1) await gate;
        return [];
      },
      claimStaleLinked: async (): Promise<never[]> => []
    } as unknown as CalendarSyncRepository;

    const handle = startCalendarSyncWorker({
      pool,
      repository: slowRepo,
      intervalMs: 20,
      linksIntervalMs: 3_600_000
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100)); // ~5 ticks com a 1ª drenagem presa
      expect(claimCount).toBe(1); // RED: hoje cada tick empilha outra drenagem
      release();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(claimCount).toBeGreaterThanOrEqual(2); // retoma depois de liberada
    } finally {
      await handle.stop();
    }
  });
});
