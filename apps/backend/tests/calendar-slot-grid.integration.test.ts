// Integração: a grade de horários (verificarHorarios) com responsável EXPLÍCITO
// honra a Google Agenda — intervalos remotos (expandidos pelo buffer da agenda)
// ocupam slots (vagas=0), o filtro de horário solicitado/próximos obedece ao
// Google, Google fora do ar falha 502 (fail-closed) e sem conexão o legado é
// preservado. HTTP do Google é stubado via seam de fábrica do client; banco de
// teste real. Horários locais derivados via workspaceLocalDateTime.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import { seedTenantCapabilities } from "./helpers/capability-seed.js";
import { encryptSecret } from "../src/modules/ai-router/secret-box.js";
import { setCalendarBookingClientFactory, type CalendarBookingClient } from "../src/modules/scheduling/calendar-booking.js";
import { GoogleCalendarApiError } from "../src/modules/scheduling/google-calendar.js";
import { verificarHorarios, workspaceLocalDateTime } from "../src/modules/scheduling/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const DAY = "2026-10-05";
const TIMEZONE = "America/Sao_Paulo";
const UNIT_ID = "slot-grid";
const BUFFER_MS = 30 * 60_000;
const at = (hhmm: string) => workspaceLocalDateTime(DAY, hhmm, TIMEZONE);

type FakeState = {
  busy: Record<string, Array<{ start: string; end: string }>>;
  fail: Error | null;
  calls: Array<{ calendarId: string; start: string; end: string }>;
};
let googleState: FakeState = { busy: {}, fail: null, calls: [] };

beforeEach(() => {
  googleState = { busy: {}, fail: null, calls: [] };
  setCalendarBookingClientFactory(() => ({
    freeBusy: async (_refreshToken: string, calendarId: string, start: string, end: string) => {
      if (googleState.fail) throw googleState.fail;
      googleState.calls.push({ calendarId, start, end });
      return googleState.busy[calendarId] ?? [];
    },
    listEvents: async () => {
      if (googleState.fail) throw googleState.fail;
      return [];
    }
  }) as unknown as CalendarBookingClient);
});

afterEach(async () => {
  await pool.query("DELETE FROM scheduling_calendar_connections WHERE tenant_id=$1", [fixture.tenantId]);
});

afterAll(async () => {
  setCalendarBookingClientFactory(null);
  await pool.query("DELETE FROM tenants WHERE name LIKE 'CalendarSlotGrid %'");
  await pool.end();
});

let fixture: { tenantId: string; members: { a: string; b: string } };

beforeAll(async () => {
  const tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active',$2) RETURNING id",
    [`CalendarSlotGrid ${randomUUID()}`, TIMEZONE]
  )).rows[0].id;
  await seedTenantCapabilities(pool, [tenantId]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const roles = await client.query<{ id: string; name: string }>("SELECT id,name FROM workspace_roles WHERE workspace_id=$1", [tenantId]);
    const operatorRole = roles.rows.find((role) => role.name === "OPERADOR")!.id;
    const members = {} as { a: string; b: string };
    for (const label of ["a", "b"] as const) {
      const user = (await client.query<{ id: string }>(
        "INSERT INTO users(email,password_hash,status) VALUES($1,'x','active') RETURNING id",
        [`slot-grid-${label}-${randomUUID()}@test.local`]
      )).rows[0].id;
      members[label] = (await client.query<{ id: string }>(
        "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now()) RETURNING id",
        [tenantId, user, operatorRole]
      )).rows[0].id;
    }
    // Unidade: grade de 60min, capacidade 1, todos os dias (determinístico).
    await client.query(
      `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity)
       VALUES($1,$2,'Slot Grid','08:00','18:00',ARRAY[0,1,2,3,4,5,6]::smallint[],60,1)`,
      [tenantId, UNIT_ID]
    );
    await client.query("COMMIT");
    fixture = { tenantId, members };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

async function connectMember(memberId: string, calendarId: string, bufferMinutes: number) {
  await pool.query(
    `INSERT INTO scheduling_calendar_connections(tenant_id,member_id,google_email,refresh_token_encrypted,calendar_id,buffer_minutes)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(tenant_id,member_id) DO UPDATE SET calendar_id=EXCLUDED.calendar_id,buffer_minutes=EXCLUDED.buffer_minutes`,
    [fixture.tenantId, memberId, `${memberId}@test.local`, encryptSecret(`refresh-${memberId}`, config.DATA_ENCRYPTION_KEY), calendarId, bufferMinutes]
  );
}

function slotAt(grid: Awaited<ReturnType<typeof verificarHorarios>>, hhmm: string) {
  const start = at(hhmm).toISOString();
  const slot = grid.horarios.find((option) => option.start === start);
  expect(slot, `slot ${hhmm} ausente da grade`).toBeDefined();
  return slot!;
}

describe("availability grid × Google Calendar busy intervals", () => {
  it("compromisso remoto dentro do slot + buffer marca 09:00/10:00/11:00 ocupados; uma única chamada freeBusy sobre o dia expandido", async () => {
    await connectMember(fixture.members.a, "cal-a", 30);
    // Evento 10:10–10:50 local; buffer 30min → ocupa [09:40, 11:20].
    googleState.busy = { "cal-a": [{ start: at("10:10").toISOString(), end: at("10:50").toISOString() }] };

    const grid = await verificarHorarios(fixture.tenantId, UNIT_ID, DAY, {
      includeFullSlots: true,
      assignedMemberId: fixture.members.a
    });

    expect(slotAt(grid, "09:00").vagas).toBe(0); // buffer antes
    expect(slotAt(grid, "10:00").vagas).toBe(0); // evento dentro do slot
    expect(slotAt(grid, "11:00").vagas).toBe(0); // buffer depois
    expect(slotAt(grid, "08:00").vagas).toBe(1); // fora do buffer
    expect(slotAt(grid, "12:00").vagas).toBe(1);
    // Uma chamada freeBusy sobre o dia expandido pelo buffer.
    expect(googleState.calls).toEqual([{
      calendarId: "cal-a",
      start: new Date(at("08:00").getTime() - BUFFER_MS).toISOString(),
      end: new Date(at("18:00").getTime() + BUFFER_MS).toISOString()
    }]);
  });

  it("horário solicitado ocupado no Google: indisponível e horarios_proximos exclui slots ocupados (com buffer)", async () => {
    await connectMember(fixture.members.a, "cal-a", 30);
    googleState.busy = { "cal-a": [{ start: at("10:10").toISOString(), end: at("10:50").toISOString() }] };

    const grid = await verificarHorarios(fixture.tenantId, UNIT_ID, DAY, {
      assignedMemberId: fixture.members.a,
      requestedTime: "10:00"
    });

    expect(grid.horarios).toEqual([]);
    expect(grid.horario_solicitado).toBeDefined();
    expect(grid.horario_solicitado).toMatchObject({ start: at("10:00").toISOString(), disponivel: false, vagas: 0 });
    // 09:00 e 11:00 são ocupados pelo buffer → próximos são 08:00, 12:00, 13:00.
    expect((grid.horarios_proximos ?? []).map((option) => option.start)).toEqual([
      at("08:00").toISOString(),
      at("12:00").toISOString(),
      at("13:00").toISOString()
    ]);
  });

  it("Google fora do ar: falha 502 (fail-closed), nunca grade livre", async () => {
    await connectMember(fixture.members.a, "cal-a", 30);
    googleState.fail = new GoogleCalendarApiError("Google indisponível no teste");

    const error = await verificarHorarios(fixture.tenantId, UNIT_ID, DAY, {
      includeFullSlots: true,
      assignedMemberId: fixture.members.a
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(GoogleCalendarApiError);
    expect((error as GoogleCalendarApiError).statusCode).toBe(502);
  });

  it("sem conexão do responsável: legado preservado — grade livre e nenhuma chamada ao Google", async () => {
    // Membro B sem conexão; Google até responde para 'cal-b' se consultado.
    googleState.busy = { "cal-b": [{ start: at("10:10").toISOString(), end: at("10:50").toISOString() }] };

    const grid = await verificarHorarios(fixture.tenantId, UNIT_ID, DAY, {
      includeFullSlots: true,
      assignedMemberId: fixture.members.b
    });

    expect(grid.horarios).toHaveLength(10);
    expect(grid.horarios.every((slot) => slot.vagas === 1)).toBe(true);
    expect(googleState.calls).toEqual([]);
  });
});
