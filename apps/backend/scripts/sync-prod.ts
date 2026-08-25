// Sincroniza produção: agent_configs.system_prompt <- instrução-ia.md e garante o parceiro Newave.
// Uso: npx tsx scripts/sync-prod.ts   (com TENANT_ID=<uuid> se houver mais de um tenant ativo)
import { readFileSync } from "node:fs";
import { db } from "../src/db/client.js";

const NEWAVE_LINK = "https://sistema.newavepay.com/proposta-cliente/592a8187-f278-4b85-b180-23bfd09512b7";

async function main() {
  const prompt = readFileSync(new URL("../../../instrução-ia.md", import.meta.url), "utf8");

  const tenants = await db.query<{ tenant_id: string }>("SELECT DISTINCT tenant_id FROM agent_configs WHERE is_active");
  const target = process.env.TENANT_ID ?? (tenants.rows.length === 1 ? tenants.rows[0].tenant_id : null);
  if (!target) {
    console.error("Mais de um tenant ativo — rode com TENANT_ID=<uuid>. Tenants:", tenants.rows.map((r) => r.tenant_id));
    process.exit(1);
  }

  const updated = await db.query(
    "UPDATE agent_configs SET system_prompt=$1, updated_at=now() WHERE tenant_id=$2 AND is_active",
    [prompt, target]
  );
  console.log(`agent_configs atualizados para tenant ${target}: ${updated.rowCount}`);

  await db.query(
    `INSERT INTO scheduling_partners (tenant_id, id, name, priority_order, proposal_link, active)
     VALUES ($1, 'newave', 'Newave', COALESCE((SELECT max(priority_order) FROM scheduling_partners WHERE tenant_id=$1), 0) + 1, $2, true)
     ON CONFLICT (tenant_id, id) DO UPDATE SET proposal_link=EXCLUDED.proposal_link, active=true, updated_at=now()`,
    [target, NEWAVE_LINK]
  );
  console.log("parceiro newave garantido em scheduling_partners");

  await db.end();
}

main().catch((error) => { console.error(error); process.exit(1); });
