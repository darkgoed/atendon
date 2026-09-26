// Integração: a lista de responsáveis (appointment-assignees) confirma contra a
// Google Agenda quem está livre localmente. Google ocupado → membro removido da
// oferta com placeholder de conflito (sem detalhes do evento externo); Google
// fora do ar → falha (fail-closed), nunca "livre" sem confirmação. HTTP do
// Google é stubado via seam de fábrica do client; banco de teste real.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import { seedTenantCapabilities } from "./helpers/capability-seed.js";
import { encryptSecret } from "../src/modules/ai-router/secret-box.js";
import { setCalendarBookingClientFactory, type CalendarBookingClient } from "../src/modules/scheduling/calendar-booking.js";
import { GoogleCalendarApiError } from "../src/modules/scheduling/google-calendar.js";
import { listAppointmentAssignees } from "../src/modules/scheduling/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const INTERVAL = { start: new Date("2026-10-05T13:00:00Z"), end: new Date("2026-10-05T14:00:00Z") };

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
  await pool.query("DELETE FROM tenants WHERE name LIKE 'CalendarAssignee %'");
  await pool.end();
});

let fixture: { tenantId: string; members: { a: string; b: string } };

beforeAll(async () => {
  const tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`CalendarAssignee ${randomUUID()}`]
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
        [`assignee-${label}-${randomUUID()}@test.local`]
      )).rows[0].id;
      members[label] = (await client.query<{ id: string }>(
        "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now()) RETURNING id",
        [tenantId, user, operatorRole]
      )).rows[0].id;
      await client.query("INSERT INTO scheduling_google_meet_closers(tenant_id,member_id) VALUES($1,$2)", [tenantId, members[label]]);
    }
    await client.query("COMMIT");
    fixture = { tenantId, members };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

async function connectMember(memberId: string, calendarId: string) {
  await pool.query(
    `INSERT INTO scheduling_calendar_connections(tenant_id,member_id,google_email,refresh_token_encrypted,calendar_id,buffer_minutes)
     VALUES($1,$2,$3,$4,$5,0)
     ON CONFLICT(tenant_id,member_id) DO UPDATE SET calendar_id=EXCLUDED.calendar_id`,
    [fixture.tenantId, memberId, `${memberId}@test.local`, encryptSecret(`refresh-${memberId}`, config.DATA_ENCRYPTION_KEY), calendarId]
  );
}

describe("appointment assignees × Google Calendar availability", () => {
  it("Google ocupado para A e livre para B: só B é oferecido e sugerido", async () => {
    await connectMember(fixture.members.a, "cal-a");
    await connectMember(fixture.members.b, "cal-b");
    googleState.busy = { "cal-a": [{ start: INTERVAL.start.toISOString(), end: INTERVAL.end.toISOString() }] };

    const assignees = await listAppointmentAssignees(fixture.tenantId, INTERVAL);

    const busy = assignees.find((option) => option.member_id === fixture.members.a)!;
    expect(busy.selectable).toBe(false);
    // Placeholder sem detalhes do evento externo (só indica ocupado no Google).
    expect(busy.conflicts).toEqual([{
      id: "google-calendar",
      start: INTERVAL.start.toISOString(),
      end: INTERVAL.end.toISOString(),
      lead_name: "Ocupado na Google Agenda"
    }]);
    const free = assignees.find((option) => option.member_id === fixture.members.b)!;
    expect(free.selectable).toBe(true);
    expect(free.suggested).toBe(true);
    // Ordem dos membros é ORDER BY pool.created_at,member.id (ids aleatórios): só garante que ambos foram consultados.
    expect(googleState.calls.map((call) => call.calendarId).sort()).toEqual(["cal-a", "cal-b"]);
  });

  it("Google fora do ar: falha (fail-closed) em vez de oferecer livre", async () => {
    await connectMember(fixture.members.a, "cal-a");
    for (const failure of [
      new GoogleCalendarApiError("Google fora do ar"),
      new Error("falha inesperada")
    ]) {
      googleState.fail = failure;
      await expect(listAppointmentAssignees(fixture.tenantId, INTERVAL))
        .rejects.toMatchObject({ statusCode: 502 });
    }
    googleState.fail = null;
  });
});
