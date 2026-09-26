import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { requirePermission } from "../../auth/session.js";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { withTransaction } from "../../db/transaction.js";
import { decryptSecret, encryptSecret } from "../ai-router/secret-box.js";
import {
  createGoogleCalendarClient,
  createGoogleCalendarOAuthClient,
  GoogleCalendarConfigurationError
} from "./google-calendar.js";
import { httpError } from "./service.js";

// OAuth e cliente HTTP do Google vivem no irmão google-calendar.ts (mesmo client_id do Meet,
// spec: nenhuma credencial nova). Aqui ficam apenas as rotas e o estado no banco.

export function googleCalendarOAuthConfigured(): boolean {
  return Boolean(config.GOOGLE_MEET_OAUTH_CLIENT_ID?.trim() && config.GOOGLE_MEET_OAUTH_CLIENT_SECRET?.trim());
}

// URI de callback REAL da API: o proxy público mapeia {PANEL_PUBLIC_URL}/api → backend removendo
// o prefixo (deploy/nginx/atendon.conf location /api/; rewrites panelProxyPaths em
// apps/panel/next.config.ts; compose define NEXT_PUBLIC_API_BASE_URL=/api). PANEL_PUBLIC_URL + rota
// nua cairia no painel, não na API. Quem registrar outro URI no Google Cloud Console precisa de uma
// chave de config dedicada em config.ts — não de env cru lido aqui.
function googleCalendarOAuthRedirectUri(): string {
  return new URL("/api/scheduling/google-calendar/oauth/callback", config.PANEL_PUBLIC_URL).toString();
}

type GoogleCalendarOAuthExchange = { email: string; refreshToken: string };

type ConnectionRow = {
  id: string;
  member_id: string;
  google_email: string;
  refresh_token_encrypted: string;
};

// Metadados expostos ao painel — refresh_token_encrypted fica de fora sempre.
type ConnectionMeta = {
  id: string;
  member_id: string;
  google_email: string;
  calendar_id: string | null;
  calendar_name: string | null;
  calendar_timezone: string | null;
  buffer_minutes: number;
  connected_at: Date;
};

const CONNECTION_META_SELECT = `SELECT id,member_id,google_email,calendar_id,calendar_name,calendar_timezone,buffer_minutes,connected_at
  FROM scheduling_calendar_connections`;

function connectionPayload(row: ConnectionMeta) {
  return {
    id: row.id,
    member_id: row.member_id,
    email: row.google_email,
    calendar_id: row.calendar_id,
    calendar_name: row.calendar_name,
    calendar_timezone: row.calendar_timezone,
    buffer_minutes: row.buffer_minutes,
    connected_at: row.connected_at.toISOString(),
    // Só calendar_id selecionado habilita sincronização.
    configured: Boolean(row.calendar_id)
  };
}

async function loadConnection(tenantId: string, connectionId: string): Promise<ConnectionRow> {
  const row = (await db.query<ConnectionRow>(
    `SELECT id,member_id,google_email,refresh_token_encrypted
     FROM scheduling_calendar_connections WHERE tenant_id=$1 AND id=$2`,
    [tenantId, connectionId]
  )).rows[0];
  if (!row) throw httpError(404, "Conexão não encontrada");
  return row;
}

function calendarClient() {
  if (!googleCalendarOAuthConfigured()) throw new GoogleCalendarConfigurationError();
  return createGoogleCalendarClient();
}

// Keyring {current, previous} (mesmo contrato de calendar-booking/calendar-sync):
// tokens gravados antes da rotação continuam legíveis nas rotas do painel.
function connectionRefreshToken(connection: ConnectionRow): string {
  return decryptSecret(connection.refresh_token_encrypted, {
    current: config.DATA_ENCRYPTION_KEY,
    previous: config.DATA_ENCRYPTION_KEY_PREVIOUS ? [config.DATA_ENCRYPTION_KEY_PREVIOUS] : []
  });
}

async function memberIsActive(tenantId: string, memberId: string): Promise<boolean> {
  return Boolean((await db.query(
    "SELECT 1 FROM workspace_members WHERE id=$1 AND workspace_id=$2 AND status='active'",
    [memberId, tenantId]
  )).rows[0]);
}

// Guarda compartilhada de desconexão/reconexão: nenhuma operação que mate a
// credencial da conexão pode rodar com sync em voo (claim na outbox) ou
// pendência ligada a ela — o worker sem token marca o vínculo como órfão e o
// evento remoto fica no Google para sempre. 409 preserva o estado atual.
// ponytail: complete() do worker segura a linha da outbox e pede KEY SHARE do
// tenant/conexão no INSERT do vínculo — janela de ms pode dar deadlock (o
// Postgres aborta um lado; sem corrupção, retry resolve).
async function assertCalendarSyncSettled(client: PoolClient, tenantId: string, connectionId: string): Promise<void> {
  const claimedRows = await client.query<{ claimed_at: Date | null }>(
    "SELECT claimed_at FROM scheduling_calendar_sync_outbox WHERE tenant_id=$1 FOR UPDATE",
    [tenantId]
  );
  if (claimedRows.rows.some((row) => row.claimed_at !== null)) {
    throw httpError(409, "Sincronização com o Google em andamento. Aguarde alguns instantes e tente novamente.");
  }
  const blocked = (await client.query<{ blocked: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM scheduling_appointment_calendar_events e
       JOIN scheduling_appointments a
         ON a.id=e.appointment_id AND a.tenant_id=e.tenant_id
       LEFT JOIN scheduling_calendar_sync_outbox ob
         ON ob.appointment_id=e.appointment_id AND ob.tenant_id=e.tenant_id
       WHERE e.tenant_id=$1 AND e.connection_id=$2
         AND (
           (a.start_at > now() AND a.status IN ('confirmado','reagendado'))
           OR ob.appointment_id IS NOT NULL
         )
     ) AS blocked`,
    [tenantId, connectionId]
  )).rows[0]!.blocked;
  if (blocked) {
    throw httpError(
      409,
      "Existem agendamentos vinculados a esta conexão com sincronização pendente. Cancele os agendamentos futuros ou aguarde a sincronização concluir antes de desconectar."
    );
  }
}

async function connectGoogleCalendar(tenantId: string, memberId: string, identity: GoogleCalendarOAuthExchange): Promise<void> {
  // Reconexão volta a "sem agenda selecionada" — só calendar_id escolhido sincroniza.
  // Mesma guarda do disconnect: reconectar sobrescreve o refresh_token; com sync
  // em voo/pendente isso revogaria a credencial que o worker precisa para apagar
  // eventos remotos → órfãos silenciosos. 409 preserva a auth antiga; o callback
  // do OAuth converte em redirect calendar_oauth=error (sem expor token).
  await withTransaction(db, async (client) => {
    await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [tenantId]);
    const existing = (await client.query<{ id: string }>(
      "SELECT id FROM scheduling_calendar_connections WHERE tenant_id=$1 AND member_id=$2 FOR UPDATE",
      [tenantId, memberId]
    )).rows[0];
    if (existing) await assertCalendarSyncSettled(client, tenantId, existing.id);
    await client.query(
      `INSERT INTO scheduling_calendar_connections(tenant_id,member_id,google_email,refresh_token_encrypted)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(tenant_id,member_id) DO UPDATE SET
         google_email=EXCLUDED.google_email,
         refresh_token_encrypted=EXCLUDED.refresh_token_encrypted,
         calendar_id=NULL, calendar_name=NULL, calendar_timezone=NULL,
         connected_at=now(), updated_at=now()`,
      [tenantId, memberId, identity.email, encryptSecret(identity.refreshToken, config.DATA_ENCRYPTION_KEY)]
    );
  });
}

async function existsInTenant(table: string, tenantId: string, id: string): Promise<boolean> {
  // table vem de literais nas chamadas abaixo, nunca de input do usuário.
  return Boolean((await db.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1 AND id=$2`, [tenantId, id])).rows[0]);
}

// Enfileira na MESMA transação da mudança os agendamentos FUTUROS e ATIVOS
// afetados: sem isso uma conexão/rota nova nunca alcançaria agendamentos já
// existentes (o gatilho 0189 só enfileira mutações do próprio agendamento).
// claimed_at é preservado no conflito — mutação durante sync em voo não limpa
// a tentativa atual (mesma semântica do gatilho 0189).
function enqueueCalendarSyncSql(match: string): string {
  return `
    INSERT INTO scheduling_calendar_sync_outbox(appointment_id,tenant_id,kind,available_at,attempts,last_error,claimed_at)
    SELECT a.id,a.tenant_id,'upsert',now(),0,NULL,NULL
    FROM scheduling_appointments a
    JOIN scheduling_leads lead ON lead.id=a.lead_id AND lead.tenant_id=a.tenant_id
    LEFT JOIN pipeline_stages stage ON stage.id=lead.pipeline_stage_id AND stage.tenant_id=a.tenant_id
    LEFT JOIN scheduling_pipeline_calendar_routes route
      ON route.tenant_id=a.tenant_id AND route.pipeline_id=stage.pipeline_id
    WHERE a.tenant_id=$1 AND a.start_at>now()
      AND a.status IN ('confirmado','reagendado')
      AND (${match})
    ON CONFLICT (appointment_id,tenant_id) DO UPDATE
      SET kind=EXCLUDED.kind,available_at=EXCLUDED.available_at,attempts=0,last_error=NULL`;
}

// Agenda de pipelines roteados para a conexão + agendamentos do dono da conexão
// (mesmo emparelhamento que o worker usa: rota explícita primeiro, senão o dono).
async function enqueueConnectionSync(client: PoolClient, tenantId: string, connectionId: string, memberId: string): Promise<void> {
  await client.query(enqueueCalendarSyncSql("route.connection_id=$2 OR a.assigned_member_id=$3"), [tenantId, connectionId, memberId]);
}

async function enqueuePipelineSync(client: PoolClient, tenantId: string, pipelineId: string): Promise<void> {
  await client.query(enqueueCalendarSyncSql("stage.pipeline_id=$2"), [tenantId, pipelineId]);
}

const idParams = z.object({ id: z.string().uuid() });
const pipelineIdParams = z.object({ pipelineId: z.string().uuid() });
const memberIdQuery = z.object({ member_id: z.string().uuid() });
const calendarBody = z.object({ calendar_id: z.string().trim().min(1).max(1_024) }).strict();
// 0186: buffer_minutes 0..240 (0 = desligado); o CHECK do banco repete.
const bufferBody = z.object({ buffer_minutes: z.number().int().min(0).max(240) }).strict();
const routeBody = z.object({
  pipeline_id: z.string().uuid(),
  team_id: z.string().uuid().nullable().optional(),
  connection_id: z.string().uuid().nullable().optional()
}).strict().refine(
  (value) => ((value.team_id ?? null) === null) !== ((value.connection_id ?? null) === null),
  { message: "Escolha exatamente um destino: equipe ou conexão", path: ["team_id"] }
);

export async function registerGoogleCalendarRoutes(app: FastifyInstance) {
  app.get("/scheduling/google-calendar/connections", async (request) => {
    const session = await requirePermission(request, "units.read");
    const rows = await db.query<ConnectionMeta>(
      `${CONNECTION_META_SELECT} WHERE tenant_id=$1 ORDER BY connected_at,id`,
      [session.tenantId]
    );
    return {
      configured: googleCalendarOAuthConfigured(),
      connections: rows.rows.map(connectionPayload)
    };
  });

  app.get("/scheduling/google-calendar/connections/:id", async (request) => {
    const session = await requirePermission(request, "units.read");
    const { id } = idParams.parse(request.params);
    const row = (await db.query<ConnectionMeta>(
      `${CONNECTION_META_SELECT} WHERE tenant_id=$1 AND id=$2`,
      [session.tenantId, id]
    )).rows[0];
    if (!row) throw httpError(404, "Conexão não encontrada");
    // Metadados apenas: refresh_token_encrypted nunca sai do banco.
    return { connection: connectionPayload(row) };
  });

  app.get("/scheduling/google-calendar/oauth/start", async (request) => {
    const session = await requirePermission(request, "units.manage");
    const { member_id } = memberIdQuery.parse(request.query);
    if (!await memberIsActive(session.tenantId, member_id)) throw httpError(404, "Membro não encontrado");
    const nonce = randomBytes(32).toString("base64url");
    // authorizationUrl falha fechada (503) ANTES de gravar o nonce no banco.
    const authorizationUrl = createGoogleCalendarOAuthClient().authorizationUrl(nonce, googleCalendarOAuthRedirectUri());
    await db.query(
      `INSERT INTO scheduling_calendar_oauth_states(nonce,tenant_id,user_id,member_id,expires_at)
       VALUES($1,$2,$3,$4,now() + interval '10 minutes')`,
      [nonce, session.tenantId, session.userId, member_id]
    );
    return { authorization_url: authorizationUrl };
  });

  app.get("/scheduling/google-calendar/oauth/callback", async (request, reply) => {
    const session = await requirePermission(request, "units.manage");
    const query = z.object({
      code: z.string().min(1).optional(),
      state: z.string().min(1).optional(),
      error: z.string().optional()
    }).parse(request.query);
    // Painel de Calendar é a rota aninhada /configuracoes/google-calendar (o
    // [resource] dinâmico só renderiza chaves válidas, google-calendar incluída).
    const returnUrl = new URL("/configuracoes/google-calendar", config.PANEL_PUBLIC_URL);
    if (!query.state) {
      returnUrl.searchParams.set("calendar_oauth", "denied");
      return reply.redirect(returnUrl.toString());
    }
    // Consome o nonce atomicamente ANTES do erro do OAuth também (one-time use).
    const state = (await db.query<{ member_id: string }>(
      `UPDATE scheduling_calendar_oauth_states SET used_at=now()
       WHERE nonce=$1 AND tenant_id=$2 AND user_id=$3 AND used_at IS NULL AND expires_at>now()
       RETURNING member_id`,
      [query.state, session.tenantId, session.userId]
    )).rows[0];
    if (query.error || !query.code || !state) {
      returnUrl.searchParams.set("calendar_oauth", "denied");
      return reply.redirect(returnUrl.toString());
    }
    // Membro desativado enquanto o OAuth ficou no Google (mesma regra do
    // /oauth/start): não criar conexão para membro inativo.
    if (!await memberIsActive(session.tenantId, state.member_id)) {
      returnUrl.searchParams.set("calendar_oauth", "error");
      return reply.redirect(returnUrl.toString());
    }
    try {
      const identity = await createGoogleCalendarOAuthClient().exchangeCode(query.code, googleCalendarOAuthRedirectUri());
      await connectGoogleCalendar(session.tenantId, state.member_id, identity);
      returnUrl.searchParams.set("calendar_oauth", "connected");
    } catch (error) {
      // Nunca loga token/código: o erro genérico não carrega segredos.
      request.log.warn({ err: error }, "Google Calendar OAuth callback failed");
      returnUrl.searchParams.set("calendar_oauth", "error");
    }
    return reply.redirect(returnUrl.toString());
  });

  app.get("/scheduling/google-calendar/connections/:id/calendars", async (request) => {
    const session = await requirePermission(request, "units.manage");
    const { id } = idParams.parse(request.params);
    const connection = await loadConnection(session.tenantId, id);
    // minAccessRole=writer vem do servidor Google; a lista já só traz agendas graváveis.
    const calendars = await calendarClient().listCalendars(connectionRefreshToken(connection));
    return { calendars: calendars.map((calendar) => ({
      id: calendar.id, name: calendar.name, timezone: calendar.timeZone, primary: calendar.primary
    })) };
  });

  app.put("/scheduling/google-calendar/connections/:id/calendar", async (request) => {
    const session = await requirePermission(request, "units.manage");
    const { id } = idParams.parse(request.params);
    const { calendar_id } = calendarBody.parse(request.body);
    const connection = await loadConnection(session.tenantId, id);
    const chosen = (await calendarClient().listCalendars(connectionRefreshToken(connection))).find((calendar) => calendar.id === calendar_id);
    if (!chosen) throw httpError(400, "Calendário inválido ou sem permissão de escrita");
    // Google HTTP fora da transação; UPDATE + enfileiramento dos agendamentos
    // afetados são atômicos (mesma transação).
    return withTransaction(db, async (client) => {
      const previous = (await client.query<{ calendar_id: string | null }>(
        "SELECT calendar_id FROM scheduling_calendar_connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [session.tenantId, id]
      )).rows[0];
      if (!previous) throw httpError(404, "Conexão não encontrada");
      const updated = await client.query<{
        calendar_id: string; calendar_name: string | null; calendar_timezone: string | null;
      }>(
        `UPDATE scheduling_calendar_connections
         SET calendar_id=$3, calendar_name=$4, calendar_timezone=$5, updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING calendar_id,calendar_name,calendar_timezone`,
        [session.tenantId, id, chosen.id, chosen.name, chosen.timeZone]
      );
      // Seleção/reseleção de agenda: conexão antes dessincronizada começa a
      // sincronizar os agendamentos já existentes; troca reprocessa os atuais.
      if (previous.calendar_id !== chosen.id) {
        await enqueueConnectionSync(client, session.tenantId, id, connection.member_id);
      }
      return { calendar: {
        id: updated.rows[0]!.calendar_id,
        name: updated.rows[0]!.calendar_name,
        timezone: updated.rows[0]!.calendar_timezone
      } };
    });
  });

  app.patch("/scheduling/google-calendar/connections/:id/buffer", async (request) => {
    const session = await requirePermission(request, "units.manage");
    const { id } = idParams.parse(request.params);
    const { buffer_minutes } = bufferBody.parse(request.body);
    // Buffer muda só a janela de freeBusy (0186): o evento remoto não depende
    // dele, nada a enfileirar no outbox.
    const updated = await db.query<{ buffer_minutes: number }>(
      `UPDATE scheduling_calendar_connections
       SET buffer_minutes=$3, updated_at=now()
       WHERE tenant_id=$1 AND id=$2
       RETURNING buffer_minutes`,
      [session.tenantId, id, buffer_minutes]
    );
    if (!updated.rowCount) throw httpError(404, "Conexão não encontrada");
    return { buffer_minutes: updated.rows[0]!.buffer_minutes };
  });

  app.delete("/scheduling/google-calendar/connections/:id", async (request) => {
    const session = await requirePermission(request, "units.manage");
    const { id } = idParams.parse(request.params);
    // Fail-safe ANTES do DELETE: o FK dos vínculos é ON DELETE SET NULL
    // (connection_id) e o worker (calendar-sync) sem token não apaga o evento
    // remoto — desconectar com sync em voo/pendente deixava reuniões órfãs no
    // Google em silêncio. Ordem de locks: tenants → conexão → outbox (linha
    // pai primeiro, como em routes.ts): tenant trava INSERT com FK ao tenant
    // (vínculo/outbox/agendamento novo não nascem no meio do cheque);
    // conexão serializa DELETEs concorrentes e faz o INSERT de vínculo de um
    // worker em voo esperar o FK (link confirmado antes → 409; delete
    // commitado antes → FK 23503 ruidosa no worker, retry drena); outbox
    // impede claim novo durante o cheque. A guarda em si (claim em voo +
    // vínculo futuro ativo/pendente) vive em assertCalendarSyncSettled,
    // compartilhada com a reconexão.
    // Consequência documentada do caminho normal: agendamento passado sem
    // pendência não bloqueia e o vínculo vira órfão por FK — o evento antigo
    // permanece no Google (worker marca "vínculo órfão" sem token para
    // apagá-lo); órfão histórico é intencional.
    return withTransaction(db, async (client) => {
      await client.query("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [session.tenantId]);
      const locked = (await client.query(
        "SELECT id FROM scheduling_calendar_connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [session.tenantId, id]
      )).rows[0];
      if (!locked) throw httpError(404, "Conexão não encontrada");
      await assertCalendarSyncSettled(client, session.tenantId, id);
      await client.query(
        "DELETE FROM scheduling_calendar_connections WHERE tenant_id=$1 AND id=$2",
        [session.tenantId, id]
      );
      // Não usa nem apaga o token global do Meet; histórico passado vira órfão por FK.
      return { disconnected: true };
    });
  });

  app.get("/scheduling/google-calendar/routes", async (request) => {
    const session = await requirePermission(request, "units.read");
    const rows = await db.query<{ pipeline_id: string; team_id: string | null; connection_id: string | null }>(
      `SELECT pipeline_id,team_id,connection_id FROM scheduling_pipeline_calendar_routes
       WHERE tenant_id=$1 ORDER BY pipeline_id`,
      [session.tenantId]
    );
    return { routes: rows.rows };
  });

  app.put("/scheduling/google-calendar/routes", async (request) => {
    const session = await requirePermission(request, "units.manage");
    const body = routeBody.parse(request.body);
    const teamId = body.team_id ?? null;
    const connectionId = body.connection_id ?? null;
    if (!await existsInTenant("pipelines", session.tenantId, body.pipeline_id)) throw httpError(404, "Pipeline não encontrado");
    if (teamId && !await existsInTenant("teams", session.tenantId, teamId)) throw httpError(404, "Equipe não encontrada");
    if (connectionId) {
      const connection = (await db.query<{ calendar_id: string | null }>(
        "SELECT calendar_id FROM scheduling_calendar_connections WHERE tenant_id=$1 AND id=$2",
        [session.tenantId, connectionId]
      )).rows[0];
      if (!connection) throw httpError(404, "Conexão não encontrada");
      // Sem agenda selecionada (ex.: reconexão limpa o calendar_id) a rota
      // deixaria os eventos do pipeline sem destino observável — e o worker
      // nunca cai para o calendário de terceiro do assignee. Recusa antes.
      if (!connection.calendar_id) {
        throw httpError(409, "Conexão sem agenda selecionada; selecione a agenda antes de rotear");
      }
    }
    return withTransaction(db, async (client) => {
      const previous = (await client.query<{ team_id: string | null; connection_id: string | null }>(
        "SELECT team_id,connection_id FROM scheduling_pipeline_calendar_routes WHERE tenant_id=$1 AND pipeline_id=$2 FOR UPDATE",
        [session.tenantId, body.pipeline_id]
      )).rows[0] ?? null;
      const row = (await client.query<{ team_id: string | null; connection_id: string | null }>(
        `INSERT INTO scheduling_pipeline_calendar_routes(tenant_id,pipeline_id,team_id,connection_id)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(tenant_id,pipeline_id) DO UPDATE SET
           team_id=EXCLUDED.team_id, connection_id=EXCLUDED.connection_id, updated_at=now()
         RETURNING team_id,connection_id`,
        [session.tenantId, body.pipeline_id, teamId, connectionId]
      )).rows[0]!;
      // Mudança de rota muda o destino dos agendamentos existentes do pipeline;
      // salvar o MESMO destino é no-op: nada a reprocessar.
      if (!previous || previous.team_id !== teamId || previous.connection_id !== connectionId) {
        await enqueuePipelineSync(client, session.tenantId, body.pipeline_id);
      }
      return { route: { pipeline_id: body.pipeline_id, team_id: row.team_id, connection_id: row.connection_id } };
    });
  });

  app.delete("/scheduling/google-calendar/routes/:pipelineId", async (request) => {
    const session = await requirePermission(request, "units.manage");
    const { pipelineId } = pipelineIdParams.parse(request.params);
    return withTransaction(db, async (client) => {
      const deleted = await client.query(
        "DELETE FROM scheduling_pipeline_calendar_routes WHERE tenant_id=$1 AND pipeline_id=$2",
        [session.tenantId, pipelineId]
      );
      if (!deleted.rowCount) throw httpError(404, "Rota não encontrada");
      // Sem rota, o destino volta ao responsável: agendamentos existentes reprocessam.
      await enqueuePipelineSync(client, session.tenantId, pipelineId);
      return { deleted: true };
    });
  });
}
