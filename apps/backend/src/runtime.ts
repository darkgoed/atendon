import { config } from "./config.js";
import { db } from "./db/client.js";
import { logger } from "./logger.js";
import { OpenRouterClient } from "./modules/ai-router/openrouter.js";
import { MessageProcessor } from "./modules/messages/process-message.js";
import { MessageRepository } from "./modules/messages/repository.js";
import { WhatsAppSessionManager } from "./modules/whatsapp/session-manager.js";
import { enqueueHandoffNotification } from "./queue/handoff-notification-queue.js";
import { AiFollowUpProcessor, AiFollowUpRepository } from "./modules/messages/ai-follow-up.js";
import { aiTurnProgressStore } from "./modules/realtime/ai-turn-progress.js";
import { MeetingConfirmationRepository } from "./modules/scheduling/meeting-confirmation.js";

export function createWhatsAppRuntime(): {
  manager: WhatsAppSessionManager;
  processor: MessageProcessor;
  followUpProcessor: AiFollowUpProcessor;
  followUpRepository: AiFollowUpRepository;
} {
  const manager = new WhatsAppSessionManager(db, config, logger);
  const ai = new OpenRouterClient(config);
  const meetingConfirmations = new MeetingConfirmationRepository(db);
  const processor = new MessageProcessor(
    new MessageRepository(db, config),
    manager,
    ai,
    async (notification) => {
      await enqueueHandoffNotification(notification.id);
    },
    config.AI_SCHEDULING_MIN_LEAD_MINUTES,
    aiTurnProgressStore,
    // Promove o agendamento a CONFIRMADO quando o contato responde afirmando
    // presença. Sem isso o estado nunca sairia de "solicitada" e os lembretes
    // continuariam pedindo confirmação a quem já confirmou.
    (tenantId, appointmentId, response) =>
      meetingConfirmations.registerContactConfirmation(tenantId, appointmentId, response)
  );
  const followUpRepository = new AiFollowUpRepository(db, config);
  const followUpProcessor = new AiFollowUpProcessor(followUpRepository, manager, ai);
  return { manager, processor, followUpProcessor, followUpRepository };
}
