// F4-r1 (WP-B — specs/active/flow-integrity-20260921.md rev.3 + decisões B1-B7):
// CAS de fluxos. Prova o trigger da migration 0182 (QUALQUER UPDATE incrementa
// revision; SET manual é sobrescrito), o 409 FLOW_VERSION_CONFLICT sem gravar
// nada (nem snapshot fantasma), a corrida N=5 na MESMA base (1 vence, N-1 409
// com a revisão corrente), restore com revisao_base correto e o isolamento do
// lock advisory por tenant (não vaza entre tenants).
// app.ts é do orquestrador: os testes usam buildApp() (rotas /qualification/*
// já registradas — NUNCA re-registrar o plugin aqui).
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { seedTenantCapabilities } from "./helpers/capability-seed.js";
import { flowDefinitionSchema } from "../src/modules/qualification/flow.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const tenantIds: string[] = [];
const testEmails: string[] = [];

// Definições dos 5 tipos de nó exigidos pela corrida (message/delay/branch/
// finalize/interactive) — todas passam no zod e em activationIssues.
const triggers = { ctwa: false, session_ids: [] as string[], keywords: ["cas"] };
const raceDefinitions = {
  message: {
    start: "M1", origem: "facebook", triggers,
    steps: { M1: { kind: "message", message: "cas msg", next: "F1" }, F1: { kind: "final", message: "fim" } }
  },
  delay: {
    start: "D1", origem: "facebook", triggers,
    steps: { D1: { kind: "delay", wait_minutes: 1, next: "F1" }, F1: { kind: "final", message: "fim" } }
  },
  branch: {
    start: "B1", origem: "facebook", triggers,
    steps: {
      B1: { kind: "branch", variable_name: "x", operator: "eq", value: "y", transitions: { yes: "F1", no: "F1" } },
      F1: { kind: "final", message: "fim" }
    }
  },
  finalize: {
    start: "Z1", origem: "facebook", triggers,
    steps: { Z1: { kind: "finalize", end_reason: "cas" } }
  },
  interactive: {
    start: "I1", origem: "facebook", triggers,
    steps: {
      I1: { kind: "interactive", interactive_type: "buttons", message: "escolha", options: [{ value: "a" }], transitions: { a: "F1" } },
      F1: { kind: "final", message: "fim" }
    }
  }
} satisfies Record<string, z.input<typeof flowDefinitionSchema>>;

const baseDefinition = raceDefinitions.message;

async function provisionTenant(label: string): Promise<{ tenantId: string; userId: string }> {
  const tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Flow CAS ${label} ${randomUUID()}`]
  )).rows[0].id;
  tenantIds.push(tenantId);
  await seedTenantCapabilities(pool, [tenantId]);
  const email = `cas-${label}-${randomUUID()}@test.local`;
  testEmails.push(email);
  const passwordHash = await hash("cas-password", 4);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    const user = (await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id", [email, passwordHash]
    )).rows[0];
    await client.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at) SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OWNER'",
      [tenantId, user.id]
    );
    await client.query("COMMIT");
    return { tenantId, userId: user.id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cookieFor(tenantId: string, userId: string): Promise<string> {
  const email = (await pool.query<{ email: string }>("SELECT email FROM users WHERE id=$1", [userId])).rows[0].email;
  const token = await createSessionToken({ userId, tenantId, email, isRoot: false, rootWorkspaceAccess: false, mustChangePassword: false });
  return `atendon_session=${token}`;
}

const putFlow = (cookie: string, id: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: `/qualification/flows/${id}`, headers: { cookie }, payload });

const patchFlow = (cookie: string, id: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url: `/qualification/flows/${id}`, headers: { cookie }, payload });

async function flowRow(tenantId: string, id: string) {
  return (await pool.query<{ revision: number; name: string; active: boolean; definition: unknown }>(
    "SELECT revision,name,active,definition FROM qualification_flows WHERE tenant_id=$1 AND id=$2", [tenantId, id]
  )).rows[0];
}

async function snapshotCount(tenantId: string, id: string): Promise<number> {
  return Number((await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM flow_versions WHERE tenant_id=$1 AND flow_id=$2", [tenantId, id]
  )).rows[0].count);
}

async function currentRevision(tenantId: string, id: string): Promise<number> {
  return (await flowRow(tenantId, id))?.revision ?? 0;
}

function expectConflict(body: { code?: string; revisao?: number; error?: string }, revisao: number) {
  expect(body.code).toBe("FLOW_VERSION_CONFLICT");
  expect(body.revisao).toBe(revisao);
  expect(body.error).toContain("Conflito de versão");
}

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email=ANY($1::text[]))", [testEmails]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenantIds]);
  await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [testEmails]);
  await app.close();
  await pool.end();
});

describe("F4-r1 — CAS de fluxos (revision + revisao_base + lock por tenant)", () => {
  it("(a) corrida N=5 na MESMA revisao_base com os 5 tipos de payload: 1 vence, 4 tomam 409 com a revisão corrente, sem estado corrompido", async () => {
    const { tenantId, userId } = await provisionTenant("race");
    const cookie = await cookieFor(tenantId, userId);
    const created = await putFlow(cookie, "cas-race", { nome: "CAS Race", definition: baseDefinition, revisao_base: 0 });
    expect(created.statusCode).toBe(201);
    expect(created.json().flow.revisao).toBe(1);

    const payloads = Object.entries(raceDefinitions).map(([kind, definition]) => ({ kind, body: { nome: `CAS Race ${kind}`, definition, revisao_base: 1 } }));
    const results = await Promise.all(payloads.map(({ body }) => putFlow(cookie, "cas-race", body)));

    const winners = results.filter((result) => result.statusCode === 200);
    const losers = results.filter((result) => result.statusCode === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(4);
    for (const loser of losers) expectConflict(loser.json(), 2);

    const winner = payloads[results.indexOf(winners[0])];
    const row = (await flowRow(tenantId, "cas-race"))!;
    expect(row.revision).toBe(2); // contígua: 1 (criação) → 2 (vencedor)
    expect(row.name).toBe(winner.body.nome);
    expect(row.definition).toEqual(flowDefinitionSchema.parse(winner.body.definition));
    expect(flowDefinitionSchema.safeParse(row.definition).success).toBe(true); // sem estado corrompido
    expect(await snapshotCount(tenantId, "cas-race")).toBe(2); // criação + vencedor; conflito NÃO cria snapshot fantasma
  });

  it("(b) trigger incrementa a revisão em PATCH nome/ativo; SET manual de revision é sobrescrito; GET detail expõe revisao", async () => {
    const { tenantId, userId } = await provisionTenant("trigger");
    const cookie = await cookieFor(tenantId, userId);
    const created = await putFlow(cookie, "cas-trigger", { nome: "CAS Trigger", ativo: false, definition: { ...baseDefinition, triggers: { ctwa: true, session_ids: [], keywords: [] } }, revisao_base: 0 });
    expect(created.statusCode).toBe(201);

    const detail = await app.inject({ method: "GET", url: "/qualification/flows/cas-trigger", headers: { cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().flow.revisao).toBe(1);

    const renamed = await patchFlow(cookie, "cas-trigger", { nome: "CAS Trigger 2", revisao_base: 1 });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().flow.revisao).toBe(2);

    const activated = await patchFlow(cookie, "cas-trigger", { ativo: true, revisao_base: 2 });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().flow.revisao).toBe(3);
    expect(activated.json().flow.ativo).toBe(true);

    // Prova direta do trigger: mesmo um SET revision=999 vira OLD+1 (3→4).
    const forced = await pool.query<{ revision: number }>(
      "UPDATE qualification_flows SET revision=999,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING revision", [tenantId, "cas-trigger"]
    );
    expect(forced.rows[0].revision).toBe(4);
  });

  it("(c) revisao_base stale → 409 FLOW_VERSION_CONFLICT sem gravar nada (definition, revision e snapshots intactos)", async () => {
    const { tenantId, userId } = await provisionTenant("stale");
    const cookie = await cookieFor(tenantId, userId);
    await putFlow(cookie, "cas-stale", { nome: "CAS Stale", definition: baseDefinition, revisao_base: 0 });
    const before = (await flowRow(tenantId, "cas-stale"))!;
    const snapshotsBefore = await snapshotCount(tenantId, "cas-stale");

    const stale = await putFlow(cookie, "cas-stale", { nome: "CAS Stale HACKED", definition: raceDefinitions.finalize, revisao_base: 99 });
    expect(stale.statusCode).toBe(409);
    expectConflict(stale.json(), before.revision);

    const after = (await flowRow(tenantId, "cas-stale"))!;
    expect(after.name).toBe(before.name); // nome NÃO foi gravado
    expect(after.revision).toBe(before.revision);
    expect(after.definition).toEqual(before.definition); // definition NÃO foi gravada
    expect(await snapshotCount(tenantId, "cas-stale")).toBe(snapshotsBefore); // sem snapshot fantasma
  });

  it("(d) restore com revisao_base correto bumpa a revisão e cria snapshot novo; restore stale → 409 sem snapshot", async () => {
    const { tenantId, userId } = await provisionTenant("restore");
    const cookie = await cookieFor(tenantId, userId);
    await putFlow(cookie, "cas-restore", { nome: "CAS Restore", definition: baseDefinition, revisao_base: 0 });
    await putFlow(cookie, "cas-restore", { nome: "CAS Restore", definition: raceDefinitions.delay, revisao_base: 1 });
    expect((await flowRow(tenantId, "cas-restore"))!.revision).toBe(2);
    const versions = (await app.inject({ method: "GET", url: "/qualification/flows/cas-restore/versions", headers: { cookie } })).json().versions as Array<{ id: string; version: number }>;
    expect(versions).toHaveLength(2);

    const restored = await app.inject({
      method: "POST", url: `/qualification/flows/cas-restore/versions/${versions[1].id}/restore`,
      headers: { cookie }, payload: { revisao_base: await currentRevision(tenantId, "cas-restore") }
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().flow.revisao).toBe(3); // trigger bumpa no restore
    expect(restored.json()).toMatchObject({ restored_from: 1, version: 3 });
    expect(restored.json().flow.definition.steps.M1.message).toBe("cas msg"); // definition da v1 de volta

    // Restore com token agora stale: 409 e NENHUM snapshot extra.
    const staleRestore = await app.inject({
      method: "POST", url: `/qualification/flows/cas-restore/versions/${versions[0].id}/restore`,
      headers: { cookie }, payload: { revisao_base: 2 }
    });
    expect(staleRestore.statusCode).toBe(409);
    expectConflict(staleRestore.json(), 3);
    expect(await snapshotCount(tenantId, "cas-restore")).toBe(3);
  });

  it("(e) criação com revisao_base≠0 → 409 (revisao 0, nada gravado); revisao_base=0 em fluxo existente → 409", async () => {
    const { tenantId, userId } = await provisionTenant("creation");
    const cookie = await cookieFor(tenantId, userId);

    const wrongToken = await putFlow(cookie, "cas-novo", { nome: "CAS Novo", definition: baseDefinition, revisao_base: 5 });
    expect(wrongToken.statusCode).toBe(409);
    expectConflict(wrongToken.json(), 0); // fluxo não existe: revisão corrente 0
    expect(await flowRow(tenantId, "cas-novo")).toBeUndefined(); // nada foi criado

    await putFlow(cookie, "cas-novo", { nome: "CAS Novo", definition: baseDefinition, revisao_base: 0 });
    const zeroOnExisting = await putFlow(cookie, "cas-novo", { nome: "CAS Novo 2", definition: raceDefinitions.delay, revisao_base: 0 });
    expect(zeroOnExisting.statusCode).toBe(409);
    expectConflict(zeroOnExisting.json(), 1); // existente: revisão corrente 1
    expect((await flowRow(tenantId, "cas-novo"))!.name).toBe("CAS Novo"); // sobrescrita por 0 bloqueada
  });

  it("(f) isolamento multi-tenant: lock/409 não vazam entre tenants com o mesmo flow_id", async () => {
    const a = await provisionTenant("iso-a");
    const b = await provisionTenant("iso-b");
    const cookieA = await cookieFor(a.tenantId, a.userId);
    const cookieB = await cookieFor(b.tenantId, b.userId);

    // Mesmo id de fluxo nos dois tenants, ambos nascem com revision 1.
    expect((await putFlow(cookieA, "cas-iso", { nome: "ISO A", definition: baseDefinition, revisao_base: 0 })).statusCode).toBe(201);
    expect((await putFlow(cookieB, "cas-iso", { nome: "ISO B", definition: baseDefinition, revisao_base: 0 })).statusCode).toBe(201);

    // B avança; A continua na revisão 1 e AINDA assim salva com o próprio token —
    // o estado (e o 409) de B não contamina A.
    expect((await putFlow(cookieB, "cas-iso", { nome: "ISO B v2", revisao_base: 1 })).statusCode).toBe(200);
    expect((await putFlow(cookieA, "cas-iso", { nome: "ISO A v2", revisao_base: 1 })).statusCode).toBe(200);

    // Token stale em B reporta a revisão de B, não a de A.
    const staleB = await putFlow(cookieB, "cas-iso", { nome: "ISO B v3", revisao_base: 1 });
    expect(staleB.statusCode).toBe(409);
    expectConflict(staleB.json(), 2);
    expect((await flowRow(a.tenantId, "cas-iso"))!.name).toBe("ISO A v2");

    // Mutações simultâneas em tenants diferentes prosseguem em paralelo (locks independentes).
    const [ra, rb] = await Promise.all([
      putFlow(cookieA, "cas-iso", { nome: "ISO A v3", revisao_base: 2 }),
      putFlow(cookieB, "cas-iso", { nome: "ISO B v3", revisao_base: 2 })
    ]);
    expect(ra.statusCode).toBe(200);
    expect(rb.statusCode).toBe(200);
    expect((await flowRow(a.tenantId, "cas-iso"))!.revision).toBe(3);
    expect((await flowRow(b.tenantId, "cas-iso"))!.revision).toBe(3);
  });

  it("(g) matriz B7: 5 mutações de tipos diferentes na mesma base — exatamente 1 vence, revision contígua, ≤1 snapshot novo", async () => {
    const { tenantId, userId } = await provisionTenant("b7");
    const cookie = await cookieFor(tenantId, userId);
    await putFlow(cookie, "cas-b7", { nome: "CAS B7", definition: baseDefinition, revisao_base: 0 });
    const versions = (await app.inject({ method: "GET", url: "/qualification/flows/cas-b7/versions", headers: { cookie } })).json().versions as Array<{ id: string }>;
    const roleId = (await pool.query<{ id: string }>(
      "INSERT INTO workspace_roles(workspace_id,name) VALUES($1,$2) RETURNING id", [tenantId, `CAS B7 ROLE ${randomUUID()}`]
    )).rows[0].id;

    const mutations: Array<() => ReturnType<typeof putFlow>> = [
      () => putFlow(cookie, "cas-b7", { nome: "CAS B7", definition: raceDefinitions.branch, revisao_base: 1 }), // PUT definition
      () => putFlow(cookie, "cas-b7", { nome: "CAS B7 renomeado", revisao_base: 1 }), // PUT nome-only
      () => patchFlow(cookie, "cas-b7", { allowed_role_ids: [roleId], revisao_base: 1 }), // PATCH roles
      () => patchFlow(cookie, "cas-b7", { nome: "CAS B7 patch", revisao_base: 1 }), // PATCH nome
      () => app.inject({ method: "POST", url: `/qualification/flows/cas-b7/versions/${versions[0].id}/restore`, headers: { cookie }, payload: { revisao_base: 1 } }) // restore
    ];
    const results = await Promise.all(mutations.map((run) => run()));

    const winners = results.filter((result) => result.statusCode === 200);
    const losers = results.filter((result) => result.statusCode === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(4);
    for (const loser of losers) expectConflict(loser.json(), 2);

    const row = (await flowRow(tenantId, "cas-b7"))!;
    expect(row.revision).toBe(2); // contígua — exatamente um incremento
    // Zero snapshot fantasma: 1 da criação + no máximo 1 do vencedor (PUT definition ou restore).
    expect(await snapshotCount(tenantId, "cas-b7")).toBeLessThanOrEqual(2);
  });
});
