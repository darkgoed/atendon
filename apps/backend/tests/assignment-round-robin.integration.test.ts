import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import {
  assignConversationToNamedAttendant,
  ensureCaseAssignment,
  redistributeRemovedAssignments,
  transferCaseAssignment
} from "../src/modules/assignments/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 20 });

let tenantId = "";
let betoUserId = "";
let betoMemberId = "";
let juliaUserId = "";
let juliaMemberId = "";
let phoneSequence = 0;

const nextPhone = () => `551198${String(++phoneSequence).padStart(6, "0")}`;

async function inTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createLead(
  phone: string,
  options: {
    status?: "em_atendimento" | "qualificado" | "perdido";
    assignedMemberId?: string | null;
    formattedPhone?: string;
  } = {}
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO scheduling_leads(
       tenant_id,phone,name,interest_category_id,unit_id,status,source,assigned_member_id,
       commercial_outcome,loss_reason,commercial_updated_at
     ) VALUES($1,$2,$3,'assignment-category','assignment-unit',$4,'assignment-test',$5,
       CASE WHEN $4='perdido' THEN 'nao_avancou' END,
       CASE WHEN $4='perdido' THEN 'outro' END,
       CASE WHEN $4='perdido' THEN now() END)
     RETURNING id`,
    [
      tenantId,
      options.formattedPhone ?? phone,
      `Lead ${phone}`,
      options.status ?? "em_atendimento",
      options.assignedMemberId ?? null
    ]
  )).rows[0].id;
}

async function createConversation(
  phone: string,
  options: {
    status?: "open" | "closed";
    assignedUserId?: string | null;
    formattedPhone?: string;
  } = {}
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO conversations(
       tenant_id,contact_phone,contact_name,status,assigned_user_id,claimed_at
     ) VALUES($1,$2,$3,$4,$5,CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() END)
     RETURNING id`,
    [
      tenantId,
      options.formattedPhone ?? phone,
      `Contato ${phone}`,
      options.status ?? "open",
      options.assignedUserId ?? null
    ]
  )).rows[0].id;
}

async function createCase(phone = nextPhone()) {
  const leadId = await createLead(phone);
  const conversationId = await createConversation(phone);
  return { phone, leadId, conversationId };
}

async function createAppointment(
  leadId: string,
  options: {
    status?: "confirmado" | "reagendado" | "cancelado" | "concluido";
    assignedMemberId?: string | null;
  } = {}
): Promise<string> {
  return (await pool.query<{ id: string }>(
    `INSERT INTO scheduling_appointments(
       lead_id,tenant_id,unit_id,start_at,end_at,status,assigned_member_id,assigned_at,
       commercial_outcome,outcome_next_action,outcome_next_action_at,finalized_at
     ) VALUES(
       $1,$2,'assignment-unit','2035-05-10T10:00:00Z','2035-05-10T10:30:00Z',
       $3,$4,CASE WHEN $4::uuid IS NULL THEN NULL ELSE now() END,
       CASE WHEN $3='concluido' THEN 'follow_up' END,
       CASE WHEN $3='concluido' THEN 'Revisar resultado do teste' END,
       CASE WHEN $3='concluido' THEN '2035-05-11T10:00:00Z'::timestamptz END,
       CASE WHEN $3='concluido' THEN now() END
     ) RETURNING id`,
    [leadId, tenantId, options.status ?? "confirmado", options.assignedMemberId ?? null]
  )).rows[0].id;
}

async function assignCase(
  selector: { phone: string } | { leadId: string } | { conversationId: string },
  options: {
    reason?: "novo_contato" | "lead_criado" | "retorno_conversa_encerrada" | "reuniao_sem_responsavel";
    forceRotation?: boolean;
  } = {}
) {
  return inTransaction((client) => ensureCaseAssignment(client, {
    tenantId,
    selector,
    reason: options.reason ?? "novo_contato",
    forceRotation: options.forceRotation
  }));
}

async function caseAssignments(phone: string) {
  const [lead, conversation] = await Promise.all([
    pool.query<{ assigned_member_id: string | null }>(
      "SELECT assigned_member_id FROM scheduling_leads WHERE tenant_id=$1 AND regexp_replace(phone,'\\D','','g')=$2",
      [tenantId, phone]
    ),
    pool.query<{ assigned_user_id: string | null }>(
      "SELECT assigned_user_id FROM conversations WHERE tenant_id=$1 AND regexp_replace(contact_phone,'\\D','','g')=$2",
      [tenantId, phone]
    )
  ]);
  return {
    memberIds: lead.rows.map((row) => row.assigned_member_id),
    userIds: conversation.rows.map((row) => row.assigned_user_id)
  };
}

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','UTC') RETURNING id",
    [`Assignment round robin ${randomUUID()}`]
  )).rows[0].id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    betoUserId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status,name) VALUES($1,'active','Beto Souza') RETURNING id",
      [`beto-assignment-${randomUUID()}@test.local`]
    )).rows[0].id;
    juliaUserId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
      [`lucas@${randomUUID()}.test.local`]
    )).rows[0].id;
    betoMemberId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now()
       FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'
       RETURNING id`,
      [tenantId, betoUserId]
    )).rows[0].id;
    juliaMemberId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now()
       FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'
       RETURNING id`,
      [tenantId, juliaUserId]
    )).rows[0].id;
    await client.query(
      "INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'assignment-category','Assignment category')",
      [tenantId]
    );
    await client.query(
      `INSERT INTO scheduling_units(
         tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity
       ) VALUES($1,'assignment-unit','Assignment unit','00:00','23:59',ARRAY[0,1,2,3,4,5,6]::smallint[],30,100)`,
      [tenantId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

beforeEach(async () => {
  await pool.query("DELETE FROM audit_logs WHERE workspace_id=$1", [tenantId]);
  await pool.query("DELETE FROM conversations WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM scheduling_appointments WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM scheduling_leads WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM scheduling_google_meet_closers WHERE tenant_id=$1", [tenantId]);
  await pool.query(
    `INSERT INTO scheduling_google_meet_closers(
       tenant_id,member_id,created_at,availability_status
     ) VALUES
       ($1,$2,'2026-01-01T00:00:00Z','available'),
       ($1,$3,'2026-01-02T00:00:00Z','unavailable')`,
    [tenantId, betoMemberId, juliaMemberId]
  );
  await pool.query(
    `INSERT INTO attendant_assignment_cursors(tenant_id,last_member_id)
     VALUES($1,NULL)
     ON CONFLICT(tenant_id) DO UPDATE SET last_member_id=NULL,updated_at=now()`,
    [tenantId]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM audit_logs WHERE workspace_id=$1 OR actor_user_id=ANY($2::uuid[])", [
    tenantId,
    [betoUserId, juliaUserId]
  ]);
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[betoUserId, juliaUserId]]);
  await pool.end();
});

describe("strict attendant round robin", () => {
  it("assigns an owner referral by unique email local part when the attendant has no display name", async () => {
    const item = await createCase();
    await pool.query(
      "UPDATE scheduling_leads SET assigned_member_id=$2 WHERE tenant_id=$1 AND id=$3",
      [tenantId, betoMemberId, item.leadId]
    );
    await pool.query(
      "UPDATE conversations SET assigned_user_id=$2 WHERE tenant_id=$1 AND id=$3",
      [tenantId, betoUserId, item.conversationId]
    );
    const appointmentId = await createAppointment(item.leadId, { assignedMemberId: betoMemberId });

    await expect(inTransaction((client) => assignConversationToNamedAttendant(client, {
      tenantId,
      conversationId: item.conversationId,
      assigneeName: "Lucas"
    }))).resolves.toMatchObject({ memberId: juliaMemberId, userId: juliaUserId });

    expect(await caseAssignments(item.phone)).toEqual({
      memberIds: [betoMemberId],
      userIds: [juliaUserId]
    });
    expect((await pool.query<{ assigned_member_id: string }>(
      "SELECT assigned_member_id FROM scheduling_appointments WHERE id=$1",
      [appointmentId]
    )).rows[0].assigned_member_id).toBe(betoMemberId);
    expect((await pool.query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE workspace_id=$1 AND resource_id=$2 ORDER BY created_at DESC LIMIT 1",
      [tenantId, item.conversationId]
    )).rows[0].action).toBe("assignment.owner_referral");
  });

  it("alternates Beto -> Julia -> Beto -> Julia and includes an unavailable selected member", async () => {
    const cases = await Promise.all([createCase(), createCase(), createCase(), createCase()]);
    const assignments = [];
    for (const item of cases) assignments.push(await assignCase({ leadId: item.leadId }));

    expect(assignments.map((assignment) => assignment?.memberId)).toEqual([
      betoMemberId,
      juliaMemberId,
      betoMemberId,
      juliaMemberId
    ]);
    expect(assignments[1]).toMatchObject({
      memberId: juliaMemberId,
      userId: juliaUserId,
      availabilityStatus: "unavailable"
    });

    for (const [index, item] of cases.entries()) {
      const expectedMemberId = index % 2 === 0 ? betoMemberId : juliaMemberId;
      const expectedUserId = index % 2 === 0 ? betoUserId : juliaUserId;
      expect(await caseAssignments(item.phone)).toEqual({
        memberIds: [expectedMemberId],
        userIds: [expectedUserId]
      });
    }
  });

  it("serializes concurrent creations without duplicating a turn", async () => {
    const cases = await Promise.all(Array.from({ length: 8 }, () => createCase()));
    const assignments = await Promise.all(cases.map((item) => assignCase({ phone: item.phone })));
    const memberIds = assignments.map((assignment) => assignment?.memberId);

    expect(memberIds.filter((memberId) => memberId === betoMemberId)).toHaveLength(4);
    expect(memberIds.filter((memberId) => memberId === juliaMemberId)).toHaveLength(4);
    expect(new Set(memberIds)).toEqual(new Set([betoMemberId, juliaMemberId]));

    const persisted = await pool.query<{ assigned_member_id: string; total: number }>(
      `SELECT assigned_member_id,count(*)::int total
       FROM scheduling_leads WHERE tenant_id=$1
       GROUP BY assigned_member_id ORDER BY assigned_member_id`,
      [tenantId]
    );
    expect(Object.fromEntries(persisted.rows.map((row) => [row.assigned_member_id, row.total]))).toEqual({
      [betoMemberId]: 4,
      [juliaMemberId]: 4
    });
  });

  it("is idempotent and does not consume another turn for an already assigned case", async () => {
    const firstCase = await createCase();
    const first = await assignCase({ conversationId: firstCase.conversationId });
    const repeated = await assignCase({ leadId: firstCase.leadId }, { reason: "lead_criado" });
    const secondCase = await createCase();
    const second = await assignCase({ leadId: secondCase.leadId });

    expect(first?.memberId).toBe(betoMemberId);
    expect(repeated?.memberId).toBe(betoMemberId);
    expect(second?.memberId).toBe(juliaMemberId);
    expect((await pool.query<{ total: number }>(
      "SELECT count(*)::int total FROM scheduling_lead_events WHERE tenant_id=$1 AND lead_id=$2",
      [tenantId, firstCase.leadId]
    )).rows[0].total).toBe(1);
    expect((await pool.query<{ total: number }>(
      `SELECT count(*)::int total FROM audit_logs
       WHERE workspace_id=$1 AND resource_id=$2 AND action LIKE 'assignment.%'`,
      [tenantId, firstCase.leadId]
    )).rows[0].total).toBe(1);
  });

  it("rotates a returning closed conversation and synchronizes its lead and active meeting", async () => {
    const item = await createCase();
    expect((await assignCase({ leadId: item.leadId }))?.memberId).toBe(betoMemberId);
    const activeAppointmentId = await createAppointment(item.leadId, { assignedMemberId: betoMemberId });
    const completedAppointmentId = await createAppointment(item.leadId, {
      assignedMemberId: betoMemberId,
      status: "concluido"
    });
    await pool.query("UPDATE conversations SET status='closed' WHERE id=$1", [item.conversationId]);

    const returned = await assignCase(
      { conversationId: item.conversationId },
      { reason: "retorno_conversa_encerrada", forceRotation: true }
    );

    expect(returned?.memberId).toBe(juliaMemberId);
    expect(await caseAssignments(item.phone)).toEqual({
      memberIds: [juliaMemberId],
      userIds: [juliaUserId]
    });
    const appointments = await pool.query<{ id: string; assigned_member_id: string }>(
      "SELECT id,assigned_member_id FROM scheduling_appointments WHERE id=ANY($1::uuid[])",
      [[activeAppointmentId, completedAppointmentId]]
    );
    const byId = Object.fromEntries(appointments.rows.map((row) => [row.id, row.assigned_member_id]));
    expect(byId[activeAppointmentId]).toBe(juliaMemberId);
    expect(byId[completedAppointmentId]).toBe(betoMemberId);
    expect((await pool.query<{ event_type: string }>(
      "SELECT event_type FROM scheduling_lead_events WHERE lead_id=$1 ORDER BY created_at,id",
      [item.leadId]
    )).rows.map((row) => row.event_type)).toEqual([
      "responsavel_atribuido_automaticamente",
      "responsavel_reatribuido_retorno"
    ]);
  });

  it("leaves the case unassigned when the pool is empty", async () => {
    await pool.query("DELETE FROM scheduling_google_meet_closers WHERE tenant_id=$1", [tenantId]);
    const item = await createCase();

    expect(await assignCase({ leadId: item.leadId })).toBeNull();
    expect(await caseAssignments(item.phone)).toEqual({ memberIds: [null], userIds: [null] });
    expect((await pool.query<{ last_member_id: string | null }>(
      "SELECT last_member_id FROM attendant_assignment_cursors WHERE tenant_id=$1",
      [tenantId]
    )).rows[0].last_member_id).toBeNull();
  });
});

describe("case assignment consistency", () => {
  it("allows only the current operator to transfer and only a manager to remove the assignee", async () => {
    const item = await createCase();
    await assignCase({ leadId: item.leadId });
    const appointmentId = await createAppointment(item.leadId, { assignedMemberId: betoMemberId });

    expect(await inTransaction((client) => transferCaseAssignment(client, {
      tenantId,
      selector: { conversationId: item.conversationId },
      targetMemberId: betoMemberId,
      actor: { userId: juliaUserId },
      manager: false
    }))).toEqual({ found: false, previousUserId: null, assignment: null });

    await expect(inTransaction((client) => transferCaseAssignment(client, {
      tenantId,
      selector: { leadId: item.leadId },
      targetMemberId: null,
      actor: { userId: betoUserId },
      manager: false
    }))).rejects.toMatchObject({ statusCode: 403 });

    expect(await inTransaction((client) => transferCaseAssignment(client, {
      tenantId,
      selector: { leadId: item.leadId },
      targetMemberId: null,
      actor: { userId: betoUserId },
      manager: true
    }))).toMatchObject({
      found: true,
      previousUserId: betoUserId,
      assignment: null
    });
    expect(await caseAssignments(item.phone)).toEqual({ memberIds: [null], userIds: [null] });
    expect((await pool.query<{ assigned_member_id: string | null }>(
      "SELECT assigned_member_id FROM scheduling_appointments WHERE id=$1",
      [appointmentId]
    )).rows[0].assigned_member_id).toBeNull();
  });

  it("transfers lead, conversation and active meeting together and records the actor", async () => {
    const item = await createCase();
    await assignCase({ leadId: item.leadId });
    const appointmentId = await createAppointment(item.leadId, { assignedMemberId: betoMemberId });

    const transferred = await inTransaction((client) => transferCaseAssignment(client, {
      tenantId,
      selector: { leadId: item.leadId },
      targetMemberId: juliaMemberId,
      actor: { userId: betoUserId },
      manager: false
    }));

    expect(transferred).toMatchObject({
      found: true,
      previousUserId: betoUserId,
      assignment: { memberId: juliaMemberId, userId: juliaUserId }
    });
    expect(await caseAssignments(item.phone)).toEqual({
      memberIds: [juliaMemberId],
      userIds: [juliaUserId]
    });
    expect((await pool.query<{ assigned_member_id: string }>(
      "SELECT assigned_member_id FROM scheduling_appointments WHERE id=$1",
      [appointmentId]
    )).rows[0].assigned_member_id).toBe(juliaMemberId);
    expect((await pool.query<{ action: string; metadata: { actor_user_id: string } }>(
      "SELECT action,metadata FROM audit_logs WHERE workspace_id=$1 AND resource_id=$2 ORDER BY created_at DESC LIMIT 1",
      [tenantId, item.leadId]
    )).rows[0]).toMatchObject({
      action: "assignment.transferencia_manual",
      metadata: { actor_user_id: betoUserId }
    });
  });

  it("transfers a closed case without reopening or pausing its historical conversation", async () => {
    const item = await createCase();
    await assignCase({ leadId: item.leadId });
    const resolvedAt = "2034-01-02T03:04:05.000Z";
    await pool.query(
      `UPDATE conversations
       SET status='closed',resolved_at=$2,ai_active=true,handoff_reason=NULL
       WHERE id=$1`,
      [item.conversationId, resolvedAt]
    );

    expect(await inTransaction((client) => transferCaseAssignment(client, {
      tenantId,
      selector: { leadId: item.leadId },
      targetMemberId: juliaMemberId,
      actor: { userId: betoUserId },
      manager: false
    }))).toMatchObject({
      found: true,
      previousUserId: betoUserId,
      assignment: { memberId: juliaMemberId, userId: juliaUserId }
    });

    const conversation = (await pool.query<{
      status: string;
      assigned_user_id: string | null;
      resolved_at: Date | null;
      ai_active: boolean;
      handoff_reason: string | null;
    }>(
      `SELECT status,assigned_user_id,resolved_at,ai_active,handoff_reason
       FROM conversations WHERE id=$1`,
      [item.conversationId]
    )).rows[0];
    expect(conversation).toMatchObject({
      status: "closed",
      assigned_user_id: juliaUserId,
      ai_active: true,
      handoff_reason: null
    });
    expect(conversation.resolved_at?.toISOString()).toBe(resolvedAt);
  });

  it("redistributes active records but preserves closed conversations and final leads", async () => {
    const fullyActivePhone = nextPhone();
    const fullyActiveLead = await createLead(fullyActivePhone, { assignedMemberId: betoMemberId });
    await createConversation(fullyActivePhone, { assignedUserId: betoUserId });
    const activeAppointmentId = await createAppointment(fullyActiveLead, { assignedMemberId: betoMemberId });

    const activeLeadPhone = nextPhone();
    const activeLeadId = await createLead(activeLeadPhone, { assignedMemberId: betoMemberId });
    const closedConversationId = await createConversation(activeLeadPhone, {
      assignedUserId: betoUserId,
      status: "closed"
    });

    const activeConversationPhone = nextPhone();
    const finalLeadId = await createLead(activeConversationPhone, {
      assignedMemberId: betoMemberId,
      status: "perdido"
    });
    const activeConversationId = await createConversation(activeConversationPhone, {
      assignedUserId: betoUserId
    });

    const conversationOnlyPhone = nextPhone();
    const conversationOnlyId = await createConversation(conversationOnlyPhone, {
      assignedUserId: betoUserId
    });

    const historicalPhone = nextPhone();
    const historicalLeadId = await createLead(historicalPhone, {
      assignedMemberId: betoMemberId,
      status: "perdido"
    });
    const historicalConversationId = await createConversation(historicalPhone, {
      assignedUserId: betoUserId,
      status: "closed"
    });

    await pool.query(
      "DELETE FROM scheduling_google_meet_closers WHERE tenant_id=$1 AND member_id=$2",
      [tenantId, betoMemberId]
    );
    const totals = await inTransaction((client) => redistributeRemovedAssignments(client, {
      tenantId,
      removedMemberIds: [betoMemberId],
      actor: { userId: betoUserId }
    }));

    expect(totals).toEqual({ leads: 3, conversations: 3, appointments: 1 });
    expect((await pool.query(
      `SELECT
         (SELECT assigned_member_id FROM scheduling_leads WHERE id=$1) fully_active_lead,
         (SELECT assigned_user_id FROM conversations WHERE tenant_id=$2 AND contact_phone=$3) fully_active_conversation,
         (SELECT assigned_member_id FROM scheduling_appointments WHERE id=$4) active_appointment,
         (SELECT assigned_member_id FROM scheduling_leads WHERE id=$5) active_lead,
         (SELECT assigned_user_id FROM conversations WHERE id=$6) closed_conversation,
         (SELECT assigned_member_id FROM scheduling_leads WHERE id=$7) final_lead,
         (SELECT assigned_user_id FROM conversations WHERE id=$8) active_conversation,
         (SELECT assigned_user_id FROM conversations WHERE id=$9) conversation_only,
         (SELECT assigned_member_id FROM scheduling_leads
          WHERE tenant_id=$2 AND phone=$10) conversation_only_lead,
         (SELECT assigned_member_id FROM scheduling_leads WHERE id=$11) historical_lead,
         (SELECT assigned_user_id FROM conversations WHERE id=$12) historical_conversation`,
      [
        fullyActiveLead,
        tenantId,
        fullyActivePhone,
        activeAppointmentId,
        activeLeadId,
        closedConversationId,
        finalLeadId,
        activeConversationId,
        conversationOnlyId,
        conversationOnlyPhone,
        historicalLeadId,
        historicalConversationId
      ]
    )).rows[0]).toEqual({
      fully_active_lead: juliaMemberId,
      fully_active_conversation: juliaUserId,
      active_appointment: juliaMemberId,
      active_lead: juliaMemberId,
      closed_conversation: betoUserId,
      final_lead: betoMemberId,
      active_conversation: juliaUserId,
      conversation_only: juliaUserId,
      conversation_only_lead: juliaMemberId,
      historical_lead: betoMemberId,
      historical_conversation: betoUserId
    });
  });

  it("preserves cases when removing the final pool member", async () => {
    await pool.query(
      "DELETE FROM scheduling_google_meet_closers WHERE tenant_id=$1 AND member_id=$2",
      [tenantId, juliaMemberId]
    );
    const activePhone = nextPhone();
    const activeLeadId = await createLead(activePhone, { assignedMemberId: betoMemberId });
    const activeConversationId = await createConversation(activePhone, { assignedUserId: betoUserId });
    const historicalPhone = nextPhone();
    const historicalLeadId = await createLead(historicalPhone, {
      assignedMemberId: betoMemberId,
      status: "perdido"
    });
    const historicalConversationId = await createConversation(historicalPhone, {
      assignedUserId: betoUserId,
      status: "closed"
    });
    await pool.query(
      "DELETE FROM scheduling_google_meet_closers WHERE tenant_id=$1 AND member_id=$2",
      [tenantId, betoMemberId]
    );

    expect(await inTransaction((client) => redistributeRemovedAssignments(client, {
      tenantId,
      removedMemberIds: [betoMemberId],
      actor: { userId: betoUserId }
    }))).toEqual({ leads: 0, conversations: 0, appointments: 0 });
    expect((await pool.query(
      `SELECT
         (SELECT assigned_member_id FROM scheduling_leads WHERE id=$1) active_lead,
         (SELECT assigned_user_id FROM conversations WHERE id=$2) active_conversation,
         (SELECT assigned_member_id FROM scheduling_leads WHERE id=$3) historical_lead,
         (SELECT assigned_user_id FROM conversations WHERE id=$4) historical_conversation`,
      [activeLeadId, activeConversationId, historicalLeadId, historicalConversationId]
    )).rows[0]).toEqual({
      active_lead: betoMemberId,
      active_conversation: betoUserId,
      historical_lead: betoMemberId,
      historical_conversation: betoUserId
    });
  });
});
