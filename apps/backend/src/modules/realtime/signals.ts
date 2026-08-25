import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { aiTurnProgressSchema, type AiTurnProgress } from "./ai-turn-contract.js";

export const REALTIME_POSTGRES_CHANNEL = "atendon_realtime_changes";
export const REALTIME_REDIS_CHANNEL = "atendon:realtime:changes:v1";

const internalSignalSchema = z.discriminatedUnion("type", [
  z.object({
    v: z.literal(1),
    type: z.literal("conversation.messages.changed"),
    tenantId: z.string().uuid(),
    conversationId: z.string().uuid(),
    entityId: z.string().uuid()
  }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("alerts.changed"),
    tenantId: z.string().uuid(),
    entityId: z.string().uuid()
  }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("appointment.changed"),
    tenantId: z.string().uuid(),
    appointmentId: z.string().uuid(),
    leadId: z.string().uuid(),
    entityId: z.string().uuid(),
    previousUserId: z.string().uuid().nullable(),
    assignedUserId: z.string().uuid().nullable()
  }).strict(),
  z.object({
    v: z.literal(1),
    type: z.literal("case.assignment.changed"),
    tenantId: z.string().uuid(),
    caseId: z.string().uuid(),
    conversationId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
    entityId: z.string().uuid(),
    previousUserId: z.string().uuid().nullable(),
    assignedUserId: z.string().uuid().nullable()
  }).strict(),
  aiTurnProgressSchema.extend({
    v: z.literal(1),
    tenantId: z.string().uuid()
  }).strict()
]);

export type InternalRealtimeSignal = z.infer<typeof internalSignalSchema>;
export type PublicRealtimeSignal =
  | { type: "conversation.messages.changed"; conversationId: string }
  | AiTurnProgress
  | { type: "alerts.changed" }
  | { type: "appointment.changed"; appointmentId: string; leadId: string }
  | {
      type: "case.assignment.changed";
      caseId: string;
      conversationId?: string;
      leadId?: string;
    };

export function parseInternalRealtimeSignal(value: unknown): InternalRealtimeSignal | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return internalSignalSchema.parse(parsed);
  } catch {
    return null;
  }
}

export function internalSignalKey(signal: InternalRealtimeSignal): string {
  if (signal.type === "conversation.ai.progress") {
    return `${signal.tenantId}:${signal.type}:${signal.conversationId}:${signal.turnId}:${signal.attempt}:${signal.revision}`;
  }
  return `${signal.tenantId}:${signal.type}:${signal.entityId}`;
}

export function publicRealtimeSignal(signal: InternalRealtimeSignal): PublicRealtimeSignal {
  if (signal.type === "conversation.ai.progress") {
    const { v: _version, tenantId: _tenantId, ...progress } = signal;
    void _version;
    void _tenantId;
    return progress;
  }
  if (signal.type === "alerts.changed") return { type: signal.type };
  if (signal.type === "appointment.changed") {
    return {
      type: signal.type,
      appointmentId: signal.appointmentId,
      leadId: signal.leadId
    };
  }
  if (signal.type === "conversation.messages.changed") {
    return { type: signal.type, conversationId: signal.conversationId };
  }
  return {
    type: signal.type,
    caseId: signal.caseId,
    ...(signal.conversationId ? { conversationId: signal.conversationId } : {}),
    ...(signal.leadId ? { leadId: signal.leadId } : {})
  };
}

export function opaqueRealtimeEventId(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function serializeSseEvent(input: {
  event: "catchup" | "change";
  id: string;
  data: unknown;
}): string {
  return `event: ${input.event}\nid: ${input.id}\ndata: ${JSON.stringify(input.data)}\n\n`;
}

export function catchupSseEvent(lastEventId: string | undefined): string {
  return serializeSseEvent({
    event: "catchup",
    id: opaqueRealtimeEventId(`catchup:${randomUUID()}`),
    data: { type: "catchup", reconnect: Boolean(lastEventId) }
  });
}
