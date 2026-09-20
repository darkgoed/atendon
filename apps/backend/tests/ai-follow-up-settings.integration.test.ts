import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const password = "follow-up-root-password";
const rootEmail = `follow-up-root-${randomUUID()}@test.local`;
let tenantId: string;
let rootCookie: string;

beforeAll(async () => {
  await app.ready();
  const tenant = await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",
    [`Follow-up settings ${randomUUID()}`]
  );
  tenantId = tenant.rows[0].id;
  await pool.query(
    "INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',true)",
    [rootEmail, await hash(password, 4)]
  );
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: rootEmail, password } });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers["set-cookie"]!;
  const loginCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
  const access = await app.inject({
    method: "POST",
    url: `/root/workspaces/${tenantId}/access`,
    headers: { cookie: loginCookie }
  });
  expect(access.statusCode).toBe(200);
  const accessCookie = access.headers["set-cookie"]!;
  rootCookie = (Array.isArray(accessCookie) ? accessCookie[0] : accessCookie).split(";")[0];
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id=(SELECT id FROM users WHERE email=$1)", [rootEmail]);
  await pool.query("DELETE FROM users WHERE email=$1", [rootEmail]);
  await pool.end();
  await app.close();
});

describe("AI follow-up settings API", () => {
  // NOTA (auditoria 2026-09): os testes de GET /agent/quality/summary e
  // PUT /agent/evaluator-settings foram REMOVIDOS — os endpoints nunca foram
  // portados (grep em src/* não encontra as rotas; nenhum cliente do painel
  // as consome). Se o avaliador de qualidade da IA for portado um dia,
  // recriar os testes junto com as rotas.

  it("validates, persists and audits the workspace cadence", async () => {
    const initial = await app.inject({ url: "/ai-follow-ups/settings", headers: { cookie: rootCookie } });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().settings).toEqual({
      enabled: false,
      delaysMinutes: [120, 1440, 4320],
      delivery: [{ type: "text" }, { type: "text" }, { type: "text" }],
      maxCount: 3,
      intervalMinutes: 120
    });

    const invalid = await app.inject({
      method: "PUT",
      url: "/ai-follow-ups/settings",
      headers: { cookie: rootCookie },
      payload: { enabled: true, maxCount: 11, intervalMinutes: 0 }
    });
    expect(invalid.statusCode).toBe(400);

    const updated = await app.inject({
      method: "PUT",
      url: "/ai-follow-ups/settings",
      headers: { cookie: rootCookie },
      payload: { enabled: true, delaysMinutes: [120, 1440, 4320] }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().settings).toEqual({
      enabled: true,
      delaysMinutes: [120, 1440, 4320],
      delivery: [{ type: "text" }, { type: "text" }, { type: "text" }]
    });

    const persisted = await pool.query(
      `SELECT ai_follow_up_enabled,ai_follow_up_max_count,ai_follow_up_interval_minutes,
              ai_follow_up_delays_minutes
       FROM tenant_ai_settings WHERE tenant_id=$1`,
      [tenantId]
    );
    expect(persisted.rows[0]).toEqual({
      ai_follow_up_enabled: true,
      ai_follow_up_max_count: 3,
      ai_follow_up_interval_minutes: 120,
      ai_follow_up_delays_minutes: [120, 1440, 4320]
    });
    const audit = await pool.query<{ count: number }>(
      `SELECT count(*)::int count FROM audit_logs
       WHERE workspace_id=$1 AND action='agent.follow_up.settings.update'`,
      [tenantId]
    );
    expect(audit.rows[0].count).toBe(1);

    const legacy = await app.inject({
      method: "PUT",
      url: "/ai-follow-ups/settings",
      headers: { cookie: rootCookie },
      payload: { enabled: true, maxCount: 2, intervalMinutes: 180 }
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().settings).toEqual({
      enabled: true,
      delaysMinutes: [180, 360],
      delivery: [{ type: "text" }, { type: "text" }]
    });
  });

  it("uploads a case image and associates it with a text-captioned attempt", async () => {
    const uploaded = await app.inject({
      method: "POST",
      url: "/ai-follow-ups/media",
      headers: { cookie: rootCookie },
      payload: {
        name: "Case Newave — 14 dias",
        description: "Resultados de vendas do cliente Newave nos primeiros 14 dias.",
        mimeType: "image/png",
        fileName: "case-newave.png",
        dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")
      }
    });
    expect(uploaded.statusCode).toBe(201);
    const mediaId = uploaded.json().media.id as string;

    const content = await app.inject({
      url: `/ai-follow-ups/media/${mediaId}/content`,
      headers: { cookie: rootCookie }
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toContain("image/png");

    const configured = await app.inject({
      method: "PUT",
      url: "/ai-follow-ups/settings",
      headers: { cookie: rootCookie },
      payload: {
        enabled: true,
        delaysMinutes: [120],
        delivery: [{ type: "image", assetId: mediaId }]
      }
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json().settings.delivery).toEqual([{ type: "image", assetId: mediaId }]);

    const inUse = await app.inject({
      method: "DELETE",
      url: `/ai-follow-ups/media/${mediaId}`,
      headers: { cookie: rootCookie }
    });
    expect(inUse.statusCode).toBe(409);

    await app.inject({
      method: "PUT",
      url: "/ai-follow-ups/settings",
      headers: { cookie: rootCookie },
      payload: { enabled: true, delaysMinutes: [120], delivery: [{ type: "text" }] }
    });
    const removed = await app.inject({
      method: "DELETE",
      url: `/ai-follow-ups/media/${mediaId}`,
      headers: { cookie: rootCookie }
    });
    expect(removed.statusCode).toBe(204);
  });
});
