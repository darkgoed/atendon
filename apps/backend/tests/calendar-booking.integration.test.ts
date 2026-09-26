// Integração: checagem fail-closed de disponibilidade do Google Calendar e rota
// de etapa (pipeline→equipe/conexão) em create/reschedule/reassign
// (specs/active/google-calendar-team-sync.md + migration 0186). HTTP do Google
// é stubado via seam de fábrica do client; banco de teste real.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import { seedTenantCapabilities } from "./helpers/capability-seed.js";
import { encryptSecret } from "../src/modules/ai-router/secret-box.js";
import { setCalendarBookingClientFactory, type CalendarBookingClient } from "../src/modules/scheduling/calendar-booking.js";
import {
  GoogleCalendarApiError,
  GoogleCalendarConfigurationError
} from "../src/modules/scheduling/google-calendar.js";
import {
  cancelAppointment,
  createAppointment,
  reassignAppointmentAssignee,
  rescheduleAppointment
} from "../src/modules/scheduling/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
// Segunda 05/10/2026, 13:00Z (fuso do tenant em teste: UTC) — dentro de 08:00-18:00.
const NOW = new Date("2026-10-05T09:00:00Z");
const SLOT_START = "2026-10-05T13:00:00Z";
const SLOT_END = "2026-10-05T14:00:00Z";

type FakeEvent = { start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; transparency?: "transparent" | "opaque" };
type FakeState = {
  busy: Array<{ start: string; end: string }>;
  events: Map<string, FakeEvent>;
  fail: Error | null;
  calls: Array<{ calendarId: string; start: string; end: string }>;
  tokens: string[];
};
let googleState: FakeState = { busy: [], events: new Map(), fail: null, calls: [], tokens: [] };

function overlaps(start?: string, end?: string, from = 0, to = 0): boolean {
  const eventStart = Date.parse(start ?? "");
  const eventEnd = Date.parse(end ?? "");
  return eventStart < to && eventEnd > from;
}

beforeEach(() => {
  googleState = { busy: [], events: new Map(), fail: null, calls: [], tokens: [] };
  setCalendarBookingClientFactory(() => ({
    freeBusy: async (refreshToken: string, calendarId: string, start: string, end: string) => {
      if (googleState.fail) throw googleState.fail;
      googleState.calls.push({ calendarId, start, end });
      googleState.tokens.push(refreshToken);
      return googleState.busy;
    },
    listEvents: async (refreshToken: string, calendarId: string, start: string, end: string) => {
      if (googleState.fail) throw googleState.fail;
      googleState.calls.push({ calendarId, start, end });
      googleState.tokens.push(refreshToken);
      const from = Date.parse(start);
      const to = Date.parse(end);
      return [...googleState.events.entries()]
        .filter(([, event]) => overlaps(event.start?.dateTime ?? event.start?.date, event.end?.dateTime ?? event.end?.date, from, to))
        .map(([id, event]) => ({ id, ...event }));
    }
  }) as unknown as CalendarBookingClient);
});

afterEach(async () => {
  await pool.query("DELETE FROM scheduling_pipeline_calendar_routes WHERE tenant_id=$1", [fixture.tenantId]);
  await pool.query("UPDATE scheduling_calendar_connections SET buffer_minutes=0 WHERE tenant_id=$1", [fixture.tenantId]);
  await pool.query("DELETE FROM scheduling_appointments WHERE tenant_id=$1", [fixture.tenantId]);
});

afterAll(async () => {
  setCalendarBookingClientFactory(null);
  await pool.query("DELETE FROM tenants WHERE name LIKE 'CalendarBooking %'");
  await pool.end();
});

type Fixture = {
  tenantId: string;
  ownerId: string;
  members: Record<"a" | "b" | "c" | "d", string>;
  pipelineId: string;
  sessionId: string;
};

async function setupTenant(label: string): Promise<Fixture> {
  const tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`CalendarBooking ${label} ${randomUUID()}`]
  )).rows[0].id;
  await seedTenantCapabilities(pool, [tenantId]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const roles = await client.query<{ id: string; name: string }>("SELECT id,name FROM workspace_roles WHERE workspace_id=$1", [tenantId]);
    const operatorRole = roles.rows.find((role) => role.name === "OPERADOR")!.id;
    const owner = (await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,'x','active') RETURNING id",
      [`owner-${label}-${randomUUID()}@test.local`]
    )).rows[0].id;
    await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())", [tenantId, owner, operatorRole]);
    const members = {} as Fixture["members"];
    for (const label2 of ["a", "b", "c", "d"] as const) {
      const user = (await client.query<{ id: string }>(
        "INSERT INTO users(email,password_hash,status) VALUES($1,'x','active') RETURNING id",
        [`closer-${label2}-${randomUUID()}@test.local`]
      )).rows[0].id;
      members[label2] = (await client.query<{ id: string }>(
        "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now()) RETURNING id",
        [tenantId, user, operatorRole]
      )).rows[0].id;
      await client.query("INSERT INTO scheduling_google_meet_closers(tenant_id,member_id) VALUES($1,$2)", [tenantId, members[label2]]);
    }
    await client.query(
      "INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity) VALUES($1,'unit','Unit','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[],60,3)",
      [tenantId]
    );
    const sessionId = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",
      [tenantId]
    )).rows[0].id;
    const pipelineId = (await client.query<{ pipeline_id: string }>(
      "SELECT pipeline_id FROM pipeline_stages WHERE tenant_id=$1 ORDER BY position,id LIMIT 1",
      [tenantId]
    )).rows[0].pipeline_id;
    await client.query("COMMIT");
    return { tenantId, ownerId: owner, members, pipelineId, sessionId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

let fixture: Fixture;
let ownerUserId = "";

beforeAll(async () => {
  fixture = await setupTenant("ab");
  ownerUserId = (await pool.query<{ user_id: string }>(
    "SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id IS NOT NULL LIMIT 1",
    [fixture.tenantId]
  )).rows[0].user_id;
});

async function connectMember(memberId: string, calendarId: string | null, bufferMinutes = 0) {
  await pool.query(
    `INSERT INTO scheduling_calendar_connections(tenant_id,member_id,google_email,refresh_token_encrypted,calendar_id,buffer_minutes)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(tenant_id,member_id) DO UPDATE SET
       calendar_id=EXCLUDED.calendar_id,
       buffer_minutes=EXCLUDED.buffer_minutes,
       refresh_token_encrypted=EXCLUDED.refresh_token_encrypted`,
    [fixture.tenantId, memberId, `${memberId}@test.local`, encryptSecret(`refresh-${memberId}`, config.DATA_ENCRYPTION_KEY), calendarId, bufferMinutes]
  );
}

async function linkOwnEvent(appointmentId: string, memberId: string, eventId: string): Promise<void> {
  // Espelha o vínculo criado pelo worker de sync (0185) para o evento nosso.
  await pool.query(
    `INSERT INTO scheduling_appointment_calendar_events(appointment_id,tenant_id,connection_id,calendar_id,event_id)
     SELECT $1,$2,id,calendar_id,$4 FROM scheduling_calendar_connections WHERE tenant_id=$2 AND member_id=$3`,
    [appointmentId, fixture.tenantId, memberId, eventId]
  );
}

async function setRoute(target: { teamId?: string | null; connectionId?: string | null }) {
  await pool.query("DELETE FROM scheduling_pipeline_calendar_routes WHERE tenant_id=$1 AND pipeline_id=$2", [fixture.tenantId, fixture.pipelineId]);
  if (target.teamId ?? target.connectionId) {
    await pool.query(
      "INSERT INTO scheduling_pipeline_calendar_routes(tenant_id,pipeline_id,team_id,connection_id) VALUES($1,$2,$3,$4)",
      [fixture.tenantId, fixture.pipelineId, target.teamId ?? null, target.connectionId ?? null]
    );
  }
}

async function newLead(memberId?: string) {
  const phone = `5511${Math.floor(910_000_000 + Math.random() * 89_999_999)}`;
  const leadId = (await pool.query<{ id: string }>(
    "INSERT INTO scheduling_leads(tenant_id,phone,name,source,assigned_member_id) VALUES($1,$2,'Lead','test',$3) RETURNING id",
    [fixture.tenantId, phone, memberId ?? null]
  )).rows[0].id;
  await pool.query(
    "INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,ai_active) VALUES($1,$2,$3,'Lead',true)",
    [fixture.tenantId, fixture.sessionId, phone]
  );
  return leadId;
}

function createBody(leadId: string, extra: Record<string, unknown> = {}) {
  return { lead_id: leadId, unidade_id: "unit", start: SLOT_START, ...extra };
}

const createOptions = { manual: true, allowExplicitAssignee: true, now: NOW };

async function assignedMember(appointmentId: string): Promise<string | null> {
  return (await pool.query<{ assigned_member_id: string | null }>(
    "SELECT assigned_member_id FROM scheduling_appointments WHERE id=$1",
    [appointmentId]
  )).rows[0]?.assigned_member_id ?? null;
}

async function appointmentStart(appointmentId: string): Promise<string> {
  return (await pool.query<{ start_at: Date }>(
    "SELECT start_at FROM scheduling_appointments WHERE id=$1",
    [appointmentId]
  )).rows[0].start_at.toISOString();
}

// Agendamento SEM responsável, com o lead na etapa roteada (rota → equipe):
// único cenário em que o reagendamento usa a seleção automática do pool.
async function newUnassignedRoutedAppointment(): Promise<string> {
  const leadId = await newLead();
  await pool.query(
    "UPDATE scheduling_leads SET pipeline_stage_id=(SELECT id FROM pipeline_stages WHERE tenant_id=$1 ORDER BY position,id LIMIT 1) WHERE id=$2",
    [fixture.tenantId, leadId]
  );
  return (await pool.query<{ id: string }>(
    "INSERT INTO scheduling_appointments(lead_id,tenant_id,unit_id,start_at,end_at) VALUES($1,$2,'unit',$3,$4) RETURNING id",
    [leadId, fixture.tenantId, SLOT_START, SLOT_END]
  )).rows[0].id;
}

describe("google calendar booking (0186)", () => {
  it("sem conexão do responsável: cria na lógica legada sem chamar o Google", async () => {
    // c = conexão sem agenda selecionada; d = sem conexão alguma.
    await connectMember(fixture.members.c, null);
    for (const member of [fixture.members.c, fixture.members.d]) {
      const leadId = await newLead();
      const appointment = await createAppointment(fixture.tenantId, createBody(leadId, { assigned_member_id: member }), createOptions);
      expect(appointment.id).toBeTruthy();
      expect(await assignedMember(appointment.id as string)).toBe(member);
      expect(googleState.calls).toHaveLength(0);
    }
  });

  it("conexões A/B isoladas: consulta a agenda do responsável e bloqueia quando a dele está ocupada", async () => {
    await connectMember(fixture.members.a, "cal-a");
    await connectMember(fixture.members.b, "cal-b");
    const freeLead = await newLead();
    const appointment = await createAppointment(fixture.tenantId, createBody(freeLead, { assigned_member_id: fixture.members.a }), createOptions);
    expect(appointment.id).toBeTruthy();
    expect(googleState.calls).toEqual([{ calendarId: "cal-a", start: "2026-10-05T13:00:00.000Z", end: "2026-10-05T14:00:00.000Z" }]);
    expect(googleState.tokens).toEqual([`refresh-${fixture.members.a}`]);

    googleState.busy = [{ start: SLOT_START, end: SLOT_END }];
    const busyLead = await newLead();
    await expect(createAppointment(fixture.tenantId, createBody(busyLead, { assigned_member_id: fixture.members.b }), createOptions))
      .rejects.toMatchObject({ statusCode: 409 });
    expect((await pool.query("SELECT 1 FROM scheduling_appointments WHERE lead_id=$1", [busyLead])).rows).toHaveLength(0);
    expect(googleState.calls.at(-1)?.calendarId).toBe("cal-b");
  });

  it("conflito externo → 409 sem criar; falha do Google → 502/503, nunca confirma como livre", async () => {
    await connectMember(fixture.members.a, "cal-a");
    for (const failure of [
      new GoogleCalendarApiError("Google fora do ar", "safe_to_retry", 503),
      new GoogleCalendarConfigurationError(),
      new Error("falha inesperada")
    ] as Error[]) {
      googleState.fail = failure;
      const leadId = await newLead();
      const expected = failure instanceof GoogleCalendarApiError ? 502 : failure instanceof GoogleCalendarConfigurationError ? 503 : 502;
      await expect(createAppointment(fixture.tenantId, createBody(leadId, { assigned_member_id: fixture.members.a }), createOptions))
        .rejects.toMatchObject({ statusCode: expected });
      expect((await pool.query("SELECT 1 FROM scheduling_appointments WHERE lead_id=$1", [leadId])).rows).toHaveLength(0);
    }
    googleState.fail = null;
  });

  it("freeBusy com entrada indecifrável ou duração nula → fail-closed 409", async () => {
    await connectMember(fixture.members.a, "cal-a");
    for (const busy of [
      [{ start: "nao-e-data", end: "tambem-nao" }],
      [{ start: SLOT_START, end: SLOT_START }],
      [{ start: SLOT_END, end: SLOT_START }],
      [{ start: "2026-10-05T20:00:00Z", end: "fora-da-janela-indecifrável" }]
    ]) {
      googleState.busy = busy;
      const leadId = await newLead();
      await expect(createAppointment(fixture.tenantId, createBody(leadId, { assigned_member_id: fixture.members.a }), createOptions))
        .rejects.toMatchObject({ statusCode: 409 });
      expect((await pool.query("SELECT 1 FROM scheduling_appointments WHERE lead_id=$1", [leadId])).rows).toHaveLength(0);
    }
    googleState.busy = [];
  });

  it("intervalos encostados (termina em 13:00 / começa em 14:00) não conflitam", async () => {
    await connectMember(fixture.members.a, "cal-a");
    await connectMember(fixture.members.b, "cal-b");
    googleState.busy = [{ start: "2026-10-05T12:00:00Z", end: SLOT_START }];
    const leadId = await newLead();
    const appointment = await createAppointment(fixture.tenantId, createBody(leadId, { assigned_member_id: fixture.members.a }), createOptions);
    expect(appointment.id).toBeTruthy();

    // Começa exatamente onde a janela termina: toque na borda não é conflito.
    googleState.busy = [{ start: SLOT_END, end: "2026-10-05T15:00:00Z" }];
    const secondLead = await newLead();
    const second = await createAppointment(fixture.tenantId, createBody(secondLead, { assigned_member_id: fixture.members.b }), createOptions);
    expect(second.id).toBeTruthy();
  });

  it("buffer_minutes da conexão amplia a janela checada", async () => {
    await connectMember(fixture.members.a, "cal-a", 30);
    googleState.busy = [{ start: "2026-10-05T14:15:00Z", end: "2026-10-05T15:15:00Z" }];
    const leadId = await newLead();
    await expect(createAppointment(fixture.tenantId, createBody(leadId, { assigned_member_id: fixture.members.a }), createOptions))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(googleState.calls[0]).toEqual({
      calendarId: "cal-a",
      start: "2026-10-05T12:30:00.000Z",
      end: "2026-10-05T14:30:00.000Z"
    });
    await pool.query("UPDATE scheduling_calendar_connections SET buffer_minutes=0 WHERE tenant_id=$1 AND member_id=$2", [fixture.tenantId, fixture.members.a]);
    const freeLead = await newLead();
    const appointment = await createAppointment(fixture.tenantId, createBody(freeLead, { assigned_member_id: fixture.members.a }), createOptions);
    expect(appointment.id).toBeTruthy();
  });

  it("calendário recém-selecionado preserva o buffer já configurado na conexão", async () => {
    // Estado pós-OAuth (0185): conexão existe com buffer configurado e SEM agenda.
    await connectMember(fixture.members.a, null, 30);
    // A agenda é selecionada DEPOIS (rota PUT /connections/:id/calendar): o UPDATE
    // de produção troca só calendar_id/name/timezone — o buffer precisa sobreviver.
    await pool.query(
      `UPDATE scheduling_calendar_connections
       SET calendar_id='cal-a', calendar_name='Agenda A', updated_at=now()
       WHERE tenant_id=$1 AND member_id=$2`,
      [fixture.tenantId, fixture.members.a]
    );
    googleState.busy = [{ start: "2026-10-05T14:15:00Z", end: "2026-10-05T15:15:00Z" }];
    const leadId = await newLead();
    await expect(createAppointment(fixture.tenantId, createBody(leadId, { assigned_member_id: fixture.members.a }), createOptions))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(googleState.calls[0]).toEqual({
      calendarId: "cal-a",
      start: "2026-10-05T12:30:00.000Z",
      end: "2026-10-05T14:30:00.000Z"
    });
  });

  it("rotação de chave: refresh token cifrado com a chave ANTERIOR decifra pelo keyring", async () => {
    // Simula token gravado antes da rotação (cifrado com a chave anterior): sem o
    // keyring {current, previous} o decript falha → 502 fail-closed.
    const previousKey = "chave-anterior-da-rotação-32-caracteres-x";
    const original = config.DATA_ENCRYPTION_KEY_PREVIOUS;
    try {
      config.DATA_ENCRYPTION_KEY_PREVIOUS = previousKey;
      await connectMember(fixture.members.a, "cal-a");
      await pool.query(
        "UPDATE scheduling_calendar_connections SET refresh_token_encrypted=$3 WHERE tenant_id=$1 AND member_id=$2",
        [fixture.tenantId, fixture.members.a, encryptSecret("refresh-cifrado-na-chave-anterior", previousKey)]
      );
      const leadId = await newLead();
      const appointment = await createAppointment(fixture.tenantId, createBody(leadId, { assigned_member_id: fixture.members.a }), createOptions);
      expect(appointment.id).toBeTruthy();
      expect(googleState.tokens).toEqual(["refresh-cifrado-na-chave-anterior"]);
    } finally {
      config.DATA_ENCRYPTION_KEY_PREVIOUS = original;
    }
  });

  it("rota de equipe: rotação restrita aos membros e escolha explícita de fora → 409", async () => {
    const teamId = (await pool.query<{ id: string }>(
      "INSERT INTO teams(tenant_id,name) VALUES($1,'Equipe A') RETURNING id",
      [fixture.tenantId]
    )).rows[0].id;
    await pool.query("UPDATE workspace_members SET team_id=$1 WHERE workspace_id=$2 AND id=$3", [teamId, fixture.tenantId, fixture.members.b]);
    await setRoute({ teamId });
    const leadId = await newLead();
    const appointment = await createAppointment(fixture.tenantId, createBody(leadId), { manual: true, now: NOW });
    expect(await assignedMember(appointment.id as string)).toBe(fixture.members.b);

    const explicitLead = await newLead();
    await expect(createAppointment(fixture.tenantId, createBody(explicitLead, { assigned_member_id: fixture.members.a }), createOptions))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("rota de equipe: primeiro candidato ocupado no Google → roda para o próximo livre da equipe", async () => {
    const teamId = (await pool.query<{ id: string }>(
      "INSERT INTO teams(tenant_id,name) VALUES($1,'Equipe GC') RETURNING id",
      [fixture.tenantId]
    )).rows[0].id;
    await pool.query(
      "UPDATE workspace_members SET team_id=$1 WHERE workspace_id=$2 AND id=ANY($3::uuid[])",
      [teamId, fixture.tenantId, [fixture.members.a, fixture.members.b]]
    );
    await connectMember(fixture.members.a, "cal-a");
    await connectMember(fixture.members.b, "cal-b");
    await connectMember(fixture.members.c, "cal-c");
    await setRoute({ teamId });
    // freeBusy por agenda: cal-a ocupada, cal-b livre (ordem da rotação depende do
    // sort de uuid); cal-c FORA da equipe fica livre — se a exclusão da equipe
    // regredir, o loop cairia em c em vez de 409.
    const busyByCalendar = new Map<string, Array<{ start: string; end: string }>>([
      ["cal-a", [{ start: SLOT_START, end: SLOT_END }]]
    ]);
    setCalendarBookingClientFactory(() => ({
      freeBusy: async (refreshToken: string, calendarId: string, start: string, end: string) => {
        googleState.calls.push({ calendarId, start, end });
        googleState.tokens.push(refreshToken);
        return busyByCalendar.get(calendarId) ?? [];
      },
      listEvents: async () => {
        throw new Error("listEvents não deveria ser chamado na criação");
      }
    }) as unknown as CalendarBookingClient);

    const leadId = await newLead();
    const appointment = await createAppointment(fixture.tenantId, createBody(leadId), createOptions);
    expect(await assignedMember(appointment.id as string)).toBe(fixture.members.b);
    expect(googleState.calls.length).toBeGreaterThan(0);
    expect(googleState.calls.some((call) => call.calendarId === "cal-b")).toBe(true);
    // Janela consultada = slot exato (buffer 0): duração/intervalo respeitados.
    expect(googleState.calls.every((call) => call.start === new Date(SLOT_START).toISOString() && call.end === new Date(SLOT_END).toISOString())).toBe(true);

    // Todos os membros da equipe ocupados no Google → 409; nunca cai para fora da equipe.
    busyByCalendar.set("cal-b", [{ start: SLOT_START, end: SLOT_END }]);
    googleState.calls = [];
    const busyLead = await newLead();
    await expect(createAppointment(fixture.tenantId, createBody(busyLead), createOptions))
      .rejects.toMatchObject({ statusCode: 409 });
    expect((await pool.query("SELECT 1 FROM scheduling_appointments WHERE lead_id=$1", [busyLead])).rows).toHaveLength(0);
    expect(googleState.calls.length).toBeGreaterThan(0);
    expect(googleState.calls.every((call) => ["cal-a", "cal-b"].includes(call.calendarId))).toBe(true);
  });

  it("reagendamento automático (sem responsável): ocupado no Google → roda para o próximo livre da equipe", async () => {
    const teamId = (await pool.query<{ id: string }>(
      "INSERT INTO teams(tenant_id,name) VALUES($1,'Equipe RS') RETURNING id",
      [fixture.tenantId]
    )).rows[0].id;
    await pool.query(
      "UPDATE workspace_members SET team_id=$1 WHERE workspace_id=$2 AND id=ANY($3::uuid[])",
      [teamId, fixture.tenantId, [fixture.members.a, fixture.members.b]]
    );
    // Ordem determinística da rotação: created_at distintos → a antes de b no pool.
    await pool.query("UPDATE scheduling_google_meet_closers SET created_at=$2 WHERE tenant_id=$1 AND member_id=$3", [fixture.tenantId, new Date("2026-01-01T00:00:00Z"), fixture.members.a]);
    await pool.query("UPDATE scheduling_google_meet_closers SET created_at=$2 WHERE tenant_id=$1 AND member_id=$3", [fixture.tenantId, new Date("2026-01-02T00:00:00Z"), fixture.members.b]);
    await connectMember(fixture.members.a, "cal-a");
    await connectMember(fixture.members.b, "cal-b");
    await setRoute({ teamId });
    // Slot NOVO do reagendamento: 13:30-14:30. cal-a ocupada, cal-b livre.
    const busyByCalendar = new Map<string, Array<{ start: string; end: string }>>([
      ["cal-a", [{ start: SLOT_START, end: SLOT_END }]]
    ]);
    setCalendarBookingClientFactory(() => ({
      freeBusy: async (refreshToken: string, calendarId: string, start: string, end: string) => {
        googleState.calls.push({ calendarId, start, end });
        googleState.tokens.push(refreshToken);
        return busyByCalendar.get(calendarId) ?? [];
      },
      listEvents: async () => {
        throw new Error("listEvents não deveria ser chamado sem evento vinculado");
      }
    }) as unknown as CalendarBookingClient);
    // 1ª rotação: agendamento SEM responsável → caminho automático.
    const appointmentId = await newUnassignedRoutedAppointment();
    // Cursor zerado: rotação começa no primeiro do pool (a) — determinístico.
    await pool.query("DELETE FROM attendant_assignment_cursors WHERE tenant_id=$1", [fixture.tenantId]);

    await rescheduleAppointment(fixture.tenantId, appointmentId, { start: "2026-10-05T13:30:00Z" }, { manual: true, now: NOW, requireAvailableAttendant: true });
    expect(await appointmentStart(appointmentId)).toBe("2026-10-05T13:30:00.000Z");
    // a consultada e pulada (ocupado), b consultada e livre → b assume.
    expect(await assignedMember(appointmentId)).toBe(fixture.members.b);
    expect(googleState.calls.map((call) => call.calendarId)).toEqual(["cal-a", "cal-b"]);

    // 409 em agendamento RECÉM-criado sem responsável: o 1º agora pertence a b —
    // reagendá-lo preservaria b (só cal-b seria consultada). Ambos da equipe
    // ocupados no Google no slot novo → 409, horário preservado, e a rotação
    // nunca cai para membros de fora da equipe (c/d ficariam "livres" no Google).
    const slotNovo = [{ start: "2026-10-05T15:00:00Z", end: "2026-10-05T16:00:00Z" }];
    busyByCalendar.set("cal-a", slotNovo);
    busyByCalendar.set("cal-b", slotNovo);
    googleState.calls = [];
    const busyAppointmentId = await newUnassignedRoutedAppointment();
    // Cursor zerado de novo: rotação determinística começando em a.
    await pool.query("DELETE FROM attendant_assignment_cursors WHERE tenant_id=$1", [fixture.tenantId]);
    await expect(rescheduleAppointment(fixture.tenantId, busyAppointmentId, { start: "2026-10-05T15:00:00Z" }, { manual: true, now: NOW, requireAvailableAttendant: true }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(await appointmentStart(busyAppointmentId)).toBe("2026-10-05T13:00:00.000Z");
    expect(await assignedMember(busyAppointmentId)).toBeNull();
    expect(googleState.calls.map((call) => call.calendarId)).toEqual(["cal-a", "cal-b"]);
  });

  it("rota de conexão força o dono da conexão mesmo com escolha explícita", async () => {
    await connectMember(fixture.members.b, "cal-b");
    await setRoute({ connectionId: (await pool.query<{ id: string }>(
      "SELECT id FROM scheduling_calendar_connections WHERE tenant_id=$1 AND member_id=$2",
      [fixture.tenantId, fixture.members.b]
    )).rows[0].id });
    const leadId = await newLead();
    const appointment = await createAppointment(fixture.tenantId, createBody(leadId, { assigned_member_id: fixture.members.a }), createOptions);
    expect(await assignedMember(appointment.id as string)).toBe(fixture.members.b);
    expect(googleState.calls.at(-1)?.calendarId).toBe("cal-b");
  });

  it("reagendamento exclui apenas o evento vinculado próprio (por identidade), externo na janela → 409", async () => {
    await connectMember(fixture.members.a, "cal-a");
    const leadId = await newLead();
    const appointment = await createAppointment(fixture.tenantId, createBody(leadId, { assigned_member_id: fixture.members.a }), createOptions) as { id: string };
    await linkOwnEvent(appointment.id as string, fixture.members.a, "evt-own");
    googleState.events.set("evt-own", { start: { dateTime: SLOT_START }, end: { dateTime: SLOT_END } });
    // Google ainda reporta o próprio evento (13:00-14:00) como busy: excusado por
    // identidade → sucesso.
    googleState.busy = [{ start: SLOT_START, end: SLOT_END }];
    await rescheduleAppointment(fixture.tenantId, appointment.id, { start: "2026-10-05T13:30:00Z" }, { manual: true, now: NOW });

    // Evento externo sobreposto (não é o nosso) na janela pedida → 409.
    googleState.events.set("evt-ext", { start: { dateTime: "2026-10-05T14:00:00Z" }, end: { dateTime: "2026-10-05T15:00:00Z" } });
    await expect(rescheduleAppointment(fixture.tenantId, appointment.id, { start: "2026-10-05T13:45:00Z" }, { manual: true, now: NOW }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(await appointmentStart(appointment.id)).toBe("2026-10-05T13:30:00.000Z");
  });

  it("reagendamento: evento externo coincidente com o próprio (bloco mesclado no freeBusy) → 409", async () => {
    // Nosso evento e um externo ocupam o MESMO intervalo: o freeBusy do Google os
    // mescla em UM bloco igual ao intervalo do próprio. Aprovar por igualdade de
    // intervalo liberaria slot ocupado — a identidade (events.list) separa os dois.
    await connectMember(fixture.members.a, "cal-a");
    const leadId = await newLead();
    const appointment = await createAppointment(fixture.tenantId, createBody(leadId, { assigned_member_id: fixture.members.a }), createOptions) as { id: string };
    await linkOwnEvent(appointment.id as string, fixture.members.a, "evt-own");
    googleState.events.set("evt-own", { start: { dateTime: SLOT_START }, end: { dateTime: SLOT_END } });
    googleState.events.set("evt-ext", { start: { dateTime: SLOT_START }, end: { dateTime: SLOT_END } });
    googleState.busy = [{ start: SLOT_START, end: SLOT_END }];
    await expect(rescheduleAppointment(fixture.tenantId, appointment.id, { start: "2026-10-05T13:30:00Z" }, { manual: true, now: NOW }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(await appointmentStart(appointment.id)).toBe("2026-10-05T13:00:00.000Z");
  });

  it("reagendamento: evento externo coincidente TRANSPARENTE é ignorado → sucesso", async () => {
    // Mesma cena do teste anterior, mas o externo é 'transparent' (ex.: bloqueio
    // "Ocupado" do próprio usuário que não ocupa): só evento opaco conflita —
    // pin regressivo do if (transparency === 'transparent') em calendar-booking.
    await connectMember(fixture.members.a, "cal-a");
    const leadId = await newLead();
    const appointment = await createAppointment(fixture.tenantId, createBody(leadId, { assigned_member_id: fixture.members.a }), createOptions) as { id: string };
    await linkOwnEvent(appointment.id as string, fixture.members.a, "evt-own");
    googleState.events.set("evt-own", { start: { dateTime: SLOT_START }, end: { dateTime: SLOT_END } });
    googleState.events.set("evt-ext", { start: { dateTime: SLOT_START }, end: { dateTime: SLOT_END }, transparency: "transparent" });
    googleState.busy = [{ start: SLOT_START, end: SLOT_END }];
    await rescheduleAppointment(fixture.tenantId, appointment.id, { start: "2026-10-05T13:30:00Z" }, { manual: true, now: NOW });
    expect(await appointmentStart(appointment.id)).toBe("2026-10-05T13:30:00.000Z");
  });

  it("reagendamento: evento próprio já movido na agenda + busy externo na mesma janela → 409", async () => {
    await connectMember(fixture.members.a, "cal-a");
    const leadId = await newLead();
    const appointment = await createAppointment(fixture.tenantId, createBody(leadId, { assigned_member_id: fixture.members.a }), createOptions) as { id: string };
    await linkOwnEvent(appointment.id as string, fixture.members.a, "evt-own");
    googleState.events.set("evt-own", { start: { dateTime: SLOT_START }, end: { dateTime: SLOT_END } });
    googleState.busy = [{ start: SLOT_START, end: SLOT_END }];
    // Primeiro reagendamento excusa o próprio evento por identidade → sucesso.
    await rescheduleAppointment(fixture.tenantId, appointment.id, { start: "2026-10-05T13:30:00Z" }, { manual: true, now: NOW });
    // O sync já moveu o evento Google para a posição atual (13:30-14:30).
    googleState.events.set("evt-own", { start: { dateTime: "2026-10-05T13:30:00Z" }, end: { dateTime: "2026-10-05T14:30:00Z" } });
    // Evento externo exatamente na janela pedida (14:00-15:00) → 409, mesmo com o
    // próprio evento também cobrindo a janela.
    googleState.events.set("evt-ext", { start: { dateTime: "2026-10-05T14:00:00Z" }, end: { dateTime: "2026-10-05T15:00:00Z" } });
    await expect(rescheduleAppointment(fixture.tenantId, appointment.id, { start: "2026-10-05T14:00:00Z" }, { manual: true, now: NOW }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(await appointmentStart(appointment.id)).toBe("2026-10-05T13:30:00.000Z");
  });

  it("cancelamento: nunca consulta o Google; outbox 'delete' na mesma transação; vínculo preservado; reagendar/reatribuir cancelado → 409", async () => {
    await connectMember(fixture.members.a, "cal-a");
    const leadId = await newLead();
    // O cancelamento move a etapa do lead; o fixture não define pipeline_stage_id.
    await pool.query(
      "UPDATE scheduling_leads SET pipeline_stage_id=(SELECT id FROM pipeline_stages WHERE tenant_id=$1 ORDER BY position,id LIMIT 1) WHERE id=$2",
      [fixture.tenantId, leadId]
    );
    const appointment = await createAppointment(fixture.tenantId, createBody(leadId, { assigned_member_id: fixture.members.a }), createOptions) as { id: string };
    await linkOwnEvent(appointment.id as string, fixture.members.a, "evt-own");
    const callsBefore = googleState.calls.length;

    await cancelAppointment(fixture.tenantId, appointment.id);
    expect(googleState.calls).toHaveLength(callsBefore);
    // Gatilho 0189 enfileira na MESMA transação: cancelado → kind='delete'.
    const outbox = await pool.query<{ kind: string }>(
      "SELECT kind FROM scheduling_calendar_sync_outbox WHERE appointment_id=$1",
      [appointment.id]
    );
    expect(outbox.rows[0]?.kind).toBe("delete");
    // Vínculo NÃO é apagado pelo cancelamento — só após exclusão remota confirmada.
    const link = await pool.query("SELECT 1 FROM scheduling_appointment_calendar_events WHERE appointment_id=$1", [appointment.id]);
    expect(link.rows).toHaveLength(1);

    await expect(rescheduleAppointment(fixture.tenantId, appointment.id, { start: "2026-10-05T15:00:00Z" }, { manual: true, now: NOW }))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(reassignAppointmentAssignee(fixture.tenantId, appointment.id, fixture.members.b, { userId: ownerUserId, actorScope: "workspace" }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(googleState.calls).toHaveLength(callsBefore);
  });

  it("reatribuição: conflito na agenda do destino → 409 e reatribuição preservada", async () => {
    await connectMember(fixture.members.a, "cal-a");
    await connectMember(fixture.members.b, "cal-b");
    const leadId = await newLead(fixture.members.a);
    const appointment = await createAppointment(fixture.tenantId, createBody(leadId, { assigned_member_id: fixture.members.a }), createOptions) as { id: string };
    googleState.busy = [{ start: SLOT_START, end: SLOT_END }];
    await expect(reassignAppointmentAssignee(fixture.tenantId, appointment.id, fixture.members.b, { userId: ownerUserId, actorScope: "workspace" }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(await assignedMember(appointment.id)).toBe(fixture.members.a);

    googleState.busy = [];
    const reassigned = await reassignAppointmentAssignee(fixture.tenantId, appointment.id, fixture.members.b, { userId: ownerUserId, actorScope: "workspace" });
    expect(await assignedMember(appointment.id)).toBe(fixture.members.b);
    expect(reassigned).toBeTruthy();
  });

  it("reatribuição: rota de equipe recusa membro de fora; rota de conexão força o dono", async () => {
    await connectMember(fixture.members.b, "cal-b");
    const leadId = await newLead(fixture.members.a);
    const appointment = await createAppointment(fixture.tenantId, createBody(leadId, { assigned_member_id: fixture.members.a }), createOptions) as { id: string };
    const teamId = (await pool.query<{ id: string }>(
      "INSERT INTO teams(tenant_id,name) VALUES($1,'Equipe R') RETURNING id",
      [fixture.tenantId]
    )).rows[0].id;
    await pool.query("UPDATE workspace_members SET team_id=$1 WHERE workspace_id=$2 AND id=$3", [teamId, fixture.tenantId, fixture.members.b]);
    await setRoute({ teamId });
    await expect(reassignAppointmentAssignee(fixture.tenantId, appointment.id, fixture.members.c, { userId: ownerUserId, actorScope: "workspace" }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(await assignedMember(appointment.id)).toBe(fixture.members.a);

    await setRoute({ connectionId: (await pool.query<{ id: string }>(
      "SELECT id FROM scheduling_calendar_connections WHERE tenant_id=$1 AND member_id=$2",
      [fixture.tenantId, fixture.members.b]
    )).rows[0].id });
    await reassignAppointmentAssignee(fixture.tenantId, appointment.id, fixture.members.c, { userId: ownerUserId, actorScope: "workspace" });
    expect(await assignedMember(appointment.id)).toBe(fixture.members.b);
  });
});
