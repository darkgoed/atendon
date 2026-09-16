import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { MessageRepository } from "../src/modules/messages/repository.js";
import { aiTurnProgressStore } from "../src/modules/realtime/ai-turn-progress.js";
import { WhatsAppSessionManager } from "../src/modules/whatsapp/session-manager.js";
import { WhatsAppSendRejectedError } from "../src/modules/whatsapp/errors.js";
import { QualificationService } from "../src/modules/qualification/service.js";
import { inboundQueue, inboundRecoveryJobId } from "../src/queue/message-queue.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const password = "tenant-password-42";
const readOnlyEmail = `ia-read-only-${randomUUID()}@test.local`;
const operatorEmail = `operator-${randomUUID()}@test.local`;
let emailA: string; let emailB: string; let operatorUserId: string;
let tenantA: string; let tenantB: string; let conversationA: string; let conversationB: string; let cookieA: string; let cookieB: string; let readOnlyCookie: string;
let phoneSequence=Number(Date.now().toString().slice(-8));
const nextPhone=()=>`5511${String(++phoneSequence).slice(-8).padStart(8,"0")}`;

async function createInstagramConversationFixture() {
  const instagramContactId=`igsid-${randomUUID()}`;
  const sessionId=(await pool.query<{id:string}>(
    `INSERT INTO whatsapp_sessions(tenant_id,status,channel,is_primary,phone_number)
     VALUES($1,'connected','instagram',false,NULL) RETURNING id`,
    [tenantA]
  )).rows[0].id;
  const leadId=(await pool.query<{id:string}>(
    `INSERT INTO scheduling_leads(
       tenant_id,phone,name,source,instagram_contact_id,instagram_username,instagram_session_id
     ) VALUES($1,NULL,'Contato Instagram','instagram',$2,'cliente_teste',$3) RETURNING id`,
    [tenantA,instagramContactId,sessionId]
  )).rows[0].id;
  const conversationId=(await pool.query<{id:string}>(
    `INSERT INTO conversations(
       tenant_id,session_id,contact_phone,contact_name,instagram_contact_id,instagram_username,lead_id,ai_active
     ) VALUES($1,$2,NULL,'Contato Instagram',$3,'cliente_teste',$4,false) RETURNING id`,
    [tenantA,sessionId,instagramContactId,leadId]
  )).rows[0].id;
  return {conversationId,leadId,sessionId};
}

async function deleteInstagramConversationFixture(fixture:{conversationId:string;leadId:string;sessionId:string}) {
  await pool.query("DELETE FROM conversations WHERE id=$1",[fixture.conversationId]);
  await pool.query("DELETE FROM scheduling_leads WHERE id=$1",[fixture.leadId]);
  await pool.query("DELETE FROM whatsapp_sessions WHERE id=$1",[fixture.sessionId]);
}

beforeAll(async () => {
  await app.ready();
  const a = await pool.query<{id:string}>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Painel A ${randomUUID()}`]);
  const b = await pool.query<{id:string}>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Painel B ${randomUUID()}`]);
  tenantA=a.rows[0].id; tenantB=b.rows[0].id;
  const passwordHash=await hash(password,4);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const planId=(await client.query<{id:string}>("SELECT id FROM plans WHERE code='MEDIUM'")).rows[0].id;
    for (const tenant of [tenantA,tenantB]) {
      await client.query(
        `INSERT INTO tenant_subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end)
         VALUES($1,$2,'ACTIVE',now(),now()+interval '1 month')`,
        [tenant,planId]
      );
      await client.query(
        `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
         SELECT $1,flag_key,true FROM feature_flag_definitions
         WHERE flag_key=ANY($2::text[])
         ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=true,updated_at=now()`,
        [tenant,["dashboard_v1","leads_v1","pipeline_v1","appointments_v1","workspace_admin_v1"]]
      );
    }
    for (const tenant of [tenantA, tenantB]) await ensureWorkspaceDefaultRoles(client, tenant);
    emailA = `a-${randomUUID()}@test.local`;
    emailB = `b-${randomUUID()}@test.local`;
    const userA = await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [emailA,passwordHash]);
    const userB = await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [emailB,passwordHash]);
    const readOnlyUser = await client.query<{ id: string }>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [readOnlyEmail,passwordHash]);
    const operatorUser = await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status,name) VALUES($1,$2,'active','Marina Oliveira') RETURNING id",
      [operatorEmail,passwordHash]
    );
    operatorUserId = operatorUser.rows[0].id;
    const memberA = await client.query<{ id: string }>(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER' RETURNING id",
      [tenantA,userA.rows[0].id]
    );
    await client.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'",
      [tenantB,userB.rows[0].id]
    );
    const readOnlyRole = await client.query<{ id: string }>(
      "INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,'LEITURA IA','Consulta agente e humanização') RETURNING id",
      [tenantA]
    );
    await client.query(
      "INSERT INTO workspace_role_permissions(role_id,permission_key) SELECT $1,key FROM permissions WHERE key=ANY($2::text[])",
      [readOnlyRole.rows[0].id,["agent.read","humanizer.read"]]
    );
    await client.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())",
      [tenantA,readOnlyUser.rows[0].id,readOnlyRole.rows[0].id]
    );
    const memberOperator = await client.query<{ id: string }>(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR' RETURNING id",
      [tenantA,operatorUser.rows[0].id]
    );
    await client.query(
      `INSERT INTO scheduling_google_meet_closers(tenant_id,member_id,availability_status)
       VALUES($1,$2,'available'),($1,$3,'available')`,
      [tenantA,memberA.rows[0].id,memberOperator.rows[0].id]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  for(const tenant of [tenantA,tenantB]){
    const session=await pool.query<{id:string}>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",[tenant]);
    await pool.query("INSERT INTO agent_configs(tenant_id,system_prompt,ai_model) VALUES($1,$2,$3)",[tenant,`prompt-${tenant}`,`model-${tenant}`]);
    const conversation=await pool.query<{id:string}>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,facebook_attribution,contact_avatar_url) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
      [
        tenant,
        session.rows[0].id,
        tenant===tenantA?"5511911111111":"5511922222222",
        tenant===tenantA?"Contato Aurora":"Contato Boreal",
        tenant===tenantA
          ? { provider:"meta",channel:"instagram",source_type:"ad",source_id:"ad-panel",headline:"Campanha Aurora" }
          : {},
        tenant===tenantA ? "https://cdn.example/aurora.jpg" : null
      ]
    );
    await pool.query("INSERT INTO usage_logs(tenant_id,conversation_id,ai_model,input_tokens,output_tokens,cost_usd) VALUES($1,$2,$3,$4,$5,$6)",[tenant,conversation.rows[0].id,`usage-model-${tenant}`,tenant===tenantA?17:999,tenant===tenantA?5:999,tenant===tenantA?.0123:9.99]);
    if(tenant===tenantA)conversationA=conversation.rows[0].id;else conversationB=conversation.rows[0].id;
  }
  const login=await app.inject({method:"POST",url:"/auth/login",payload:{email:emailA,password}});
  expect(login.statusCode).toBe(200);
  const setCookie=login.headers["set-cookie"]!; cookieA=(Array.isArray(setCookie)?setCookie[0]:setCookie).split(";")[0];
  const loginB=await app.inject({method:"POST",url:"/auth/login",payload:{email:emailB,password}});
  expect(loginB.statusCode).toBe(200);
  const setCookieB=loginB.headers["set-cookie"]!; cookieB=(Array.isArray(setCookieB)?setCookieB[0]:setCookieB).split(";")[0];
  const readOnlyLogin=await app.inject({method:"POST",url:"/auth/login",payload:{email:readOnlyEmail,password}});
  expect(readOnlyLogin.statusCode).toBe(200);
  const readOnlySetCookie=readOnlyLogin.headers["set-cookie"]!;
  readOnlyCookie=(Array.isArray(readOnlySetCookie)?readOnlySetCookie[0]:readOnlySetCookie).split(";")[0];
});

afterAll(async()=>{
  const testUsers=[readOnlyEmail,operatorEmail,emailA,emailB];
  await pool.query(
    `UPDATE feature_flag_definitions
     SET global_enabled=NULL,kill_switch_enabled=false,updated_by_user_id=NULL,updated_at=now()
     WHERE flag_key=ANY($1::text[])`,
    [["conversations_delta_v2","alerts_delivery_v2"]]
  );
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN(SELECT id FROM users WHERE email=ANY($1::text[]))",[testUsers]);
  await pool.query("DELETE FROM tenants WHERE id IN($1,$2)",[tenantA,tenantB]);
  await pool.query("DELETE FROM users WHERE email=ANY($1::text[])",[testUsers]);
  await pool.end();
  await app.close();
});

describe("panel API tenant isolation",()=>{
  it("returns defense-in-depth security headers from the API itself",async()=>{
    const response=await app.inject({url:"/version"});
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("rejects state-changing requests from a foreign origin",async()=>{
    const response=await app.inject({method:"POST",url:"/auth/login",headers:{origin:"https://evil.example"},payload:{email:"user@example.com",password:"password"}});
    expect(response.statusCode).toBe(403);
  });
  it("requires authentication",async()=>expect((await app.inject({url:"/dashboard"})).statusCode).toBe(401));
  it("binds realtime streams to the tenant selected by the authenticated session",async()=>{
    const headers={cookie:cookieA,accept:"text/event-stream"};
    const missingTenant=await app.inject({url:"/events",headers});
    expect(missingTenant.statusCode).toBe(403);
    expect(missingTenant.json()).toEqual({error:"Workspace do stream não corresponde à sessão"});

    const foreignTenant=await app.inject({url:`/events?tenantId=${encodeURIComponent(tenantB)}`,headers});
    expect(foreignTenant.statusCode).toBe(403);
    expect(foreignTenant.json()).toEqual({error:"Workspace do stream não corresponde à sessão"});
  });
  it("resolves the tenant-scoped scheduling context from a conversation phone",async()=>{
    expect((await app.inject({url:`/scheduling/conversations/${conversationA}/appointment-context`})).statusCode).toBe(401);
    expect((await app.inject({url:`/scheduling/conversations/${conversationA}/appointment-context`,headers:{cookie:readOnlyCookie}})).statusCode).toBe(403);
    expect((await app.inject({url:`/scheduling/conversations/${conversationB}/appointment-context`,headers:{cookie:cookieA}})).statusCode).toBe(404);

    const empty=await app.inject({url:`/scheduling/conversations/${conversationA}/appointment-context`,headers:{cookie:cookieA}});
    expect(empty.statusCode).toBe(200);
    const autoLinkedLeadId=(await pool.query<{lead_id:string}>(
      "SELECT lead_id FROM conversations WHERE tenant_id=$1 AND id=$2",
      [tenantA,conversationA]
    )).rows[0].lead_id;
    expect(empty.json()).toMatchObject({
      contact:{id:conversationA,nome:"Contato Aurora",telefone:"5511911111111"},
      lead:{
        id:autoLinkedLeadId,
        nome:"Contato Aurora",
        telefone:"5511911111111",
        unidade_id:null
      },
      agendamento_ativo:null,
      timezone:"UTC"
    });

    const suffix=randomUUID();
    const categoryId=`context-${suffix}`;
    const unitId=`context-${randomUUID()}`;
    await pool.query("INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,$2,'Categoria contexto')",[tenantA,categoryId]);
    await pool.query(
      "INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days) VALUES($1,$2,'Unidade contexto','09:00','18:00',ARRAY[0,1,2,3,4,5,6]::smallint[])",
      [tenantA,unitId]
    );
    const lead=await pool.query<{id:string}>(
      `UPDATE scheduling_leads
       SET name='Lead Aurora',interest_category_id=$2,unit_id=$3,source='teste-contexto'
       WHERE tenant_id=$1 AND id=$4
       RETURNING id`,
      [tenantA,categoryId,unitId,autoLinkedLeadId]
    );
    const appointment=await pool.query<{id:string}>(
      `INSERT INTO scheduling_appointments(lead_id,tenant_id,unit_id,start_at,end_at,status)
       VALUES($1,$2,$3,'2035-02-05T14:00:00.000Z','2035-02-05T15:00:00.000Z','confirmado') RETURNING id`,
      [lead.rows[0].id,tenantA,unitId]
    );

    const linked=await app.inject({url:`/scheduling/conversations/${conversationA}/appointment-context`,headers:{cookie:cookieA}});
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toMatchObject({
      lead:{id:lead.rows[0].id,nome:"Lead Aurora",telefone:"5511911111111",unidade_id:unitId},
      agendamento_ativo:{id:appointment.rows[0].id,unidade_id:unitId,start:"2035-02-05T14:00:00.000Z",status:"confirmado"}
    });
  });
  it("projects alert receipts on emission and keeps listing pure while claims are concurrent and idempotent",async()=>{
    const rootEmail=`alerts-member-root-${randomUUID()}@test.local`;
    const root=await pool.query<{id:string}>(
      "INSERT INTO users(email,status,is_root) VALUES($1,'active',true) RETURNING id",
      [rootEmail]
    );
    await pool.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'`,
      [tenantA,root.rows[0].id]
    );
    const rootToken=await createSessionToken({
      userId:root.rows[0].id,
      tenantId:tenantA,
      email:rootEmail,
      isRoot:true,
      rootWorkspaceAccess:true
    });
    const alertsCookie=`atendon_session=${rootToken}`;
    const ownAlert=await pool.query<{id:string}>(
      "INSERT INTO system_alerts(tenant_id,message,created_at) VALUES($1,$2,now()-interval '2 days') RETURNING id",
      [tenantA,"Falha operacional antiga, ainda revisável"]
    );
    const newerAlert=await pool.query<{id:string}>(
      "INSERT INTO system_alerts(tenant_id,message,created_at) VALUES($1,$2,now()-interval '1 day') RETURNING id",
      [tenantA,"Falha operacional mais recente"]
    );
    const foreignAlert=await pool.query<{id:string}>(
      "INSERT INTO system_alerts(tenant_id,message) VALUES($1,$2) RETURNING id",
      [tenantB,"Alerta exclusivo de outro tenant"]
    );
    const ownId=ownAlert.rows[0].id;
    const newerId=newerAlert.rows[0].id;
    const foreignId=foreignAlert.rows[0].id;

    expect((await app.inject({url:"/alerts",headers:{cookie:readOnlyCookie}})).statusCode).toBe(403);
    expect((await app.inject({method:"PATCH",url:`/alerts/${ownId}/read`,headers:{cookie:readOnlyCookie}})).statusCode).toBe(403);
    expect((await app.inject({method:"PATCH",url:"/alerts/read-all",headers:{cookie:readOnlyCookie}})).statusCode).toBe(403);

    const projected=await pool.query<{email:string}>(
      `SELECT u.email
       FROM system_alert_receipts r
       JOIN users u ON u.id=r.user_id
       WHERE r.alert_id=$1 AND r.tenant_id=$2
       ORDER BY u.email`,
      [ownId,tenantA]
    );
    expect(projected.rows.map((row)=>row.email)).toEqual(
      [emailA,operatorEmail,readOnlyEmail,rootEmail].sort()
    );

    const state=async()=>(
      await pool.query<{value:unknown}>(
        `SELECT jsonb_build_object(
           'alerts',COALESCE((
             SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
             FROM system_alerts a WHERE a.tenant_id=ANY($1::uuid[])
           ),'[]'::jsonb),
           'receipts',COALESCE((
             SELECT jsonb_agg(to_jsonb(r) ORDER BY r.tenant_id,r.alert_id,r.user_id)
             FROM system_alert_receipts r WHERE r.tenant_id=ANY($1::uuid[])
           ),'[]'::jsonb)
         ) value`,
        [[tenantA,tenantB]]
      )
    ).rows[0].value;
    const beforeGet=await state();
    const first=await app.inject({url:"/alerts",headers:{cookie:alertsCookie}});
    const second=await app.inject({url:"/alerts",headers:{cookie:alertsCookie}});
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(await state()).toEqual(beforeGet);
    expect(first.json()).toMatchObject({total:2,unread:2,receipt_mode:"member"});
    expect(first.json().alerts.map((alert:{id:string})=>alert.id)).toEqual([newerId,ownId]);
    const firstOwn=first.json().alerts.find((alert:{id:string})=>alert.id===ownId);
    expect(firstOwn).toMatchObject({
      message:"Falha operacional antiga, ainda revisável",
      notified_at:null,
      read_at:null,
      can_acknowledge:true,
      should_toast:false
    });
    expect(first.json().alerts.map((alert:{id:string})=>alert.id)).not.toContain(foreignId);

    const operatorLogin=await app.inject({method:"POST",url:"/auth/login",remoteAddress:"10.45.0.8",payload:{email:operatorEmail,password}});
    expect(operatorLogin.statusCode).toBe(200);
    const operatorSetCookie=operatorLogin.headers["set-cookie"]!;
    const operatorCookie=(Array.isArray(operatorSetCookie)?operatorSetCookie[0]:operatorSetCookie).split(";")[0];
    const operatorAlerts=await app.inject({url:"/alerts",headers:{cookie:operatorCookie}});
    expect(operatorAlerts.statusCode).toBe(403);

    const disabledClaim=await app.inject({
      method:"POST",
      url:"/alerts/notifications/claim",
      headers:{cookie:alertsCookie},
      payload:{limit:20}
    });
    expect(disabledClaim.statusCode).toBe(409);
    expect(disabledClaim.json()).toMatchObject({
      code:"FEATURE_FLAG_DISABLED",
      feature:"alerts_delivery_v2",
      fallback:"/alerts"
    });
    expect((await app.inject({
      method:"POST",
      url:"/alerts/notifications/claim",
      headers:{cookie:cookieB},
      payload:{limit:20}
    })).statusCode).toBe(403);
    expect((await pool.query<{count:number}>(
      `SELECT count(*)::int count FROM system_alert_receipts
       WHERE tenant_id=$1 AND notified_at IS NOT NULL`,
      [tenantA]
    )).rows[0].count).toBe(0);
    await pool.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
       VALUES($1,'alerts_delivery_v2',true)`,
      [tenantA]
    );
    expect((await app.inject({
      method:"POST",
      url:"/alerts/notifications/claim",
      headers:{cookie:cookieB},
      payload:{limit:20}
    })).statusCode).toBe(403);

    const claims=await Promise.all([
      app.inject({method:"POST",url:"/alerts/notifications/claim",headers:{cookie:alertsCookie},payload:{limit:20}}),
      app.inject({method:"POST",url:"/alerts/notifications/claim",headers:{cookie:alertsCookie},payload:{limit:20}})
    ]);
    expect(claims.every((response)=>response.statusCode===200)).toBe(true);
    const claimedIds=claims.flatMap((response)=>response.json().alerts.map((alert:{id:string})=>alert.id));
    expect([...claimedIds].sort()).toEqual([newerId,ownId].sort());
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect((await app.inject({
      method:"POST",
      url:"/alerts/notifications/claim",
      headers:{cookie:alertsCookie},
      payload:{limit:20}
    })).json().alerts).toEqual([]);
    const listedAfterClaim=await app.inject({url:"/alerts",headers:{cookie:alertsCookie}});
    expect(listedAfterClaim.json()).toMatchObject({total:2,unread:2});
    expect(listedAfterClaim.json().alerts.map((alert:{id:string})=>alert.id)).toEqual([newerId,ownId]);
    expect(listedAfterClaim.json().alerts.every((alert:{notified_at:string|null})=>alert.notified_at!==null)).toBe(true);

    const selected=await pool.query<{id:string}>(
      `INSERT INTO system_alerts(tenant_id,message,audience)
       VALUES($1,'Alerta com destinatário explícito','selected') RETURNING id`,
      [tenantA]
    );
    const selectedId=selected.rows[0].id;
    expect((await pool.query<{count:number}>(
      "SELECT count(*)::int count FROM system_alert_receipts WHERE alert_id=$1",
      [selectedId]
    )).rows[0].count).toBe(0);
    await pool.query(
      `INSERT INTO system_alert_receipts(alert_id,tenant_id,user_id)
       SELECT $1,$2,id FROM users WHERE email=$3`,
      [selectedId,tenantA,rootEmail]
    );
    const ownerWithSelected=await app.inject({url:"/alerts",headers:{cookie:alertsCookie}});
    const operatorWithoutSelected=await app.inject({url:"/alerts",headers:{cookie:operatorCookie}});
    expect(ownerWithSelected.json().alerts.map((alert:{id:string})=>alert.id)).toContain(selectedId);
    expect(operatorWithoutSelected.statusCode).toBe(403);

    const killedAlert=await pool.query<{id:string}>(
      "INSERT INTO system_alerts(tenant_id,message) VALUES($1,'Alerta durante kill switch') RETURNING id",
      [tenantA]
    );
    await pool.query(
      `UPDATE feature_flag_definitions
       SET kill_switch_enabled=true
       WHERE flag_key='alerts_delivery_v2'`
    );
    const killedClaim=await app.inject({
      method:"POST",
      url:"/alerts/notifications/claim",
      headers:{cookie:alertsCookie},
      payload:{limit:20}
    });
    expect(killedClaim.statusCode).toBe(409);
    expect(killedClaim.json()).toMatchObject({
      code:"FEATURE_FLAG_DISABLED",
      feature:"alerts_delivery_v2",
      fallback:"/alerts"
    });
    expect((await pool.query<{notified_at:Date|null}>(
      `SELECT notified_at FROM system_alert_receipts
       WHERE alert_id=$1 AND tenant_id=$2
         AND user_id=(SELECT id FROM users WHERE email=$3)`,
      [killedAlert.rows[0].id,tenantA,rootEmail]
    )).rows[0].notified_at).toBeNull();
    await pool.query(
      `UPDATE feature_flag_definitions
       SET kill_switch_enabled=false
       WHERE flag_key='alerts_delivery_v2'`
    );

    expect((await app.inject({method:"PATCH",url:`/alerts/${foreignId}/read`,headers:{cookie:alertsCookie}})).statusCode).toBe(404);
    const acknowledged=await app.inject({method:"PATCH",url:`/alerts/${ownId}/read`,headers:{cookie:alertsCookie}});
    const replay=await app.inject({method:"PATCH",url:`/alerts/${ownId}/read`,headers:{cookie:alertsCookie}});
    expect(acknowledged.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().readAt).toBe(acknowledged.json().readAt);

    const receipts=await pool.query<{email:string;read_at:Date|null}>(
      `SELECT u.email,r.read_at FROM system_alert_receipts r JOIN users u ON u.id=r.user_id
       WHERE r.alert_id=$1 AND r.tenant_id=$2 ORDER BY u.email`,
      [ownId,tenantA]
    );
    expect(receipts.rows.find((row)=>row.email===rootEmail)?.read_at).not.toBeNull();
    expect(receipts.rows.find((row)=>row.email===operatorEmail)?.read_at).toBeNull();
    const audit=await pool.query<{count:number}>(
      "SELECT count(*)::int count FROM audit_logs WHERE workspace_id=$1 AND actor_user_id=(SELECT id FROM users WHERE email=$2) AND action='system_alert.read' AND resource_id=$3",
      [tenantA,rootEmail,ownId]
    );
    expect(audit.rows[0].count).toBe(1);

    const markedAll=await app.inject({method:"PATCH",url:"/alerts/read-all",headers:{cookie:alertsCookie}});
    expect(markedAll.statusCode).toBe(200);
    expect(markedAll.json()).toEqual({ok:true,updated:3});
    expect((await app.inject({url:"/alerts",headers:{cookie:alertsCookie}})).json().unread).toBe(0);
    expect((await app.inject({method:"PATCH",url:"/alerts/read-all",headers:{cookie:alertsCookie}})).json())
      .toEqual({ok:true,updated:0});
    expect((await pool.query<{count:number}>(
      `SELECT count(*)::int count FROM audit_logs
       WHERE workspace_id=$1 AND actor_user_id=(SELECT id FROM users WHERE email=$2)
         AND action='system_alert.read_all'`,
      [tenantA,rootEmail]
    )).rows[0].count).toBe(1);
    expect((await pool.query<{count:number}>(
      `SELECT count(*)::int count FROM system_alert_receipts r
       JOIN users u ON u.id=r.user_id
       WHERE r.tenant_id=$1 AND u.email=$2 AND r.read_at IS NOT NULL`,
      [tenantA,operatorEmail]
    )).rows[0].count).toBe(0);

    const readOnlyRootEmail=`alerts-root-${randomUUID()}@test.local`;
    const readOnlyRoot=await pool.query<{id:string}>(
      "INSERT INTO users(email,status,is_root) VALUES($1,'active',true) RETURNING id",
      [readOnlyRootEmail]
    );
    try {
      const readOnlyRootToken=await createSessionToken({
        userId:readOnlyRoot.rows[0].id,
        tenantId:tenantA,
        email:readOnlyRootEmail,
        isRoot:true,
        rootWorkspaceAccess:true
      });
      const rootCookie=`atendon_session=${readOnlyRootToken}`;
      const rootList=await app.inject({url:"/alerts",headers:{cookie:rootCookie}});
      expect(rootList.statusCode).toBe(200);
      expect(rootList.json()).toMatchObject({receipt_mode:"root_read_only",unread:0});
      expect(rootList.json().alerts.map((alert:{id:string})=>alert.id)).toEqual(
        expect.arrayContaining([ownId,newerId])
      );
      expect(rootList.json().alerts.every((alert:{can_acknowledge:boolean})=>!alert.can_acknowledge)).toBe(true);
      expect((await app.inject({
        method:"POST",
        url:"/alerts/notifications/claim",
        headers:{cookie:rootCookie},
        payload:{limit:20}
      })).json().alerts).toEqual([]);
      expect((await app.inject({
        method:"PATCH",
        url:`/alerts/${newerId}/read`,
        headers:{cookie:rootCookie}
      })).statusCode).toBe(404);
      expect((await app.inject({
        method:"PATCH",
        url:"/alerts/read-all",
        headers:{cookie:rootCookie}
      })).json()).toEqual({ok:true,updated:0});
      expect((await pool.query<{count:number}>(
        "SELECT count(*)::int count FROM system_alert_receipts WHERE tenant_id=$1 AND user_id=$2",
        [tenantA,readOnlyRoot.rows[0].id]
      )).rows[0].count).toBe(0);
    } finally {
      await pool.query("DELETE FROM users WHERE id=$1",[readOnlyRoot.rows[0].id]);
    }
    await pool.query("DELETE FROM audit_logs WHERE actor_user_id=$1",[root.rows[0].id]);
    await pool.query("DELETE FROM users WHERE id=$1",[root.rows[0].id]);
  });
  it("lists only the authenticated tenant conversations",async()=>{
    const response=await app.inject({url:"/conversations",headers:{cookie:cookieA}});
    expect(response.statusCode).toBe(200);expect(response.json().conversations.map((x:{id:string})=>x.id)).toContain(conversationA);expect(response.json().conversations.map((x:{id:string})=>x.id)).not.toContain(conversationB);
    expect(response.json().conversations.find((x:{id:string})=>x.id===conversationA).avatar_url).toBe("https://cdn.example/aurora.jpg");
  });
  it("updates contact details, lists all conversation assets, and clears messages within the case scope",async()=>{
    await pool.query(
      `INSERT INTO messages(conversation_id,sender,content,media_type,media_mime_type,media_file_name,media_size_bytes)
       VALUES
        ($1,'contact','Veja https://tripz.example/oferta','image','image/jpeg','oferta.jpg',1200),
        ($1,'contact','Confira o contrato','document','application/pdf','contrato.pdf',2400),
        ($1,'contact','Acesse https://tripz.example/roteiro',NULL,NULL,NULL,NULL)
       RETURNING id`,
      [conversationA]
    );
    const updated=await app.inject({
      method:"PATCH",url:`/conversations/${conversationA}/contact`,headers:{cookie:cookieA},payload:{name:"Aurora Nogueira"}
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({conversation_id:conversationA,contact_name:"Aurora Nogueira"});
    expect((await pool.query<{name:string|null}>(
      `SELECT lead.name FROM conversations conversation
       JOIN scheduling_leads lead ON lead.id=conversation.lead_id AND lead.tenant_id=conversation.tenant_id
       WHERE conversation.tenant_id=$1 AND conversation.id=$2`,
      [tenantA,conversationA]
    )).rows[0].name).toBe("Aurora Nogueira");
    expect((await app.inject({url:`/conversations/${conversationB}/assets`,headers:{cookie:cookieA}})).statusCode).toBe(404);
    expect((await app.inject({method:"PATCH",url:`/conversations/${conversationA}/contact`,headers:{cookie:readOnlyCookie},payload:{name:"Sem permissão"}})).statusCode).toBe(403);
    expect((await app.inject({method:"DELETE",url:`/conversations/${conversationA}/messages`,headers:{cookie:readOnlyCookie}})).statusCode).toBe(403);
    expect((await app.inject({method:"DELETE",url:`/conversations/${conversationB}/messages`,headers:{cookie:cookieA}})).statusCode).toBe(404);

    const assets=await app.inject({url:`/conversations/${conversationA}/assets?limit=2`,headers:{cookie:cookieA}});
    expect(assets.statusCode).toBe(200);
    expect(assets.json()).toMatchObject({limit:2,has_more:true});
    expect(assets.json().messages).toHaveLength(2);
    const nextCursor=assets.json().next_cursor;
    expect(typeof nextCursor).toBe("string");
    const remaining=await app.inject({url:`/conversations/${conversationA}/assets?limit=2&before=${encodeURIComponent(nextCursor)}`,headers:{cookie:cookieA}});
    expect(remaining.statusCode).toBe(200);
    expect(remaining.json()).toMatchObject({limit:2,has_more:false});
    expect(remaining.json().messages).toHaveLength(1);
    expect(remaining.json().messages[0].id).not.toBe(assets.json().messages[0].id);
    expect(remaining.json().messages[0].id).not.toBe(assets.json().messages[1].id);
    expect((await pool.query<{action:string}>("SELECT action FROM audit_logs WHERE workspace_id=$1 AND resource_id=$2 AND action='conversation.contact_updated'",[tenantA,conversationA])).rowCount).toBeGreaterThan(0);

    const cleared=await app.inject({method:"DELETE",url:`/conversations/${conversationA}/messages`,headers:{cookie:cookieA}});
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().deleted_count).toBeGreaterThanOrEqual(3);
    expect((await app.inject({url:`/conversations/${conversationA}/messages`,headers:{cookie:cookieA}})).json().messages).toEqual([]);
    expect((await pool.query<{action:string}>("SELECT action FROM audit_logs WHERE workspace_id=$1 AND resource_id=$2 AND action='conversation.messages_cleared'",[tenantA,conversationA])).rowCount).toBeGreaterThan(0);
  });
  it("filters conversations with active appointments as scheduled",async()=>{
    const response=await app.inject({url:"/conversations?filter=scheduled",headers:{cookie:cookieA}});
    expect(response.statusCode).toBe(200);
    expect(response.json().conversations.map((item:{id:string})=>item.id)).toContain(conversationA);
    expect(response.json().conversations.map((item:{id:string})=>item.id)).not.toContain(conversationB);
    // The suite reuses conversationA for AI lifecycle checks below. Remove the
    // fixture only after its list projection has been asserted so the new
    // commercial guard does not intentionally block those unrelated checks.
    await pool.query(
      `DELETE FROM scheduling_appointments appointment USING conversations conversation
       WHERE conversation.tenant_id=$1 AND conversation.id=$2
         AND appointment.tenant_id=conversation.tenant_id
         AND appointment.lead_id=conversation.lead_id`,
      [tenantA,conversationA]
    );
  });
  it("requests a profile picture for visible unsaved contacts without an avatar",async()=>{
    const session=await pool.query<{session_id:string}>("SELECT session_id FROM conversations WHERE id=$1",[conversationA]);
    const phone=nextPhone();
    await pool.query(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name) VALUES($1,$2,$3,'Contato não salvo')",
      [tenantA,session.rows[0].session_id,phone]
    );
    const refresh=vi.spyOn(WhatsAppSessionManager.prototype,"refreshContactAvatar").mockResolvedValue();
    try {
      const response=await app.inject({url:"/conversations",headers:{cookie:cookieA}});
      expect(response.statusCode).toBe(200);
      expect(refresh).toHaveBeenCalledWith(session.rows[0].session_id,phone);
    }finally{
      refresh.mockRestore();
    }
  });
  it("returns sanitized Meta attribution with the selected conversation",async()=>{
    const response=await app.inject({url:`/conversations/${conversationA}/messages`,headers:{cookie:cookieA}});
    expect(response.statusCode).toBe(200);
    expect(response.json().conversation.facebook_attribution).toMatchObject({
      provider:"meta",channel:"instagram",source_type:"ad",source_id:"ad-panel",headline:"Campanha Aurora"
    });
    expect(response.json().conversation.avatar_url).toBe("https://cdn.example/aurora.jpg");
    expect(response.json().ai_turn).toBeNull();
  });
  it("recovers the active AI turn through both message endpoints",async()=>{
    await pool.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
       VALUES($1,'ai_turn_visibility_v1',true)
       ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=true,updated_at=now()`,
      [tenantA]
    );
    const progress=await aiTurnProgressStore.start({
      tenantId:tenantA,
      conversationId:conversationA,
      turnId:randomUUID(),
      attempt:1
    });
    expect(progress).not.toBeNull();
    try{
      await progress!.publish({phase:"preview",preview:"Resposta ainda não enviada",previewTruncated:false});
      const legacy=await app.inject({url:`/conversations/${conversationA}/messages`,headers:{cookie:cookieA}});
      expect(legacy.statusCode).toBe(200);
      expect(legacy.json().ai_turn).toMatchObject({
        conversationId:conversationA,
        turnId:progress!.turnId,
        phase:"preview",
        preview:"Resposta ainda não enviada"
      });

      await pool.query(
        `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
         VALUES($1,'conversations_delta_v2',true)
         ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=true,updated_at=now()`,
        [tenantA]
      );
      const delta=await app.inject({url:`/conversations/${conversationA}/messages/v2`,headers:{cookie:cookieA}});
      expect(delta.statusCode).toBe(200);
      expect(delta.json().ai_turn).toMatchObject({turnId:progress!.turnId,phase:"preview"});
    }finally{
      await progress?.clear();
      await pool.query(
        "DELETE FROM tenant_feature_flag_overrides WHERE tenant_id=$1 AND flag_key=ANY($2::text[])",
        [tenantA,["ai_turn_visibility_v1","conversations_delta_v2"]]
      );
    }
  });
  it("rejects foreign quoted message IDs and renders only same-conversation quotes",async()=>{
    const foreignContent=`segredo-tenant-b-${randomUUID()}`;
    const foreignMessage=(await pool.query<{id:string}>(
      "INSERT INTO messages(conversation_id,sender,content) VALUES($1,'contact',$2) RETURNING id",
      [conversationB,foreignContent]
    )).rows[0];
    const ownQuotedContent=`mensagem-tenant-a-${randomUUID()}`;
    const ownQuotedMessage=(await pool.query<{id:string}>(
      "INSERT INTO messages(conversation_id,sender,content) VALUES($1,'contact',$2) RETURNING id",
      [conversationA,ownQuotedContent]
    )).rows[0];
    const ownMessage=(await pool.query<{id:string}>(
      `INSERT INTO messages(conversation_id,sender,content,reply_to_message_id)
       VALUES($1,'human','resposta com citação',$2) RETURNING id`,
      [conversationA,ownQuotedMessage.id]
    )).rows[0];
    await pool.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
       VALUES($1,'conversations_delta_v2',true)
       ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=true,updated_at=now()`,
      [tenantA]
    );
    await pool.query("UPDATE conversations SET ai_active=false WHERE id=$1 AND tenant_id=$2",[conversationA,tenantA]);
    try{
      const rejected=await app.inject({
        method:"POST",
        url:`/conversations/${conversationA}/messages`,
        headers:{cookie:cookieA,"idempotency-key":`foreign-quote-${randomUUID()}`},
        payload:{text:"não deve ser enviada",replyToMessageId:foreignMessage.id}
      });
      expect(rejected.statusCode).toBe(404);
      expect(rejected.json()).toEqual({error:"Mensagem citada não encontrada"});
      for(const url of [
        `/conversations/${conversationA}/messages`,
        `/conversations/${conversationA}/messages/v2`
      ]){
        const response=await app.inject({url,headers:{cookie:cookieA}});
        expect(response.statusCode).toBe(200);
        const message=response.json().messages.find((item:{id:string})=>item.id===ownMessage.id);
        expect(message).toMatchObject({
          id:ownMessage.id,
          reply_to_message_id:ownQuotedMessage.id,
          reply_to_content:ownQuotedContent,
          reply_to_sender:"contact"
        });
        expect(JSON.stringify(response.json())).not.toContain(foreignContent);
      }
    }finally{
      await pool.query("UPDATE conversations SET ai_active=true WHERE id=$1 AND tenant_id=$2",[conversationA,tenantA]);
      await pool.query(
        "DELETE FROM messages WHERE id=ANY($1::uuid[])",
        [[ownMessage.id,ownQuotedMessage.id,foreignMessage.id]]
      );
      await pool.query(
        "DELETE FROM tenant_feature_flag_overrides WHERE tenant_id=$1 AND flag_key='conversations_delta_v2'",
        [tenantA]
      );
    }
  });
  it("paginates message v2 initial, before and after with stable opaque cursors",async()=>{
    const session=await pool.query<{session_id:string}>("SELECT session_id FROM conversations WHERE id=$1",[conversationA]);
    const pagedConversation=await pool.query<{id:string}>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name)
       VALUES($1,$2,$3,'Cursor Test') RETURNING id`,
      [tenantA,session.rows[0].session_id,nextPhone()]
    );
    const conversationId=pagedConversation.rows[0].id;
    await pool.query(
      `INSERT INTO messages(conversation_id,sender,content,created_at)
       SELECT $1,'contact','cursor-'||n,
              timestamptz '2030-01-01T00:00:00Z' + make_interval(secs => (n/20)::int)
       FROM generate_series(1,505) n`,
      [conversationId]
    );

    const disabled=await app.inject({
      url:`/conversations/${conversationId}/messages/v2?limit=100`,
      headers:{cookie:cookieA}
    });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toMatchObject({
      code:"FEATURE_FLAG_DISABLED",
      feature:"conversations_delta_v2",
      fallback:`/conversations/${conversationId}/messages`
    });
    expect((await app.inject({
      url:`/conversations/${conversationId}/messages`,
      headers:{cookie:cookieA}
    })).statusCode).toBe(200);
    expect((await app.inject({
      url:`/conversations/${conversationB}/messages/v2`,
      headers:{cookie:cookieB}
    })).statusCode).toBe(409);
    await pool.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
       VALUES($1,'conversations_delta_v2',true)`,
      [tenantA]
    );
    expect((await app.inject({
      url:`/conversations/${conversationB}/messages/v2`,
      headers:{cookie:cookieB}
    })).statusCode).toBe(409);

    const initial=await app.inject({
      url:`/conversations/${conversationId}/messages/v2?limit=100`,
      headers:{cookie:cookieA}
    });
    expect(initial.statusCode).toBe(200);
    const initialBody=initial.json();
    expect(initialBody.ai_turn).toBeNull();
    expect(initialBody.messages).toHaveLength(100);
    expect(initialBody.page).toMatchObject({direction:"initial",limit:100,has_more_before:true,has_more_after:false});
    expect(initialBody.cursors.before).toEqual(expect.any(String));
    expect(initialBody.cursors.after).toEqual(expect.any(String));
    const expectedLatest=(await pool.query<{id:string}>(
      `SELECT id FROM (
         SELECT id,created_at FROM messages WHERE conversation_id=$1
         ORDER BY created_at DESC,id DESC LIMIT 100
       ) latest ORDER BY created_at,id`,
      [conversationId]
    )).rows.map((row)=>row.id);
    expect(initialBody.messages.map((message:{id:string})=>message.id)).toEqual(expectedLatest);

    const historicalIds=new Set(initialBody.messages.map((message:{id:string})=>message.id));
    let before:string|null=initialBody.cursors.before;
    let hasMore=true;
    while(hasMore){
      const page=await app.inject({
        url:`/conversations/${conversationId}/messages/v2?limit=100&before=${encodeURIComponent(before!)}`,
        headers:{cookie:cookieA}
      });
      expect(page.statusCode).toBe(200);
      const body=page.json();
      expect(body.page.direction).toBe("before");
      for(const message of body.messages as Array<{id:string}>){
        expect(historicalIds.has(message.id)).toBe(false);
        historicalIds.add(message.id);
      }
      before=body.cursors.before;
      hasMore=body.page.has_more_before;
    }
    expect(historicalIds.size).toBe(505);

    const deltaTimestamp="2031-02-03T04:05:06.000Z";
    const inserted=(await pool.query<{id:string}>(
      `INSERT INTO messages(conversation_id,sender,content,created_at)
       VALUES($1,'contact','delta-a',$2),($1,'agent','delta-b',$2)
       RETURNING id`,
      [conversationId,deltaTimestamp]
    )).rows.map((row)=>row.id).sort();
    const delta=await app.inject({
      url:`/conversations/${conversationId}/messages/v2?limit=100&after=${encodeURIComponent(initialBody.cursors.after)}`,
      headers:{cookie:cookieA}
    });
    expect(delta.statusCode).toBe(200);
    expect(delta.json().page).toMatchObject({direction:"after",has_more_before:false,has_more_after:false});
    expect(delta.json().messages.map((message:{id:string})=>message.id)).toEqual(inserted);

    const invalid=await app.inject({
      url:`/conversations/${conversationId}/messages/v2?after=not-a-cursor`,
      headers:{cookie:cookieA}
    });
    expect(invalid.statusCode).toBe(400);
    expect((await app.inject({
      url:`/conversations/${conversationId}/messages/v2?limit=101`,
      headers:{cookie:cookieA}
    })).statusCode).toBe(400);
    const conflicting=await app.inject({
      url:`/conversations/${conversationId}/messages/v2?before=${encodeURIComponent(initialBody.cursors.before)}&after=${encodeURIComponent(initialBody.cursors.after)}`,
      headers:{cookie:cookieA}
    });
    expect(conflicting.statusCode).toBe(400);
    expect((await app.inject({
      url:`/conversations/${conversationB}/messages/v2?after=not-a-cursor`,
      headers:{cookie:cookieA}
    })).statusCode).toBe(404);

    await pool.query(
      `UPDATE feature_flag_definitions
       SET kill_switch_enabled=true
       WHERE flag_key='conversations_delta_v2'`
    );
    const killed=await app.inject({
      url:`/conversations/${conversationId}/messages/v2`,
      headers:{cookie:cookieA}
    });
    expect(killed.statusCode).toBe(409);
    expect(killed.json()).toMatchObject({
      code:"FEATURE_FLAG_DISABLED",
      feature:"conversations_delta_v2"
    });
    expect((await app.inject({
      url:`/conversations/${conversationId}/messages`,
      headers:{cookie:cookieA}
    })).statusCode).toBe(200);
    await pool.query(
      `UPDATE feature_flag_definitions
       SET kill_switch_enabled=false
       WHERE flag_key='conversations_delta_v2'`
    );
  });
  it("searches conversations by contact name or phone without crossing tenants",async()=>{
    const byName=await app.inject({url:"/conversations?q=aurora",headers:{cookie:cookieA}});
    expect(byName.statusCode).toBe(200);
    expect(byName.json().conversations.map((x:{id:string})=>x.id)).toEqual([conversationA]);
    const byPhone=await app.inject({url:"/conversations?q=111111",headers:{cookie:cookieA}});
    expect(byPhone.json().conversations.map((x:{id:string})=>x.id)).toContain(conversationA);
    const otherTenant=await app.inject({url:"/conversations?q=boreal",headers:{cookie:cookieA}});
    expect(otherTenant.json().conversations).toEqual([]);
  });
  it("returns 404 for another tenant conversation and cannot reactivate it",async()=>{
    expect((await app.inject({url:`/conversations/${conversationB}/messages`,headers:{cookie:cookieA}})).statusCode).toBe(404);
    expect((await app.inject({url:`/conversations/${conversationB}/messages/v2`,headers:{cookie:cookieA}})).statusCode).toBe(404);
    expect((await app.inject({method:"PATCH",url:`/conversations/${conversationB}/reactivate`,headers:{cookie:cookieA}})).statusCode).toBe(404);
    expect((await app.inject({method:"POST",url:`/conversations/${conversationB}/reply-with-ai`,headers:{cookie:cookieA}})).statusCode).toBe(404);
    expect((await app.inject({method:"PATCH",url:`/conversations/${conversationB}/pause`,headers:{cookie:cookieA}})).statusCode).toBe(404);
    expect((await app.inject({method:"PATCH",url:`/conversations/${conversationB}/claim`,headers:{cookie:cookieA}})).statusCode).toBe(404);
    expect((await app.inject({method:"PATCH",url:`/conversations/${conversationB}/assign`,headers:{cookie:cookieA},payload:{userId:null}})).statusCode).toBe(404);
    expect((await app.inject({method:"PATCH",url:`/conversations/${conversationB}/resolve`,headers:{cookie:cookieA}})).statusCode).toBe(404);
    expect((await app.inject({method:"PATCH",url:`/conversations/${conversationB}/reopen`,headers:{cookie:cookieA}})).statusCode).toBe(404);
  });
  it("filters, assigns and reopens the human queue with SLA metrics",async()=>{
    const session=await pool.query<{session_id:string}>("SELECT session_id FROM conversations WHERE id=$1",[conversationA]);
    const queued=await pool.query<{id:string}>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,contact_avatar_url,ai_active,handoff_reason,last_message_at)
       VALUES($1,$2,$3,'Fila SLA','https://cdn.example/fila-sla.jpg',false,'contact_requested',now()-interval '20 minutes') RETURNING id`,
      [tenantA,session.rows[0].session_id,`5511${Math.floor(10_000_000+Math.random()*89_999_999)}`]
    );
    const id=queued.rows[0].id;
    const dashboard=await app.inject({url:"/dashboard",headers:{cookie:cookieA}});
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().counts).toMatchObject({handoff_unassigned:expect.any(Number),handoff_over_sla:expect.any(Number),oldest_handoff_minutes:expect.any(Number)});
    expect(dashboard.json().counts.handoff_unassigned).toBeGreaterThanOrEqual(1);
    expect(dashboard.json().counts.handoff_over_sla).toBeGreaterThanOrEqual(1);
    expect(dashboard.json().handoffs.find((item:{id:string})=>item.id===id).avatar_url).toBe("https://cdn.example/fila-sla.jpg");

    const unassigned=await app.inject({url:"/conversations?filter=unassigned",headers:{cookie:cookieA}});
    expect(unassigned.json().conversations.map((item:{id:string})=>item.id)).toContain(id);
    const assignees=await app.inject({url:"/conversations/assignees",headers:{cookie:cookieA}});
    expect(assignees.json().assignees).toContainEqual({id:operatorUserId,email:operatorEmail});
    expect((await app.inject({method:"PATCH",url:`/conversations/${id}/assign`,headers:{cookie:cookieA},payload:{userId:operatorUserId}})).statusCode).toBe(200);
    expect((await app.inject({url:"/conversations?filter=unassigned",headers:{cookie:cookieA}})).json().conversations.map((item:{id:string})=>item.id)).not.toContain(id);
    const assignedConversation = (await app.inject({url:"/conversations?filter=human",headers:{cookie:cookieA}}))
      .json().conversations.find((item:{id:string})=>item.id===id);
    expect(assignedConversation.assigned_user_first_name).toBe("Marina");
    expect((await app.inject({url:"/conversations?filter=mine",headers:{cookie:cookieA}})).json().conversations.map((item:{id:string})=>item.id)).not.toContain(id);
    expect((await app.inject({method:"PATCH",url:`/conversations/${id}/assign`,headers:{cookie:cookieA},payload:{userId:randomUUID()}})).statusCode).toBe(400);

    expect((await app.inject({method:"PATCH",url:`/conversations/${id}/resolve`,headers:{cookie:cookieA}})).statusCode).toBe(200);
    expect((await app.inject({url:"/conversations?filter=resolved",headers:{cookie:cookieA}})).json().conversations.map((item:{id:string})=>item.id)).toContain(id);
    expect((await app.inject({method:"PATCH",url:`/conversations/${id}/reopen`,headers:{cookie:cookieA}})).statusCode).toBe(200);
    const state=await pool.query<{status:string;assigned_user_id:string|null}>("SELECT status,assigned_user_id FROM conversations WHERE id=$1",[id]);
    expect(state.rows[0]).toEqual({status:"open",assigned_user_id:operatorUserId});
    expect((await app.inject({method:"PATCH",url:`/conversations/${id}/assign`,headers:{cookie:cookieA},payload:{userId:null}})).statusCode).toBe(200);
    const unassignedAgain=await app.inject({url:"/conversations?filter=unassigned",headers:{cookie:cookieA}});
    expect(unassignedAgain.json().conversations.map((item:{id:string})=>item.id)).toContain(id);
    expect((await pool.query<{assigned_user_id:string|null;handoff_reason:string|null}>(
      "SELECT assigned_user_id,handoff_reason FROM conversations WHERE id=$1",[id]
    )).rows[0]).toEqual({assigned_user_id:null,handoff_reason:"ai_decided"});
    const audit=await pool.query<{action:string}>("SELECT action FROM audit_logs WHERE workspace_id=$1 AND resource_id=$2",[tenantA,id]);
    expect(audit.rows.map((item)=>item.action)).toEqual(expect.arrayContaining(["conversation.assigned","conversation.unassigned","conversation.resolved","conversation.reopened"]));
    await pool.query("DELETE FROM conversations WHERE id=$1",[id]);
  });
  it("lets an operator claim and resolve a conversation with an audit trail",async()=>{
    const claim=await app.inject({method:"PATCH",url:`/conversations/${conversationA}/claim`,headers:{cookie:cookieA}});
    expect(claim.statusCode).toBe(200);
    const detail=await app.inject({url:`/conversations/${conversationA}/messages`,headers:{cookie:cookieA}});
    expect(detail.json().conversation.assigned_user_email).toMatch(/^a-/);
    const resolve=await app.inject({method:"PATCH",url:`/conversations/${conversationA}/resolve`,headers:{cookie:cookieA}});
    expect(resolve.statusCode).toBe(200);
    const closed=await pool.query<{status:string;resolved_at:Date|null}>("SELECT status,resolved_at FROM conversations WHERE id=$1",[conversationA]);
    expect(closed.rows[0].status).toBe("closed");expect(closed.rows[0].resolved_at).not.toBeNull();
    const openList=await app.inject({url:"/conversations",headers:{cookie:cookieA}});
    expect(openList.json().conversations.map((item:{id:string})=>item.id)).not.toContain(conversationA);
    const audit=await pool.query<{action:string}>("SELECT action FROM audit_logs WHERE workspace_id=$1 AND resource_id=$2 ORDER BY created_at",[tenantA,conversationA]);
    expect(audit.rows.map((item)=>item.action)).toEqual(expect.arrayContaining(["conversation.claimed","conversation.resolved"]));
    const session=await pool.query<{session_id:string;contact_phone:string}>("SELECT session_id,contact_phone FROM conversations WHERE id=$1",[conversationA]);
    await new MessageRepository(pool).recordInboundAndLoadContext({
      externalId:`reopen-${randomUUID()}`,tenantId:tenantA,sessionId:session.rows[0].session_id,
      contactPhone:session.rows[0].contact_phone,text:"Nova mensagem após resolução"
    });
    const reopened=await pool.query<{status:string;resolved_at:Date|null}>("SELECT status,resolved_at FROM conversations WHERE id=$1",[conversationA]);
    expect(reopened.rows[0]).toEqual({status:"open",resolved_at:null});
    expect((await app.inject({method:"PATCH",url:`/conversations/${conversationA}/reactivate`,headers:{cookie:cookieA}})).statusCode).toBe(200);
  });
  it("pauses and reactivates AI only for the selected conversation",async()=>{
    await pool.query(
      "UPDATE conversations SET ai_active=false,handoff_reason='technical_failure',handoff_error_code='policy_retry_exhausted' WHERE id=$1",
      [conversationA]
    );
    const technicalDetail=await app.inject({url:`/conversations/${conversationA}/messages`,headers:{cookie:cookieA}});
    expect(technicalDetail.json().conversation.handoff_reason).toBe("technical_failure");
    expect(technicalDetail.json().conversation).not.toHaveProperty("handoff_error_code");
    expect((await app.inject({method:"PATCH",url:`/conversations/${conversationA}/reactivate`,headers:{cookie:cookieA}})).statusCode).toBe(200);
    expect((await pool.query("SELECT handoff_error_code FROM conversations WHERE id=$1",[conversationA])).rows[0].handoff_error_code).toBeNull();

    await pool.query(
      "UPDATE conversations SET ai_active=false,handoff_reason='technical_failure',handoff_error_code='empty_final_response' WHERE id=$1",
      [conversationA]
    );
    expect((await app.inject({method:"PATCH",url:`/conversations/${conversationA}/pause`,headers:{cookie:cookieA}})).statusCode).toBe(200);
    const paused=await pool.query<{ai_active:boolean;handoff_reason:string|null;handoff_error_code:string|null}>("SELECT ai_active,handoff_reason,handoff_error_code FROM conversations WHERE id=$1",[conversationA]);
    expect(paused.rows[0]).toEqual({ai_active:false,handoff_reason:"manually_paused",handoff_error_code:null});
    const pausedDashboard=await app.inject({url:"/dashboard",headers:{cookie:cookieA}});
    expect(pausedDashboard.json().counts.handoff).toBe(0);
    expect(pausedDashboard.json().handoffs.map((item:{id:string})=>item.id)).not.toContain(conversationA);
    expect((await app.inject({method:"PATCH",url:`/conversations/${conversationA}/reactivate`,headers:{cookie:cookieA}})).statusCode).toBe(200);
    const active=await pool.query<{ai_active:boolean;handoff_reason:string|null}>("SELECT ai_active,handoff_reason FROM conversations WHERE id=$1",[conversationA]);
    expect(active.rows[0]).toEqual({ai_active:true,handoff_reason:null});
  });
  it("manually overrides an older commercial pause for reactivation and immediate AI reply",async()=>{
    const session=await pool.query<{session_id:string}>("SELECT session_id FROM conversations WHERE id=$1",[conversationA]);
    const phone=nextPhone();
    const created=await pool.query<{id:string;lead_id:string}>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,ai_active,handoff_reason)
       VALUES($1,$2,$3,'Retomada comercial',false,'commercial_handoff') RETURNING id,lead_id`,
      [tenantA,session.rows[0].session_id,phone]
    );
    const conversationId=created.rows[0].id;
    await pool.query(
      `UPDATE scheduling_leads
       SET status='agendado',commercial_updated_at=now(),updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantA,created.rows[0].lead_id]
    );

    const reactivated=await app.inject({
      method:"PATCH",url:`/conversations/${conversationId}/reactivate`,headers:{cookie:cookieA}
    });
    expect(reactivated.statusCode).toBe(200);
    expect((await pool.query<{ai_active:boolean;override_at:Date|null}>(
      "SELECT ai_active,ai_commercial_override_at override_at FROM conversations WHERE id=$1",
      [conversationId]
    )).rows[0]).toMatchObject({ai_active:true,override_at:expect.any(Date)});

    await pool.query(
      `UPDATE scheduling_leads
       SET commercial_updated_at=now()+interval '1 millisecond',updated_at=now()+interval '1 millisecond'
       WHERE tenant_id=$1 AND id=$2`,
      [tenantA,created.rows[0].lead_id]
    );
    await pool.query(
      "UPDATE conversations SET ai_active=false,handoff_reason='commercial_handoff' WHERE id=$1",
      [conversationId]
    );
    const externalId=`commercial-reply-${randomUUID()}`;
    await pool.query(
      `INSERT INTO messages(conversation_id,sender,content,external_message_id,provider_message_key,processed_at)
       VALUES($1,'contact','Pode continuar por aqui',$2,$3,now())`,
      [conversationId,externalId,`${tenantA}:${session.rows[0].session_id}:${externalId}`]
    );

    const response=await app.inject({
      method:"POST",url:`/conversations/${conversationId}/reply-with-ai`,headers:{cookie:cookieA}
    });
    expect(response.statusCode).toBe(202);
    const state=await pool.query<{ai_active:boolean;handoff_reason:string|null;override_at:Date|null;processed_at:Date|null}>(
      `SELECT conversation.ai_active,conversation.handoff_reason,
              conversation.ai_commercial_override_at override_at,message.processed_at
       FROM conversations conversation
       JOIN messages message ON message.conversation_id=conversation.id
       WHERE conversation.id=$1 AND message.external_message_id=$2`,
      [conversationId,externalId]
    );
    expect(state.rows[0]).toMatchObject({
      ai_active:true,handoff_reason:null,override_at:expect.any(Date),processed_at:null
    });
    const job=await inboundQueue.getJob(inboundRecoveryJobId({
      externalId,tenantId:tenantA,sessionId:session.rows[0].session_id,contactPhone:phone,text:""
    }));
    await job?.remove();
  });
  it("requeues the latest unanswered contact message for an immediate AI reply",async()=>{
    const conversation=await pool.query<{session_id:string;contact_phone:string}>(
      "SELECT session_id,contact_phone FROM conversations WHERE id=$1",
      [conversationA]
    );
    const externalId=`manual-ai-recovery-${randomUUID()}`;
    await new MessageRepository(pool).recordInboundAndLoadContext({
      externalId,tenantId:tenantA,sessionId:conversation.rows[0].session_id,
      contactPhone:conversation.rows[0].contact_phone,text:"Mensagem sem resposta após reinício"
    },{claim:false});
    await pool.query(
      `UPDATE messages SET processed_at=now(),processing_started_at=NULL
       WHERE conversation_id=$1 AND external_message_id=$2`,
      [conversationA,externalId]
    );
    await pool.query(
      "UPDATE conversations SET ai_active=false,handoff_reason='manually_paused' WHERE id=$1",
      [conversationA]
    );

    const response=await app.inject({method:"POST",url:`/conversations/${conversationA}/reply-with-ai`,headers:{cookie:cookieA}});
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ok:true,queued:true});
    const state=await pool.query<{ai_active:boolean;handoff_reason:string|null;processed_at:Date|null}>(
      `SELECT c.ai_active,c.handoff_reason,m.processed_at
       FROM conversations c JOIN messages m ON m.conversation_id=c.id
       WHERE c.id=$1 AND m.external_message_id=$2`,
      [conversationA,externalId]
    );
    expect(state.rows[0]).toEqual({ai_active:true,handoff_reason:null,processed_at:null});
    const message={externalId,tenantId:tenantA,sessionId:conversation.rows[0].session_id,contactPhone:conversation.rows[0].contact_phone,text:""};
    const job=await inboundQueue.getJob(inboundRecoveryJobId(message));
    expect(job?.data).toMatchObject({externalId,tenantId:tenantA,sessionId:conversation.rows[0].session_id});
    await job?.remove();
  });
  it("does not duplicate an AI reply while the contact message is already being processed",async()=>{
    const conversation=await pool.query<{session_id:string;contact_phone:string}>(
      "SELECT session_id,contact_phone FROM conversations WHERE id=$1",
      [conversationA]
    );
    const externalId=`ai-processing-${randomUUID()}`;
    await new MessageRepository(pool).recordInboundAndLoadContext({
      externalId,tenantId:tenantA,sessionId:conversation.rows[0].session_id,
      contactPhone:conversation.rows[0].contact_phone,text:"Mensagem em processamento"
    },{claim:false});
    await pool.query(
      `UPDATE messages SET processed_at=NULL,processing_started_at=now()
       WHERE conversation_id=$1 AND external_message_id=$2`,
      [conversationA,externalId]
    );
    const response=await app.inject({method:"POST",url:`/conversations/${conversationA}/reply-with-ai`,headers:{cookie:cookieA}});
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("já está processando");
    await pool.query(
      `UPDATE messages SET processed_at=now(),processing_started_at=NULL
       WHERE conversation_id=$1 AND external_message_id=$2`,
      [conversationA,externalId]
    );
  });
  it("does not ask the AI to answer when the latest message is not from the contact",async()=>{
    await pool.query(
      `INSERT INTO messages(conversation_id,sender,content,external_message_id,provider_message_key)
       VALUES($1,'human','Já respondida',$2,$3)`,
      [conversationA,`human-replied-${randomUUID()}`,`human-replied-key-${randomUUID()}`]
    );
    const response=await app.inject({method:"POST",url:`/conversations/${conversationA}/reply-with-ai`,headers:{cookie:cookieA}});
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("já recebeu resposta");
  });
  it("requires a paused AI and replays a manual message without sending twice",async()=>{
    const key=`manual-${randomUUID()}`;
    const active=await app.inject({method:"POST",url:`/conversations/${conversationA}/messages`,headers:{cookie:cookieA,"idempotency-key":key},payload:{text:"Resposta humana idempotente"}});
    expect(active.statusCode).toBe(409);
    await app.inject({method:"PATCH",url:`/conversations/${conversationA}/pause`,headers:{cookie:cookieA}});
    expect((await app.inject({method:"POST",url:`/conversations/${conversationA}/messages`,headers:{cookie:cookieA},payload:{text:"Sem chave"}})).statusCode).toBe(400);

    const send=vi.spyOn(WhatsAppSessionManager.prototype,"sendText").mockResolvedValue({externalId:`manual-${randomUUID()}`});
    try{
      const request={method:"POST" as const,url:`/conversations/${conversationA}/messages`,headers:{cookie:cookieA,"idempotency-key":key},payload:{text:"Resposta humana idempotente"}};
      const first=await app.inject(request);
      const replay=await app.inject(request);
      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({sent:true,externalId:first.json().externalId,duplicate:true});
      expect(send).toHaveBeenCalledTimes(1);
      const messages=await pool.query("SELECT sender,content FROM messages WHERE conversation_id=$1 AND content=$2",[conversationA,"Resposta humana idempotente"]);
      expect(messages.rows).toEqual([{sender:"human",content:"Resposta humana idempotente"}]);
    }finally{
      send.mockRestore();
      await app.inject({method:"PATCH",url:`/conversations/${conversationA}/reactivate`,headers:{cookie:cookieA}});
    }
  });
  it("persists and safely resends text messages rejected by a closed WhatsApp connection",async()=>{
    await pool.query("UPDATE conversations SET ai_active=false,status='open' WHERE id=$1",[conversationA]);
    const failedText=`Mensagem recuperável ${randomUUID()}`;
    const newerDisconnectedSession=randomUUID();
    const closed=vi.spyOn(WhatsAppSessionManager.prototype,"sendText").mockRejectedValue(
      new WhatsAppSendRejectedError("Connection Closed")
    );
    try{
      const failed=await app.inject({
        method:"POST",url:`/conversations/${conversationA}/messages`,headers:{cookie:cookieA,"idempotency-key":`recovery-${randomUUID()}`},payload:{text:failedText}
      });
      expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    }finally{
      closed.mockRestore();
    }

    const preview=await app.inject({url:"/connection/failed-messages",headers:{cookie:cookieA}});
    expect(preview.statusCode).toBe(200);
    expect(preview.json().recovery.available).toBe(1);
    const originalSession=(await pool.query<{session_id:string}>("SELECT session_id FROM conversations WHERE id=$1",[conversationA])).rows[0].session_id;
    await pool.query(
      "INSERT INTO whatsapp_sessions(id,tenant_id,instance_name,status) VALUES($1,$2,$3,'disconnected')",
      [newerDisconnectedSession,tenantA,`disconnected-${randomUUID()}`]
    );

    const resend=vi.spyOn(WhatsAppSessionManager.prototype,"sendText").mockImplementation(async()=>{
      await new Promise((resolve)=>setTimeout(resolve,25));
      return {externalId:`recovered-${randomUUID()}`};
    });
    try{
      const [recovered,concurrent]=await Promise.all([
        app.inject({method:"POST",url:"/connection/failed-messages/resend",headers:{cookie:cookieA}}),
        app.inject({method:"POST",url:"/connection/failed-messages/resend",headers:{cookie:cookieA}})
      ]);
      expect(recovered.statusCode).toBe(200);
      expect(concurrent.statusCode).toBe(200);
      expect(recovered.json().sent+concurrent.json().sent).toBe(1);
      expect(recovered.json().failed+concurrent.json().failed).toBe(0);
      expect(resend).toHaveBeenCalledOnce();
      expect(resend).toHaveBeenCalledWith(originalSession,expect.any(String),failedText);
      expect((await pool.query("SELECT content,status FROM messages WHERE tenant_id=$1 AND content=$2",[tenantA,failedText])).rows)
        .toEqual([{content:failedText,status:"sent"}]);
      const replay=await app.inject({method:"POST",url:"/connection/failed-messages/resend",headers:{cookie:cookieA}});
      expect(replay.json()).toMatchObject({sent:0,failed:0,remaining:0});
    }finally{
      resend.mockRestore();
      await pool.query("DELETE FROM whatsapp_sessions WHERE id=$1",[newerDisconnectedSession]);
      await app.inject({method:"PATCH",url:`/conversations/${conversationA}/reactivate`,headers:{cookie:cookieA}});
    }
  });
  it("does not resend when the provider accepted the message but local recording failed",async()=>{
    await pool.query("UPDATE conversations SET ai_active=false,status='open' WHERE id=$1",[conversationA]);
    const failedText=`Mensagem ambígua ${randomUUID()}`;
    const requestKey=`ambiguous-${randomUUID()}`;
    const closed=vi.spyOn(WhatsAppSessionManager.prototype,"sendText").mockRejectedValueOnce(
      new WhatsAppSendRejectedError("Connection Closed")
    );
    try{
      await app.inject({
        method:"POST",url:`/conversations/${conversationA}/messages`,headers:{cookie:cookieA,"idempotency-key":requestKey},payload:{text:failedText}
      });
    }finally{
      closed.mockRestore();
    }
    await pool.query(
      `UPDATE outbound_message_requests
       SET recovery_payload=jsonb_set(recovery_payload,'{sentByUserId}',to_jsonb($3::text))
       WHERE tenant_id=$1 AND idempotency_key=$2`,
      [tenantA,requestKey,"00000000-0000-4000-8000-000000000999"]
    );

    const resend=vi.spyOn(WhatsAppSessionManager.prototype,"sendText").mockResolvedValue({externalId:`ambiguous-${randomUUID()}`});
    try{
      const first=await app.inject({method:"POST",url:"/connection/failed-messages/resend",headers:{cookie:cookieA}});
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({sent:0,failed:0,ambiguous:1,remaining:0});
      const second=await app.inject({method:"POST",url:"/connection/failed-messages/resend",headers:{cookie:cookieA}});
      expect(second.json()).toMatchObject({sent:0,failed:0,ambiguous:0,remaining:0});
      expect(resend).toHaveBeenCalledOnce();
      expect((await pool.query(
        "SELECT status,external_message_id FROM outbound_message_requests WHERE tenant_id=$1 AND idempotency_key=$2",
        [tenantA,requestKey]
      )).rows[0]).toMatchObject({status:"ambiguous"});
    }finally{
      resend.mockRestore();
      await app.inject({method:"PATCH",url:`/conversations/${conversationA}/reactivate`,headers:{cookie:cookieA}});
    }
  });
  it("sends media idempotently and serves conversation media through the authenticated proxy",async()=>{
    await app.inject({method:"PATCH",url:`/conversations/${conversationA}/pause`,headers:{cookie:cookieA}});
    const send=vi.spyOn(WhatsAppSessionManager.prototype,"sendMedia").mockResolvedValue({externalId:`media-${randomUUID()}`});
    try{
      const key=`media-${randomUUID()}`;
      const request={
        method:"POST" as const,
        url:`/conversations/${conversationA}/messages`,
        headers:{cookie:cookieA,"idempotency-key":key},
        payload:{mediaType:"audio",mimeType:"audio/webm;codecs=opus",fileName:"gravacao.webm",dataBase64:"V2ViTQ=="}
      };
      const first=await app.inject(request);
      const replay=await app.inject(request);
      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(expect.any(String),expect.any(String),expect.objectContaining({
        mediaType:"audio",mimeType:"audio/webm",fileName:"gravacao.webm",dataBase64:"V2ViTQ=="
      }));
      const stored=await pool.query<{id:string;media_type:string;media_mime_type:string;media_file_name:string;media_size_bytes:number}>(
        "SELECT id,media_type,media_mime_type,media_file_name,media_size_bytes FROM messages WHERE conversation_id=$1 AND external_message_id=$2",
        [conversationA,first.json().externalId]
      );
      expect(stored.rows[0]).toMatchObject({media_type:"audio",media_mime_type:"audio/webm",media_file_name:"gravacao.webm",media_size_bytes:4});

      const download=vi.spyOn(WhatsAppSessionManager.prototype,"downloadMedia").mockResolvedValue({
        base64:"V2ViTQ==",mimeType:"audio/webm",fileName:"gravacao.webm"
      });
      try{
        const media=await app.inject({url:`/conversations/${conversationA}/messages/${stored.rows[0].id}/media`,headers:{cookie:cookieA}});
        expect(media.statusCode).toBe(200);
        expect(media.headers["content-type"]).toContain("audio/webm");
        expect(media.rawPayload).toEqual(Buffer.from("WebM"));
        expect((await app.inject({url:`/conversations/${conversationB}/messages/${stored.rows[0].id}/media`,headers:{cookie:cookieA}})).statusCode).toBe(404);
        expect(download).toHaveBeenCalledOnce();
      }finally{
        download.mockRestore();
      }
    }finally{
      send.mockRestore();
      await app.inject({method:"PATCH",url:`/conversations/${conversationA}/reactivate`,headers:{cookie:cookieA}});
    }
  });
  it("keeps reply-with-ai unavailable for Instagram before any WhatsApp effect", async () => {
    const instagram=await createInstagramConversationFixture();
    const sendText = vi.spyOn(WhatsAppSessionManager.prototype, "sendText");
    const sendMedia = vi.spyOn(WhatsAppSessionManager.prototype, "sendMedia");
    const pause = vi.spyOn(QualificationService.prototype, "pauseForConversation");
    try {
      const before=await pool.query<{messages:number;requests:number}>(
        `SELECT
           (SELECT count(*)::int FROM messages WHERE conversation_id=$1) messages,
           (SELECT count(*)::int FROM outbound_message_requests WHERE conversation_id=$1) requests`,
        [instagram.conversationId]
      );
      const response = await app.inject({
        method: "POST", url: `/conversations/${instagram.conversationId}/reply-with-ai`, headers: { cookie: cookieA }
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "Esta conversa pertence ao canal Instagram e não pode ser enviada pelo WhatsApp" });
      expect((await pool.query<{messages:number;requests:number}>(
        `SELECT
           (SELECT count(*)::int FROM messages WHERE conversation_id=$1) messages,
           (SELECT count(*)::int FROM outbound_message_requests WHERE conversation_id=$1) requests`,
        [instagram.conversationId]
      )).rows[0]).toEqual(before.rows[0]);
      expect(sendText).not.toHaveBeenCalled();
      expect(sendMedia).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
    } finally {
      sendText.mockRestore(); sendMedia.mockRestore(); pause.mockRestore();
      await deleteInstagramConversationFixture(instagram);
    }
  });

  it("blocks unsupported Instagram message effects and keeps local deletion available", async () => {
    const instagram=await createInstagramConversationFixture();
    const messages = await pool.query<{ id: string }>(
      `INSERT INTO messages(conversation_id,sender,content,external_message_id)
       VALUES ($1,'human','canal instagram follow-up','external-follow-up'),
              ($1,'human','canal instagram reaction','external-reaction'),
              ($1,'human','canal instagram edit','external-edit'),
              ($1,'human','canal instagram delete','external-delete')
       RETURNING id`,
      [instagram.conversationId]
    );
    const [followUpMessage, reactionMessage, editMessage, deleteMessage] = messages.rows;
    const sendText = vi.spyOn(WhatsAppSessionManager.prototype, "sendText");
    const sendReaction = vi.spyOn(WhatsAppSessionManager.prototype, "sendReactionStrict");
    const updateText = vi.spyOn(WhatsAppSessionManager.prototype, "updateText");
    const deleteForEveryone = vi.spyOn(WhatsAppSessionManager.prototype, "deleteMessageForEveryone");
    try {
      const followUp = await app.inject({
        method: "POST", url: `/conversations/${instagram.conversationId}/follow-up`,
        headers: { cookie: cookieA, "idempotency-key": `instagram-follow-up-${randomUUID()}` }
      });
      expect(followUp.statusCode).toBe(409);
      expect(followUp.json()).toEqual({ error: "Esta conversa pertence ao canal Instagram e não pode ser enviada pelo WhatsApp" });

      const reaction = await app.inject({
        method: "POST", url: `/conversations/${instagram.conversationId}/messages/${reactionMessage.id}/react`,
        headers: { cookie: cookieA }, payload: { emoji: "👍" }
      });
      expect(reaction.statusCode).toBe(409);
      expect(reaction.json()).toEqual({ code: "CHANNEL_OPERATION_UNSUPPORTED", error: "A operação reagir não é suportada no Instagram" });

      const edit = await app.inject({
        method: "PATCH", url: `/conversations/${instagram.conversationId}/messages/${editMessage.id}`,
        headers: { cookie: cookieA }, payload: { text: "não editar" }
      });
      expect(edit.statusCode).toBe(409);
      expect(edit.json()).toEqual({ code: "CHANNEL_OPERATION_UNSUPPORTED", error: "A operação editar mensagem não é suportada no Instagram" });

      const everyone = await app.inject({
        method: "DELETE", url: `/conversations/${instagram.conversationId}/messages/${deleteMessage.id}`,
        headers: { cookie: cookieA }, payload: { forEveryone: true }
      });
      expect(everyone.statusCode).toBe(409);
      expect(everyone.json()).toEqual({ code: "CHANNEL_OPERATION_UNSUPPORTED", error: "A operação apagar mensagem para todos não é suportada no Instagram" });

      const untouched = await pool.query<{ content: string; deleted_at: Date | null; deleted_for_everyone_at: Date | null }>(
        "SELECT content,deleted_at,deleted_for_everyone_at FROM messages WHERE id=ANY($1::uuid[]) ORDER BY id",
        [messages.rows.map((message) => message.id)]
      );
      expect(untouched.rows).toHaveLength(4);
      expect(untouched.rows.every((message) => message.deleted_at === null && message.deleted_for_everyone_at === null)).toBe(true);
      expect(sendText).not.toHaveBeenCalled();
      expect(sendReaction).not.toHaveBeenCalled();
      expect(updateText).not.toHaveBeenCalled();
      expect(deleteForEveryone).not.toHaveBeenCalled();

      const local = await app.inject({
        method: "DELETE", url: `/conversations/${instagram.conversationId}/messages/${followUpMessage.id}`,
        headers: { cookie: cookieA }, payload: { forEveryone: false }
      });
      expect(local.statusCode).toBe(200);
      expect(local.json()).toEqual({ ok: true });
      const localState = await pool.query<{ deleted_at: Date | null; deleted_for_everyone_at: Date | null }>(
        "SELECT deleted_at,deleted_for_everyone_at FROM messages WHERE id=$1", [followUpMessage.id]
      );
      expect(localState.rows[0].deleted_at).not.toBeNull();
      expect(localState.rows[0].deleted_for_everyone_at).toBeNull();
    } finally {
      sendText.mockRestore(); sendReaction.mockRestore(); updateText.mockRestore(); deleteForEveryone.mockRestore();
      await pool.query("DELETE FROM messages WHERE id=ANY($1::uuid[])", [messages.rows.map((message) => message.id)]);
      await deleteInstagramConversationFixture(instagram);
    }
  });

  it("returns AI stickers as visual messages without exposing a file name",async()=>{
    const sticker=await pool.query<{id:string}>(
      `INSERT INTO ai_stickers(
         tenant_id,name,description,tags,mime_type,file_name,size_bytes,content_hash,media_data,source,enabled
       ) VALUES($1,'Confirmação','Confirmar atendimento','{}','image/webp','interno.webp',12,$2,$3,'panel_upload',true)
       RETURNING id`,
      [tenantA,randomUUID(),Buffer.from("RIFF0000WEBP")]
    );
    const externalId=`sticker-${randomUUID()}`;
    await new MessageRepository(pool).recordAiStickerSend({
      tenantId:tenantA,conversationId:conversationA,stickerId:sticker.rows[0].id,externalId
    });
    const detail=await app.inject({url:`/conversations/${conversationA}/messages`,headers:{cookie:cookieA}});
    expect(detail.statusCode).toBe(200);
    const message=detail.json().messages.find((item:{external_message_id?:string;media_is_sticker?:boolean})=>item.media_is_sticker);
    expect(message).toMatchObject({
      sender:"agent",content:"",media_type:"image",media_mime_type:"image/webp",
      media_file_name:null,media_size_bytes:12,media_is_sticker:true
    });
    const download=vi.spyOn(WhatsAppSessionManager.prototype,"downloadMedia").mockResolvedValue({
      base64:Buffer.from("RIFF0000WEBP").toString("base64"),mimeType:"image/webp",fileName:"provider-name.webp"
    });
    try{
      const media=await app.inject({url:`/conversations/${conversationA}/messages/${message.id}/media`,headers:{cookie:cookieA}});
      expect(media.statusCode).toBe(200);
      expect(media.headers["content-type"]).toContain("image/webp");
      expect(media.rawPayload).toEqual(Buffer.from("RIFF0000WEBP"));
    }finally{
      download.mockRestore();
    }
  });
  it("keeps AI configuration and usage invisible to every non-ROOT role",async()=>{
    for(const cookie of [readOnlyCookie,cookieA]){
      expect((await app.inject({url:"/agent",headers:{cookie}})).statusCode).toBe(403);
      expect((await app.inject({url:"/humanizer",headers:{cookie}})).statusCode).toBe(403);
      expect((await app.inject({url:"/usage",headers:{cookie}})).statusCode).toBe(403);
      expect((await app.inject({url:"/usage/credits",headers:{cookie}})).statusCode).toBe(403);
      expect((await app.inject({url:"/usage/export",headers:{cookie}})).statusCode).toBe(403);
      for (const url of [
        "/agent/quality/summary",
        "/agent/evaluations",
        "/agent/regression-cases",
        "/agent/improvement-proposals",
        "/agent/versions",
        "/agent/evaluator-settings"
      ]) expect((await app.inject({url,headers:{cookie}})).statusCode).toBe(404);
    }
    const agentPayload={systemPrompt:"tentativa não ROOT",aiModel:"blocked/model",temperature:.5,maxTokens:512,isActive:false};
    expect((await app.inject({method:"PUT",url:"/agent",headers:{cookie:cookieA},payload:agentPayload})).statusCode).toBe(403);
    expect((await app.inject({method:"PATCH",url:"/agent/status",headers:{cookie:cookieA},payload:{isActive:false}})).statusCode).toBe(403);
    expect((await app.inject({method:"PUT",url:"/humanizer",headers:{cookie:cookieA},payload:{}})).statusCode).toBe(403);
    const dashboard=await app.inject({url:"/dashboard",headers:{cookie:cookieA}});
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().agent).toBeNull();
    const agents=await pool.query<{tenant_id:string;system_prompt:string;is_active:boolean}>("SELECT tenant_id,system_prompt,is_active FROM agent_configs WHERE tenant_id IN($1,$2)",[tenantA,tenantB]);
    expect(agents.rows.find(x=>x.tenant_id===tenantA)).toMatchObject({system_prompt:`prompt-${tenantA}`,is_active:true});
    expect(agents.rows.find(x=>x.tenant_id===tenantB)).toMatchObject({system_prompt:`prompt-${tenantB}`,is_active:true});
  });
  it("updates only the authenticated workspace profile",async()=>{
    const response=await app.inject({method:"PATCH",url:"/workspaces/current",headers:{cookie:cookieA},payload:{name:"Painel A atualizado",attendantPhone:"5511999999999"}});
    expect(response.statusCode).toBe(200);
    const rows=await pool.query<{id:string;name:string;attendant_phone:string|null}>("SELECT id,name,attendant_phone FROM tenants WHERE id IN($1,$2)",[tenantA,tenantB]);
    expect(rows.rows.find(x=>x.id===tenantA)).toMatchObject({name:"Painel A atualizado",attendant_phone:"5511999999999"});
    expect(rows.rows.find(x=>x.id===tenantB)!.name).not.toBe("Painel A atualizado");
    const invalidPhone=await app.inject({method:"PATCH",url:"/workspaces/current",headers:{cookie:cookieA},payload:{attendantPhone:"número inválido"}});
    expect(invalidPhone.statusCode).toBe(400);
  });
  it("checks ROOT access before parsing usage filters",async()=>{
    const response=await app.inject({url:"/usage?month=2026-99",headers:{cookie:cookieA}});
    expect(response.statusCode).toBe(403);
  });
  it("keeps the destructive dev reset restricted to ROOT",async()=>{
    await pool.query("INSERT INTO messages(conversation_id,sender,content) VALUES($1,'contact','mensagem para reset')",[conversationA]);
    const response=await app.inject({method:"DELETE",url:`/root/workspaces/${tenantA}/contacts-and-messages`,headers:{cookie:cookieA}});
    expect(response.statusCode).toBe(403);
    expect((await pool.query("SELECT id FROM conversations WHERE id=$1",[conversationA])).rowCount).toBe(1);
    expect((await pool.query("SELECT id FROM conversations WHERE id=$1",[conversationB])).rowCount).toBe(1);
  });
  it("rate-limits repeated login attempts from the same address",async()=>{
    const statuses=[];
    for(let index=0;index<12;index++){
      const response=await app.inject({method:"POST",url:"/auth/login",payload:{email:`missing-${index}@test.local`,password:"invalid-password"}});
      statuses.push(response.statusCode);
    }
    expect(statuses).toContain(429);
  },30_000);
});
