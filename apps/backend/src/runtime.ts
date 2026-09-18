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
import { QualificationService } from "./modules/qualification/service.js";
import { createInstagramRuntime } from "./modules/instagram/index.js";
import type { InstagramRuntime } from "./modules/instagram/types.js";
import { ChannelGatewayRouter } from "./modules/messages/channel-gateway.js";
import type { MessageGateway } from "./modules/messages/types.js";

export function createWhatsAppRuntime(): {
  manager: WhatsAppSessionManager;
  processor: MessageProcessor;
  followUpProcessor: AiFollowUpProcessor;
  followUpRepository: AiFollowUpRepository;
  messageRepository: MessageRepository;
  instagramRuntime: InstagramRuntime;
  gateway: MessageGateway;
} {
  const manager = new WhatsAppSessionManager(db, config, logger);
  const instagramRuntime = createInstagramRuntime({ database: db, runtimeConfig: config });
  const gateway = new ChannelGatewayRouter(db, manager, instagramRuntime, config);
  const ai = new OpenRouterClient(config);
  const meetingConfirmations = new MeetingConfirmationRepository(db);
  const messageRepository = new MessageRepository(db, config);
  // Robô determinístico de fluxos de qualificação (R22): roda antes do turno de
  // IA. Sem classificador de IA — o robô é determinístico (handleInbound sem
  // aiClassify). Sem fluxo/gatilho ativo o outcome é null e o turno segue igual.
  const qualificationRobot = new QualificationService();
  const processor = new MessageProcessor(
    messageRepository,
    gateway,
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
      meetingConfirmations.registerContactConfirmation(tenantId, appointmentId, response),
    (input) => qualificationRobot.handleInbound(input)
  );
  const followUpRepository = new AiFollowUpRepository(db, config);
  const followUpProcessor = new AiFollowUpProcessor(followUpRepository, gateway, ai);
  return {
    manager,
    processor,
    followUpProcessor,
    followUpRepository,
    messageRepository,
    instagramRuntime,
    gateway
  };
}
