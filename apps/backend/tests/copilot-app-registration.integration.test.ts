// R3 — exposição do copiloto pelo buildApp: rota registrada UMA vez em app.ts
// (sem re-registro direto em buildApp de teste — app.ts é do orquestrador).
// Smoke mínimo: hasRoute após app.ready, anônimo 401 (Fastify devolveria 404 se
// a rota não existisse) e inquilino válido executando o handler REAL — conversa
// sem agente → 409 acionável. Copiloto nunca envia nada: nada além do 409 roda.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const tenantIds: string[] = [];
const testEmails: string[] = [];
let phoneSeq = 0;

async function provisionRootWithConversation(label: string): Promise<{ cookie: string; conversationId: string }> {
  const tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Copilot app ${label} ${randomUUID()}`]
  )).rows[0].id;
  tenantIds.push(tenantId);
  const email = `copilot-app-${label}-${randomUUID()}@test.local`;
  testEmails.push(email);
  const userId = (await pool.query<{ id: string }>(
    "INSERT INTO users(email,password_hash,status,is_root) VALUES($1,'x','active',true) RETURNING id", [email]
  )).rows[0].id;
  const sessionId = (await pool.query<{ id: string }>(
    "INSERT INTO whatsapp_sessions(tenant_id,label,status) VALUES($1,'Comercial','connected') RETURNING id", [tenantId]
  )).rows[0].id;
  const conversationId = (await pool.query<{ id: string }>(
    "INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name) VALUES($1,$2,$3,'Contato') RETURNING id",
    [tenantId, sessionId, `5511${String(90_000_000 + (phoneSeq += 1))}`]
  )).rows[0].id;
  const token = await createSessionToken({ userId, tenantId, email, isRoot: true });
  return { cookie: `atendon_session=${token}`, conversationId };
}

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenantIds]);
  await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [testEmails]);
  await app.close();
  await pool.end();
});

describe("R3 — copiloto exposto pelo buildApp (app.ts)", () => {
  it("rota registrada em app.ts e visível após app.ready", () => {
    expect(app.hasRoute({ method: "POST", url: "/conversations/:id/copilot-suggestion" })).toBe(true);
  });

  it("anônimo: 401 (sem rota registrada, o Fastify responderia 404)", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${randomUUID()}/copilot-suggestion`
    });
    expect(response.statusCode).toBe(401);
  });

  it("inquilino válido: handler real executa — conversa sem agente → 409 acionável", async () => {
    const fixture = await provisionRootWithConversation("sem-agente");
    const response = await app.inject({
      method: "POST",
      url: `/conversations/${fixture.conversationId}/copilot-suggestion`,
      headers: { cookie: fixture.cookie }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("Configure o agente");
  });
});
