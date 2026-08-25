import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles, SUPERVISOR_PERMISSIONS } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const password = "case-scope-password";
const suffix = randomUUID();
const emails = {
  root: `case-root-${suffix}@test.local`,
  owner: `case-owner-${suffix}@test.local`,
  admin: `case-admin-${suffix}@test.local`,
  supervisor: `case-supervisor-${suffix}@test.local`,
  beto: `case-beto-${suffix}@test.local`,
  julia: `case-julia-${suffix}@test.local`,
  custom: `case-custom-${suffix}@test.local`,
  inactive: `case-inactive-${suffix}@test.local`
};

let tenantId = "";
let sessionId = "";
let rootCookie = "";
let ownerCookie = "";
let adminCookie = "";
let supervisorCookie = "";
let betoCookie = "";
let juliaCookie = "";
let customCookie = "";
let betoUserId = "";
let juliaUserId = "";
let customUserId = "";
let betoMemberId = "";
let juliaMemberId = "";
let customMemberId = "";
let betoConversationId = "";
let juliaConversationId = "";
let customConversationId = "";
let unassignedConversationId = "";
let juliaMessageId = "";
let betoLeadId = "";
let juliaLeadId = "";
let customLeadId = "";
let unassignedLeadId = "";
let juliaAppointmentId = "";

async function login(email: string) {
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password }
  });
  expect(response.statusCode).toBe(200);
  const value = response.headers["set-cookie"]!;
  return (Array.isArray(value) ? value[0] : value).split(";")[0];
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
      [`Case scope ${suffix}`]
    )).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantId);
    await client.query(
      `INSERT INTO workspace_role_permissions(role_id,permission_key)
       SELECT id,'api_keys.manage'
       FROM workspace_roles
       WHERE workspace_id=$1 AND name='SUPERVISOR'`,
      [tenantId]
    );
    await ensureWorkspaceDefaultRoles(client, tenantId);
    sessionId = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",
      [tenantId]
    )).rows[0].id;

    const customRoleId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_roles(workspace_id,name,description)
       VALUES($1,$2,'Função personalizada de atendimento')
       RETURNING id`,
      [tenantId, `PERSONALIZADA ${suffix}`]
    )).rows[0].id;
    await client.query(
      `INSERT INTO workspace_role_permissions(role_id,permission_key)
       SELECT $1,permission
       FROM unnest($2::text[]) permission`,
      [
        customRoleId,
        [
          "dashboard.read",
          "conversations.read",
          "conversations.reply",
          "conversations.reactivate",
          "leads.read",
          "leads.update_status",
          "appointments.read",
          "appointments.reschedule"
        ]
      ]
    );

    const passwordHash = await hash(password, 4);
    const users = new Map<string, string>();
    for (const email of Object.values(emails)) {
      const user = await client.query<{ id: string }>(
        "INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',$3) RETURNING id",
        [email, passwordHash, email === emails.root]
      );
      users.set(email, user.rows[0].id);
    }
    betoUserId = users.get(emails.beto)!;
    juliaUserId = users.get(emails.julia)!;
    customUserId = users.get(emails.custom)!;

    const ownerMemberId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now()
       FROM workspace_roles
       WHERE workspace_id=$1 AND name='OWNER'
       RETURNING id`,
      [tenantId, users.get(emails.owner)]
    )).rows[0].id;
    void ownerMemberId;
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now()
       FROM workspace_roles
       WHERE workspace_id=$1 AND name='ADMIN'`,
      [tenantId, users.get(emails.admin)]
    );
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now()
       FROM workspace_roles
       WHERE workspace_id=$1 AND name='SUPERVISOR'`,
      [tenantId, users.get(emails.supervisor)]
    );
    const operatorMembers = new Map<string, string>();
    for (const email of [emails.beto, emails.julia, emails.inactive]) {
      const member = await client.query<{ id: string }>(
        `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
         SELECT $1,$2,id,'active',now()
         FROM workspace_roles
         WHERE workspace_id=$1 AND name='OPERADOR'
         RETURNING id`,
        [tenantId, users.get(email)]
      );
      operatorMembers.set(email, member.rows[0].id);
    }
    customMemberId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       VALUES($1,$2,$3,'active',now())
       RETURNING id`,
      [tenantId, customUserId, customRoleId]
    )).rows[0].id;
    betoMemberId = operatorMembers.get(emails.beto)!;
    juliaMemberId = operatorMembers.get(emails.julia)!;

    await client.query(
      `INSERT INTO scheduling_google_meet_closers(
         tenant_id,member_id,availability_status
       ) VALUES
         ($1,$2,'available'),
         ($1,$3,'unavailable'),
         ($1,$4,'available'),
         ($1,$5,'available')`,
      [
        tenantId,
        operatorMembers.get(emails.beto),
        operatorMembers.get(emails.julia),
        customMemberId,
        operatorMembers.get(emails.inactive)
      ]
    );
    await client.query("UPDATE users SET status='disabled' WHERE id=$1", [users.get(emails.inactive)]);

    const insertConversation = async (
      phone: string,
      assignedUserId: string | null,
      name: string
    ) => {
      const conversation = await client.query<{ id: string }>(
        `INSERT INTO conversations(
         tenant_id,session_id,contact_phone,contact_name,assigned_user_id,
           ai_active,handoff_reason,status,claimed_at
         ) VALUES($1,$2,$3,$4,$5,false,'contact_requested','open',
           CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() END)
         RETURNING id`,
        [tenantId, sessionId, phone, name, assignedUserId]
      );
      await client.query(
        "INSERT INTO messages(conversation_id,sender,content) VALUES($1,'contact',$2)",
        [conversation.rows[0].id, `Mensagem privada de ${name}`]
      );
      return conversation.rows[0].id;
    };
    betoConversationId = await insertConversation("5511900001001", betoUserId, "Beto");
    juliaConversationId = await insertConversation("5511900001002", juliaUserId, "Julia");
    customConversationId = await insertConversation("5511900001003", customUserId, "Custom");
    unassignedConversationId = await insertConversation("5511900001004", null, "Sem responsável");
    juliaMessageId = (await client.query<{ id: string }>(
      "SELECT id FROM messages WHERE conversation_id=$1",
      [juliaConversationId]
    )).rows[0].id;

    await client.query(
      `INSERT INTO scheduling_units(
         tenant_id,id,name,opening_time,closing_time,operating_days
       ) VALUES($1,'case-scope','Unidade escopo','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[])`,
      [tenantId]
    );
    for (const [phone, memberId] of [
      ["5511900001001", operatorMembers.get(emails.beto)],
      ["5511900001002", operatorMembers.get(emails.julia)],
      ["5511900001003", customMemberId]
    ] as const) {
      const lead = await client.query<{ id: string }>(
        `UPDATE scheduling_leads
         SET name=$3,source='test',unit_id='case-scope',assigned_member_id=$4,updated_at=now()
         WHERE tenant_id=$1 AND phone=$2
         RETURNING id`,
        [tenantId, phone, `Lead ${phone}`, memberId]
      );
      if (phone === "5511900001001") betoLeadId = lead.rows[0].id;
      if (phone === "5511900001002") juliaLeadId = lead.rows[0].id;
      if (phone === "5511900001003") customLeadId = lead.rows[0].id;
    }
    unassignedLeadId = (await client.query<{ id: string }>(
      `UPDATE scheduling_leads
       SET name='Lead sem responsável',source='test',unit_id='case-scope',updated_at=now()
       WHERE tenant_id=$1 AND phone='5511900001004'
       RETURNING id`,
      [tenantId]
    )).rows[0].id;
    const appointments = await client.query<{ id: string; assigned_member_id: string | null }>(
      `INSERT INTO scheduling_appointments(
         tenant_id,lead_id,unit_id,start_at,end_at,status,assigned_member_id
       ) VALUES
         ($1,$2,'case-scope','2035-01-08T09:00:00Z','2035-01-08T10:00:00Z','confirmado',$6),
         ($1,$3,'case-scope','2035-01-08T10:00:00Z','2035-01-08T11:00:00Z','confirmado',$7),
         ($1,$4,'case-scope','2035-01-08T11:00:00Z','2035-01-08T12:00:00Z','confirmado',$8),
         ($1,$5,'case-scope','2035-01-08T12:00:00Z','2035-01-08T13:00:00Z','confirmado',NULL)
       RETURNING id,assigned_member_id`,
      [
        tenantId,
        betoLeadId,
        juliaLeadId,
        customLeadId,
        unassignedLeadId,
        betoMemberId,
        juliaMemberId,
        customMemberId
      ]
    );
    juliaAppointmentId = appointments.rows.find(
      (appointment) => appointment.assigned_member_id === juliaMemberId
    )!.id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  [rootCookie, ownerCookie, adminCookie, supervisorCookie, betoCookie, juliaCookie, customCookie] = await Promise.all([
    login(emails.root),
    login(emails.owner),
    login(emails.admin),
    login(emails.supervisor),
    login(emails.beto),
    login(emails.julia),
    login(emails.custom)
  ]);
  const rootWorkspace = await app.inject({
    method: "POST",
    url: "/workspaces/switch",
    headers: { cookie: rootCookie },
    payload: { workspaceId: tenantId }
  });
  expect(rootWorkspace.statusCode).toBe(200);
  const rootValue = rootWorkspace.headers["set-cookie"]!;
  rootCookie = (Array.isArray(rootValue) ? rootValue[0] : rootValue).split(";")[0];
});

afterAll(async () => {
  await pool.query(
    "DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email=ANY($1::text[]))",
    [Object.values(emails)]
  );
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [Object.values(emails)]);
  await app.close();
  await pool.end();
});

describe("conversation case scope", () => {
  it("gives the protected SUPERVISOR role exact operational permissions without administration", async () => {
    const me = await app.inject({ url: "/me", headers: { cookie: supervisorCookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().activeWorkspace).toMatchObject({ role: "SUPERVISOR" });
    expect(new Set(me.json().permissions)).toEqual(new Set(SUPERVISOR_PERMISSIONS));
    expect(me.json().permissions).toEqual(expect.arrayContaining([
      "conversations.read",
      "conversations.reply",
      "leads.create",
      "appointments.read",
      "appointments.create",
      "appointments.notes.manage"
    ]));
    expect(me.json().permissions).not.toEqual(expect.arrayContaining([
      "workspace.update",
      "members.read",
      "members.update",
      "roles.read",
      "roles.update",
      "api_keys.manage",
      "connection.manage",
      "agent.manage"
    ]));

    const role = await pool.query<{
      is_owner_role: boolean;
      is_system: boolean;
      permissions: string[];
    }>(
      `SELECT role.is_owner_role,role.is_system,
              array_agg(permission.permission_key ORDER BY permission.permission_key) permissions
       FROM workspace_roles role
       JOIN workspace_role_permissions permission ON permission.role_id=role.id
       WHERE role.workspace_id=$1 AND role.name='SUPERVISOR'
       GROUP BY role.id`,
      [tenantId]
    );
    expect(role.rows[0]).toMatchObject({ is_owner_role: false, is_system: true });
    expect(new Set(role.rows[0].permissions)).toEqual(new Set(SUPERVISOR_PERMISSIONS));

    expect((await app.inject({
      url: "/workspaces/current/members",
      headers: { cookie: supervisorCookie }
    })).statusCode).toBe(403);
    expect((await app.inject({
      url: "/workspaces/current/roles",
      headers: { cookie: supervisorCookie }
    })).statusCode).toBe(403);

    const attendants = await app.inject({
      url: "/scheduling/config/attendants",
      headers: { cookie: supervisorCookie }
    });
    expect(attendants.statusCode).toBe(200);
    expect(attendants.json().attendants.map(
      (attendant: { member_id: string }) => attendant.member_id
    )).toEqual(expect.arrayContaining([betoMemberId, juliaMemberId, customMemberId]));
    expect(attendants.json().attendants.filter(
      (attendant: { selected: boolean }) => attendant.selected
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ member_id: betoMemberId, cor_agenda: "#2563EB" }),
      expect.objectContaining({ member_id: juliaMemberId, cor_agenda: "#2563EB" }),
      expect.objectContaining({ member_id: customMemberId, cor_agenda: "#2563EB" })
    ]));

    const roles = await app.inject({
      url: "/workspaces/current/roles",
      headers: { cookie: rootCookie }
    });
    expect(roles.statusCode).toBe(200);
    const supervisorRole = roles.json().roles.find((item: { name: string }) => item.name === "SUPERVISOR");
    expect(supervisorRole).toMatchObject({ is_system: true, is_owner_role: false });
    expect((await app.inject({
      method: "PUT",
      url: `/workspaces/current/roles/${supervisorRole.id}`,
      headers: { cookie: rootCookie },
      payload: {
        name: "SUPERVISOR ALTERADO",
        description: "Não deve mudar",
        permissions: ["workspace.update"]
      }
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "DELETE",
      url: `/workspaces/current/roles/${supervisorRole.id}`,
      headers: { cookie: rootCookie }
    })).statusCode).toBe(409);
  });

  it("limits lists and dashboard indicators to the operator's own cases", async () => {
    const betoList = await app.inject({
      url: "/conversations?filter=all",
      headers: { cookie: betoCookie }
    });
    expect(betoList.statusCode).toBe(200);
    expect(betoList.json().conversations.map((row: { id: string }) => row.id)).toEqual([
      betoConversationId
    ]);
    const unassigned = await app.inject({
      url: "/conversations?filter=unassigned",
      headers: { cookie: betoCookie }
    });
    expect(unassigned.json().conversations).toEqual([]);

    const dashboard = await app.inject({ url: "/dashboard", headers: { cookie: betoCookie } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().counts).toMatchObject({
      open: 1,
      handoff: 1,
      handoff_unassigned: 0,
      messagesToday: 1
    });
    expect(dashboard.json().handoffs.map((row: { id: string }) => row.id)).toEqual([
      betoConversationId
    ]);
    expect(dashboard.json().commercial.scope).toMatchObject({
      type: "mine"
    });
    expect(dashboard.json().commercial.team.map((row: { user_id: string }) => row.user_id)).toEqual([
      betoUserId
    ]);

    const ownerList = await app.inject({
      url: "/conversations?filter=all",
      headers: { cookie: ownerCookie }
    });
    expect(ownerList.json().conversations.map((row: { id: string }) => row.id)).toEqual(
      expect.arrayContaining([
        betoConversationId,
        juliaConversationId,
        customConversationId,
        unassignedConversationId
      ])
    );

    const supervisorList = await app.inject({
      url: "/conversations?filter=all",
      headers: { cookie: supervisorCookie }
    });
    expect(supervisorList.statusCode).toBe(200);
    expect(supervisorList.json().conversations.map((row: { id: string }) => row.id)).toEqual(
      expect.arrayContaining([
        betoConversationId,
        juliaConversationId,
        customConversationId,
        unassignedConversationId
      ])
    );
    expect((await app.inject({
      url: `/conversations/${juliaConversationId}/messages`,
      headers: { cookie: supervisorCookie }
    })).statusCode).toBe(200);
  });

  it("returns 404 for foreign IDs across details, media and mutations", async () => {
    const requests = [
      { method: "GET", url: `/conversations/${juliaConversationId}/messages` },
      { method: "GET", url: `/conversations/${juliaConversationId}/messages/v2` },
      {
        method: "GET",
        url: `/conversations/${juliaConversationId}/messages/${juliaMessageId}/media`
      },
      { method: "PATCH", url: `/conversations/${juliaConversationId}/signature`, payload: { enabled: true } },
      { method: "PATCH", url: `/conversations/${juliaConversationId}/reactivate` },
      { method: "PATCH", url: `/conversations/${juliaConversationId}/pause` },
      { method: "PATCH", url: `/conversations/${juliaConversationId}/claim` },
      ...[
        betoUserId,
        randomUUID(),
        null
      ].map((userId) => ({
        method: "PATCH" as const,
        url: `/conversations/${juliaConversationId}/assign`,
        payload: { userId }
      })),
      { method: "PATCH", url: `/conversations/${juliaConversationId}/resolve` },
      { method: "PATCH", url: `/conversations/${juliaConversationId}/reopen` },
      {
        method: "POST",
        url: `/conversations/${juliaConversationId}/messages`,
        payload: { text: "Não pode vazar" }
      }
    ] as const;
    for (const request of requests) {
      const response = await app.inject({
        ...request,
        headers: { cookie: betoCookie, "idempotency-key": randomUUID() }
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(404);
    }
  });

  it("applies own-case isolation to custom roles too", async () => {
    const list = await app.inject({ url: "/conversations", headers: { cookie: customCookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().conversations.map((row: { id: string }) => row.id)).toEqual([
      customConversationId
    ]);
    expect((await app.inject({
      url: `/conversations/${betoConversationId}/messages`,
      headers: { cookie: customCookie }
    })).statusCode).toBe(404);
  });

  it("lists only active eligible pool members, regardless of availability", async () => {
    const response = await app.inject({
      url: "/conversations/assignees",
      headers: { cookie: betoCookie }
    });
    expect(response.statusCode).toBe(200);
    const ids = response.json().assignees.map((row: { id: string }) => row.id);
    expect(ids).toEqual(expect.arrayContaining([betoUserId, juliaUserId, customUserId]));
    expect(response.json().assignees.map((row: { email: string }) => row.email)).not.toContain(
      emails.inactive
    );
  });

  it("keeps an unassigned case unassigned when a manager resolves it", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/conversations/${unassignedConversationId}/resolve`,
      headers: { cookie: ownerCookie }
    });
    expect(response.statusCode).toBe(200);
    expect((await pool.query(
      "SELECT status,assigned_user_id,claimed_at FROM conversations WHERE id=$1",
      [unassignedConversationId]
    )).rows[0]).toEqual({
      status: "closed",
      assigned_user_id: null,
      claimed_at: null
    });
  });

  it("shows workspace alerts to managers without exposing the alerts panel to operators", async () => {
    const alertId = (await pool.query<{ id: string }>(
      `INSERT INTO system_alerts(tenant_id,message,audience)
       VALUES($1,'Alerta sem responsável','workspace')
       RETURNING id`,
      [tenantId]
    )).rows[0].id;
    await pool.query(
      `DELETE FROM system_alert_receipts
       WHERE alert_id=$1
         AND user_id IN (
           $2,
           (SELECT id FROM users WHERE email=$3)
         )`,
      [alertId, betoUserId, emails.admin]
    );
    const managerAlerts = await app.inject({ url: "/alerts", headers: { cookie: ownerCookie } });
    expect(managerAlerts.statusCode).toBe(200);
    expect(managerAlerts.json().alerts.map((alert: { id: string }) => alert.id)).toContain(alertId);
    const adminAlerts = await app.inject({ url: "/alerts", headers: { cookie: adminCookie } });
    expect(adminAlerts.statusCode).toBe(200);
    expect(adminAlerts.json().alerts.map((alert: { id: string }) => alert.id)).toContain(alertId);
    const supervisorAlerts = await app.inject({ url: "/alerts", headers: { cookie: supervisorCookie } });
    expect(supervisorAlerts.statusCode).toBe(200);
    expect(supervisorAlerts.json().alerts.map((alert: { id: string }) => alert.id)).toContain(alertId);
    const operatorAlerts = await app.inject({ url: "/alerts", headers: { cookie: betoCookie } });
    expect(operatorAlerts.statusCode).toBe(403);
  });

  it("applies the manager, OPERADOR and custom-role matrix to lead lists and IDs", async () => {
    const allLeadIds = [betoLeadId, juliaLeadId, customLeadId, unassignedLeadId];
    for (const [role, cookie] of [
      ["ROOT", rootCookie],
      ["OWNER", ownerCookie],
      ["ADMIN", adminCookie],
      ["SUPERVISOR", supervisorCookie]
    ] as const) {
      const list = await app.inject({ url: "/scheduling/leads", headers: { cookie } });
      expect(list.statusCode, `${role} lead list`).toBe(200);
      expect(list.json().leads.map((lead: { id: string }) => lead.id)).toEqual(
        expect.arrayContaining(allLeadIds)
      );

      const detail = await app.inject({
        url: `/scheduling/leads/${juliaLeadId}`,
        headers: { cookie }
      });
      expect(detail.statusCode, `${role} foreign lead detail`).toBe(200);
      expect(detail.json().lead.id).toBe(juliaLeadId);

      const mutation = await app.inject({
        method: "PATCH",
        url: `/scheduling/leads/${juliaLeadId}/status`,
        headers: { cookie },
        payload: { status: "em_atendimento" }
      });
      expect(mutation.statusCode, `${role} foreign lead mutation`).toBe(200);
    }

    const operatorList = await app.inject({
      url: "/scheduling/leads",
      headers: { cookie: betoCookie }
    });
    expect(operatorList.statusCode).toBe(200);
    expect(operatorList.json().leads.map((lead: { id: string }) => lead.id)).toEqual([betoLeadId]);
    expect((await app.inject({
      url: `/scheduling/leads/${juliaLeadId}`,
      headers: { cookie: betoCookie }
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "PATCH",
      url: `/scheduling/leads/${juliaLeadId}/status`,
      headers: { cookie: betoCookie },
      payload: { status: "perdido" }
    })).statusCode).toBe(404);

    const customList = await app.inject({
      url: "/scheduling/leads",
      headers: { cookie: customCookie }
    });
    expect(customList.statusCode).toBe(200);
    expect(customList.json().leads.map((lead: { id: string }) => lead.id)).toEqual([customLeadId]);
    expect((await app.inject({
      url: `/scheduling/leads/${customLeadId}`,
      headers: { cookie: customCookie }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "PATCH",
      url: `/scheduling/leads/${customLeadId}/status`,
      headers: { cookie: customCookie },
      payload: { status: "em_atendimento" }
    })).statusCode).toBe(200);
    expect((await app.inject({
      url: `/scheduling/leads/${juliaLeadId}`,
      headers: { cookie: customCookie }
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "PATCH",
      url: `/scheduling/leads/${juliaLeadId}/status`,
      headers: { cookie: customCookie },
      payload: { status: "perdido" }
    })).statusCode).toBe(404);
  });

  it("applies the same role matrix to agenda lists and appointment mutations", async () => {
    const agendaUrl =
      "/scheduling/appointments?unidade_id=case-scope" +
      "&inicio=2035-01-08T00:00:00.000Z&fim=2035-01-09T00:00:00.000Z";
    for (const [role, cookie] of [
      ["ROOT", rootCookie],
      ["OWNER", ownerCookie],
      ["ADMIN", adminCookie],
      ["SUPERVISOR", supervisorCookie]
    ] as const) {
      const list = await app.inject({ url: agendaUrl, headers: { cookie } });
      expect(list.statusCode, `${role} appointment list`).toBe(200);
      expect(list.json().agendamentos).toHaveLength(4);
      if (role === "SUPERVISOR") {
        expect(list.json().agendamentos.filter(
          (appointment: { responsavel: unknown }) => appointment.responsavel
        )).toEqual(expect.arrayContaining([
          expect.objectContaining({
            responsavel: expect.objectContaining({ cor_agenda: "#2563EB" })
          })
        ]));
      }

      const directMutation = await app.inject({
        method: "PATCH",
        url: `/scheduling/appointments/${juliaAppointmentId}/reagendar`,
        headers: { cookie },
        payload: {}
      });
      expect(directMutation.statusCode, `${role} appointment scope`).toBe(400);
    }

    const operatorList = await app.inject({ url: agendaUrl, headers: { cookie: betoCookie } });
    expect(operatorList.statusCode).toBe(200);
    expect(operatorList.json().agendamentos.map(
      (appointment: { responsavel: { member_id: string } | null }) => appointment.responsavel?.member_id
    )).toEqual([betoMemberId]);
    expect((await app.inject({
      method: "PATCH",
      url: `/scheduling/appointments/${juliaAppointmentId}/reagendar`,
      headers: { cookie: betoCookie },
      payload: {}
    })).statusCode).toBe(404);

    const customList = await app.inject({ url: agendaUrl, headers: { cookie: customCookie } });
    expect(customList.statusCode).toBe(200);
    expect(customList.json().agendamentos.map(
      (appointment: { responsavel: { member_id: string } | null }) => appointment.responsavel?.member_id
    )).toEqual([customMemberId]);
    expect((await app.inject({
      method: "PATCH",
      url: `/scheduling/appointments/${juliaAppointmentId}/reagendar`,
      headers: { cookie: customCookie },
      payload: {}
    })).statusCode).toBe(404);
  });

  it("lets operators transfer only an owned case and never unassign it", async () => {
    const unassign = await app.inject({
      method: "PATCH",
      url: `/conversations/${betoConversationId}/assign`,
      headers: { cookie: betoCookie },
      payload: { userId: null }
    });
    expect(unassign.statusCode).toBe(403);

    const transfer = await app.inject({
      method: "PATCH",
      url: `/conversations/${betoConversationId}/assign`,
      headers: { cookie: betoCookie },
      payload: { userId: juliaUserId }
    });
    expect(transfer.statusCode).toBe(200);
    expect((await app.inject({
      url: `/conversations/${betoConversationId}/messages`,
      headers: { cookie: betoCookie }
    })).statusCode).toBe(404);
    expect((await app.inject({
      url: `/conversations/${betoConversationId}/messages`,
      headers: { cookie: juliaCookie }
    })).statusCode).toBe(200);

    const managerUnassign = await app.inject({
      method: "PATCH",
      url: `/conversations/${betoConversationId}/assign`,
      headers: { cookie: ownerCookie },
      payload: { userId: null }
    });
    expect(managerUnassign.statusCode).toBe(200);
    expect((await app.inject({
      url: `/conversations/${betoConversationId}/messages`,
      headers: { cookie: juliaCookie }
    })).statusCode).toBe(404);
  });
});
