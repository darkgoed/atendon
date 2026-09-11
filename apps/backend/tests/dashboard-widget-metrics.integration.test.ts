import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp(); const suffix = randomUUID();
let tenantA = ""; let tenantB = ""; let ownerA = ""; let operatorA = ""; let ownerB = "";
let memberA = ""; let memberB = ""; let unit = ""; let session = "";
let conversationSequence = 0;
let ownerCookie = ""; let operatorCookie = ""; let ownerBCookie = "";
const period = { period: "custom", start: "2025-01-01", end: "2025-02-01" };

type Row = { id: string };
async function member(c: pg.PoolClient, tenant: string, user: string, role: string) {
  const r = await c.query<Row>(`INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
    SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name=$3 RETURNING id`, [tenant, user, role]);
  return r.rows[0].id;
}
async function lead(c: pg.PoolClient, values: { tenant: string; phone: string; name: string; source: string; created: string; member?: string; status?: string; outcome?: string; sale?: string; lossReason?: string; next?: string; attribution?: object }) {
  const result = await c.query<Row>(`INSERT INTO scheduling_leads
    (tenant_id,phone,name,source,created_at,assigned_member_id,status,commercial_outcome,sale_value,loss_reason,next_action_at,facebook_attribution,pipeline_stage_id)
    VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,'novo'),$8,$9,$10,$11,COALESCE($12::jsonb,'{}'::jsonb),(SELECT id FROM pipeline_stages WHERE tenant_id=$1 ORDER BY position LIMIT 1)) RETURNING id`,
    [values.tenant, values.phone, values.name, values.source, values.created, values.member ?? null, values.status ?? null, values.outcome ?? null, values.sale ?? null, values.lossReason ?? null, values.next ?? null, JSON.stringify(values.attribution ?? {})]);
  return result.rows[0].id;
}
async function conversation(c: pg.PoolClient, tenant: string, leadId: string, assigned: string | null, created: string, status: string) {
  const phone = `551100000${String(++conversationSequence).padStart(3, "0")}`;
  return (await c.query<Row>(`INSERT INTO conversations(tenant_id,session_id,lead_id,contact_phone,contact_name,assigned_user_id,created_at,last_message_at,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8) RETURNING id`, [tenant, session, leadId, phone, "Contato", assigned, created, status])).rows[0].id;
}

beforeAll(async () => {
  await app.ready(); const c = await pool.connect();
  try {
    await c.query("BEGIN");
    tenantA = (await c.query<Row>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`metric-a-${suffix}`])).rows[0].id;
    tenantB = (await c.query<Row>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`metric-b-${suffix}`])).rows[0].id;
    await c.query(`INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled) VALUES
      ($1,'dashboard_v1',true),($1,'dashboard_widgets_v1',true),($1,'leads_v1',true),($1,'appointments_v1',true),
      ($2,'dashboard_v1',true),($2,'dashboard_widgets_v1',true),($2,'leads_v1',true),($2,'appointments_v1',true)
      ON CONFLICT (tenant_id,flag_key) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()`, [tenantA, tenantB]);
    await ensureWorkspaceDefaultRoles(c, tenantA); await ensureWorkspaceDefaultRoles(c, tenantB);
    ownerA = (await c.query<Row>("INSERT INTO users(email,name,status) VALUES($1,'Owner A','active') RETURNING id", [`metric-owner-a-${suffix}@test.local`])).rows[0].id;
    operatorA = (await c.query<Row>("INSERT INTO users(email,name,status) VALUES($1,'Operator A','active') RETURNING id", [`metric-operator-a-${suffix}@test.local`])).rows[0].id;
    ownerB = (await c.query<Row>("INSERT INTO users(email,name,status) VALUES($1,'Owner B','active') RETURNING id", [`metric-owner-b-${suffix}@test.local`])).rows[0].id;
    memberA = await member(c, tenantA, ownerA, "OWNER"); memberB = await member(c, tenantA, operatorA, "OPERADOR"); await member(c, tenantB, ownerB, "OWNER");
    unit = `metric-${suffix}`;
    await c.query(`INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days) VALUES($1,$2,'Metric unit','08:00','18:00',ARRAY[0,1,2,3,4,5,6]::smallint[])`, [tenantA, unit]);
    await c.query("INSERT INTO scheduling_google_meet_closers(tenant_id,member_id) VALUES($1,$2),($1,$3)", [tenantA, memberA, memberB]);
    session = (await c.query<Row>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantA])).rows[0].id;
    const l1 = await lead(c, { tenant: tenantA, phone: "551100000001", name: "Paid sale", source: "facebook", created: "2025-01-05T10:00:00Z", member: memberA, status: "fechado", outcome: "fechado", sale: "100.50", attribution: { campaign: "paid" } });
    const l2 = await lead(c, { tenant: tenantA, phone: "551100000002", name: "Referral lost", source: "indica-amigo", created: "2025-01-06T10:00:00Z", member: memberB, status: "perdido", outcome: "nao_avancou", lossReason: "outro", next: "2025-01-10T10:00:00Z" });
    const l3 = await lead(c, { tenant: tenantA, phone: "551100000003", name: "Organic sale", source: "whatsapp", created: "2025-01-07T10:00:00Z", member: memberB, status: "fechado", outcome: "fechado", sale: "25.00", next: "2099-01-01T00:00:00Z" });
    const l4 = await lead(c, { tenant: tenantA, phone: "551100000004", name: "Outside", source: "google", created: "2024-12-01T10:00:00Z", member: memberA });
    const l5 = await lead(c, { tenant: tenantA, phone: "551100000005", name: "Other", source: "google", created: "2025-01-08T10:00:00Z", member: memberA });
    await c.query("UPDATE scheduling_leads SET commercial_updated_at='2025-01-15T10:00:00Z' WHERE id IN ($1,$2,$3)", [l1, l2, l3]);
    await conversation(c, tenantA, l1, operatorA, "2025-01-05T11:00:00Z", "open");
    await conversation(c, tenantA, l2, operatorA, "2025-01-06T11:00:00Z", "closed");
    await conversation(c, tenantA, l3, ownerA, "2025-01-07T11:00:00Z", "open");
    await conversation(c, tenantA, l4, ownerA, "2024-12-02T11:00:00Z", "open");
    await conversation(c, tenantA, l5, ownerA, "2025-01-08T11:00:00Z", "open");
    await c.query(`INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at,status,assigned_member_id,commercial_outcome,sale_value)
      VALUES($1,$2,$3,'2025-01-10T10:00:00Z','2025-01-10T11:00:00Z','concluido',$4,'fechado','100.50'),
            ($1,$5,$3,'2025-01-11T10:00:00Z','2025-01-11T11:00:00Z','no_show',$6,NULL,NULL),
            ($1,$7,$3,'2025-01-12T10:00:00Z','2025-01-12T11:00:00Z','concluido',$6,'fechado','25.00'),
            ($1,$2,$3,'2025-01-13T10:00:00Z','2025-01-13T11:00:00Z','cancelado',$4,NULL,NULL)`, [tenantA,l1,unit,memberA,l2,memberB,l3]);
    await c.query("INSERT INTO scheduling_lead_events(tenant_id,lead_id,event_type,details) VALUES($1,$2,'agendamento_reagendado',$3::jsonb)", [tenantA, l3, JSON.stringify({ appointment_id: (await c.query<Row>("SELECT id FROM scheduling_appointments WHERE lead_id=$1 AND status='concluido'", [l3])).rows[0].id })]);
    const otherLead = await lead(c, { tenant: tenantB, phone: "551100000009", name: "Other tenant", source: "facebook", created: "2025-01-05T10:00:00Z", member: (await c.query<Row>("SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [tenantB, ownerB])).rows[0].id, status: "fechado", outcome: "fechado", sale: "999.99" });
    await c.query("UPDATE scheduling_leads SET commercial_updated_at=created_at WHERE id=$1", [otherLead]);
    await c.query("UPDATE scheduling_leads SET pipeline_stage_id=(SELECT id FROM pipeline_stages WHERE tenant_id=$1 ORDER BY position LIMIT 1) WHERE id=$2", [tenantB, otherLead]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  const cookie = async (u: string, t: string, email: string, role: string) => `atendon_session=${await createSessionToken({ userId: u, tenantId: t, email, role })}`;
  ownerCookie = await cookie(ownerA, tenantA, `metric-owner-a-${suffix}@test.local`, "OWNER"); operatorCookie = await cookie(operatorA, tenantA, `metric-operator-a-${suffix}@test.local`, "OPERADOR"); ownerBCookie = await cookie(ownerB, tenantB, `metric-owner-b-${suffix}@test.local`, "OWNER");
}, 120_000);

afterAll(async () => {
  const tenants = [tenantA, tenantB].filter(Boolean);
  const users = [ownerA, operatorA, ownerB].filter(Boolean);
  if (tenants.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenants]);

  if (users.length) await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [users]);
  await pool.end(); await app.close();
});

function value(data: unknown) { return (data as { value: number }).value; }

describe("dashboard indicator values", () => {
  it("returns every one of the 25 indicators with exact non-trivial values", { timeout: 120_000 }, async () => {
    const expected: Record<string, number | object> = {
      conversations_started: 4, active_conversations: 4, new_leads: 4, pending_follow_ups: 1, overdue_follow_ups: 1,
      leads_paid_traffic: 1, leads_referral: 1, leads_organic: 1, leads_other_sources: 1,
      appointments_count: 3, attendances: 2, no_shows: 1, reschedules: 1, attendance_rate: 66.7,
      sales_count: 2, sales_value: 12550, average_ticket: 6275, lost_sales: 1, conversion_rate: 50,
      sales_paid_traffic: 1, sales_referral: 0, sales_organic: 1
    };
    for (const [key, wanted] of Object.entries(expected)) {
      const response = await app.inject({ url: `/dashboard/widgets/${key}`, query: period, headers: { cookie: ownerCookie } });
      expect(response.statusCode, `${key}: ${response.body}`).toBe(200);
      expect(value(response.json().data), key).toBe(wanted);
      if (["sales_value", "average_ticket"].includes(key)) expect(response.json().data.currency).toBe("BRL");
    }
    for (const key of ["sales_by_seller", "sales_value_by_seller", "conversion_by_seller"]) {
      const response = await app.inject({ url: `/dashboard/widgets/${key}`, query: period, headers: { cookie: ownerCookie } });
      expect(response.statusCode, `${key}: ${response.body}`).toBe(200);
      const items = response.json().data.items;
      expect(items).toEqual(expect.arrayContaining([{ member_id: memberA, name: "Owner A", value: expect.any(Number) }, { member_id: memberB, name: "Operator A", value: expect.any(Number) }]));
      expect(items.map((item: { member_id: string }) => item.member_id)).toHaveLength(2);
      if (key === "sales_by_seller") expect(Object.fromEntries(items.map((i: { member_id: string; value: number }) => [i.member_id, i.value]))).toEqual({ [memberA]: 1, [memberB]: 1 });
      if (key === "sales_value_by_seller") expect(Object.fromEntries(items.map((i: { member_id: string; value: number }) => [i.member_id, i.value]))).toEqual({ [memberA]: 10050, [memberB]: 2500 });
      if (key === "conversion_by_seller") expect(Object.fromEntries(items.map((i: { member_id: string; value: number }) => [i.member_id, i.value]))).toEqual({ [memberA]: 100, [memberB]: 100 });
    }
  });

  it("applies tenant and mine scope to values and keeps percentages finite", async () => {
    const mine = await app.inject({ url: "/dashboard/widgets/sales_value", query: period, headers: { cookie: operatorCookie } });
    expect(mine.statusCode).toBe(200); expect(mine.json().data).toMatchObject({ value: 2500, currency: "BRL" });
    const other = await app.inject({ url: "/dashboard/widgets/sales_value", query: period, headers: { cookie: ownerBCookie } });
    expect(other.statusCode).toBe(200); expect(other.json().data).toMatchObject({ value: 99999, currency: "BRL" });
    const zero = await app.inject({ url: "/dashboard/widgets/attendance_rate", query: { period: "custom", start: "2024-01-01", end: "2024-02-01" }, headers: { cookie: ownerCookie } });
    expect(zero.statusCode).toBe(200); expect(zero.json().data.value).toBe(0); expect(Number.isFinite(zero.json().data.value)).toBe(true);
    const hidden = await app.inject({ method: "PUT", url: "/dashboard/widgets/layout", headers: { cookie: ownerCookie }, payload: { items: [{ key: "sales_value", order: 0, visible: false, size: "small" }] } });
    expect(hidden.statusCode).toBe(200);
    const same = await app.inject({ url: "/dashboard/widgets/sales_value", query: period, headers: { cookie: ownerCookie } });
    expect(same.json().data.value).toBe(12550);
  });
});
