import { PoolClient } from "pg";
import { z } from "zod";
import { db } from "../../db/client.js";
import { httpError, withTransaction } from "../scheduling/service.js";
import type { WorkspaceSession } from "../../auth/session.js";

// Campos personalizados de contato (migration 0170; R7 e contrato
// "Campos personalizados"). O catálogo fica por workspace; valores do lead
// em JSONB tipado pelo type do campo.

export const fieldType = z.enum(["text", "number", "currency", "date", "select", "multiselect", "boolean"]);

export const customFieldCreateSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9_]+$/, "key deve conter apenas letras minúsculas, números e _").max(64).optional(),
  label: z.string().trim().min(1).max(200),
  type: fieldType,
  options: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  required: z.boolean().optional()
}).strict();

export const customFieldUpdateSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  options: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  required: z.boolean().optional()
}).strict();

export const leadCustomValueSchema = z.object({
  field_id: z.string().uuid(),
  value: z.unknown()
}).strict();

export type CustomFieldDefRow = {
  id: string;
  tenant_id: string;
  entity: string;
  key: string;
  label: string;
  type: string;
  options: string[] | null;
  required: boolean;
  created_at: Date;
};

function mapField(row: CustomFieldDefRow) {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    type: row.type,
    options: row.options ?? [],
    required: row.required,
    created_at: row.created_at
  };
}

async function insertFieldAudit(client: PoolClient, tenantId: string, fieldId: string, actor: { userId: string; actorScope: string; ipAddress?: string; userAgent?: string }, action: string, metadata: Record<string, unknown>) {
  await client.query(
    `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
     VALUES($1,$2,$3,$4,'custom_field',$5,$6,$7,$8)`,
    [actor.userId, tenantId, actor.actorScope, action, fieldId, metadata, actor.ipAddress ?? null, actor.userAgent ?? null]
  );
}

function assertOptions(fieldType: string, options: string[] | null | undefined) {
  if (fieldType === "select" || fieldType === "multiselect") {
    if (!options || !options.length) throw httpError(400, "Campos de seleção exigem ao menos uma opção");
  }
}

export async function listCustomFields(tenantId: string) {
  const rows = await db.query<CustomFieldDefRow>(
    `SELECT id,tenant_id,entity,key,label,type,options,required,created_at
     FROM custom_field_defs
     WHERE tenant_id=$1 AND entity='lead'
     ORDER BY created_at,key`,
    [tenantId]
  );
  return rows.rows.map(mapField);
}

export async function createCustomField(
  tenantId: string,
  input: z.infer<typeof customFieldCreateSchema>,
  actor: { userId: string; actorScope: string; ipAddress?: string; userAgent?: string }
) {
  assertOptions(input.type, input.options);
  return withTransaction(async (client) => {
    const inserted = await client.query<CustomFieldDefRow>(
      `INSERT INTO custom_field_defs(tenant_id,entity,key,label,type,options,required)
       VALUES($1,'lead',$2,$3,$4,$5,$6)
       RETURNING id,tenant_id,entity,key,label,type,options,required,created_at`,
      [tenantId, input.key ?? input.label, input.label, input.type, input.options ? JSON.stringify(input.options) : null, input.required ?? false]
    ).catch((error: { code?: string }) => {
      if (error?.code === "23505") throw httpError(409, "Já existe um campo com essa chave");
      throw error;
    });
    await insertFieldAudit(client, tenantId, inserted.rows[0].id, actor, "custom_field.create", { key: inserted.rows[0].key, type: input.type });
    return mapField(inserted.rows[0]);
  });
}

export async function updateCustomField(
  tenantId: string,
  fieldId: string,
  input: z.infer<typeof customFieldUpdateSchema>,
  actor: { userId: string; actorScope: string; ipAddress?: string; userAgent?: string }
) {
  return withTransaction(async (client) => {
    const current = await client.query<CustomFieldDefRow>(
      "SELECT id,tenant_id,entity,key,label,type,options,required,created_at FROM custom_field_defs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [tenantId, fieldId]
    );
    if (!current.rows[0]) throw httpError(404, "Campo não encontrado");
    assertOptions(current.rows[0].type, input.options !== undefined ? input.options : current.rows[0].options);
    const updated = await client.query<CustomFieldDefRow>(
      `UPDATE custom_field_defs SET label=$3,options=$4,required=$5
       WHERE tenant_id=$1 AND id=$2
       RETURNING id,tenant_id,entity,key,label,type,options,required,created_at`,
      [tenantId, fieldId, input.label ?? current.rows[0].label, input.options !== undefined ? input.options : current.rows[0].options, input.required ?? current.rows[0].required]
    );
    await insertFieldAudit(client, tenantId, fieldId, actor, "custom_field.update", {});
    return mapField(updated.rows[0]);
  });
}

export async function deleteCustomField(
  tenantId: string,
  fieldId: string,
  actor: { userId: string; actorScope: string; ipAddress?: string; userAgent?: string }
) {
  return withTransaction(async (client) => {
    const deleted = await client.query(
      "DELETE FROM custom_field_defs WHERE tenant_id=$1 AND id=$2 RETURNING id",
      [tenantId, fieldId]
    );
    if (!deleted.rows[0]) throw httpError(404, "Campo não encontrado");
    // Valores somem junto (lead_custom_values FK ON DELETE CASCADE).
    await insertFieldAudit(client, tenantId, fieldId, actor, "custom_field.delete", {});
    return { id: fieldId };
  });
}

// Leitura dos valores do lead junto ao catálogo: 1 query, sem N+1.
export async function listLeadCustomValues(tenantId: string, leadId: string) {
  const rows = await db.query<{
    field_id: string; key: string; label: string; type: string; required: boolean; options: string[] | null; value: unknown;
  }>(
    `SELECT def.id field_id,def.key,def.label,def.type,def.required,def.options,value.value
     FROM custom_field_defs def
     LEFT JOIN lead_custom_values value ON value.field_id=def.id AND value.lead_id=$2
     WHERE def.tenant_id=$1 AND def.entity='lead'
     ORDER BY def.created_at,def.key`,
    [tenantId, leadId]
  );
  return {
    items: rows.rows.map((row) => ({
      field_id: row.field_id,
      key: row.key,
      label: row.label,
      type: row.type,
      required: row.required,
      options: row.options ?? [],
      value: row.value ?? null
    }))
  };
}

function validateValueByType(type: string, value: unknown, options: string[] | null): unknown {
  if (value === null || value === undefined || value === "") return null;
  switch (type) {
    case "text":
      if (typeof value !== "string" || value.length > 10_000) throw httpError(400, "Valor deve ser texto");
      return value;
    case "number":
    case "currency":
      if (typeof value !== "number" || !Number.isFinite(value)) throw httpError(400, "Valor deve ser numérico");
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw httpError(400, "Valor deve ser booleano");
      return value;
    case "date": {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value) || Number.isNaN(Date.parse(value))) {
        throw httpError(400, "Data inválida: use ISO (YYYY-MM-DD ou datetime ISO)");
      }
      return value;
    }
    case "select": {
      const allowed = options ?? [];
      if (typeof value !== "string" || !allowed.includes(value)) throw httpError(400, "Valor não está entre as opções do campo");
      return value;
    }
    case "multiselect": {
      const allowed = options ?? [];
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !allowed.includes(item))) {
        throw httpError(400, "Valor deve ser uma lista de opções válidas");
      }
      return [...new Set(value as string[])];
    }
    default:
      throw httpError(400, "Tipo de campo inválido");
  }
}

export async function setLeadCustomValue(
  session: WorkspaceSession,
  leadId: string,
  input: z.infer<typeof leadCustomValueSchema>,
  actor: { userId: string; actorScope: string; ipAddress?: string; userAgent?: string }
) {
  return withTransaction(async (client) => {
    const field = await client.query<CustomFieldDefRow>(
      "SELECT id,tenant_id,entity,key,label,type,options,required,created_at FROM custom_field_defs WHERE tenant_id=$1 AND id=$2 AND entity='lead'",
      [session.tenantId, input.field_id]
    );
    if (!field.rows[0]) throw httpError(404, "Campo não encontrado");
    // Contato na lixeira não aceita novos valores (comportamento equivalente
    // ao lead excluído antes do soft delete).
    const lead = await client.query(
      "SELECT 1 FROM scheduling_leads WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL",
      [leadId, session.tenantId]
    );
    if (!lead.rows[0]) throw httpError(404, "Lead não encontrado");
    const validated = validateValueByType(field.rows[0].type, input.value, field.rows[0].options);
    await client.query(
      `INSERT INTO lead_custom_values(field_id,lead_id,value)
       VALUES($1,$2,$3)
       ON CONFLICT (field_id,lead_id) DO UPDATE SET value=EXCLUDED.value`,
      [input.field_id, leadId, validated === null ? null : JSON.stringify(validated)]
    );
    await client.query(
      `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
       VALUES($1,$2,$3,$4,'scheduling_lead',$5,$6,$7,$8)`,
      [actor.userId, session.tenantId, actor.actorScope, "lead.custom_value.set", leadId, { field_id: input.field_id }, actor.ipAddress ?? null, actor.userAgent ?? null]
    );
    return { field_id: input.field_id, value: validated ?? null };
  });
}
