import { z } from "zod";
import type { PermissionKey } from "../../auth/rbac.js";
import type { WorkspaceSession } from "../../auth/session.js";
import {
  conversationScopeCondition,
  leadScopeCondition,
  resolveCaseScope,
  type CaseScope
} from "../../auth/case-scope.js";
import { db } from "../../db/client.js";
import { normalizePhoneE164 } from "../../phone.js";
import { httpError } from "../scheduling/service.js";

// Busca global do painel (GET /search) sobre contatos, tarefas e conversas.
//
// Escopo e permissões por seção — itens sem permissão são OMITIDOS/esvaziados,
// nunca 403 (a rota usa requireWorkspace, não requirePermission):
// - contacts exige leads.follow_up.read — sem ela a chave NÃO existe na resposta;
// - tasks exige tasks.read — sem ela tasks vem vazio (com tasks.assign, todo o
//   tenant; sem, apenas o que o usuário criou ou é responsável);
// - conversations exige conversations.read — sem ela conversations vem vazio.
//
// Sem trigramas (padrão da casa: ILIKE + LIMIT, já usado em scheduling/
// contact-ops/post-sales; índice GIN trgm ficaria para necessidade real).
// Escopo: tenant SEMPRE + case-scope por seção (resolveCaseScope).

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(25).default(8),
  cursor: z.string().max(2000).optional()
}).strict();

type CursorPoint = { createdAt: string; id: string };
type SectionKey = "contacts" | "tasks" | "conversations";
type SectionPoints = Record<SectionKey, CursorPoint | null>;

type SectionResult = {
  items: Array<Record<string, unknown>>;
  has_more: boolean;
  next_point: CursorPoint | null;
};

// Mesmo formato base64url da casa (tasks): JSON { v: 1, ... }. Aqui o cursor é
// composto — um ponto keyset por seção, pois cada seção pagina de forma
// independente sobre a mesma query. Na estrutura (wire) cada ponto usa
// created_at (snake_case, como em tasks); o valor preserva MICROSEGUNDOS do
// Postgres (Date.toISOString trunca para ms e, com created_at idêntico em um
// INSERT..SELECT, o truncamento pularia páginas inteiras no keyset).
function encodeCursor(points: SectionPoints): string {
  const wire = (point: CursorPoint | null) => (point ? { created_at: point.createdAt, id: point.id } : null);
  return Buffer.from(
    JSON.stringify({
      v: 1,
      sections: {
        contacts: wire(points.contacts),
        tasks: wire(points.tasks),
        conversations: wire(points.conversations)
      }
    })
  ).toString("base64url");
}

function decodeCursorPoint(value: unknown): CursorPoint | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") throw new Error("cursor");
  const point = value as { created_at?: unknown; id?: unknown };
  if (typeof point.created_at !== "string" || Number.isNaN(Date.parse(point.created_at))) throw new Error("cursor");
  if (typeof point.id !== "string" || !/^[0-9a-f-]{36}$/i.test(point.id)) throw new Error("cursor");
  return { createdAt: point.created_at, id: point.id };
}

function decodeCursor(value: string): SectionPoints {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      v?: unknown;
      sections?: unknown;
    };
    if (parsed.v !== 1 || typeof parsed.sections !== "object" || parsed.sections === null) throw new Error("cursor");
    const sections = parsed.sections as Record<string, unknown>;
    if (Object.keys(sections).some((key) => !["contacts", "tasks", "conversations"].includes(key))) throw new Error("cursor");
    return {
      contacts: decodeCursorPoint(sections.contacts),
      tasks: decodeCursorPoint(sections.tasks),
      conversations: decodeCursorPoint(sections.conversations)
    };
  } catch {
    throw httpError(400, "Cursor inválido");
  }
}

// Espelho de src/modules/scheduling/routes.ts — leitura por seção, sem 403.
function sessionHasPermission(session: WorkspaceSession, permission: PermissionKey): boolean {
  return Boolean(session.isRoot && session.rootWorkspaceAccess) || session.permissions.includes(permission);
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

// Contatos e conversas armazenam E.164 sem '+'. Normaliza os dígitos da
// consulta (Brasil assume 55; estrangeiros batem pelos dígitos crus) e exige
// >= 8 para não transformar meia dúzia de dígitos em match amplo demais.
function phoneSearchCandidates(query: string): string[] {
  const digits = query.replace(/\D/g, "");
  if (digits.length < 8) return [];
  try {
    return [...new Set([normalizePhoneE164(digits), digits])];
  } catch {
    return [digits];
  }
}

function paginate<T extends { id: string; created_at_key: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    pageRows,
    has_more: hasMore,
    // Guarda o ponto mesmo sem has_more: avançar além do que já foi devolvido
    // evita redevolver as mesmas linhas em páginas futuras. created_at_key é o
    // timestamptz COM microssegundos (to_char) — Date perde essa precisão e o
    // keyset com created_at empatado pularia/repetiria linhas.
    next_point: last ? { createdAt: last.created_at_key, id: last.id } : null
  };
}

const emptySection = (): SectionResult => ({ items: [], has_more: false, next_point: null });

async function searchContacts(
  session: WorkspaceSession,
  scope: CaseScope,
  pattern: string,
  phoneCandidates: string[],
  point: CursorPoint | null,
  limit: number
): Promise<SectionResult> {
  const values: unknown[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const conditions = [
    `lead.tenant_id=${bind(session.tenantId)}`,
    "lead.deleted_at IS NULL",
    `(${leadScopeCondition(scope, "lead", bind(scope.memberId))})`
  ];
  const nameCondition = `lead.name ILIKE ${bind(pattern)} ESCAPE '\\'`;
  conditions.push(
    phoneCandidates.length
      ? `(${nameCondition} OR lead.phone LIKE ANY(${bind(phoneCandidates.map((candidate) => `%${candidate}%`))}::text[]))`
      : nameCondition
  );
  if (point) {
    conditions.push(`(lead.created_at,lead.id)<(${bind(point.createdAt)}::timestamptz,${bind(point.id)}::uuid)`);
  }
  const result = await db.query<{
    id: string;
    name: string | null;
    phone: string;
    status: string;
    created_at: Date;
    created_at_key: string;
  }>(
    `SELECT lead.id,lead.name,lead.phone,lead.status,lead.created_at,
            to_char(lead.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_key
     FROM scheduling_leads lead
     WHERE ${conditions.join(" AND ")}
     ORDER BY lead.created_at DESC,lead.id DESC
     LIMIT ${bind(limit + 1)}`,
    values
  );
  const page = paginate(result.rows, limit);
  return {
    items: page.pageRows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      status: row.status,
      created_at: row.created_at
    })),
    has_more: page.has_more,
    next_point: page.next_point
  };
}

async function searchTasks(
  session: WorkspaceSession,
  pattern: string,
  point: CursorPoint | null,
  limit: number
): Promise<SectionResult> {
  const values: unknown[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const conditions = [`task.tenant_id=${bind(session.tenantId)}`];
  // tasks.assign vê o tenant inteiro; sem ele, apenas o que criou ou é responsável.
  if (!sessionHasPermission(session, "tasks.assign")) {
    conditions.push(`(task.assignee_id=${bind(session.userId)} OR task.created_by=${bind(session.userId)})`);
  }
  const patternCondition = `ILIKE ${bind(pattern)} ESCAPE '\\'`;
  conditions.push(`(task.title ${patternCondition} OR task.description ${patternCondition})`);
  if (point) {
    conditions.push(`(task.created_at,task.id)<(${bind(point.createdAt)}::timestamptz,${bind(point.id)}::uuid)`);
  }
  const result = await db.query<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    created_at: Date;
    created_at_key: string;
  }>(
    `SELECT task.id,task.title,task.description,task.status,task.priority,task.created_at,
            to_char(task.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_key
     FROM tasks task
     WHERE ${conditions.join(" AND ")}
     ORDER BY task.created_at DESC,task.id DESC
     LIMIT ${bind(limit + 1)}`,
    values
  );
  const page = paginate(result.rows, limit);
  return {
    items: page.pageRows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      created_at: row.created_at
    })),
    has_more: page.has_more,
    next_point: page.next_point
  };
}

async function searchConversations(
  session: WorkspaceSession,
  scope: CaseScope,
  pattern: string,
  phoneCandidates: string[],
  point: CursorPoint | null,
  limit: number
): Promise<SectionResult> {
  const values: unknown[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const conditions = [
    `conversation.tenant_id=${bind(session.tenantId)}`,
    // UMA condição única de escopo: no mine, conversa atribuída ao membro OU
    // lead do membro (espelha a inbox); workspace vê tudo.
    scope.type === "mine"
      ? `((${conversationScopeCondition(scope, "conversation", bind(scope.userId))}) OR (EXISTS (
          SELECT 1 FROM scheduling_leads lead
          WHERE lead.id=conversation.lead_id AND lead.tenant_id=conversation.tenant_id
            AND lead.deleted_at IS NULL AND (${leadScopeCondition(scope, "lead", bind(scope.memberId))})
        )))`
      : `(${conversationScopeCondition(scope, "conversation", bind(scope.userId))})`
  ];
  // Telefone também casa pelos DÍGITOS normalizados (contatos armazenam E.164
  // sem '+'; padrões com '-' ou DDI parcial não casam por ILIKE cru).
  const phoneCondition = phoneCandidates.length
    ? ` OR conversation.contact_phone LIKE ANY(${bind(phoneCandidates.map((candidate) => `%${candidate}%`))}::text[])`
    : "";
  const patternCondition = `ILIKE ${bind(pattern)} ESCAPE '\\'`;
  conditions.push(
    `(conversation.contact_name ${patternCondition} OR conversation.contact_phone ${patternCondition}${phoneCondition})`
  );
  if (point) {
    conditions.push(`(conversation.created_at,conversation.id)<(${bind(point.createdAt)}::timestamptz,${bind(point.id)}::uuid)`);
  }
  const result = await db.query<{
    id: string;
    contact_name: string | null;
    contact_phone: string | null;
    status: string;
    created_at: Date;
    created_at_key: string;
  }>(
    `SELECT conversation.id,conversation.contact_name,conversation.contact_phone,conversation.status,conversation.created_at,
            to_char(conversation.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_key
     FROM conversations conversation
     WHERE ${conditions.join(" AND ")}
     ORDER BY conversation.created_at DESC,conversation.id DESC
     LIMIT ${bind(limit + 1)}`,
    values
  );
  const page = paginate(result.rows, limit);
  return {
    items: page.pageRows.map((row) => ({
      id: row.id,
      contact_name: row.contact_name,
      contact_phone: row.contact_phone,
      status: row.status,
      created_at: row.created_at
    })),
    has_more: page.has_more,
    next_point: page.next_point
  };
}

export async function searchWorkspace(
  session: WorkspaceSession,
  query: z.infer<typeof searchQuerySchema>
) {
  const scope = await resolveCaseScope(db, session);
  const pattern = likePattern(query.q);
  const phoneCandidates = phoneSearchCandidates(query.q);
  const points = query.cursor
    ? decodeCursor(query.cursor)
    : { contacts: null, tasks: null, conversations: null };

  const [contacts, tasks, conversations] = await Promise.all([
    sessionHasPermission(session, "leads.follow_up.read")
      ? searchContacts(session, scope, pattern, phoneCandidates, points.contacts, query.limit)
      : null,
    sessionHasPermission(session, "tasks.read")
      ? searchTasks(session, pattern, points.tasks, query.limit)
      : emptySection(),
    sessionHasPermission(session, "conversations.read")
      ? searchConversations(session, scope, pattern, phoneCandidates, points.conversations, query.limit)
      : emptySection()
  ]);

  const hasMore = contacts?.has_more === true || tasks.has_more || conversations.has_more;
  const nextCursor = hasMore
    ? encodeCursor({
      contacts: contacts ? contacts.next_point : null,
      tasks: tasks.next_point,
      conversations: conversations.next_point
    })
    : null;
  const sectionPage = (section: { has_more: boolean }) => ({
    has_more: section.has_more,
    next_cursor: nextCursor
  });

  return {
    q: query.q,
    page: { limit: query.limit, has_more: hasMore, next_cursor: nextCursor },
    // Sem leads.follow_up.read a seção NÃO existe na resposta (omitida, não 403).
    ...(contacts ? { contacts: { items: contacts.items, page: sectionPage(contacts) } } : {}),
    tasks: { items: tasks.items, page: sectionPage(tasks) },
    conversations: { items: conversations.items, page: sectionPage(conversations) }
  };
}
