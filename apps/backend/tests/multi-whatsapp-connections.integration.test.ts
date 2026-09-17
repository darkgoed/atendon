import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { createSessionToken } from "../src/auth/session.js";
import { assertLimitWithinTransaction } from "../src/billing/limits.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { EvolutionClient } from "../src/modules/whatsapp/evolution-client.js";
import { WhatsAppSessionManager } from "../src/modules/whatsapp/session-manager.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const tenantIds: string[] = [];
const userIds: string[] = [];
let startSpy: { mockRestore(): void };

interface FixtureOptions {
  capabilityEnabled?: boolean;
  permissions?: string[];
  sessionCount?: number;
}

async function fixture(options: FixtureOptions = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenantId = (await client.query<{ id: string }>(
      "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
      [`Conexões ${randomUUID()}`, `connections-${randomUUID()}`]
    )).rows[0].id;
    tenantIds.push(tenantId);
    await ensureWorkspaceDefaultRoles(client, tenantId);

    const planId = (await client.query<{ id: string }>(
      "SELECT id FROM plans WHERE code='MEDIUM'"
    )).rows[0].id;
    await client.query(
      `INSERT INTO tenant_subscriptions(
         tenant_id,plan_id,status,current_period_start,current_period_end
       ) VALUES($1,$2,'ACTIVE',now(),now()+interval '1 month')`,
      [tenantId, planId]
    );
    await client.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
       VALUES($1,'workspace_admin_v1',$2)
       ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=EXCLUDED.enabled`,
      [tenantId, options.capabilityEnabled ?? true]
    );

    const email = `connections-${randomUUID()}@test.local`;
    const userId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
      [email]
    )).rows[0].id;
    userIds.push(userId);

    let roleName = "OWNER";
    if (options.permissions) {
      roleName = `CONNECTIONS-${randomUUID()}`;
      const roleId = (await client.query<{ id: string }>(
        "INSERT INTO workspace_roles(workspace_id,name) VALUES($1,$2) RETURNING id",
        [tenantId, roleName]
      )).rows[0].id;
      if (options.permissions.length) {
        await client.query(
          `INSERT INTO workspace_role_permissions(role_id,permission_key)
           SELECT $1,key FROM permissions WHERE key=ANY($2::text[])`,
          [roleId, options.permissions]
        );
      }
    }
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles
       WHERE workspace_id=$1 AND name=$3`,
      [tenantId, userId, roleName]
    );

    const sessionIds: string[] = [];
    for (let index = 0; index < (options.sessionCount ?? 1); index += 1) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO whatsapp_sessions(tenant_id,label,is_primary,status)
         VALUES($1,$2,$3,'connected') RETURNING id`,
        [tenantId, index === 0 ? "Principal" : `Secundária ${index}`, index === 0]
      );
      sessionIds.push(inserted.rows[0].id);
    }
    await client.query("COMMIT");
    const token = await createSessionToken({ userId, tenantId, email, role: roleName });
    return { tenantId, sessionIds, cookie: `atendon_session=${token}` };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  startSpy = vi.spyOn(WhatsAppSessionManager.prototype, "start").mockResolvedValue();
  await app.ready();
});

afterAll(async () => {
  startSpy.mockRestore();
  if (tenantIds.length) {
    await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenantIds]);
  }
  if (userIds.length) {
    await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
  }
  await app.close();
  await pool.end();
});

describe("API de múltiplas conexões WhatsApp", () => {
  it("cria a segunda conexão de um tenant MEDIUM", async () => {
    const context = await fixture();

    const response = await app.inject({
      method: "POST",
      url: "/connections",
      headers: { cookie: context.cookie },
      payload: { label: "Suporte" }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ connection: { label: "Suporte" } });
    const rows = await pool.query<{ label: string; is_primary: boolean }>(
      "SELECT label,is_primary FROM whatsapp_sessions WHERE tenant_id=$1 AND archived_at IS NULL ORDER BY created_at",
      [context.tenantId]
    );
    expect(rows.rows).toEqual([
      { label: "Principal", is_primary: true },
      { label: "Suporte", is_primary: false }
    ]);
  });

  it("recusa a terceira conexão no limite MEDIUM sem inserir linha", async () => {
    const context = await fixture({ sessionCount: 2 });
    const before = (await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM whatsapp_sessions WHERE tenant_id=$1",
      [context.tenantId]
    )).rows[0].count;

    const response = await app.inject({
      method: "POST",
      url: "/connections",
      headers: { cookie: context.cookie },
      payload: { label: "Financeiro" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "Você atingiu o limite de 2 conexões do WhatsApp do seu plano.",
      code: "PLAN_LIMIT_REACHED"
    });
    const after = (await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM whatsapp_sessions WHERE tenant_id=$1",
      [context.tenantId]
    )).rows[0].count;
    expect(after).toBe(before);
  });

  it("serializa criações concorrentes no limite do plano", async () => {
    // Este teste tem de falhar se a checagem de limite sair de dentro da
    // transação que insere (TOCTOU) ou se o lock FOR UPDATE de
    // tenant_subscriptions (limits.ts) deixar de serializar.
    // Duas transações reais são abertas em DUAS conexões pg distintas; a
    // checagem roda nas DUAS antes de qualquer COMMIT: a segunda só consegue
    // contar depois que o COMMIT da primeira libera o lock, e então enxerga a
    // vaga ocupada e recusa.
    const context = await fixture();
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");

      // Primeira transação: dentro do limite (1 usada de 2) e reserva a vaga.
      await assertLimitWithinTransaction(first, context.tenantId, "MAX_WHATSAPP_CONNECTIONS");
      await first.query(
        `INSERT INTO whatsapp_sessions(tenant_id,label,is_primary,channel)
         VALUES($1,'Concorrência',false,'whatsapp')`,
        [context.tenantId]
      );

      // Segunda transação: bloqueia no SELECT ... FOR UPDATE de
      // tenant_subscriptions até o COMMIT da primeira. A espera abaixo garante
      // que o SELECT da segunda chegou ao banco ANTES do COMMIT — sem ela,
      // sem o lock, a contagem poderia correr depois do COMMIT e o teste
      // deixaria de reprovar a ausência de serialização.
      const secondAssert = assertLimitWithinTransaction(second, context.tenantId, "MAX_WHATSAPP_CONNECTIONS");
      await new Promise((resolve) => setTimeout(resolve, 150));
      await first.query("COMMIT");
      await expect(secondAssert).rejects.toMatchObject({ code: "PLAN_LIMIT_REACHED" });
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it("serializa requisições sobrepostas no limite do plano", async () => {
    // Cobertura de rota para o mesmo TOCTOU: seguramos a linha de
    // tenant_subscriptions com FOR UPDATE para que as duas requisições
    // empacam no mesmo ponto e sejam liberadas juntas quando o COMMIT solta o
    // lock. Com a checagem dentro da transação da rota, quem pega o lock
    // primeiro insere e só solta no commit; o segundo então enxerga a conexão
    // nova e é recusado. Com a checagem fora, os dois contam antes de
    // qualquer insert e passam.
    const context = await fixture();
    const gate = await pool.connect();
    let responses: Array<{ statusCode: number }>;
    try {
      await gate.query("BEGIN");
      await gate.query("SELECT id FROM tenant_subscriptions WHERE tenant_id=$1 FOR UPDATE", [context.tenantId]);

      const inflight = Promise.all(["Comercial", "Suporte"].map((label) => app.inject({
        method: "POST",
        url: "/connections",
        headers: { cookie: context.cookie },
        payload: { label }
      })));
      // Tempo suficiente para as duas requisições chegarem ao lock e pararem lá.
      await new Promise((resolve) => setTimeout(resolve, 400));
      await gate.query("COMMIT");
      responses = await inflight;
    } finally {
      await gate.query("ROLLBACK").catch(() => undefined);
      gate.release();
    }
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const count = (await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM whatsapp_sessions WHERE tenant_id=$1 AND archived_at IS NULL",
      [context.tenantId]
    )).rows[0].count;
    expect(count).toBe(2);
  });

  it("libera vaga no plano quando uma conexão é arquivada", async () => {
    // Regressão: o painel conta conexões ativas (listByTenant filtra arquivadas)
    // enquanto o limite contava TODAS as linhas. O usuário via "1 de 2" com o
    // botão habilitado, clicava e recebia 409 — arquivar nunca liberava vaga.
    const context = await fixture({ sessionCount: 2 });
    await pool.query(
      `UPDATE whatsapp_sessions SET archived_at=now(),is_primary=false,status='disconnected'
       WHERE tenant_id=$1 AND is_primary=false`,
      [context.tenantId]
    );

    const response = await app.inject({
      method: "POST",
      url: "/connections",
      headers: { cookie: context.cookie },
      payload: { label: "Nova após arquivar" }
    });

    expect(response.statusCode).toBe(201);
    const active = (await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM whatsapp_sessions WHERE tenant_id=$1 AND archived_at IS NULL",
      [context.tenantId]
    )).rows[0].count;
    expect(active).toBe(2);
  });

  it("nega criação sem connection.manage", async () => {
    const context = await fixture({ permissions: ["connection.read"] });

    const response = await app.inject({
      method: "POST",
      url: "/connections",
      headers: { cookie: context.cookie },
      payload: { label: "Sem permissão" }
    });

    expect(response.statusCode).toBe(403);
    expect((await pool.query<{ count: number }>(
      "SELECT count(*)::int count FROM whatsapp_sessions WHERE tenant_id=$1",
      [context.tenantId]
    )).rows[0].count).toBe(1);
  });

  it("aplica workspace_admin_v1 às novas rotas", async () => {
    const context = await fixture({ capabilityEnabled: false });

    const response = await app.inject({
      method: "GET",
      url: "/connections",
      headers: { cookie: context.cookie }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "FEATURE_FLAG_DISABLED",
      feature: "workspace_admin_v1"
    });
  });

  it("lista conexões ativas e o limite efetivo do plano", async () => {
    const context = await fixture({ sessionCount: 2 });

    const response = await app.inject({
      method: "GET",
      url: "/connections",
      headers: { cookie: context.cookie }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      limits: { used: 2, max: 2 },
      connections: [
        { id: context.sessionIds[0], label: "Principal", is_primary: true, status: "connected" },
        { id: context.sessionIds[1], label: "Secundária 1", is_primary: false, status: "connected" }
      ]
    });
  });

  it("promove uma conexão própria depois de rebaixar a primária", async () => {
    const context = await fixture({ sessionCount: 2 });

    const response = await app.inject({
      method: "PATCH",
      url: `/connections/${context.sessionIds[1]}`,
      headers: { cookie: context.cookie },
      payload: { label: "Suporte prioritário", is_primary: true }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      connection: { id: context.sessionIds[1], label: "Suporte prioritário", is_primary: true }
    });
    const rows = await pool.query<{ id: string; is_primary: boolean }>(
      "SELECT id,is_primary FROM whatsapp_sessions WHERE tenant_id=$1 ORDER BY id",
      [context.tenantId]
    );
    expect(rows.rows.filter((row) => row.is_primary)).toEqual([
      { id: context.sessionIds[1], is_primary: true }
    ]);
  });

  it("rejeita atualização sem rótulo nem promoção", async () => {
    const context = await fixture();

    const response = await app.inject({
      method: "PATCH",
      url: `/connections/${context.sessionIds[0]}`,
      headers: { cookie: context.cookie },
      payload: {}
    });

    expect(response.statusCode).toBe(400);
  });

  it("responde 404 ao tentar promover conexão de outro tenant sem rebaixar a atual", async () => {
    const own = await fixture();
    const foreign = await fixture();

    const response = await app.inject({
      method: "PATCH",
      url: `/connections/${foreign.sessionIds[0]}`,
      headers: { cookie: own.cookie },
      payload: { is_primary: true }
    });

    expect(response.statusCode).toBe(404);
    expect((await pool.query<{ is_primary: boolean }>(
      "SELECT is_primary FROM whatsapp_sessions WHERE id=$1",
      [own.sessionIds[0]]
    )).rows[0].is_primary).toBe(true);
  });

  it("reconecta somente uma conexão ativa do próprio tenant", async () => {
    const own = await fixture();
    const foreign = await fixture();
    const reconnect = vi.spyOn(WhatsAppSessionManager.prototype, "reconnect").mockResolvedValue();
    try {
      const accepted = await app.inject({
        method: "POST",
        url: `/connections/${own.sessionIds[0]}/reconnect`,
        headers: { cookie: own.cookie }
      });
      const hidden = await app.inject({
        method: "POST",
        url: `/connections/${foreign.sessionIds[0]}/reconnect`,
        headers: { cookie: own.cookie }
      });

      expect(accepted.statusCode).toBe(202);
      expect(hidden.statusCode).toBe(404);
      expect(reconnect).toHaveBeenCalledOnce();
      expect(reconnect).toHaveBeenCalledWith(own.sessionIds[0]);
    } finally {
      reconnect.mockRestore();
    }
  });

  it("recusa arquivar a última conexão ativa", async () => {
    const context = await fixture();

    const response = await app.inject({
      method: "DELETE",
      url: `/connections/${context.sessionIds[0]}`,
      headers: { cookie: context.cookie }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Mantenha ao menos uma conexão de WhatsApp" });
    expect((await pool.query<{ archived_at: Date | null }>(
      "SELECT archived_at FROM whatsapp_sessions WHERE id=$1",
      [context.sessionIds[0]]
    )).rows[0].archived_at).toBeNull();
  });

  it("recusa arquivar a primária enquanto houver outra conexão", async () => {
    const context = await fixture({ sessionCount: 2 });

    const response = await app.inject({
      method: "DELETE",
      url: `/connections/${context.sessionIds[0]}`,
      headers: { cookie: context.cookie }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Promova outra conexão a principal antes de remover esta" });
    expect((await pool.query<{ archived_at: Date | null }>(
      "SELECT archived_at FROM whatsapp_sessions WHERE id=$1",
      [context.sessionIds[0]]
    )).rows[0].archived_at).toBeNull();
  });

  it("mantém a secundária arquivada quando a exclusão na Evolution falha", async () => {
    const context = await fixture({ sessionCount: 2 });
    const prototype = EvolutionClient.prototype as EvolutionClient & {
      deleteInstance(instanceName: string): Promise<void>;
    };
    const original = Object.getOwnPropertyDescriptor(EvolutionClient.prototype, "deleteInstance");
    const deleteInstance = vi.fn().mockRejectedValue(new Error("Evolution indisponível"));
    Object.defineProperty(prototype, "deleteInstance", { configurable: true, value: deleteInstance });
    const logout = vi.spyOn(EvolutionClient.prototype, "logout").mockResolvedValue();
    try {
      const response = await app.inject({
        method: "DELETE",
        url: `/connections/${context.sessionIds[1]}`,
        headers: { cookie: context.cookie }
      });

      expect(response.statusCode).toBe(200);
      expect(deleteInstance).toHaveBeenCalledOnce();
      expect(logout).toHaveBeenCalledOnce();
      expect((await pool.query<{
        archived_at: Date | null;
        is_primary: boolean;
        status: string;
      }>(
        "SELECT archived_at,is_primary,status FROM whatsapp_sessions WHERE id=$1",
        [context.sessionIds[1]]
      )).rows[0]).toMatchObject({
        archived_at: expect.any(Date),
        is_primary: false,
        status: "disconnected"
      });
    } finally {
      logout.mockRestore();
      if (original) Object.defineProperty(EvolutionClient.prototype, "deleteInstance", original);
      else delete (prototype as unknown as Record<string, unknown>).deleteInstance;
    }
  });

  it("mantém as rotas legadas apontadas para a conexão primária", async () => {
    const context = await fixture({ sessionCount: 2 });
    await pool.query(
      `UPDATE whatsapp_sessions SET created_at=CASE id
         WHEN $1 THEN '2020-01-01T00:00:00Z'::timestamptz
         ELSE '2021-01-01T00:00:00Z'::timestamptz END
       WHERE tenant_id=$2`,
      [context.sessionIds[0], context.tenantId]
    );
    const reconnect = vi.spyOn(WhatsAppSessionManager.prototype, "reconnect").mockResolvedValue();
    try {
      const listed = await app.inject({
        method: "GET",
        url: "/connection",
        headers: { cookie: context.cookie }
      });
      const accepted = await app.inject({
        method: "POST",
        url: "/connection/reconnect",
        headers: { cookie: context.cookie }
      });

      expect(listed.statusCode).toBe(200);
      expect(listed.json().connection.id).toBe(context.sessionIds[0]);
      expect(accepted.statusCode).toBe(202);
      expect(reconnect).toHaveBeenCalledWith(context.sessionIds[0]);
    } finally {
      reconnect.mockRestore();
    }
  });
});
