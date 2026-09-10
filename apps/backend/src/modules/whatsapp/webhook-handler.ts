import { timingSafeEqual } from "node:crypto";
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config.js";
import { db as defaultDb } from "../../db/client.js";
import { SessionRepository } from "./session-repository.js";
import { parseEvolutionEvent, evolutionContactUpdates, evolutionMessage, evolutionMessageStatusUpdates, evolutionPresenceUpdates, evolutionStickerMessage } from "./evolution-webhook.js";
import { MessageRepository } from "../messages/repository.js";
import { AiFollowUpRepository } from "../messages/ai-follow-up.js";
import { enqueueInbound } from "../../queue/message-queue.js";
import { loadBusinessHoursConfig, isWithinBusinessHours, nextBusinessHoursStart } from "./business-hours.js";
import { StickerRepository } from "../stickers/repository.js";
import type { WhatsAppSessionManager } from "./session-manager.js";
export type EvolutionWebhookDeps = { db?: typeof defaultDb; whatsapp: WhatsAppSessionManager; log: FastifyBaseLogger };
function secretMatches(received: unknown, expected: string): boolean { if (typeof received !== "string") return false; const a=Buffer.from(received), b=Buffer.from(expected); return a.length===b.length && timingSafeEqual(a,b); }

export async function handleEvolutionWebhook(request: FastifyRequest, reply: FastifyReply, deps: EvolutionWebhookDeps) {
    if (!secretMatches(request.headers["x-atendon-webhook-secret"], config.EVOLUTION_WEBHOOK_SECRET)) {
      return reply.status(401).send({ error: "Webhook inválido" });
    }
    const event = parseEvolutionEvent(request.body);
    if (!event) return reply.status(400).send({ error: "Evento inválido" });
    const repository = new SessionRepository(deps.db ?? defaultDb);
    const identity = await repository.findByInstance(event.instanceName);
    if (identity?.archivedAt) {
      // 204 (não 404) para a Evolution não reagendar entrega de uma instância
      // que a empresa já removeu. Perder esses eventos é o comportamento correto.
      deps.log.info({ instance: event.instanceName }, "Evento de instância arquivada descartado");
      return reply.status(204).send();
    }
    if (!identity) return reply.status(404).send({ error: "Instância desconhecida" });

    deps.log.info({ event: event.event, instance: event.instanceName, dataKeys: Object.keys(event.data) }, "Evolution webhook received");

    // SEND_MESSAGE is emitted for messages sent through our own API call. Processing
    // it as a linked-device message duplicates agent replies and pollutes AI history.
    if (event.event === "MESSAGES_UPSERT") {
      const sticker = evolutionStickerMessage(event.data);
      if (sticker?.fromMe) {
        try {
          const media = await deps.whatsapp.downloadMedia(identity.id, sticker.externalId);
          await new StickerRepository(deps.db ?? defaultDb).importWhatsAppSticker({
            tenantId: identity.tenantId,
            sessionId: identity.id,
            externalId: sticker.externalId,
            dataBase64: media.base64
          });
        } catch (error) {
          deps.log.warn({ err: error, tenantId: identity.tenantId, sessionId: identity.id, externalId: sticker.externalId }, "Could not import WhatsApp sticker into AI library");
        }
      }
      const message = evolutionMessage(event.data, { tenantId: identity.tenantId, sessionId: identity.id });
      if (message) {
        await new AiFollowUpRepository(deps.db ?? defaultDb).cancelForContact(
          message.tenantId,
          message.contactPhone,
          message.kind === "human" ? "human_intervened" : "contact_replied"
        );
        // Fora do horário comercial o lead não é respondido: o job de resposta
        // fica agendado para o próximo início de expediente, com jitter para o
        // acúmulo da madrugada não ser processado todo no mesmo instante. A
        // mensagem em si é gravada na hora (claim:false) para aparecer pro
        // humano no painel; só a resposta automática da IA espera o expediente.
        // ponytail: jitter simples (0-10min); um sequenciador por tenant seria o upgrade se precisar de ordem estrita.
        let delayMs = 0;
        if (message.kind === "contact") {
          const hours = await loadBusinessHoursConfig(deps.db ?? defaultDb, message.tenantId);
          const now = new Date();
          if (!isWithinBusinessHours(now, hours)) {
            const start = nextBusinessHoursStart(now, hours);
            delayMs = (start.getTime() - now.getTime()) + Math.floor(Math.random() * 10 * 60_000);
            await new MessageRepository(deps.db ?? defaultDb).recordInboundAndLoadContext(message, { claim: false });
          }
        }
        await enqueueInbound(message, delayMs);
      }
    } else if (event.event === "MESSAGES_UPDATE") {
      const messageRepository = new MessageRepository(deps.db ?? defaultDb);
      const updates = evolutionMessageStatusUpdates(event.data);
      deps.log.info({ tenantId: identity.tenantId, sessionId: identity.id, count: updates.length }, "Evolution message statuses parsed");
      for (const update of updates) {
        const statusChanged = await messageRepository.updateMessageStatus({
          tenantId: identity.tenantId,
          sessionId: identity.id,
          externalId: update.externalId,
          status: update.status
        });
        if (update.failed && update.fromMe !== false && statusChanged) {
          deps.log.warn({ tenantId: identity.tenantId, sessionId: identity.id, externalId: update.externalId }, "WhatsApp rejected outbound message (ack ERROR)");
          await messageRepository.createSystemAlertOnce(
            identity.tenantId,
            "O WhatsApp rejeitou uma mensagem. Revise a conversa antes de qualquer reenvio e não reconecte uma instância que esteja saudável."
          );
        } else if (update.failed && update.fromMe !== false) {
          deps.log.info(
            { tenantId: identity.tenantId, sessionId: identity.id, externalId: update.externalId },
            "Ignored stale WhatsApp ERROR ack after a newer delivery status"
          );
        }
      }
    } else if (event.event === "CONTACTS_UPSERT" || event.event === "CONTACTS_UPDATE") {
      const updates = evolutionContactUpdates(event.data);
      for (const update of updates) {
        await (deps.db ?? defaultDb).query(
          `UPDATE conversations SET
             contact_jid=COALESCE(contact_jid,$4),
             contact_avatar_url=$5,
             contact_avatar_updated_at=now()
           WHERE tenant_id=$1 AND session_id=$2
             AND (contact_jid=$4 OR regexp_replace(contact_phone,'\\D','','g')=regexp_replace($3,'\\D','','g'))`,
          [identity.tenantId, identity.id, update.contactPhone, update.contactJid, update.avatarUrl]
        );
      }
    } else if (event.event === "PRESENCE_UPDATE") {
      const updates = evolutionPresenceUpdates(event.data);
      for (const update of updates) {
        await (deps.db ?? defaultDb).query(
          `UPDATE conversations SET
             contact_jid=COALESCE(contact_jid,$4),
             contact_presence=$5,
             contact_presence_updated_at=now(),
             contact_last_seen_at=CASE
               WHEN $6::timestamptz IS NOT NULL THEN $6
               WHEN $5 IN ('unavailable','paused') THEN now()
               ELSE contact_last_seen_at
             END
           WHERE tenant_id=$1 AND session_id=$2 AND contact_phone=$3`,
          [identity.tenantId, identity.id, update.contactPhone, update.contactJid, update.presence, update.lastSeenAt ?? null]
        );
      }
    } else if (event.event === "QRCODE_UPDATED") {
      const qr = event.data.qrcode && typeof event.data.qrcode === "object" ? event.data.qrcode as Record<string, unknown> : event.data;
      const code = String(qr.code ?? qr.pairingCode ?? "");
      await repository.updateStatus(identity.id, "qr_pending", undefined, code || undefined);
    } else if (event.event === "CONNECTION_UPDATE") {
      const rawState = event.data.state ?? event.data.status ?? event.data.connection ?? event.data.instance ?? "";
      const state = String(rawState).toLowerCase();
      deps.log.info({ rawState, state, allDataKeys: Object.keys(event.data) }, "CONNECTION_UPDATE parsed state");
      const status = state === "open" || state === "connected" ? "connected" : state === "connecting" ? "qr_pending" : "disconnected";
      const owner = String(event.data.ownerJid ?? event.data.wuid ?? "").split("@")[0].split(":")[0] || undefined;
      const reason = status === "disconnected" ? String(event.data.reason ?? event.data.statusReason ?? (state || "connection_closed")) : undefined;
      await repository.updateStatus(identity.id, status, owner, undefined, reason);
      deps.log.info({ sessionId: identity.id, status, hasOwner: Boolean(owner), reason }, "Session status updated");
      if (status === "connected") {
        // Presence is advisory and Evolution may be temporarily unavailable.
        // Do not hold the webhook response open or invite provider retries.
        void loadBusinessHoursConfig(deps.db ?? defaultDb, identity.tenantId)
          .then((hours) => isWithinBusinessHours(new Date(), hours)
            ? deps.whatsapp.goOnline(identity.id)
            : deps.whatsapp.setPresence(identity.id, "unavailable", 1))
          .then(() => deps.log.info({ sessionId: identity.id }, "Evolution presence refresh attempted"))
          .catch((err) => deps.log.warn({ err, sessionId: identity.id }, "Evolution presence refresh failed"));
      }
    }
  return reply.status(204).send();
}
