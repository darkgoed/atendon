import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";

export interface HumanOutboundJob {
  tenantId: string;
  sessionId: string;
  conversationId: string;
  contactPhone: string;
  contactJid?: string;
  text: string;
}

export const HUMAN_OUTBOUND_QUEUE = "human-outbound-messages";
export const humanOutboundQueue = new Queue<HumanOutboundJob>(HUMAN_OUTBOUND_QUEUE, { connection: redisConnection });
