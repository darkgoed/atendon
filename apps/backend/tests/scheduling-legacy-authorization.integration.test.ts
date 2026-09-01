import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg, { type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InjectOptions } from "fastify";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { atualizarStatusLead } from "../src/modules/scheduling/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const password = "legacy-password";
const suffix = randomUUID();
let tenantA: string; let tenantB: string; let unitA: string; let unitB: string;
let ownerCookie: string; let operatorCookie: string; let emptyCookie: string;
let ownerMember: string; let operatorMember: string; let secondOperatorMember: string;
let ownLead: string; let otherLead: string; let foreignLead: string;
let ownAppointment: string; let otherAppointment: string; let foreignAppointment: string;
const emails = [`legacy-owner-${suffix}@test.local`, `legacy-operator-${suffix}@test.local`, `legacy-empty-${suffix}@test.local`, `legacy-second-operator-${suffix}@test.local`];
const phoneDigits = suffix.replace(/\D/g, "").slice(0, 7).padEnd(7, "7");
const phones = [`55119${phoneDigits}1`, `55119${phoneDigits}2`, `55119${phoneDigits}3`];

async function login(email: string) { const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } }); expect(response.statusCode).toBe(200); const value = response.headers["set-cookie"]!; return (Array.isArray(value) ? value[0] : value).split(";")[0]; }
async function row<T extends QueryResultRow>(sql: string, values: unknown[]) { return (await pool.query<T>(sql, values)).rows[0]; }

beforeAll(async () => {
  await app.ready();
  tenantA = (await row<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`legacy-a-${suffix}`])).id;
  tenantB = (await row<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`legacy-b-${suffix}`])).id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantA); await ensureWorkspaceDefaultRoles(client, tenantB);
    const passwordHash = await hash(password, 4); const users: { id: string }[] = [];
    for (const email of emails) users.push((await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [email, passwordHash])).rows[0]);
    const emptyRole = (await client.query<{ id: string }>("INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,$2,'no permissions') RETURNING id", [tenantA, `EMPTY-${suffix}`])).rows[0].id;
    const operatorScopeRole = (await client.query<{ id: string }>("INSERT INTO workspace_roles(workspace_id,name,description,is_owner_role,is_system) VALUES($1,$2,'all matrix permissions, mine scope',false,false) RETURNING id", [tenantA, `MATRIX-OPERATOR-${suffix}`])).rows[0].id;
    const matrixPermissions = ["leads.create", "categories.read", "partners.read", "leads.send_partner_proposal", "availability.read", "appointments.create", "appointments.reschedule", "appointments.cancel", "leads.update_status", "leads.transfer"];
    await client.query("INSERT INTO workspace_role_permissions(role_id,permission_key) SELECT $1, unnest($2::text[])", [operatorScopeRole, matrixPermissions]);
    ownerMember = (await client.query<{ id: string }>("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER' RETURNING id", [tenantA, users[0].id])).rows[0].id;
    operatorMember = (await client.query<{ id: string }>("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now()) RETURNING id", [tenantA, users[1].id, operatorScopeRole])).rows[0].id;
    secondOperatorMember = (await client.query<{ id: string }>("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR' RETURNING id", [tenantA, users[3].id])).rows[0].id;
    await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())", [tenantA, users[2].id, emptyRole]);
    await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'", [tenantB, users[0].id]);
    unitA = `legacy-${suffix}`; await client.query("INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days) VALUES($1,$2,'Legacy','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[])", [tenantA, unitA]);
    unitB = `legacy-b-${suffix}`; await client.query("INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days) VALUES($1,$2,'Legacy B','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[])", [tenantB, unitB]);
    for (const member of [ownerMember, operatorMember, secondOperatorMember]) await client.query("INSERT INTO scheduling_google_meet_closers(tenant_id,member_id,availability_status) VALUES($1,$2,'available')", [tenantA, member]);
    ownLead = (await client.query<{ id: string }>("INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source,assigned_member_id) VALUES($1,$2,'Own',$3,'novo','test',$4) RETURNING id", [tenantA, phones[0], unitA, operatorMember])).rows[0].id;
    otherLead = (await client.query<{ id: string }>("INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source,assigned_member_id) VALUES($1,$2,'Other',$3,'novo','test',$4) RETURNING id", [tenantA, phones[1], unitA, secondOperatorMember])).rows[0].id;
    foreignLead = (await client.query<{ id: string }>("INSERT INTO scheduling_leads(tenant_id,phone,name,status,source) VALUES($1,$2,'Foreign','novo','test') RETURNING id", [tenantB, phones[2]])).rows[0].id;
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  ownerCookie = await login(emails[0]); operatorCookie = await login(emails[1]); emptyCookie = await login(emails[2]);
  ownAppointment = (await pool.query<{ id: string }>("INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at,status,assigned_member_id) VALUES($1,$2,$3,'2035-01-01T12:00:00Z','2035-01-01T13:00:00Z','confirmado',$4) RETURNING id", [tenantA, ownLead, unitA, operatorMember])).rows[0].id;
  otherAppointment = (await pool.query<{ id: string }>("INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at,status,assigned_member_id) VALUES($1,$2,$3,'2035-01-02T12:00:00Z','2035-01-02T13:00:00Z','confirmado',$4) RETURNING id", [tenantA, otherLead, unitA, secondOperatorMember])).rows[0].id;
  foreignAppointment = (await pool.query<{ id: string }>("INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at,status,assigned_member_id) VALUES($1,$2,$3,'2035-01-03T12:00:00Z','2035-01-03T13:00:00Z','confirmado',NULL) RETURNING id", [tenantB, foreignLead, unitB])).rows[0].id;
});
afterAll(async () => { await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email=ANY($1::text[]))", [emails]); await pool.query("DELETE FROM tenants WHERE id IN($1,$2)", [tenantA, tenantB]); await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [emails]); await app.close(); await pool.end(); });

describe("legacy scheduling authorization against Fastify and PostgreSQL", () => {
  type RequestMethod = "GET" | "POST" | "PATCH" | "DELETE";
  type RequestPayload = Exclude<InjectOptions["payload"], undefined | null>;
  const inject = async (method: RequestMethod, url: string, cookie: string, payload?: RequestPayload) => {
    const options: InjectOptions = { method: method as InjectOptions["method"], url, headers: { cookie } };
    if (payload !== undefined) options.payload = payload;
    return app.inject(options as never);
  };
  it("denies the 10 matrix routes without permission", async () => {
    const routes: Array<[RequestMethod, string, RequestPayload?]> = [["POST", "/leads", { nome: "x", telefone: "+559****9999" }], ["GET", "/categorias"], ["GET", "/parceiros"], ["POST", `/leads/${ownLead}/proposta-parceiro`, { parceiro_id: "x" }], ["GET", `/unidades/${unitA}/horarios?data=2035-01-01`], ["POST", "/agendamentos", { lead_id: ownLead, unidade_id: unitA, start: "2035-03-01T12:00:00Z" }], ["PATCH", `/agendamentos/${ownAppointment}/reagendar`, { start: "2035-04-01T12:00:00Z" }], ["DELETE", `/agendamentos/${ownAppointment}`], ["PATCH", `/leads/${ownLead}/status`, { status: "novo" }], ["POST", `/leads/${ownLead}/transferir`, { motivo: "x" }]];
    for (const [method, url, payload] of routes) expect((await inject(method, url, emptyCookie, payload)).statusCode, `${method} ${url}`).toBe(403);
  });
  it("rejects divergent tenant queries", async () => {
    const routes = ["/categorias", "/parceiros", `/unidades/${unitA}/horarios?data=2035-01-01`];
    for (const url of routes) expect((await inject("GET", `${url}${url.includes("?") ? "&" : "?"}tenant=${tenantB}`, ownerCookie)).statusCode, `GET ${url}`).toBe(403);
  });
  it("returns 404 and leaves every foreign/non-owned object unchanged", async () => {
    const leadBefore = (await pool.query("SELECT id,status,assigned_member_id,updated_at FROM scheduling_leads WHERE id=ANY($1::uuid[])", [[otherLead, foreignLead]])).rows;
    const apptBefore = (await pool.query("SELECT id,start_at,end_at,status,updated_at FROM scheduling_appointments WHERE id=ANY($1::uuid[])", [[otherAppointment, foreignAppointment]])).rows;
    const cases: Array<[RequestMethod, string, RequestPayload?]> = [["POST", `/leads/${otherLead}/proposta-parceiro`, { parceiro_id: "x" }], ["POST", `/leads/${foreignLead}/proposta-parceiro`, { parceiro_id: "x" }], ["POST", "/leads", { telefone: phones[1], nome: "changed" }], ["POST", "/agendamentos", { lead_id: otherLead, unidade_id: unitA, start: "2035-06-01T12:00:00Z" }], ["POST", "/agendamentos", { lead_id: foreignLead, unidade_id: unitB, start: "2035-06-02T12:00:00Z" }], ["PATCH", `/agendamentos/${otherAppointment}/reagendar`, { start: "2035-07-01T12:00:00Z" }], ["PATCH", `/agendamentos/${foreignAppointment}/reagendar`, { start: "2035-07-02T12:00:00Z" }], ["DELETE", `/agendamentos/${otherAppointment}`], ["DELETE", `/agendamentos/${foreignAppointment}`], ["PATCH", `/leads/${otherLead}/status`, { status: "fechado" }], ["PATCH", `/leads/${foreignLead}/status`, { status: "fechado" }], ["POST", `/leads/${otherLead}/transferir`, { motivo: "x" }], ["POST", `/leads/${foreignLead}/transferir`, { motivo: "x" }]];
    for (const [method, url, payload] of cases) expect((await inject(method, url, operatorCookie, payload)).statusCode, `${method} ${url}`).toBe(404);
    expect((await pool.query("SELECT id,status,assigned_member_id,updated_at FROM scheduling_leads WHERE id=ANY($1::uuid[])", [[otherLead, foreignLead]])).rows).toEqual(leadBefore);
    expect((await pool.query("SELECT id,start_at,end_at,status,updated_at FROM scheduling_appointments WHERE id=ANY($1::uuid[])", [[otherAppointment, foreignAppointment]])).rows).toEqual(apptBefore);
    expect((await pool.query("SELECT count(*)::int AS count FROM scheduling_appointments WHERE tenant_id=$1", [tenantA])).rows[0].count).toBe(2);
  });
  it("rechecks assignment under the service lock before mutating", async () => {
    const before = (await pool.query("SELECT status,updated_at FROM scheduling_leads WHERE id=$1", [ownLead])).rows[0];
    const eventCount = (await pool.query("SELECT count(*)::int AS count FROM scheduling_lead_events WHERE lead_id=$1", [ownLead])).rows[0].count;
    await expect(atualizarStatusLead(tenantA, ownLead, "em_atendimento", undefined, secondOperatorMember)).rejects.toMatchObject({ statusCode: 404 });
    expect((await pool.query("SELECT status,updated_at FROM scheduling_leads WHERE id=$1", [ownLead])).rows[0]).toEqual(before);
    expect((await pool.query("SELECT count(*)::int AS count FROM scheduling_lead_events WHERE lead_id=$1", [ownLead])).rows[0].count).toBe(eventCount);
  });
  it("allows owner workspace access and operator access to own appointment", async () => {
    expect((await inject("PATCH", `/leads/${otherLead}/status`, ownerCookie, { status: "novo" })).statusCode).toBe(200);
    expect((await inject("DELETE", `/agendamentos/${ownAppointment}`, operatorCookie)).statusCode).toBe(200);
  });
});
