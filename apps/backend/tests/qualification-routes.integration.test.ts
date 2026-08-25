import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { OpenRouterClient } from "../src/modules/ai-router/openrouter.js";
import { QualificationService } from "../src/modules/qualification/service.js";
import { WhatsAppSessionManager } from "../src/modules/whatsapp/session-manager.js";

const pool=new pg.Pool({connectionString:config.DATABASE_URL});
const app=buildApp();
let tenantId="";let otherTenantId="";let sessionId="";let foreignSessionId="";let cookie="";let readCookie="";let ownerUserId="";let testEmails:string[]=[];
let phoneSequence=Number(Date.now().toString().slice(-8));
const nextPhone=(ddd="11")=>`55${ddd}${String(++phoneSequence).slice(-8).padStart(8,"0")}`;

beforeAll(async()=>{
  await app.ready();
  tenantId=(await pool.query<{id:string}>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",[`Qualification routes ${randomUUID()}`])).rows[0].id;
  otherTenantId=(await pool.query<{id:string}>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",[`Qualification foreign ${randomUUID()}`])).rows[0].id;
  sessionId=(await pool.query<{id:string}>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",[tenantId])).rows[0].id;
  foreignSessionId=(await pool.query<{id:string}>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id",[otherTenantId])).rows[0].id;
  const email=`qualification-${randomUUID()}@test.local`;const readEmail=`qualification-read-${randomUUID()}@test.local`;const password="qualification-password";
  testEmails=[email,readEmail];
  const client=await pool.connect();
  try{await client.query("BEGIN");await ensureWorkspaceDefaultRoles(client,tenantId);const passwordHash=await hash(password,4);const user=await client.query<{id:string}>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",[email,passwordHash]);ownerUserId=user.rows[0].id;const ownerMember=await client.query<{id:string}>("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER' RETURNING id",[tenantId,user.rows[0].id]);await client.query("INSERT INTO scheduling_google_meet_closers(tenant_id,member_id) VALUES($1,$2)",[tenantId,ownerMember.rows[0].id]);const readRole=await client.query<{id:string}>("INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,$2,'Leitura Newave') RETURNING id",[tenantId,`NEWAVE READ ${randomUUID()}`]);await client.query("INSERT INTO workspace_role_permissions(role_id,permission_key) VALUES($1,'agent.read')",[readRole.rows[0].id]);const readUser=await client.query<{id:string}>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",[readEmail,passwordHash]);await client.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())",[tenantId,readUser.rows[0].id,readRole.rows[0].id]);await client.query("COMMIT");}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  const login=await app.inject({method:"POST",url:"/auth/login",payload:{email,password}});
  cookie=(Array.isArray(login.headers["set-cookie"])?login.headers["set-cookie"][0]:login.headers["set-cookie"]!).split(";")[0];
  const readLogin=await app.inject({method:"POST",url:"/auth/login",payload:{email:readEmail,password}});
  readCookie=(Array.isArray(readLogin.headers["set-cookie"])?readLogin.headers["set-cookie"][0]:readLogin.headers["set-cookie"]!).split(";")[0];
});

afterAll(async()=>{await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN(SELECT id FROM users WHERE email=ANY($1::text[]))",[testEmails]);await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])",[[tenantId,otherTenantId]]);await pool.query("DELETE FROM users WHERE email=ANY($1::text[])",[testEmails]);await app.close();await pool.end();});

const service=new QualificationService();
async function activeQualification(suffix:string){
  const phone=nextPhone();
  const conversation=(await pool.query<{id:string}>("INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",[tenantId,sessionId,phone])).rows[0];
  await service.handleInbound({tenantId,sessionId,contactPhone:phone,text:"Anúncio",externalId:`start-${suffix}-${randomUUID()}`,referral:{sourceType:"ad",sourceId:`ad-${suffix}`}});
  const state=(await pool.query(`SELECT l.id lead_id,q.id qualification_id FROM scheduling_leads l JOIN lead_qualifications q ON q.lead_id=l.id AND q.tenant_id=l.tenant_id WHERE l.tenant_id=$1 AND l.phone=$2`,[tenantId,phone])).rows[0];
  return {phone,conversationId:conversation.id,...state};
}

describe("API de configuração Newave",()=>{
  it("qualifica manualmente pelo histórico e exige permissão de alteração do lead",async()=>{
    const phone=nextPhone();
    const conversation=(await pool.query<{id:string;lead_id:string}>(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name) VALUES($1,$2,$3,'Empresa Contextual') RETURNING id,lead_id",
      [tenantId,sessionId,phone]
    )).rows[0];
    const lead=(await pool.query<{id:string}>(
      "UPDATE scheduling_leads SET name='Empresa Contextual',source='whatsapp' WHERE tenant_id=$1 AND id=$2 RETURNING id",
      [tenantId,conversation.lead_id]
    )).rows[0];
    await pool.query(
      `INSERT INTO messages(conversation_id,sender,content)
       VALUES($1,'contact','Atuo há seis anos no varejo'),($1,'human','Qual é o faturamento?'),($1,'contact','Em torno de 80 mil por mês')`,
      [conversation.id]
    );
    await pool.query(
      "INSERT INTO agent_configs(tenant_id,system_prompt,ai_model) VALUES($1,'Prompt de teste','test/contextual-model')",
      [tenantId]
    );
    const complete=vi.spyOn(OpenRouterClient.prototype,"complete").mockResolvedValue({
      text:JSON.stringify({
        estrelas:5,
        respostas:{
          tempo_mercado:"6 anos",
          faturamento:"Cerca de R$ 80 mil por mês",
          nicho:"Varejo",
          causa_perda_vendas:null,
          possibilidade_investimento:null,
          instagram:null
        },
        resumo:"Empresa madura no varejo, com faturamento declarado.",
        justificativa:"Tempo de operação e faturamento demonstram maturidade comercial."
      }),
      inputTokens:100,
      outputTokens:60,
      costUsd:0
    });
    try{
      expect((await app.inject({method:"POST",url:`/scheduling/leads/${lead.id}/qualify-context`})).statusCode).toBe(401);
      expect((await app.inject({method:"POST",url:`/scheduling/leads/${lead.id}/qualify-context`,headers:{cookie:readCookie}})).statusCode).toBe(403);
      const response=await app.inject({method:"POST",url:`/scheduling/leads/${lead.id}/qualify-context`,headers:{cookie}});
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        lead_id:lead.id,
        conversa_id:conversation.id,
        mensagens_analisadas:3,
        qualificacao:{
          estrelas:5,
          respostas:{tempo_mercado:"6 anos",faturamento:"Cerca de R$ 80 mil por mês",nicho:"Varejo"},
          resumo:"Empresa madura no varejo, com faturamento declarado."
        }
      });
      expect(response.json().qualificacao.respostas).not.toHaveProperty("causa_perda_vendas");
      expect(complete.mock.calls[0][0].responseFormat).toMatchObject({
        json_schema:{
          strict:true,
          schema:{
            properties:{
              respostas:{
                required:[
                  "tempo_mercado",
                  "faturamento",
                  "nicho",
                  "causa_perda_vendas",
                  "possibilidade_investimento",
                  "instagram"
                ]
              }
            }
          }
        }
      });
      expect((await pool.query(
        "SELECT status,qualification_stars FROM scheduling_leads WHERE id=$1",
        [lead.id]
      )).rows[0]).toEqual({status:"qualificado",qualification_stars:5});
      const repeated=await app.inject({method:"POST",url:`/scheduling/leads/${lead.id}/qualify-context`,headers:{cookie}});
      expect(repeated.statusCode).toBe(409);
      expect(repeated.json().error).toBe("Este lead já foi qualificado");
      expect(complete).toHaveBeenCalledTimes(1);
    }finally{
      complete.mockRestore();
    }
  });

  it("salva incompleto desativado e valida requisitos antes de ativar",async()=>{
    const inactive=await app.inject({method:"PUT",url:"/qualification/flows/newave",headers:{cookie},payload:{nome:"Fluxo Newave",ativo:false}});
    expect(inactive.statusCode).toBe(201);expect(inactive.json().flow.ativo).toBe(false);
    const invalid=await app.inject({method:"PUT",url:"/qualification/flows/newave",headers:{cookie},payload:{nome:"Fluxo Newave",ativo:true}});
    expect(invalid.statusCode).toBe(400);expect(invalid.json().error).toContain("gatilho");
  });

  it("permite consulta com agent.read e exige agent.manage para salvar",async()=>{
    expect((await app.inject({url:"/qualification/flows/newave",headers:{cookie:readCookie}})).statusCode).toBe(200);
    expect((await app.inject({method:"PUT",url:"/qualification/flows/newave",headers:{cookie:readCookie},payload:{nome:"Bloqueado",ativo:false}})).statusCode).toBe(403);
  });

  it("valida sessões no tenant e expõe somente configuração própria",async()=>{
    const foreign=await app.inject({method:"PUT",url:"/qualification/flows/newave",headers:{cookie},payload:{nome:"Fluxo Newave",ativo:false,sessoes:[foreignSessionId]}});
    expect(foreign.statusCode).toBe(400);
    const active=await app.inject({method:"PUT",url:"/qualification/flows/newave",headers:{cookie},payload:{nome:"Fluxo Newave",ativo:true,sessoes:[sessionId],ctwa:true,palavras_chave:["newave"]}});
    expect(active.statusCode).toBe(200);expect(active.json().flow).toMatchObject({ativo:true,gatilhos:{ctwa:true,session_ids:[sessionId],keywords:["newave"]}});
    const sessions=await app.inject({url:"/qualification/sessions",headers:{cookie}});
    expect(sessions.json().sessions.map((item:{id:string})=>item.id)).toEqual([sessionId]);
  });

  it("mantém somente um fluxo ativo por organização",async()=>{
    const second=await app.inject({method:"PUT",url:"/qualification/flows/newave-v2",headers:{cookie},payload:{nome:"Fluxo Newave v2",ativo:true,ctwa:true}});
    expect(second.statusCode).toBe(201);
    const active=await pool.query("SELECT id FROM qualification_flows WHERE tenant_id=$1 AND active",[tenantId]);
    expect(active.rows).toEqual([{id:"newave-v2"}]);
    expect((await app.inject({url:"/qualification/flows/inexistente",headers:{cookie}})).statusCode).toBe(404);
  });

  it("isola por organização os quatro filtros de qualificação",async()=>{
    const definition=(await pool.query("SELECT definition FROM qualification_flows WHERE tenant_id=$1 AND id='newave-v2'",[tenantId])).rows[0].definition;
    await pool.query("INSERT INTO qualification_flows(tenant_id,id,name,active,definition) VALUES($1,'newave-filter','Filtro',false,$2)",[otherTenantId,definition]);
    const localA=(await pool.query<{id:string}>("INSERT INTO scheduling_leads(tenant_id,phone,source) VALUES($1,$2,'facebook') RETURNING id",[tenantId,nextPhone()])).rows[0].id;
    const localB=(await pool.query<{id:string}>("INSERT INTO scheduling_leads(tenant_id,phone,source) VALUES($1,$2,'facebook') RETURNING id",[tenantId,nextPhone()])).rows[0].id;
    const foreign=(await pool.query<{id:string}>("INSERT INTO scheduling_leads(tenant_id,phone,source) VALUES($1,$2,'facebook') RETURNING id",[otherTenantId,nextPhone()])).rows[0].id;
    const insertQualification=(leadId:string,ownerTenant:string,flowId:string,values:{faturamento:string;resultado:string;investimento:string;status:string})=>pool.query(
      `INSERT INTO lead_qualifications(tenant_id,lead_id,flow_id,current_step,status,definition_snapshot,trigger_type,attribution,
       faturamento,resultado_final,investimento,answered_count,total_questions)
       VALUES($1,$2,$3,$4,$5,$6,'ctwa','{"channel":"facebook","product":"newave"}',$7,$8,$9,3,3)`,
      [ownerTenant,leadId,flowId,values.resultado,values.status,definition,values.faturamento,values.resultado,values.investimento]
    );
    await insertQualification(localA,tenantId,"newave-v2",{faturamento:"Até R$ 10 mil",resultado:"E3_ENCERRAMENTO",investimento:"NÃO",status:"concluido"});
    await insertQualification(localB,tenantId,"newave-v2",{faturamento:"Acima de R$ 100 mil",resultado:"E1_PAGINA_FINAL",investimento:"SIM",status:"concluido"});
    await insertQualification(foreign,otherTenantId,"newave-filter",{faturamento:"Até R$ 10 mil",resultado:"E3_ENCERRAMENTO",investimento:"NÃO",status:"concluido"});
    for(const query of [
      "faturamento=At%C3%A9+R%24+10+mil","resultado=E3_ENCERRAMENTO","investimento=NAO","formulario=concluido"
    ]){
      const response=await app.inject({url:`/scheduling/leads?${query}`,headers:{cookie}});
      expect(response.statusCode).toBe(200);
      const ids=response.json().leads.map((item:{id:string})=>item.id);
      expect(ids).toContain(localA);expect(ids).not.toContain(foreign);
      if(!query.startsWith("formulario"))expect(ids).not.toContain(localB);
    }
  });

  it("pausa e retoma qualificação junto com o estado da conversa",async()=>{
    const item=await activeQualification("21");
    expect((await app.inject({method:"PATCH",url:`/conversations/${item.conversationId}/pause`,headers:{cookie}})).statusCode).toBe(200);
    let state=(await pool.query(`SELECT q.status,c.ai_active,c.handoff_reason FROM lead_qualifications q JOIN conversations c ON c.tenant_id=q.tenant_id JOIN scheduling_leads l ON l.id=q.lead_id AND l.phone=c.contact_phone WHERE q.id=$1`,[item.qualification_id])).rows[0];
    expect(state).toEqual({status:"pausado",ai_active:false,handoff_reason:"manually_paused"});
    expect((await app.inject({method:"POST",url:`/scheduling/leads/${item.lead_id}/qualification/retomar`,headers:{cookie}})).statusCode).toBe(200);
    state=(await pool.query("SELECT q.status,q.ask_pending,c.ai_active FROM lead_qualifications q JOIN scheduling_leads l ON l.id=q.lead_id JOIN conversations c ON c.tenant_id=l.tenant_id AND c.contact_phone=l.phone WHERE q.id=$1",[item.qualification_id])).rows[0];
    expect(state).toEqual({status:"em_andamento",ask_pending:true,ai_active:true});
  });

  it("pausa ao assumir, atribuir e enviar manualmente, sem cruzar tenants",async()=>{
    const claimed=await activeQualification("22");
    expect((await app.inject({method:"PATCH",url:`/conversations/${claimed.conversationId}/claim`,headers:{cookie}})).statusCode).toBe(200);
    expect((await pool.query("SELECT status FROM lead_qualifications WHERE id=$1",[claimed.qualification_id])).rows[0].status).toBe("pausado");

    const assigned=await activeQualification("23");
    expect((await app.inject({method:"PATCH",url:`/conversations/${assigned.conversationId}/assign`,headers:{cookie},payload:{userId:ownerUserId}})).statusCode).toBe(200);
    expect((await pool.query("SELECT status FROM lead_qualifications WHERE id=$1",[assigned.qualification_id])).rows[0].status).toBe("pausado");

    const manual=await activeQualification("24");
    await pool.query("UPDATE conversations SET ai_active=false,handoff_reason='manually_paused' WHERE id=$1",[manual.conversationId]);
    const send=vi.spyOn(WhatsAppSessionManager.prototype,"sendText").mockResolvedValue({externalId:`manual-${randomUUID()}`});
    try{
      const response=await app.inject({method:"POST",url:`/conversations/${manual.conversationId}/messages`,headers:{cookie,"idempotency-key":randomUUID()},payload:{text:"Atendimento manual"}});
      expect(response.statusCode).toBe(201);
      expect((await pool.query("SELECT status FROM lead_qualifications WHERE id=$1",[manual.qualification_id])).rows[0].status).toBe("pausado");
    }finally{send.mockRestore();}

    const foreignLead=(await pool.query<{id:string}>("INSERT INTO scheduling_leads(tenant_id,phone,source) VALUES($1,$2,'teste') RETURNING id",[otherTenantId,nextPhone("99")])).rows[0].id;
    expect((await app.inject({method:"POST",url:`/scheduling/leads/${foreignLead}/qualification/pausar`,headers:{cookie}})).statusCode).toBe(404);
  });
});
