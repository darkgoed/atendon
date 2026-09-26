import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { decryptSecret, encryptSecret } from "../src/modules/ai-router/secret-box.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
// As rotas já vêm registradas pelo orquestrador: buildApp (app.ts) inclui
// registerGoogleCalendarRoutes — nada é registrado em duplicidade aqui.
const app = buildApp();
const password = "calendar-test-password";
let tenantId = "";
let otherTenantId = "";
let userId = "";
let otherUserId = "";
let operatorUserId = "";
let adminUserId = "";
let adminMemberId = "";
let adminCookie = "";
let memberId = "";
let operatorMemberId = "";
let otherMemberId = "";
let cookie = "";
let operatorCookie = "";
let otherCookie = "";
let connectionId = "";
let otherTenantConnectionId = "";
let otherTenantTeamId = "";
let appointmentId = "";
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Servidor Google falso: token/userinfo/calendarList determinísticos por teste.
function stubGoogleFetch(options: {
  tokenStatus?: number;
  user?: unknown;
  userStatus?: number;
  calendarList?: unknown[];
  calendarStatus?: number;
}): void {
  fetchCalls = [];
  vi.stubGlobal("fetch", (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, init });
    if (url === config.GOOGLE_MEET_TOKEN_URL) {
      return jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 }, options.tokenStatus ?? 200);
    }
    if (url === config.GOOGLE_MEET_OAUTH_USERINFO_URL) {
      return jsonResponse(options.user ?? { email: "atendente@test.local", email_verified: true }, options.userStatus ?? 200);
    }
    if (url.includes("/calendar/v3/users/me/calendarList")) {
      const pages = options.calendarList ?? [];
      const pageToken = new URL(url).searchParams.get("pageToken");
      const index = pageToken === null ? 0 : Number(pageToken);
      // Simula o filtro minAccessRole=writer do Google real: só owner/writer voltam.
      const page = pages[index] as { items?: Array<{ accessRole?: string }>; nextPageToken?: string } | undefined;
      const items = (page?.items ?? []).filter(
        (item) => item.accessRole === "owner" || item.accessRole === "writer"
      );
      return jsonResponse({ items, nextPageToken: page?.nextPageToken }, options.calendarStatus ?? 200);
    }
    return jsonResponse({ error: "unexpected_request" }, 500);
  }) as typeof fetch);
}

async function createWorkspaceUser(tenant: string, email: string, role = "OWNER"): Promise<{ userId: string; memberId: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenant);
    const user = await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
      [email, await hash(password, 4)]
    );
    const member = await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name=$3
       RETURNING id`,
      [tenant, user.rows[0].id, role]
    );
    await client.query("COMMIT");
    return { userId: user.rows[0].id, memberId: member.rows[0].id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function login(email: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  expect(response.statusCode).toBe(200);
  return (Array.isArray(response.headers["set-cookie"])
    ? response.headers["set-cookie"][0]
    : response.headers["set-cookie"]!).split(";")[0];
}

async function startOauth(member: string, forCookie: string = cookie): Promise<{ authorization_url: string }> {
  const response = await app.inject({
    method: "GET",
    url: `/scheduling/google-calendar/oauth/start?member_id=${member}`,
    headers: { cookie: forCookie }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { authorization_url: string };
}

function nonceFrom(authorizationUrl: string): string {
  const url = new URL(authorizationUrl);
  expect(url.origin).toBe(new URL(config.GOOGLE_MEET_OAUTH_AUTH_URL).origin);
  expect(url.searchParams.get("client_id")).toBe("calendar-test-client");
  // Callback público real: o proxy mapeia {PANEL_PUBLIC_URL}/api → API (prefixo removido).
  expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3200/api/scheduling/google-calendar/oauth/callback");
  expect(url.searchParams.get("scope")).toContain("calendar.events");
  expect(url.searchParams.get("scope")).toContain("calendar.calendarlist.readonly");
  expect(url.searchParams.get("scope")).toContain("calendar.freebusy");
  expect(url.searchParams.get("access_type")).toBe("offline");
  const nonce = url.searchParams.get("state");
  expect(nonce).toBeTruthy();
  return nonce as string;
}

beforeAll(async () => {
  config.GOOGLE_MEET_OAUTH_CLIENT_ID = "calendar-test-client";
  config.GOOGLE_MEET_OAUTH_CLIENT_SECRET = "calendar-test-secret";
  await app.ready();
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','UTC') RETURNING id",
    [`Calendar A ${randomUUID()}`]
  )).rows[0].id;
  otherTenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','UTC') RETURNING id",
    [`Calendar B ${randomUUID()}`]
  )).rows[0].id;
  const owner = await createWorkspaceUser(tenantId, `calendar-owner-${randomUUID()}@test.local`);
  userId = owner.userId;
  memberId = owner.memberId;
  const operator = await createWorkspaceUser(tenantId, `calendar-operator-${randomUUID()}@test.local`, "OPERADOR");
  operatorUserId = operator.userId;
  operatorMemberId = operator.memberId;
  const admin = await createWorkspaceUser(tenantId, `calendar-admin-${randomUUID()}@test.local`, "ADMIN");
  adminUserId = admin.userId;
  adminMemberId = admin.memberId;
  const otherOwner = await createWorkspaceUser(otherTenantId, `calendar-other-${randomUUID()}@test.local`);
  otherUserId = otherOwner.userId;
  otherMemberId = otherOwner.memberId;
  cookie = await login((await pool.query<{ email: string }>("SELECT email FROM users WHERE id=$1", [userId])).rows[0].email);
  operatorCookie = await login((await pool.query<{ email: string }>("SELECT email FROM users WHERE id=$1", [operatorUserId])).rows[0].email);
  otherCookie = await login((await pool.query<{ email: string }>("SELECT email FROM users WHERE id=$1", [otherUserId])).rows[0].email);
  adminCookie = await login((await pool.query<{ email: string }>("SELECT email FROM users WHERE id=$1", [adminUserId])).rows[0].email);
  otherTenantConnectionId = (await pool.query<{ id: string }>(
    `INSERT INTO scheduling_calendar_connections(tenant_id,member_id,google_email,refresh_token_encrypted)
     VALUES($1,$2,'outra@conta.local',$3) RETURNING id`,
    [otherTenantId, otherMemberId, encryptSecret("rt-other", config.DATA_ENCRYPTION_KEY)]
  )).rows[0].id;
  otherTenantTeamId = (await pool.query<{ id: string }>(
    "INSERT INTO teams(tenant_id,name) VALUES($1,'Equipe outro') RETURNING id",
    [otherTenantId]
  )).rows[0].id;
});

afterAll(async () => {
  config.GOOGLE_MEET_OAUTH_CLIENT_ID = undefined;
  config.GOOGLE_MEET_OAUTH_CLIENT_SECRET = undefined;
  vi.unstubAllGlobals();
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantId, otherTenantId]]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[userId, operatorUserId, otherUserId, adminUserId]]);
  await app.close();
  await pool.end();
});

describe("Google Calendar team sync integration", () => {
  it("applies migration 0185 with tables, composite FKs and check constraints", async () => {
    for (const table of [
      "scheduling_calendar_connections",
      "scheduling_pipeline_calendar_routes",
      "scheduling_appointment_calendar_events",
      "scheduling_calendar_sync_outbox",
      "scheduling_calendar_oauth_states"
    ]) {
      const exists = await pool.query("SELECT to_regclass($1) AS reg", [`public.${table}`]);
      expect(exists.rows[0]?.reg, table).not.toBeNull();
    }
    const constraints = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = ANY($1::text[])`,
      [[
        "scheduling_calendar_connections_tenant_member_unique",
        "scheduling_calendar_connections_id_tenant_unique",
        "scheduling_calendar_connections_member_fkey",
        "scheduling_pipeline_calendar_routes_target_check",
        "scheduling_pipeline_calendar_routes_pipeline_fkey",
        "scheduling_appointment_calendar_events_target_unique",
        "scheduling_appointment_calendar_events_connection_fkey",
        "scheduling_calendar_sync_outbox_appointment_fkey",
        "scheduling_appointments_id_tenant_unique",
        "workspace_members_id_workspace_unique"
      ]]
    );
    expect(new Set(constraints.rows.map((row) => row.conname)).size).toBe(10);
  }, 20_000);

  it("oauth/start requires units.manage, an active member, and persists a one-time nonce", async () => {
    const forbidden = await app.inject({
      method: "GET",
      url: `/scheduling/google-calendar/oauth/start?member_id=${memberId}`,
      headers: { cookie: operatorCookie }
    });
    expect(forbidden.statusCode).toBe(403);
    const missing = await app.inject({
      method: "GET",
      url: "/scheduling/google-calendar/oauth/start",
      headers: { cookie }
    });
    expect(missing.statusCode).toBe(400);
    const unknownMember = await app.inject({
      method: "GET",
      url: `/scheduling/google-calendar/oauth/start?member_id=${randomUUID()}`,
      headers: { cookie }
    });
    expect(unknownMember.statusCode).toBe(404);
    const start = await startOauth(memberId);
    const nonce = nonceFrom(start.authorization_url);
    const persisted = await pool.query<{ member_id: string; tenant_id: string; used_at: Date | null }>(
      "SELECT member_id,tenant_id,used_at FROM scheduling_calendar_oauth_states WHERE nonce=$1",
      [nonce]
    );
    expect(persisted.rows[0]).toMatchObject({ member_id: memberId, tenant_id: tenantId, used_at: null });

    const previousClientId = config.GOOGLE_MEET_OAUTH_CLIENT_ID;
    config.GOOGLE_MEET_OAUTH_CLIENT_ID = "";
    const unconfigured = await app.inject({
      method: "GET",
      url: `/scheduling/google-calendar/oauth/start?member_id=${memberId}`,
      headers: { cookie }
    });
    expect(unconfigured.statusCode).toBe(503);
    config.GOOGLE_MEET_OAUTH_CLIENT_ID = previousClientId;
  }, 20_000);

  it("callback exchanges the code once, encrypts the refresh token, and rejects replays", async () => {
    stubGoogleFetch({});
    const nonce = nonceFrom((await startOauth(memberId)).authorization_url);
    const callback = await app.inject({
      method: "GET",
      url: `/scheduling/google-calendar/oauth/callback?code=one-time-code&state=${nonce}`,
      headers: { cookie }
    });
    expect(callback.statusCode).toBe(302);
    // Volta para a rota aninhada do painel, sem o parâmetro resource antigo.
    const redirect = new URL(String(callback.headers.location));
    expect(redirect.pathname).toBe("/configuracoes/google-calendar");
    expect(redirect.searchParams.get("calendar_oauth")).toBe("connected");
    expect(redirect.searchParams.has("resource")).toBe(false);

    const saved = await pool.query<{
      google_email: string; refresh_token_encrypted: string; calendar_id: string | null; member_id: string;
    }>(
      "SELECT google_email,refresh_token_encrypted,calendar_id,member_id FROM scheduling_calendar_connections WHERE tenant_id=$1",
      [tenantId]
    );
    expect(saved.rows).toHaveLength(1);
    expect(saved.rows[0]).toMatchObject({ google_email: "atendente@test.local", calendar_id: null, member_id: memberId });
    expect(decryptSecret(saved.rows[0].refresh_token_encrypted, config.DATA_ENCRYPTION_KEY)).toBe("rt");
    connectionId = (await pool.query<{ id: string }>(
      "SELECT id FROM scheduling_calendar_connections WHERE tenant_id=$1", [tenantId]
    )).rows[0].id;
    expect((await pool.query("SELECT used_at FROM scheduling_calendar_oauth_states WHERE nonce=$1", [nonce])).rows[0].used_at).not.toBeNull();

    const replay = await app.inject({
      method: "GET",
      url: `/scheduling/google-calendar/oauth/callback?code=one-time-code&state=${nonce}`,
      headers: { cookie }
    });
    expect(String(replay.headers.location)).toContain("calendar_oauth=denied");
    expect(fetchCalls.filter((call) => call.url === config.GOOGLE_MEET_TOKEN_URL)).toHaveLength(1);

    const forged = await app.inject({
      method: "GET",
      url: `/scheduling/google-calendar/oauth/callback?code=x&state=${randomUUID()}`,
      headers: { cookie }
    });
    expect(String(forged.headers.location)).toContain("calendar_oauth=denied");

    // Nonce de outro gerente (mesmo tenant) não vale: user_id é verificado.
    const otherUserNonce = nonceFrom((await startOauth(operatorMemberId, cookie)).authorization_url);
    const hijacked = await app.inject({
      method: "GET",
      url: `/scheduling/google-calendar/oauth/callback?code=x&state=${otherUserNonce}`,
      headers: { cookie: adminCookie }
    });
    expect(String(hijacked.headers.location)).toContain("calendar_oauth=denied");
  }, 20_000);

  it("callback consumes the nonce and reports denial/error even when Google refuses", async () => {
    stubGoogleFetch({});
    const deniedNonce = nonceFrom((await startOauth(memberId)).authorization_url);
    const denied = await app.inject({
      method: "GET",
      url: `/scheduling/google-calendar/oauth/callback?error=access_denied&state=${deniedNonce}`,
      headers: { cookie }
    });
    expect(String(denied.headers.location)).toContain("calendar_oauth=denied");
    expect((await pool.query("SELECT used_at FROM scheduling_calendar_oauth_states WHERE nonce=$1", [deniedNonce])).rows[0].used_at).not.toBeNull();

    stubGoogleFetch({ tokenStatus: 400 });
    const errorNonce = nonceFrom((await startOauth(memberId)).authorization_url);
    const failed = await app.inject({
      method: "GET",
      url: `/scheduling/google-calendar/oauth/callback?code=bad-code&state=${errorNonce}`,
      headers: { cookie }
    });
    expect(String(failed.headers.location)).toContain("calendar_oauth=error");
    const saved = await pool.query("SELECT 1 FROM scheduling_calendar_connections WHERE tenant_id=$1", [tenantId]);
    expect(saved.rows).toHaveLength(1);

    const expired = await pool.query(
      `INSERT INTO scheduling_calendar_oauth_states(nonce,tenant_id,user_id,member_id,expires_at)
       VALUES($1,$2,$3,$4,now() - interval '1 minute')`,
      ["expired-nonce", tenantId, userId, memberId]
    );
    expect(expired.rowCount).toBe(1);
    const expiredCallback = await app.inject({
      method: "GET",
      url: "/scheduling/google-calendar/oauth/callback?code=x&state=expired-nonce",
      headers: { cookie }
    });
    expect(String(expiredCallback.headers.location)).toContain("calendar_oauth=denied");
    const noState = await app.inject({
      method: "GET",
      url: "/scheduling/google-calendar/oauth/callback?code=x",
      headers: { cookie }
    });
    expect(String(noState.headers.location)).toContain("calendar_oauth=denied");
  }, 20_000);

  it("lists connections as tenant-scoped metadata without tokens", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/scheduling/google-calendar/connections",
      headers: { cookie }
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { configured: boolean; connections: Array<Record<string, unknown>> };
    expect(body.configured).toBe(true);
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).toMatchObject({
      email: "atendente@test.local", calendar_id: null, configured: false, member_id: memberId
    });
    expect(JSON.stringify(body)).not.toContain("refresh_token");
    // units.read é suficiente para listar.
    expect((await app.inject({
      method: "GET",
      url: "/scheduling/google-calendar/connections",
      headers: { cookie: operatorCookie }
    })).statusCode).toBe(200);
    const foreign = await app.inject({
      method: "GET",
      url: "/scheduling/google-calendar/connections",
      headers: { cookie: otherCookie }
    });
    // Isolado: só a conexão do próprio tenant, nunca a de A.
    const foreignBody = foreign.json() as { connections: Array<{ id: string }> };
    expect(foreignBody.connections.map((row) => row.id)).toEqual([otherTenantConnectionId]);
  }, 20_000);

  it("lists writable calendars across pagination and requires units.manage", async () => {
    stubGoogleFetch({
      calendarList: [
        {
          items: [
            { id: "primary@test.local", summary: "Agenda Atendente", timeZone: "America/Sao_Paulo", primary: true, accessRole: "owner" },
            { id: "leitor@test.local", summary: "Somente leitura", accessRole: "reader" }
          ],
          nextPageToken: "1"
        },
        {
          items: [
            { id: "equipe@test.local", summary: "Agenda Equipe", timeZone: "UTC", accessRole: "writer" }
          ]
        }
      ]
    });
    const forbidden = await app.inject({
      method: "GET",
      url: `/scheduling/google-calendar/connections/${connectionId}/calendars`,
      headers: { cookie: operatorCookie }
    });
    expect(forbidden.statusCode).toBe(403);
    const ok = await app.inject({
      method: "GET",
      url: `/scheduling/google-calendar/connections/${connectionId}/calendars`,
      headers: { cookie }
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      calendars: [
        { id: "primary@test.local", name: "Agenda Atendente", timezone: "America/Sao_Paulo", primary: true },
        { id: "equipe@test.local", name: "Agenda Equipe", timezone: "UTC", primary: false }
      ]
    });
    const missing = await app.inject({
      method: "GET",
      url: `/scheduling/google-calendar/connections/${randomUUID()}/calendars`,
      headers: { cookie }
    });
    expect(missing.statusCode).toBe(404);
  }, 20_000);

  it("selects only a writable calendar for the connection", async () => {
    stubGoogleFetch({
      calendarList: [
        {
          items: [
            { id: "primary@test.local", summary: "Agenda Atendente", timeZone: "America/Sao_Paulo", primary: true, accessRole: "owner" },
            { id: "leitor@test.local", summary: "Somente leitura", accessRole: "reader" }
          ],
          nextPageToken: "1"
        },
        { items: [{ id: "equipe@test.local", summary: "Agenda Equipe", timeZone: "UTC", accessRole: "writer" }] }
      ]
    });
    const reader = await app.inject({
      method: "PUT",
      url: `/scheduling/google-calendar/connections/${connectionId}/calendar`,
      headers: { cookie },
      payload: { calendar_id: "leitor@test.local" }
    });
    expect(reader.statusCode).toBe(400);
    const arbitrary = await app.inject({
      method: "PUT",
      url: `/scheduling/google-calendar/connections/${connectionId}/calendar`,
      headers: { cookie },
      payload: { calendar_id: "nao-existe@test.local" }
    });
    expect(arbitrary.statusCode).toBe(400);
    const ok = await app.inject({
      method: "PUT",
      url: `/scheduling/google-calendar/connections/${connectionId}/calendar`,
      headers: { cookie },
      payload: { calendar_id: "equipe@test.local" }
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      calendar: { id: "equipe@test.local", name: "Agenda Equipe", timezone: "UTC" }
    });
    const row = await pool.query<{ calendar_id: string | null; calendar_name: string | null; calendar_timezone: string | null }>(
      "SELECT calendar_id,calendar_name,calendar_timezone FROM scheduling_calendar_connections WHERE tenant_id=$1",
      [tenantId]
    );
    expect(row.rows[0]).toEqual({ calendar_id: "equipe@test.local", calendar_name: "Agenda Equipe", calendar_timezone: "UTC" });
  }, 20_000);

  it("reconnecting keeps the connection but clears the selected calendar", async () => {
    stubGoogleFetch({});
    const nonce = nonceFrom((await startOauth(memberId)).authorization_url);
    const reconnect = await app.inject({
      method: "GET",
      url: `/scheduling/google-calendar/oauth/callback?code=fresh-code&state=${nonce}`,
      headers: { cookie }
    });
    expect(String(reconnect.headers.location)).toContain("calendar_oauth=connected");
    const rows = await pool.query<{ count: number; calendar_id: string | null }>(
      "SELECT count(*)::int AS count, (SELECT calendar_id FROM scheduling_calendar_connections WHERE tenant_id=$1) AS calendar_id FROM scheduling_calendar_connections WHERE tenant_id=$1",
      [tenantId]
    );
    expect(rows.rows[0]).toMatchObject({ count: 1, calendar_id: null });
  }, 20_000);

  it("blocks disconnect with future linked appointments and orphans only history", async () => {
    await pool.query(
      `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity)
       VALUES($1,'cal-room','Cal room','00:00','23:59',ARRAY[0,1,2,3,4,5,6]::smallint[],60,10)`,
      [tenantId]
    );
    const lead = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source,qualification_stars)
       VALUES($1,$2,'Lead Calendar','cal-room','qualificado','test',5) RETURNING id`,
      [tenantId, `5511${Date.now().toString().slice(-8)}`]
    )).rows[0].id;
    appointmentId = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at)
       VALUES($1,$2,'cal-room',now() + interval '2 days',now() + interval '2 days' + interval '1 hour') RETURNING id`,
      [tenantId, lead]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO scheduling_appointment_calendar_events(appointment_id,tenant_id,connection_id,calendar_id,event_id)
       VALUES($1,$2,$3,'equipe@test.local','evt_1')`,
      [appointmentId, tenantId, connectionId]
    );
    // Sem token do Meet criado nem apagado pelas operações de Calendar.
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM scheduling_google_meet_settings WHERE tenant_id=$1", [tenantId]
    )).rows[0].count).toBe(0);

    const foreign = await app.inject({
      method: "DELETE",
      url: `/scheduling/google-calendar/connections/${otherTenantConnectionId}`,
      headers: { cookie }
    });
    expect(foreign.statusCode).toBe(404);
    // Agendamento futuro ativo vinculado: 409 sem estado parcial — conexão
    // (token) e vínculo preservados.
    const blocked = await app.inject({
      method: "DELETE",
      url: `/scheduling/google-calendar/connections/${connectionId}`,
      headers: { cookie }
    });
    expect(blocked.statusCode).toBe(409);
    const kept = await pool.query<{ refresh_token_encrypted: string | null }>(
      "SELECT refresh_token_encrypted FROM scheduling_calendar_connections WHERE tenant_id=$1 AND id=$2",
      [tenantId, connectionId]
    );
    expect(kept.rows).toHaveLength(1);
    expect(kept.rows[0]!.refresh_token_encrypted).toBeTruthy();
    expect((await pool.query<{ connection_id: string | null }>(
      "SELECT connection_id FROM scheduling_appointment_calendar_events WHERE appointment_id=$1",
      [appointmentId]
    )).rows[0]?.connection_id).toBe(connectionId);

    // Histórico: agendamento no passado, outbox drenada → desconecta (200) e o
    // vínculo vira órfão por FK — o evento antigo permanece no Google
    // (consequência documentada da desconexão normal).
    await pool.query(
      "UPDATE scheduling_appointments SET start_at=now() - interval '1 hour', end_at=now() WHERE id=$1",
      [appointmentId]
    );
    // Drena a pendência que o gatilho 0189 reenfileirou ao mover o horário
    // (worker já concluiu: nenhum delete remoto fica órfão).
    await pool.query(
      "DELETE FROM scheduling_calendar_sync_outbox WHERE tenant_id=$1 AND appointment_id=$2",
      [tenantId, appointmentId]
    );
    const deleted = await app.inject({
      method: "DELETE",
      url: `/scheduling/google-calendar/connections/${connectionId}`,
      headers: { cookie }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ disconnected: true });
    const orphan = await pool.query<{ connection_id: string | null }>(
      "SELECT connection_id FROM scheduling_appointment_calendar_events WHERE appointment_id=$1",
      [appointmentId]
    );
    expect(orphan.rows[0]?.connection_id).toBeNull();
    expect((await pool.query("SELECT 1 FROM scheduling_appointments WHERE id=$1", [appointmentId])).rows).toHaveLength(1);
    const again = await app.inject({
      method: "DELETE",
      url: `/scheduling/google-calendar/connections/${connectionId}`,
      headers: { cookie }
    });
    expect(again.statusCode).toBe(404);
  }, 20_000);

  it("enforces database invariants for links, outbox and routes", async () => {
    const recreated = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_calendar_connections(tenant_id,member_id,google_email,refresh_token_encrypted)
       VALUES($1,$2,'atendente@test.local',$3) RETURNING id`,
      [tenantId, memberId, encryptSecret("rt-restored", config.DATA_ENCRYPTION_KEY)]
    )).rows[0].id;
    connectionId = recreated;
    // O vínculo órfão do teste anterior ocupa a PK (1 vínculo por agendamento).
    await pool.query("DELETE FROM scheduling_appointment_calendar_events WHERE appointment_id=$1", [appointmentId]);
    const secondLead = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source,qualification_stars)
       VALUES($1,$2,'Lead Calendar 2','cal-room','qualificado','test',5) RETURNING id`,
      [tenantId, `5512${Date.now().toString().slice(-8)}`]
    )).rows[0].id;
    const secondAppointment = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at)
       VALUES($1,$2,'cal-room',now() + interval '3 days',now() + interval '3 days' + interval '1 hour') RETURNING id`,
      [tenantId, secondLead]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO scheduling_appointment_calendar_events(appointment_id,tenant_id,connection_id,calendar_id,event_id)
       VALUES($1,$2,$3,'equipe@test.local','evt_dup')`,
      [appointmentId, tenantId, connectionId]
    );
    await expect(pool.query(
      `INSERT INTO scheduling_appointment_calendar_events(appointment_id,tenant_id,connection_id,calendar_id,event_id)
       VALUES($1,$2,$3,'equipe@test.local','evt_dup')`,
      [secondAppointment, tenantId, connectionId]
    )).rejects.toMatchObject({ code: "23505" });

    // O gatilho 0189 já enfileirou 'upsert' na criação do agendamento acima:
    // sem limpar, o INSERT manual abaixo colide no pkey da outbox.
    await pool.query(
      "DELETE FROM scheduling_calendar_sync_outbox WHERE tenant_id=$1 AND appointment_id=$2",
      [tenantId, appointmentId]
    );
    await pool.query(
      `INSERT INTO scheduling_calendar_sync_outbox(appointment_id,tenant_id,kind)
       VALUES($1,$2,'upsert')`,
      [appointmentId, tenantId]
    );
    await expect(pool.query(
      `INSERT INTO scheduling_calendar_sync_outbox(appointment_id,tenant_id,kind)
       VALUES($1,$2,'bogus')`,
      [appointmentId, tenantId]
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(
      `INSERT INTO scheduling_calendar_sync_outbox(appointment_id,tenant_id,kind)
       VALUES($1,$2,'upsert')`,
      [randomUUID(), tenantId]
    )).rejects.toMatchObject({ code: "23503" });
    // Índice de pendentes do outbox existe.
    expect((await pool.query(
      "SELECT 1 FROM pg_indexes WHERE indexname='idx_calendar_sync_outbox_pending'"
    )).rows).toHaveLength(1);

    const pipelineId = (await pool.query<{ id: string }>(
      "SELECT id FROM pipelines WHERE tenant_id=$1 AND is_default AND archived_at IS NULL LIMIT 1",
      [tenantId]
    )).rows[0].id;
    await expect(pool.query(
      `INSERT INTO scheduling_pipeline_calendar_routes(tenant_id,pipeline_id,team_id,connection_id)
       VALUES($1,$2,NULL,NULL)`,
      [tenantId, pipelineId]
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(
      `INSERT INTO scheduling_pipeline_calendar_routes(tenant_id,pipeline_id,team_id,connection_id)
       VALUES($1,$2,$3,$4)`,
      [tenantId, pipelineId, otherTenantTeamId, connectionId]
    )).rejects.toMatchObject({ code: "23514" });
    // Vínculos órfãos (connection_id NULL) não colidem no UNIQUE.
    const orphanAgain = await pool.query(
      `INSERT INTO scheduling_appointment_calendar_events(appointment_id,tenant_id,connection_id,calendar_id,event_id)
       VALUES($1,$2,NULL,'outro@test.local','evt_orphan')
       ON CONFLICT (appointment_id) DO UPDATE SET calendar_id=EXCLUDED.calendar_id, event_id=EXCLUDED.event_id`,
      [appointmentId, tenantId]
    );
    expect(orphanAgain.rowCount).toBe(1);
  }, 20_000);

  it("blocks disconnect on claimed outbox without link and on past pending delete", async () => {
    // (a) Claim em voo SEM vínculo (primeiro upsert a caminho do Google):
    // bloqueia mesmo sem link — evita evento remoto órfão.
    const lead = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source,qualification_stars)
       VALUES($1,$2,'Lead Claim','cal-room','qualificado','test',5) RETURNING id`,
      [tenantId, `5513${Date.now().toString().slice(-8)}`]
    )).rows[0].id;
    const claimedAppointment = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at)
       VALUES($1,$2,'cal-room',now() + interval '4 days',now() + interval '4 days' + interval '1 hour') RETURNING id`,
      [tenantId, lead]
    )).rows[0].id;
    // O gatilho 0189 enfileirou 'upsert': simula worker com claim em voo.
    await pool.query(
      "UPDATE scheduling_calendar_sync_outbox SET claimed_at=now(),claim_token=gen_random_uuid() WHERE tenant_id=$1 AND appointment_id=$2",
      [tenantId, claimedAppointment]
    );
    expect((await app.inject({
      method: "DELETE",
      url: `/scheduling/google-calendar/connections/${connectionId}`,
      headers: { cookie }
    })).statusCode).toBe(409);
    // Claim liberado (lease venceu/worker concluiu): futuro ativo SEM vínculo
    // não bloqueia por si só.
    await pool.query(
      "UPDATE scheduling_calendar_sync_outbox SET claimed_at=NULL,claim_token=NULL WHERE tenant_id=$1 AND appointment_id=$2",
      [tenantId, claimedAppointment]
    );
    // (b) Delete pendente para agendamento PASSADO vinculado: bloqueia fora da
    // janela futura — o worker ainda precisa do token para apagar o remoto.
    await pool.query(
      `INSERT INTO scheduling_appointment_calendar_events(appointment_id,tenant_id,connection_id,calendar_id,event_id)
       VALUES($1,$2,$3,'equipe@test.local','evt_hist')
       ON CONFLICT (appointment_id) DO UPDATE SET connection_id=EXCLUDED.connection_id`,
      [appointmentId, tenantId, connectionId]
    );
    await pool.query(
      `INSERT INTO scheduling_calendar_sync_outbox(appointment_id,tenant_id,kind,claimed_at,claim_token)
       VALUES($1,$2,'delete',NULL,NULL)
       ON CONFLICT (appointment_id,tenant_id) DO UPDATE SET kind='delete',claimed_at=NULL,claim_token=NULL`,
      [appointmentId, tenantId]
    );
    expect((await app.inject({
      method: "DELETE",
      url: `/scheduling/google-calendar/connections/${connectionId}`,
      headers: { cookie }
    })).statusCode).toBe(409);
    // Drena a outbox (worker concluiu): conexão segue viva para os testes de rota.
    await pool.query(
      "DELETE FROM scheduling_calendar_sync_outbox WHERE tenant_id=$1 AND appointment_id=ANY($2::uuid[])",
      [tenantId, [claimedAppointment, appointmentId]]
    );
  }, 20_000);

  it("blocks reconnect while future linked appointments exist, keeping old auth", async () => {
    const lead = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source,qualification_stars)
       VALUES($1,$2,'Lead Reconnect','cal-room','qualificado','test',5) RETURNING id`,
      [tenantId, `5514${Date.now().toString().slice(-8)}`]
    )).rows[0].id;
    const futureAppointment = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at)
       VALUES($1,$2,'cal-room',now() + interval '5 days',now() + interval '5 days' + interval '1 hour') RETURNING id`,
      [tenantId, lead]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO scheduling_appointment_calendar_events(appointment_id,tenant_id,connection_id,calendar_id,event_id)
       VALUES($1,$2,$3,'equipe@test.local','evt_future')`,
      [futureAppointment, tenantId, connectionId]
    );
    stubGoogleFetch({});
    const nonce = nonceFrom((await startOauth(memberId)).authorization_url);
    const reconnect = await app.inject({
      method: "GET",
      url: `/scheduling/google-calendar/oauth/callback?code=fresh-code&state=${nonce}`,
      headers: { cookie }
    });
    // Guarda 409 dentro do callback → redirect de erro, sem expor token.
    expect(String(reconnect.headers.location)).toContain("calendar_oauth=error");
    // Auth antiga preservada: o token da conexão recriada nos invariants não mudou.
    const row = (await pool.query<{ refresh_token_encrypted: string }>(
      "SELECT refresh_token_encrypted FROM scheduling_calendar_connections WHERE tenant_id=$1 AND id=$2",
      [tenantId, connectionId]
    )).rows[0];
    expect(decryptSecret(row!.refresh_token_encrypted, config.DATA_ENCRYPTION_KEY)).toBe("rt-restored");
    // Sem a troca: vínculo futuro intacto.
    expect((await pool.query<{ connection_id: string | null }>(
      "SELECT connection_id FROM scheduling_appointment_calendar_events WHERE appointment_id=$1",
      [futureAppointment]
    )).rows[0]?.connection_id).toBe(connectionId);
    // Limpeza para não vazar estado aos testes seguintes.
    await pool.query(
      "DELETE FROM scheduling_calendar_sync_outbox WHERE tenant_id=$1 AND appointment_id=$2",
      [tenantId, futureAppointment]
    );
  }, 20_000);

  it("routes CRUD validates ownership and the exactly-one target", async () => {
    const pipelineId = (await pool.query<{ id: string }>(
      "SELECT id FROM pipelines WHERE tenant_id=$1 AND is_default AND archived_at IS NULL LIMIT 1",
      [tenantId]
    )).rows[0].id;
    const teamId = (await pool.query<{ id: string }>(
      "INSERT INTO teams(tenant_id,name) VALUES($1,'Equipe Calendar') RETURNING id",
      [tenantId]
    )).rows[0].id;

    const forbidden = await app.inject({
      method: "PUT",
      url: "/scheduling/google-calendar/routes",
      headers: { cookie: operatorCookie },
      payload: { pipeline_id: pipelineId, team_id: teamId }
    });
    expect(forbidden.statusCode).toBe(403);
    expect((await app.inject({
      method: "GET",
      url: "/scheduling/google-calendar/routes",
      headers: { cookie: operatorCookie }
    })).statusCode).toBe(200);

    const unknownPipeline = await app.inject({
      method: "PUT",
      url: "/scheduling/google-calendar/routes",
      headers: { cookie },
      payload: { pipeline_id: randomUUID(), team_id: teamId }
    });
    expect(unknownPipeline.statusCode).toBe(404);
    const foreignTeam = await app.inject({
      method: "PUT",
      url: "/scheduling/google-calendar/routes",
      headers: { cookie },
      payload: { pipeline_id: pipelineId, team_id: otherTenantTeamId }
    });
    expect(foreignTeam.statusCode).toBe(404);
    const foreignConnection = await app.inject({
      method: "PUT",
      url: "/scheduling/google-calendar/routes",
      headers: { cookie },
      payload: { pipeline_id: pipelineId, connection_id: otherTenantConnectionId }
    });
    expect(foreignConnection.statusCode).toBe(404);
    const bothTargets = await app.inject({
      method: "PUT",
      url: "/scheduling/google-calendar/routes",
      headers: { cookie },
      payload: { pipeline_id: pipelineId, team_id: teamId, connection_id: connectionId }
    });
    expect(bothTargets.statusCode).toBe(400);

    const byTeam = await app.inject({
      method: "PUT",
      url: "/scheduling/google-calendar/routes",
      headers: { cookie },
      payload: { pipeline_id: pipelineId, team_id: teamId }
    });
    expect(byTeam.statusCode).toBe(200);
    expect(byTeam.json()).toEqual({ route: { pipeline_id: pipelineId, team_id: teamId, connection_id: null } });
    // Conexão sem agenda selecionada não pode receber rota (o evento ficaria
    // sem destino); com agenda selecionada, a rota é aceita.
    const savedCalendar = (await pool.query<{ calendar_id: string | null }>(
      "SELECT calendar_id FROM scheduling_calendar_connections WHERE id=$1", [connectionId]
    )).rows[0].calendar_id;
    await pool.query("UPDATE scheduling_calendar_connections SET calendar_id=NULL WHERE id=$1", [connectionId]);
    const unconfigured = await app.inject({
      method: "PUT",
      url: "/scheduling/google-calendar/routes",
      headers: { cookie },
      payload: { pipeline_id: pipelineId, connection_id: connectionId }
    });
    expect(unconfigured.statusCode).toBe(409);
    await pool.query(
      "UPDATE scheduling_calendar_connections SET calendar_id=$2 WHERE id=$1",
      [connectionId, savedCalendar ?? "cal-route-test"]
    );
    const byConnection = await app.inject({
      method: "PUT",
      url: "/scheduling/google-calendar/routes",
      headers: { cookie },
      payload: { pipeline_id: pipelineId, connection_id: connectionId }
    });
    expect(byConnection.json()).toEqual({ route: { pipeline_id: pipelineId, team_id: null, connection_id: connectionId } });
    const listed = await app.inject({
      method: "GET",
      url: "/scheduling/google-calendar/routes",
      headers: { cookie }
    });
    expect(listed.json()).toEqual({ routes: [{ pipeline_id: pipelineId, team_id: null, connection_id: connectionId }] });

    const removed = await app.inject({
      method: "DELETE",
      url: `/scheduling/google-calendar/routes/${pipelineId}`,
      headers: { cookie }
    });
    expect(removed.statusCode).toBe(200);
    const afterRemove = await app.inject({
      method: "GET",
      url: "/scheduling/google-calendar/routes",
      headers: { cookie }
    });
    expect(afterRemove.json()).toEqual({ routes: [] });
    const removeAgain = await app.inject({
      method: "DELETE",
      url: `/scheduling/google-calendar/routes/${pipelineId}`,
      headers: { cookie }
    });
    expect(removeAgain.statusCode).toBe(404);
  }, 20_000);

  it("rotação de chave: token gravado com a chave ANTERIOR lista e seleciona agenda", async () => {
    // Simula conexão criada antes da rotação: refresh token cifrado com a chave
    // anterior. Sem o keyring {current, previous} (mesmo contrato de
    // calendar-booking/calendar-sync) o decript falha e as rotas do painel quebram.
    const previousKey = "chave-anterior-calendar-32-caracteres-x";
    const original = config.DATA_ENCRYPTION_KEY_PREVIOUS;
    try {
      config.DATA_ENCRYPTION_KEY_PREVIOUS = previousKey;
      await pool.query(
        "UPDATE scheduling_calendar_connections SET refresh_token_encrypted=$2, calendar_id=NULL WHERE tenant_id=$1 AND id=$3",
        [tenantId, encryptSecret("rt-chave-anterior", previousKey), connectionId]
      );
      stubGoogleFetch({
        calendarList: [
          { items: [{ id: "primary@test.local", summary: "Agenda Atendente", timeZone: "America/Sao_Paulo", primary: true, accessRole: "owner" }] }
        ]
      });
      const listed = await app.inject({
        method: "GET",
        url: `/scheduling/google-calendar/connections/${connectionId}/calendars`,
        headers: { cookie }
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual({
        calendars: [{ id: "primary@test.local", name: "Agenda Atendente", timezone: "America/Sao_Paulo", primary: true }]
      });
      const selected = await app.inject({
        method: "PUT",
        url: `/scheduling/google-calendar/connections/${connectionId}/calendar`,
        headers: { cookie },
        payload: { calendar_id: "primary@test.local" }
      });
      expect(selected.statusCode).toBe(200);
      expect(selected.json()).toEqual({
        calendar: { id: "primary@test.local", name: "Agenda Atendente", timezone: "America/Sao_Paulo" }
      });
    } finally {
      config.DATA_ENCRYPTION_KEY_PREVIOUS = original;
    }
  }, 20_000);
});
