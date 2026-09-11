import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { applyStructuredStageEffects } from "../src/modules/commercial-journey/service.js";
import { captureClosedSalePostSaleClient } from "../src/modules/post-sales/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const suffix = randomUUID();
let tenantId = "";
let foreignTenantId = "";
let ownerUserId = "";
let operatorUserId = "";
let limitedUserId = "";
let foreignOwnerUserId = "";
let operatorMemberId = "";
let whatsappSessionId = "";
let leadId = "";
let conversationId = "";
let ownerCookie = "";
let operatorCookie = "";
let limitedCookie = "";
let foreignOwnerCookie = "";

async function cookieFor(userId: string, email: string, activeTenantId: string, role: string) {
  return `atendon_session=${await createSessionToken({ userId,tenantId: activeTenantId,email,role })}`;
}

beforeAll(async () => {
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','America/Sao_Paulo') RETURNING id",
      [`Pós-venda ${suffix}`]
    )).rows[0].id;
    foreignTenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','Pacific/Kiritimati') RETURNING id",
      [`Pós-venda estrangeiro ${suffix}`]
    )).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantId);
    await ensureWorkspaceDefaultRoles(client, foreignTenantId);
    whatsappSessionId = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label,is_primary) VALUES($1,'Principal',true) RETURNING id",
      [tenantId]
    )).rows[0].id;

    const users = await client.query<{ id: string; email: string }>(
      `INSERT INTO users(email,status) VALUES
         ($1,'active'),($2,'active'),($3,'active'),($4,'active')
       RETURNING id,email`,
      [
        `post-sales-owner-${suffix}@test.local`,
        `post-sales-operator-${suffix}@test.local`,
        `post-sales-limited-${suffix}@test.local`,
        `post-sales-foreign-${suffix}@test.local`
      ]
    );
    const byEmail = new Map(users.rows.map((row) => [row.email, row.id]));
    ownerUserId = byEmail.get(`post-sales-owner-${suffix}@test.local`)!;
    operatorUserId = byEmail.get(`post-sales-operator-${suffix}@test.local`)!;
    limitedUserId = byEmail.get(`post-sales-limited-${suffix}@test.local`)!;
    foreignOwnerUserId = byEmail.get(`post-sales-foreign-${suffix}@test.local`)!;

    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles
       WHERE workspace_id=$1 AND name='OWNER'`,
      [tenantId, ownerUserId]
    );
    operatorMemberId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles
       WHERE workspace_id=$1 AND name='OPERADOR' RETURNING id`,
      [tenantId, operatorUserId]
    )).rows[0].id;
    const limitedRoleId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_roles(workspace_id,name,description,is_system)
       VALUES($1,'PÓS-VENDA LIMITADO','Sem acesso a conversas',false) RETURNING id`,
      [tenantId]
    )).rows[0].id;
    await client.query(
      "INSERT INTO workspace_role_permissions(role_id,permission_key) VALUES($1,'post_sales.use')",
      [limitedRoleId]
    );
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       VALUES($1,$2,$3,'active',now())`,
      [tenantId, limitedUserId, limitedRoleId]
    );
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles
       WHERE workspace_id=$1 AND name='OWNER'`,
      [foreignTenantId, foreignOwnerUserId]
    );

    leadId = (await client.query<{ id: string }>(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,source,assigned_member_id)
       VALUES($1,'5511977100011','Cliente pós-venda','test',$2) RETURNING id`,
      [tenantId, operatorMemberId]
    )).rows[0].id;
    conversationId = (await client.query<{ id: string }>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,lead_id)
       VALUES($1,$2,'5511977100011','Cliente pós-venda',$3) RETURNING id`,
      [tenantId, whatsappSessionId, leadId]
    )).rows[0].id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  ownerCookie = await cookieFor(ownerUserId, `post-sales-owner-${suffix}@test.local`, tenantId, "OWNER");
  operatorCookie = await cookieFor(operatorUserId, `post-sales-operator-${suffix}@test.local`, tenantId, "OPERADOR");
  limitedCookie = await cookieFor(limitedUserId, `post-sales-limited-${suffix}@test.local`, tenantId, "PÓS-VENDA LIMITADO");
  foreignOwnerCookie = await cookieFor(foreignOwnerUserId, `post-sales-foreign-${suffix}@test.local`, foreignTenantId, "OWNER");
});

afterAll(async () => {
  await pool.query("DELETE FROM tenant_feature_flag_overrides WHERE tenant_id=ANY($1::uuid[])", [[tenantId, foreignTenantId]]);
  await pool.query("DELETE FROM audit_logs WHERE workspace_id=ANY($1::uuid[])", [[tenantId, foreignTenantId]]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantId, foreignTenantId]]);
  await pool.query(
    "DELETE FROM users WHERE id=ANY($1::uuid[])",
    [[ownerUserId, operatorUserId, limitedUserId, foreignOwnerUserId]]
  );
  await pool.end();
  await app.close();
});

describe("post-sales REST API", () => {
  let firstItemId = "";
  let secondItemId = "";
  let clientId = "";
  let entryId = "";

  it("is default-off and grants the intended default-role permissions", async () => {
    const disabled = await app.inject({ url: "/post-sales/clients", headers: { cookie: operatorCookie } });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toMatchObject({ code: "FEATURE_FLAG_DISABLED", feature: "post_sales_v1" });

    const grants = await pool.query<{ name: string; permissions: string[] }>(
      `SELECT role.name,array_agg(permission.permission_key ORDER BY permission.permission_key) permissions
       FROM workspace_roles role
       JOIN workspace_role_permissions permission ON permission.role_id=role.id
       WHERE role.workspace_id=$1 AND permission.permission_key LIKE 'post_sales.%'
       GROUP BY role.name ORDER BY role.name`,
      [tenantId]
    );
    expect(new Map(grants.rows.map((row) => [row.name, row.permissions]))).toEqual(new Map([
      ["ADMIN", ["post_sales.manage", "post_sales.use"]],
      ["OPERADOR", ["post_sales.use"]],
      ["OWNER", ["post_sales.manage", "post_sales.use"]],
      ["PÓS-VENDA LIMITADO", ["post_sales.use"]],
      ["SUPERVISOR", ["post_sales.use"]]
    ]));

    await pool.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
       VALUES($1,'post_sales_v1',true),($2,'post_sales_v1',true)`,
      [tenantId, foreignTenantId]
    );
  });

  it("configures and propagates the checklist while preserving archived answers", async () => {
    expect((await app.inject({
      method: "POST",
      url: "/post-sales/checklist-template/items",
      headers: { cookie: operatorCookie },
      payload: { description: "Não permitido" }
    })).statusCode).toBe(403);

    const first = await app.inject({
      method: "POST",
      url: "/post-sales/checklist-template/items",
      headers: { cookie: ownerCookie },
      payload: { description: "Oferecer treinamento" }
    });
    expect(first.statusCode).toBe(201);
    firstItemId = first.json().item.id;

    const today = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const created = await app.inject({
      method: "POST",
      url: "/post-sales/clients",
      headers: { cookie: operatorCookie },
      payload: {
        name: "Cliente pós-venda",
        phone_e164: "+55 (11) 97710-0011",
        responsible_member_id: operatorMemberId,
        next_action: "Fazer contato inicial",
        next_action_at: today
      }
    });
    expect(created.statusCode).toBe(201);
    clientId = created.json().client.id;
    expect(created.json().client).toMatchObject({
      phone_e164: "5511977100011",
      lead_id: leadId,
      origin: "manual",
      responsible_member_id: operatorMemberId,
      version: 1
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/post-sales/clients",
      headers: { cookie: ownerCookie },
      payload: { name: "Duplicado", phone_e164: "5511977100011" }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: "POST_SALE_PHONE_CONFLICT", existing_id: clientId });

    const detail = await app.inject({ url: `/post-sales/clients/${clientId}`, headers: { cookie: ownerCookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().client.conversation_id).toBe(conversationId);
    expect(detail.json().checklist).toHaveLength(1);
    entryId = detail.json().checklist[0].id;

    const limitedDetail = await app.inject({ url: `/post-sales/clients/${clientId}`, headers: { cookie: limitedCookie } });
    expect(limitedDetail.statusCode).toBe(200);
    expect(limitedDetail.json().client).not.toHaveProperty("conversation_id");
    const foreignDetail = await app.inject({ url: `/post-sales/clients/${clientId}`, headers: { cookie: foreignOwnerCookie } });
    expect(foreignDetail.statusCode).toBe(404);

    const second = await app.inject({
      method: "POST",
      url: "/post-sales/checklist-template/items",
      headers: { cookie: ownerCookie },
      payload: { description: "Confirmar implantação" }
    });
    expect(second.statusCode).toBe(201);
    secondItemId = second.json().item.id;
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM post_sale_client_checklist WHERE tenant_id=$1 AND client_id=$2",
      [tenantId, clientId]
    )).rows[0].count).toBe(2);

    const answered = await app.inject({
      method: "PATCH",
      url: `/post-sales/clients/${clientId}/checklist/${entryId}`,
      headers: { cookie: operatorCookie },
      payload: { version: 1, result: "aceito", note: "Cliente confirmou" }
    });
    expect(answered.statusCode).toBe(200);
    expect(answered.json().entry).toMatchObject({ result: "aceito", version: 2 });
    expect((await app.inject({
      method: "PATCH",
      url: `/post-sales/clients/${clientId}/checklist/${entryId}`,
      headers: { cookie: operatorCookie },
      payload: { version: 1, result: "recusado" }
    })).statusCode).toBe(409);

    const archived = await app.inject({
      method: "POST",
      url: `/post-sales/checklist-template/items/${firstItemId}/archive`,
      headers: { cookie: ownerCookie },
      payload: { version: 1 }
    });
    expect(archived.statusCode).toBe(200);
    expect((await pool.query<{ result: string; note: string }>(
      "SELECT result,note FROM post_sale_client_checklist WHERE tenant_id=$1 AND id=$2",
      [tenantId, entryId]
    )).rows[0]).toEqual({ result: "aceito", note: "Cliente confirmou" });
    expect((await app.inject({
      method: "PATCH",
      url: `/post-sales/clients/${clientId}/checklist/${entryId}`,
      headers: { cookie: operatorCookie },
      payload: { version: 2, result: "recusado" }
    })).statusCode).toBe(404);
    const restored = await app.inject({
      method: "POST",
      url: `/post-sales/checklist-template/items/${firstItemId}/restore`,
      headers: { cookie: ownerCookie },
      payload: { version: archived.json().item.version }
    });
    expect(restored.statusCode).toBe(200);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM post_sale_client_checklist WHERE tenant_id=$1 AND client_id=$2 AND item_id=$3",
      [tenantId, clientId, firstItemId]
    )).rows[0].count).toBe(1);

    const template = await app.inject({ url: "/post-sales/checklist-template/items", headers: { cookie: ownerCookie } });
    const ordered = await app.inject({
      method: "PUT",
      url: "/post-sales/checklist-template/order",
      headers: { cookie: ownerCookie },
      payload: {
        items: template.json().items
          .filter((item: { archived_at: string | null }) => !item.archived_at)
          .reverse()
          .map((item: { id: string; version: number }) => ({ id: item.id, version: item.version }))
      }
    });
    expect(ordered.statusCode).toBe(200);
    expect(ordered.json().items.slice(0, 2).map((item: { id: string }) => item.id)).toEqual([secondItemId, firstItemId]);
  });

  it("derives portfolio queues and enforces client optimistic versions and archive-only lifecycle", async () => {
    await pool.query(
      `UPDATE post_sale_clients client
       SET next_action_at=(
         (now() AT TIME ZONE tenant.timezone)::date + time '12:00'
       ) AT TIME ZONE tenant.timezone
       FROM tenants tenant
       WHERE client.tenant_id=$1 AND client.id=$2 AND tenant.id=client.tenant_id`,
      [tenantId, clientId]
    );
    const list = await app.inject({ url: "/post-sales/clients?next_action=today", headers: { cookie: operatorCookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().summary).toMatchObject({ active: 1, archived: 0 });
    expect(list.json().clients).toHaveLength(1);

    const current = (await app.inject({ url: `/post-sales/clients/${clientId}`, headers: { cookie: operatorCookie } })).json().client;
    const updated = await app.inject({
      method: "PATCH",
      url: `/post-sales/clients/${clientId}`,
      headers: { cookie: operatorCookie },
      payload: { version: current.version, notes: "Acompanhamento iniciado" }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().client.version).toBe(current.version + 1);
    expect((await app.inject({
      method: "PATCH",
      url: `/post-sales/clients/${clientId}`,
      headers: { cookie: ownerCookie },
      payload: { version: current.version, notes: "Sobrescrita silenciosa" }
    })).statusCode).toBe(409);

    const archived = await app.inject({
      method: "POST",
      url: `/post-sales/clients/${clientId}/archive`,
      headers: { cookie: operatorCookie },
      payload: { version: updated.json().client.version }
    });
    expect(archived.statusCode).toBe(200);
    expect((await app.inject({ url: "/post-sales/clients", headers: { cookie: operatorCookie } })).json().clients).toHaveLength(0);
    expect((await app.inject({ url: "/post-sales/clients?archived=archived", headers: { cookie: operatorCookie } })).json().clients)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: clientId, state: "archived" })]));

    const restored = await app.inject({
      method: "POST",
      url: `/post-sales/clients/${clientId}/restore`,
      headers: { cookie: operatorCookie },
      payload: { version: archived.json().client.version }
    });
    expect(restored.statusCode).toBe(200);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM post_sale_clients WHERE tenant_id=$1 AND id=$2",
      [tenantId, clientId]
    )).rows[0].count).toBe(1);
  });

  it("captures only post-activation closed sales once and assigns the closing member", async () => {
    const activeLeadId = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,source,status,pipeline_stage_id)
       SELECT $1,'5511977100022','Venda ativa','test','agendado',id
       FROM pipeline_stages WHERE tenant_id=$1 AND technical_status='agendado' AND is_default
       RETURNING id`,
      [tenantId]
    )).rows[0].id;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const lead = (await client.query<{
        id: string;
        status: "agendado";
        pipeline_stage_id: string;
        assigned_member_id: string | null;
        sdr_member_id: string | null;
        closer_member_id: string | null;
      }>(
        `SELECT id,status,pipeline_stage_id,assigned_member_id,sdr_member_id,closer_member_id
         FROM scheduling_leads WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [tenantId, activeLeadId]
      )).rows[0];
      const closedStageId = (await client.query<{ id: string }>(
        "SELECT id FROM pipeline_stages WHERE tenant_id=$1 AND technical_status='fechado' AND is_default",
        [tenantId]
      )).rows[0].id;
      await applyStructuredStageEffects(client, {
        tenantId,
        lead,
        targetStatus: "fechado",
        targetStageId: closedStageId,
        payload: {
          sale_value: 1500,
          sale_product: "Plano Premium",
          sale_source: "campanha-x",
          sale_channel: "whatsapp",
          responsavel_member_id: operatorMemberId
        },
        actor: { userId: operatorUserId, actorScope: "workspace" }
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const captured = (await pool.query<{
      id: string;
      origin: string;
      lead_id: string;
      responsible_member_id: string;
    }>(
      "SELECT id,origin,lead_id,responsible_member_id FROM post_sale_clients WHERE tenant_id=$1 AND lead_id=$2",
      [tenantId, activeLeadId]
    )).rows[0];
    expect(captured).toMatchObject({
      origin: "closed_sale",
      lead_id: activeLeadId,
      responsible_member_id: operatorMemberId
    });
    const leadAfterClose = (await pool.query(
      "SELECT name,phone,status,pipeline_stage_id,assigned_member_id,commercial_outcome,sale_value FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
      [tenantId, activeLeadId]
    )).rows[0];
    const repeatClient = await pool.connect();
    try {
      await repeatClient.query("BEGIN");
      const repeat = await captureClosedSalePostSaleClient(repeatClient, tenantId, activeLeadId, operatorUserId);
      expect(repeat).toMatchObject({ created: false, clientId: captured.id, reason: "existing" });
      await repeatClient.query("COMMIT");
    } finally {
      repeatClient.release();
    }
    expect((await pool.query(
      "SELECT name,phone,status,pipeline_stage_id,assigned_member_id,commercial_outcome,sale_value FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
      [tenantId, activeLeadId]
    )).rows[0]).toEqual(leadAfterClose);

    await pool.query(
      "UPDATE tenant_feature_flag_overrides SET enabled=false WHERE tenant_id=$1 AND flag_key='post_sales_v1'",
      [foreignTenantId]
    );
    const inactiveLeadId = (await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,source)
       VALUES($1,'5511977100033','Venda anterior','test') RETURNING id`,
      [foreignTenantId]
    )).rows[0].id;
    const inactiveClient = await pool.connect();
    try {
      await inactiveClient.query("BEGIN");
      expect(await captureClosedSalePostSaleClient(inactiveClient, foreignTenantId, inactiveLeadId, foreignOwnerUserId))
        .toMatchObject({ created: false, clientId: null, reason: "feature_disabled" });
      await inactiveClient.query("COMMIT");
    } finally {
      inactiveClient.release();
    }
    await pool.query(
      "UPDATE tenant_feature_flag_overrides SET enabled=true WHERE tenant_id=$1 AND flag_key='post_sales_v1'",
      [foreignTenantId]
    );
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM post_sale_clients WHERE tenant_id=$1 AND lead_id=$2",
      [foreignTenantId, inactiveLeadId]
    )).rows[0].count).toBe(0);
  });
});
