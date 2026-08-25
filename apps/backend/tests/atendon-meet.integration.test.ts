import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hash } from "bcryptjs";
import { jwtVerify } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { createAppointment, joinAppointment } from "../src/modules/scheduling/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const password = "atendon-meet-test-password";
let tenantId = "";
let otherTenantId = "";
let userId = "";
let otherUserId = "";
let operatorUserId = "";
let cookie = "";
let otherCookie = "";
let operatorCookie = "";
let leadId = "";
let fallbackLeadId = "";
const recordingFiles: string[] = [];

async function createWorkspaceUser(tenant: string, email: string, role = "OWNER"): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenant);
    const user = await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
      [email, await hash(password, 4)]
    );
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name=$3`,
      [tenant, user.rows[0].id, role]
    );
    await client.query("COMMIT");
    return user.rows[0].id;
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

beforeAll(async () => {
  config.MEET_ENABLED = true;
  await app.ready();
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','UTC') RETURNING id",
    [`Atendon Meet ${randomUUID()}`]
  )).rows[0].id;
  otherTenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','UTC') RETURNING id",
    [`Other Meet ${randomUUID()}`]
  )).rows[0].id;
  const email = `atendon-meet-${randomUUID()}@test.local`;
  const otherEmail = `other-meet-${randomUUID()}@test.local`;
  const operatorEmail = `operator-meet-${randomUUID()}@test.local`;
  userId = await createWorkspaceUser(tenantId, email);
  otherUserId = await createWorkspaceUser(otherTenantId, otherEmail);
  operatorUserId = await createWorkspaceUser(tenantId, operatorEmail, "OPERADOR");
  cookie = await login(email);
  otherCookie = await login(otherEmail);
  operatorCookie = await login(operatorEmail);
  await pool.query(
    `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
     VALUES($1,'workspace_admin_v1',true)
     ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=true`,
    [tenantId]
  );
  await pool.query(
    `INSERT INTO scheduling_units(
       tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity
     ) VALUES($1,'meet-room','Meet room','00:00','23:59',ARRAY[0,1,2,3,4,5,6]::smallint[],60,10)`,
    [tenantId]
  );
  const leads = await pool.query<{ id: string }>(
    `INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source,qualification_stars)
     VALUES
       ($1,$2,'Lead Meet','meet-room','qualificado','test',5),
       ($1,$3,'Lead fallback','meet-room','qualificado','test',5)
     RETURNING id`,
    [tenantId, `5511${Date.now().toString().slice(-8)}`, `5521${Date.now().toString().slice(-8)}`]
  );
  [leadId, fallbackLeadId] = leads.rows.map((row) => row.id);
});

afterAll(async () => {
  config.MEET_ENABLED = false;
  await Promise.all(recordingFiles.splice(0).map((path) => rm(path, { force: true })));
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])", [[userId, otherUserId]]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantId, otherTenantId]]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[userId, otherUserId, operatorUserId]]);
  await app.close();
  await pool.end();
});

describe("AtendON Meet integration", () => {
  it("manages tenant settings and keeps rooms and moderator tokens tenant-scoped", async () => {
    const initial = await app.inject({ method: "GET", url: "/scheduling/config/atendon-meet", headers: { cookie } });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ settings: { enabled: false, available: true } });

    const enabled = await app.inject({
      method: "PUT",
      url: "/scheduling/config/atendon-meet",
      headers: { cookie },
      payload: { enabled: true }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toEqual({ settings: { enabled: true, available: true } });

    const created = await app.inject({ method: "POST", url: "/meet/rooms", headers: { cookie }, payload: {} });
    expect(created.statusCode).toBe(201);
    const room = created.json().room as { id: string; room_name: string; code: string; url: string };
    expect(room.room_name).toMatch(/^atendon-[a-f0-9]{32}$/);
    expect(room.url).toContain(`/reuniao/${room.code}`);

    const tokenResponse = await app.inject({ method: "GET", url: `/meet/rooms/${room.id}/token`, headers: { cookie } });
    expect(tokenResponse.statusCode).toBe(200);
    expect(tokenResponse.json()).toMatchObject({ room_name: room.room_name, domain: new URL(config.MEET_PUBLIC_URL).origin });
    const verified = await jwtVerify(String(tokenResponse.json().token), new TextEncoder().encode(config.MEET_JWT_SECRET));
    expect(verified.payload).toMatchObject({ room: room.room_name, iss: config.MEET_JWT_APP_ID, aud: config.MEET_JWT_APP_ID });

    const foreign = await app.inject({ method: "GET", url: `/meet/rooms/${room.id}/token`, headers: { cookie: otherCookie } });
    expect(foreign.statusCode).toBe(404);

    const participant = await app.inject({ method: "GET", url: `/meet/join/${room.code}` });
    expect(participant.statusCode).toBe(200);
    const participantJwt = await jwtVerify(participant.json().token, new TextEncoder().encode(config.MEET_JWT_SECRET));
    expect(participantJwt.payload.context).toMatchObject({
      user: { affiliation: "member", moderator: false },
      features: { recording: false }
    });
    await pool.query("UPDATE meet_rooms SET expires_at=now() - interval '1 second' WHERE id=$1", [room.id]);
    const expiredParticipant = await app.inject({ method: "GET", url: `/meet/join/${room.code}` });
    expect(expiredParticipant.statusCode).toBe(404);
  });

  it("provisions AtendON Meet in the appointment transaction and sends logged users to the moderator page", async () => {
    await pool.query(
      `INSERT INTO scheduling_atendon_meet_settings(tenant_id,enabled)
       VALUES($1,true) ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,updated_at=now()`,
      [tenantId]
    );
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 2);
    start.setUTCHours(10, 0, 0, 0);
    const appointment = await createAppointment(tenantId, {
      lead_id: leadId,
      unidade_id: "meet-room",
      start: start.toISOString(),
      idempotency_key: `atendon-meet-${randomUUID()}`
    });
    expect(appointment).toMatchObject({
      meeting_provider: "atendon_meet",
      meeting_provisioning_status: "ready"
    });
    expect(appointment.meeting_url).toContain("/reuniao/");
    const appointmentId = String(appointment.id);
    const persisted = await pool.query<{ id: string; public_code: string }>(
      "SELECT id,public_code FROM meet_rooms WHERE tenant_id=$1 AND appointment_id=$2",
      [tenantId, appointmentId]
    );
    expect(persisted.rows).toHaveLength(1);
    expect(appointment.meeting_code).toBe(persisted.rows[0].public_code);
    const joined = await joinAppointment(tenantId, appointmentId, {
      userId,
      actorScope: "workspace"
    });
    expect(joined).toEqual({ url: new URL(`/meet/${persisted.rows[0].id}`, config.PANEL_PUBLIC_URL).toString() });
    expect((await pool.query(
      "SELECT 1 FROM scheduling_meeting_provisioning_outbox WHERE appointment_id=$1",
      [appointmentId]
    )).rows).toHaveLength(0);
  });

  it("falls back to the unchanged provider decision when AtendON Meet is disabled", async () => {
    const disabled = await app.inject({
      method: "PUT",
      url: "/scheduling/config/atendon-meet",
      headers: { cookie },
      payload: { enabled: false }
    });
    expect(disabled.statusCode).toBe(200);
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 3);
    start.setUTCHours(11, 0, 0, 0);
    const appointment = await createAppointment(tenantId, {
      lead_id: fallbackLeadId,
      unidade_id: "meet-room",
      start: start.toISOString(),
      idempotency_key: `meet-fallback-${randomUUID()}`
    });
    expect(appointment).toMatchObject({ meeting_provider: null, meeting_provisioning_status: "not_required" });
  });

  it("lists recordings only inside the active tenant", async () => {
    const room = await pool.query<{ room_name: string; appointment_id: string }>(
      `SELECT room_name,appointment_id FROM meet_rooms
       WHERE tenant_id=$1 AND appointment_id IS NOT NULL ORDER BY created_at LIMIT 1`,
      [tenantId]
    );
    const relativeFile = `${room.rows[0].room_name}/tenant-safe-${randomUUID()}.mp4`;
    const absoluteFile = join(config.MEET_RECORDINGS_DIR, relativeFile);
    recordingFiles.push(absoluteFile);
    await mkdir(dirname(absoluteFile), { recursive: true });
    await writeFile(absoluteFile, "0123456789");
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO meet_recordings(tenant_id,room_name,appointment_id,file_path,size_bytes,status)
       VALUES($1,$2,$3,$4,10,'ready') RETURNING id`,
      [tenantId, room.rows[0].room_name, room.rows[0].appointment_id, relativeFile]
    );
    const own = await app.inject({ method: "GET", url: `/meet/recordings?appointment_id=${room.rows[0].appointment_id}`, headers: { cookie } });
    expect(own.statusCode).toBe(200);
    expect(own.json().recordings).toEqual(expect.arrayContaining([
      expect.objectContaining({ file_name: relativeFile.split("/").at(-1), size_bytes: 10, status: "ready" })
    ]));
    const partialFile = await app.inject({
      method: "GET",
      url: `/meet/recordings/${inserted.rows[0].id}/file`,
      headers: { cookie, range: "bytes=2-5" }
    });
    expect(partialFile.statusCode).toBe(206);
    expect(partialFile.headers).toMatchObject({
      "accept-ranges": "bytes",
      "content-range": "bytes 2-5/10",
      "content-length": "4"
    });
    expect(partialFile.rawPayload.toString()).toBe("2345");
    const unsatisfiable = await app.inject({
      method: "GET",
      url: `/meet/recordings/${inserted.rows[0].id}/file`,
      headers: { cookie, range: "bytes=10-" }
    });
    expect(unsatisfiable.statusCode).toBe(416);
    expect(unsatisfiable.headers["content-range"]).toBe("bytes */10");
    const foreign = await app.inject({ method: "GET", url: `/meet/recordings?appointment_id=${room.rows[0].appointment_id}`, headers: { cookie: otherCookie } });
    expect(foreign.json()).toEqual({ recordings: [] });
    const foreignFile = await app.inject({
      method: "GET",
      url: `/meet/recordings/${inserted.rows[0].id}/file`,
      headers: { cookie: otherCookie }
    });
    expect(foreignFile.statusCode).toBe(404);

    const sameTenantRestricted = await app.inject({
      method: "GET",
      url: `/meet/recordings?appointment_id=${room.rows[0].appointment_id}`,
      headers: { cookie: operatorCookie }
    });
    expect(sameTenantRestricted.statusCode).toBe(200);
    expect(sameTenantRestricted.json()).toEqual({ recordings: [] });
    const sameTenantRestrictedFile = await app.inject({
      method: "GET",
      url: `/meet/recordings/${inserted.rows[0].id}/file`,
      headers: { cookie: operatorCookie }
    });
    expect(sameTenantRestrictedFile.statusCode).toBe(404);
    const appointmentRoom = await pool.query<{ id: string }>(
      "SELECT id FROM meet_rooms WHERE tenant_id=$1 AND appointment_id=$2",
      [tenantId, room.rows[0].appointment_id]
    );
    const sameTenantModerator = await app.inject({
      method: "GET",
      url: `/meet/rooms/${appointmentRoom.rows[0].id}/token`,
      headers: { cookie: operatorCookie }
    });
    expect(sameTenantModerator.statusCode).toBe(404);
    const sameTenantCreate = await app.inject({
      method: "POST",
      url: "/meet/rooms",
      headers: { cookie: operatorCookie },
      payload: { appointment_id: room.rows[0].appointment_id }
    });
    expect(sameTenantCreate.statusCode).toBe(404);

    const unsafe = await pool.query<{ id: string }>(
      `INSERT INTO meet_recordings(tenant_id,room_name,appointment_id,file_path,size_bytes,status)
       VALUES($1,$2,$3,'../outside.mp4',42,'ready') RETURNING id`,
      [tenantId, room.rows[0].room_name, room.rows[0].appointment_id]
    );
    const unsafeFile = await app.inject({
      method: "GET",
      url: `/meet/recordings/${unsafe.rows[0].id}/file`,
      headers: { cookie }
    });
    expect(unsafeFile.statusCode).toBe(404);
  });
});
