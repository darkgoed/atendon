import { createHash, randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { reconcilePendingMeetingResults } from "../src/modules/commercial-journey/reconciliation.js";
import { SchedulingNotificationRepository } from "../src/modules/scheduling/notification-repository.js";
import { markLeadDisqualified } from "../src/modules/scheduling/service.js";

const pool=new pg.Pool({connectionString:config.DATABASE_URL});const app=buildApp();const apiKey=`test-${randomUUID()}`;const otherApiKey=`other-${randomUUID()}`;let tenantId="";let otherTenantId="";let cookie="";let leadA="";let leadB="";
const apiHeaders={"x-api-key":apiKey};
let phoneSequence=Number(String(Date.now()).slice(-8));
function testPhone(ddd="11") { phoneSequence=(phoneSequence+1)%100_000_000; return `55${ddd}9${String(phoneSequence).padStart(8,"0")}`; }
async function ensureOwnerCloser() {
  const owner=await pool.query<{member_id:string}>(
    `SELECT member.id member_id FROM workspace_members member
     JOIN workspace_roles role ON role.id=member.role_id
     WHERE member.workspace_id=$1 AND role.name='OWNER' LIMIT 1`,
    [tenantId]
  );
  await pool.query(
    `INSERT INTO scheduling_google_meet_closers(tenant_id,member_id,availability_status)
     VALUES($1,$2,'available')
     ON CONFLICT(tenant_id,member_id) DO UPDATE SET availability_status='available'`,
    [tenantId,owner.rows[0].member_id]
  );
  return owner.rows[0].member_id;
}

beforeAll(async()=>{await app.ready();const tenant=await pool.query<{id:string}>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",[`Scheduling ${randomUUID()}`]);tenantId=tenant.rows[0].id;const other=await pool.query<{id:string}>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",[`Other ${randomUUID()}`]);otherTenantId=other.rows[0].id;await pool.query("INSERT INTO tenant_api_keys(tenant_id,key_hash) VALUES($1,$2),($3,$4)",[tenantId,createHash("sha256").update(apiKey).digest("hex"),otherTenantId,createHash("sha256").update(otherApiKey).digest("hex")]);const email=`schedule-${randomUUID()}@test.local`;const passwordHash=await hash("schedule-password",4);const client=await pool.connect();try{await client.query("BEGIN");await ensureWorkspaceDefaultRoles(client,tenantId);const user=await client.query<{id:string}>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",[email,passwordHash]);await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'",[tenantId,user.rows[0].id]);await client.query("COMMIT")}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}const login=await app.inject({method:"POST",url:"/auth/login",payload:{email,password:"schedule-password"}});cookie=(Array.isArray(login.headers["set-cookie"])?login.headers["set-cookie"][0]:login.headers["set-cookie"]!).split(";")[0];
  await pool.query("INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'categoria-teste','Categoria teste')",[tenantId]);
  await pool.query("INSERT INTO scheduling_partners(tenant_id,id,name,priority_order,proposal_link) VALUES($1,'parceiro-teste','Parceiro teste',1,'https://example.test/proposta')",[tenantId]);
  await pool.query("INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity) VALUES($1,'unidade-teste','Unidade teste','09:00','12:00',ARRAY[1,2,3,4,5]::smallint[],60,1)",[tenantId]);
  await pool.query("INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity) VALUES($1,'unidade-capacidade','Unidade capacidade','09:00','12:00',ARRAY[1]::smallint[],60,2)",[tenantId]);
});
afterAll(async()=>{await pool.query("DELETE FROM tenants WHERE id IN($1,$2)",[tenantId,otherTenantId]);await app.close();await pool.end()});

describe("scheduling API",()=>{
  it("requires an API key and rejects a tenant mismatch",async()=>{expect((await app.inject({url:"/categorias"})).statusCode).toBe(401);expect((await app.inject({url:`/categorias?tenant=${otherTenantId}`,headers:apiHeaders})).statusCode).toBe(403)});
  it("lists only active tenant configuration in partner priority order",async()=>{await pool.query("UPDATE scheduling_partners SET priority_order=2 WHERE tenant_id=$1 AND id='parceiro-teste'",[tenantId]);await pool.query("INSERT INTO scheduling_partners(tenant_id,id,name,priority_order,proposal_link,active) VALUES($1,'prioritario','Prioritário',1,'https://example.test/primeiro',true),($1,'inativo','Inativo',4,'https://example.test/inativo',false)",[tenantId]);const response=await app.inject({url:`/parceiros?tenant=${tenantId}`,headers:apiHeaders});expect(response.statusCode).toBe(200);expect(response.json().parceiros.map((x:{id:string})=>x.id)).toEqual(["prioritario","parceiro-teste"]);expect((await app.inject({url:`/categorias?tenant=${tenantId}`,headers:apiHeaders})).json().categorias).toHaveLength(1)});
  it("upserts leads by tenant and phone, preserving omitted fields",async()=>{const first=await app.inject({method:"POST",url:"/leads",headers:apiHeaders,payload:{telefone:"5511999999999",nome:"Lead A",categoria_interesse_id:"categoria-teste",unidade_id:"unidade-teste",origem:"teste"}});expect(first.statusCode).toBe(201);leadA=first.json().lead.id;const second=await app.inject({method:"POST",url:"/leads",headers:apiHeaders,payload:{telefone:"5511999999999",nome:"Lead A atualizado"}});expect(second.statusCode).toBe(200);expect(second.json().lead).toMatchObject({id:leadA,nome:"Lead A atualizado",categoria_interesse_id:"categoria-teste",unidade_id:"unidade-teste"});const invalid=await app.inject({method:"POST",url:"/leads",headers:apiHeaders,payload:{telefone:"5511777777777",nome:"Incompleto"}});expect(invalid.statusCode).toBe(400);const created=await app.inject({method:"POST",url:"/leads",headers:apiHeaders,payload:{telefone:"5511888888888",nome:"Lead B",categoria_interesse_id:"categoria-teste",unidade_id:"unidade-teste",origem:"teste"}});expect(created.statusCode).toBe(201);leadB=created.json().lead.id});
  it("persists a boleto disqualification once with canonical commercial fields",async()=>{
    const created=await pool.query<{id:string}>(
      "INSERT INTO scheduling_leads(tenant_id,phone,name,status,source) VALUES($1,$2,'Lead boleto','em_atendimento','whatsapp') RETURNING id",
      [tenantId,testPhone()]
    );
    const leadId=created.rows[0].id;
    await expect(markLeadDisqualified(tenantId,leadId)).resolves.toMatchObject({
      id:leadId,status:"perdido",commercial_outcome:"nao_avancou",loss_reason:"nao_qualificado"
    });
    await expect(markLeadDisqualified(tenantId,leadId)).resolves.toMatchObject({
      id:leadId,status:"perdido",commercial_outcome:"nao_avancou",loss_reason:"nao_qualificado"
    });
    const events=await pool.query<{count:number}>(
      "SELECT count(*)::int count FROM scheduling_lead_events WHERE tenant_id=$1 AND lead_id=$2 AND event_type='lead_desqualificado' AND details->>'reason'='tripz_boleto_payment'",
      [tenantId,leadId]
    );
    expect(events.rows[0].count).toBe(1);
  });
  it("serializes concurrent lead upserts by normalized phone",async()=>{
    const suffix=Date.now().toString().slice(-8);
    const digits=`5511${suffix}`;
    const formatted=`+55 (11) ${suffix.slice(0,4)}-${suffix.slice(4)}`;
    const [raw,pretty]=await Promise.all([
      app.inject({method:"POST",url:"/leads",headers:apiHeaders,payload:{telefone:digits,nome:"Lead concorrente",origem:"teste"}}),
      app.inject({method:"POST",url:"/leads",headers:apiHeaders,payload:{telefone:formatted,nome:"Lead concorrente",origem:"teste"}})
    ]);
    expect([raw.statusCode,pretty.statusCode].sort()).toEqual([200,201]);
    expect(raw.json().lead.id).toBe(pretty.json().lead.id);
    expect((await pool.query<{count:number}>(
      "SELECT count(*)::int count FROM scheduling_leads WHERE tenant_id=$1 AND regexp_replace(phone,'\\D','','g')=$2",
      [tenantId,digits]
    )).rows[0].count).toBe(1);
  });
  it("projects the WhatsApp contact avatar into lead list and detail",async()=>{
    const session=await pool.query<{id:string}>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",[tenantId]);
    await pool.query(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,contact_avatar_url,contact_avatar_updated_at) VALUES($1,$2,'5511999999999','Lead A atualizado','https://cdn.example/lead-a.jpg',now())",
      [tenantId,session.rows[0].id]
    );
    const list=await app.inject({url:"/scheduling/leads?busca=5511999999999",headers:{cookie}});
    expect(list.statusCode).toBe(200);
    expect(list.json().leads.find((lead:{id:string})=>lead.id===leadA).avatar_url).toBe("https://cdn.example/lead-a.jpg");
    const detail=await app.inject({url:`/scheduling/leads/${leadA}`,headers:{cookie}});
    expect(detail.statusCode).toBe(200);
    expect(detail.json().lead.avatar_url).toBe("https://cdn.example/lead-a.jpg");
  });
  it("projects an AI-registered lead name back into the linked conversation",async()=>{
    const updated=await app.inject({
      method:"POST",url:"/leads",headers:apiHeaders,
      payload:{telefone:"5511999999999",nome:"Nome real registrado pela IA"}
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().lead).toMatchObject({id:leadA,nome:"Nome real registrado pela IA"});
    expect((await pool.query<{contact_name:string|null}>(
      "SELECT contact_name FROM conversations WHERE tenant_id=$1 AND regexp_replace(contact_phone,'\\D','','g')=$2",
      [tenantId,"5511999999999"]
    )).rows[0].contact_name).toBe("Nome real registrado pela IA");
  });
  it("edits lead identity and synchronizes the linked WhatsApp contact",async()=>{
    const nextPhone=testPhone();
    const formattedPhone=`+${nextPhone.slice(0,2)} (${nextPhone.slice(2,4)}) ${nextPhone.slice(4)}`;
    const updated=await app.inject({
      method:"PATCH",url:`/scheduling/leads/${leadA}/identity`,headers:{cookie},
      payload:{nome:"Contato editado",telefone:formattedPhone}
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().lead).toMatchObject({id:leadA,nome:"Contato editado",telefone:nextPhone});
    expect((await pool.query(
      "SELECT contact_name,contact_phone,contact_avatar_url FROM conversations WHERE tenant_id=$1 AND regexp_replace(contact_phone,'\\D','','g')=$2",
      [tenantId,nextPhone]
    )).rows[0]).toMatchObject({contact_name:"Contato editado",contact_phone:nextPhone,contact_avatar_url:"https://cdn.example/lead-a.jpg"});
    const duplicate=await app.inject({
      method:"PATCH",url:`/scheduling/leads/${leadA}/identity`,headers:{cookie},payload:{telefone:"5511888888888"}
    });
    expect(duplicate.statusCode).toBe(409);
    expect((await pool.query("SELECT phone FROM scheduling_leads WHERE id=$1",[leadA])).rows[0].phone).toBe(nextPhone);
    expect((await app.inject({method:"PATCH",url:`/scheduling/leads/${leadA}/identity`,payload:{nome:"Sem sessão"}})).statusCode).toBe(401);
    const restored=await app.inject({
      method:"PATCH",url:`/scheduling/leads/${leadA}/identity`,headers:{cookie},
      payload:{nome:"Lead A atualizado",telefone:"5511999999999"}
    });
    expect(restored.statusCode).toBe(200);
  });
  it("associates the configured partner and returns its proposal link",async()=>{const response=await app.inject({method:"POST",url:`/leads/${leadA}/proposta-parceiro`,headers:apiHeaders,payload:{parceiro_id:"parceiro-teste"}});expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({link_proposta:"https://example.test/proposta",status:"proposta_enviada"})});
  it("returns only operating slots and their capacity",async()=>{const monday=await app.inject({url:"/unidades/unidade-teste/horarios?data=2030-01-07",headers:apiHeaders});expect(monday.statusCode).toBe(200);expect(monday.json().horarios).toHaveLength(3);const sunday=await app.inject({url:"/unidades/unidade-teste/horarios?data=2030-01-06",headers:apiHeaders});expect(sunday.json().horarios).toEqual([])});
  it("accepts broken-minute fits and blocks overlap until the configured duration ends",async()=>{
    const createLead=async(index:number)=>{
      const response=await app.inject({method:"POST",url:"/leads",headers:apiHeaders,payload:{telefone:testPhone(),nome:`Encaixe ${index}`,categoria_interesse_id:"categoria-teste",unidade_id:"unidade-teste",origem:"teste"}});
      expect(response.statusCode).toBe(201);
      return response.json().lead.id as string;
    };
    const [firstLead,overlapLead,nextLead]=await Promise.all([1,2,3].map(createLead));
    const first=await app.inject({method:"POST",url:"/agendamentos",headers:apiHeaders,payload:{lead_id:firstLead,unidade_id:"unidade-teste",start:"2030-01-09T09:40:00.000Z"}});
    expect(first.statusCode).toBe(201);
    expect(first.json().agendamento).toMatchObject({start:"2030-01-09T09:40:00.000Z",end:"2030-01-09T10:40:00.000Z"});
    const overlap=await app.inject({method:"POST",url:"/agendamentos",headers:apiHeaders,payload:{lead_id:overlapLead,unidade_id:"unidade-teste",start:"2030-01-09T10:00:00.000Z"}});
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json().error).toMatch(/capacidade/);
    const next=await app.inject({method:"POST",url:"/agendamentos",headers:apiHeaders,payload:{lead_id:nextLead,unidade_id:"unidade-teste",start:"2030-01-09T10:40:00.000Z"}});
    expect(next.statusCode).toBe(201);
  });
  it("shows the real start of an off-grid appointment and distinguishes a future conflict",async()=>{
    await pool.query(
      "INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity) VALUES($1,'unidade-grade-quebrada','Unidade grade quebrada','08:30','13:30',ARRAY[1,2,3,4,5]::smallint[],60,1)",
      [tenantId]
    );
    const lead=await app.inject({method:"POST",url:"/leads",headers:apiHeaders,payload:{telefone:testPhone(),nome:"Lead fora da grade",categoria_interesse_id:"categoria-teste",unidade_id:"unidade-grade-quebrada",origem:"teste"}});
    expect(lead.statusCode).toBe(201);
    const booked=await app.inject({method:"POST",url:"/agendamentos",headers:apiHeaders,payload:{lead_id:lead.json().lead.id,unidade_id:"unidade-grade-quebrada",start:"2030-01-09T11:00:00.000Z"}});
    expect(booked.statusCode).toBe(201);

    const response=await app.inject({url:"/scheduling/availability?unidade_id=unidade-grade-quebrada&data=2030-01-09",headers:{cookie}});
    expect(response.statusCode).toBe(200);
    const slots=new Map(response.json().horarios.map((slot:{start:string;vagas:number;ocupados_no_inicio:number})=>[slot.start,slot]));
    expect(slots.get("2030-01-09T10:30:00.000Z")).toMatchObject({vagas:0,ocupados_no_inicio:0});
    expect(slots.get("2030-01-09T11:00:00.000Z")).toMatchObject({vagas:0,ocupados_no_inicio:1});
    expect(slots.get("2030-01-09T11:30:00.000Z")).toMatchObject({vagas:0,ocupados_no_inicio:1});
  });
  it("bounds agenda queries to an operationally safe period",async()=>{
    const reversed=await app.inject({
      url:"/scheduling/appointments?unidade_id=unidade-teste&inicio=2030-03-02&fim=2030-03-01",
      headers:{cookie}
    });
    expect(reversed.statusCode).toBe(400);
    const oversized=await app.inject({
      url:"/scheduling/appointments?unidade_id=unidade-teste&inicio=2030-01-01&fim=2030-03-01",
      headers:{cookie}
    });
    expect(oversized.statusCode).toBe(400);
  });
  it("honors configurable capacity and reports remaining vacancies",async()=>{const payload=(lead_id:string)=>({lead_id,unidade_id:"unidade-capacidade",start:"2030-01-07T09:00:00.000Z"});const first=await app.inject({method:"POST",url:"/agendamentos",headers:apiHeaders,payload:payload(leadA)});expect(first.statusCode).toBe(201);expect(first.json().agendamento.end).toBe("2030-01-07T10:00:00.000Z");const availability=await app.inject({url:"/unidades/unidade-capacidade/horarios?data=2030-01-07",headers:apiHeaders});expect(availability.json().horarios[0].vagas).toBe(1);const second=await app.inject({method:"POST",url:"/agendamentos",headers:apiHeaders,payload:payload(leadB)});expect(second.statusCode).toBe(201);expect((await app.inject({method:"POST",url:"/agendamentos",headers:apiHeaders,payload:payload(leadA)})).statusCode).toBe(409);await app.inject({method:"DELETE",url:`/agendamentos/${first.json().agendamento.id}`,headers:apiHeaders});await app.inject({method:"DELETE",url:`/agendamentos/${second.json().agendamento.id}`,headers:apiHeaders})});
  it("rejects booking outside configured slots, in the past, and cross-tenant relational references",async()=>{const outside=await app.inject({method:"POST",url:"/agendamentos",headers:apiHeaders,payload:{lead_id:leadA,unidade_id:"unidade-teste",start:"2030-01-07T08:00:00.000Z"}});expect(outside.statusCode).toBe(409);const past=await app.inject({method:"POST",url:"/agendamentos",headers:apiHeaders,payload:{lead_id:leadA,unidade_id:"unidade-teste",start:"2024-01-08T09:00:00.000Z"}});expect(past.statusCode).toBe(409);expect(past.json().error).toMatch(/futuro/);await pool.query("INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days) VALUES($1,'unidade-teste','Outra unidade','09:00','12:00',ARRAY[1]::smallint[])",[otherTenantId]);await expect(pool.query("INSERT INTO scheduling_appointments(lead_id,tenant_id,unit_id,start_at,end_at) VALUES($1,$2,'unidade-teste','2030-01-07T09:00:00Z','2030-01-07T10:00:00Z')",[leadA,otherTenantId])).rejects.toMatchObject({code:"23503"})});
  it("rejects past appointment creation and rescheduling in both the panel and API",async()=>{
    const createLead=async(name:string)=>{
      const response=await app.inject({method:"POST",url:"/leads",headers:apiHeaders,payload:{telefone:testPhone(),nome:name,categoria_interesse_id:"categoria-teste",unidade_id:"unidade-teste",origem:"painel"}});
      expect(response.statusCode).toBe(201);
      return response.json().lead.id as string;
    };
    const [pastLead,rescheduleLead]=await Promise.all([createLead("Histórico manual"),createLead("Reagendamento histórico")]);
    const createdPast=await app.inject({
      method:"POST",url:"/scheduling/appointments",headers:{cookie},
      payload:{lead_id:pastLead,unidade_id:"unidade-teste",start:"2024-01-08T09:00:00.000Z",end:"2024-01-08T10:00:00.000Z"}
    });
    expect(createdPast.statusCode).toBe(409);
    expect(createdPast.json().error).toMatch(/futuro/);

    const future=await app.inject({
      method:"POST",url:"/agendamentos",headers:apiHeaders,
      payload:{lead_id:rescheduleLead,unidade_id:"unidade-teste",start:"2030-01-21T10:00:00.000Z"}
    });
    expect(future.statusCode).toBe(201);
    const movedPast=await app.inject({
      method:"PATCH",url:`/scheduling/appointments/${future.json().agendamento.id}/reagendar`,headers:{cookie},
      payload:{start:"2024-01-08T10:00:00.000Z",end:"2024-01-08T11:00:00.000Z"}
    });
    expect(movedPast.statusCode).toBe(409);
    expect(movedPast.json().error).toMatch(/futuro/);
  });
  it("prevents concurrent active appointments for the same lead",async()=>{const payload=(start:string)=>({lead_id:leadA,unidade_id:"unidade-teste",start});const [first,second]=await Promise.all([app.inject({method:"POST",url:"/agendamentos",headers:apiHeaders,payload:payload("2030-01-08T09:00:00.000Z")}),app.inject({method:"POST",url:"/agendamentos",headers:apiHeaders,payload:payload("2030-01-08T10:00:00.000Z")})]);expect([first.statusCode,second.statusCode].sort()).toEqual([201,409]);const rejected=first.statusCode===409?first:second;expect(rejected.json().error).toMatch(/agendamento ativo/);const created=first.statusCode===201?first:second;await app.inject({method:"DELETE",url:`/agendamentos/${created.json().agendamento.id}`,headers:apiHeaders})});
  it("rejects reuse of an appointment idempotency key with different input",async()=>{
    const createLead=async(index:number)=>(await app.inject({
      method:"POST",url:"/leads",headers:apiHeaders,
      payload:{telefone:testPhone(),nome:`Idempotência ${index}`,origem:"teste"}
    })).json().lead.id as string;
    const [firstLead,secondLead]=await Promise.all([createLead(1),createLead(2)]);
    const idempotencyKey=`review-${randomUUID()}`;
    const first=await app.inject({
      method:"POST",url:"/agendamentos",headers:apiHeaders,
      payload:{lead_id:firstLead,unidade_id:"unidade-teste",start:"2030-01-08T11:00:00.000Z",idempotency_key:idempotencyKey}
    });
    expect(first.statusCode).toBe(201);
    const replay=await app.inject({
      method:"POST",url:"/agendamentos",headers:apiHeaders,
      payload:{lead_id:firstLead,unidade_id:"unidade-teste",start:"2030-01-08T11:00:00.000Z",idempotency_key:idempotencyKey}
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().agendamento.id).toBe(first.json().agendamento.id);
    const mismatch=await app.inject({
      method:"POST",url:"/agendamentos",headers:apiHeaders,
      payload:{lead_id:secondLead,unidade_id:"unidade-teste",start:"2030-01-08T10:00:00.000Z",idempotency_key:idempotencyKey}
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error).toMatch(/idempotência/);
    await app.inject({method:"DELETE",url:`/agendamentos/${first.json().agendamento.id}`,headers:apiHeaders});
  });
  it("serializes concurrent bookings, updates the lead and keeps final status in agenda history",async()=>{const payloadA={lead_id:leadA,unidade_id:"unidade-teste",start:"2030-01-07T09:00:00.000Z"};const payloadB={lead_id:leadB,unidade_id:"unidade-teste",start:"2030-01-07T09:00:00.000Z"};const [a,b]=await Promise.all([app.inject({method:"POST",url:"/agendamentos",headers:apiHeaders,payload:payloadA}),app.inject({method:"POST",url:"/agendamentos",headers:apiHeaders,payload:payloadB})]);expect([a.statusCode,b.statusCode].sort()).toEqual([201,409]);const booked=a.statusCode===201?a:b;const appointmentId=booked.json().agendamento.id;const lead=await pool.query("SELECT status FROM scheduling_leads WHERE id=$1",[booked.json().agendamento.lead_id]);expect(lead.rows[0].status).toBe("agendado");const pastMove=await app.inject({method:"PATCH",url:`/agendamentos/${appointmentId}/reagendar`,headers:apiHeaders,payload:{start:"2024-01-08T09:00:00.000Z"}});expect(pastMove.statusCode).toBe(409);expect(pastMove.json().error).toMatch(/futuro/);const moved=await app.inject({method:"PATCH",url:`/agendamentos/${appointmentId}/reagendar`,headers:apiHeaders,payload:{start:"2030-01-07T10:00:00.000Z"}});expect(moved.statusCode).toBe(200);expect(moved.json().agendamento.status).toBe("reagendado");const nowFree=await app.inject({method:"POST",url:"/agendamentos",headers:apiHeaders,payload:booked.json().agendamento.lead_id===leadA?payloadB:payloadA});expect(nowFree.statusCode).toBe(201);const cancelled=await app.inject({method:"DELETE",url:`/agendamentos/${appointmentId}`,headers:apiHeaders});expect(cancelled.statusCode).toBe(200);expect(cancelled.json().agendamento.status).toBe("cancelado");const panelAgenda=await app.inject({url:"/scheduling/appointments?unidade_id=unidade-teste&inicio=2030-01-07T00%3A00%3A00.000Z&fim=2030-01-08T00%3A00%3A00.000Z",headers:{cookie}});expect(panelAgenda.json().agendamentos.find((x:{id:string})=>x.id===appointmentId)).toMatchObject({id:appointmentId,status:"cancelado"})});
  it("opens an outbound-ready WhatsApp conversation for a contact created from Agenda",async()=>{
    const session=await pool.query<{id:string}>("INSERT INTO whatsapp_sessions(tenant_id,status,last_connected_at) VALUES($1,'connected',now()) RETURNING id",[tenantId]);
    const lead=await pool.query<{id:string}>("INSERT INTO scheduling_leads(tenant_id,phone,name,source) VALUES($1,$2,'Contato da agenda','agenda_manual') RETURNING id",[tenantId,testPhone()]);
    const appointment=await pool.query<{id:string}>("INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at) VALUES($1,$2,'unidade-teste','2031-01-06T09:00:00Z','2031-01-06T10:00:00Z') RETURNING id",[tenantId,lead.rows[0].id]);
    const first=await app.inject({method:"POST",url:`/scheduling/appointments/${appointment.rows[0].id}/conversation`,headers:{cookie}});
    expect(first.statusCode).toBe(201);
    const conversationId=first.json().conversation.id as string;
    expect((await pool.query("SELECT session_id,ai_active,handoff_reason,status FROM conversations WHERE id=$1",[conversationId])).rows[0]).toMatchObject({session_id:session.rows[0].id,ai_active:false,handoff_reason:"manually_paused",status:"open"});
    const replay=await app.inject({method:"POST",url:`/scheduling/appointments/${appointment.rows[0].id}/conversation`,headers:{cookie}});
    expect(replay.statusCode).toBe(200);
    expect(replay.json().conversation.id).toBe(conversationId);
  });
  it("records status history and transfer notification without crossing tenants",async()=>{const status=await app.inject({method:"PATCH",url:`/leads/${leadA}/status`,headers:apiHeaders,payload:{status:"qualificado"}});expect(status.statusCode).toBe(200);const transfer=await app.inject({method:"POST",url:`/leads/${leadA}/transferir`,headers:apiHeaders,payload:{motivo:"Atendimento solicitado"}});expect(transfer.statusCode).toBe(200);const detail=await app.inject({url:`/scheduling/leads/${leadA}`,headers:{cookie}});expect(detail.statusCode).toBe(200);expect(detail.json().eventos.map((x:{event_type:string})=>x.event_type)).toContain("transferencia");const notifications=await pool.query("SELECT reason,status FROM scheduling_transfer_notifications WHERE lead_id=$1",[leadA]);expect(notifications.rows[0]).toMatchObject({reason:"Atendimento solicitado",status:"pending"});expect((await app.inject({url:`/scheduling/leads/${leadA}`})).statusCode).toBe(401)});
  it("lists and filters contextual qualification and the human-decision queue",async()=>{
    await pool.query(
      `UPDATE scheduling_leads SET qualification_stars=2,qualification_answers=$2,qualification_summary='Resumo 2 estrelas',
         qualification_reason='Justificativa interna',qualification_evaluated_at=now(),requires_human_decision=true,
         facebook_attribution=$3 WHERE id=$1`,
      [leadA,{nicho:"ótica",faturamento:"não informou"},{provider:"meta",channel:"facebook",source_id:"ad-panel",headline:"Campanha Newave"}]
    );
    await pool.query(
      `UPDATE scheduling_leads SET qualification_stars=3,qualification_answers=$2,qualification_summary='Resumo 3 estrelas',
         qualification_reason='Pode avançar',qualification_evaluated_at=now(),requires_human_decision=false WHERE id=$1`,
      [leadB,{nicho:"eletrônicos",faturamento:"R$ 40 mil"}]
    );
    const humanQueue=await app.inject({url:"/scheduling/leads?estrelas=2&fila_humana=true",headers:{cookie}});
    expect(humanQueue.statusCode).toBe(200);
    expect(humanQueue.json().leads.map((lead:{id:string})=>lead.id)).toContain(leadA);
    expect(humanQueue.json().leads.map((lead:{id:string})=>lead.id)).not.toContain(leadB);
    expect(humanQueue.json().leads.find((lead:{id:string})=>lead.id===leadA).qualificacao).toMatchObject({
      estrelas:2,resumo:"Resumo 2 estrelas",requer_decisao_humana:true,origem_facebook:{source_id:"ad-panel"}
    });
    const viable=await app.inject({url:"/scheduling/leads?estrelas=3",headers:{cookie}});
    expect(viable.json().leads.map((lead:{id:string})=>lead.id)).toContain(leadB);
    const detail=await app.inject({url:`/scheduling/leads/${leadA}`,headers:{cookie}});
    expect(detail.json().qualificacao).toMatchObject({
      estrelas:2,respostas:{nicho:"ótica",faturamento:"não informou"},resumo:"Resumo 2 estrelas",
      justificativa:"Justificativa interna",requer_decisao_humana:true,origem_facebook:{headline:"Campanha Newave"}
    });
  });
  it("hides another tenant resources from a valid foreign API key",async()=>{const response=await app.inject({method:"PATCH",url:`/leads/${leadA}/status`,headers:{"x-api-key":otherApiKey},payload:{status:"em_atendimento"}});expect(response.statusCode).toBe(404)});
  it("updates lead status from the panel with permission, transition validation and history",async()=>{
    const created=await app.inject({method:"POST",url:"/leads",headers:apiHeaders,payload:{telefone:testPhone(),nome:"Lead de status",categoria_interesse_id:"categoria-teste",unidade_id:"unidade-teste",origem:"painel"}});
    const leadId=created.json().lead.id;

    expect((await app.inject({method:"PATCH",url:`/scheduling/leads/${leadId}/status`,payload:{status:"em_atendimento"}})).statusCode).toBe(401);

    const readOnlyEmail=`status-readonly-${randomUUID()}@test.local`;
    const readOnlyPassword="status-readonly-password";
    const passwordHash=await hash(readOnlyPassword,4);
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      const role=await client.query<{id:string}>("INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,$2,'Leitura de leads') RETURNING id",[tenantId,`STATUS READONLY ${randomUUID()}`]);
      await client.query("INSERT INTO workspace_role_permissions(role_id,permission_key) VALUES($1,'leads.read')",[role.rows[0].id]);
      const user=await client.query<{id:string}>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",[readOnlyEmail,passwordHash]);
      await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())",[tenantId,user.rows[0].id,role.rows[0].id]);
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}

    try{
      const login=await app.inject({method:"POST",url:"/auth/login",payload:{email:readOnlyEmail,password:readOnlyPassword}});
      const readOnlyCookie=(Array.isArray(login.headers["set-cookie"])?login.headers["set-cookie"][0]:login.headers["set-cookie"]!).split(";")[0];
      const forbidden=await app.inject({method:"PATCH",url:`/scheduling/leads/${leadId}/status`,headers:{cookie:readOnlyCookie},payload:{status:"em_atendimento"}});
      expect(forbidden.statusCode).toBe(403);

      const updated=await app.inject({method:"PATCH",url:`/scheduling/leads/${leadId}/status`,headers:{cookie},payload:{status:"em_atendimento"}});
      expect(updated.statusCode).toBe(200);
      expect(updated.json().lead.status).toBe("em_atendimento");
      expect(updated.json().status_permitidos).toEqual(["aguardando_resposta","qualificado"]);

      const invalid=await app.inject({method:"PATCH",url:`/scheduling/leads/${leadId}/status`,headers:{cookie},payload:{status:"agendado"}});
      expect(invalid.statusCode).toBe(409);

      const idempotent=await app.inject({method:"PATCH",url:`/scheduling/leads/${leadId}/status`,headers:{cookie},payload:{status:"em_atendimento"}});
      expect(idempotent.statusCode).toBe(200);
      const history=await pool.query("SELECT previous_status,new_status FROM scheduling_lead_events WHERE lead_id=$1 AND event_type='status_atualizado' ORDER BY created_at",[leadId]);
      expect(history.rows).toEqual([{previous_status:"novo",new_status:"em_atendimento"}]);
    }finally{
      await pool.query("DELETE FROM users WHERE email=$1",[readOnlyEmail]);
    }
  });
  it("manages internal lead follow-up with explicit RBAC, eligible assignees and tenant isolation",async()=>{
    const phone=testPhone();
    const created=await app.inject({method:"POST",url:"/leads",headers:apiHeaders,payload:{telefone:phone,nome:"Lead com acompanhamento",categoria_interesse_id:"categoria-teste",unidade_id:"unidade-teste",origem:"painel"}});
    expect(created.statusCode).toBe(201);
    const leadId=created.json().lead.id as string;
    await pool.query("UPDATE tenants SET timezone='UTC' WHERE id=$1",[tenantId]);

    const readEmail=`follow-read-${randomUUID()}@test.local`;
    const leadOnlyEmail=`follow-lead-only-${randomUUID()}@test.local`;
    const suspendedEmail=`follow-suspended-${randomUUID()}@test.local`;
    const foreignEmail=`follow-foreign-${randomUUID()}@test.local`;
    const password="follow-up-password";
    let ownerMemberId="";
    let suspendedMemberId="";
    let foreignMemberId="";
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      await ensureWorkspaceDefaultRoles(client,otherTenantId);
      ownerMemberId=(await client.query<{id:string}>("SELECT m.id FROM workspace_members m JOIN workspace_roles r ON r.id=m.role_id WHERE m.workspace_id=$1 AND r.name='OWNER'",[tenantId])).rows[0].id;
      await client.query(
        "INSERT INTO scheduling_google_meet_closers(tenant_id,member_id) VALUES($1,$2) ON CONFLICT(tenant_id,member_id) DO NOTHING",
        [tenantId,ownerMemberId]
      );
      const readRole=await client.query<{id:string}>("INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,$2,'Leitura de acompanhamento') RETURNING id",[tenantId,`FOLLOW READ ${randomUUID()}`]);
      await client.query("INSERT INTO workspace_role_permissions(role_id,permission_key) VALUES($1,'leads.read'),($1,'leads.follow_up.read')",[readRole.rows[0].id]);
      const leadOnlyRole=await client.query<{id:string}>("INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,$2,'Leitura comum de leads') RETURNING id",[tenantId,`FOLLOW LEAD ONLY ${randomUUID()}`]);
      await client.query("INSERT INTO workspace_role_permissions(role_id,permission_key) VALUES($1,'leads.read')",[leadOnlyRole.rows[0].id]);
      const passwordHash=await hash(password,4);
      const readUser=await client.query<{id:string}>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",[readEmail,passwordHash]);
      const leadOnlyUser=await client.query<{id:string}>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",[leadOnlyEmail,passwordHash]);
      const suspendedUser=await client.query<{id:string}>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",[suspendedEmail,passwordHash]);
      await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now()),($1,$4,$5,'active',now())",[tenantId,readUser.rows[0].id,readRole.rows[0].id,leadOnlyUser.rows[0].id,leadOnlyRole.rows[0].id]);
      suspendedMemberId=(await client.query<{id:string}>("INSERT INTO workspace_members(workspace_id,user_id,role_id,status) VALUES($1,$2,$3,'suspended') RETURNING id",[tenantId,suspendedUser.rows[0].id,leadOnlyRole.rows[0].id])).rows[0].id;
      const foreignUser=await client.query<{id:string}>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",[foreignEmail,passwordHash]);
      foreignMemberId=(await client.query<{id:string}>("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR' RETURNING id",[otherTenantId,foreignUser.rows[0].id])).rows[0].id;
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}

    try{
      const readLogin=await app.inject({method:"POST",url:"/auth/login",payload:{email:readEmail,password}});
      const readCookie=(Array.isArray(readLogin.headers["set-cookie"])?readLogin.headers["set-cookie"][0]:readLogin.headers["set-cookie"]!).split(";")[0];
      const leadOnlyLogin=await app.inject({method:"POST",url:"/auth/login",payload:{email:leadOnlyEmail,password}});
      const leadOnlyCookie=(Array.isArray(leadOnlyLogin.headers["set-cookie"])?leadOnlyLogin.headers["set-cookie"][0]:leadOnlyLogin.headers["set-cookie"]!).split(";")[0];

      expect((await app.inject({url:`/scheduling/leads/${leadId}/follow-up`,headers:{cookie:leadOnlyCookie}})).statusCode).toBe(403);
      expect((await app.inject({url:`/scheduling/leads/${leadId}/follow-up`,headers:{cookie:readCookie}})).statusCode).toBe(404);
      expect((await app.inject({method:"PATCH",url:`/scheduling/leads/${leadId}/follow-up`,headers:{cookie:readCookie},payload:{responsavel_member_id:ownerMemberId}})).statusCode).toBe(403);
      expect((await app.inject({method:"POST",url:`/scheduling/leads/${leadId}/notes`,headers:{cookie:readCookie},payload:{nota:"Sem permissão"}})).statusCode).toBe(403);

      expect((await app.inject({method:"PATCH",url:`/scheduling/leads/${leadId}/follow-up`,headers:{cookie},payload:{proxima_acao:"Sem data"}})).statusCode).toBe(400);
      expect((await app.inject({method:"PATCH",url:`/scheduling/leads/${leadId}/follow-up`,headers:{cookie},payload:{proxima_acao:"Ação vencida",proxima_acao_em_local:"2020-01-01T10:00"}})).statusCode).toBe(400);
      expect((await app.inject({method:"PATCH",url:`/scheduling/leads/${leadId}/follow-up`,headers:{cookie},payload:{responsavel_member_id:foreignMemberId}})).statusCode).toBe(400);
      expect((await app.inject({method:"PATCH",url:`/scheduling/leads/${leadId}/follow-up`,headers:{cookie},payload:{responsavel_member_id:suspendedMemberId}})).statusCode).toBe(400);
      expect((await app.inject({method:"POST",url:`/scheduling/leads/${leadId}/notes`,headers:{cookie},payload:{nota:"   "}})).statusCode).toBe(400);

      const followUpPayload={responsavel_member_id:ownerMemberId,proxima_acao:"Retornar com a proposta",proxima_acao_em_local:"2035-02-01T10:30"};
      const updated=await app.inject({method:"PATCH",url:`/scheduling/leads/${leadId}/follow-up`,headers:{cookie},payload:followUpPayload});
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({alterado:true,follow_up:{proxima_acao:"Retornar com a proposta",proxima_acao_em:"2035-02-01T10:30:00.000Z",timezone:"UTC"}});
      const idempotent=await app.inject({method:"PATCH",url:`/scheduling/leads/${leadId}/follow-up`,headers:{cookie},payload:followUpPayload});
      expect(idempotent.json().alterado).toBe(false);

      const secretNote="Nota super secreta: condição comercial interna";
      const added=await app.inject({method:"POST",url:`/scheduling/leads/${leadId}/notes`,headers:{cookie},payload:{nota:secretNote}});
      expect(added.statusCode).toBe(201);
      expect(added.json().nota.nota).toBe(secretNote);
      expect((await app.inject({url:`/scheduling/leads/${leadId}/follow-up`,headers:{cookie:readCookie}})).statusCode).toBe(404);
      const followUp=await app.inject({url:`/scheduling/leads/${leadId}/follow-up`,headers:{cookie}});
      expect(followUp.json().notas[0].nota).toBe(secretNote);
      expect(followUp.json().responsaveis.map((item:{member_id:string})=>item.member_id)).toContain(ownerMemberId);
      expect(followUp.json().responsaveis.map((item:{member_id:string})=>item.member_id)).not.toContain(suspendedMemberId);

      const ownerDetail=await app.inject({url:`/scheduling/leads/${leadId}`,headers:{cookie}});
      expect(ownerDetail.json().lead).toMatchObject({responsavel_member_id:ownerMemberId,proxima_acao:"Retornar com a proposta"});
      expect(ownerDetail.json().eventos.map((item:{event_type:string})=>item.event_type)).toEqual(expect.arrayContaining(["acompanhamento_atualizado","nota_interna_adicionada"]));
      expect(JSON.stringify(ownerDetail.json().eventos)).not.toContain(secretNote);

      const restrictedDetail=await app.inject({url:`/scheduling/leads/${leadId}`,headers:{cookie:leadOnlyCookie}});
      expect(restrictedDetail.statusCode).toBe(404);
      expect(JSON.stringify(restrictedDetail.json())).not.toContain(secretNote);
      const restrictedList=await app.inject({url:`/scheduling/leads?busca=${phone}`,headers:{cookie:leadOnlyCookie}});
      expect(restrictedList.statusCode).toBe(200);
      expect(restrictedList.json().leads).toEqual([]);

      const publicUpdate=await app.inject({method:"POST",url:"/leads",headers:apiHeaders,payload:{telefone:phone,nome:"Lead atualizado externamente"}});
      expect(publicUpdate.statusCode).toBe(200);
      expect(JSON.stringify(publicUpdate.json())).not.toContain(secretNote);
      expect(publicUpdate.json().lead).not.toHaveProperty("proxima_acao");

      await pool.query("INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'categoria-follow-up','Categoria follow-up') ON CONFLICT DO NOTHING",[otherTenantId]);
      await pool.query("INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days) VALUES($1,'unidade-follow-up','Unidade follow-up','09:00','12:00',ARRAY[1,2,3,4,5]::smallint[]) ON CONFLICT DO NOTHING",[otherTenantId]);
      const foreignLead=await app.inject({method:"POST",url:"/leads",headers:{"x-api-key":otherApiKey},payload:{telefone:testPhone("98"),nome:"Lead de outro tenant",categoria_interesse_id:"categoria-follow-up",unidade_id:"unidade-follow-up",origem:"teste"}});
      expect((await app.inject({url:`/scheduling/leads/${foreignLead.json().lead.id}/follow-up`,headers:{cookie}})).statusCode).toBe(404);

      const cleared=await app.inject({method:"PATCH",url:`/scheduling/leads/${leadId}/follow-up`,headers:{cookie},payload:{responsavel_member_id:null,proxima_acao:null,proxima_acao_em_local:null}});
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).toMatchObject({alterado:true,follow_up:{responsavel:null,proxima_acao:null,proxima_acao_em:null}});

      const events=await pool.query("SELECT event_type,details FROM scheduling_lead_events WHERE lead_id=$1 AND event_type IN ('acompanhamento_atualizado','nota_interna_adicionada') ORDER BY created_at",[leadId]);
      expect(events.rows).toHaveLength(3);
      expect(JSON.stringify(events.rows)).not.toContain(secretNote);
      const audits=await pool.query("SELECT action,metadata FROM audit_logs WHERE workspace_id=$1 AND resource_id=$2 AND action LIKE 'leads.follow_up.%' ORDER BY created_at",[tenantId,leadId]);
      expect(audits.rows.map((item)=>item.action)).toEqual(["leads.follow_up.update","leads.follow_up.note.create","leads.follow_up.update"]);
      expect(JSON.stringify(audits.rows)).not.toContain(secretNote);
    }finally{
      await pool.query("DELETE FROM users WHERE email=ANY($1::text[])",[[readEmail,leadOnlyEmail,suspendedEmail,foreignEmail]]);
    }
  });
  it("rejects a manual closer conflict while AI availability still respects capacity",async()=>{
    const phone=testPhone();
    const createdLead=await app.inject({
      method:"POST",
      url:"/scheduling/leads",
      headers:{cookie},
      payload:{
        telefone:phone,
        nome:"Lead criado na agenda",
        categoria_interesse_id:"categoria-teste",
        unidade_id:"unidade-teste",
        origem:"agenda_manual"
      }
    });
    expect(createdLead.statusCode).toBe(201);
    const leadId=createdLead.json().lead.id as string;
    const listed=await app.inject({url:`/scheduling/leads?busca=${phone}`,headers:{cookie}});
    expect(listed.json().leads).toEqual(expect.arrayContaining([
      expect.objectContaining({id:leadId,telefone:phone,nome:"Lead criado na agenda"})
    ]));

    const outsideGrid=await app.inject({
      method:"POST",
      url:"/scheduling/appointments",
      headers:{cookie},
      payload:{
        lead_id:leadId,
        unidade_id:"unidade-teste",
        start:"2030-01-20T06:15:00.000Z",
        end:"2030-01-20T07:45:00.000Z"
      }
    });
    expect(outsideGrid.statusCode).toBe(201);
    expect(outsideGrid.json().agendamento).toMatchObject({
      start:"2030-01-20T06:15:00.000Z",
      end:"2030-01-20T07:45:00.000Z",
      duration_min:90
    });

    const conflictLead=await app.inject({
      method:"POST",
      url:"/scheduling/leads",
      headers:{cookie},
      payload:{telefone:testPhone(),nome:"Conflito da IA",origem:"agenda_manual"}
    });
    const manual=await app.inject({
      method:"POST",
      url:"/scheduling/appointments",
      headers:{cookie},
      payload:{
        lead_id:conflictLead.json().lead.id,
        unidade_id:"unidade-teste",
        start:"2030-01-10T09:15:00.000Z",
        end:"2030-01-10T10:45:00.000Z"
      }
    });
    expect(manual.statusCode).toBe(201);

    const sharedLead=await app.inject({
      method:"POST",
      url:"/scheduling/leads",
      headers:{cookie},
      payload:{telefone:testPhone(),nome:"Mesmo horário manual",origem:"agenda_manual"}
    });
    const sharedManual=await app.inject({
      method:"POST",
      url:"/scheduling/appointments",
      headers:{cookie},
      payload:{
        lead_id:sharedLead.json().lead.id,
        unidade_id:"unidade-teste",
        start:"2030-01-10T09:15:00.000Z",
        end:"2030-01-10T10:45:00.000Z"
      }
    });
    expect(sharedManual.statusCode).toBe(409);

    const availability=await app.inject({
      url:"/unidades/unidade-teste/horarios?data=2030-01-10",
      headers:apiHeaders
    });
    expect(availability.statusCode).toBe(200);
    expect(availability.json().horarios.map((slot:{start:string})=>slot.start)).toEqual([
      "2030-01-10T11:00:00.000Z"
    ]);

    const aiLead=await app.inject({
      method:"POST",
      url:"/leads",
      headers:apiHeaders,
      payload:{telefone:testPhone(),nome:"Tentativa sobreposta",origem:"ia"}
    });
    const overlapping=await app.inject({
      method:"POST",
      url:"/agendamentos",
      headers:apiHeaders,
      payload:{
        lead_id:aiLead.json().lead.id,
        unidade_id:"unidade-teste",
        start:"2030-01-10T10:00:00.000Z"
      }
    });
    expect(overlapping.statusCode).toBe(409);
    expect(overlapping.json().error).toMatch(/capacidade/);
  });
  it("persists appointment observations with explicit RBAC and without copying their text to audit metadata",async()=>{
    const lead=await app.inject({
      method:"POST",
      url:"/scheduling/leads",
      headers:{cookie},
      payload:{telefone:testPhone(),nome:"Lead com observação",origem:"agenda_manual"}
    });
    const appointment=await app.inject({
      method:"POST",
      url:"/scheduling/appointments",
      headers:{cookie},
      payload:{
        lead_id:lead.json().lead.id,
        unidade_id:"unidade-teste",
        start:"2030-01-11T13:15:00.000Z",
        end:"2030-01-11T13:45:00.000Z"
      }
    });
    expect(appointment.statusCode).toBe(201);
    const appointmentId=appointment.json().agendamento.id as string;
    const initialUpdatedAt=appointment.json().agendamento.atualizado_em as string;
    const secretObservation="Cliente pediu proposta especial antes da reunião";
    const persisted=await app.inject({
      method:"PATCH",
      url:`/scheduling/appointments/${appointmentId}/observation`,
      headers:{cookie},
      payload:{observacao:secretObservation,expected_updated_at:initialUpdatedAt}
    });
    expect(persisted.statusCode).toBe(200);
    expect(persisted.json()).toMatchObject({
      alterado:true,
      agendamento:{id:appointmentId,observacao:secretObservation}
    });
    const idempotent=await app.inject({
      method:"PATCH",
      url:`/scheduling/appointments/${appointmentId}/observation`,
      headers:{cookie},
      payload:{
        observacao:secretObservation,
        expected_updated_at:persisted.json().agendamento.atualizado_em
      }
    });
    expect(idempotent.json().alterado).toBe(false);
    const stale=await app.inject({
      method:"PATCH",
      url:`/scheduling/appointments/${appointmentId}/observation`,
      headers:{cookie},
      payload:{observacao:"Sobrescrita atrasada",expected_updated_at:initialUpdatedAt}
    });
    expect(stale.statusCode).toBe(409);
    const agenda=await app.inject({
      url:"/scheduling/appointments?unidade_id=unidade-teste&inicio=2030-01-11&fim=2030-01-12",
      headers:{cookie}
    });
    expect(agenda.json().agendamentos.find((item:{id:string})=>item.id===appointmentId).observacao).toBe(secretObservation);

    const restrictedEmail=`agenda-observation-read-${randomUUID()}@test.local`;
    const restrictedPassword="agenda-observation-read";
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      const role=await client.query<{id:string}>(
        "INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,$2,'Agenda sem observações') RETURNING id",
        [tenantId,`AGENDA OBS READ ${randomUUID()}`]
      );
      await client.query(
        "INSERT INTO workspace_role_permissions(role_id,permission_key) VALUES($1,'appointments.read')",
        [role.rows[0].id]
      );
      const user=await client.query<{id:string}>(
        "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
        [restrictedEmail,await hash(restrictedPassword,4)]
      );
      await client.query(
        "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())",
        [tenantId,user.rows[0].id,role.rows[0].id]
      );
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
    try{
      const login=await app.inject({method:"POST",url:"/auth/login",payload:{email:restrictedEmail,password:restrictedPassword}});
      const restrictedCookie=(Array.isArray(login.headers["set-cookie"])?login.headers["set-cookie"][0]:login.headers["set-cookie"]!).split(";")[0];
      expect((await app.inject({
        method:"PATCH",
        url:`/scheduling/appointments/${appointmentId}/observation`,
        headers:{cookie:restrictedCookie},
        payload:{
          observacao:"Sem permissão",
          expected_updated_at:idempotent.json().agendamento.atualizado_em
        }
      })).statusCode).toBe(403);
    }finally{
      await pool.query("DELETE FROM users WHERE email=$1",[restrictedEmail]);
    }
    const evidence=await pool.query(
      `SELECT metadata::text evidence
       FROM audit_logs
       WHERE workspace_id=$1 AND resource_id=$2
         AND action='scheduling.appointment.observation.update'
       UNION ALL
       SELECT details::text evidence
       FROM scheduling_lead_events
       WHERE tenant_id=$1 AND lead_id=$3
         AND event_type='observacao_agendamento_atualizada'`,
      [tenantId,appointmentId,lead.json().lead.id]
    );
    expect(evidence.rows).toHaveLength(2);
    expect(JSON.stringify(evidence.rows)).not.toContain(secretObservation);
  });
  it("configures an attendant color and projects it on the complete agenda",async()=>{
    const ownerMember=await pool.query<{member_id:string}>(
      `SELECT member.id member_id
       FROM workspace_members member
       JOIN workspace_roles role ON role.id=member.role_id
       WHERE member.workspace_id=$1 AND role.name='OWNER'
       LIMIT 1`,
      [tenantId]
    );
    const memberId=ownerMember.rows[0].member_id;
    await pool.query(
      `INSERT INTO scheduling_google_meet_closers(tenant_id,member_id)
       VALUES($1,$2)
       ON CONFLICT(tenant_id,member_id) DO NOTHING`,
      [tenantId,memberId]
    );
    const changed=await app.inject({
      method:"PATCH",
      url:`/scheduling/attendants/${memberId}/calendar-color`,
      headers:{cookie},
      payload:{cor_agenda:"#a855f7"}
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      alterado:true,
      attendant:{member_id:memberId,cor_agenda:"#A855F7"}
    });
    const attendants=await app.inject({url:"/scheduling/config/attendants",headers:{cookie}});
    expect(attendants.json().attendants.find((item:{member_id:string})=>item.member_id===memberId).cor_agenda).toBe("#A855F7");

    const lead=await app.inject({
      method:"POST",
      url:"/scheduling/leads",
      headers:{cookie},
      payload:{telefone:testPhone(),nome:"Lead colorido",origem:"agenda_manual"}
    });
    const appointment=await app.inject({
      method:"POST",
      url:"/scheduling/appointments",
      headers:{cookie},
      payload:{
        lead_id:lead.json().lead.id,
        unidade_id:"unidade-teste",
        start:"2030-01-14T13:00:00.000Z",
        end:"2030-01-14T13:30:00.000Z"
      }
    });
    expect(appointment.statusCode).toBe(201);
    expect(appointment.json().agendamento.responsavel).toMatchObject({
      member_id:memberId,
      cor_agenda:"#A855F7"
    });
    const agenda=await app.inject({
      url:"/scheduling/appointments?unidade_id=unidade-teste&inicio=2030-01-14&fim=2030-01-15",
      headers:{cookie}
    });
    expect(agenda.json().agendamentos.find((item:{id:string})=>item.id===appointment.json().agendamento.id).responsavel.cor_agenda).toBe("#A855F7");
  });
  it("manages the panel appointment lifecycle with RBAC, tenant isolation and transactional events",async()=>{
    const createLead=async(index:number)=>{
      const response=await app.inject({method:"POST",url:"/leads",headers:apiHeaders,payload:{telefone:testPhone(),nome:`Agenda manual ${index}`,categoria_interesse_id:"categoria-teste",unidade_id:"unidade-teste",origem:"painel"}});
      expect(response.statusCode).toBe(201);
      return response.json().lead.id as string;
    };
    const leadIds=await Promise.all([1,2,3].map(createLead));
    const payload=(leadId:string,start:string)=>({lead_id:leadId,unidade_id:"unidade-teste",start});

    expect((await app.inject({method:"POST",url:"/scheduling/appointments",payload:payload(leadIds[0],"2030-01-15T09:00:00.000Z")})).statusCode).toBe(401);

    const readOnlyEmail=`agenda-readonly-${randomUUID()}@test.local`;
    const readOnlyPassword="agenda-readonly-password";
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      const role=await client.query<{id:string}>("INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,$2,'Somente leitura da agenda') RETURNING id",[tenantId,`AGENDA READONLY ${randomUUID()}`]);
      await client.query("INSERT INTO workspace_role_permissions(role_id,permission_key) VALUES($1,'appointments.read')",[role.rows[0].id]);
      const user=await client.query<{id:string}>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",[readOnlyEmail,await hash(readOnlyPassword,4)]);
      await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())",[tenantId,user.rows[0].id,role.rows[0].id]);
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}

    try{
      const login=await app.inject({method:"POST",url:"/auth/login",payload:{email:readOnlyEmail,password:readOnlyPassword}});
      const readOnlyCookie=(Array.isArray(login.headers["set-cookie"])?login.headers["set-cookie"][0]:login.headers["set-cookie"]!).split(";")[0];
      expect((await app.inject({url:"/scheduling/appointment-leads",headers:{cookie:readOnlyCookie}})).statusCode).toBe(403);
      expect((await app.inject({method:"POST",url:"/scheduling/appointments",headers:{cookie:readOnlyCookie},payload:payload(leadIds[0],"2030-01-15T09:00:00.000Z")})).statusCode).toBe(403);

      const candidates=await app.inject({url:"/scheduling/appointment-leads",headers:{cookie}});
      expect(candidates.statusCode).toBe(200);
      expect(candidates.json().leads.map((lead:{id:string})=>lead.id)).toEqual(expect.arrayContaining(leadIds));

      await pool.query("INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'categoria-isolada','Categoria isolada') ON CONFLICT DO NOTHING",[otherTenantId]);
      await pool.query("INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days) VALUES($1,'unidade-isolada','Unidade isolada','09:00','12:00',ARRAY[1,2,3,4,5]::smallint[]) ON CONFLICT DO NOTHING",[otherTenantId]);
      const foreignLead=await app.inject({method:"POST",url:"/leads",headers:{"x-api-key":otherApiKey},payload:{telefone:testPhone("99"),nome:"Lead externo",categoria_interesse_id:"categoria-isolada",unidade_id:"unidade-isolada",origem:"teste"}});
      expect(foreignLead.statusCode).toBe(201);
      const foreignAppointment=await app.inject({method:"POST",url:"/agendamentos",headers:{"x-api-key":otherApiKey},payload:{lead_id:foreignLead.json().lead.id,unidade_id:"unidade-isolada",start:"2030-01-15T09:00:00.000Z"}});
      expect(foreignAppointment.statusCode).toBe(201);
      expect(candidates.json().leads.map((lead:{id:string})=>lead.id)).not.toContain(foreignLead.json().lead.id);
      expect((await app.inject({method:"POST",url:"/scheduling/appointments",headers:{cookie},payload:payload(foreignLead.json().lead.id,"2030-01-15T09:00:00.000Z")})).statusCode).toBe(404);
      expect((await app.inject({method:"PATCH",url:`/scheduling/appointments/${foreignAppointment.json().agendamento.id}/concluir`,headers:{cookie}})).statusCode).toBe(404);

      const created=[] as Array<{id:string}>;
      for(const [index,start] of ["09:00","10:00","11:00"].entries()){
        const response=await app.inject({method:"POST",url:"/scheduling/appointments",headers:{cookie},payload:payload(leadIds[index],`2030-01-15T${start}:00.000Z`)});
        expect(response.statusCode).toBe(201);
        created.push(response.json().agendamento);
      }
      const reactionSession=await pool.query<{id:string}>("INSERT INTO whatsapp_sessions(tenant_id,status,last_connected_at) VALUES($1,'connected',now()) RETURNING id",[tenantId]);
      for(const [index,appointment] of created.entries()){
        await pool.query(
          `INSERT INTO scheduling_appointment_notifications(
             tenant_id,appointment_id,session_id,group_jid,message,status,external_message_id,sent_at
           ) VALUES($1,$2,$3,'120363000000000000@g.us','Novo agendamento','sent',$4,now())`,
          [tenantId,appointment.id,reactionSession.rows[0].id,`appointment-notification-${randomUUID()}-${index}`]
        );
      }
      expect((await app.inject({method:"DELETE",url:`/scheduling/appointments/${created[0].id}`,headers:{cookie:readOnlyCookie}})).statusCode).toBe(403);
      expect((await app.inject({method:"PATCH",url:`/scheduling/appointments/${created[1].id}/concluir`,headers:{cookie:readOnlyCookie}})).statusCode).toBe(403);
      expect((await app.inject({method:"PATCH",url:`/scheduling/appointments/${created[2].id}/no-show`,headers:{cookie:readOnlyCookie}})).statusCode).toBe(403);

      expect((await app.inject({method:"DELETE",url:`/scheduling/appointments/${created[0].id}`,headers:{cookie}})).json().agendamento.status).toBe("cancelado");
      expect((await app.inject({method:"DELETE",url:`/scheduling/appointments/${created[0].id}`,headers:{cookie}})).statusCode).toBe(409);
      expect((await app.inject({method:"PATCH",url:`/scheduling/appointments/${created[1].id}/concluir`,headers:{cookie},payload:{outcome:"fechado",sale_value:1500}})).json().agendamento.status).toBe("concluido");
      expect((await app.inject({method:"PATCH",url:`/scheduling/appointments/${created[1].id}/no-show`,headers:{cookie}})).json().agendamento.status).toBe("no_show");
      expect((await app.inject({method:"PATCH",url:`/scheduling/appointments/${created[2].id}/no-show`,headers:{cookie}})).json().agendamento.status).toBe("no_show");
      expect((await app.inject({method:"PATCH",url:`/scheduling/appointments/${created[2].id}/concluir`,headers:{cookie},payload:{outcome:"fechado",sale_value:900}})).json().agendamento.status).toBe("concluido");
      expect((await app.inject({method:"PATCH",url:`/scheduling/appointments/${created[2].id}/reagendar`,headers:{cookie},payload:{start:"2030-01-16T09:00:00.000Z"}})).statusCode).toBe(409);

      const correctedProjections=await pool.query<{
        appointment_id:string;appointment_status:string;appointment_outcome:string|null;appointment_sale_value:string|null;
        lead_status:string;recovery_required:boolean;lead_outcome:string|null;lead_sale_value:string|null;
      }>(
        `SELECT appointment.id appointment_id,appointment.status appointment_status,
                appointment.commercial_outcome appointment_outcome,appointment.sale_value appointment_sale_value,
                lead.status lead_status,lead.recovery_required,
                lead.commercial_outcome lead_outcome,lead.sale_value lead_sale_value
         FROM scheduling_appointments appointment
         JOIN scheduling_leads lead ON lead.tenant_id=appointment.tenant_id AND lead.id=appointment.lead_id
         WHERE appointment.tenant_id=$1 AND appointment.id=ANY($2::uuid[])`,
        [tenantId,[created[1].id,created[2].id]]
      );
      const correctedByAppointment=new Map(correctedProjections.rows.map((projection)=>[projection.appointment_id,projection]));
      expect(correctedByAppointment.get(created[1].id)).toMatchObject({
        appointment_status:"no_show",appointment_outcome:null,appointment_sale_value:null,
        lead_status:"follow_up",recovery_required:true,lead_outcome:null,lead_sale_value:null
      });
      expect(correctedByAppointment.get(created[2].id)).toMatchObject({
        appointment_status:"concluido",appointment_outcome:"fechado",appointment_sale_value:"900.00",
        lead_status:"fechado",recovery_required:false,lead_outcome:"fechado",lead_sale_value:"900.00"
      });

      const reactions=await pool.query<{appointment_id:string;reaction_emoji:string;reaction_status:string}>(
        "SELECT appointment_id,reaction_emoji,reaction_status FROM scheduling_appointment_notifications WHERE appointment_id=ANY($1::uuid[])",
        [created.map((appointment)=>appointment.id)]
      );
      const reactionByAppointment=new Map(reactions.rows.map((reaction)=>[reaction.appointment_id,reaction]));
      expect(reactionByAppointment.get(created[0].id)).toMatchObject({reaction_emoji:"❌",reaction_status:"pending"});
      expect(reactionByAppointment.get(created[1].id)).toMatchObject({reaction_emoji:"⚠️",reaction_status:"pending"});
      expect(reactionByAppointment.get(created[2].id)).toMatchObject({reaction_emoji:"✅",reaction_status:"pending"});

      const events=await pool.query<{event_type:string;details:{outcome?:string;disposition?:string;previous_appointment_status?:string} }>("SELECT event_type,details FROM scheduling_lead_events WHERE lead_id=ANY($1::uuid[]) AND event_type IN ('agendamento_cancelado','resultado_comercial_registrado','agendamento_no_show') ORDER BY event_type",[leadIds]);
      expect(events.rows.map((event)=>event.event_type)).toEqual(["agendamento_cancelado","agendamento_no_show","agendamento_no_show","resultado_comercial_registrado","resultado_comercial_registrado"]);
      expect(events.rows.map((event)=>event.details)).toEqual(expect.arrayContaining([
        expect.objectContaining({disposition:"recover"}),
        expect.objectContaining({previous_appointment_status:"concluido"}),
        expect.objectContaining({previous_appointment_status:"no_show",outcome:"fechado"})
      ]));
    }finally{
      await pool.query("DELETE FROM users WHERE email=$1",[readOnlyEmail]);
    }
  });
  it("requires explicit pipeline reactivation before scheduling a lost lead",async()=>{
    await ensureOwnerCloser();
    const lead=await app.inject({
      method:"POST",url:"/scheduling/leads",headers:{cookie},
      payload:{telefone:testPhone(),nome:"Lead terminal",origem:"agenda_manual"}
    });
    expect(lead.statusCode).toBe(201);
    const leadId=lead.json().lead.id as string;
    await pool.query(
      `UPDATE scheduling_leads
       SET status='perdido',commercial_outcome='nao_avancou',loss_reason='outro',commercial_updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId,leadId]
    );

    const response=await app.inject({
      method:"POST",url:"/scheduling/appointments",headers:{cookie},
      payload:{lead_id:leadId,unidade_id:"unidade-teste",start:"2030-02-03T09:00:00.000Z"}
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/Reative o lead/);
    const persisted=await pool.query(
      "SELECT status,commercial_outcome,loss_reason FROM scheduling_leads WHERE tenant_id=$1 AND id=$2",
      [tenantId,leadId]
    );
    expect(persisted.rows[0]).toMatchObject({
      status:"perdido",commercial_outcome:"nao_avancou",loss_reason:"outro"
    });
  });

  it("persists every structured commercial outcome and rejects incomplete result payloads",async()=>{
    await ensureOwnerCloser();
    const cases=[
      {
        label:"Proposta",
        start:"2030-02-04T09:00:00.000Z",
        payload:{outcome:"proposta_enviada",next_action:"Revisar proposta",next_action_at:"2035-02-04T09:00:00.000Z"},
        leadStatus:"proposta_enviada"
      },
      {
        label:"Negociação",
        start:"2030-02-05T09:00:00.000Z",
        payload:{outcome:"em_negociacao",next_action:"Negociar condições",next_action_at:"2035-02-05T09:00:00.000Z"},
        leadStatus:"em_negociacao"
      },
      {
        label:"Follow-up",
        start:"2030-02-06T09:00:00.000Z",
        payload:{outcome:"follow_up",next_action:"Retomar contato",next_action_at:"2035-02-06T09:00:00.000Z"},
        leadStatus:"follow_up"
      },
      {
        label:"Não avançou",
        start:"2030-02-07T09:00:00.000Z",
        payload:{outcome:"nao_avancou",loss_reason:"preco"},
        leadStatus:"perdido"
      }
    ] as const;
    const persisted:Array<{leadId:string;appointmentId:string;outcome:string}>=[];
    for(const [index,item] of cases.entries()){
      const lead=await app.inject({
        method:"POST",url:"/scheduling/leads",headers:{cookie},
        payload:{telefone:testPhone(),nome:`Resultado ${item.label}`,origem:"agenda_manual"}
      });
      expect(lead.statusCode).toBe(201);
      const appointment=await app.inject({
        method:"POST",url:"/scheduling/appointments",headers:{cookie},
        payload:{lead_id:lead.json().lead.id,unidade_id:"unidade-teste",start:item.start}
      });
      expect(appointment.statusCode).toBe(201);
      if(index===0){
        const invalid=await app.inject({
          method:"PATCH",url:`/scheduling/appointments/${appointment.json().agendamento.id}/concluir`,headers:{cookie},
          payload:{outcome:"proposta_enviada"}
        });
        expect(invalid.statusCode).toBe(400);
      }
      if(index===3){
        const invalid=await app.inject({
          method:"PATCH",url:`/scheduling/appointments/${appointment.json().agendamento.id}/concluir`,headers:{cookie},
          payload:{outcome:"nao_avancou"}
        });
        expect(invalid.statusCode).toBe(400);
      }
      const concluded=await app.inject({
        method:"PATCH",url:`/scheduling/appointments/${appointment.json().agendamento.id}/concluir`,headers:{cookie},
        payload:item.payload
      });
      expect(concluded.statusCode).toBe(200);
      expect(concluded.json().agendamento).toMatchObject({status:"concluido",commercial_outcome:item.payload.outcome});
      const stored=await pool.query<{
        appointment_outcome:string;appointment_loss_reason:string|null;appointment_next_action:string|null;
        lead_status:string;lead_outcome:string;lead_loss_reason:string|null;lead_next_action:string|null;
      }>(
        `SELECT appointment.commercial_outcome appointment_outcome,
                appointment.loss_reason appointment_loss_reason,
                appointment.outcome_next_action appointment_next_action,
                lead.status lead_status,lead.commercial_outcome lead_outcome,
                lead.loss_reason lead_loss_reason,lead.next_action lead_next_action
         FROM scheduling_appointments appointment
         JOIN scheduling_leads lead ON lead.tenant_id=appointment.tenant_id AND lead.id=appointment.lead_id
         WHERE appointment.tenant_id=$1 AND appointment.id=$2`,
        [tenantId,appointment.json().agendamento.id]
      );
      expect(stored.rows[0]).toMatchObject({
        appointment_outcome:item.payload.outcome,
        lead_status:item.leadStatus,
        lead_outcome:item.payload.outcome,
        appointment_loss_reason:item.payload.outcome==="nao_avancou" ? "preco" : null,
        lead_loss_reason:item.payload.outcome==="nao_avancou" ? "preco" : null,
        appointment_next_action:"next_action" in item.payload ? item.payload.next_action : null,
        lead_next_action:"next_action" in item.payload ? item.payload.next_action : null
      });
      persisted.push({leadId:lead.json().lead.id,appointmentId:appointment.json().agendamento.id,outcome:item.payload.outcome});
    }
    const proposalFilter=await app.inject({
      url:"/scheduling/leads?commercial_outcome=proposta_enviada&appointment_status=concluido",
      headers:{cookie}
    });
    expect(proposalFilter.statusCode).toBe(200);
    expect(proposalFilter.json().leads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id:persisted[0].leadId,
        commercial_outcome:"proposta_enviada",
        latest_appointment:expect.objectContaining({id:persisted[0].appointmentId,status:"concluido"})
      })
    ]));
  });
  it("assigns no-show recovery deterministically and clears recovery on a new handoff",async()=>{
    await ensureOwnerCloser();
    const lead=await app.inject({
      method:"POST",url:"/scheduling/leads",headers:{cookie},
      payload:{telefone:testPhone(),nome:"Recuperação determinística",origem:"agenda_manual"}
    });
    const first=await app.inject({
      method:"POST",url:"/scheduling/appointments",headers:{cookie},
      payload:{lead_id:lead.json().lead.id,unidade_id:"unidade-teste",start:"2030-04-01T09:00:00.000Z"}
    });
    expect(first.statusCode).toBe(201);
    await pool.query(
      `UPDATE scheduling_leads SET sdr_member_id=NULL,closer_member_id=NULL,assigned_member_id=NULL
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId,lead.json().lead.id]
    );
    await pool.query(
      "UPDATE scheduling_appointments SET assigned_member_id=NULL WHERE tenant_id=$1 AND id=$2",
      [tenantId,first.json().agendamento.id]
    );
    const noShow=await app.inject({
      method:"PATCH",url:`/scheduling/appointments/${first.json().agendamento.id}/no-show`,headers:{cookie},payload:{}
    });
    expect(noShow.statusCode).toBe(200);
    const recovering=await pool.query<{
      recovery_required:boolean;recovery_member_id:string|null;assigned_member_id:string|null;
      next_action:string|null;status:string;
    }>(
      `SELECT recovery_required,recovery_member_id,assigned_member_id,next_action,status
       FROM scheduling_leads WHERE tenant_id=$1 AND id=$2`,
      [tenantId,lead.json().lead.id]
    );
    expect(recovering.rows[0]).toMatchObject({
      recovery_required:true,
      assigned_member_id:recovering.rows[0].recovery_member_id,
      next_action:"Recuperar reunião",
      status:"follow_up"
    });
    expect(recovering.rows[0].recovery_member_id).toBeTruthy();

    const replacement=await app.inject({
      method:"POST",url:"/scheduling/appointments",headers:{cookie},
      payload:{lead_id:lead.json().lead.id,unidade_id:"unidade-teste",start:"2030-04-02T09:00:00.000Z"}
    });
    expect(replacement.statusCode).toBe(201);
    const handedOff=await pool.query<{
      recovery_required:boolean;recovery_member_id:string|null;sdr_member_id:string|null;closer_member_id:string|null;status:string;
    }>(
      `SELECT recovery_required,recovery_member_id,sdr_member_id,closer_member_id,status
       FROM scheduling_leads WHERE tenant_id=$1 AND id=$2`,
      [tenantId,lead.json().lead.id]
    );
    expect(handedOff.rows[0]).toMatchObject({
      recovery_required:false,
      recovery_member_id:null,
      sdr_member_id:recovering.rows[0].recovery_member_id,
      status:"agendado"
    });
    expect(handedOff.rows[0].closer_member_id).toBeTruthy();
  });
  it("clears pending and recovery projections when a meeting is rescheduled",async()=>{
    const memberId=await ensureOwnerCloser();
    const lead=await app.inject({
      method:"POST",url:"/scheduling/leads",headers:{cookie},
      payload:{telefone:testPhone(),nome:"Recuperação reagendada",origem:"agenda_manual"}
    });
    const created=await app.inject({
      method:"POST",url:"/scheduling/appointments",headers:{cookie},
      payload:{lead_id:lead.json().lead.id,unidade_id:"unidade-teste",start:"2030-04-03T09:00:00.000Z"}
    });
    expect(created.statusCode).toBe(201);
    await pool.query(
      `UPDATE scheduling_appointments SET result_pending_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId,created.json().agendamento.id]
    );
    await pool.query(
      `UPDATE scheduling_leads SET status='follow_up',recovery_required=true,recovery_member_id=$3,
         assigned_member_id=$3,next_action='Recuperar reunião',next_action_at='2035-04-03T09:00:00Z',
         commercial_outcome='follow_up',commercial_updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId,lead.json().lead.id,memberId]
    );
    const rescheduled=await app.inject({
      method:"PATCH",url:`/scheduling/appointments/${created.json().agendamento.id}/reagendar`,headers:{cookie},
      payload:{start:"2030-04-04T09:00:00.000Z"}
    });
    expect(rescheduled.statusCode).toBe(200);
    expect(rescheduled.json().agendamento).toMatchObject({status:"reagendado",result_pending_at:null});
    const projection=await pool.query<{
      status:string;recovery_required:boolean;recovery_member_id:string|null;commercial_outcome:string|null;
      next_action:string|null;next_action_at:Date|null;result_pending_at:Date|null;
    }>(
      `SELECT lead.status,lead.recovery_required,lead.recovery_member_id,lead.commercial_outcome,
              lead.next_action,lead.next_action_at,appointment.result_pending_at
       FROM scheduling_leads lead JOIN scheduling_appointments appointment
         ON appointment.tenant_id=lead.tenant_id AND appointment.lead_id=lead.id
       WHERE lead.tenant_id=$1 AND appointment.id=$2`,
      [tenantId,created.json().agendamento.id]
    );
    expect(projection.rows[0]).toEqual({
      status:"agendado",recovery_required:false,recovery_member_id:null,commercial_outcome:null,
      next_action:null,next_action_at:null,result_pending_at:null
    });
  });
  it("blocks Meet per closer until that closer resolves prior pending results",async()=>{
    const memberId=await ensureOwnerCloser();
    const createMeeting=async(label:string,start:string)=>{
      const lead=await app.inject({
        method:"POST",url:"/scheduling/leads",headers:{cookie},
        payload:{telefone:testPhone(),nome:label,origem:"agenda_manual"}
      });
      const appointment=await app.inject({
        method:"POST",url:"/scheduling/appointments",headers:{cookie},
        payload:{lead_id:lead.json().lead.id,unidade_id:"unidade-teste",start}
      });
      expect(appointment.statusCode).toBe(201);
      return {leadId:lead.json().lead.id as string,appointmentId:appointment.json().agendamento.id as string};
    };
    const prior=await createMeeting("Reunião anterior","2030-05-01T09:00:00.000Z");
    const current=await createMeeting("Reunião posterior","2030-05-02T09:00:00.000Z");
    const otherUser=await pool.query<{id:string}>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
      [`beto-${randomUUID()}@test.local`,await hash("beto-password",4)]
    );
    const otherMember=await pool.query<{id:string}>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles
       WHERE workspace_id=$1 AND name='OPERADOR' RETURNING id`,
      [tenantId,otherUser.rows[0].id]
    );
    await pool.query(
      "INSERT INTO scheduling_google_meet_closers(tenant_id,member_id,availability_status) VALUES($1,$2,'available')",
      [tenantId,otherMember.rows[0].id]
    );
    const otherCurrent=await createMeeting("Reunião do Beto","2030-05-03T09:00:00.000Z");
    await pool.query(
      `UPDATE scheduling_appointments SET assigned_member_id=$3,
         start_at=now()-interval '50 minutes',end_at=now()-interval '20 minutes',
         meeting_provider='google_meet',meeting_space_name='spaces/prior',meeting_code='prior-code',
         meeting_url='https://meet.google.com/prior-test',meeting_created_at=now(),meeting_provisioning_status='ready'
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId,prior.appointmentId,memberId]
    );
    await pool.query(
      `UPDATE scheduling_appointments SET assigned_member_id=$3,
         meeting_provider='google_meet',meeting_space_name='spaces/current',meeting_code='current-code',
         meeting_url='https://meet.google.com/current-test',meeting_created_at=now(),meeting_provisioning_status='ready'
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId,current.appointmentId,memberId]
    );
    await pool.query(
      `UPDATE scheduling_appointments SET assigned_member_id=$3,
         meeting_provider='google_meet',meeting_space_name='spaces/beto',meeting_code='beto-code',
         meeting_url='https://meet.google.com/beto-test',meeting_created_at=now(),meeting_provisioning_status='ready'
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId,otherCurrent.appointmentId,otherMember.rows[0].id]
    );
    const concurrentPasses=await Promise.all([
      reconcilePendingMeetingResults(500),
      reconcilePendingMeetingResults(500)
    ]);
    expect(concurrentPasses.reduce((total,result)=>total+result.marked,0)).toBeGreaterThanOrEqual(1);
    expect(concurrentPasses.reduce((total,result)=>total+result.failed,0)).toBe(0);
    const secondPass=await reconcilePendingMeetingResults(500);
    expect(secondPass.marked).toBe(0);
    const pending=await pool.query<{result_pending_at:Date|null}>(
      "SELECT result_pending_at FROM scheduling_appointments WHERE tenant_id=$1 AND id=$2",
      [tenantId,prior.appointmentId]
    );
    expect(pending.rows[0].result_pending_at).toBeInstanceOf(Date);
    expect((await pool.query<{count:number}>(
      `SELECT count(*)::int count FROM scheduling_lead_events
       WHERE tenant_id=$1 AND lead_id=$2 AND event_type='resultado_reuniao_pendente'`,
      [tenantId,prior.leadId]
    )).rows[0].count).toBe(1);
    expect((await pool.query<{count:number}>(
      `SELECT count(*)::int count FROM system_alerts
       WHERE tenant_id=$1 AND metadata->>'event'='appointment_result_pending'
         AND metadata->>'appointment_id'=$2`,
      [tenantId,prior.appointmentId]
    )).rows[0].count).toBe(1);
    const pendingFilter=await app.inject({url:"/scheduling/leads?action_bucket=result_pending",headers:{cookie}});
    expect(pendingFilter.statusCode).toBe(200);
    expect(pendingFilter.json().leads).toEqual(expect.arrayContaining([
      expect.objectContaining({id:prior.leadId,latest_appointment:expect.objectContaining({result_pending:true})})
    ]));

    const joinedDuringGrace=await app.inject({method:"POST",url:`/scheduling/appointments/${current.appointmentId}/join`,headers:{cookie}});
    expect(joinedDuringGrace.statusCode).toBe(200);
    expect(joinedDuringGrace.json()).toEqual({url:"https://meet.google.com/current-test"});
    await pool.query(
      `UPDATE scheduling_appointments
       SET start_at=now()-interval '61 minutes',end_at=now()-interval '31 minutes'
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId,prior.appointmentId]
    );

    const blocked=await app.inject({method:"POST",url:`/scheduling/appointments/${current.appointmentId}/join`,headers:{cookie}});
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatch(/resultado da reunião anterior/i);
    const otherJoined=await app.inject({method:"POST",url:`/scheduling/appointments/${otherCurrent.appointmentId}/join`,headers:{cookie}});
    expect(otherJoined.statusCode).toBe(200);
    expect(otherJoined.json()).toEqual({url:"https://meet.google.com/beto-test"});
    const resolved=await app.inject({
      method:"PATCH",url:`/scheduling/appointments/${prior.appointmentId}/concluir`,headers:{cookie},
      payload:{outcome:"nao_avancou",loss_reason:"sem_retorno"}
    });
    expect(resolved.statusCode).toBe(200);
    const joined=await app.inject({method:"POST",url:`/scheduling/appointments/${current.appointmentId}/join`,headers:{cookie}});
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toEqual({url:"https://meet.google.com/current-test"});
  });
  it("recovers when the group message changes after delivery has already read the old revision",async()=>{
    const leadId=(await pool.query<{id:string}>(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,unit_id,status,source)
       VALUES($1,$2,'Corrida do link','unidade-teste','agendado','teste') RETURNING id`,
      [tenantId,testPhone()]
    )).rows[0].id;
    const appointmentId=(await pool.query<{id:string}>(
      `INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at,status)
       VALUES($1,$2,'unidade-teste','2031-01-06T09:00:00.000Z','2031-01-06T10:00:00.000Z','confirmado')
       RETURNING id`,
      [tenantId,leadId]
    )).rows[0].id;
    const sessionId=(await pool.query<{id:string}>(
      "INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",
      [tenantId]
    )).rows[0].id;
    const repository=new SchedulingNotificationRepository(pool);
    const notificationId=await repository.create({
      tenantId,
      appointmentId,
      sessionId,
      groupJid:"120363000000000001@g.us",
      message:"Agendamento sem link"
    });
    const deliverySnapshot=await repository.getPending(notificationId!);
    expect(deliverySnapshot).toMatchObject({message:"Agendamento sem link",revision:0});

    await repository.scheduleMessageEdit(
      notificationId!,
      "Agendamento com link https://meet.google.com/race-safe"
    );
    await expect(repository.markSent(
      notificationId!,
      "stale-group-message-id",
      deliverySnapshot!.revision
    )).resolves.toBe(1);
    expect(await repository.getPendingEdit(notificationId!)).toMatchObject({
      message:"Agendamento com link https://meet.google.com/race-safe",
      revision:1
    });
  });
  it("preserves final-status reactions when notification creation races with completion",async()=>{
    const lead=await app.inject({
      method:"POST",
      url:"/leads",
      headers:apiHeaders,
      payload:{
        telefone:testPhone(),
        nome:"Agenda finalizada antes da notificação",
        categoria_interesse_id:"categoria-teste",
        unidade_id:"unidade-teste",
        origem:"teste"
      }
    });
    expect(lead.statusCode).toBe(201);
    const appointment=await app.inject({
      method:"POST",
      url:"/scheduling/appointments",
      headers:{cookie},
      payload:{lead_id:lead.json().lead.id,unidade_id:"unidade-teste",start:"2030-01-17T09:00:00.000Z"}
    });
    expect(appointment.statusCode).toBe(201);
    const appointmentId=appointment.json().agendamento.id as string;
    const completed=await app.inject({
      method:"PATCH",
      url:`/scheduling/appointments/${appointmentId}/concluir`,
      headers:{cookie},
      payload:{outcome:"fechado",sale_value:2500}
    });
    expect(completed.statusCode).toBe(200);

    const session=await pool.query<{id:string}>(
      "INSERT INTO whatsapp_sessions(tenant_id,status,last_connected_at) VALUES($1,'connected',now()) RETURNING id",
      [tenantId]
    );
    const repository=new SchedulingNotificationRepository(pool);
    const notificationId=await repository.create({
      tenantId,
      appointmentId,
      sessionId:session.rows[0].id,
      groupJid:"120363000000000000@g.us",
      message:"Novo agendamento"
    });
    expect(notificationId).toBeTruthy();
    expect((await pool.query(
      "SELECT status,reaction_emoji,reaction_status FROM scheduling_appointment_notifications WHERE id=$1",
      [notificationId]
    )).rows[0]).toMatchObject({status:"pending",reaction_emoji:"✅",reaction_status:"pending"});

    await repository.markSent(notificationId!,"group-message-id");
    const editedPhone=testPhone();
    const editedIdentity=await app.inject({
      method:"PATCH",
      url:`/scheduling/leads/${lead.json().lead.id}/identity`,
      headers:{cookie},
      payload:{nome:"Agenda finalizada editada",telefone:editedPhone}
    });
    expect(editedIdentity.statusCode).toBe(200);
    expect(await repository.getPendingEdit(notificationId!)).toMatchObject({
      externalMessageId:"group-message-id",
      message:expect.stringContaining("Contato: Agenda finalizada editada"),
      revision:1
    });
    await repository.markEdited(notificationId!,1);
    expect((await pool.query(
      "SELECT edit_status,message_revision,edited_revision FROM scheduling_appointment_notifications WHERE id=$1",
      [notificationId]
    )).rows[0]).toMatchObject({edit_status:"sent",message_revision:1,edited_revision:1});

    await pool.query("UPDATE scheduling_appointment_notifications SET status='pending' WHERE id=$1",[notificationId]);
    await repository.recordFailure(notificationId!,new Error("provider unavailable"),true);
    expect((await pool.query(
      "SELECT status,reaction_status,reaction_last_error FROM scheduling_appointment_notifications WHERE id=$1",
      [notificationId]
    )).rows[0]).toMatchObject({
      status:"failed",
      reaction_status:"failed",
      reaction_last_error:"provider unavailable"
    });
  });
  it("applies workspace IANA timezone across DST boundaries and separates final-action permissions",async()=>{
    const invalidTimezone=await app.inject({method:"PATCH",url:"/workspaces/current/timezone",headers:{cookie},payload:{timezone:"not/a-timezone"}});
    expect(invalidTimezone.statusCode).toBe(400);
    expect((await app.inject({method:"PATCH",url:"/workspaces/current/timezone",payload:{timezone:"America/New_York"}})).statusCode).toBe(401);

    const updatedTimezone=await app.inject({method:"PATCH",url:"/workspaces/current/timezone",headers:{cookie},payload:{timezone:"America/New_York"}});
    expect(updatedTimezone.statusCode).toBe(200);
    expect(updatedTimezone.json().workspace.timezone).toBe("America/New_York");
    expect(updatedTimezone.json().queue_adjustment).toMatchObject({
      promoted: expect.any(Number),
      rescheduled: expect.any(Number),
      skipped: expect.any(Number)
    });
    expect((await app.inject({url:"/workspaces/current/timezone",headers:{cookie}})).json().workspace.timezone).toBe("America/New_York");

    const restrictedEmail=`agenda-cancel-only-${randomUUID()}@test.local`;
    const restrictedPassword="agenda-cancel-only-password";
    try{
      await pool.query("INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity) VALUES($1,'unidade-dst','Unidade DST','01:00','04:00',ARRAY[0]::smallint[],60,1)",[tenantId]);
      const spring=await app.inject({url:"/scheduling/availability?unidade_id=unidade-dst&data=2030-03-10",headers:{cookie}});
      expect(spring.statusCode).toBe(200);
      expect(spring.json()).toMatchObject({data:"2030-03-10",timezone:"America/New_York"});
      expect(spring.json().horarios.map((slot:{start:string})=>slot.start)).toEqual([
        "2030-03-10T06:00:00.000Z",
        "2030-03-10T07:00:00.000Z"
      ]);
      const fall=await app.inject({url:"/unidades/unidade-dst/horarios?data=2030-11-03",headers:apiHeaders});
      expect(fall.statusCode).toBe(200);
      expect(fall.json().horarios.map((slot:{start:string})=>slot.start)).toEqual([
        "2030-11-03T05:00:00.000Z",
        "2030-11-03T06:00:00.000Z",
        "2030-11-03T07:00:00.000Z",
        "2030-11-03T08:00:00.000Z"
      ]);

      const lead=await app.inject({method:"POST",url:"/leads",headers:apiHeaders,payload:{telefone:testPhone(),nome:"Lead DST",categoria_interesse_id:"categoria-teste",unidade_id:"unidade-dst",origem:"teste-dst"}});
      expect(lead.statusCode).toBe(201);
      const appointment=await app.inject({method:"POST",url:"/scheduling/appointments",headers:{cookie},payload:{lead_id:lead.json().lead.id,unidade_id:"unidade-dst",start:"2030-03-10T07:00:00.000Z"}});
      expect(appointment.statusCode).toBe(201);
      const appointmentId=appointment.json().agendamento.id as string;
      const agenda=await app.inject({url:"/scheduling/appointments?unidade_id=unidade-dst&inicio=2030-03-10&fim=2030-03-11",headers:{cookie}});
      expect(agenda.statusCode).toBe(200);
      expect(agenda.json().timezone).toBe("America/New_York");
      expect(agenda.json().agendamentos.map((item:{id:string})=>item.id)).toContain(appointmentId);

      const client=await pool.connect();
      try{
        await client.query("BEGIN");
        const role=await client.query<{id:string}>("INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,$2,'Pode apenas cancelar') RETURNING id",[tenantId,`AGENDA CANCEL ONLY ${randomUUID()}`]);
        await client.query("INSERT INTO workspace_role_permissions(role_id,permission_key) VALUES($1,'appointments.read'),($1,'appointments.cancel')",[role.rows[0].id]);
        const user=await client.query<{id:string}>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",[restrictedEmail,await hash(restrictedPassword,4)]);
        await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())",[tenantId,user.rows[0].id,role.rows[0].id]);
        await client.query("COMMIT");
      }catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}

      const login=await app.inject({method:"POST",url:"/auth/login",payload:{email:restrictedEmail,password:restrictedPassword}});
      const restrictedCookie=(Array.isArray(login.headers["set-cookie"])?login.headers["set-cookie"][0]:login.headers["set-cookie"]!).split(";")[0];
      expect((await app.inject({method:"PATCH",url:"/workspaces/current/timezone",headers:{cookie:restrictedCookie},payload:{timezone:"UTC"}})).statusCode).toBe(403);
      expect((await app.inject({method:"PATCH",url:`/scheduling/appointments/${appointmentId}/concluir`,headers:{cookie:restrictedCookie}})).statusCode).toBe(403);
      expect((await app.inject({method:"PATCH",url:`/scheduling/appointments/${appointmentId}/no-show`,headers:{cookie:restrictedCookie}})).statusCode).toBe(403);
      expect((await app.inject({method:"DELETE",url:`/scheduling/appointments/${appointmentId}`,headers:{cookie:restrictedCookie}})).statusCode).toBe(404);
    }finally{
      await app.inject({method:"PATCH",url:"/workspaces/current/timezone",headers:{cookie},payload:{timezone:"UTC"}});
      await pool.query("DELETE FROM users WHERE email=$1",[restrictedEmail]);
    }
  });
  it("dispatches configured transfer notifications with unit routing data",async()=>{const previous=config.TRANSFER_NOTIFICATION_WEBHOOK_URL;config.TRANSFER_NOTIFICATION_WEBHOOK_URL="https://notify.example.test/transfer";const fetchMock=vi.fn().mockResolvedValue({ok:true,status:200});vi.stubGlobal("fetch",fetchMock);try{const response=await app.inject({method:"POST",url:`/leads/${leadB}/transferir`,headers:apiHeaders,payload:{motivo:"Precisa de humano"}});expect(response.statusCode).toBe(200);expect(fetchMock).toHaveBeenCalledOnce();expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({tenant:tenantId,lead_id:leadB,unidade_id:"unidade-teste",motivo:"Precisa de humano"});expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);const notification=await pool.query("SELECT status FROM scheduling_transfer_notifications WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 1",[leadB]);expect(notification.rows[0].status).toBe("sent")}finally{config.TRANSFER_NOTIFICATION_WEBHOOK_URL=previous;vi.unstubAllGlobals()}});
  it("supports tenant-scoped panel CRUD",async()=>{const created=await app.inject({method:"POST",url:"/scheduling/config/categorias",headers:{cookie},payload:{id:"nova-categoria",nome:"Nova categoria",ativa:true}});expect(created.statusCode).toBe(201);const updated=await app.inject({method:"PUT",url:"/scheduling/config/categorias/nova-categoria",headers:{cookie},payload:{id:"nova-categoria",nome:"Categoria atualizada",ativa:false}});expect(updated.json().categoria.nome).toBe("Categoria atualizada");expect((await app.inject({method:"DELETE",url:"/scheduling/config/categorias/nova-categoria",headers:{cookie}})).statusCode).toBe(204)});
  it("supports partner and unit CRUD without fixed business data",async()=>{const partner={id:"novo-parceiro",nome:"Novo parceiro",ordem_prioridade:3,link_proposta:"https://example.test/nova",ativo:true};expect((await app.inject({method:"POST",url:"/scheduling/config/parceiros",headers:{cookie},payload:partner})).statusCode).toBe(201);expect((await app.inject({method:"DELETE",url:"/scheduling/config/parceiros/novo-parceiro",headers:{cookie}})).statusCode).toBe(204);const unit={id:"nova-unidade",nome:"Nova unidade",horario_abertura:"08:00",horario_fechamento:"17:00",dias_funcionamento:[1,2,3,4,5],duracao_slot_min:30,capacidade_simultanea:2};expect((await app.inject({method:"POST",url:"/scheduling/config/unidades",headers:{cookie},payload:unit})).statusCode).toBe(201);expect((await app.inject({method:"DELETE",url:"/scheduling/config/unidades/nova-unidade",headers:{cookie}})).statusCode).toBe(204)});
});
