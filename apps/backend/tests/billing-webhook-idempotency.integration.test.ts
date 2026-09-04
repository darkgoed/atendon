import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const tenantIds: string[] = [];
afterAll(async () => { if (tenantIds.length) await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [tenantIds]); await pool.end(); });

describe("billing webhook idempotency", () => {
  it("rejects the duplicate event identity at the database boundary", async () => {
    const tenant = (await pool.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`webhook-${randomUUID()}`, `webhook-${randomUUID()}`])).rows[0].id;
    tenantIds.push(tenant);
    const provider = (await pool.query<{ id: string }>("INSERT INTO billing_providers(code,name,environment) VALUES($1,'Test provider','sandbox') RETURNING id", [`test-${randomUUID()}`])).rows[0].id;
    const invoice = (await pool.query<{ id: string }>("INSERT INTO invoices(tenant_id,provider_id,kind,amount_cents,status) VALUES($1,$2,'subscription',1000,'pending') RETURNING id", [tenant, provider])).rows[0].id;
    expect(invoice).toBeTruthy();
    const eventId = `payment-approved-${randomUUID()}`;
    const payload = { event: eventId, type: "payment.approved", invoice_id: invoice };
    await pool.query("INSERT INTO billing_events(provider_id,external_event_id,event_type,payload,signature_valid,tenant_id,processed_at) VALUES($1,$2,'payment.approved',$3,true,$4,now())", [provider, eventId, payload, tenant]);
    const duplicate = await pool.query("INSERT INTO billing_events(provider_id,external_event_id,event_type,payload,signature_valid,tenant_id) VALUES($1,$2,'payment.approved',$3,true,$4)", [provider, eventId, payload, tenant]).catch(e => e);
    expect(duplicate).toMatchObject({ code: "23505" });
    expect((await pool.query("SELECT count(*)::int AS n FROM billing_events WHERE provider_id=$1 AND external_event_id=$2", [provider, eventId])).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1", [invoice])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT status,paid_at FROM invoices WHERE id=$1", [invoice])).rows[0]).toMatchObject({ status: "pending", paid_at: null });
  });
});
