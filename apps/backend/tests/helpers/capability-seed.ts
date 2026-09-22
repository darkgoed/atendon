// Seed de capabilities para suítes de integração que criam tenants via INSERT
// SQL direto — espelha o provisionamento do fluxo ROOT
// (src/modules/root/routes.ts:330-348): override por tenant vence
// default_enabled=false da migração 0118 e destrava o gate de capabilities
// (senão: 409 FEATURE_FLAG_DISABLED determinístico).
//
// Só assinaturas `all_tenants` — nunca provisiona tenant_capability_support,
// então tripz_ai_v1 (supported_tenants) permanece desligado.
import type { Pool, PoolClient } from "pg";

export const DEFAULT_SEEDED_CAPABILITIES = [
  "dashboard_v1",
  "leads_v1",
  "pipeline_v1",
  "appointments_v1",
  "post_sales_v1",
  "workspace_admin_v1"
] as const;

export async function seedTenantCapabilities(
  client: Pool | PoolClient,
  tenantIds: readonly string[],
  keys: readonly string[] = DEFAULT_SEEDED_CAPABILITIES
): Promise<void> {
  if (tenantIds.length === 0 || keys.length === 0) return;
  await client.query(
    `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
     SELECT t.id,k.flag_key,true
     FROM unnest($1::uuid[]) AS t(id)
     CROSS JOIN unnest($2::text[]) AS k(flag_key)
     ON CONFLICT (tenant_id,flag_key) DO UPDATE SET
       enabled=EXCLUDED.enabled,
       updated_at=now()`,
    [[...tenantIds], [...keys]]
  );
}
