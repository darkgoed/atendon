// W2B — R14 importação, R15 exportação CSV server-side, R17 fila aguardando
// resposta, R20 onboarding-status derivado (specs/active/v6-evolucao-estrutural-atendon.md).
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import type { CaseScope } from "../../auth/case-scope.js";
import { conversationScopeCondition } from "../../auth/case-scope.js";
import { db } from "../../db/client.js";
import { withTransaction } from "../../db/transaction.js";
import { httpError } from "../scheduling/service.js";
import { normalizePhoneE164, InvalidPhoneError } from "../../phone.js";
import {
  loadImportFile,
  MAX_IMPORT_ROWS
} from "./import-csv.js";

type ImportActor = {
  userId: string;
  actorScope: "root" | "workspace";
  ipAddress?: string;
  userAgent?: string;
};

// Etiqueta padrão para tags criadas pela importação (o catálogo exige cor).
const IMPORT_TAG_COLOR = "#2563EB";
const DEFAULT_SOURCE = "importacao";
const MAX_TAG_NAMES_PER_ROW = 20;
// Segurança do export: keyset por página, nunca a tabela inteira em memória.
const EXPORT_PAGE_SIZE = 500;
const EXPORT_ROW_LIMIT = 50_000;
const CSV_HEADER = ["id", "nome", "telefone_e164", "telefone_display", "email", "etiquetas", "status", "origem", "campanha", "criado_em"] as const;

function csvCell(value: unknown): string {
  const raw = String(value ?? "");
  // Mesma proteção anti-fórmula do /usage/export (planilha executa =+-@ como fórmula).
  const text = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

type CustomFieldDef = {
  id: string;
  key: string;
  label: string;
  type: string;
  options: string[] | null;
};

async function listLeadFieldDefs(tenantId: string): Promise<CustomFieldDef[]> {
  const rows = await db.query<{ id: string; key: string; label: string; type: string; options: string[] | null }>(
    "SELECT id,key,label,type,options FROM custom_field_defs WHERE tenant_id=$1 AND entity='lead' ORDER BY key",
    [tenantId]
  );
  return rows.rows;
}

/** Converte o texto da célula no valor JSONB do campo, espelhando a validação do módulo custom-fields. */
function castCustomValue(type: string, raw: string, options: string[] | null): unknown {
  if (raw === "") return null;
  switch (type) {
    case "text":
      if (raw.length > 10_000) throw httpError(400, "Valor deve ser texto");
      return raw;
    case "number":
    case "currency": {
      const normalized = /^[^.,]*\.[^.,]*,/.test(raw) || (/^[\d.]*,\d+$/.test(raw) && !raw.includes(".")) ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(",", ".");
      const parsed = Number(normalized);
      if (!Number.isFinite(parsed)) throw httpError(400, "Valor deve ser numérico");
      return parsed;
    }
    case "boolean": {
      const value = raw.trim().toLowerCase();
      if (["sim", "true", "1", "x", "yes"].includes(value)) return true;
      if (["não", "nao", "false", "0", "no"].includes(value)) return false;
      throw httpError(400, "Valor deve ser booleano (sim/não)");
    }
    case "date": {
      const iso = /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw : /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)
        ? raw.split("/").reverse().map((part, index) => index === 0 ? part.padStart(4, "0") : part.padStart(2, "0")).join("-")
        : null;
      if (!iso || Number.isNaN(Date.parse(iso))) throw httpError(400, "Data inválida: use ISO (YYYY-MM-DD) ou dd/mm/aaaa");
      return iso;
    }
    case "select": {
      const allowed = options ?? [];
      if (!allowed.includes(raw)) throw httpError(400, "Valor não está entre as opções do campo");
      return raw;
    }
    case "multiselect": {
      const allowed = options ?? [];
      const values = [...new Set(raw.split(/[,;]/).map((item) => item.trim()).filter(Boolean))];
      if (!values.length || values.some((item) => !allowed.includes(item))) throw httpError(400, "Valor deve ser uma lista de opções válidas");
      return values;
    }
    default:
      throw httpError(400, "Tipo de campo inválido");
  }
}

type ResolvedMapping = {
  nome?: number;
  telefone?: number;
  email?: number;
  tags?: number;
  origem?: number;
  campanha?: number;
  custom: Map<string, number>;
};

function resolveMapping(headers: string[], mapping: {
  nome?: string; telefone?: string; email?: string; tags?: string; origem?: string; campanha?: string;
  custom?: Record<string, string>;
}): ResolvedMapping {
  const index = new Map<string, number>();
  headers.forEach((header, position) => {
    const key = header.trim().toLowerCase();
    if (key && !index.has(key)) index.set(key, position);
  });
  const find = (name: string | undefined): number | undefined => {
    if (!name) return undefined;
    const found = index.get(name.trim().toLowerCase());
    if (found === undefined) throw httpError(400, `Coluna "${name}" não existe no arquivo enviado`);
    return found;
  };
  const custom = new Map<string, number>();
  for (const [key, column] of Object.entries(mapping.custom ?? {})) {
    custom.set(key, find(column)!); // record garante coluna informada; find lança se não existir
  }
  return {
    nome: find(mapping.nome),
    telefone: find(mapping.telefone),
    email: find(mapping.email),
    tags: find(mapping.tags),
    origem: find(mapping.origem),
    campanha: find(mapping.campanha),
    custom
  };
}

/**
 * R14 — pipeline por linha: telefone E.164 é a chave do contato, origem tem
 * default "importacao", email vai para o campo personalizado "email" (criado
 * sob demanda), etiquetas são acrescentadas (nunca removidas) e campos
 * personalizados são validados por tipo. Nunca há merge por nome: duplicidade
 * é apenas por telefone normalizado. Linhas são transações independentes —
 * uma linha com erro não desfaz as demais.
 */
export async function importContacts(
  tenantId: string,
  actor: ImportActor,
  body: {
    csv_base64?: string;
    xlsx_base64?: string;
    filename: string;
    mapping: { nome?: string; telefone?: string; email?: string; tags?: string; origem?: string; campanha?: string; custom?: Record<string, string> };
    options: { on_duplicate: "skip" | "update" | "flag" };
  }
) {
  const { rows } = loadImportFile(body);
  if (rows.length < 2) throw httpError(400, "O arquivo não possui linhas de dados além do cabeçalho");
  const mapping = resolveMapping(rows[0], body.mapping);
  if (mapping.telefone === undefined && mapping.nome === undefined) {
    throw httpError(400, "O mapeamento precisa resolver ao menos nome ou telefone");
  }

  // Email não tem coluna própria em scheduling_leads: é campo personalizado.
  // Campos mapeados ausentes do catálogo (email incluso) são criados sob demanda
  // como texto — a importação não pode falhar porque o campo é novo na planilha.
  let defs = await listLeadFieldDefs(tenantId);
  const present = new Set(defs.map((def) => def.key));
  const missingFields = [
    ...(mapping.email !== undefined && !present.has("email") ? [{ key: "email", label: "Email" }] : []),
    ...Object.keys(body.mapping.custom ?? {}).filter((key) => !present.has(key)).map((key) => ({ key, label: key }))
  ];
  for (const field of missingFields) {
    await db.query(
      `INSERT INTO custom_field_defs(tenant_id,entity,key,label,type)
       VALUES($1,'lead',$2,$3,'text')
       ON CONFLICT (tenant_id,entity,key) DO NOTHING`,
      [tenantId, field.key, field.label]
    );
  }
  if (missingFields.length) defs = await listLeadFieldDefs(tenantId);
  const defsByKey = new Map(defs.map((def) => [def.key, def]));
  const emailDef = mapping.email === undefined ? undefined : defsByKey.get("email");

  const result = { imported: 0, updated: 0, skipped: 0, duplicates_flagged: 0, errors: [] as Array<{ row: number; field: string; message: string }> };
  const flaggedLeadIds: string[] = [];
  const totalDataRows = rows.length - 1;
  if (totalDataRows > MAX_IMPORT_ROWS) {
    throw httpError(400, `O arquivo tem ${totalDataRows} linhas; o limite por importação é ${MAX_IMPORT_ROWS}`);
  }

  // Por arquivo, cada telefone é processado uma só vez no modo update: a
  // primeira ocorrência define o estado final (linhas repetidas são ruído e
  // nunca reescrevem o que esta importação acabou de gravar).
  const updatedPhones = new Set<string>();
  for (let rowNumber = 1; rowNumber < rows.length; rowNumber++) {
    const cells = rows[rowNumber];
    const cell = (position: number | undefined) => position === undefined ? "" : (cells[position] ?? "").trim();
    try {
      const rawPhone = cell(mapping.telefone);
      if (!rawPhone) throw httpError(400, "Telefone ausente: todo contato precisa de um telefone válido");
      let phone: string;
      try {
        phone = normalizePhoneE164(rawPhone);
      } catch (error) {
        throw httpError(400, error instanceof InvalidPhoneError || error instanceof Error ? error.message : "Telefone inválido");
      }
      const nome = cell(mapping.nome) || null;
      const origem = cell(mapping.origem) || DEFAULT_SOURCE;
      if (origem.length > 200) throw httpError(400, "Origem deve ter no máximo 200 caracteres");
      const campanha = cell(mapping.campanha) || null;
      if (campanha && campanha.length > 200) throw httpError(400, "Campanha deve ter no máximo 200 caracteres");

      const tagNames = mapping.tags === undefined ? [] : [...new Set(cell(mapping.tags).split(/[,;]/).map((item) => item.trim()).filter(Boolean))];
      if (tagNames.length > MAX_TAG_NAMES_PER_ROW) throw httpError(400, `Máximo de ${MAX_TAG_NAMES_PER_ROW} etiquetas por linha`);

      const customValues: Array<{ fieldId: string; key: string; value: unknown }> = [];
      for (const [key, position] of mapping.custom) {
        const raw = cell(position);
        if (!raw) continue;
        const def = defsByKey.get(key);
        if (!def) throw httpError(400, `Campo personalizado "${key}" não existe no catálogo`);
        customValues.push({ fieldId: def.id, key, value: castCustomValue(def.type, raw, def.options) });
      }
      const email = mapping.email === undefined ? "" : cell(mapping.email);
      if (email && email.length > 10_000) throw httpError(400, "Email deve ser texto");

      const leadId = await upsertImportedLead(tenantId, actor, body.filename, {
        phone, nome, origem, campanha,
        onDuplicate: body.options.on_duplicate,
        customValues,
        email,
        emailFieldId: emailDef?.id,
        tagNames,
        seenUpdatedPhones: updatedPhones,
        imported: () => result.imported++,
        updated: () => result.updated++,
        skipped: () => result.skipped++,
        flagged: (id) => { result.duplicates_flagged++; flaggedLeadIds.push(id); }
      });
      if (leadId === null) continue;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status !== undefined && status < 500) {
        result.errors.push({ row: rowNumber + 1, field: "linha", message: error instanceof Error ? error.message : "Erro desconhecido" });
      } else {
        throw error;
      }
    }
  }

  await db.query(
    `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
     VALUES($1,$2,$3,'contact_import','contact',$4,$5,$6,$7)`,
    [
      actor.userId, tenantId, actor.actorScope, randomUUID(),
      {
        filename: body.filename,
        on_duplicate: body.options.on_duplicate,
        imported: result.imported,
        updated: result.updated,
        skipped: result.skipped,
        duplicates_flagged: result.duplicates_flagged,
        errors: result.errors.length,
        flagged_lead_ids: flaggedLeadIds
      },
      actor.ipAddress ?? null, actor.userAgent ?? null
    ]
  );
  return result;
}

type RowUpsert = {
  phone: string;
  nome: string | null;
  origem: string;
  campanha: string | null;
  onDuplicate: "skip" | "update" | "flag";
  customValues: Array<{ fieldId: string; key: string; value: unknown }>;
  email: string;
  emailFieldId?: string;
  tagNames: string[];
  seenUpdatedPhones: Set<string>;
  imported: () => void;
  updated: () => void;
  skipped: () => void;
  flagged: (leadId: string) => void;
};

async function upsertImportedLead(tenantId: string, actor: ImportActor, filename: string, row: RowUpsert): Promise<string | null> {
  return withTransaction(db, async (client) => {
    // Transação-por-linha é decisão, não descuido: um erro numa linha do CSV
    // não derruba o import inteiro (isolamento por linha) e o advisory lock
    // (mesmo do upsertLead) serializa contra o painel para o mesmo telefone
    // dentro do tenant.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`lead:${tenantId}:${row.phone}`]);
    const existing = await client.query<{ id: string; name: string | null; source: string }>(
      `SELECT id,name,source FROM scheduling_leads
       WHERE tenant_id=$1 AND regexp_replace(phone,'\\D','','g')=regexp_replace($2,'\\D','','g')
       ORDER BY created_at,id LIMIT 1 FOR UPDATE`,
      [tenantId, row.phone]
    );
    let leadId: string;
    if (!existing.rows[0]) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO scheduling_leads(tenant_id,phone,name,source,campaign)
         VALUES($1,$2,$3,$4,$5) RETURNING id`,
        [tenantId, row.phone, row.nome, row.origem, row.campanha]
      );
      leadId = inserted.rows[0].id;
      row.imported();
      await client.query(
        `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,new_status,details,actor_user_id)
         VALUES($1,$2,'lead_criado',NULL,$3,$4)`,
        [leadId, tenantId, { via: "contact_import", filename }, actor.userId]
      );
    } else if (row.onDuplicate === "skip") {
      row.skipped();
      return null;
    } else if (row.onDuplicate === "flag") {
      row.flagged(existing.rows[0].id);
      return null;
    } else {
      if (row.seenUpdatedPhones.has(row.phone)) return null; // já atualizado por este arquivo
      row.seenUpdatedPhones.add(row.phone);
      leadId = existing.rows[0].id;
      // Atualização conservadora: célula vazia nunca apaga dado existente;
      // histórico/notas/tags de outras tabelas ficam intactos.
      await client.query(
        `UPDATE scheduling_leads
         SET name=CASE WHEN $3::text IS NOT NULL AND $3::text <> '' THEN $3 ELSE name END,
             source=CASE WHEN $4::text IS NOT NULL AND $4::text <> '' THEN $4 ELSE source END,
             campaign=CASE WHEN $5::text IS NOT NULL THEN $5 ELSE campaign END,
             deleted_at=NULL,deleted_by=NULL,updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, leadId, row.nome, row.origem === DEFAULT_SOURCE ? null : row.origem, row.campanha]
      );
      row.updated();
      await client.query(
        `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details,actor_user_id)
         VALUES($1,$2,'lead_atualizado',$3,$4)`,
        [leadId, tenantId, { via: "contact_import", filename }, actor.userId]
      );
    }
    if (row.nome) {
      await client.query(
        `UPDATE conversations SET contact_name=$3
         WHERE tenant_id=$1 AND regexp_replace(contact_phone,'\\D','','g')=regexp_replace($2,'\\D','','g')`,
        [tenantId, row.phone, row.nome]
      );
    }
    for (const custom of row.customValues) {
      if (custom.value === null) continue;
      await client.query(
        `INSERT INTO lead_custom_values(field_id,lead_id,value)
         VALUES($1,$2,$3)
         ON CONFLICT (field_id,lead_id) DO UPDATE SET value=EXCLUDED.value`,
        [custom.fieldId, leadId, JSON.stringify(custom.value)]
      );
    }
    if (row.email && row.emailFieldId) {
      await client.query(
        `INSERT INTO lead_custom_values(field_id,lead_id,value)
         VALUES($1,$2,$3)
         ON CONFLICT (field_id,lead_id) DO UPDATE SET value=EXCLUDED.value`,
        [row.emailFieldId, leadId, JSON.stringify(row.email)]
      );
    }
    for (const tagName of row.tagNames) {
      let tag = (await client.query<{ id: string }>(
        "SELECT id FROM lead_tags WHERE tenant_id=$1 AND archived_at IS NULL AND lower(name)=lower($2)",
        [tenantId, tagName]
      )).rows[0];
      if (!tag) {
        try {
          tag = (await client.query<{ id: string }>(
            `INSERT INTO lead_tags(tenant_id,name,color,created_by_user_id)
             VALUES($1,$2,$3,$4)
             RETURNING id`,
            [tenantId, tagName, IMPORT_TAG_COLOR, actor.userId]
          )).rows[0];
        } catch (error) {
          // 23505 = outro processo criou a etiqueta entre o SELECT e o INSERT.
          if ((error as { code?: string }).code !== "23505") throw error;
        }
        tag ??= (await client.query<{ id: string }>(
          "SELECT id FROM lead_tags WHERE tenant_id=$1 AND archived_at IS NULL AND lower(name)=lower($2)",
          [tenantId, tagName]
        )).rows[0];
      }
      if (!tag) throw httpError(409, `Etiqueta "${tagName}" não pôde ser criada`);
      await client.query(
        `INSERT INTO lead_tag_assignments(tenant_id,lead_id,tag_id,created_by_user_id)
         VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [tenantId, leadId, tag.id, actor.userId]
      );
    }
    return leadId;
  });
}

export type ExportQuery = {
  ids?: string[];
  status?: string;
  unidade_id?: string;
  categoria_id?: string;
  parceiro_id?: string;
  busca?: string;
  estrelas?: number;
  pipeline_stage_id?: string;
  sdr_member_id?: string;
  closer_member_id?: string;
  origem?: string;
  campanha?: string;
  period_start?: string;
  period_end?: string;
  appointment_status?: string;
  commercial_outcome?: string;
  action_bucket?: string;
  fila_humana?: boolean;
  faturamento?: string;
  resultado?: string;
  investimento?: string;
  formulario?: string;
};

/**
 * R15 — export CSV server-side com keyset interno (páginas de 500 linhas,
 * nunca a tabela inteira). Mesmo escopo e filtros de /scheduling/leads;
 * leads na lixeira nunca são exportados.
 */
export async function exportLeadsCsv(
  tenantId: string,
  scope: CaseScope,
  filters: ExportQuery
): Promise<{ stream: Readable; truncated: boolean; total: number }> {
  const params: unknown[] = [tenantId, scope.memberId];
  const conditions = [
    "l.tenant_id=$1",
    "l.deleted_at IS NULL",
    `(${leadReadScopeCondition(scope, "l", "$2")})`
  ];
  const needsAppointmentLateral = Boolean(filters.appointment_status) || filters.action_bucket === "result_pending" || filters.action_bucket === "today";
  const needsQualificationJoin = Boolean(filters.faturamento || filters.resultado || filters.investimento || filters.formulario);
  if (filters.ids) {
    if (filters.ids.length > 2000) throw httpError(400, "Máximo de 2000 ids por exportação");
    params.push(filters.ids);
    conditions.push(`l.id=ANY($${params.length}::uuid[])`);
  }
  for (const [value, column] of [
    [filters.status, "l.status"], [filters.unidade_id, "l.unit_id"], [filters.categoria_id, "l.interest_category_id"],
    [filters.parceiro_id, "l.partner_id"], [filters.estrelas, "l.qualification_stars"],
    [filters.pipeline_stage_id, "l.pipeline_stage_id"], [filters.sdr_member_id, "l.sdr_member_id"],
    [filters.closer_member_id, "l.closer_member_id"], [filters.origem, "l.source"], [filters.campanha, "l.campaign"],
    [filters.appointment_status, "latest_appointment.status"], [filters.commercial_outcome, "l.commercial_outcome"],
    [filters.faturamento, "q.faturamento"], [filters.resultado, "q.resultado_final"]
  ] as const) {
    if (value !== undefined && value !== null && value !== "") { params.push(value); conditions.push(`${column}=$${params.length}`); }
  }
  if (filters.investimento) {
    params.push(filters.investimento && filters.investimento.toLowerCase() === "nao" ? "NÃO" : "SIM");
    conditions.push(`q.investimento=$${params.length}`);
  }
  if (filters.formulario) { params.push(filters.formulario); conditions.push(`q.status=$${params.length}`); }
  if (filters.fila_humana) conditions.push("l.requires_human_decision=true");
  if (filters.action_bucket === "result_pending") conditions.push("latest_appointment.result_pending_at IS NOT NULL");
  if (filters.action_bucket === "recovery") conditions.push("l.recovery_required=true");
  if (filters.action_bucket === "overdue_follow_up") conditions.push("l.next_action_at<now()");
  if (filters.action_bucket === "today") conditions.push("(latest_appointment.start_at AT TIME ZONE tenant.timezone)::date=(now() AT TIME ZONE tenant.timezone)::date");
  if (filters.period_start) { params.push(filters.period_start); conditions.push(`l.created_at >= ($${params.length}::date::timestamp AT TIME ZONE tenant.timezone)`); }
  if (filters.period_end) { params.push(filters.period_end); conditions.push(`l.created_at < (($${params.length}::date + 1)::timestamp AT TIME ZONE tenant.timezone)`); }
  if (filters.busca) { params.push(`%${filters.busca}%`); conditions.push(`(l.phone ILIKE $${params.length} OR l.name ILIKE $${params.length})`); }

  const where = conditions.join(" AND ");
  // Joins de filtro vão no count e na página; o LATERAL de tags só é necessário
  // no SELECT da página (count não usa tags.items).
  const filterJoins = [
    "JOIN tenants tenant ON tenant.id=l.tenant_id",
    needsAppointmentLateral ? `LEFT JOIN LATERAL (
      SELECT appointment.id,appointment.status,appointment.start_at,appointment.end_at,appointment.result_pending_at
      FROM scheduling_appointments appointment
      WHERE appointment.tenant_id=l.tenant_id AND appointment.lead_id=l.id
      ORDER BY appointment.start_at DESC,appointment.id DESC
      LIMIT 1
    ) latest_appointment ON true` : "",
    needsQualificationJoin ? "LEFT JOIN lead_qualifications q ON q.tenant_id=l.tenant_id AND q.lead_id=l.id" : ""
  ].filter(Boolean).join("\n");
  const tagsJoin = `LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id',tag.id,'name',tag.name,'color',tag.color) ORDER BY lower(tag.name),tag.id) items
      FROM lead_tag_assignments assignment
      JOIN lead_tags tag ON tag.tenant_id=assignment.tenant_id AND tag.id=assignment.tag_id
      WHERE assignment.tenant_id=l.tenant_id AND assignment.lead_id=l.id
    ) tags ON true`;

  const count = await db.query<{ total: number }>(
    `SELECT count(*)::int total FROM scheduling_leads l ${filterJoins} WHERE ${where}`,
    params
  );
  const total = count.rows[0]?.total ?? 0;

  const defs = await listLeadFieldDefs(tenantId);
  const emailDefId = defs.find((def) => def.key === "email")?.id ?? null;
  const columns = [...CSV_HEADER, ...defs.map((def) => def.key)];

  async function* csvLines(): AsyncGenerator<string> {
    yield `${columns.map(csvCell).join(",")}\n`;
    let cursorCreatedAt: string | null = null;
    let cursorId: string | null = null;
    let emitted = 0;
    while (emitted < Math.min(total, EXPORT_ROW_LIMIT)) {
      const pageParams = [...params];
      const pageConditions = [...conditions];
      if (cursorCreatedAt) {
        pageParams.push(cursorCreatedAt, cursorId);
        pageConditions.push(`(l.created_at,l.id)>($${pageParams.length - 1}::timestamptz,$${pageParams.length}::uuid)`);
      }
      pageParams.push(EXPORT_PAGE_SIZE);
      const page = await db.query<{
        id: string; name: string | null; phone: string | null; status: string; source: string; campaign: string | null; created_at: Date; tags: { name: string }[] | null;
      }>(
        `SELECT l.id,l.name,l.phone,l.status,l.source,l.campaign,l.created_at,
                COALESCE(tags.items,'[]'::jsonb) tags
         FROM scheduling_leads l ${filterJoins}
         ${tagsJoin}
         WHERE ${pageConditions.join(" AND ")}
         ORDER BY l.created_at,l.id
         LIMIT $${pageParams.length}`,
        pageParams
      );
      if (!page.rows.length) break;
      const customMap = await loadCustomValues(page.rows.map((row) => row.id), defs.map((def) => def.id));
      for (const row of page.rows) {
        if (emitted >= EXPORT_ROW_LIMIT) break;
        const tags = (row.tags ?? []).map((tag) => tag.name).join(", ");
        const values = [
          row.id,
          row.name ?? "",
          row.phone ?? "",
          row.phone ? `+${row.phone}` : "",
          emailDefId ? formatCustomValue(customMap.get(`${row.id}:${emailDefId}`) ?? null) : "",
          tags,
          row.status,
          row.source,
          row.campaign ?? "",
          row.created_at.toISOString()
        ];
        for (const def of defs) {
          values.push(formatCustomValue(customMap.get(`${row.id}:${def.id}`) ?? null));
        }
        yield `${values.map(csvCell).join(",")}\n`;
        emitted++;
      }
      const last = page.rows[page.rows.length - 1];
      cursorCreatedAt = last.created_at.toISOString();
      cursorId = last.id;
      if (page.rows.length < EXPORT_PAGE_SIZE) break;
    }
  }

  return { stream: Readable.from(csvLines(), { objectMode: false }), truncated: total > EXPORT_ROW_LIMIT, total };
}

function leadReadScopeCondition(scope: CaseScope, alias: string, memberParameter: string): string {
  if (scope.type === "workspace") return `(${memberParameter}::uuid IS NULL OR ${memberParameter}::uuid IS NOT NULL)`;
  if (!scope.memberId) return "FALSE";
  return `(${alias}.assigned_member_id=${memberParameter} OR ${alias}.sdr_member_id=${memberParameter} OR ${alias}.closer_member_id=${memberParameter} OR ${alias}.recovery_member_id=${memberParameter})`;
}

async function loadCustomValues(leadIds: string[], fieldIds: string[]): Promise<Map<string, unknown>> {
  const map = new Map<string, unknown>();
  if (!leadIds.length || !fieldIds.length) return map;
  const rows = await db.query<{ lead_id: string; field_id: string; value: unknown }>(
    "SELECT lead_id,field_id,value FROM lead_custom_values WHERE lead_id=ANY($1::uuid[]) AND field_id=ANY($2::uuid[])",
    [leadIds, fieldIds]
  );
  for (const row of rows.rows) map.set(`${row.lead_id}:${row.field_id}`, row.value);
  return map;
}

function formatCustomValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "sim" : "não";
  return String(value);
}

export type AwaitingReplyQuery = { limit: number; cursor?: string };

/**
 * R17 — fila de conversas com cliente aguardando humano, 100% derivada
 * (nenhuma coluna de marcador). A expressão lateral da última mensagem é a
 * mesma de scheduling/routes.ts:369-383; aqui o predicado é
 * `latest_message.sender='contact'` (o cliente falou por último e ninguém
 * respondeu) — ver relatório para a decisão completa.
 */
export async function listAwaitingReply(tenantId: string, scope: CaseScope, query: AwaitingReplyQuery) {
  // conversationScopeCondition('mine') compara c.assigned_user_id — o param é o
  // USER da sessão; scope.memberId aqui filtrava por um uuid de workspace_members
  // que a coluna nunca contém (fila vazia para operador).
  const params: unknown[] = [tenantId, scope.userId];
  const conditions = [
    "c.tenant_id=$1",
    "c.status='open'",
    // Cliente falou por último e ninguém respondeu; conversa sem mensagens não aguarda ninguém.
    "latest_message.sender='contact'",
    `(${conversationScopeCondition(scope, "c", "$2")})`
  ];
  if (query.cursor) {
    const cursor = decodeAwaitingCursor(query.cursor);
    params.push(cursor.at, cursor.mid, cursor.cid);
    conditions.push(`(latest_message.created_at,latest_message.id,c.id)<($${params.length - 2}::timestamptz,$${params.length - 1}::uuid,$${params.length}::uuid)`);
  }
  params.push(query.limit + 1);
  const result = await db.query<{
    id: string; session_id: string | null; ai_active: boolean; contact_phone: string; contact_name: string | null;
    last_message_at: Date; last_message_id: string; last_inbound_at: Date | null;
    lead_id: string; lead_name: string | null; lead_phone: string | null; lead_status: string;
  }>(
    `SELECT c.id,c.session_id,c.ai_active,c.contact_phone,c.contact_name,
            latest_message.created_at last_message_at,latest_message.id last_message_id,
            latest_contact.created_at last_inbound_at,
            l.id lead_id,l.name lead_name,l.phone lead_phone,l.status lead_status
     FROM conversations c
     LEFT JOIN LATERAL (
       SELECT message.id,message.sender,message.created_at
       FROM messages message
       WHERE message.conversation_id=c.id
       ORDER BY message.created_at DESC,message.id DESC
       LIMIT 1
     ) latest_message ON true
     LEFT JOIN LATERAL (
       SELECT m.created_at
       FROM messages m
       WHERE m.conversation_id=c.id AND m.sender='contact'
       ORDER BY m.created_at DESC,m.id DESC
       LIMIT 1
     ) latest_contact ON true
     JOIN scheduling_leads l ON l.tenant_id=c.tenant_id AND l.id=c.lead_id AND l.deleted_at IS NULL
     WHERE ${conditions.join(" AND ")}
     ORDER BY latest_message.created_at DESC,latest_message.id DESC,c.id DESC
     LIMIT $${params.length}`,
    params
  );
  const rows = result.rows.slice(0, query.limit);
  const hasMore = result.rows.length > query.limit;
  const last = rows[rows.length - 1];
  return {
    items: rows.map((row) => ({
      conversation_id: row.id,
      session_id: row.session_id,
      ai_active: row.ai_active,
      contact: { phone: row.contact_phone, name: row.contact_name },
      last_inbound_at: row.last_inbound_at ? row.last_inbound_at.toISOString() : null,
      last_message_at: row.last_message_at.toISOString(),
      lead: { id: row.lead_id, name: row.lead_name, phone: row.lead_phone, status: row.lead_status }
    })),
    next_cursor: hasMore && last
      ? encodeAwaitingCursor({ at: last.last_message_at.toISOString(), mid: last.last_message_id, cid: last.id })
      : null
  };
}

function decodeAwaitingCursor(raw: string): { at: string; mid: string; cid: string } {
  let decoded: unknown;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw httpError(400, "Cursor inválido");
  }
  const value = decoded as { v?: unknown; at?: unknown; mid?: unknown; cid?: unknown };
  if (
    value.v !== 1 || typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))
    || typeof value.mid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.mid)
    || typeof value.cid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.cid)
  ) {
    throw httpError(400, "Cursor inválido");
  }
  return { at: value.at, mid: value.mid, cid: value.cid };
}

function encodeAwaitingCursor(payload: { at: string; mid: string; cid: string }): string {
  return Buffer.from(JSON.stringify({ v: 1, ...payload })).toString("base64url");
}

/**
 * R20 — onboarding derivado de contagens reais, sem toggle manual. Empresa
 * considera configurada quando o timezone deixa de ser o placeholder 'UTC'
 * (padrão de criação; tenants provisionados por preset já nascem com timezone).
 */
export async function onboardingStatus(tenantId: string) {
  const result = await db.query<{
    name: string; timezone: string; connected_channels: number; active_members: number; pipeline_stage_count: number;
  }>(
    `SELECT tenant.name,tenant.timezone,
            (SELECT count(*) FROM whatsapp_sessions session WHERE session.tenant_id=$1 AND session.status='connected') connected_channels,
            (SELECT count(*) FROM workspace_members member WHERE member.workspace_id=$1 AND member.status='active') active_members,
            (SELECT count(*) FROM pipeline_stages stage WHERE stage.tenant_id=$1) pipeline_stage_count
     FROM tenants tenant WHERE tenant.id=$1`,
    [tenantId]
  );
  const row = result.rows[0];
  if (!row) throw httpError(404, "Empresa não encontrada");
  const items = [
    {
      key: "empresa",
      label: "Perfil da empresa",
      done: row.name.trim() !== "" && row.timezone !== "UTC",
      href: "/configuracoes"
    },
    { key: "canal", label: "Canal conectado", done: row.connected_channels > 0, href: "/conexao" },
    { key: "equipe", label: "Equipe ativa", done: row.active_members > 1, href: "/workspace/members" },
    { key: "pipeline", label: "Pipeline configurado", done: row.pipeline_stage_count > 1, href: "/pipeline" }
  ];
  return { items, all_done: items.every((item) => item.done) };
}
