import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MessageGateway, MessagingCapabilityFlags } from "../messages/types.js";
import { requirePermission } from "../../auth/session.js";
import { leadScopeCondition, resolveCaseScope } from "../../auth/case-scope.js";
import { db } from "../../db/client.js";
import { uuid, withTransaction } from "../scheduling/service.js";
import { MessageRepository } from "../messages/repository.js";
import { idempotencyKeySchema } from "../messages/idempotency.js";
import { QualificationService } from "../qualification/service.js";
import { WhatsAppSendRejectedError } from "../whatsapp/errors.js";

/**
 * B7/B8 (SPEC v7) — capacidades de mensageria por sessão e abertura de
 * conversa outbound. Toda a fronteira de provider é o MessageGateway: nenhuma
 * rota deste módulo conhece Evolution/Cloud API diretamente.
 */
export async function registerMessagingRoutes(app: FastifyInstance, options: { gateway: MessageGateway }) {
  const service = new QualificationService();

  app.get("/me/messaging-capabilities", async (request) => {
    const session = await requirePermission(request, "conversations.read");
    const rows = await db.query<{ id: string; label: string | null; phone_number: string | null; status: string }>(
      `SELECT id,label,phone_number,status FROM whatsapp_sessions
       WHERE tenant_id=$1 AND channel='whatsapp' AND archived_at IS NULL
       ORDER BY is_primary DESC, created_at DESC`, [session.tenantId]);
    const sessions = [];
    for (const row of rows.rows) {
      let capabilities: MessagingCapabilityFlags = { reactions: false, forward_media: false, interactive: false };
      try { // captura degradada: erro ao derivar flags → all-false, nunca 500
        capabilities = (await options.gateway.sessionMessagingCapabilities?.(row.id)) ?? capabilities;
      } catch { /* degradado */ }
      sessions.push({ session_id: row.id, label: row.label, phone_number: row.phone_number, status: row.status, capabilities });
    }
    return { sessions };
  });

  app.post("/conversations/initiate", async (request, reply) => {
    const session = await requirePermission(request, "conversations.reply");
    const body = z.object({ lead_id: uuid, session_id: uuid, text: z.string().trim().min(1).max(4_000) }).strict().parse(request.body);
    const idempotencyKey = idempotencyKeySchema.parse(request.headers["idempotency-key"]);
    const scope = await resolveCaseScope(db, session);
    const lead = await db.query<{ id: string; phone: string; name: string | null }>(
      `SELECT lead.id,lead.phone,lead.name FROM scheduling_leads lead
       WHERE lead.tenant_id=$1 AND lead.id=$2 AND lead.deleted_at IS NULL
         AND (${leadScopeCondition(scope, "lead", "$3")})`, [session.tenantId, body.lead_id, scope.memberId]);
    if (!lead.rows[0]) return reply.status(404).send({ error: "Lead não encontrado" });
    const leadRow = lead.rows[0];
    const connection = await db.query<{ id: string; status: string }>(
      `SELECT id,status FROM whatsapp_sessions WHERE tenant_id=$1 AND id=$2 AND channel='whatsapp' AND archived_at IS NULL`,
      [session.tenantId, body.session_id]);
    if (!connection.rows[0]) return reply.status(404).send({ error: "Conexão WhatsApp não encontrada" });
    if (connection.rows[0].status !== "connected") return reply.status(409).send({ error: "A conexão do WhatsApp está desconectada" });
    const upserted = await withTransaction(async (client) => client.query<{ id: string; created: boolean }>(
      `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,assigned_user_id) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id,session_id,contact_phone) DO UPDATE
         SET ai_active=false,handoff_reason='manually_paused',handoff_error_code=NULL,assigned_user_id=$5
       RETURNING id,(xmax=0) AS created`,
      [session.tenantId, body.session_id, leadRow.phone, leadRow.name, session.userId]));
    const conversation = upserted.rows[0];
    await service.pauseForConversation(session.tenantId, conversation.id, "manually_paused"); // APÓS a tx
    const repository = new MessageRepository(db);
    try {
      const sent = await repository.sendManualMessageOnce({
        tenantId: session.tenantId, conversationId: conversation.id, sessionId: body.session_id,
        contactPhone: leadRow.phone, text: body.text, idempotencyKey, sentByUserId: session.userId
      }, () => options.gateway.sendText(body.session_id, leadRow.phone, body.text));
      return reply.status(conversation.created ? 201 : 200)
        .send({ conversation_id: conversation.id, lead_id: leadRow.id, sent: true, externalId: sent.externalId, duplicate: sent.duplicate });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const rejected = err instanceof WhatsAppSendRejectedError;
      const existing = typeof (err as { statusCode?: unknown }).statusCode === "number" ? ((err as unknown as { statusCode: number }).statusCode) : undefined;
      if (conversation.created && (rejected || existing !== 409)) { // 409 de idempotência não apaga (pedido gêmeo em andamento)
        await db.query(
          `DELETE FROM conversations c WHERE c.tenant_id=$1 AND c.id=$2
           AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.tenant_id=$1)`,
          [session.tenantId, conversation.id]);
      }
      throw Object.assign(
        rejected
          ? new Error(`O WhatsApp recusou o envio da mensagem: ${err.message}`)
          : err,
        { statusCode: rejected ? 409 : existing ?? 502 }
      );
    }
  });
}
