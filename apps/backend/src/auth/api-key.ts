import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { db } from "../db/client.js";

export interface ApiTenant { tenantId: string; keyId: string }

export const API_KEY_SCOPES = [
  "scheduling.categories.read",
  "scheduling.partners.read",
  "scheduling.availability.read",
  "scheduling.leads.upsert",
  "scheduling.leads.partner_proposal",
  "scheduling.leads.status",
  "scheduling.leads.transfer",
  "scheduling.appointments.create",
  "scheduling.appointments.reschedule",
  "scheduling.appointments.cancel"
] as const;

export type ApiKeyScope = typeof API_KEY_SCOPES[number];

export const API_KEY_SCOPE_DESCRIPTIONS: Record<ApiKeyScope, string> = {
  "scheduling.categories.read": "Consultar categorias",
  "scheduling.partners.read": "Consultar parceiros",
  "scheduling.availability.read": "Consultar horários disponíveis",
  "scheduling.leads.upsert": "Criar ou atualizar leads",
  "scheduling.leads.partner_proposal": "Enviar proposta de parceiro",
  "scheduling.leads.status": "Alterar status de leads",
  "scheduling.leads.transfer": "Transferir leads",
  "scheduling.appointments.create": "Criar agendamentos",
  "scheduling.appointments.reschedule": "Reagendar atendimentos",
  "scheduling.appointments.cancel": "Cancelar agendamentos"
};

export function hashApiKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function requireApiTenant(request: FastifyRequest, requiredScope: ApiKeyScope): Promise<ApiTenant> {
  const raw = request.headers["x-api-key"] ?? request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (typeof raw !== "string" || raw.length < 16) {
    throw Object.assign(new Error("API key ausente ou inválida"), { statusCode: 401 });
  }
  const digest = hashApiKey(raw);
  const result = await db.query<{
    id: string;
    tenant_id: string;
    key_hash: string;
    active: boolean;
    scopes: string[];
    expires_at: string | null;
    revoked_at: string | null;
    tenant_status: string;
  }>(
    `SELECT k.id,k.tenant_id,k.key_hash,k.active,k.scopes,k.expires_at,k.revoked_at,t.status tenant_status
     FROM tenant_api_keys k
     JOIN tenants t ON t.id=k.tenant_id
     WHERE k.key_hash=$1`,
    [digest]
  );
  const key = result.rows[0];
  const expired = key?.expires_at ? new Date(key.expires_at).getTime() <= Date.now() : false;
  if (!key || !timingSafeEqual(Buffer.from(key.key_hash), Buffer.from(digest)) || !key.active || key.revoked_at || expired || key.tenant_status === "suspended") {
    throw Object.assign(new Error("API key inválida"), { statusCode: 401 });
  }
  if (!key.scopes.includes(requiredScope)) {
    throw Object.assign(new Error(`API key sem o scope necessário: ${requiredScope}`), { statusCode: 403 });
  }
  void db.query("UPDATE tenant_api_keys SET last_used_at=now() WHERE id=$1", [key.id]).catch(() => undefined);
  return { tenantId: key.tenant_id, keyId: key.id };
}
