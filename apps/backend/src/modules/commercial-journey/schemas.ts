import { z } from "zod";
import { COMMERCIAL_OUTCOMES } from "./domain.js";

export const commercialOutcomeSchema = z.enum(COMMERCIAL_OUTCOMES);
/**
 * A chave do motivo é validada contra o catálogo do tenant
 * (`lead_loss_reasons`, migration 0129), não contra um enum global: cada
 * cliente tem o seu próprio vocabulário comercial. Aqui só garantimos o
 * formato da chave; `resolveLossReason` faz a validação semântica.
 */
export const lossReasonSchema = z.string().trim().regex(/^[a-z0-9_]{2,40}$/, "Motivo de perda inválido");
export const lossReasonNoteSchema = z.string().trim().min(1).max(500);
const instant = z.string().datetime({ offset: true });
const memberId = z.string().uuid();
const metadata = z.record(z.string(),z.unknown()).optional();
const nextAction = z.string().trim().min(1).max(500);

export const commercialTransitionPayloadSchema = z.object({
  sale_value: z.number().positive().finite().optional(),
  sale_product: z.string().trim().min(1).max(200).optional(),
  sale_channel: z.string().trim().min(1).max(60).optional(),
  sale_source: z.string().trim().min(1).max(200).optional(),
  responsavel_member_id: memberId.optional(),
  loss_reason: lossReasonSchema.optional(),
  loss_reason_note: lossReasonNoteSchema.optional(),
  next_action: nextAction.optional(),
  next_action_at: instant.optional(),
  outcome_metadata: metadata
}).strict();

const closedOutcomeSchema = z.object({
  outcome: z.literal("fechado"),
  sale_value: z.number().positive().finite(),
  outcome_metadata: metadata
}).strict();

function continuingOutcome<T extends "proposta_enviada" | "em_negociacao" | "follow_up">(outcome: T) {
  return z.object({
    outcome: z.literal(outcome),
    next_action: nextAction,
    next_action_at: instant,
    outcome_metadata: metadata
  }).strict();
}

const lostOutcomeSchema = z.object({
  outcome: z.literal("nao_avancou"),
  loss_reason: lossReasonSchema,
  loss_reason_note: lossReasonNoteSchema.optional(),
  outcome_metadata: metadata
}).strict();

export const concludeAppointmentSchema = z.discriminatedUnion("outcome", [
  closedOutcomeSchema,
  continuingOutcome("proposta_enviada"),
  continuingOutcome("em_negociacao"),
  continuingOutcome("follow_up"),
  lostOutcomeSchema
]);

export const cancellationSchema = z.discriminatedUnion("disposition", [
  z.object({
    disposition: z.literal("recover"),
    next_action: nextAction,
    next_action_at: instant
  }).strict(),
  z.object({
    disposition: z.literal("lost"),
    loss_reason: lossReasonSchema,
    loss_reason_note: lossReasonNoteSchema.optional()
  }).strict()
]);

export const noShowSchema = z.object({
  next_action_at: instant.optional()
}).strict().default({});

export type CommercialTransitionPayload = z.infer<typeof commercialTransitionPayloadSchema>;
export type ConcludeAppointmentInput = z.infer<typeof concludeAppointmentSchema>;
export type CancellationInput = z.infer<typeof cancellationSchema>;
export type NoShowInput = z.infer<typeof noShowSchema>;
