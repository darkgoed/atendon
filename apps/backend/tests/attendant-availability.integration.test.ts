import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const password = "attendant-availability-password";
let tenantId = "";
let ownerUserId = "";
let ownerMemberId = "";
let ownerCookie = "";
let operatorUserId = "";
let operatorMemberId = "";
let operatorCookie = "";
let outsiderUserId = "";
let outsiderCookie = "";
let whatsappSessionId = "";

async function login(email: string) {
  const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  return (Array.isArray(response.headers["set-cookie"])
    ? response.headers["set-cookie"][0]
    : response.headers["set-cookie"]!).split(";")[0];
}

async function createLead(label: string) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source,assigned_member_id)
     VALUES($1,$2,$3,'calls','qualificado','attendant-test',$4) RETURNING id`,
    [tenantId, `5511${Math.floor(Math.random() * 90_000_000 + 10_000_000)}`, label, ownerMemberId]
  )).rows[0].id;
}

async function insertAppointment(input: {
  label: string;
  start: string;
  status?: "confirmado" | "reagendado" | "cancelado" | "concluido" | "no_show";
  memberId?: string;
}) {
  const leadId = await createLead(input.label);
  const appointment = await pool.query<{ id: string }>(
    `INSERT INTO scheduling_appointments(
       lead_id,tenant_id,unit_id,start_at,end_at,status,assigned_member_id,assigned_at,
       commercial_outcome,outcome_next_action,outcome_next_action_at,finalized_at
     ) VALUES($1,$2,'calls',$3,$3::timestamptz + interval '30 minutes',$4,$5,now(),
       CASE WHEN $4='concluido' THEN 'follow_up' END,
       CASE WHEN $4='concluido' THEN 'Revisar resultado do teste' END,
       CASE WHEN $4='concluido' THEN $3::timestamptz + interval '1 day' END,
       CASE WHEN $4='concluido' THEN now() END)
     RETURNING id`,
    [leadId, tenantId, input.start, input.status ?? "confirmado", input.memberId ?? ownerMemberId]
  );
  return { leadId, appointmentId: appointment.rows[0].id };
}

beforeAll(async () => {
  await app.ready();
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','UTC') RETURNING id",
    [`Attendant Availability ${randomUUID()}`]
  )).rows[0].id;
  whatsappSessionId = (await pool.query<{ id: string }>(
    "INSERT INTO whatsapp_sessions(tenant_id,label,is_primary) VALUES($1,'Principal',true) RETURNING id",
    [tenantId]
  )).rows[0].id;
  const passwordHash = await hash(password, 4);
  const users = [
    `attendant-owner-${randomUUID()}@test.local`,
    `attendant-operator-${randomUUID()}@test.local`,
    `attendant-outsider-${randomUUID()}@test.local`
  ];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const ids: string[] = [];
    for (const email of users) {
      ids.push((await client.query<{ id: string }>(
        "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
        [email, passwordHash]
      )).rows[0].id);
    }
    [ownerUserId, operatorUserId, outsiderUserId] = ids;
    ownerMemberId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'
       RETURNING id`,
      [tenantId, ownerUserId]
    )).rows[0].id;
    operatorMemberId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'
       RETURNING id`,
      [tenantId, operatorUserId]
    )).rows[0].id;
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'
       RETURNING id`,
      [tenantId, outsiderUserId]
    );
    await client.query(
      `INSERT INTO scheduling_units(
         tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity
       ) VALUES($1,'calls','Calls','00:00','23:59',ARRAY[0,1,2,3,4,5,6]::smallint[],30,100)`,
      [tenantId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  [ownerCookie, operatorCookie, outsiderCookie] = await Promise.all(users.map(login));
});

beforeEach(async () => {
  await pool.query("DELETE FROM scheduling_appointments WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM conversations WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM scheduling_leads WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM system_alerts WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM scheduling_google_meet_closers WHERE tenant_id=$1", [tenantId]);
  await pool.query(
    `INSERT INTO scheduling_google_meet_closers(tenant_id,member_id,availability_status,created_at)
     VALUES
       ($1,$2,'available','2026-01-01T00:00:00Z'),
       ($1,$3,'available','2026-01-02T00:00:00Z')`,
    [tenantId, ownerMemberId, operatorMemberId]
  );
  await pool.query(
    `INSERT INTO attendant_assignment_cursors(tenant_id,last_member_id)
     VALUES($1,NULL)
     ON CONFLICT(tenant_id) DO UPDATE SET last_member_id=NULL,updated_at=now()`,
    [tenantId]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.query(
    "DELETE FROM audit_logs WHERE actor_user_id=ANY($1::uuid[])",
    [[ownerUserId, operatorUserId, outsiderUserId]]
  );
  await pool.query(
    "DELETE FROM users WHERE id=ANY($1::uuid[])",
    [[ownerUserId, operatorUserId, outsiderUserId]]
  );
  await app.close();
  await pool.end();
});

describe("attendant availability and redistribution", () => {
  it("publishes a tenant-scoped realtime signal when the agenda changes", async () => {
    const listener = await pool.connect();
    try {
      await listener.query("LISTEN atendon_realtime_changes");
      const signalPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("appointment realtime signal timeout")), 2_000);
        listener.on("notification", (notification) => {
          if (!notification.payload) return;
          const signal = JSON.parse(notification.payload) as Record<string, unknown>;
          if (signal.type !== "appointment.changed" || signal.tenantId !== tenantId) return;
          clearTimeout(timeout);
          resolve(signal);
        });
      });
      const created = await insertAppointment({
        label: "Agenda realtime",
        start: "2032-01-04T09:00:00.000Z"
      });
      await expect(signalPromise).resolves.toMatchObject({
        v: 1,
        type: "appointment.changed",
        tenantId,
        appointmentId: created.appointmentId,
        leadId: created.leadId,
        previousUserId: null,
        assignedUserId: ownerUserId
      });
    } finally {
      listener.removeAllListeners("notification");
      await listener.query("UNLISTEN atendon_realtime_changes");
      listener.release();
    }
  });

  it("uses only manually available closers and leaves the meeting unassigned when none are available", async () => {
    await pool.query(
      "UPDATE scheduling_google_meet_closers SET availability_status='unavailable' WHERE tenant_id=$1 AND member_id=$2",
      [tenantId, operatorMemberId]
    );
    await insertAppointment({ label: "Owner load 1", start: "2032-01-05T09:00:00.000Z" });
    await insertAppointment({ label: "Owner load 2", start: "2032-01-05T10:00:00.000Z" });
    const availableWinsLead = await createLead("Available wins");
    const availableWins = await app.inject({
      method: "POST",
      url: "/scheduling/appointments",
      headers: { cookie: ownerCookie },
      payload: { lead_id: availableWinsLead, unidade_id: "calls", start: "2032-01-05T11:00:00.000Z" }
    });
    expect(availableWins.statusCode).toBe(201);
    expect(availableWins.json().agendamento.responsavel).toMatchObject({
      member_id: ownerMemberId,
      availability_status: "available"
    });

    await pool.query(
      "UPDATE scheduling_google_meet_closers SET availability_status='unavailable' WHERE tenant_id=$1",
      [tenantId]
    );
    const fallbackLead = await createLead("Fallback load");
    const fallback = await app.inject({
      method: "POST",
      url: "/scheduling/appointments",
      headers: { cookie: ownerCookie },
      payload: { lead_id: fallbackLead, unidade_id: "calls", start: "2032-01-05T12:00:00.000Z" }
    });
    expect(fallback.statusCode).toBe(409);
    expect(fallback.json().error).toMatch(/closer ativo disponível/i);
    expect((await pool.query<{ assigned_member_id: string | null }>(
      "SELECT assigned_member_id FROM scheduling_leads WHERE id=$1",
      [fallbackLead]
    )).rows[0].assigned_member_id).toBe(ownerMemberId);
  });

  it("lets an attendant change only their own status while a manager can change anyone in the pool", async () => {
    expect((await app.inject({
      method: "PUT",
      url: "/scheduling/config/attendants",
      headers: { cookie: operatorCookie },
      payload: { member_ids: [ownerMemberId, operatorMemberId] }
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "PATCH",
      url: `/scheduling/attendants/${ownerMemberId}/availability`,
      headers: { cookie: operatorCookie },
      payload: { availability_status: "unavailable" }
    })).statusCode).toBe(403);

    const own = await app.inject({
      method: "PATCH",
      url: "/scheduling/attendants/me/availability",
      headers: { cookie: operatorCookie },
      payload: { availability_status: "unavailable" }
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({
      attendant: { member_id: operatorMemberId, availability_status: "unavailable" },
      alterado: true
    });
    expect((await app.inject({
      method: "PATCH",
      url: "/scheduling/attendants/me/availability",
      headers: { cookie: outsiderCookie },
      payload: { availability_status: "unavailable" }
    })).statusCode).toBe(403);

    const managed = await app.inject({
      method: "PATCH",
      url: `/scheduling/attendants/${operatorMemberId}/availability`,
      headers: { cookie: ownerCookie },
      payload: { availability_status: "available" }
    });
    expect(managed.statusCode).toBe(200);
    const configResponse = await app.inject({
      url: "/scheduling/config/attendants",
      headers: { cookie: operatorCookie }
    });
    expect(configResponse.statusCode).toBe(200);
    expect(configResponse.json().attendants).toEqual([expect.objectContaining({
      member_id: operatorMemberId,
      selected: true,
      availability_status: "available"
    })]);
    expect(configResponse.json().attendants[0]).not.toHaveProperty("active_appointments");
    expect(configResponse.json().attendants[0]).not.toHaveProperty("last_assigned_at");
    expect(configResponse.json().attendants[0]).not.toHaveProperty("availability_changed_by_user_id");
    expect(configResponse.json().attendants[0]).not.toHaveProperty("availability_changed_by_email");
  });

  it("does not redistribute any appointment when availability changes", async () => {
    const pastActive = await insertAppointment({ label: "Already started", start: "2025-01-05T09:00:00.000Z" });
    const futureActive = await insertAppointment({ label: "Future active", start: "2032-02-05T09:00:00.000Z" });
    const rescheduled = await insertAppointment({ label: "Future rescheduled", start: "2032-02-05T10:00:00.000Z", status: "reagendado" });
    const completed = await insertAppointment({ label: "Future completed", start: "2032-02-05T11:00:00.000Z", status: "concluido" });
    const cancelled = await insertAppointment({ label: "Future cancelled", start: "2032-02-05T12:00:00.000Z", status: "cancelado" });
    const noShow = await insertAppointment({ label: "Future no show", start: "2032-02-05T13:00:00.000Z", status: "no_show" });

    const response = await app.inject({
      method: "PATCH",
      url: `/scheduling/attendants/${ownerMemberId}/availability`,
      headers: { cookie: ownerCookie },
      payload: { availability_status: "unavailable" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().redistribuidos).toBe(0);

    const assignments = await pool.query<{ id: string; assigned_member_id: string }>(
      `SELECT id,assigned_member_id FROM scheduling_appointments
       WHERE id=ANY($1::uuid[])`,
      [[
        pastActive.appointmentId,
        futureActive.appointmentId,
        rescheduled.appointmentId,
        completed.appointmentId,
        cancelled.appointmentId,
        noShow.appointmentId
      ]]
    );
    const byId = Object.fromEntries(assignments.rows.map((row) => [row.id, row.assigned_member_id]));
    for (const unchanged of [pastActive, futureActive, rescheduled, completed, cancelled, noShow]) {
      expect(byId[unchanged.appointmentId]).toBe(ownerMemberId);
    }
    const leads = await pool.query<{ id: string; assigned_member_id: string }>(
      "SELECT id,assigned_member_id FROM scheduling_leads WHERE id=ANY($1::uuid[])",
      [[futureActive.leadId, rescheduled.leadId]]
    );
    expect(leads.rows.every((lead) => lead.assigned_member_id === ownerMemberId)).toBe(true);

    const receipts = await pool.query<{ user_id: string; event: string }>(
      `SELECT r.user_id,a.metadata->>'event' event
       FROM system_alerts a
       JOIN system_alert_receipts r ON r.alert_id=a.id AND r.tenant_id=a.tenant_id
       WHERE a.tenant_id=$1 ORDER BY a.created_at,a.id,r.user_id`,
      [tenantId]
    );
    expect(receipts.rows).toEqual([]);
  });

  it("preserves retained availability and redistributes removals to the remaining pool member", async () => {
    await pool.query(
      `UPDATE scheduling_google_meet_closers
       SET availability_status='unavailable',availability_changed_at=now()
       WHERE tenant_id=$1 AND member_id=$2`,
      [tenantId, operatorMemberId]
    );
    const future = await insertAppointment({ label: "Removed owner", start: "2032-02-06T09:00:00.000Z" });
    const response = await app.inject({
      method: "PUT",
      url: "/scheduling/config/attendants",
      headers: { cookie: ownerCookie },
      payload: { member_ids: [operatorMemberId] }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().redistribuidos).toBe(1);
    expect(response.json().attendants).toContainEqual(expect.objectContaining({
      member_id: operatorMemberId,
      selected: true,
      availability_status: "unavailable"
    }));
    expect((await pool.query<{ assigned_member_id: string }>(
      "SELECT assigned_member_id FROM scheduling_appointments WHERE id=$1",
      [future.appointmentId]
    )).rows[0].assigned_member_id).toBe(operatorMemberId);
    expect((await pool.query<{ assigned_member_id: string }>(
      "SELECT assigned_member_id FROM scheduling_leads WHERE id=$1",
      [future.leadId]
    )).rows[0].assigned_member_id).toBe(operatorMemberId);
  });

  it("splits existing unscheduled cases when the pool expands without moving an active appointment", async () => {
    await pool.query(
      "DELETE FROM scheduling_google_meet_closers WHERE tenant_id=$1 AND member_id=$2",
      [tenantId, operatorMemberId]
    );
    await pool.query(
      `INSERT INTO attendant_assignment_cursors(tenant_id,last_member_id)
       VALUES($1,$2)
       ON CONFLICT(tenant_id) DO UPDATE SET last_member_id=$2,updated_at=now()`,
      [tenantId, ownerMemberId]
    );
    const scheduled = await insertAppointment({
      label: "Agenda do owner preservada",
      start: "2032-02-07T09:00:00.000Z"
    });
    const unscheduledLeadIds: string[] = [];
    for (const label of ["Sem agenda 1", "Sem agenda 2", "Sem agenda 3", "Sem agenda 4"]) {
      const leadId = await createLead(label);
      unscheduledLeadIds.push(leadId);
      const phone = (await pool.query<{ phone: string }>(
        "SELECT phone FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
        [tenantId, leadId]
      )).rows[0].phone;
      await pool.query(
        `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,status,assigned_user_id,claimed_at)
         VALUES($1,$2,$3,$4,'open',$5,now())`,
        [tenantId, whatsappSessionId, phone, label, ownerUserId]
      );
    }

    const response = await app.inject({
      method: "PUT",
      url: "/scheduling/config/attendants",
      headers: { cookie: ownerCookie },
      payload: { member_ids: [ownerMemberId, operatorMemberId] }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      redistribuidos_leads: 2,
      redistribuidos_conversas: 2,
      redistribuidos_reunioes: 0
    });

    const unscheduled = await pool.query<{ assigned_member_id: string; count: number }>(
      `SELECT assigned_member_id,count(*)::int count
       FROM scheduling_leads
       WHERE tenant_id=$1 AND id=ANY($2::uuid[])
       GROUP BY assigned_member_id`,
      [tenantId, unscheduledLeadIds]
    );
    expect(Object.fromEntries(unscheduled.rows.map((row) => [row.assigned_member_id, row.count]))).toEqual({
      [ownerMemberId]: 2,
      [operatorMemberId]: 2
    });
    expect((await pool.query<{ assigned_member_id: string }>(
      "SELECT assigned_member_id FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
      [tenantId, scheduled.leadId]
    )).rows[0].assigned_member_id).toBe(ownerMemberId);
    expect((await pool.query<{ assigned_member_id: string }>(
      "SELECT assigned_member_id FROM scheduling_appointments WHERE tenant_id=$1 AND id=$2",
      [tenantId, scheduled.appointmentId]
    )).rows[0].assigned_member_id).toBe(ownerMemberId);
  });

  it("keeps case assignments while unassigning meetings when the pool becomes empty", async () => {
    await pool.query(
      "DELETE FROM scheduling_google_meet_closers WHERE tenant_id=$1 AND member_id=$2",
      [tenantId, operatorMemberId]
    );
    const single = await insertAppointment({ label: "Single attendant", start: "2032-03-05T09:00:00.000Z" });
    const unavailable = await app.inject({
      method: "PATCH",
      url: "/scheduling/attendants/me/availability",
      headers: { cookie: ownerCookie },
      payload: { availability_status: "unavailable" }
    });
    expect(unavailable.statusCode).toBe(200);
    expect(unavailable.json().redistribuidos).toBe(0);
    expect((await pool.query<{ assigned_member_id: string }>(
      "SELECT assigned_member_id FROM scheduling_appointments WHERE id=$1",
      [single.appointmentId]
    )).rows[0].assigned_member_id).toBe(ownerMemberId);

    const removed = await app.inject({
      method: "PUT",
      url: "/scheduling/config/attendants",
      headers: { cookie: ownerCookie },
      payload: { member_ids: [] }
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().redistribuidos).toBe(1);
    expect((await pool.query<{ assigned_member_id: string | null }>(
      "SELECT assigned_member_id FROM scheduling_appointments WHERE id=$1",
      [single.appointmentId]
    )).rows[0].assigned_member_id).toBeNull();
    expect((await pool.query<{ assigned_member_id: string | null }>(
      "SELECT assigned_member_id FROM scheduling_leads WHERE id=$1",
      [single.leadId]
    )).rows[0].assigned_member_id).toBe(ownerMemberId);

    const leadId = await createLead("Unassigned");
    const created = await app.inject({
      method: "POST",
      url: "/scheduling/appointments",
      headers: { cookie: ownerCookie },
      payload: { lead_id: leadId, unidade_id: "calls", start: "2032-03-05T10:00:00.000Z" }
    });
    expect(created.statusCode).toBe(409);
    expect(created.json().error).toMatch(/closer ativo disponível/i);
    expect((await pool.query<{ assigned_member_id: string | null }>(
      "SELECT assigned_member_id FROM scheduling_leads WHERE id=$1",
      [leadId]
    )).rows[0].assigned_member_id).toBe(ownerMemberId);
  });

  it("synchronizes a manual lead assignment to its active appointment even when the target is unavailable", async () => {
    await pool.query(
      "UPDATE scheduling_google_meet_closers SET availability_status='unavailable' WHERE tenant_id=$1 AND member_id=$2",
      [tenantId, operatorMemberId]
    );
    const { leadId, appointmentId } = await insertAppointment({
      label: "Manual assignment",
      start: "2032-04-05T09:00:00.000Z"
    });
    const response = await app.inject({
      method: "PATCH",
      url: `/scheduling/leads/${leadId}/follow-up`,
      headers: { cookie: ownerCookie },
      payload: { responsavel_member_id: operatorMemberId }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().follow_up.responsavel).toMatchObject({
      member_id: operatorMemberId,
      availability_status: "unavailable"
    });
    const synchronized = await pool.query<{ lead_member: string; appointment_member: string }>(
      `SELECT l.assigned_member_id lead_member,a.assigned_member_id appointment_member
       FROM scheduling_leads l JOIN scheduling_appointments a ON a.lead_id=l.id AND a.tenant_id=l.tenant_id
       WHERE l.id=$1 AND a.id=$2`,
      [leadId, appointmentId]
    );
    expect(synchronized.rows[0]).toEqual({
      lead_member: operatorMemberId,
      appointment_member: operatorMemberId
    });
    const event = await pool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM scheduling_lead_events
       WHERE tenant_id=$1 AND lead_id=$2 AND event_type='acompanhamento_atualizado'
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, leadId]
    );
    expect(event.rows[0].details).toMatchObject({
      motivo: "atribuicao_manual",
      anterior: { responsavel_member_id: ownerMemberId },
      atual: { responsavel_member_id: operatorMemberId }
    });
  });

  it("keeps conversation-only support members selectable for human service", async () => {
    const role = await pool.query<{ role_id: string }>(
      "SELECT role_id FROM workspace_members WHERE workspace_id=$1 AND id=$2",
      [tenantId, operatorMemberId]
    );
    await pool.query(
      "DELETE FROM workspace_role_permissions WHERE role_id=$1 AND permission_key='leads.read'",
      [role.rows[0].role_id]
    );
    try {
      const configResponse = await app.inject({
        url: "/scheduling/config/attendants",
        headers: { cookie: ownerCookie }
      });
      expect(configResponse.statusCode).toBe(200);
      expect(configResponse.json().attendants).toContainEqual(expect.objectContaining({
        member_id: operatorMemberId,
        selected: true
      }));

      const saved = await app.inject({
        method: "PUT",
        url: "/scheduling/config/attendants",
        headers: { cookie: ownerCookie },
        payload: { member_ids: [ownerMemberId, operatorMemberId] }
      });
      expect(saved.statusCode).toBe(200);
      const assignees = await app.inject({
        url: "/conversations/assignees",
        headers: { cookie: ownerCookie }
      });
      expect(assignees.statusCode).toBe(200);
      expect(assignees.json().assignees).toContainEqual(expect.objectContaining({ id: operatorUserId }));
    } finally {
      await pool.query(
        `INSERT INTO workspace_role_permissions(role_id,permission_key)
         VALUES($1,'leads.read') ON CONFLICT DO NOTHING`,
        [role.rows[0].role_id]
      );
    }
  });
});
