import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
let tenantId: string;

beforeAll(async () => {
  const tenant = await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
    [`Multi ${randomUUID()}`, `multi-${randomUUID().slice(0, 8)}`]
  );
  tenantId = tenant.rows[0].id;
});

afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.end();
});

describe("whatsapp_sessions multi-conexão", () => {
  it("aceita várias conexões por tenant com rótulo e arquivamento", async () => {
    const first = await pool.query<{ id: string; is_primary: boolean }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label,is_primary) VALUES($1,'Comercial',true) RETURNING id,is_primary",
      [tenantId]
    );
    const second = await pool.query<{ id: string; is_primary: boolean }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label) VALUES($1,'Suporte') RETURNING id,is_primary",
      [tenantId]
    );
    expect(first.rows[0].is_primary).toBe(true);
    expect(second.rows[0].is_primary).toBe(false);
  });

  it("impede duas conexões primárias ativas no mesmo tenant", async () => {
    await expect(pool.query(
      "INSERT INTO whatsapp_sessions(tenant_id,label,is_primary) VALUES($1,'Duplicada',true)",
      [tenantId]
    )).rejects.toThrow(/uq_whatsapp_sessions_primary|duplicate key/i);
  });

  it("libera a primária quando a anterior é arquivada", async () => {
    await pool.query("UPDATE whatsapp_sessions SET archived_at=now(),is_primary=false WHERE tenant_id=$1 AND label='Comercial'", [tenantId]);
    const promoted = await pool.query(
      "UPDATE whatsapp_sessions SET is_primary=true WHERE tenant_id=$1 AND label='Suporte' RETURNING id",
      [tenantId]
    );
    expect(promoted.rowCount).toBe(1);
  });
});

describe("conversations escopadas por conexão", () => {
  it("permite o mesmo contato em duas conexões e bloqueia duplicata na mesma conexão", async () => {
    const phone = `551199${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
    const sessions = await pool.query<{ id: string }>(
      "SELECT id FROM whatsapp_sessions WHERE tenant_id=$1 ORDER BY created_at LIMIT 2",
      [tenantId]
    );
    const [a, b] = sessions.rows;
    await pool.query("INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3)", [tenantId, a.id, phone]);
    await pool.query("INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3)", [tenantId, b.id, phone]);
    await expect(pool.query(
      "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3)",
      [tenantId, a.id, phone]
    )).rejects.toThrow(/uq_conversations_session_phone|duplicate key/i);
    const linked = await pool.query<{ lead_id: string }>(
      "SELECT DISTINCT lead_id FROM conversations WHERE tenant_id=$1 AND contact_phone=$2",
      [tenantId, phone]
    );
    expect(linked.rowCount).toBe(1);
  });

  it("recusa conversa sem conexão", async () => {
    await expect(pool.query(
      "INSERT INTO conversations(tenant_id,contact_phone) VALUES($1,'5511988887777')",
      [tenantId]
    )).rejects.toThrow(/null value in column "session_id"/i);
  });
});
