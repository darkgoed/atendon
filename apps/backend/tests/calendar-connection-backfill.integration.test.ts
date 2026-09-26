import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { encryptSecret } from "../src/modules/ai-router/secret-box.js";

// Backfill do outbox via rotas de conexão/rota (complemento de calendar-connections):
// PATCH buffer, metadados sem segredo e o enfileiramento atômico de agendamentos
// futuros ativos quando a agenda selecionada ou a rota mudam. 0189 enfileira
// mutações do PRÓPRIO agendamento; aqui exercita o enfileiramento das ROTAS.
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const password = "calendar-backfill-password";
let tenantId = "";
let otherTenantId = "";
let userId = "";
let otherUserId = "";
let memberId = "";
let otherMemberId = "";
let cookie = "";
let connectionId = "";
let otherConnectionId = "";
let routeConnectionId = "";
let apMember = "";
let apRouted = "";
let apCanceled = "";
let apPast = "";
let apDone = "";

type OutboxRow = {
  appointment_id: string;
  kind: string;
  available_at: Date;
  attempts: number;
  last_error: string | null;
  claimed_at: Date | null;
  claim_token: string | null;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Google falso: refresh de token + calendarList com minAccessRole já filtrado.
function stubGoogleFetch(): void {
  vi.stubGlobal("fetch", (async (input: string | URL) => {
    const url = String(input);
    if (url === config.GOOGLE_MEET_TOKEN_URL) {
      return jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
    }
    if (url.includes("/calendar/v3/users/me/calendarList")) {
      return jsonResponse({
        items: [
          { id: "primary@test.local", summary: "Agenda Primária", timeZone: "America/Sao_Paulo", primary: true, accessRole: "owner" },
          { id: "equipe@test.local", summary: "Agenda Equipe", timeZone: "UTC", accessRole: "writer" },
          { id: "leitor@test.local", summary: "Somente leitura", accessRole: "reader" }
        ]
      });
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

let leadSequence = 0;
async function seedAppointment(input: { status: string; assigned: string | null; daysFromNow: number; outcome?: string; saleValue?: string }): Promise<string> {
  leadSequence += 1;
  const phone = `5511${String(Date.now() % 10_000_000).padStart(7, "0")}${leadSequence}`;
  const lead = (await pool.query<{ id: string }>(
    `INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source,qualification_stars)
     VALUES($1,$2,'Lead Backfill','cal-backfill','agendado','test',5) RETURNING id`,
    [tenantId, phone]
  )).rows[0].id;
  const start = new Date(Date.now() + input.daysFromNow * 86_400_000).toISOString();
  return (await pool.query<{ id: string }>(
    `INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at,status,assigned_member_id,assigned_at,commercial_outcome,sale_value)
     VALUES($1,$2,'cal-backfill',$3::timestamptz,$3::timestamptz + interval '60 minutes',$4,$5,$6,$7,$8)
     RETURNING id`,
    [tenantId, lead, start, input.status, input.assigned, input.assigned ? new Date().toISOString() : null, input.outcome ?? null, input.saleValue ?? null]
  )).rows[0].id;
}

async function clearOutbox(): Promise<void> {
  await pool.query("DELETE FROM scheduling_calendar_sync_outbox WHERE tenant_id=$1", [tenantId]);
}

async function outboxRows(): Promise<OutboxRow[]> {
  return (await pool.query<OutboxRow>(
    `SELECT appointment_id,kind,available_at,attempts,last_error,claimed_at,claim_token
     FROM scheduling_calendar_sync_outbox WHERE tenant_id=$1 ORDER BY appointment_id`,
    [tenantId]
  )).rows;
}

function idsOf(rows: OutboxRow[]): string[] {
  return rows.map((row) => row.appointment_id).sort();
}

type InjectResponse = Awaited<ReturnType<typeof app.inject>>;

async function putCalendar(calendarId: string): Promise<InjectResponse> {
  return app.inject({
    method: "PUT",
    url: `/scheduling/google-calendar/connections/${connectionId}/calendar`,
    headers: { cookie },
    payload: { calendar_id: calendarId }
  });
}

async function putRoute(body: Record<string, unknown>): Promise<InjectResponse> {
  return app.inject({
    method: "PUT",
    url: "/scheduling/google-calendar/routes",
    headers: { cookie },
    payload: body
  });
}

beforeAll(async () => {
  config.GOOGLE_MEET_OAUTH_CLIENT_ID = "calendar-backfill-client";
  config.GOOGLE_MEET_OAUTH_CLIENT_SECRET = "calendar-backfill-secret";
  await app.ready();
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','UTC') RETURNING id",
    [`Calendar Backfill A ${randomUUID()}`]
  )).rows[0].id;
  otherTenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','UTC') RETURNING id",
    [`Calendar Backfill B ${randomUUID()}`]
  )).rows[0].id;
  const owner = await createWorkspaceUser(tenantId, `backfill-owner-${randomUUID()}@test.local`);
  userId = owner.userId;
  memberId = owner.memberId;
  const colleague = await createWorkspaceUser(tenantId, `backfill-colleague-${randomUUID()}@test.local`, "OPERADOR");
  otherMemberId = colleague.memberId;
  const otherOwner = await createWorkspaceUser(otherTenantId, `backfill-other-${randomUUID()}@test.local`);
  otherUserId = otherOwner.userId;
  cookie = await login((await pool.query<{ email: string }>("SELECT email FROM users WHERE id=$1", [userId])).rows[0].email);
  await pool.query(
    `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity)
     VALUES($1,'cal-backfill','Cal backfill','00:00','23:59',ARRAY[0,1,2,3,4,5,6]::smallint[],60,10)`,
    [tenantId]
  );
  connectionId = (await pool.query<{ id: string }>(
    `INSERT INTO scheduling_calendar_connections(tenant_id,member_id,google_email,refresh_token_encrypted)
     VALUES($1,$2,'atendente@test.local',$3) RETURNING id`,
    [tenantId, memberId, encryptSecret("rt-backfill", config.DATA_ENCRYPTION_KEY)]
  )).rows[0].id;
  otherConnectionId = (await pool.query<{ id: string }>(
    `INSERT INTO scheduling_calendar_connections(tenant_id,member_id,google_email,refresh_token_encrypted)
     VALUES($1,$2,'outra@conta.local',$3) RETURNING id`,
    [otherTenantId, otherOwner.memberId, encryptSecret("rt-other", config.DATA_ENCRYPTION_KEY)]
  )).rows[0].id;
  // Conexão SEM agenda selecionada, dedicada ao teste de rota (nunca configurada).
  routeConnectionId = (await pool.query<{ id: string }>(
    `INSERT INTO scheduling_calendar_connections(tenant_id,member_id,google_email,refresh_token_encrypted)
     VALUES($1,$2,'rota@test.local',$3) RETURNING id`,
    [tenantId, otherMemberId, encryptSecret("rt-rota", config.DATA_ENCRYPTION_KEY)]
  )).rows[0].id;
  // Agendamentos do pipeline padrão (leads 'agendado' caem no estágio padrão):
  apMember = await seedAppointment({ status: "confirmado", assigned: memberId, daysFromNow: 2 });
  apRouted = await seedAppointment({ status: "reagendado", assigned: otherMemberId, daysFromNow: 2 });
  apCanceled = await seedAppointment({ status: "cancelado", assigned: memberId, daysFromNow: 3 });
  apPast = await seedAppointment({ status: "confirmado", assigned: memberId, daysFromNow: -2 });
  apDone = await seedAppointment({ status: "concluido", assigned: memberId, daysFromNow: 3, outcome: "fechado", saleValue: "1000" });
  // O gatilho 0189 enfileirou na criação; os testes abaixo partem da outbox limpa.
  await clearOutbox();
});

afterAll(async () => {
  config.GOOGLE_MEET_OAUTH_CLIENT_ID = undefined;
  config.GOOGLE_MEET_OAUTH_CLIENT_SECRET = undefined;
  vi.unstubAllGlobals();
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantId, otherTenantId]]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[userId, otherUserId]]);
  await app.close();
  await pool.end();
});

describe("Google Calendar connection buffer and sync backfill", () => {
  it("PATCH buffer accepts 0..240, rejects invalid input and is tenant-scoped", async () => {
    const foreign = await app.inject({
      method: "PATCH",
      url: `/scheduling/google-calendar/connections/${otherConnectionId}/buffer`,
      headers: { cookie },
      payload: { buffer_minutes: 30 }
    });
    expect(foreign.statusCode).toBe(404);
    const unknown = await app.inject({
      method: "PATCH",
      url: `/scheduling/google-calendar/connections/${randomUUID()}/buffer`,
      headers: { cookie },
      payload: { buffer_minutes: 30 }
    });
    expect(unknown.statusCode).toBe(404);
    const foreignRead = await app.inject({
      method: "GET",
      url: `/scheduling/google-calendar/connections/${otherConnectionId}`,
      headers: { cookie }
    });
    expect(foreignRead.statusCode).toBe(404);

    for (const invalid of [-1, 241, 0.5, "abc"]) {
      const rejected = await app.inject({
        method: "PATCH",
        url: `/scheduling/google-calendar/connections/${connectionId}/buffer`,
        headers: { cookie },
        payload: { buffer_minutes: invalid }
      });
      expect(rejected.statusCode).toBe(400);
    }
    const extraField = await app.inject({
      method: "PATCH",
      url: `/scheduling/google-calendar/connections/${connectionId}/buffer`,
      headers: { cookie },
      payload: { buffer_minutes: 10, extra: true }
    });
    expect(extraField.statusCode).toBe(400);

    const off = await app.inject({
      method: "PATCH",
      url: `/scheduling/google-calendar/connections/${connectionId}/buffer`,
      headers: { cookie },
      payload: { buffer_minutes: 0 }
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ buffer_minutes: 0 });
    const max = await app.inject({
      method: "PATCH",
      url: `/scheduling/google-calendar/connections/${connectionId}/buffer`,
      headers: { cookie },
      payload: { buffer_minutes: 240 }
    });
    expect(max.statusCode).toBe(200);
    expect(max.json()).toEqual({ buffer_minutes: 240 });

    // Buffer muda só a janela de freeBusy: nunca enfileira nada na outbox.
    expect(idsOf(await outboxRows())).toEqual([]);

    // Metadados do GET: buffer persistido e segredo sempre fora do payload.
    const single = await app.inject({
      method: "GET",
      url: `/scheduling/google-calendar/connections/${connectionId}`,
      headers: { cookie }
    });
    expect(single.statusCode).toBe(200);
    const body = single.json() as { connection: Record<string, unknown> };
    expect(body.connection).toMatchObject({
      id: connectionId,
      member_id: memberId,
      email: "atendente@test.local",
      calendar_id: null,
      buffer_minutes: 240,
      configured: false
    });
    expect(typeof body.connection.connected_at).toBe("string");
    expect(single.body).not.toContain("refresh_token");
    expect(single.body).not.toContain("rt-backfill");
  }, 20_000);

  it("selecting a calendar enqueues future active appointments atomically", async () => {
    await clearOutbox();
    stubGoogleFetch();
    // Falha ANTES da transação: nem agenda nova nem outbox (sem estado parcial).
    const invalid = await putCalendar("nao-existe@test.local");
    expect(invalid.statusCode).toBe(400);
    expect((await pool.query<{ calendar_id: string | null }>(
      "SELECT calendar_id FROM scheduling_calendar_connections WHERE tenant_id=$1 AND id=$2",
      [tenantId, connectionId]
    )).rows[0].calendar_id).toBeNull();
    expect(idsOf(await outboxRows())).toEqual([]);

    const ok = await putCalendar("equipe@test.local");
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ calendar: { id: "equipe@test.local", name: "Agenda Equipe", timezone: "UTC" } });

    // Mesma transação do UPDATE da conexão: sem rota, só o agendamento do dono
    // da conexão (futuro e ativo) é afetado.
    const rows = await outboxRows();
    expect(idsOf(rows)).toEqual([apMember].sort());
    expect(rows[0]).toMatchObject({ kind: "upsert", attempts: 0, last_error: null, claimed_at: null });
    // 0190: enfileiramento novo nasce sem token de posse.
    expect(rows[0].claim_token).toBeNull();
  }, 20_000);

  it("re-selecting the same calendar is a no-op for the outbox", async () => {
    stubGoogleFetch();
    const before = await outboxRows();
    expect(idsOf(before)).toEqual([apMember]);
    const ok = await putCalendar("equipe@test.local");
    expect(ok.statusCode).toBe(200);
    expect(JSON.stringify(await outboxRows())).toBe(JSON.stringify(before));
  }, 20_000);

  it("changing the calendar re-enqueues and preserves an in-flight claim", async () => {
    stubGoogleFetch();
    const claimed = (await pool.query<{ claim_token: string; claimed_at: Date; available_at: Date }>(
      `UPDATE scheduling_calendar_sync_outbox
       SET claimed_at=now(),claim_token=gen_random_uuid(),attempts=1,last_error='tentativa em voo'
       WHERE tenant_id=$1 AND appointment_id=$2
       RETURNING claim_token,claimed_at,available_at`,
      [tenantId, apMember]
    )).rows[0];
    expect(claimed).toBeDefined();

    const ok = await putCalendar("primary@test.local");
    expect(ok.statusCode).toBe(200);
    const rows = await outboxRows();
    expect(idsOf(rows)).toEqual([apMember]);
    const memberRow = rows.find((row) => row.appointment_id === apMember)!;
    // Mutação durante sync em voo NÃO limpa o claim (mesma semântica do 0189):
    // claimed_at/claim_token intactos; tentativa/erro zerados e disponibilidade renovada.
    expect(memberRow.claimed_at?.getTime()).toBe(claimed.claimed_at.getTime());
    expect(memberRow.claim_token).toBe(claimed.claim_token);
    expect(memberRow).toMatchObject({ kind: "upsert", attempts: 0, last_error: null });
    expect(memberRow.available_at.getTime()).toBeGreaterThanOrEqual(claimed.available_at.getTime());
  }, 20_000);

  it("route changes enqueue the pipeline's future active appointments and no-op keeps them", async () => {
    const pipelineId = (await pool.query<{ id: string }>(
      "SELECT id FROM pipelines WHERE tenant_id=$1 AND is_default AND archived_at IS NULL LIMIT 1",
      [tenantId]
    )).rows[0].id;
    const teamId = (await pool.query<{ id: string }>(
      "INSERT INTO teams(tenant_id,name) VALUES($1,'Equipe Backfill') RETURNING id",
      [tenantId]
    )).rows[0].id;

    await clearOutbox();
    // Rota para a conexão: alcança TAMBÉM o agendamento de outro atendente.
    const byConnection = await putRoute({ pipeline_id: pipelineId, connection_id: connectionId });
    expect(byConnection.statusCode).toBe(200);
    expect(byConnection.json()).toEqual({ route: { pipeline_id: pipelineId, team_id: null, connection_id: connectionId } });
    let rows = await outboxRows();
    expect(idsOf(rows)).toEqual([apMember, apRouted].sort());
    for (const row of rows) {
      expect(row).toMatchObject({ kind: "upsert", attempts: 0, last_error: null, claimed_at: null });
    }

    // Salvar a MESMA rota é no-op: nada reenfileirado.
    const before = JSON.stringify(rows);
    const repeat = await putRoute({ pipeline_id: pipelineId, connection_id: connectionId });
    expect(repeat.statusCode).toBe(200);
    expect(JSON.stringify(await outboxRows())).toBe(before);

    // Mudança para equipe reenfileira o pipeline inteiro (mesmo conjunto).
    const byTeam = await putRoute({ pipeline_id: pipelineId, team_id: teamId });
    expect(byTeam.statusCode).toBe(200);
    expect(byTeam.json()).toEqual({ route: { pipeline_id: pipelineId, team_id: teamId, connection_id: null } });
    rows = await outboxRows();
    expect(idsOf(rows)).toEqual([apMember, apRouted].sort());

    // Remover a rota devolve o destino ao responsável: reenfileira de novo.
    const removed = await app.inject({
      method: "DELETE",
      url: `/scheduling/google-calendar/routes/${pipelineId}`,
      headers: { cookie }
    });
    expect(removed.statusCode).toBe(200);
    expect(idsOf(await outboxRows())).toEqual([apMember, apRouted].sort());
    const removeAgain = await app.inject({
      method: "DELETE",
      url: `/scheduling/google-calendar/routes/${pipelineId}`,
      headers: { cookie }
    });
    expect(removeAgain.statusCode).toBe(404);

    // Cancelado, passado e concluído nunca entram (filtro de estado ativo).
    const all = idsOf(await outboxRows());
    expect(all).not.toContain(apCanceled);
    expect(all).not.toContain(apPast);
    expect(all).not.toContain(apDone);
  }, 20_000);

  it("PUT route rejects a connection without a selected calendar and accepts it after selection", async () => {
    const pipelineId = (await pool.query<{ id: string }>(
      "SELECT id FROM pipelines WHERE tenant_id=$1 AND is_default AND archived_at IS NULL LIMIT 1",
      [tenantId]
    )).rows[0].id;
    const unknown = await putRoute({ pipeline_id: pipelineId, connection_id: randomUUID() });
    expect(unknown.statusCode).toBe(404);

    // Conexão sem agenda (ex.: recém-reconectada) não pode virar destino:
    // o pipeline ficaria sem rota observável. 409 e NADA gravado.
    const rejected = await putRoute({ pipeline_id: pipelineId, connection_id: routeConnectionId });
    expect(rejected.statusCode).toBe(409);
    expect((await pool.query<{ n: number }>(
      "SELECT count(*)::int n FROM scheduling_pipeline_calendar_routes WHERE tenant_id=$1 AND pipeline_id=$2",
      [tenantId, pipelineId]
    )).rows[0].n).toBe(0);

    // O 409 é só sobre estar sem agenda: selecionada, o mesmo PUT passa.
    stubGoogleFetch();
    const select = await app.inject({
      method: "PUT",
      url: `/scheduling/google-calendar/connections/${routeConnectionId}/calendar`,
      headers: { cookie },
      payload: { calendar_id: "equipe@test.local" }
    });
    expect(select.statusCode).toBe(200);
    const ok = await putRoute({ pipeline_id: pipelineId, connection_id: routeConnectionId });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ route: { pipeline_id: pipelineId, team_id: null, connection_id: routeConnectionId } });

    // Sem estado residual de rota para o restante da suíte.
    await app.inject({ method: "DELETE", url: `/scheduling/google-calendar/routes/${pipelineId}`, headers: { cookie } });
  }, 20_000);

  it("OAuth callback does not create a connection for a member deactivated during the flow", async () => {
    const { userId: oauthUserId, memberId: oauthMemberId } = await createWorkspaceUser(
      tenantId, `oauth-member-${randomUUID()}@test.local`, "OPERADOR"
    );
    stubGoogleFetch();
    const start = await app.inject({
      method: "GET",
      url: `/scheduling/google-calendar/oauth/start?member_id=${oauthMemberId}`,
      headers: { cookie }
    });
    expect(start.statusCode).toBe(200);
    const nonce = (await pool.query<{ nonce: string }>(
      "SELECT nonce FROM scheduling_calendar_oauth_states WHERE tenant_id=$1 AND member_id=$2 AND used_at IS NULL",
      [tenantId, oauthMemberId]
    )).rows[0].nonce;

    // O membro é desativado enquanto o OAuth fica na tela do Google.
    await pool.query("UPDATE workspace_members SET status='suspended' WHERE id=$1", [oauthMemberId]);

    const callback = await app.inject({
      method: "GET",
      url: `/scheduling/google-calendar/oauth/callback?code=oauth-code&state=${encodeURIComponent(nonce)}`,
      headers: { cookie }
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain("calendar_oauth=error");
    // Nonce consumido mesmo no erro (one-time use).
    expect((await pool.query<{ n: number }>(
      "SELECT count(*)::int n FROM scheduling_calendar_oauth_states WHERE nonce=$1 AND used_at IS NOT NULL",
      [nonce]
    )).rows[0].n).toBe(1);
    // Nenhuma conexão criada para membro inativo.
    expect((await pool.query<{ n: number }>(
      "SELECT count(*)::int n FROM scheduling_calendar_connections WHERE tenant_id=$1 AND member_id=$2",
      [tenantId, oauthMemberId]
    )).rows[0].n).toBe(0);

    await pool.query("DELETE FROM users WHERE id=$1", [oauthUserId]);
  }, 20_000);
});
