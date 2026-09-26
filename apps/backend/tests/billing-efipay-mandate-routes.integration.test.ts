import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { encryptCredentials } from "../src/billing/providers/credentials.js";
import { setEfiPixMandateOverridesForTests } from "../src/billing/efipay-mandates.js";
import type { EfiTransport } from "../src/billing/providers/efipay-pix-automatic.js";

/**
 * Rotas do mandato Pix Automático (Efí) contra o serviço REAL (efipay-mandates.ts)
 * com provider DEDICADO por execução + transport falso injetado
 * (setEfiPixMandateOverridesForTests) — as linhas globais de billing_providers
 * nunca são reconfiguradas e o override é sempre restaurado. Cobre: 401 sem
 * sessão, 403 sem billing.manage (GET só exige workspace), POST sem corpo
 * (preço/quantidade fixos no servidor), isolamento multi-tenant, fail-closed
 * sem provider Efí e sem documento do titular.
 */
const PATH="/billing/ai-credit-packs/pix-automatic";
const MANDATE_OVERRIDE={providerCode:`efipay-mandate-${randomUUID().slice(0,8)}`};
const runId=MANDATE_OVERRIDE.providerCode.slice("efipay-mandate-".length);
const recStatus=new Map<string,string>();
let recSeq=0;let locSeq=0;

// Efí falsa: jornada 2 (token, locrec, rec, GET rec). Caminho desconhecido
// falha alto — desvio de fluxo quebra o teste, não passa silencioso.
const fakeEfi:EfiTransport=async(request)=>{
  const json=(body:unknown)=>({statusCode:200,text:JSON.stringify(body)});
  if(request.method==="POST"&&request.path==="/oauth/token")return json({access_token:"test-token",expires_in:3600});
  if(request.method==="POST"&&request.path==="/v2/locrec")return json({id:++locSeq,location:"loc"});
  if(request.method==="POST"&&request.path==="/v2/rec"){
    const idRec=`rec${runId.replace(/-/g,"")}${String(++recSeq).padStart(4,"0")}`.slice(0,35);
    recStatus.set(idRec,"CRIADA");
    return json({idRec,status:"CRIADA"});
  }
  if(request.method==="GET"&&request.path.startsWith("/v2/rec/")){
    const idRec=decodeURIComponent(request.path.slice("/v2/rec/".length));
    return json({idRec,status:recStatus.get(idRec)??"CRIADA",dadosQR:{pixCopiaECola:`pix-copia-e-cola-${idRec}`}});
  }
  return {statusCode:400,text:JSON.stringify({message:`caminho Efí inesperado: ${request.method} ${request.path}`})};
};

const pool=new pg.Pool({connectionString:config.DATABASE_URL});
const app=buildApp();
const tenants:string[]=[],emails:string[]=[];
let tenantA="";let tenantB="";let tenantC="";let userA="";let cookieA="";let cookieB="";let cookieC="";let readCookie="";
let providerId="";

async function insertTenant(name:string):Promise<string>{
  const workspace=(await pool.query<{id:string}>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",[name])).rows[0].id;
  tenants.push(workspace);
  const client=await pool.connect();
  try{await client.query("BEGIN");await ensureWorkspaceDefaultRoles(client,workspace);await client.query("COMMIT");}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  return workspace;
}

async function ownerCookie(workspace:string,tag:string):Promise<{userId:string;cookie:string}>{
  const email=`efi-mandate-${tag}-${randomUUID()}@test.local`;emails.push(email);
  const user=(await pool.query<{id:string}>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",[email,await hash("efi-mandate-password",4)])).rows[0].id;
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'",[workspace,user]);
  const login=await app.inject({method:"POST",url:"/auth/login",payload:{email,password:"efi-mandate-password"}});
  return {userId:user,cookie:(Array.isArray(login.headers["set-cookie"])?login.headers["set-cookie"][0]:login.headers["set-cookie"]!).split(";")[0]};
}

async function mandateCount(tenant:string):Promise<number>{
  return (await pool.query<{n:number}>("SELECT count(*)::int n FROM ai_credit_pix_mandates WHERE tenant_id=$1",[tenant])).rows[0].n;
}

beforeAll(async()=>{
  await app.ready();
  tenantA=await insertTenant(`Efi mandate ${randomUUID()}`);
  tenantB=await insertTenant(`Efi mandate foreign ${randomUUID()}`);
  tenantC=await insertTenant(`Efi mandate no-debtor ${randomUUID()}`);
  // Provider dedicado (código único por execução): o serviço olha este código
  // via override; as linhas globais 'efipay' ficam intocadas (desligadas).
  providerId=(await pool.query<{id:string}>(`INSERT INTO billing_providers(code,name,enabled,environment,homologated,status,credentials_encrypted) VALUES($1,$1,true,'production',true,'CONNECTED',$2) RETURNING id`,[MANDATE_OVERRIDE.providerCode,encryptCredentials({clientId:"test",clientSecret:"test",certificateP12Base64:"dGVzdA=="},config.DATA_ENCRYPTION_KEY)])).rows[0].id;
  // Devedor (§ pagador) para A e B; C fica SEM documento — fail-closed.
  await pool.query("INSERT INTO billing_accounts(tenant_id,provider_id,document) VALUES($1,$2,'12345678901')",[tenantA,providerId]);
  await pool.query("INSERT INTO billing_accounts(tenant_id,provider_id,document) VALUES($1,$2,'12345678901234')",[tenantB,providerId]);
  setEfiPixMandateOverridesForTests({...MANDATE_OVERRIDE,transport:fakeEfi});
  const ownerA=await ownerCookie(tenantA,"a");
  userA=ownerA.userId;cookieA=ownerA.cookie;
  cookieB=(await ownerCookie(tenantB,"b")).cookie;
  cookieC=(await ownerCookie(tenantC,"c")).cookie;
  // Leitura sem billing.manage: papel com apenas agent.read.
  const readEmail=`efi-mandate-read-${randomUUID()}@test.local`;emails.push(readEmail);
  const readUser=(await pool.query<{id:string}>("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",[readEmail,await hash("efi-mandate-password",4)])).rows[0].id;
  const readRole=(await pool.query<{id:string}>("INSERT INTO workspace_roles(workspace_id,name,description) VALUES($1,$2,'Somente leitura') RETURNING id",[tenantA,`EFI READ ${randomUUID()}`])).rows[0].id;
  await pool.query("INSERT INTO workspace_role_permissions(role_id,permission_key) VALUES($1,'agent.read')",[readRole]);
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) VALUES($1,$2,$3,'active',now())",[tenantA,readUser,readRole]);
  const readLogin=await app.inject({method:"POST",url:"/auth/login",payload:{email:readEmail,password:"efi-mandate-password"}});
  readCookie=(Array.isArray(readLogin.headers["set-cookie"])?readLogin.headers["set-cookie"][0]:readLogin.headers["set-cookie"]!).split(";")[0];
});

afterAll(async()=>{
  // Sempre restaura o estado do serviço; nenhum fixture global fica alterado.
  setEfiPixMandateOverridesForTests(undefined);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])",[tenants]);
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email=ANY($1::text[]))",[emails]);
  await pool.query("DELETE FROM users WHERE email=ANY($1::text[])",[emails]);
  await pool.query("DELETE FROM billing_providers WHERE code=$1",[MANDATE_OVERRIDE.providerCode]);
  await app.close();
  await pool.end();
});

describe("rotas do mandato Pix Automático (Efí)",()=>{
  it("GET exige apenas workspace; POST/DELETE exigem billing.manage; sem sessão é 401",async()=>{
    for(const method of ["GET","POST","DELETE"] as const)expect((await app.inject({method,url:PATH})).statusCode).toBe(401);
    expect((await app.inject({url:PATH,headers:{cookie:readCookie}})).statusCode).toBe(200);
    expect((await app.inject({url:PATH,headers:{cookie:readCookie}})).json()).toEqual({mandate:null});
    expect((await app.inject({method:"POST",url:PATH,headers:{cookie:readCookie}})).statusCode).toBe(403);
    expect((await app.inject({method:"DELETE",url:PATH,headers:{cookie:readCookie}})).statusCode).toBe(403);
    // Rota literal vizinha segue intacta (precedência do path literal).
    expect((await app.inject({url:"/billing/ai-credit-packs/balance",headers:{cookie:readCookie}})).statusCode).toBe(200);
  });

  it("POST rejeita corpo: preço e quantidade são fixos no servidor",async()=>{
    const r=await app.inject({method:"POST",url:PATH,headers:{cookie:cookieA,"content-type":"application/json"},payload:{priceCents:100,credits:1}});
    expect(r.statusCode).toBe(400);
    expect(await mandateCount(tenantA)).toBe(0);
  });

  it("sem provider Efí configurado falha fechado e o status segue legível",async()=>{
    setEfiPixMandateOverridesForTests(undefined); // caminho de produção real: olha 'efipay' global (desligado)
    try{
      const post=await app.inject({method:"POST",url:PATH,headers:{cookie:cookieA}});
      expect(post.statusCode).toBeGreaterThanOrEqual(400);
      expect(await mandateCount(tenantA)).toBe(0);
      const get=await app.inject({url:PATH,headers:{cookie:cookieA}});
      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual({mandate:null});
    }finally{
      setEfiPixMandateOverridesForTests({...MANDATE_OVERRIDE,transport:fakeEfi});
    }
  });

  it("opt-in, status, duplicidade idempotente e stop isolados por tenant",async()=>{
    const started=await app.inject({method:"POST",url:PATH,headers:{cookie:cookieA}});
    expect(started.statusCode).toBe(200);
    const mandate=started.json().mandate;
    expect(mandate).toMatchObject({status:"PENDING"});
    expect(String(mandate.pixCopiaECola)).toContain("pix-copia-e-cola");
    expect(String(mandate.firstDueOn)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const rowA=(await pool.query<{status:string;credits:string;price_cents:string;consent_actor_user_id:string;external_id_rec:string|null}>("SELECT status,credits,price_cents,consent_actor_user_id,external_id_rec FROM ai_credit_pix_mandates WHERE tenant_id=$1",[tenantA])).rows[0];
    expect(rowA).toMatchObject({status:"PENDING",credits:"50000000",price_cents:"15700",consent_actor_user_id:userA});
    expect(rowA.external_id_rec).toBeTruthy();

    // B não vê o mandato de A e cria o próprio.
    expect((await app.inject({url:PATH,headers:{cookie:cookieB}})).json()).toEqual({mandate:null});
    const foreign=await app.inject({method:"POST",url:PATH,headers:{cookie:cookieB}});
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json().mandate.id).not.toBe(mandate.id);
    expect((await app.inject({url:PATH,headers:{cookie:cookieA}})).json().mandate.id).toBe(mandate.id);
    // Reopt-in NUNCA reenvia criação remota: mesmo mandato, mesmo id.
    expect((await app.inject({method:"POST",url:PATH,headers:{cookie:cookieA}})).json().mandate.id).toBe(mandate.id);

    // Stop de A não interrompe B; a revogação bancária fica explícita.
    const stopped=await app.inject({method:"DELETE",url:PATH,headers:{cookie:cookieA}});
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().mandate.status).toBe("CANCELLED");
    expect(String(stopped.json().remoteRevocation)).toContain("não oferece API");
    expect(String(stopped.json().remoteRevocation)).toContain("app do banco");
    expect(String(stopped.json().remoteRevocation)).toContain("vencimento hoje");
    expect((await pool.query<{status:string}>("SELECT status FROM ai_credit_pix_mandates WHERE tenant_id=$1",[tenantA])).rows[0]).toMatchObject({status:"CANCELLED"});
    expect((await app.inject({url:PATH,headers:{cookie:cookieB}})).json().mandate.status).toBe("PENDING");
    // Stop sem mandato em curso é idempotente: mandate null, sem erro.
    expect((await app.inject({method:"DELETE",url:PATH,headers:{cookie:cookieA}})).json().mandate).toBeNull();
    // E B para o dele.
    expect((await app.inject({method:"DELETE",url:PATH,headers:{cookie:cookieB}})).statusCode).toBe(200);
  });

  it("sem documento do titular (CPF/CNPJ) falha fechado",async()=>{
    const post=await app.inject({method:"POST",url:PATH,headers:{cookie:cookieC}});
    expect(post.statusCode).toBeGreaterThanOrEqual(400);
    expect(await mandateCount(tenantC)).toBe(0);
  });
});
