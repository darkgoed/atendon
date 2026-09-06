import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { QualificationService } from "../src/modules/qualification/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const service = new QualificationService();
let tenantId = "";
let sessionId = "";

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id",
    [`Attribution ${randomUUID()}`, `tenant-attribution-${randomUUID().slice(0, 8)}`]
  )).rows[0].id;
  sessionId = (await pool.query<{ id: string }>(
    "INSERT INTO whatsapp_sessions(id,tenant_id,status) VALUES($1,$2,'connected') RETURNING id",
    [randomUUID(), tenantId]
  )).rows[0].id;
  await pool.query(
    `INSERT INTO qualification_flows(id,tenant_id,name,definition,active)
     VALUES($1,$2,'Integration attribution',$3,true)`,
    [randomUUID(), tenantId, {
      start: "intro",
      origem: "facebook",
      triggers: { ctwa: true, session_ids: [], keywords: [] },
      steps: { intro: { kind: "text", question: "Qual seu nome?", next: "final" }, final: { kind: "final", message: "Obrigado" } }
    }]
  );
});

afterAll(async () => {
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.end();
});

describe("qualification attribution", () => {
  it("persiste o slug do tenant como produto, sem literal de empresa", async () => {
    const phone = `5511${Date.now().toString().slice(-8)}`;
    await service.handleInbound({
      tenantId,
      sessionId,
      contactPhone: phone,
      text: "Anúncio",
      externalId: randomUUID(),
      referral: { sourceType: "ad", sourceId: "integration-ad" }
    });

    const result = await pool.query<{ product: string }>(
      `SELECT attribution->>'product' AS product
       FROM lead_qualifications q
       JOIN scheduling_leads l ON l.id=q.lead_id
       WHERE q.tenant_id=$1 AND l.phone=$2`,
      [tenantId, phone]
    );
    const tenant = await pool.query<{ slug: string }>("SELECT slug FROM tenants WHERE id=$1", [tenantId]);
    expect(result.rows[0]?.product).toBe(tenant.rows[0].slug);
    expect(result.rows[0]?.product).not.toBe("newave");
  });
});
