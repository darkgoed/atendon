// Notas internas com @menções (R3) e central de notificações internas por
// usuário (R2) — specs/active/v6-evolucao-estrutural-atendon.md, Contratos de
// API (W1). Notificações internas são eventos direcionados a UM usuário,
// user-scoped e SEM gate de gestão (o system_alerts existente em app.ts segue
// cuidando dos alertas agregados restritos a gestores).
//
// Notas de lead: a tabela scheduling_lead_notes (0034) é saudável e foi
// EXTENDIDA com `mentions` (0167) — a leitura/escrita fica unificada nela, na
// mesma fonte da rota atual POST /scheduling/leads/:id/notes. Notas de
// conversa usam internal_notes (context_type='conversation').
import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { db } from "../../db/client.js";
import { withTenantTransaction } from "../../db/tenant-transaction.js";
import { httpError, type FollowUpActor } from "../scheduling/service.js";
import type { WorkspaceSession } from "../../auth/session.js";

export const internalNotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(512).optional(),
  unread: z.string().optional()
});

export const internalNoteBodySchema = z.object({
  body: z.string().trim().min(1).max(4000),
  mentions: z.array(z.string().uuid()).max(20).optional()
}).strict();

type InternalNotificationsQuery = z.infer<typeof internalNotificationsQuerySchema>;
type InternalNoteBody = z.infer<typeof internalNoteBodySchema>;

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  source_type: string | null;
  source_id: string | null;
  actor_id: string | null;
  actor_name: string | null;
  read_at: Date | null;
  created_at: Date;
};

export type InternalNoteItem = {
  id: string;
  body: string;
  author_id: string;
  author_name: string | null;
  mentions: { id: string; name: string | null }[];
  created_at: Date;
};

// --- keyset cursor (padrão do codebase: base64url + validação) -------------

function encodeNotificationCursor(row: { created_at: Date; id: string }) {
  return Buffer.from(JSON.stringify({ v: 1, created_at: new Date(row.created_at).toISOString(), id: row.id }))
    .toString("base64url");
}

function decodeNotificationCursor(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || typeof parsed.id !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.id)) throw new Error();
    if (typeof parsed.created_at !== "string" || Number.isNaN(Date.parse(parsed.created_at))) throw new Error();
    return { createdAt: parsed.created_at, id: parsed.id };
  } catch {
    throw httpError(400, "Cursor inválido");
  }
}

// --- feed de notificações internas (escopo do token, sempre) ---------------

export async function listInternalNotifications(session: WorkspaceSession, query: InternalNotificationsQuery) {
  const values: unknown[] = [session.tenantId, session.userId];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const where = ["notification.tenant_id=$1", "notification.user_id=$2"];
  const unreadOnly = query.unread === "true" || query.unread === "1";
  if (unreadOnly) where.push("notification.read_at IS NULL");
  if (query.cursor) {
    const cursor = decodeNotificationCursor(query.cursor);
    where.push(`(notification.created_at,notification.id)<(${bind(cursor.createdAt)}::timestamptz,${bind(cursor.id)}::uuid)`);
  }
  const limit = bind(query.limit + 1);
  const [page, unread] = await Promise.all([
    db.query<NotificationRow>(
      `SELECT notification.id,notification.type,notification.title,notification.body,
              notification.source_type,notification.source_id,notification.actor_id,
              notification.read_at,notification.created_at,actor.name actor_name
       FROM internal_notifications notification
       LEFT JOIN users actor ON actor.id=notification.actor_id
       WHERE ${where.join(" AND ")}
       ORDER BY notification.created_at DESC,notification.id DESC
       LIMIT ${limit}`,
      values
    ),
    db.query<{ total_unread: number }>(
      `SELECT count(*)::int total_unread
       FROM internal_notifications
       WHERE tenant_id=$1 AND user_id=$2 AND read_at IS NULL`,
      [session.tenantId, session.userId]
    )
  ]);
  const hasMore = page.rows.length > query.limit;
  const items = hasMore ? page.rows.slice(0, query.limit) : page.rows;
  return {
    items,
    total_unread: unread.rows[0].total_unread,
    page: {
      has_more: hasMore,
      next_cursor: hasMore && items.length ? encodeNotificationCursor(items.at(-1)!) : null
    }
  };
}

export async function markInternalNotificationRead(session: WorkspaceSession, notificationId: string) {
  // Sem filtro read_at: reler uma notificação é idempotente. O escopo
  // tenant_id+user_id do token é SEMPRE imposto — id de outro usuário/tenant
  // é 404, nunca 403 (não revela existência).
  const updated = await db.query(
    `UPDATE internal_notifications SET read_at=now()
     WHERE tenant_id=$1 AND user_id=$2 AND id=$3`,
    [session.tenantId, session.userId, notificationId]
  );
  if (!updated.rowCount) throw httpError(404, "Notificação não encontrada");
  return { ok: true };
}

export async function markAllInternalNotificationsRead(session: WorkspaceSession) {
  const updated = await db.query<{ id: string }>(
    `UPDATE internal_notifications SET read_at=now()
     WHERE tenant_id=$1 AND user_id=$2 AND read_at IS NULL
     RETURNING id`,
    [session.tenantId, session.userId]
  );
  return { updated: updated.rowCount ?? 0 };
}

// --- menções ---------------------------------------------------------------

// Valida que todos os mencionados são usuários ativos do MESMO tenant (membros
// ativos do workspace). Menção de outro tenant → 400.
async function assertMentionsInTenant(client: PoolClient, tenantId: string, mentions: string[]): Promise<void> {
  const unique = [...new Set(mentions)];
  if (!unique.length) return;
  const members = await client.query<{ id: string }>(
    `SELECT member.user_id id
     FROM workspace_members member
     JOIN users member_user ON member_user.id=member.user_id AND member_user.status='active'
     WHERE member.workspace_id=$1 AND member.status='active' AND member.user_id=ANY($2::uuid[])`,
    [tenantId, unique]
  );
  if (members.rows.length !== unique.length) {
    throw httpError(400, "Menção inválida: usuário não pertence à empresa ou está inativo");
  }
}

// Uma internal_notification tipo 'mention' por mencionado; o autor nunca se
// notifica (menção a si mesmo não cria evento).
async function insertMentionNotifications(
  client: PoolClient,
  tenantId: string,
  authorId: string,
  mentions: string[],
  noteBody: string,
  sourceId: string
): Promise<void> {
  const recipients = [...new Set(mentions)].filter((id) => id !== authorId);
  if (!recipients.length) return;
  await client.query(
    `INSERT INTO internal_notifications(tenant_id,user_id,type,title,body,source_type,source_id,actor_id)
     SELECT $1, recipient, 'mention', 'Você foi mencionado em uma nota interna', $3, 'internal_note', $4, $5
     FROM unnest($2::uuid[]) AS recipient`,
    [tenantId, recipients, noteBody.slice(0, 500), sourceId, authorId]
  );
}

async function loadMentionNames(connection: Pick<Pool | PoolClient, "query">, mentions: string[]) {
  const unique = [...new Set(mentions)];
  if (!unique.length) return new Map<string, string | null>();
  const rows = await connection.query<{ id: string; name: string }>(
    `SELECT id,name FROM users WHERE id=ANY($1::uuid[])`,
    [unique]
  );
  return new Map<string, string | null>(rows.rows.map((row) => [row.id, row.name]));
}

function mentionItems(mentions: string[], names: Map<string, string | null>) {
  return [...new Set(mentions)].map((id) => ({ id, name: names.get(id) ?? null }));
}

// --- notas de lead (fonte unificada: scheduling_lead_notes) ----------------

export async function listLeadNotes(tenantId: string, leadId: string): Promise<{ items: InternalNoteItem[] }> {
  // Append-only; mais recente primeiro, espelhando a ordem da timeline do lead
  // (índice 0034). Thread pode crescer: teto defensivo de 200 itens.
  const rows = await db.query<{
    id: string; body: string; author_id: string; author_name: string | null; mentions: string[] | null; created_at: Date;
  }>(
    `SELECT note.id,note.content body,note.author_user_id author_id,author.name author_name,note.mentions,note.created_at
     FROM scheduling_lead_notes note
     JOIN users author ON author.id=note.author_user_id
     WHERE note.tenant_id=$1 AND note.lead_id=$2
     ORDER BY note.created_at DESC,note.id DESC
     LIMIT 200`,
    [tenantId, leadId]
  );
  const names = await loadMentionNames(db, rows.rows.flatMap((row) => row.mentions ?? []));
  return {
    items: rows.rows.map((row) => ({
      id: row.id,
      body: row.body,
      author_id: row.author_id,
      author_name: row.author_name,
      mentions: mentionItems(row.mentions ?? [], names),
      created_at: row.created_at
    }))
  };
}

export async function createLeadNote(
  tenantId: string,
  leadId: string,
  actor: FollowUpActor,
  body: InternalNoteBody
): Promise<InternalNoteItem> {
  const mentions = body.mentions ?? [];
  return withTenantTransaction(db, tenantId, async (client) => {
    const lead = await client.query(
      "SELECT id FROM scheduling_leads WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
      [leadId, tenantId]
    );
    if (!lead.rows[0]) throw httpError(404, "Lead não encontrado");
    await assertMentionsInTenant(client, tenantId, mentions);
    const inserted = await client.query<{
      id: string; body: string; author_id: string; created_at: Date;
    }>(
      `INSERT INTO scheduling_lead_notes(tenant_id,lead_id,author_user_id,content,mentions)
       VALUES($1,$2,$3,$4,$5)
       RETURNING id,content body,author_user_id author_id,created_at`,
      [tenantId, leadId, actor.userId, body.body, [...new Set(mentions)]]
    );
    const note = inserted.rows[0];
    // Espelha os efeitos colaterais de addLeadNote (scheduling/service.ts) para
    // a timeline/auditoria continuarem coerentes com a fonte unificada.
    await client.query("UPDATE scheduling_leads SET updated_at=now() WHERE id=$1 AND tenant_id=$2", [leadId, tenantId]);
    await client.query(
      `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details)
       VALUES($1,$2,'nota_interna_adicionada',$3)`,
      [leadId, tenantId, { note_id: note.id, actor_user_id: actor.userId }]
    );
    await client.query(
      `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
       VALUES($1,$2,$3,'leads.follow_up.note.create','scheduling_lead',$4,$5,$6,$7)`,
      [actor.userId, tenantId, actor.actorScope, leadId, { note_id: note.id }, actor.ipAddress ?? null, actor.userAgent ?? null]
    );
    await insertMentionNotifications(client, tenantId, actor.userId, mentions, note.body, note.id);
    const [author, mentionNames] = await Promise.all([
      client.query<{ name: string | null }>("SELECT name FROM users WHERE id=$1", [actor.userId]),
      loadMentionNames(client, mentions)
    ]);
    return {
      id: note.id,
      body: note.body,
      author_id: note.author_id,
      author_name: author.rows[0]?.name ?? null,
      mentions: mentionItems(mentions, mentionNames),
      created_at: note.created_at
    };
  });
}

// --- notas de conversa (internal_notes, context_type='conversation') -------

export async function listConversationNotes(tenantId: string, conversationId: string): Promise<{ items: InternalNoteItem[] }> {
  const rows = await db.query<{
    id: string; body: string; author_id: string; author_name: string | null; mentions: string[] | null; created_at: Date;
  }>(
    `SELECT note.id,note.body,note.author_id,author.name author_name,note.mentions,note.created_at
     FROM internal_notes note
     JOIN users author ON author.id=note.author_id
     WHERE note.tenant_id=$1 AND note.context_type='conversation' AND note.context_id=$2
     ORDER BY note.created_at,note.id
     LIMIT 200`,
    [tenantId, conversationId]
  );
  const names = await loadMentionNames(db, rows.rows.flatMap((row) => row.mentions ?? []));
  return {
    items: rows.rows.map((row) => ({
      id: row.id,
      body: row.body,
      author_id: row.author_id,
      author_name: row.author_name,
      mentions: mentionItems(row.mentions ?? [], names),
      created_at: row.created_at
    }))
  };
}

export async function createConversationNote(
  tenantId: string,
  conversationId: string,
  actor: WorkspaceSession,
  body: InternalNoteBody
): Promise<InternalNoteItem> {
  const mentions = body.mentions ?? [];
  return withTenantTransaction(db, tenantId, async (client) => {
    const conversation = await client.query(
      "SELECT id FROM conversations WHERE id=$1 AND tenant_id=$2",
      [conversationId, tenantId]
    );
    if (!conversation.rows[0]) throw httpError(404, "Conversa não encontrada");
    await assertMentionsInTenant(client, tenantId, mentions);
    const inserted = await client.query<{
      id: string; body: string; author_id: string; created_at: Date;
    }>(
      `INSERT INTO internal_notes(tenant_id,context_type,context_id,author_id,body,mentions)
       VALUES($1,'conversation',$2,$3,$4,$5)
       RETURNING id,body,author_id,created_at`,
      [tenantId, conversationId, actor.userId, body.body, [...new Set(mentions)]]
    );
    const note = inserted.rows[0];
    await insertMentionNotifications(client, tenantId, actor.userId, mentions, note.body, note.id);
    const [author, mentionNames] = await Promise.all([
      client.query<{ name: string | null }>("SELECT name FROM users WHERE id=$1", [actor.userId]),
      loadMentionNames(client, mentions)
    ]);
    return {
      id: note.id,
      body: note.body,
      author_id: note.author_id,
      author_name: author.rows[0]?.name ?? null,
      mentions: mentionItems(mentions, mentionNames),
      created_at: note.created_at
    };
  });
}

// --- preferências de notificação (estende app.ts /me/notification-preferences)
// Handlers em app.ts passam a delegar aqui (patch entregue ao orquestrador).

export const notificationPreferencesPatchSchema = z.object({
  enabled: z.boolean().optional(),
  sound_enabled: z.boolean().optional(),
  visual_enabled: z.boolean().optional(),
  // Novidades R1: som selecionável e volume. Null explícito reseta para o
  // padrão do painel (coluna NULL); campo ausente mantém o atual.
  sound_key: z.string().trim().min(1).max(100).nullable().optional(),
  volume: z.number().int().min(0).max(100).nullable().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos uma preferência");

export async function loadPanelNotificationPreferences(session: WorkspaceSession) {
  const [preferences, muted] = await Promise.all([
    db.query<{ enabled: boolean; sound_enabled: boolean; visual_enabled: boolean; sound_key: string | null; volume: number | null }>(
      `SELECT enabled,sound_enabled,visual_enabled,sound_key,volume
       FROM panel_notification_preferences WHERE tenant_id=$1 AND user_id=$2`,
      [session.tenantId, session.userId]
    ),
    db.query<{ id: string; contact_name: string | null; contact_phone: string; muted_at: Date }>(
      `SELECT conversation.id,conversation.contact_name,conversation.contact_phone,mute.created_at muted_at
       FROM panel_notification_conversation_mutes mute
       JOIN conversations conversation
         ON conversation.id=mute.conversation_id AND conversation.tenant_id=mute.tenant_id
       WHERE mute.tenant_id=$1 AND mute.user_id=$2
       ORDER BY mute.created_at DESC`,
      [session.tenantId, session.userId]
    )
  ]);
  return {
    preferences: preferences.rows[0] ?? { enabled: true, sound_enabled: true, visual_enabled: true, sound_key: null, volume: null },
    muted_conversations: muted.rows
  };
}

export async function updatePanelNotificationPreferences(
  session: WorkspaceSession,
  body: z.infer<typeof notificationPreferencesPatchSchema>
) {
  const hasSoundKey = body.sound_key !== undefined;
  const hasVolume = body.volume !== undefined;
  const updated = await db.query<{
    enabled: boolean; sound_enabled: boolean; visual_enabled: boolean; sound_key: string | null; volume: number | null;
  }>(
    `INSERT INTO panel_notification_preferences(tenant_id,user_id,enabled,sound_enabled,visual_enabled,sound_key,volume)
     VALUES($1,$2,COALESCE($3,true),COALESCE($4,true),COALESCE($5,true),
       CASE WHEN $6 THEN $7::text END,
       CASE WHEN $8 THEN $9::smallint END)
     ON CONFLICT(tenant_id,user_id) DO UPDATE SET
       enabled=COALESCE($3,panel_notification_preferences.enabled),
       sound_enabled=COALESCE($4,panel_notification_preferences.sound_enabled),
       visual_enabled=COALESCE($5,panel_notification_preferences.visual_enabled),
       sound_key=CASE WHEN $6 THEN $7::text ELSE panel_notification_preferences.sound_key END,
       volume=CASE WHEN $8 THEN $9::smallint ELSE panel_notification_preferences.volume END,
       updated_at=now()
     RETURNING enabled,sound_enabled,visual_enabled,sound_key,volume`,
    [
      session.tenantId,
      session.userId,
      body.enabled ?? null,
      body.sound_enabled ?? null,
      body.visual_enabled ?? null,
      hasSoundKey,
      body.sound_key ?? null,
      hasVolume,
      body.volume ?? null
    ]
  );
  return { preferences: updated.rows[0] };
}

// --- aparência por usuário (R16) --------------------------------------------

export const appearancePreferencesPatchSchema = z.object({
  theme: z.enum(["light", "dark"]).nullable().optional(),
  accent: z.string().trim().min(1).max(64).nullable().optional(),
  density: z.enum(["comfortable", "compact"]).nullable().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Informe ao menos uma preferência");

export async function loadAppearancePreferences(session: WorkspaceSession) {
  const row = await db.query<{ theme: string | null; accent: string | null; density: string | null }>(
    `SELECT theme,accent,density FROM user_appearance_prefs WHERE tenant_id=$1 AND user_id=$2`,
    [session.tenantId, session.userId]
  );
  return row.rows[0] ?? { theme: null, accent: null, density: null };
}

export async function updateAppearancePreferences(
  session: WorkspaceSession,
  body: z.infer<typeof appearancePreferencesPatchSchema>
) {
  // Ausente = mantém; null explícito = reseta. A flag CASE distingue os dois.
  const updated = await db.query<{ theme: string | null; accent: string | null; density: string | null }>(
    `INSERT INTO user_appearance_prefs(tenant_id,user_id,theme,accent,density)
     VALUES($1,$2,
       CASE WHEN $3 THEN $4::text END,
       CASE WHEN $5 THEN $6::text END,
       CASE WHEN $7 THEN $8::text END)
     ON CONFLICT(tenant_id,user_id) DO UPDATE SET
       theme=CASE WHEN $3 THEN $4::text ELSE user_appearance_prefs.theme END,
       accent=CASE WHEN $5 THEN $6::text ELSE user_appearance_prefs.accent END,
       density=CASE WHEN $7 THEN $8::text ELSE user_appearance_prefs.density END,
       updated_at=now()
     RETURNING theme,accent,density`,
    [
      session.tenantId,
      session.userId,
      body.theme !== undefined,
      body.theme ?? null,
      body.accent !== undefined,
      body.accent ?? null,
      body.density !== undefined,
      body.density ?? null
    ]
  );
  return updated.rows[0];
}