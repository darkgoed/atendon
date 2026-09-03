import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { SchedulingNotificationRepository } from "../src/modules/scheduling/notification-repository.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
let tenantId = "";
let cookie = "";
let operatorCookie = "";
let memberA = "";
let memberB = "";
let userA = "";
let userB = "";
let sessionId = "";
let sequence = 910_000_000;
const phone = () => `5511${++sequence}`;

beforeAll(async () => {
  await app.ready();
  tenantId = (await pool.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Assignees ${randomUUID()}`])).rows[0].id;
  const ownerEmail = `assignee-owner-${randomUUID()}@test.local`;
  const operatorEmail = `closer-a-${randomUUID()}@test.local`;
  const password = "assignee-password";
  const passwordHash = await hash(password, 4);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const roles = await client.query<{ id: string; name: string }>("SELECT id,name FROM workspace_roles WHERE workspace_id=$1", [tenantId]);
    const ownerRole = roles.rows.find((role) => role.name === "OWNER")!.id;
    const operatorRole = roles.rows.find((role) => role.name === "OPERADOR")!.id;
    const owner = await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [ownerEmail, passwordHash]);
    await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())", [tenantId, owner.rows[0].id, ownerRole]);
    for (const label of ["A", "B"]) {
      const email = label === "A" ? operatorEmail : `closer-b-${randomUUID()}@test.local`;
      const user = await client.query<{ id: string }>("INSERT INTO users(email,name,password_hash,status) VALUES($1,$2,$3,'active') RETURNING id", [email, `Closer ${label}`, passwordHash]);
      const member = await client.query<{ id: string }>("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now()) RETURNING id", [tenantId, user.rows[0].id, operatorRole]);
      await client.query("INSERT INTO scheduling_google_meet_closers(tenant_id,member_id) VALUES($1,$2)", [tenantId, member.rows[0].id]);
      if (label === "A") { memberA = member.rows[0].id; userA = user.rows[0].id; } else { memberB = member.rows[0].id; userB = user.rows[0].id; }
    }
    await client.query("INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,simultaneous_capacity) VALUES($1,'unit','Unit','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[],3)", [tenantId]);
    sessionId = (await client.query<{ id: string }>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantId])).rows[0].id;
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: ownerEmail, password } });
  cookie = (Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"][0] : login.headers["set-cookie"]!).split(";")[0];
  const operatorLogin = await app.inject({ method: "POST", url: "/auth/login", payload: { email: operatorEmail, password } });
  operatorCookie = (Array.isArray(operatorLogin.headers["set-cookie"]) ? operatorLogin.headers["set-cookie"][0] : operatorLogin.headers["set-cookie"]!).split(";")[0];
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await app.close();
  await pool.end();
});

async function caseFor(memberId = memberA) {
  const contactPhone = phone();
  const lead = await pool.query<{ id: string }>("INSERT INTO scheduling_leads(tenant_id,phone,name,source,assigned_member_id) VALUES($1,$2,'Lead','test',$3) RETURNING id", [tenantId, contactPhone, memberId]);
  const userId = memberId === memberA ? userA : userB;
  const conversation = await pool.query<{ id: string }>("INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,assigned_user_id,ai_active) VALUES($1,$2,$3,'Lead',$4,true) RETURNING id", [tenantId, sessionId, contactPhone, userId]);
  return { leadId: lead.rows[0].id, conversationId: conversation.rows[0].id, phone: contactPhone };
}

describe("appointment assignees", () => {
  it("remove um agendamento e seu outbox de confirmação", async () => {
    const contactPhone = phone();
    const lead = (await pool.query<{ id: string }>(
      "INSERT INTO scheduling_leads(tenant_id,phone,name,source) VALUES($1,$2,'Outbox lead','test') RETURNING id",
      [tenantId, contactPhone]
    )).rows[0].id;
    const appointment = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_appointments(lead_id,tenant_id,unit_id,start_at,end_at,status)
       VALUES($1,$2,'unit',now()+interval '1 day',now()+interval '1 day 1 hour','confirmado') RETURNING id`,
      [lead, tenantId]
    )).rows[0].id;
    const conversation = (await pool.query<{ id: string }>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name)
       VALUES($1,$2,$3,'Outbox lead') RETURNING id`, [tenantId, sessionId, contactPhone]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO scheduling_meeting_confirmation_outbox(
         tenant_id,appointment_id,conversation_id,session_id,contact_phone,moment,message_text
       ) VALUES($1,$2,$3,$4,$5,'pos_agendamento','Confirme')`,
      [tenantId, appointment, conversation, sessionId, contactPhone]
    );

    const response = await app.inject({
      method: "DELETE",
      url: `/scheduling/appointments/${appointment}/remove`,
      headers: { cookie }
    });

    expect(response.statusCode).toBe(200);
    expect((await pool.query("SELECT 1 FROM scheduling_appointments WHERE id=$1", [appointment])).rows).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM scheduling_meeting_confirmation_outbox WHERE appointment_id=$1", [appointment])).rows).toHaveLength(0);
  });

  it("keeps a new agenda contact with the closer who created it", async () => {
    const contactPhone = phone();
    const createdLead = await app.inject({
      method: "POST",
      url: "/scheduling/leads",
      headers: { cookie: operatorCookie },
      payload: { telefone: contactPhone, nome: "Contato próprio do closer", origem: "agenda_manual" }
    });
    expect(createdLead.statusCode).toBe(201);
    const leadId = createdLead.json().lead.id as string;
    expect((await pool.query<{ assigned_member_id: string | null }>(
      "SELECT assigned_member_id FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
      [tenantId, leadId]
    )).rows[0].assigned_member_id).toBe(memberA);
    const conversationId = (await pool.query<{ id: string }>(
      `INSERT INTO conversations(
         tenant_id,session_id,contact_phone,contact_name,assigned_user_id,ai_active,last_message_at
       ) VALUES($1,$2,$3,'Contato próprio do closer',$4,true,now()) RETURNING id`,
      [tenantId, sessionId, contactPhone, userA]
    )).rows[0].id;
    const agentMessageId = (await pool.query<{ id: string }>(
      "INSERT INTO messages(conversation_id,sender,content) VALUES($1,'agent','Posso te explicar melhor?') RETURNING id",
      [conversationId]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO ai_follow_up_schedules(
         conversation_id,tenant_id,last_agent_message_id,follow_up_count,status,next_run_at
       ) VALUES($1,$2,$3,1,'scheduled',now()+interval '1 hour')`,
      [conversationId, tenantId, agentMessageId]
    );
    const pipelineLead = await app.inject({
      url: `/scheduling/leads?busca=${contactPhone}`,
      headers: { cookie: operatorCookie }
    });
    expect(pipelineLead.statusCode).toBe(200);
    expect(pipelineLead.json().leads).toEqual([
      expect.objectContaining({
        id: leadId,
        ai_follow_up: expect.objectContaining({ count: 1, status: "scheduled" })
      })
    ]);

    const appointment = await app.inject({
      method: "POST",
      url: "/scheduling/appointments",
      headers: { cookie: operatorCookie },
      payload: {
        lead_id: leadId,
        unidade_id: "unit",
        start: "2030-08-05T16:00:00.000Z",
        end: "2030-08-05T16:30:00.000Z"
      }
    });
    expect(appointment.statusCode).toBe(201);
    expect(appointment.json().agendamento.responsavel.member_id).toBe(memberA);
    expect((await pool.query<{ assigned_member_id: string | null; closer_member_id: string | null }>(
      "SELECT assigned_member_id,closer_member_id FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
      [tenantId, leadId]
    )).rows[0]).toEqual({ assigned_member_id: memberA, closer_member_id: memberA });
  });

  it("does not allow an operator to choose another closer", async () => {
    const current = await caseFor(memberA);
    const response = await app.inject({ method: "POST", url: "/scheduling/appointments", headers: { cookie: operatorCookie }, payload: {
      lead_id: current.leadId, unidade_id: "unit", start: "2030-08-05T09:00:00.000Z", end: "2030-08-05T09:30:00.000Z", assigned_member_id: memberB
    } });
    expect(response.statusCode).toBe(403);
  });

  it("creates and reassigns explicitly, blocks unavailable/conflicting closers and keeps commercial AI paused", async () => {
    const current = await caseFor();
    const created = await app.inject({ method: "POST", url: "/scheduling/appointments", headers: { cookie }, payload: {
      lead_id: current.leadId, unidade_id: "unit", start: "2030-08-05T10:00:00.000Z", end: "2030-08-05T10:30:00.000Z", assigned_member_id: memberA
    } });
    expect(created.statusCode).toBe(201);
    const appointmentId = created.json().agendamento.id as string;
    expect(created.json().agendamento.responsavel.member_id).toBe(memberA);
    const notificationRepository = new SchedulingNotificationRepository(pool);
    const notificationId = await notificationRepository.create({
      tenantId,
      appointmentId,
      sessionId,
      groupJid: "120363000000000000@g.us",
      message: "Agendamento com Closer A"
    });
    expect(notificationId).toBeTruthy();
    await notificationRepository.markSent(notificationId!, "group-message-assignee");

    await pool.query("UPDATE scheduling_google_meet_closers SET availability_status='unavailable' WHERE tenant_id=$1 AND member_id=$2", [tenantId, memberB]);
    expect((await app.inject({ method: "PATCH", url: `/scheduling/appointments/${appointmentId}/assignee`, headers: { cookie }, payload: { assigned_member_id: memberB } })).statusCode).toBe(409);
    await pool.query("UPDATE scheduling_google_meet_closers SET availability_status='available' WHERE tenant_id=$1 AND member_id=$2", [tenantId, memberB]);

    const changed = await app.inject({ method: "PATCH", url: `/scheduling/appointments/${appointmentId}/assignee`, headers: { cookie }, payload: { assigned_member_id: memberB } });
    expect(changed.statusCode).toBe(200);
    const state = await pool.query(
      `SELECT appointment.assigned_member_id,lead.assigned_member_id lead_member,conversation.assigned_user_id,conversation.ai_active
       FROM scheduling_appointments appointment JOIN scheduling_leads lead ON lead.id=appointment.lead_id
       JOIN conversations conversation ON conversation.tenant_id=lead.tenant_id AND conversation.contact_phone=lead.phone
       WHERE appointment.id=$1`, [appointmentId]
    );
    expect(state.rows[0]).toMatchObject({ assigned_member_id: memberB, lead_member: memberB, assigned_user_id: userB, ai_active: false });
    const assignedEmail = (await pool.query<{ email: string }>("SELECT email FROM users WHERE id=$1", [userB])).rows[0].email;
    expect(await notificationRepository.getPendingEdit(notificationId!)).toMatchObject({
      externalMessageId: "group-message-assignee",
      revision: 1,
      message: expect.stringContaining(`Responsável: ${assignedEmail}`)
    });
    const recipients = await pool.query<{ user_id: string }>(
      `SELECT receipt.user_id FROM system_alert_receipts receipt JOIN system_alerts alert ON alert.id=receipt.alert_id
       WHERE alert.tenant_id=$1 AND alert.metadata->>'appointment_id'=$2`, [tenantId, appointmentId]
    );
    expect(recipients.rows.map((row) => row.user_id)).toEqual(expect.arrayContaining([userA, userB]));
  });

  it("offers only conflict-free closers and rejects creation when none can take the interval", async () => {
    const first = await caseFor(memberA);
    const second = await caseFor(memberB);
    await pool.query("INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at,assigned_member_id) VALUES($1,$2,'unit','2030-08-06T10:00:00Z','2030-08-06T10:30:00Z',$3),($1,$4,'unit','2030-08-06T10:00:00Z','2030-08-06T10:30:00Z',$5)", [tenantId, first.leadId, memberA, second.leadId, memberB]);
    const options = await app.inject({ url: "/scheduling/appointment-assignees?start=2030-08-06T10%3A00%3A00.000Z&end=2030-08-06T10%3A30%3A00.000Z", headers: { cookie } });
    expect(options.statusCode).toBe(200);
    expect(options.json().assignees.every((assignee: { selectable: boolean; conflicts: unknown[] }) => !assignee.selectable && assignee.conflicts.length === 1)).toBe(true);

    const fallback = await caseFor(memberA);
    const created = await app.inject({ method: "POST", url: "/scheduling/appointments", headers: { cookie }, payload: {
      lead_id: fallback.leadId, unidade_id: "unit", start: "2030-08-06T10:00:00.000Z", end: "2030-08-06T10:30:00.000Z", assigned_member_id: null
    } });
    expect(created.statusCode).toBe(409);
    expect(created.json().error).toMatch(/closer ativo disponível/i);
    expect((await pool.query("SELECT assigned_member_id FROM scheduling_leads WHERE id=$1", [fallback.leadId])).rows[0].assigned_member_id).toBe(memberA);
  });

  it("returns a different free-time grid for each closer, including conflicts in another unit", async () => {
    const first = await caseFor(memberA);
    const second = await caseFor(memberB);
    await pool.query(
      "INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,simultaneous_capacity) VALUES($1,'other-unit','Other unit','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[],3)",
      [tenantId]
    );
    await pool.query(
      "INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at,assigned_member_id) VALUES($1,$2,'other-unit','2030-08-07T09:00:00Z','2030-08-07T10:00:00Z',$3),($1,$4,'unit','2030-08-07T10:00:00Z','2030-08-07T11:00:00Z',$5)",
      [tenantId, first.leadId, memberA, second.leadId, memberB]
    );

    const availabilityFor = async (memberId: string) => app.inject({
      url: `/scheduling/availability?unidade_id=unit&data=2030-08-07&assigned_member_id=${memberId}`,
      headers: { cookie }
    });
    const [closerA, closerB] = await Promise.all([availabilityFor(memberA), availabilityFor(memberB)]);
    expect(closerA.statusCode).toBe(200);
    expect(closerB.statusCode).toBe(200);
    expect((await app.inject({
      url: `/scheduling/availability?unidade_id=unit&data=2030-08-07&assigned_member_id=${memberB}`,
      headers: { cookie: operatorCookie }
    })).statusCode).toBe(403);
    const vacancies = (response: typeof closerA) => new Map(
      response.json().horarios.map((slot: { start: string; vagas: number }) => [slot.start, slot.vagas])
    );

    expect(vacancies(closerA).get("2030-08-07T09:00:00.000Z")).toBe(0);
    expect(vacancies(closerA).get("2030-08-07T10:00:00.000Z")).toBe(1);
    expect(vacancies(closerB).get("2030-08-07T09:00:00.000Z")).toBe(1);
    expect(vacancies(closerB).get("2030-08-07T10:00:00.000Z")).toBe(0);
  });

  it("treats a closer's personal block exactly like an occupied meeting", async () => {
    const createdBlock = await app.inject({
      method: "POST",
      url: "/scheduling/attendants/me/time-blocks",
      headers: { cookie: operatorCookie },
      payload: {
        start: "2030-08-08T10:00:00.000Z",
        end: "2030-08-08T11:00:00.000Z",
        reason: "Compromisso da Julia"
      }
    });
    expect(createdBlock.statusCode).toBe(201);
    const blockId = createdBlock.json().block.id as string;

    const options = await app.inject({
      url: "/scheduling/appointment-assignees?start=2030-08-08T10%3A00%3A00.000Z&end=2030-08-08T10%3A30%3A00.000Z",
      headers: { cookie }
    });
    expect(options.statusCode).toBe(200);
    expect(options.json().assignees.find((candidate: { member_id: string }) => candidate.member_id === memberA))
      .toMatchObject({ selectable: false, conflicts: [expect.objectContaining({ id: blockId, lead_name: "Compromisso da Julia" })] });
    expect(options.json().assignees.find((candidate: { member_id: string }) => candidate.member_id === memberB))
      .toMatchObject({ selectable: true });

    const current = await caseFor(memberA);
    const scheduled = await app.inject({
      method: "POST",
      url: "/scheduling/appointments",
      headers: { cookie },
      payload: {
        lead_id: current.leadId,
        unidade_id: "unit",
        start: "2030-08-08T10:00:00.000Z",
        end: "2030-08-08T10:30:00.000Z"
      }
    });
    expect(scheduled.statusCode).toBe(201);
    expect(scheduled.json().agendamento.responsavel.member_id).toBe(memberB);

    const grid = await app.inject({
      url: `/scheduling/availability?unidade_id=unit&data=2030-08-08&assigned_member_id=${memberA}`,
      headers: { cookie }
    });
    expect(grid.statusCode).toBe(200);
    expect(grid.json().horarios.find((slot: { start: string }) => slot.start === "2030-08-08T10:00:00.000Z"))
      .toMatchObject({ vagas: 0 });

    const listed = await app.inject({
      url: "/scheduling/attendants/me/time-blocks?start=2030-08-08T00%3A00%3A00.000Z&end=2030-08-09T00%3A00%3A00.000Z",
      headers: { cookie: operatorCookie }
    });
    expect(listed.json().blocks).toEqual([expect.objectContaining({ id: blockId, reason: "Compromisso da Julia" })]);
    expect((await app.inject({
      method: "DELETE",
      url: `/scheduling/attendants/me/time-blocks/${blockId}`,
      headers: { cookie: operatorCookie }
    })).statusCode).toBe(200);
  });
});
