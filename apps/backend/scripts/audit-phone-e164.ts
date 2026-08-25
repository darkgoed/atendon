import pg from "pg";
import { config } from "../src/config.js";
import { normalizePhoneE164 } from "../src/phone.js";

type Row = { tenant_id: string; id: string; source: string; phone: string };
const client = new pg.Client({ connectionString: config.DATABASE_URL });

try {
  await client.connect();
  const result = await client.query<Row>(
    `SELECT tenant_id,id,'scheduling_leads' source,phone FROM scheduling_leads
     UNION ALL SELECT tenant_id,id,'conversations',contact_phone FROM conversations
     UNION ALL SELECT tenant_id,id,'qualification_message_outbox',contact_phone FROM qualification_message_outbox
     UNION ALL SELECT tenant_id,id,'scheduling_meeting_contact_delivery_outbox',contact_phone
       FROM scheduling_meeting_contact_delivery_outbox`
  );
  const invalid: Array<Pick<Row, "tenant_id" | "id" | "source">> = [];
  const canonical = new Map<string, string[]>();
  for (const row of result.rows) {
    try {
      const phone = normalizePhoneE164(row.phone);
      if (row.source === "scheduling_leads" || row.source === "conversations") {
        const key = `${row.tenant_id}:${row.source}:${phone}`;
        canonical.set(key, [...(canonical.get(key) ?? []), row.id]);
      }
    } catch {
      invalid.push({ tenant_id: row.tenant_id, id: row.id, source: row.source });
    }
  }
  const collisions = [...canonical.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => {
      const [tenant_id, source] = key.split(":", 3);
      return { tenant_id, source, ids };
    });
  if (invalid.length || collisions.length) {
    console.error(JSON.stringify({ ok: false, invalid, collisions }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, checked: result.rowCount ?? result.rows.length }));
  }
} finally {
  await client.end();
}
